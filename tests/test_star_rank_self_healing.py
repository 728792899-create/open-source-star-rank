import datetime as dt
import tempfile
import unittest
from pathlib import Path
from typing import Any, Mapping, Optional

from tools.star_rank import run_update
from tools.star_rank_incident import incident_state_from_body, update_incident


def api_repository(stars: int) -> dict[str, Any]:
    return {
        "id": 1,
        "full_name": "owner/repo",
        "description": "A test repository",
        "language": "Python",
        "stargazers_count": stars,
        "html_url": "https://github.com/owner/repo",
        "owner": {"avatar_url": "https://avatars.example.test/1"},
        "created_at": "2026-01-01T00:00:00Z",
        "pushed_at": "2026-08-08T00:00:00Z",
        "archived": False,
        "disabled": False,
        "fork": False,
    }


class RecordingRankClient:
    def __init__(self, repository: Mapping[str, Any]) -> None:
        self.repository = dict(repository)
        self.request_count = 0
        self.retry_count = 0

    def search_repositories(self, query: str, *, sort: str, pages: int) -> list[Mapping[str, Any]]:
        self.request_count += 1
        return [self.repository]

    def get_repository_by_id(self, repository_id: int) -> Optional[Mapping[str, Any]]:
        self.request_count += 1
        return self.repository if repository_id == 1 else None

    def get_repository(self, full_name: str) -> Optional[Mapping[str, Any]]:
        self.request_count += 1
        return self.repository if full_name == "owner/repo" else None


class RejectingRankClient:
    def search_repositories(self, query: str, *, sort: str, pages: int) -> list[Mapping[str, Any]]:
        raise AssertionError("same-day retry must not search GitHub")

    def get_repository_by_id(self, repository_id: int) -> Optional[Mapping[str, Any]]:
        raise AssertionError("same-day retry must not refresh GitHub metadata")

    def get_repository(self, full_name: str) -> Optional[Mapping[str, Any]]:
        raise AssertionError("same-day retry must not refresh a seeded repository")


class FakeIssueClient:
    def __init__(self) -> None:
        self.issue: Optional[dict[str, Any]] = None

    def ensure_label(self, label: str) -> None:
        return None

    def find_open_issue(self, title: str) -> Optional[dict[str, Any]]:
        if self.issue and self.issue.get("state", "open") == "open" and self.issue["title"] == title:
            return self.issue
        return None

    def request(self, method: str, path: str, payload: Optional[dict[str, Any]] = None) -> dict[str, Any]:
        if method == "POST" and path == "/issues":
            self.issue = {"number": 30, "state": "open", **(payload or {})}
        elif method == "PATCH" and self.issue:
            self.issue.update(payload or {})
        return self.issue or {}


