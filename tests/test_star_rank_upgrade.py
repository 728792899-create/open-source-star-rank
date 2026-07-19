import datetime as dt
import shutil
import tempfile
import unittest
from pathlib import Path

from tools.star_rank import (
    DataIntegrityError,
    build_daily_ranking,
    build_language_rankings,
    build_period_ranking,
    build_repository_catalog,
    build_snapshot,
    capture_quality,
    complete_period_window,
    language_slug,
    repository_record,
    run_update,
    snapshot_pair_is_valid,
    window_quality,
)
from tools.star_rank_schema import SchemaValidationError, validate_payload
from tools.validate_star_rank_data import ranking_uses_current_repository_catalog, validate_data_tree


def api_repo(repository_id: int, language: str, stars: int) -> dict:
    full_name = f"owner/{language.lower()}-{repository_id}"
    return {
        "id": repository_id,
        "full_name": full_name,
        "description": f"Long-lived test repository {repository_id}",
        "language": language,
        "stargazers_count": stars,
        "html_url": f"https://github.com/{full_name}",
        "owner": {"avatar_url": "https://avatars.example.test/1"},
        "created_at": "2026-01-01T00:00:00Z",
        "pushed_at": "2026-07-14T00:00:00Z",
        "archived": False,
        "disabled": False,
        "fork": False,
    }


class NoCallClient:
    request_count = 0
    retry_count = 0

    def search_repositories(self, *args, **kwargs):
        self.request_count += 1
        raise AssertionError("invalid capture must fail before calling GitHub")


