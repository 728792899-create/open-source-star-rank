from __future__ import annotations

import datetime as dt
import tempfile
import unittest
from pathlib import Path
from typing import Any, Iterable, Mapping

from tools.event_live_rank import (
    aggregate_hour_states,
    build_hour_state,
    enrich_live_aggregates,
    expected_hours,
    live_window,
    run_live_update,
    source_url,
)
from tools.star_rank import DataIntegrityError, StarRankError
from tools.star_rank_schema import validate_payload


class FakeSource:
    def __init__(self, records: dict[str, list[dict[str, Any]]], *, fail_hour: str | None = None) -> None:
        self.records = records
        self.fail_hour = fail_hour
        self.calls: list[str] = []

    def fetch(self, hour_start: dt.datetime) -> Iterable[Mapping[str, Any]]:
        key = hour_start.isoformat()
        self.calls.append(key)
        if key == self.fail_hour:
            raise StarRankError("fixture archive unavailable")
        return self.records[key]


class FakeGitHub:
    def __init__(self, payloads: dict[int, dict[str, Any]]) -> None:
        self.payloads = payloads
        self.request_count = 0
        self.retry_count = 0

    def get_repository_by_id(self, repository_id: int) -> dict[str, Any] | None:
        self.request_count += 1
        return self.payloads.get(repository_id)


def repository(repository_id: int) -> dict[str, Any]:
    return {
        "id": repository_id,
        "full_name": f"fixture/repo-{repository_id}",
        "description": f"Repository {repository_id}",
        "language": "Python",
        "stargazers_count": 1000 + repository_id,
        "created_at": "2016-01-01T00:00:00Z",
        "pushed_at": "2026-07-16T00:00:00Z",
        "html_url": f"https://github.com/fixture/repo-{repository_id}",
        "owner": {"avatar_url": f"https://avatars.githubusercontent.com/u/{repository_id}"},
        "private": False,
        "visibility": "public",
        "fork": False,
        "archived": False,
        "disabled": False,
    }


def watch_event(hour: dt.datetime, repository_id: int, actor_id: int, event_id: str) -> dict[str, Any]:
    return {
        "id": event_id,
        "type": "WatchEvent",
        "actor": {"id": actor_id},
        "repo": {"id": repository_id, "name": f"fixture/repo-{repository_id}"},
        "created_at": (hour + dt.timedelta(minutes=5)).isoformat().replace("+00:00", "Z"),
    }


