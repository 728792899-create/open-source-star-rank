import datetime as dt
import unittest
from typing import Any, Optional

from tools.check_star_rank_freshness import check_freshness
from tools.star_rank_incident import update_incident


class FakeIssueClient:
    def __init__(self) -> None:
        self.issue: Optional[dict[str, Any]] = None
        self.labels: list[str] = []
        self.requests: list[tuple[str, str, Optional[dict[str, Any]]]] = []

    def ensure_label(self, label: str) -> None:
        self.labels.append(label)

    def find_open_issue(self, title: str) -> Optional[dict[str, Any]]:
        if self.issue and self.issue.get("state", "open") == "open" and self.issue["title"] == title:
            return self.issue
        return None

    def request(self, method: str, path: str, payload: Optional[dict[str, Any]] = None) -> dict[str, Any]:
        self.requests.append((method, path, payload))
        if method == "POST" and path == "/issues":
            self.issue = {"number": 7, "state": "open", **(payload or {})}
            return self.issue
        if method == "PATCH" and self.issue:
            self.issue.update(payload or {})
            return self.issue
        return {}


class OperationsTests(unittest.TestCase):
    def test_freshness_requires_today_for_watchdog(self) -> None:
        index = {
            "updated_at": "2026-07-15T16:20:00Z",
            "freshness_threshold_hours": 36,
            "status": "ready",
            "latest_date": "2026-07-15",
        }
        now = dt.datetime(2026, 7, 16, 17, 15, tzinfo=dt.timezone.utc)
        result = check_freshness(index, now=now)
        self.assertLess(result["age_hours"], 36)
        with self.assertRaisesRegex(ValueError, "今日快照"):
            check_freshness(index, now=now, require_today=True)

    def test_freshness_rejects_data_older_than_threshold(self) -> None:
        index = {
            "updated_at": "2026-07-14T00:00:00Z",
            "freshness_threshold_hours": 36,
            "status": "ready",
            "latest_date": "2026-07-13",
        }
        with self.assertRaisesRegex(ValueError, "超过 36 小时"):
            check_freshness(
                index,
                now=dt.datetime(2026, 7, 16, 0, 1, tzinfo=dt.timezone.utc),
            )

    def test_watchdog_rejects_an_outside_window_snapshot(self) -> None:
        index = {
            "updated_at": "2026-07-15T04:13:00Z",
            "freshness_threshold_hours": 36,
            "status": "initializing",
            "latest_date": None,
            "sampling": {"latest_snapshot_valid": False},
        }
        with self.assertRaisesRegex(ValueError, "00:00–03:00"):
            check_freshness(
                index,
                now=dt.datetime(2026, 7, 15, 5, 0, tzinfo=dt.timezone.utc),
                require_valid_capture=True,
            )

    def test_event_watchdog_requires_yesterday_beijing_date(self) -> None:
        index = {
            "schema_version": "1.2.0",
            "ranking_limit": 500,
            "page_size": 100,
            "updated_at": "2026-07-16T23:35:00Z",
            "freshness_threshold_hours": 36,
            "status": "ready",
            "latest_date": "2026-07-16",
            "latest_source_metrics": {
                "scope": "github_public_events_as_archived_by_gh_archive",
                "counting_unit": "unique_actor_repository_pair",
                "expected_hour_count": 24,
                "observed_hour_count": 24,
                "missing_hours": [],
                "ranking_complete": True,
                "metadata_success_count": 500,
                "api_request_count": 500,
                "quality_baseline_days": 7,
                "quality_status": "passed",
                "watch_event_count_ratio": 1.0,
                "unique_addition_count_ratio": 1.0,
            },
        }
        result = check_freshness(
            index,
            now=dt.datetime(2026, 7, 17, 0, 15, tzinfo=dt.timezone.utc),
            require_yesterday_date=True,
            require_complete_event_coverage=True,
        )
        self.assertEqual(result["latest_date"], "2026-07-16")
        index["latest_date"] = "2026-07-15"
        with self.assertRaises(ValueError):
            check_freshness(
                index,
                now=dt.datetime(2026, 7, 17, 0, 15, tzinfo=dt.timezone.utc),
                require_yesterday_date=True,
                require_complete_event_coverage=True,
            )

    def test_event_watchdog_rejects_incomplete_hourly_coverage(self) -> None:
        index = {
            "schema_version": "1.2.0",
            "ranking_limit": 500,
            "page_size": 100,
            "updated_at": "2026-07-16T23:35:00Z",
            "freshness_threshold_hours": 36,
            "status": "ready",
            "latest_date": "2026-07-16",
            "latest_source_metrics": {
                "scope": "github_public_events_as_archived_by_gh_archive",
                "counting_unit": "unique_actor_repository_pair",
                "expected_hour_count": 24,
                "observed_hour_count": 23,
                "missing_hours": ["2026-07-16T03:00:00Z"],
                "ranking_complete": True,
                "metadata_success_count": 500,
                "api_request_count": 500,
                "quality_baseline_days": 7,
                "quality_status": "passed",
                "watch_event_count_ratio": 1.0,
                "unique_addition_count_ratio": 1.0,
            },
        }
        with self.assertRaisesRegex(ValueError, "小时覆盖"):
            check_freshness(
                index,
                now=dt.datetime(2026, 7, 17, 0, 15, tzinfo=dt.timezone.utc),
                require_yesterday_date=True,
                require_complete_event_coverage=True,
            )

    def test_incident_is_single_and_closes_after_recovery(self) -> None:
        client = FakeIssueClient()
        first = update_incident(
            client,
            status="open",
            title="incident",
            label="star-rank-incident",
            details="first failure",
        )
        second = update_incident(
            client,
            status="open",
            title="incident",
            label="star-rank-incident",
            details="second failure",
        )
        closed = update_incident(
            client,
            status="close",
            title="incident",
            label="star-rank-incident",
            details="recovered",
        )
        self.assertEqual((first, second, closed), (7, 7, 7))
        self.assertEqual(client.issue["state"], "closed")
        self.assertEqual(sum(1 for method, path, _ in client.requests if method == "POST" and path == "/issues"), 1)


if __name__ == "__main__":
    unittest.main()