class StarRankSelfHealingTests(unittest.TestCase):
    def test_workflows_keep_three_attempts_and_consistency_as_the_only_closer(self) -> None:
        repository = Path(__file__).resolve().parents[1]
        publisher = (repository / ".github/workflows/star-rank-pages.yml").read_text(encoding="utf-8")
        watchdog = (repository / ".github/workflows/star-rank-watchdog.yml").read_text(encoding="utf-8")
        self.assertIn('cron: "20,50 16 * * *"', publisher)
        self.assertIn('cron: "20 17 * * *"', publisher)
        self.assertIn("steps.collect.outputs.status != 'reused'", publisher)
        self.assertNotIn("--status close", publisher)
        self.assertIn('cron: "15 19 * * *"', watchdog)
        self.assertIn("--status close", watchdog)
        self.assertIn('cmp "$RUNNER_TEMP/data-index.json" "$RUNNER_TEMP/site-index.json"', watchdog)

    def test_valid_same_day_snapshot_is_reused_without_api_requests(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            seeds = root / "seeds.json"
            seeds.write_text("[]\n", encoding="utf-8")
            data_dir = root / "data"
            first = run_update(
                RecordingRankClient(api_repository(10)),
                data_dir=data_dir,
                projects_file=seeds,
                captured_at=dt.datetime(2026, 8, 8, 16, 20, tzinfo=dt.timezone.utc),
                max_candidates=10,
                require_valid_capture=True,
            )
            self.assertEqual(first["status"], "updated")

            retry = run_update(
                RejectingRankClient(),
                data_dir=data_dir,
                projects_file=seeds,
                captured_at=dt.datetime(2026, 8, 8, 17, 20, tzinfo=dt.timezone.utc),
                max_candidates=10,
                require_valid_capture=True,
            )
            self.assertEqual(retry["status"], "reused")
            self.assertEqual(retry["snapshot"]["snapshot_date"], "2026-08-09")

    def test_watchdog_failure_preserves_collector_root_cause_and_history(self) -> None:
        client = FakeIssueClient()
        common = {"title": "incident", "label": "star-rank-incident"}
        update_incident(
            client,
            status="open",
            component="collector",
            fingerprint="collector:collect",
            details="collector first failure; run=1",
            now=dt.datetime(2026, 8, 9, 16, 20, tzinfo=dt.timezone.utc),
            **common,
        )
        update_incident(
            client,
            status="open",
            component="collector",
            fingerprint="collector:collect",
            details="collector repeated failure; run=2",
            now=dt.datetime(2026, 8, 9, 17, 20, tzinfo=dt.timezone.utc),
            **common,
        )
        update_incident(
            client,
            status="open",
            component="data_freshness",
            fingerprint="data_freshness:data-branch",
            details="watchdog observed stale data",
            now=dt.datetime(2026, 8, 9, 19, 15, tzinfo=dt.timezone.utc),
            **common,
        )

        state = incident_state_from_body(str(client.issue["body"]))
        self.assertIsNotNone(state)
        assert state is not None
        self.assertEqual(state["first_seen"], "2026-08-09T16:20:00Z")
        self.assertEqual(state["last_seen"], "2026-08-09T19:15:00Z")
        self.assertEqual(set(state["failures"]), {"collector", "data_freshness"})
        collector = state["failures"]["collector"]
        self.assertEqual(collector["fingerprint"], "collector:collect")
        self.assertEqual(collector["consecutive_failures"], 2)
        self.assertEqual(collector["first_details"], "collector first failure; run=1")
        self.assertEqual(collector["latest_details"], "collector repeated failure; run=2")

    def test_existing_issue_thirty_is_upgraded_in_place(self) -> None:
        client = FakeIssueClient()
        client.issue = {
            "number": 30,
            "state": "open",
            "title": "incident",
            "body": "legacy watchdog details",
            "created_at": "2026-07-21T00:00:00Z",
        }
        number = update_incident(
            client,
            status="open",
            title="incident",
            label="star-rank-incident",
            component="collector",
            fingerprint="collector:collect",
            details="new collector failure",
            now=dt.datetime(2026, 8, 9, 16, 20, tzinfo=dt.timezone.utc),
        )
        self.assertEqual(number, 30)
        state = incident_state_from_body(str(client.issue["body"]))
        self.assertEqual(state["first_seen"], "2026-07-21T00:00:00Z")

    def test_pipeline_success_records_recovery_but_only_consistency_closes(self) -> None:
        client = FakeIssueClient()
        common = {"title": "incident", "label": "star-rank-incident"}
        update_incident(
            client,
            status="open",
            component="collector",
            fingerprint="collector:collect",
            details="collector failure",
            now=dt.datetime(2026, 8, 9, 16, 20, tzinfo=dt.timezone.utc),
            **common,
        )
        update_incident(
            client,
            status="success",
            component="pipeline",
            details="pipeline recovered; consistency pending",
            now=dt.datetime(2026, 8, 9, 17, 20, tzinfo=dt.timezone.utc),
            **common,
        )
        self.assertEqual(client.issue["state"], "open")
        pending = incident_state_from_body(str(client.issue["body"]))
        self.assertEqual(pending["last_success"]["component"], "pipeline")
        self.assertIsNone(pending["failures"]["collector"]["resolved_at"])

        update_incident(
            client,
            status="close",
            component="consistency",
            details="data branch and site match",
            now=dt.datetime(2026, 8, 9, 19, 15, tzinfo=dt.timezone.utc),
            **common,
        )
        self.assertEqual(client.issue["state"], "closed")
        recovered = incident_state_from_body(str(client.issue["body"]))
        self.assertEqual(recovered["last_success"]["component"], "consistency")
        self.assertEqual(recovered["failures"]["collector"]["resolved_at"], "2026-08-09T19:15:00Z")


if __name__ == "__main__":
    unittest.main()