class StarRankUpgradeTests(unittest.TestCase):
    def test_historical_rankings_may_outlive_current_candidate_catalog(self) -> None:
        catalog = {"updated_at": "2026-07-19T00:20:00Z"}
        historical = {"window_end": "2026-07-18T00:20:00Z"}
        current = {"window_end": "2026-07-19T00:20:00Z"}

        self.assertFalse(ranking_uses_current_repository_catalog(historical, catalog))
        self.assertTrue(ranking_uses_current_repository_catalog(current, catalog))

    def test_data_validator_accepts_legacy_11_fixture(self) -> None:
        fixture = Path(__file__).resolve().parents[1] / "site" / "tests" / "fixtures" / "ready-data"
        with tempfile.TemporaryDirectory() as temporary:
            copied_fixture = Path(temporary) / "ready-data"
            shutil.copytree(fixture, copied_fixture)
            counts = validate_data_tree(copied_fixture, sync_schemas=True)
        self.assertEqual(counts["daily"], 1)

    def test_index_schema_accepts_legacy_and_requires_12_sampling(self) -> None:
        legacy = {
            "schema_version": "1.1.0", "status": "initializing", "timezone": "Asia/Shanghai",
            "updated_at": None, "latest_date": None, "available_dates": [], "candidate_count": 0,
            "methodology_version": "candidate-pool-snapshot-v1", "freshness_threshold_hours": 36,
            "latest_collection": None,
        }
        validate_payload("index", legacy)
        with self.assertRaises(SchemaValidationError):
            validate_payload("index", {**legacy, "schema_version": "1.2.0"})

    def test_capture_window_boundaries(self) -> None:
        zone = dt.timezone(dt.timedelta(hours=8))
        self.assertTrue(capture_quality(dt.datetime(2026, 7, 16, 0, 0, tzinfo=zone))["valid_for_ranking"])
        self.assertTrue(capture_quality(dt.datetime(2026, 7, 16, 2, 59, 59, tzinfo=zone))["valid_for_ranking"])
        self.assertFalse(capture_quality(dt.datetime(2026, 7, 16, 3, 0, tzinfo=zone))["valid_for_ranking"])
        self.assertFalse(capture_quality(dt.datetime(2026, 7, 16, 12, 13, tzinfo=zone))["valid_for_ranking"])

    def test_window_duration_boundaries_and_consecutive_dates(self) -> None:
        candidates = [repository_record(api_repo(1, "Python", 10), observed_date="2026-07-15", source="test")]
        zone = dt.timezone(dt.timedelta(hours=8))
        first_at = dt.datetime(2026, 7, 15, 2, 59, tzinfo=zone)
        first = build_snapshot(candidates, captured_at=first_at)
        near_minimum = build_snapshot(candidates, captured_at=dt.datetime(2026, 7, 16, 0, 0, tzinfo=zone))
        self.assertTrue(snapshot_pair_is_valid(first, near_minimum), window_quality(first, near_minimum))
        synthetic_minimum = build_snapshot(candidates, captured_at=dt.datetime(2026, 7, 15, 3, 0, tzinfo=zone))
        synthetic_minimum["capture_quality"]["valid_for_ranking"] = True
        self.assertTrue(snapshot_pair_is_valid(synthetic_minimum, near_minimum))
        near_maximum = build_snapshot(candidates, captured_at=dt.datetime(2026, 7, 16, 2, 59, tzinfo=zone))
        first_at_midnight = build_snapshot(candidates, captured_at=dt.datetime(2026, 7, 15, 0, 0, tzinfo=zone))
        self.assertTrue(snapshot_pair_is_valid(first_at_midnight, near_maximum), window_quality(first_at_midnight, near_maximum))
        exact_maximum = build_snapshot(candidates, captured_at=dt.datetime(2026, 7, 16, 3, 0, tzinfo=zone))
        self.assertFalse(snapshot_pair_is_valid(first_at_midnight, exact_maximum), "03:00 capture is outside the valid window")
        synthetic_maximum = dict(exact_maximum)
        synthetic_maximum["capture_quality"] = {**exact_maximum["capture_quality"], "valid_for_ranking": True}
        self.assertTrue(snapshot_pair_is_valid(first_at_midnight, synthetic_maximum))
        over_maximum = build_snapshot(candidates, captured_at=dt.datetime(2026, 7, 16, 3, 0, 1, tzinfo=zone))
        over_maximum["capture_quality"]["valid_for_ranking"] = True
        self.assertFalse(snapshot_pair_is_valid(first_at_midnight, over_maximum))
        too_short = build_snapshot(candidates, captured_at=first_at + dt.timedelta(hours=20, minutes=59))
        self.assertFalse(snapshot_pair_is_valid(first, too_short))
        skipped = build_snapshot(candidates, captured_at=dt.datetime(2026, 7, 17, 0, 20, tzinfo=zone))
        self.assertFalse(snapshot_pair_is_valid(first, skipped))

    def test_required_capture_fails_before_api_or_writes(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            projects = root / "projects.json"
            projects.write_text("[]\n", encoding="utf-8")
            client = NoCallClient()
            with self.assertRaises(DataIntegrityError):
                run_update(
                    client,
                    data_dir=root / "data",
                    projects_file=projects,
                    captured_at=dt.datetime(2026, 7, 15, 4, 13, tzinfo=dt.timezone.utc),
                    require_valid_capture=True,
                )
            self.assertEqual(client.request_count, 0)
            self.assertFalse((root / "data").exists())

    def test_repository_history_keeps_invalid_window_as_null(self) -> None:
        candidate = repository_record(api_repo(1, "Python", 12), observed_date="2026-07-16", source="test")
        previous = build_snapshot([candidate], captured_at=dt.datetime(2026, 7, 15, 4, 13, tzinfo=dt.timezone.utc))
        current = build_snapshot([candidate], captured_at=dt.datetime(2026, 7, 15, 16, 20, tzinfo=dt.timezone.utc))
        history = {
            dt.date.fromisoformat(previous["snapshot_date"]): previous,
            dt.date.fromisoformat(current["snapshot_date"]): current,
        }
        with tempfile.TemporaryDirectory() as temporary:
            catalog = build_repository_catalog(
                candidates=[candidate], snapshot_history=history, public_dir=Path(temporary),
                knowledge_repositories={}, updated_at=current["captured_at"],
            )
        point = catalog["repositories"][0]["history_30d"][-1]
        self.assertIsNone(point["stars_total"])
        self.assertIsNone(point["stars_gained"])
        self.assertIsNone(point["rank"])

    def test_period_thresholds_language_independence_and_40_day_history(self) -> None:
        start = dt.date(2026, 6, 1)
        candidates = [
            repository_record(
                api_repo(repository_id, "Python" if repository_id <= 6 else "Rust", 1_000 + repository_id),
                observed_date=start.isoformat(),
                source="test",
            )
            for repository_id in range(1, 11)
        ]
        history = {}
        for offset in range(40):
            day = start + dt.timedelta(days=offset)
            captured = dt.datetime.combine(day, dt.time(0, 20), tzinfo=dt.timezone(dt.timedelta(hours=8)))
            snapshot_candidates = []
            for candidate in candidates:
                item = dict(candidate)
                item["stars_total"] = candidate["stars_total"] + offset * int(candidate["repository_id"])
                snapshot_candidates.append(item)
            history[day] = build_snapshot(snapshot_candidates, captured_at=captured)

        self.assertFalse(complete_period_window(dict(list(history.items())[:7]), end_date=start + dt.timedelta(days=6), days=7))
        self.assertTrue(complete_period_window(history, end_date=start + dt.timedelta(days=7), days=7))
        self.assertFalse(complete_period_window(dict(list(history.items())[:30]), end_date=start + dt.timedelta(days=29), days=30))
        self.assertTrue(complete_period_window(history, end_date=start + dt.timedelta(days=30), days=30))

        end_date = start + dt.timedelta(days=30)
        period = build_period_ranking(
            days=30,
            start_snapshot=history[start],
            end_snapshot=history[end_date],
            candidates=candidates,
            snapshot_history=history,
            previous_ranking=None,
            knowledge_repositories={},
        )
        self.assertEqual(period["entries"][0]["repository_id"], 10)
        self.assertEqual(period["entries"][0]["stars_gained"], 300)

        history_with_gap = {date: {**snapshot, "repositories": dict(snapshot["repositories"])} for date, snapshot in history.items()}
        del history_with_gap[start + dt.timedelta(days=15)]["repositories"]["10"]
        period_with_gap = build_period_ranking(
            days=30,
            start_snapshot=history_with_gap[start],
            end_snapshot=history_with_gap[end_date],
            candidates=candidates,
            snapshot_history=history_with_gap,
            previous_ranking=None,
            knowledge_repositories={},
        )
        self.assertNotIn(10, [item["repository_id"] for item in period_with_gap["entries"]])

        daily = build_daily_ranking(
            previous_snapshot=history[end_date - dt.timedelta(days=1)],
            current_snapshot=history[end_date],
            candidates=candidates,
            snapshot_history=history,
            previous_ranking=None,
            knowledge_repositories={},
        )
        rankable = [dict(item) for item in daily["entries"]]
        with tempfile.TemporaryDirectory() as temporary:
            language = build_language_rankings(
                daily_ranking=daily,
                all_rankable=rankable,
                public_dir=Path(temporary),
            )
        self.assertEqual([item["language"] for item in language], ["Python"])
        self.assertEqual(len(language[0]["entries"]), 6)
        self.assertEqual(language[0]["entries"][0]["rank"], 1)
        self.assertNotEqual(language_slug("C"), language_slug("C#"))


if __name__ == "__main__":
    unittest.main()
