from __future__ import annotations

import datetime as dt
import json
import re
import tempfile
import unittest
from pathlib import Path
from typing import Any

from tools.alltime_star_rank import (
    build_alltime_entries,
    build_alltime_outputs,
    run_alltime_update,
)
from tools.star_rank import DataIntegrityError
from tools.star_rank_schema import validate_payload
from tools.validate_star_rank_data import validate_data_tree


class FakeSearchClient:
    def __init__(self, items: list[dict[str, Any]]) -> None:
        self.items = items
        self.request_count = 10
        self.retry_count = 1
        self.queries: list[tuple[str, str, int, int]] = []

    def search_repository_page(
        self, query: str, *, sort: str, page: int, per_page: int = 100
    ) -> dict[str, Any]:
        self.queries.append((query, sort, page, per_page))
        range_match = re.search(r"stars:(\d+)\.\.(\d+)", query)
        minimum_match = re.search(r"stars:>=(\d+)", query)
        exact_match = re.search(r"stars:(\d+)(?:\s|$)", query)
        if range_match:
            minimum, maximum = map(int, range_match.groups())
            matched = [item for item in self.items if minimum <= item["stargazers_count"] <= maximum]
        elif minimum_match:
            minimum = int(minimum_match.group(1))
            matched = [item for item in self.items if item["stargazers_count"] >= minimum]
        elif exact_match:
            exact = int(exact_match.group(1))
            matched = [item for item in self.items if item["stargazers_count"] == exact]
        else:
            matched = list(self.items)
        matched.sort(key=lambda item: (-item["stargazers_count"], item["full_name"].casefold()))
        start = (page - 1) * per_page
        return {
            "total_count": len(matched),
            "incomplete_results": False,
            "items": matched[start : start + per_page],
        }


def search_item(repository_id: int, stars: int, **overrides: Any) -> dict[str, Any]:
    payload = {
        "id": repository_id,
        "full_name": f"fixture/repo-{repository_id}",
        "description": f"Repository {repository_id}",
        "language": "Python",
        "stargazers_count": stars,
        "html_url": f"https://github.com/fixture/repo-{repository_id}",
        "owner": {"avatar_url": f"https://avatars.githubusercontent.com/u/{repository_id}"},
        "created_at": "2016-01-01T00:00:00Z",
        "pushed_at": "2026-07-16T00:00:00Z",
        "private": False,
        "fork": False,
        "archived": False,
        "disabled": False,
    }
    payload.update(overrides)
    return payload


class AllTimeStarRankTests(unittest.TestCase):
    def setUp(self) -> None:
        self.now = dt.datetime(2026, 7, 17, 1, 0, tzinfo=dt.timezone.utc)

    def test_entries_are_deduplicated_filtered_and_sorted_by_total_stars(self) -> None:
        items = [
            search_item(3, 300_000),
            search_item(1, 500_000),
            search_item(1, 500_000),  # duplicate id must collapse
            search_item(2, 400_000, fork=True),  # forks never publish
            search_item(4, 400_000, archived=True),
            search_item(5, 400_000),
            search_item(6, 300_000, full_name="fixture/aaa"),  # star tie -> name order
        ]
        entries = build_alltime_entries(items, top_limit=4)
        self.assertEqual([item["repository_id"] for item in entries], [1, 5, 6, 3])
        self.assertEqual([item["rank"] for item in entries], [1, 2, 3, 4])
        self.assertEqual(entries[0]["stars_total"], 500_000)

    def test_top_limit_truncates_the_published_board(self) -> None:
        items = [search_item(index + 1, 100_000 - index) for index in range(50)]
        entries = build_alltime_entries(items, top_limit=10)
        self.assertEqual(len(entries), 10)
        self.assertEqual(entries[-1]["rank"], 10)

    def test_outputs_satisfy_public_schemas_and_search_contract(self) -> None:
        client = FakeSearchClient([search_item(index + 1, 900_000 - index * 10) for index in range(1000)])
        board, index = build_alltime_outputs(
            client, generated_at=self.now, minimum_stars=10_000, top_limit=1000, max_pages=10
        )
        validate_payload("alltime", board)
        validate_payload("alltime_index", index)
        self.assertEqual(client.queries[0], ("stars:>=10000 is:public fork:false archived:false", "stars", 1, 100))
        self.assertEqual(board["entry_count"], 1000)
        self.assertGreaterEqual(board["source_metrics"]["search_result_count"], 1000)
        self.assertTrue(board["source_metrics"]["ranking_complete"])
        self.assertEqual(index["ranking_limit"], 1000)
        self.assertEqual(index["top_stars"], 900_000)
        self.assertEqual(index["status"], "ready")
        self.assertEqual(index["updated_at"], board["generated_at"])

    def test_empty_search_refuses_to_publish(self) -> None:
        with self.assertRaises(DataIntegrityError):
            build_alltime_entries([search_item(1, 10, fork=True)], top_limit=1000)

    def test_run_writes_validated_board_next_to_the_other_public_data(self) -> None:
        client = FakeSearchClient([search_item(index + 1, 700_000 - index) for index in range(1000)])
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "public").mkdir(parents=True)
            (root / "public" / "index.json").write_text(
                json.dumps(
                    {
                        "schema_version": "1.1.0",
                        "status": "initializing",
                        "timezone": "Asia/Shanghai",
                        "updated_at": None,
                        "latest_date": None,
                        "available_dates": [],
                        "candidate_count": 0,
                        "methodology_version": "candidate-pool-snapshot-v1",
                        "freshness_threshold_hours": 36,
                        "latest_collection": None,
                    }
                ),
                encoding="utf-8",
            )
            result = run_alltime_update(client, data_dir=root, generated_at=self.now)
            self.assertEqual(result["status"], "updated")
            board_path = root / "public" / "alltime" / "top-1000.json"
            index_path = root / "public" / "alltime" / "index.json"
            self.assertTrue(board_path.is_file())
            self.assertTrue(index_path.is_file())
            counts = validate_data_tree(root)
            self.assertEqual(counts["alltime"], 1)

    def test_partitioned_search_backfills_filtered_first_page_results(self) -> None:
        items = [search_item(index + 1, 500_000 - index, fork=index < 30) for index in range(1_050)]
        client = FakeSearchClient(items)
        board, _ = build_alltime_outputs(
            client, generated_at=self.now, minimum_stars=10_000, top_limit=1000, max_pages=10
        )
        self.assertEqual(board["entry_count"], 1000)
        self.assertNotIn(1, {item["repository_id"] for item in board["entries"]})
        self.assertGreater(board["source_metrics"]["search_partition_count"], 2)
        cutoff = board["entries"][-1]["stars_total"]
        self.assertTrue(any(query.startswith(f"stars:{cutoff} ") for query, *_ in client.queries))
        self.assertEqual(board["source_metrics"]["cutoff_bucket_count"], 1)

    def test_run_rejects_invalid_depth_or_threshold(self) -> None:
        client = FakeSearchClient([search_item(1, 700_000)])
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            with self.assertRaises(DataIntegrityError):
                run_alltime_update(client, data_dir=root, generated_at=self.now, top_limit=0)
            with self.assertRaises(DataIntegrityError):
                run_alltime_update(client, data_dir=root, generated_at=self.now, top_limit=1001)
            with self.assertRaises(DataIntegrityError):
                run_alltime_update(client, data_dir=root, generated_at=self.now, minimum_stars=-1)
            self.assertFalse((root / "public" / "alltime").exists())


if __name__ == "__main__":
    unittest.main()
