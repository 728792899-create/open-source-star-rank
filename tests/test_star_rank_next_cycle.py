from __future__ import annotations

import json
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from tools.rehearse_star_rank_next_cycle import run_next_cycle_rehearsal
from tools.star_rank import TOP_LIMIT
from tools.star_rank_schema import SchemaValidationError, default_schema_dir, validate_payload
from tools.validate_star_rank_data import validate_data_tree


class StarRankNextCycleRehearsalTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.temporary = tempfile.TemporaryDirectory(prefix="star-rank-next-cycle-test-")
        cls.workspace = Path(cls.temporary.name)
        cls.summary = run_next_cycle_rehearsal(cls.workspace)
        cls.data_dir = cls.workspace / "star-rank-data"

    @classmethod
    def tearDownClass(cls) -> None:
        cls.temporary.cleanup()

    def test_two_cycles_publish_and_validate_the_top_limit_boundary(self) -> None:
        self.assertEqual(self.summary["candidate_count"], TOP_LIMIT)
        self.assertEqual(self.summary["snapshot_count"], 2)
        self.assertEqual(self.summary["daily_count"], 1)
        self.assertEqual(self.summary["published_entries"], TOP_LIMIT)
        self.assertEqual(self.summary["maximum_daily_rank"], TOP_LIMIT)
        self.assertEqual(self.summary["maximum_repository_history_rank"], TOP_LIMIT)

    def test_repository_history_rank_above_top_limit_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory(prefix="star-rank-overflow-") as temporary:
            copied_data = Path(temporary) / "star-rank-data"
            shutil.copytree(self.data_dir, copied_data)
            catalog_path = copied_data / "public" / "repositories.json"
            catalog = json.loads(catalog_path.read_text(encoding="utf-8"))
            boundary = next(
                point
                for repository in catalog["repositories"]
                for point in repository["history_30d"]
                if point["rank"] == TOP_LIMIT
            )
            boundary["rank"] = TOP_LIMIT + 1
            catalog_path.write_text(
                json.dumps(catalog, ensure_ascii=False, indent=2) + "\n",
                encoding="utf-8",
            )

            with self.assertRaises(SchemaValidationError):
                validate_data_tree(copied_data)

    def test_lagging_repository_history_contract_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory(prefix="star-rank-schema-drift-") as temporary:
            drifted_schema_dir = Path(temporary) / "schemas"
            shutil.copytree(default_schema_dir(), drifted_schema_dir)
            schema_path = drifted_schema_dir / "repositories.schema.json"
            schema = json.loads(schema_path.read_text(encoding="utf-8"))
            schema["$defs"]["history"]["properties"]["rank"]["maximum"] = TOP_LIMIT - 1
            schema_path.write_text(
                json.dumps(schema, ensure_ascii=False, indent=2) + "\n",
                encoding="utf-8",
            )

            def validate_with_drift(kind: str, payload: object, _schema_dir: Path) -> None:
                validate_payload(kind, payload, drifted_schema_dir)

            with mock.patch(
                "tools.validate_star_rank_data.validate_payload",
                side_effect=validate_with_drift,
            ):
                with self.assertRaises(SchemaValidationError):
                    validate_data_tree(self.data_dir)


if __name__ == "__main__":
    unittest.main()
