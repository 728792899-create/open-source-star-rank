from __future__ import annotations

import datetime as dt
import json
import shutil
import tempfile
import unittest
from pathlib import Path
from typing import Any

from tools.event_star_rank import (
    DEFAULT_MAXIMUM_BYTES_BILLED,
    build_event_outputs,
    build_watch_event_query,
    enrich_aggregates,
    event_window,
    prune_event_states,
    prune_event_pools,
    rebuild_dependent_rankings,
    run_event_update,
    source_table_dates,
)
from tools.star_rank import DataIntegrityError, RateLimitError, StarRankError, atomic_write_json
from tools.star_rank_schema import validate_payload
from tools.validate_star_rank_data import event_entry_sort_key, validate_data_tree


class FakeRunner:
    def __init__(self, rows: list[dict[str, Any]], *, estimate: int = 1024, processed: int = 1024) -> None:
        self.rows = rows
        repository_count = len(rows)
        watch_event_count = sum(int(item["watch_events"]) for item in rows)
        unique_star_addition_count = sum(int(item["stars_added"]) for item in rows)
        for item in self.rows:
            item.update(
                {
                    "observed_repository_count": repository_count,
                    "observed_watch_event_count": watch_event_count,
                    "unique_star_addition_count": unique_star_addition_count,
                    "observed_hour_count": 24,
                    "missing_hours": [],
                }
            )
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
        "observed_repository_count": 1,
        "observed_watch_event_count": events if events is not None else stars,
        "unique_star_addition_count": stars,
        "observed_hour_count": 24,
        "missing_hours": [],
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
        query = build_watch_event_query(self.date)
        self.assertIn("`githubarchive.day.20260714`", query)
        self.assertIn("COUNT(DISTINCT actor_id)", query)
        self.assertIn("COUNT(DISTINCT id)", query)
        self.assertIn("GENERATE_TIMESTAMP_ARRAY", query)
        self.assertIn("ORDER BY stars_added DESC, watch_events DESC, repository_id ASC", query)
        self.assertNotIn("LIMIT 500", query)
        self.assertNotIn("payload", query)

    def test_legacy_event_pool_order_remains_compatible(self) -> None:
        entries = [
            {
                "repository_id": 1,
                "full_name": "fixture/smaller",
                "stars_total": 100,
                "stars_added": 8,
                "watch_events": 8,
            },
            {
                "repository_id": 2,
                "full_name": "fixture/larger",
                "stars_total": 10_000,
                "stars_added": 8,
                "watch_events": 8,
            },
        ]
        legacy = sorted(entries, key=lambda item: event_entry_sort_key(item, "1.0.0"))
        current = sorted(entries, key=lambda item: event_entry_sort_key(item, "1.1.0"))
        self.assertEqual([item["repository_id"] for item in legacy], [2, 1])
        self.assertEqual([item["repository_id"] for item in current], [1, 2])

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
        rows = [aggregate(2, 312, 313), aggregate(1, 312), aggregate(3, 310), aggregate(4, 309), aggregate(5, 308)]
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
                top_limit=100,
            )
            ranking = result["ranking"]
            self.assertEqual([item["repository_id"] for item in ranking["entries"][:3]], [2, 1, 3])
            self.assertEqual(ranking["entries"][0]["trend_7d"], [None, None, None, None, None, None, 312])
            self.assertEqual(ranking["source_metrics"]["metadata_not_found_count"], 1)
            self.assertEqual(ranking["source_metrics"]["metadata_filtered_count"], 5)
            self.assertEqual(ranking["source_metrics"]["observed_hour_count"], 24)
            self.assertTrue(ranking["source_metrics"]["ranking_complete"])
            state = (root / "state" / "events" / "daily" / f"{self.date.isoformat()}.json").read_text()
            self.assertEqual(state.count('"repository_id"'), len(rows))
            counts = validate_data_tree(root)
            self.assertEqual(counts["event_daily"], 1)
            reused = run_event_update(
                runner,
                github,
                data_dir=root,
                date=self.date,
                generated_at=self.now,
                top_limit=100,
            )
            self.assertEqual(reused["status"], "reused")
            self.assertEqual(runner.run_count, 1)
            validated = run_event_update(
                runner,
                github,
                data_dir=root,
                date=self.date,
                generated_at=self.now,
                top_limit=100,
                validate_only=True,
            )
            self.assertEqual(validated["status"], "validated")
            self.assertEqual(runner.run_count, 2)
            replaced = run_event_update(
                runner,
                github,
                data_dir=root,
                date=self.date,
                generated_at=self.now,
                top_limit=100,
                replace_day=True,
            )
            self.assertEqual(replaced["status"], "updated")
            self.assertEqual(runner.run_count, 3)

    def test_category_pool_extends_enrichment_without_touching_the_top_100(self) -> None:
        rows = [aggregate(repository_id, 400 - repository_id) for repository_id in range(1, 181)]
        payloads: dict[int, dict[str, Any] | None] = {
            repository_id: repository(repository_id) for repository_id in range(1, 181)
        }
        payloads[150] = None  # pool candidates may 404 without failing the run
        payloads[151] = repository(151, fork=True)
        github = FakeGitHub(payloads)
        runner = FakeRunner(rows)
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
                top_limit=100,
                category_pool_limit=160,
            )
            self.assertEqual(len(result["ranking"]["entries"]), 100)
            self.assertEqual(result["category_pool_size"], 160)
            pool_path = root / "public" / "events" / "category" / f"{self.date.isoformat()}.json"
            pool = validate_data_tree(root)
            self.assertEqual(pool["event_category_pool"], 1)
            payload = json.loads(pool_path.read_text(encoding="utf-8"))
            self.assertEqual(payload["pool_size"], 160)
            entries = payload["entries"]
            self.assertEqual([item["rank"] for item in entries[:3]], [1, 2, 3])
            self.assertEqual(entries[0]["repository_id"], 1)
            pool_ids = {item["repository_id"] for item in entries}
            self.assertNotIn(150, pool_ids)
            self.assertNotIn(151, pool_ids)
            self.assertEqual(
                [item["repository_id"] for item in entries[:100]],
                [item["repository_id"] for item in result["ranking"]["entries"]],
            )

    def test_category_pool_rate_limit_shrinks_pool_without_failing_the_day(self) -> None:
        rows = [aggregate(repository_id, 400 - repository_id) for repository_id in range(1, 181)]
        payloads = {repository_id: repository(repository_id) for repository_id in range(1, 181)}
        github = FakeGitHub(payloads, fail_at=130)
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            shutil.copytree(
                Path(__file__).resolve().parents[1] / "site" / "seed-data",
                root / "public",
                dirs_exist_ok=True,
            )
            result = run_event_update(
                FakeRunner(rows),
                github,
                data_dir=root,
                date=self.date,
                generated_at=self.now,
                top_limit=100,
                category_pool_limit=160,
            )
            self.assertEqual(result["status"], "updated")
            self.assertEqual(len(result["ranking"]["entries"]), 100)
            self.assertEqual(result["category_pool_size"], 129)
            counts = validate_data_tree(root)
            self.assertEqual(counts["event_daily"], 1)
            self.assertEqual(counts["event_category_pool"], 1)

    def test_category_pool_is_opt_in_and_bounded(self) -> None:
        rows = [aggregate(repository_id, 400 - repository_id) for repository_id in range(1, 121)]
        payloads = {repository_id: repository(repository_id) for repository_id in range(1, 121)}
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            shutil.copytree(
                Path(__file__).resolve().parents[1] / "site" / "seed-data",
                root / "public",
                dirs_exist_ok=True,
            )
            with self.assertRaises(DataIntegrityError):
                run_event_update(
                    FakeRunner(rows),
                    FakeGitHub(payloads),
                    data_dir=root,
                    date=self.date,
                    generated_at=self.now,
                    top_limit=100,
                    category_pool_limit=99,
                )
            with self.assertRaises(DataIntegrityError):
                run_event_update(
                    FakeRunner(rows),
                    FakeGitHub(payloads),
                    data_dir=root,
                    date=self.date,
                    generated_at=self.now,
                    top_limit=100,
                    category_pool_limit=1001,
                )
            result = run_event_update(
                FakeRunner(rows),
                FakeGitHub(payloads),
                data_dir=root,
                date=self.date,
                generated_at=self.now,
                top_limit=100,
            )
            self.assertEqual(result["category_pool_size"], 0)
            self.assertFalse((root / "public" / "events" / "category").exists())

    def test_rank_change_and_trend_keep_missing_global_days_as_null(self) -> None:
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
        rows = [aggregate(item["repository_id"], item["stars_added"], item["watch_events"]) for item in enriched]
        FakeRunner(rows)
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

    def test_metadata_does_not_change_the_global_event_order(self) -> None:
        rows = [aggregate(1, 100, 101), aggregate(2, 100, 101)]
        enriched, _ = enrich_aggregates(
            FakeGitHub({
                1: repository(1, stars_total=1, full_name="z/repo"),
                2: repository(2, stars_total=999_999, full_name="a/repo"),
            }),
            rows,
            top_limit=2,
            metadata_attempt_limit=2,
        )
        self.assertEqual([item["repository_id"] for item in enriched], [1, 2])

    def test_event_schema_keeps_legacy_1_0_0_compatible(self) -> None:
        enriched = [
            {
                "repository_id": repository_id,
                "full_name": f"fixture/repo-{repository_id}",
                "description": None,
                "language": "Python",
                "stars_total": 1_000,
                "stars_added": 201 - repository_id,
                "watch_events": 201 - repository_id,
                "html_url": f"https://github.com/fixture/repo-{repository_id}",
                "owner_avatar_url": None,
            }
            for repository_id in range(1, 101)
        ]
        rows = [aggregate(item["repository_id"], item["stars_added"]) for item in enriched]
        FakeRunner(rows)
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
            state_history={},
            previous_ranking=None,
            top_limit=100,
        )
        legacy_metrics = {
            key: value
            for key, value in ranking["source_metrics"].items()
            if key not in {
                "scope", "counting_unit", "expected_hour_count", "observed_hour_count",
                "missing_hours", "unique_star_addition_count", "ranking_complete",
            }
        }
        legacy = {
            **ranking,
            "schema_version": "1.0.0",
            "methodology_version": "gharchive-public-watch-events-v1",
            "source_metrics": legacy_metrics,
        }
        validate_payload("event_daily", legacy)

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

    def test_validate_only_requires_complete_hourly_coverage_without_writes(self) -> None:
        rows = [aggregate(index, 200 - index) for index in range(1, 101)]
        runner = FakeRunner(rows)
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            result = run_event_update(
                runner,
                FakeGitHub({}),
                data_dir=root,
                date=self.date,
                generated_at=self.now,
                validate_only=True,
            )
            self.assertEqual(result["coverage"]["observed_hour_count"], 24)
            self.assertEqual(result["status"], "validated")
            self.assertFalse((root / "public").exists())

            incomplete_runner = FakeRunner(rows)
            incomplete_runner.rows[0]["observed_hour_count"] = 23
            incomplete_runner.rows[0]["missing_hours"] = ["2026-07-15T03:00:00Z"]
            with self.assertRaisesRegex(DataIntegrityError, "23/24"):
                run_event_update(
                    incomplete_runner,
                    FakeGitHub({}),
                    data_dir=root,
                    date=self.date,
                    generated_at=self.now,
                    validate_only=True,
                )

    def test_metadata_scan_can_pass_five_hundred_filtered_repositories(self) -> None:
        rows = [aggregate(index, 2_000 - index) for index in range(1, 701)]
        payloads = {
            index: repository(index, archived=index <= 550)
            for index in range(1, 701)
        }
        with tempfile.TemporaryDirectory() as temporary:
            result = run_event_update(
                FakeRunner(rows),
                FakeGitHub(payloads),
                data_dir=Path(temporary),
                date=self.date,
                generated_at=self.now,
                metadata_attempt_limit=900,
            )
            self.assertEqual(result["ranking"]["entries"][0]["repository_id"], 551)
            self.assertEqual(result["ranking"]["source_metrics"]["metadata_attempted_count"], 650)

    def test_metadata_attempt_limit_fails_atomically(self) -> None:
        rows = [aggregate(index, 2_000 - index) for index in range(1, 1_001)]
        payloads = {index: repository(index, archived=True) for index in range(1, 901)}
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            with self.assertRaisesRegex(DataIntegrityError, "900"):
                run_event_update(
                    FakeRunner(rows),
                    FakeGitHub(payloads),
                    data_dir=root,
                    date=self.date,
                    generated_at=self.now,
                    metadata_attempt_limit=900,
                )
            self.assertFalse((root / "public" / "events").exists())

    def test_internal_global_aggregate_state_retention_is_thirty_days(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            old = self.date - dt.timedelta(days=30)
            retained = self.date - dt.timedelta(days=29)
            atomic_write_json(root / f"{old.isoformat()}.json", {"entries": []})
            atomic_write_json(root / f"{retained.isoformat()}.json", {"entries": []})
            removed = prune_event_states(root, current_date=self.date)
            self.assertEqual(removed, [root / f"{old.isoformat()}.json"])
            self.assertTrue((root / f"{retained.isoformat()}.json").exists())

    def test_public_event_exploration_pools_are_permanent(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            old = self.date - dt.timedelta(days=365)
            path = root / f"{old.isoformat()}.json"
            atomic_write_json(path, {"entries": []})
            self.assertEqual(prune_event_pools(root, current_date=self.date), [])
            self.assertTrue(path.exists())


if __name__ == "__main__":
    unittest.main()
