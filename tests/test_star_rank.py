import datetime as dt
import io
import json
import tempfile
import unittest
from email.message import Message
from pathlib import Path
from typing import Any, Dict, List, Mapping, Optional
from unittest.mock import patch
from urllib.error import HTTPError

from tools.star_rank import (
    DataIntegrityError,
    GitHubClient,
    RateLimitError,
    build_daily_ranking,
    build_snapshot,
    prune_old_snapshots,
    ranked_entries,
    repository_record,
    run_update,
    select_candidate_pool,
)
from tools.validate_star_rank_data import validate_data_tree


FIXTURES = Path(__file__).parent / "fixtures" / "github"


def api_repo(
    repository_id: int,
    name: str,
    stars: int,
    *,
    archived: bool = False,
    fork: bool = False,
) -> Dict[str, Any]:
    return {
        "id": repository_id,
        "full_name": name,
        "description": f"Description for {name}",
        "language": "Python",
        "stargazers_count": stars,
        "html_url": f"https://github.com/{name}",
        "owner": {"avatar_url": "https://avatars.example.test/1"},
        "created_at": "2026-01-01T00:00:00Z",
        "pushed_at": "2026-07-14T00:00:00Z",
        "archived": archived,
        "disabled": False,
        "fork": fork,
    }


class FakeClient:
    def __init__(self, repositories: List[Mapping[str, Any]], *, incomplete: bool = False) -> None:
        self.repositories = {int(item["id"]): dict(item) for item in repositories}
        self.incomplete = incomplete
        self.request_count = 0
        self.retry_count = 0

    def search_repositories(self, query: str, *, sort: str, pages: int) -> List[Mapping[str, Any]]:
        self.request_count += 1
        if self.incomplete:
            raise DataIntegrityError("incomplete_results")
        return list(self.repositories.values())

    def get_repository_by_id(self, repository_id: int) -> Optional[Mapping[str, Any]]:
        self.request_count += 1
        return self.repositories.get(repository_id)

    def get_repository(self, full_name: str) -> Optional[Mapping[str, Any]]:
        self.request_count += 1
        return next((item for item in self.repositories.values() if item["full_name"] == full_name), None)


class StubResponse:
    def __init__(self, payload: Mapping[str, Any]) -> None:
        self.payload = payload

    def __enter__(self) -> "StubResponse":
        return self

    def __exit__(self, *_: object) -> None:
        return None

    def read(self) -> bytes:
        return json.dumps(self.payload).encode("utf-8")


def fixture(name: str) -> Mapping[str, Any]:
    return json.loads((FIXTURES / name).read_text(encoding="utf-8"))


def fixture_http_error(name: str, url: str) -> HTTPError:
    response = fixture(name)
    headers = Message()
    for key, value in response["headers"].items():
        headers[key] = str(value)
    return HTTPError(
        url,
        int(response["status"]),
        str(response["reason"]),
        headers,
        io.BytesIO(json.dumps(response["body"]).encode("utf-8")),
    )


