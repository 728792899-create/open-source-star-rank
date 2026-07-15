from __future__ import annotations

import datetime as dt
import shutil
import tempfile
import unittest
from pathlib import Path
from typing import Any

from tools.event_star_rank import (
    DEFAULT_MAXIMUM_BYTES_BILLED,
    build_event_outputs,
    build_watch_event_query,
    event_window,
    prune_event_states,
    rebuild_dependent_rankings,
    run_event_update,
    source_table_dates,
)
from tools.star_rank import DataIntegrityError, RateLimitError, StarRankError, atomic_write_json
from tools.validate_star_rank_data import validate_data_tree


class FakeRunner:
    def __init__(self, rows: list[dict[str, Any]], *, estimate: int = 1024, processed: int = 1024) -> None:
        self.rows = rows
        self.estimate = estimate
        self.processed = processed
        self.run_count = 0

    def estimate_bytes(self, query: str) -> int:
        self.query = query
        return self.estimate

    def run(self, query: str, *, maximum_bytes_billed: int) -> tuple[list[dict[str, Any]], int]:
        self.run_count += 1
        self.maximum_bytes_billed = maximum_bytes_billed
        return self.rows, self.processed


class FakeGitHub:
    def __init__(
        self,
        payloads: dict[int, dict[str, Any] | None],
        *,
        fail_at: int | None = None,
        failure: Exception | None = None,
    ) -> None:
        self.payloads = payloads
        self.fail_at = fail_at
        self.failure = failure or RateLimitError("fixture rate limit")
        self.request_count = 0
        self.retry_count = 0

    def get_repository_by_id(self, repository_id: int) -> dict[str, Any] | None:
        self.request_count += 1
        if self.fail_at == self.request_count:
            raise self.failure
        return self.payloads.get(repository_id)


def aggregate(repository_id: int, stars: int, events: int | None = None) -> dict[str, Any]:
    return {
        "repository_id": repository_id,
        "observed_name": f"fixture/repo-{repository_id}",
        "stars_added": stars,
        "watch_events": events if events is not None else stars,
        "observed_repository_count": 10_000,
        "observed_watch_event_count": 100_000,
    }


def repository(repository_id: int, *, stars_total: int = 1000, **overrides: Any) -> dict[str, Any]:
    payload = {
        "id": repository_id,
        "full_name": f"fixture/repo-{repository_id}",
        "description": f"Repository {repository_id}",
        "language": "Python",
        "stargazers_count": stars_total,
        "html_url": f"https://github.com/fixture/repo-{repository_id}",
        "owner": {"avatar_url": f"https://avatars.githubusercontent.com/u/{repository_id}"},
        "private": False,
        "visibility": "public",
        "fork": False,
        "archived": False,
        "disabled": False,
    }
    payload.update(overrides)
    return payload


