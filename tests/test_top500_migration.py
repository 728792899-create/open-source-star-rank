from __future__ import annotations

import hashlib
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from tools.migrate_star_rank_top500 import _rerank, apply_manifest, build_manifest
from tools.star_rank import atomic_write_json


class Top500MigrationTests(unittest.TestCase):
    def test_read_only_manifest_never_invents_event_history(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            date = "2026-07-18"
            daily = root / "public" / "daily" / f"{date}.json"
            event = root / "public" / "events" / "daily" / f"{date}.json"
            atomic_write_json(daily, {"date": date, "schema_version": "1.2.0", "entries": [{"repository_id": value} for value in range(1, 101)]})
            atomic_write_json(root / "public" / "explore" / "daily" / f"{date}.json", {"date": date, "entries": [{"repository_id": value} for value in range(1, 601)]})
            atomic_write_json(event, {"date": date, "schema_version": "1.1.0", "entries": [{"repository_id": value} for value in range(1, 101)]})
            atomic_write_json(root / "public" / "events" / "category" / f"{date}.json", {"date": date, "entries": [{"repository_id": value} for value in range(1, 601)]})
            atomic_write_json(root / "state" / "events" / "daily" / f"{date}.json", {"date": date, "entries": []})
            before = hashlib.sha256(daily.read_bytes() + event.read_bytes()).hexdigest()

            manifest = build_manifest(root)

            after = hashlib.sha256(daily.read_bytes() + event.read_bytes()).hexdigest()
            self.assertEqual(before, after)
            by_kind = {item["kind"]: item for item in manifest["records"]}
            self.assertTrue(by_kind["daily"]["can_recompute"])
            self.assertEqual(by_kind["daily"]["estimated_entry_count"], 500)
            self.assertFalse(by_kind["event_daily"]["can_recompute"])
            self.assertEqual(by_kind["event_daily"]["reason"], "v3_watchevent_hour_coverage_not_proven")

    def test_rerank_preserves_global_order_and_handles_new_depth(self) -> None:
        entries = [{"repository_id": value, "rank": value, "rank_change": None} for value in range(1, 501)]
        previous = {"entries": [{"repository_id": 1, "rank": 2}, {"repository_id": 2, "rank": 1}]}
        ranked = _rerank(entries, previous)
        self.assertEqual(len(ranked), 500)
        self.assertEqual(ranked[0]["rank_change"], 1)
        self.assertEqual(ranked[1]["rank_change"], -1)
        self.assertIsNone(ranked[100]["rank_change"])

    def test_apply_is_idempotent_after_the_safe_source_is_consumed(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            date = "2026-07-20"
            daily = root / "public" / "daily" / f"{date}.json"
            atomic_write_json(daily, {
                "date": date,
                "schema_version": "1.2.0",
                "eligible_count": 600,
                "entries": [
                    {"repository_id": value, "rank": value, "rank_change": None}
                    for value in range(1, 101)
                ],
            })
            atomic_write_json(root / "public" / "explore" / "daily" / f"{date}.json", {
                "date": date,
                "entries": [
                    {"repository_id": value, "rank": value, "rank_change": None}
                    for value in range(1, 601)
                ],
            })

            with (
                mock.patch("tools.migrate_star_rank_top500.validate_payload"),
                mock.patch("tools.migrate_star_rank_top500.validate_data_tree"),
            ):
                first = apply_manifest(root, build_manifest(root), recomputed_at="2026-07-21T00:00:00Z")
                first_hash = hashlib.sha256(daily.read_bytes()).hexdigest()
                second = apply_manifest(root, build_manifest(root), recomputed_at="2026-07-22T00:00:00Z")
                second_hash = hashlib.sha256(daily.read_bytes()).hexdigest()

            self.assertEqual(first, 1)
            self.assertEqual(second, 0)
            self.assertEqual(first_hash, second_hash)

    def test_apply_upgrades_language_index_contract_once(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            language_index = root / "public" / "language" / "index.json"
            atomic_write_json(language_index, {
                "schema_version": "1.2.0",
                "updated_at": "2026-07-20T16:20:00Z",
                "timezone": "Asia/Shanghai",
                "languages": [],
            })

            with (
                mock.patch("tools.migrate_star_rank_top500.validate_payload"),
                mock.patch("tools.migrate_star_rank_top500.validate_data_tree"),
            ):
                first = apply_manifest(
                    root, build_manifest(root), recomputed_at="2026-07-21T00:00:00Z"
                )
                second = apply_manifest(
                    root, build_manifest(root), recomputed_at="2026-07-22T00:00:00Z"
                )

            upgraded = json.loads(language_index.read_text(encoding="utf-8"))
            self.assertEqual(first, 1)
            self.assertEqual(second, 0)
            self.assertEqual(upgraded["schema_version"], "1.3.0")
            self.assertEqual(upgraded["ranking_limit"], 500)
            self.assertEqual(upgraded["page_size"], 100)


if __name__ == "__main__":
    unittest.main()