class StarRankTests(unittest.TestCase):
    def test_public_ranking_caps_at_five_hundred_and_keeps_short_results(self) -> None:
        sources = [
            {"repository_id": value, "rank": value, "rank_change": None}
            for value in range(1, 551)
        ]
        capped = ranked_entries(sources, previous_ranking=None, limit=500)
        self.assertEqual(len(capped), 500)
        self.assertEqual(capped[-1]["rank"], 500)
        short = ranked_entries(sources[:37], previous_ranking=None, limit=500)
        self.assertEqual(len(short), 37)
        self.assertEqual(short[-1]["rank"], 37)

    def test_repository_record_preserves_identity_across_rename(self) -> None:
        old = repository_record(api_repo(1, "owner/old", 10), observed_date="2026-07-14", source="seed")
        renamed = repository_record(
            api_repo(1, "owner/new", 12),
            observed_date="2026-07-15",
            source="tracked-refresh",
            existing=old,
        )
        self.assertEqual(renamed["repository_id"], 1)
        self.assertEqual(renamed["full_name"], "owner/new")
        self.assertEqual(renamed["first_seen_date"], "2026-07-14")

    def test_candidate_pool_prioritizes_pinned_growth_then_new(self) -> None:
        candidates = []
        for repository_id, stars, first_seen, pinned in (
            (1, 1, "2026-01-01", True),
            (2, 10, "2026-01-01", False),
            (3, 1_000, "2026-07-15", False),
            (4, 50_000, "2026-01-01", False),
        ):
            item = repository_record(
                api_repo(repository_id, f"owner/repo-{repository_id}", stars),
                observed_date="2026-07-15",
                source="test",
                pinned=pinned,
            )
            item["first_seen_date"] = first_seen
            candidates.append(item)
        selected = select_candidate_pool(
            candidates,
            recent_growth={2: 5},
            observed_date="2026-07-15",
            max_candidates=3,
        )
        self.assertEqual([item["repository_id"] for item in selected], [1, 2, 3])

    def test_candidate_pool_excludes_archived_and_forks(self) -> None:
        candidates = [
            repository_record(api_repo(1, "owner/good", 10), observed_date="2026-07-15", source="test"),
            repository_record(
                api_repo(2, "owner/archived", 20, archived=True), observed_date="2026-07-15", source="test"
            ),
            repository_record(
                api_repo(3, "owner/fork", 30, fork=True), observed_date="2026-07-15", source="test"
            ),
        ]
        selected = select_candidate_pool(candidates, recent_growth={}, observed_date="2026-07-15", max_candidates=10)
        self.assertEqual([item["repository_id"] for item in selected], [1])

    def test_daily_ranking_sorts_ties_and_calculates_changes(self) -> None:
        candidates = [
            repository_record(api_repo(1, "z/repo", 110), observed_date="2026-07-16", source="test"),
            repository_record(api_repo(2, "a/repo", 210), observed_date="2026-07-16", source="test"),
            repository_record(api_repo(3, "b/repo", 50), observed_date="2026-07-16", source="test"),
        ]
        previous = build_snapshot(candidates, captured_at=dt.datetime(2026, 7, 15, 16, 20, tzinfo=dt.timezone.utc))
        previous["repositories"]["1"]["stars_total"] = 100
        previous["repositories"]["2"]["stars_total"] = 200
        previous["repositories"]["3"]["stars_total"] = 55
        current = build_snapshot(candidates, captured_at=dt.datetime(2026, 7, 16, 16, 20, tzinfo=dt.timezone.utc))
        history = {
            dt.date(2026, 7, 16): previous,
            dt.date(2026, 7, 17): current,
        }
        prior_ranking = {"entries": [{"repository_id": 1, "rank": 1}, {"repository_id": 2, "rank": 2}]}
        ranking = build_daily_ranking(
            previous_snapshot=previous,
            current_snapshot=current,
            candidates=candidates,
            snapshot_history=history,
            previous_ranking=prior_ranking,
            knowledge_repositories={},
        )
        self.assertEqual([item["repository_id"] for item in ranking["entries"]], [2, 1, 3])
        self.assertEqual(ranking["entries"][0]["rank_change"], 1)
        self.assertIsNone(ranking["entries"][0]["knowledge_url"])
        self.assertEqual(ranking["entries"][2]["stars_gained"], -5)

    def test_first_snapshot_initializes_without_fake_ranking(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            projects_file = root / "projects.json"
            projects_file.write_text("[]\n", encoding="utf-8")
            result = run_update(
                FakeClient([api_repo(1, "owner/repo", 10)]),
                data_dir=root / "rank-data",
                projects_file=projects_file,
                captured_at=dt.datetime(2026, 7, 15, 16, 20, tzinfo=dt.timezone.utc),
                max_candidates=10,
            )
            self.assertIsNone(result["ranking"])
            index = json.loads((root / "rank-data/public/index.json").read_text(encoding="utf-8"))
            self.assertEqual(index["status"], "initializing")
            self.assertEqual(index["available_dates"], [])
            self.assertEqual(index["schema_version"], "1.3.0")
            self.assertEqual(index["ranking_limit"], 500)
            self.assertEqual(index["page_size"], 100)
            self.assertEqual(index["freshness_threshold_hours"], 36)
            self.assertEqual(index["latest_collection"]["snapshot_completeness"], 1.0)
            language_index = json.loads(
                (root / "rank-data/public/language/index.json").read_text(encoding="utf-8")
            )
            self.assertEqual(language_index["schema_version"], "1.3.0")
            self.assertEqual(language_index["ranking_limit"], 500)
            self.assertEqual(language_index["page_size"], 100)

    def test_second_snapshot_creates_real_ranking_and_is_idempotent(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            projects_file = root / "projects.json"
            projects_file.write_text("[]\n", encoding="utf-8")
            data_dir = root / "rank-data"
            first_client = FakeClient([api_repo(1, "owner/repo", 10)])
            run_update(
                first_client,
                data_dir=data_dir,
                projects_file=projects_file,
                captured_at=dt.datetime(2026, 7, 15, 16, 20, tzinfo=dt.timezone.utc),
                max_candidates=10,
            )
            second_client = FakeClient([api_repo(1, "owner/repo", 15)])
            result = run_update(
                second_client,
                data_dir=data_dir,
                projects_file=projects_file,
                captured_at=dt.datetime(2026, 7, 16, 16, 20, tzinfo=dt.timezone.utc),
                max_candidates=10,
            )
            self.assertEqual(result["ranking"]["entries"][0]["stars_gained"], 5)
            self.assertEqual(result["ranking"]["collection"]["snapshot_complete_count"], 1)
            self.assertEqual(result["ranking"]["entries"][0]["trend_7d"][:-1], [None] * 6)
            counts = validate_data_tree(data_dir)
            self.assertEqual(counts["snapshot"], 2)
            self.assertEqual(counts["daily"], 1)
            reused = run_update(
                second_client,
                data_dir=data_dir,
                projects_file=projects_file,
                captured_at=dt.datetime(2026, 7, 16, 17, 0, tzinfo=dt.timezone.utc),
                max_candidates=10,
            )
            self.assertEqual(reused["status"], "reused")

    def test_replace_snapshot_requires_matching_beijing_date(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            projects_file = root / "projects.json"
            projects_file.write_text("[]\n", encoding="utf-8")
            with self.assertRaises(DataIntegrityError):
                run_update(
                    FakeClient([api_repo(1, "owner/repo", 10)]),
                    data_dir=root / "rank-data",
                    projects_file=projects_file,
                    captured_at=dt.datetime(2026, 7, 15, 16, 20, tzinfo=dt.timezone.utc),
                    max_candidates=10,
                    replace_snapshot=True,
                    replace_date=dt.date(2026, 7, 15),
                )

    def test_incomplete_search_does_not_write_partial_state(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            projects_file = root / "projects.json"
            projects_file.write_text("[]\n", encoding="utf-8")
            with self.assertRaises(DataIntegrityError):
                run_update(
                    FakeClient([api_repo(1, "owner/repo", 10)], incomplete=True),
                    data_dir=root / "rank-data",
                    projects_file=projects_file,
                    captured_at=dt.datetime(2026, 7, 15, 16, 20, tzinfo=dt.timezone.utc),
                    max_candidates=10,
                )
            self.assertFalse((root / "rank-data/state/candidates.json").exists())

    def test_rate_limit_is_a_hard_failure(self) -> None:
        error = fixture_http_error(
            "rate-limit.json",
            "https://api.github.com/search/repositories",
        )
        with patch("urllib.request.urlopen", side_effect=error):
            with self.assertRaises(RateLimitError):
                GitHubClient("token", retries=1).search_repositories("stars:>=1", sort="stars", pages=1)

    def test_timeout_retries_are_counted_and_fail_atomically(self) -> None:
        client = GitHubClient("token", retries=2)
        with patch("urllib.request.urlopen", side_effect=TimeoutError("timed out")), patch("time.sleep"):
            with self.assertRaisesRegex(Exception, "网络或响应错误"):
                client.search_repositories("stars:>=1", sort="stars", pages=1)
        self.assertEqual(client.request_count, 2)
        self.assertEqual(client.retry_count, 1)

    def test_recorded_search_fixture_covers_pagination(self) -> None:
        client = GitHubClient("token", retries=1)
        responses = [StubResponse(fixture("search-page-1.json")), StubResponse(fixture("search-page-2.json"))]
        with patch("tools.star_rank.SEARCH_PAGE_SIZE", 2), patch(
            "urllib.request.urlopen", side_effect=responses
        ):
            results = client.search_repositories("stars:>=1", sort="stars", pages=3)
        self.assertEqual([item["id"] for item in results], [101, 102, 103])
        self.assertEqual(client.request_count, 2)

    def test_recorded_incomplete_search_is_rejected(self) -> None:
        client = GitHubClient("token", retries=1)
        with patch("urllib.request.urlopen", return_value=StubResponse(fixture("incomplete-search.json"))):
            with self.assertRaises(DataIntegrityError):
                client.search_repositories("stars:>=1", sort="stars", pages=1)

    def test_recorded_repository_detail_fixture_tracks_rename(self) -> None:
        client = GitHubClient("token", retries=1)
        with patch("urllib.request.urlopen", return_value=StubResponse(fixture("repository-detail.json"))):
            repository = client.get_repository_by_id(101)
        self.assertIsNotNone(repository)
        self.assertEqual(repository["full_name"], "fixture/alpha-renamed")
        self.assertEqual(repository["stargazers_count"], 117)

    def test_recorded_not_found_fixture_removes_deleted_repository(self) -> None:
        client = GitHubClient("token", retries=1)
        error = fixture_http_error("not-found.json", "https://api.github.com/repositories/404")
        with patch("urllib.request.urlopen", side_effect=error):
            self.assertIsNone(client.get_repository_by_id(404))

    def test_schema_failure_does_not_write_any_data(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            projects_file = root / "projects.json"
            projects_file.write_text("[]\n", encoding="utf-8")
            malformed = api_repo(1, "owner/repo", 10)
            malformed["language"] = {"unexpected": True}
            with self.assertRaises(DataIntegrityError):
                run_update(
                    FakeClient([malformed]),
                    data_dir=root / "rank-data",
                    projects_file=projects_file,
                    captured_at=dt.datetime(2026, 7, 15, 16, 20, tzinfo=dt.timezone.utc),
                    max_candidates=10,
                )
            self.assertFalse((root / "rank-data/state/candidates.json").exists())
            self.assertFalse((root / "rank-data/snapshots").exists())

    def test_snapshot_retention_keeps_90_beijing_dates(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            snapshot_dir = Path(temporary)
            current = dt.date(2026, 7, 15)
            keep = snapshot_dir / f"{(current - dt.timedelta(days=89)).isoformat()}.json"
            remove = snapshot_dir / f"{(current - dt.timedelta(days=90)).isoformat()}.json"
            keep.write_text("{}\n", encoding="utf-8")
            remove.write_text("{}\n", encoding="utf-8")
            removed = prune_old_snapshots(snapshot_dir, current_date=current)
            self.assertEqual(removed, [remove])
            self.assertTrue(keep.exists())
            self.assertFalse(remove.exists())

    def test_deleted_tracked_repository_leaves_pool(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            projects_file = root / "projects.json"
            projects_file.write_text("[]\n", encoding="utf-8")
            data_dir = root / "rank-data"
            state_dir = data_dir / "state"
            state_dir.mkdir(parents=True)
            deleted = repository_record(
                api_repo(99, "owner/deleted", 500),
                observed_date="2026-07-14",
                source="tracked-refresh",
            )
            (state_dir / "candidates.json").write_text(
                json.dumps({"candidates": [deleted]}), encoding="utf-8"
            )
            result = run_update(
                FakeClient([api_repo(1, "owner/active", 10)]),
                data_dir=data_dir,
                projects_file=projects_file,
                captured_at=dt.datetime(2026, 7, 15, 16, 20, tzinfo=dt.timezone.utc),
                max_candidates=10,
            )
            ids = set(result["snapshot"]["repositories"])
            self.assertEqual(ids, {"1"})


if __name__ == "__main__":
    unittest.main()
