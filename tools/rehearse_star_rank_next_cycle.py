#!/usr/bin/env python3
"""Offline rehearsal for the next two valid star-rank collection cycles.

The rehearsal deliberately exercises the production writer and the complete
data-tree validator with exactly ``TOP_LIMIT`` repositories.  It guards the
boundary shared by daily rankings and repository history, where a schema that
lags behind a ranking-limit migration would otherwise fail only after the next
scheduled collection.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import sys
import tempfile
from pathlib import Path
from typing import Any, Mapping, Optional, Sequence
from zoneinfo import ZoneInfo

try:
    from tools.star_rank import (
        DataIntegrityError,
        StarRankError,
        TIMEZONE,
        TOP_LIMIT,
        atomic_write_json,
        load_json,
        run_update,
    )
    from tools.star_rank_schema import SchemaValidationError
    from tools.validate_star_rank_data import validate_data_tree
except ModuleNotFoundError:  # pragma: no cover - direct script execution fallback
    from star_rank import (
        DataIntegrityError,
        StarRankError,
        TIMEZONE,
        TOP_LIMIT,
        atomic_write_json,
        load_json,
        run_update,
    )
    from star_rank_schema import SchemaValidationError
    from validate_star_rank_data import validate_data_tree


REHEARSAL_START = dt.datetime(2026, 7, 1, 0, 20, tzinfo=ZoneInfo(TIMEZONE))


class NextCycleRehearsalError(RuntimeError):
    """Raised when the generated two-cycle data tree misses a gate invariant."""


class OfflineGitHubClient:
    """Deterministic GitHub API substitute used only by the CI rehearsal."""

    retry_count = 0

    def __init__(self, *, cycle: int) -> None:
        self.request_count = 0
        self.repositories = {
            repository_id: self._repository(repository_id, cycle=cycle)
            for repository_id in range(1, TOP_LIMIT + 1)
        }

    @staticmethod
    def _repository(repository_id: int, *, cycle: int) -> dict[str, Any]:
        # The second cycle gives every repository a distinct positive delta.
        # Repository TOP_LIMIT consequently occupies the exact boundary rank.
        gained = TOP_LIMIT - repository_id + 1
        stars = 100_000 + repository_id + cycle * gained
        full_name = f"rehearsal/repository-{repository_id:04d}"
        return {
            "id": repository_id,
            "full_name": full_name,
            "description": f"Offline next-cycle rehearsal repository {repository_id}",
            "language": "Python",
            "stargazers_count": stars,
            "html_url": f"https://github.com/{full_name}",
            "owner": {"avatar_url": "https://avatars.example.test/rehearsal"},
            "created_at": "2025-01-01T00:00:00Z",
            "pushed_at": "2026-06-30T00:00:00Z",
            "archived": False,
            "disabled": False,
            "fork": False,
        }

    def search_repositories(
        self, query: str, *, sort: str, pages: int
    ) -> list[Mapping[str, Any]]:
        del query, sort, pages
        self.request_count += 1
        return [dict(item) for item in self.repositories.values()]

    def get_repository_by_id(self, repository_id: int) -> Optional[Mapping[str, Any]]:
        self.request_count += 1
        item = self.repositories.get(repository_id)
        return dict(item) if item is not None else None

    def get_repository(self, full_name: str) -> Optional[Mapping[str, Any]]:
        self.request_count += 1
        item = next(
            (repository for repository in self.repositories.values() if repository["full_name"] == full_name),
            None,
        )
        return dict(item) if item is not None else None


def run_next_cycle_rehearsal(work_dir: Path) -> dict[str, Any]:
    """Generate and validate two consecutive production-shaped snapshots."""

    workspace = work_dir.resolve()
    data_dir = workspace / "star-rank-data"
    if data_dir.exists():
        raise NextCycleRehearsalError(f"演练数据目录必须不存在：{data_dir}")
    workspace.mkdir(parents=True, exist_ok=True)
    seeds_file = workspace / "seed-repositories.json"
    atomic_write_json(seeds_file, [])

    first = run_update(
        OfflineGitHubClient(cycle=0),
        data_dir=data_dir,
        projects_file=seeds_file,
        captured_at=REHEARSAL_START,
        max_candidates=TOP_LIMIT,
        require_valid_capture=True,
    )
    second = run_update(
        OfflineGitHubClient(cycle=1),
        data_dir=data_dir,
        projects_file=seeds_file,
        captured_at=REHEARSAL_START + dt.timedelta(days=1),
        max_candidates=TOP_LIMIT,
        require_valid_capture=True,
    )

    if first["ranking"] is not None:
        raise NextCycleRehearsalError("首个快照不应生成虚假的日榜")
    ranking = second.get("ranking")
    if ranking is None:
        raise NextCycleRehearsalError("第二个连续有效快照未生成日榜")
    if len(ranking["entries"]) != TOP_LIMIT or ranking["entries"][-1]["rank"] != TOP_LIMIT:
        raise NextCycleRehearsalError(f"日榜未覆盖 Top {TOP_LIMIT} 边界")

    counts = validate_data_tree(data_dir)
    catalog = load_json(data_dir / "public" / "repositories.json")
    history_ranks = [
        point["rank"]
        for repository in catalog["repositories"]
        for point in repository["history_30d"]
        if point["rank"] is not None
    ]
    if not history_ranks or max(history_ranks) != TOP_LIMIT:
        raise NextCycleRehearsalError(f"项目历史未覆盖 Top {TOP_LIMIT} 契约边界")

    return {
        "candidate_count": TOP_LIMIT,
        "snapshot_count": counts["snapshot"],
        "daily_count": counts["daily"],
        "language_count": counts["language"],
        "exploration_pool_count": counts["exploration_pool"],
        "published_entries": len(ranking["entries"]),
        "maximum_daily_rank": ranking["entries"][-1]["rank"],
        "maximum_repository_history_rank": max(history_ranks),
        "ranking_date": ranking["date"],
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="离线演练开源星榜两个连续有效采集周期")
    parser.add_argument(
        "--work-dir",
        type=Path,
        help="保留演练数据的空工作目录；默认使用并自动清理临时目录",
    )
    return parser


def main(argv: Optional[Sequence[str]] = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        if args.work_dir is not None:
            summary = run_next_cycle_rehearsal(args.work_dir)
        else:
            with tempfile.TemporaryDirectory(prefix="star-rank-next-cycle-") as temporary:
                summary = run_next_cycle_rehearsal(Path(temporary))
    except (DataIntegrityError, StarRankError, SchemaValidationError, NextCycleRehearsalError, OSError) as exc:
        print(f"演练失败：{exc}", file=sys.stderr)
        return 1
    print(json.dumps(summary, ensure_ascii=False, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