class EventLiveRankTests(unittest.TestCase):
    def setUp(self) -> None:
        self.now = dt.datetime(2026, 7, 15, 20, 35, tzinfo=dt.timezone.utc)
        self.date, self.start, self.cutoff = live_window(self.now)
        self.hours = expected_hours(self.start, self.cutoff)

    def records(self) -> dict[str, list[dict[str, Any]]]:
        return {
            hour.isoformat(): [
                watch_event(hour, repository_id, repository_id * 100 + offset, f"{offset}-{repository_id}")
                for repository_id in range(1, 11)
            ]
            for offset, hour in enumerate(self.hours)
        }

    def test_live_window_uses_only_completed_beijing_day_hours(self) -> None:
        self.assertEqual(self.date.isoformat(), "2026-07-16")
        self.assertEqual(self.start.isoformat(), "2026-07-15T16:00:00+00:00")
        self.assertEqual(self.cutoff.isoformat(), "2026-07-15T20:00:00+00:00")
        self.assertEqual(len(self.hours), 4)
        self.assertEqual(source_url(self.hours[0]), "https://data.gharchive.org/2026-07-15-16.json.gz")
        with self.assertRaises(DataIntegrityError):
            live_window(dt.datetime(2026, 7, 15, 16, 20, tzinfo=dt.timezone.utc))

    def test_hour_state_and_daily_aggregation_deduplicate_actor_repository_pairs(self) -> None:
        hour = self.hours[0]
        state = build_hour_state(
            hour,
            [watch_event(hour, 1, 9, "a"), watch_event(hour, 1, 9, "b")],
            fetched_at=self.now,
        )
        rows = aggregate_hour_states([state])
        self.assertEqual(rows[0]["stars_added"], 1)
        self.assertEqual(rows[0]["watch_events"], 2)

    def test_update_publishes_provisional_ranking_and_reuses_hour_state(self) -> None:
        source = FakeSource(self.records())
        github = FakeGitHub({repository_id: repository(repository_id) for repository_id in range(1, 11)})
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            result = run_live_update(source, github, data_dir=root, generated_at=self.now)
            ranking = result["ranking"]
            self.assertEqual(result["status"], "updated")
            self.assertEqual(ranking["date"], "2026-07-16")
            self.assertEqual(ranking["source_metrics"]["observed_hour_count"], 4)
            self.assertEqual(ranking["source_metrics"]["remaining_hour_count"], 20)
            self.assertEqual(ranking["entry_count"], 10)
            self.assertFalse(ranking["source_metrics"]["ranking_complete"])
            validate_payload("event_live", ranking)
            self.assertEqual(len(list((root / "state" / "events" / "live-hours" / "2026-07-16").glob("*.json"))), 4)

            reused = run_live_update(source, github, data_dir=root, generated_at=self.now)
            self.assertEqual(reused["status"], "reused")
            self.assertEqual(len(source.calls), 4)

    def test_next_refresh_fetches_only_the_new_hour_and_tracks_live_movement(self) -> None:
        source = FakeSource(self.records())
        github = FakeGitHub({repository_id: repository(repository_id) for repository_id in range(1, 11)})
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            run_live_update(source, github, data_dir=root, generated_at=self.now)
            later = self.now + dt.timedelta(hours=1)
            _, _, later_cutoff = live_window(later)
            later_hours = expected_hours(self.start, later_cutoff)
            later_records = self.records()
            new_hour = later_hours[-1]
            later_records[new_hour.isoformat()] = [
                watch_event(new_hour, repository_id, repository_id * 100 + 99, f"new-{repository_id}")
                for repository_id in range(1, 11)
            ]
            next_source = FakeSource(later_records)
            result = run_live_update(next_source, github, data_dir=root, generated_at=later)
            ranking = result["ranking"]
            self.assertEqual(result["fetched_hours"], 1)
            self.assertEqual(next_source.calls, [new_hour.isoformat()])
            self.assertEqual(ranking["source_metrics"]["observed_hour_count"], 5)
            self.assertEqual(ranking["source_metrics"]["api_request_count"], 0)
            self.assertTrue(all(item["rank_change"] == 0 for item in ranking["entries"]))
            self.assertTrue(all(item["trend_7d"][-1] == 5 for item in ranking["entries"]))

    def test_metadata_failure_does_not_publish_cached_hours_or_live_output(self) -> None:
        source = FakeSource(self.records())
        github = FakeGitHub({})
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            with self.assertRaises(DataIntegrityError):
                run_live_update(source, github, data_dir=root, generated_at=self.now)
            self.assertFalse((root / "public" / "events" / "live.json").exists())
            self.assertFalse((root / "state" / "events" / "live-hours").exists())

    def test_legacy_cached_metadata_is_refreshed_for_lifecycle_fields(self) -> None:
        github = FakeGitHub({1: repository(1)})
        rows = [{"repository_id": 1, "stars_added": 4, "watch_events": 4}]
        legacy_cache = {
            1: {
                "repository_id": 1,
                "full_name": "fixture/repo-1",
                "description": "legacy",
                "language": "Python",
                "stars_total": 1001,
                "html_url": "https://github.com/fixture/repo-1",
                "owner_avatar_url": None,
            }
        }
        entries, metrics = enrich_live_aggregates(github, rows, metadata_cache=legacy_cache)
        self.assertEqual(github.request_count, 1)
        self.assertEqual(metrics["metadata_cached_count"], 0)
        self.assertEqual(entries[0]["created_at"], "2016-01-01T00:00:00Z")
        self.assertEqual(entries[0]["pushed_at"], "2026-07-16T00:00:00Z")

    def test_out_of_window_event_rejects_the_entire_refresh(self) -> None:
        records = self.records()
        first = self.hours[0]
        records[first.isoformat()] = [watch_event(first + dt.timedelta(hours=1), 1, 1, "outside")]
        source = FakeSource(records)
        github = FakeGitHub({1: repository(1)})
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            with self.assertRaises(DataIntegrityError):
                run_live_update(source, github, data_dir=root, generated_at=self.now)
            self.assertFalse((root / "public" / "events" / "live.json").exists())
            self.assertFalse((root / "state" / "events" / "live-hours").exists())

    def test_source_failure_writes_no_partial_live_state(self) -> None:
        records = self.records()
        source = FakeSource(records, fail_hour=self.hours[1].isoformat())
        github = FakeGitHub({repository_id: repository(repository_id) for repository_id in range(1, 11)})
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            with self.assertRaises(StarRankError):
                run_live_update(source, github, data_dir=root, generated_at=self.now)
            self.assertFalse((root / "public" / "events" / "live.json").exists())
            self.assertFalse((root / "state" / "events" / "live-hours").exists())


if __name__ == "__main__":
    unittest.main()