class EventStarRankTests(unittest.TestCase):
    def setUp(self) -> None:
        self.date = dt.date(2026, 7, 15)
        self.now = dt.datetime(2026, 7, 16, 0, 0, tzinfo=dt.timezone.utc)

    def test_beijing_window_maps_to_two_safe_utc_tables(self) -> None:
        start, end = event_window(self.date)
        self.assertEqual(start.isoformat(), "2026-07-14T16:00:00+00:00")
        self.assertEqual(end.isoformat(), "2026-07-15T16:00:00+00:00")
        self.assertEqual(source_table_dates(self.date), ["20260714", "20260715"])
        query = build_watch_event_query(self.date, raw_limit=500)
        self.assertIn("`githubarchive.day.20260714`", query)
        self.assertIn("COUNT(DISTINCT actor_id)", query)
        self.assertIn("COUNT(DISTINCT id)", query)
        self.assertIn("ORDER BY stars_added DESC, watch_events DESC, repository_id ASC", query)
        self.assertNotIn("payload", query)

    def test_dry_run_budget_failure_never_executes_or_writes(self) -> None:
        runner = FakeRunner([], estimate=DEFAULT_MAXIMUM_BYTES_BILLED + 1)
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            with self.assertRaises(DataIntegrityError):
                run_event_update(
                    runner,
                    FakeGitHub({}),
                    data_dir=root,
                    date=self.date,
                    generated_at=self.now,
                    top_limit=100,
                )
            self.assertEqual(runner.run_count, 0)
            self.assertFalse((root / "public").exists())

    def test_collects_filters_sorts_validates_and_reuses_a_day(self) -> None:
        rows = [aggregate(1, 312), aggregate(2, 312, 313), aggregate(3, 310), aggregate(4, 309), aggregate(5, 308)]
        rows.extend(aggregate(repository_id, 307 - repository_id) for repository_id in range(6, 111))
        payloads = {repository_id: repository(repository_id) for repository_id in range(1, 111)}
        payloads.update(
            {
                1: repository(1, stars_total=500),
                2: repository(2, stars_total=400, full_name="renamed/repo-2"),
                3: repository(3, stars_total=300),
                4: repository(4, archived=True),
                5: None,
                6: repository(6, fork=True),
                7: repository(7, disabled=True),
                8: repository(8, private=True),
                9: repository(9, visibility="private"),
            }
        )
        github = FakeGitHub(payloads)
        runner = FakeRunner(rows, estimate=2048, processed=1024)
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            shutil.copytree(
                Path(__file__).resolve().parents[1] / "site" / "seed-data",
                root / "public",
                dirs_exist_ok=True,
            )
            result = run_event_update(
                runner,
                github,
                data_dir=root,
                date=self.date,
                generated_at=self.now,
                raw_limit=110,
                top_limit=100,
            )
            ranking = result["ranking"]
            self.assertEqual([item["repository_id"] for item in ranking["entries"][:3]], [2, 1, 3])
            self.assertEqual(ranking["entries"][0]["trend_7d"], [None, None, None, None, None, None, 312])
            self.assertEqual(ranking["source_metrics"]["metadata_not_found_count"], 1)
            self.assertEqual(ranking["source_metrics"]["metadata_filtered_count"], 5)
            counts = validate_data_tree(root)
            self.assertEqual(counts["event_daily"], 1)
            reused = run_event_update(
                runner,
                github,
                data_dir=root,
                date=self.date,
                generated_at=self.now,
                raw_limit=110,
                top_limit=100,
            )
            self.assertEqual(reused["status"], "reused")
            self.assertEqual(runner.run_count, 1)
            replaced = run_event_update(
                runner,
                github,
                data_dir=root,
                date=self.date,
                generated_at=self.now,
                raw_limit=110,
                top_limit=100,
                replace_day=True,
            )
            self.assertEqual(replaced["status"], "updated")
            self.assertEqual(runner.run_count, 2)

    def test_rank_change_and_trend_keep_missing_top_500_days_as_null(self) -> None:
        enriched = [
            {
                "repository_id": repository_id,
                "full_name": f"fixture/repo-{repository_id:03d}",
                "description": None,
                "language": "Python",
                "stars_total": 10_000 - repository_id,
                "stars_added": 300 - repository_id,
                "watch_events": 300 - repository_id,
                "html_url": f"https://github.com/fixture/repo-{repository_id:03d}",
                "owner_avatar_url": None,
            }
            for repository_id in range(1, 101)
        ]
        previous_date = self.date - dt.timedelta(days=1)
        previous = {"entries": [{"repository_id": 1, "rank": 2}, {"repository_id": 2, "rank": 1}]}
        rows = [aggregate(1, 299)]
        ranking, _ = build_event_outputs(
            date=self.date,
            generated_at=self.now,
            rows=rows,
            enriched=enriched,
            metadata_metrics={
                "metadata_attempted_count": 100,
                "metadata_success_count": 100,
                "metadata_not_found_count": 0,
                "metadata_filtered_count": 0,
                "api_request_count": 100,
                "api_retry_count": 0,
            },
            estimated_bytes=1,
            bytes_processed=1,
            maximum_bytes_billed=DEFAULT_MAXIMUM_BYTES_BILLED,
            state_history={previous_date: {"entries": [{"repository_id": 1, "stars_added": 42}]}},
            previous_ranking=previous,
            top_limit=100,
        )
        self.assertEqual(ranking["entries"][0]["rank_change"], 1)
        self.assertEqual(ranking["entries"][1]["rank_change"], -1)
        self.assertEqual(ranking["entries"][0]["trend_7d"][-2:], [42, 299])
        self.assertEqual(ranking["entries"][1]["trend_7d"][-2:], [None, 298])

        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            state_dir = root / "state"
            next_date = self.date + dt.timedelta(days=1)
            next_ranking = {
                **ranking,
                "date": next_date.isoformat(),
                "entries": [{**item, "rank_change": None, "trend_7d": [None] * 7} for item in ranking["entries"]],
            }
            atomic_write_json(root / "public" / "events" / "daily" / f"{next_date.isoformat()}.json", next_ranking)
            atomic_write_json(
                state_dir / f"{next_date.isoformat()}.json",
                {"entries": [{**item, "stars_added": 99} for item in enriched]},
            )
            rebuilt = rebuild_dependent_rankings(
                root / "public",
                state_dir,
                date=self.date,
                ranking=ranking,
                raw_state={"entries": enriched},
            )
            self.assertEqual(rebuilt[next_date]["entries"][0]["rank_change"], 0)
            self.assertEqual(rebuilt[next_date]["entries"][0]["trend_7d"][-2:], [299, 99])

    def test_rate_limit_and_network_failure_do_not_publish_partial_event_data(self) -> None:
        rows = [aggregate(index, 200 - index) for index in range(1, 101)]
        for failure in (RateLimitError("fixture rate limit"), StarRankError("fixture network failure")):
            with self.subTest(type=type(failure).__name__), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                github = FakeGitHub(
                    {index: repository(index) for index in range(1, 101)},
                    fail_at=2,
                    failure=failure,
                )
                with self.assertRaises(type(failure)):
                    run_event_update(
                        FakeRunner(rows),
                        github,
                        data_dir=root,
                        date=self.date,
                        generated_at=self.now,
                        raw_limit=100,
                        top_limit=100,
                    )
                self.assertFalse((root / "public" / "events").exists())

    def test_explicit_date_is_limited_to_recent_seven_days(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            with self.assertRaises(DataIntegrityError):
                run_event_update(
                    FakeRunner([]),
                    FakeGitHub({}),
                    data_dir=Path(temporary),
                    date=self.date - dt.timedelta(days=7),
                    generated_at=self.now,
                    dry_run=True,
                )

    def test_event_ranking_requires_a_complete_top_100(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            with self.assertRaisesRegex(DataIntegrityError, "Top 100"):
                run_event_update(
                    FakeRunner([]),
                    FakeGitHub({}),
                    data_dir=Path(temporary),
                    date=self.date,
                    generated_at=self.now,
                    top_limit=99,
                    dry_run=True,
                )

    def test_internal_top_500_state_retention_is_thirty_days(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            old = self.date - dt.timedelta(days=30)
            retained = self.date - dt.timedelta(days=29)
            atomic_write_json(root / f"{old.isoformat()}.json", {"entries": []})
            atomic_write_json(root / f"{retained.isoformat()}.json", {"entries": []})
            removed = prune_event_states(root, current_date=self.date)
            self.assertEqual(removed, [root / f"{old.isoformat()}.json"])
            self.assertTrue((root / f"{retained.isoformat()}.json").exists())


if __name__ == "__main__":
    unittest.main()
