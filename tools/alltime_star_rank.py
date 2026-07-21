#!/usr/bin/env python3
"""Collect the all-time most-starred public GitHub repositories.

Unlike the daily boards, this ranking is a static "hall of fame" sorted by the
cumulative star count reported by the GitHub Search API. GitHub caps each search
at 1,000 results, so the collector walks descending star ranges and backfills
filtered repositories until it has exactly 1,000 valid public repositories.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import sys
from pathlib import Path
from typing import Any, Mapping, Optional, Protocol, Sequence
from zoneinfo import ZoneInfo

try:
    from tools.star_rank import (
        DataIntegrityError,
        GitHubClient,
        StarRankError,
        atomic_write_json,
        isoformat,
        parse_timestamp,
        utc_now,
    )
    from tools.star_rank_schema import SchemaValidationError, sync_public_schemas, validate_payload
except ModuleNotFoundError:  # pragma: no cover - direct script execution fallback
    from star_rank import (  # type: ignore
        DataIntegrityError,
        GitHubClient,
        StarRankError,
        atomic_write_json,
        isoformat,
        parse_timestamp,
        utc_now,
    )
    from star_rank_schema import SchemaValidationError, sync_public_schemas, validate_payload  # type: ignore


SCHEMA_VERSION = "1.1.0"
METHODOLOGY_VERSION = "github-search-most-starred-v2"
DEFAULT_TOP_LIMIT = 1000
MAX_TOP_LIMIT = 1000
DEFAULT_MINIMUM_STARS = 10_000
DEFAULT_MAX_PAGES = 10
FRESHNESS_THRESHOLD_HOURS = 192


class SearchClient(Protocol):
    request_count: int
    retry_count: int

    def search_repository_page(
        self, query: str, *, sort: str, page: int, per_page: int = 100
    ) -> Mapping[str, Any]: ...


def _entry(item: Mapping[str, Any], rank: int) -> dict[str, Any]:
    return {
        "repository_id": int(item["id"]),
        "full_name": str(item["full_name"]),
        "description": item.get("description"),
        "language": item.get("language"),
        "stars_total": int(item["stargazers_count"]),
        "created_at": item.get("created_at"),
        "pushed_at": item.get("pushed_at"),
        "rank": rank,
        "html_url": str(item["html_url"]),
        "owner_avatar_url": (item.get("owner") or {}).get("avatar_url"),
    }


def build_alltime_entries(
    items: Sequence[Mapping[str, Any]], *, top_limit: int
) -> list[dict[str, Any]]:
    seen: set[int] = set()
    kept: list[Mapping[str, Any]] = []
    for item in items:
        if item.get("fork") or item.get("private") or item.get("archived") or item.get("disabled"):
            continue
        repository_id = int(item["id"])
        if repository_id in seen:
            continue
        seen.add(repository_id)
        kept.append(item)
    kept.sort(key=lambda item: (-int(item["stargazers_count"]), str(item["full_name"]).casefold()))
    entries = [_entry(item, rank) for rank, item in enumerate(kept[:top_limit], start=1)]
    if len(entries) < top_limit:
        raise DataIntegrityError(
            f"GitHub 搜索仅得到 {len(entries)} 个有效仓库，无法完整发布 Top {top_limit}"
        )
    return entries


def _search_query(minimum_stars: int, maximum_stars: Optional[int] = None) -> str:
    stars = f"stars:>={minimum_stars}" if maximum_stars is None else f"stars:{minimum_stars}..{maximum_stars}"
    return f"{stars} is:public fork:false archived:false"


def _search_pages(
    client: SearchClient,
    query: str,
    *,
    max_pages: int,
) -> tuple[list[Mapping[str, Any]], int]:
    items: list[Mapping[str, Any]] = []
    total_count: Optional[int] = None
    for page in range(1, max_pages + 1):
        payload = client.search_repository_page(query, sort="stars", page=page, per_page=100)
        page_items = payload.get("items")
        if not isinstance(page_items, list) or not isinstance(payload.get("total_count"), int):
            raise DataIntegrityError("GitHub 搜索响应缺少 items 或 total_count")
        if payload.get("incomplete_results") is True:
            raise DataIntegrityError("GitHub 搜索标记为 incomplete_results，拒绝生成历史榜")
        if total_count is None:
            total_count = int(payload["total_count"])
        elif total_count != int(payload["total_count"]):
            raise DataIntegrityError("GitHub 搜索分页期间 total_count 发生变化，拒绝发布不稳定结果")
        items.extend(page_items)
        if len(page_items) < 100 or len(items) >= total_count:
            break
    return items, int(total_count or 0)


def collect_alltime_candidates(
    client: SearchClient,
    *,
    minimum_stars: int,
    top_limit: int,
    max_pages: int,
) -> tuple[list[Mapping[str, Any]], dict[str, int]]:
    """Walk descending star ranges until enough valid repositories are available.

    The first query may expose only GitHub Search's first 1,000 hits.  Moving the
    upper star boundary below the last fetched star count makes later queries
    disjoint and lets filtered/disabled repositories be replaced without using
    page 11.  The full cutoff-star bucket is fetched whenever it is representable
    within the Search cap, which keeps name-based tie ordering deterministic.
    """

    collected: dict[int, Mapping[str, Any]] = {}
    upper: Optional[int] = None
    raw_count = 0
    partition_count = 0
    rejected_count = 0
    cutoff_bucket_count = 0

    def valid_sorted() -> list[Mapping[str, Any]]:
        valid = [
            item for item in collected.values()
            if not item.get("fork") and not item.get("private")
            and not item.get("archived") and not item.get("disabled")
        ]
        valid.sort(key=lambda item: (
            -int(item["stargazers_count"]),
            str(item["full_name"]).casefold(),
            int(item["id"]),
        ))
        return valid

    while True:
        query = _search_query(minimum_stars, upper)
        batch, total_count = _search_pages(client, query, max_pages=max_pages)
        partition_count += 1
        raw_count += len(batch)
        if not batch:
            break
        for item in batch:
            collected[int(item["id"])] = item

        fetched_floor = min(int(item["stargazers_count"]) for item in batch)
        exact_query = f"stars:{fetched_floor} is:public fork:false archived:false"
        exact_items, exact_total = _search_pages(client, exact_query, max_pages=max_pages)
        partition_count += 1
        raw_count += len(exact_items)
        cutoff_bucket_count = exact_total
        if exact_total > max_pages * 100:
            raise DataIntegrityError(
                f"Star={fetched_floor} 的并列仓库超过 GitHub Search 1000 条上限，无法保证稳定截断"
            )
        for item in exact_items:
            collected[int(item["id"])] = item

        valid = valid_sorted()
        rejected_count = len(collected) - len(valid)
        if len(valid) >= top_limit:
            cutoff = int(valid[top_limit - 1]["stargazers_count"])
            if fetched_floor <= cutoff:
                if cutoff != fetched_floor:
                    final_tie_items, final_tie_total = _search_pages(
                        client,
                        f"stars:{cutoff} is:public fork:false archived:false",
                        max_pages=max_pages,
                    )
                    partition_count += 1
                    raw_count += len(final_tie_items)
                    if final_tie_total > max_pages * 100:
                        raise DataIntegrityError(
                            f"Star={cutoff} 的并列仓库超过 GitHub Search 1000 条上限，无法保证稳定截断"
                        )
                    for item in final_tie_items:
                        collected[int(item["id"])] = item
                    cutoff_bucket_count = final_tie_total
                    valid = valid_sorted()
                    rejected_count = len(collected) - len(valid)
                    if len(valid) < top_limit or int(valid[top_limit - 1]["stargazers_count"]) != cutoff:
                        raise DataIntegrityError("补齐截止 Star 并列桶后排名边界发生非预期变化")
                return valid, {
                    "search_result_count": raw_count,
                    "search_partition_count": partition_count,
                    "rejected_result_count": rejected_count,
                    "cutoff_stars": cutoff,
                    "cutoff_bucket_count": cutoff_bucket_count,
                }
        if fetched_floor <= minimum_stars:
            break
        upper = fetched_floor - 1
        if total_count <= len(batch) and upper < minimum_stars:
            break

    raise DataIntegrityError(
        f"分段搜索后仍不足 {top_limit} 个有效公开仓库；最低 Star 阈值为 {minimum_stars}"
    )


def next_weekly_refresh(generated_at: dt.datetime) -> dt.datetime:
    local = generated_at.astimezone(ZoneInfo("Asia/Shanghai"))
    days_until_monday = (7 - local.weekday()) % 7
    candidate = dt.datetime.combine(
        local.date() + dt.timedelta(days=days_until_monday),
        dt.time(10, 0),
        ZoneInfo("Asia/Shanghai"),
    )
    if candidate <= local:
        candidate += dt.timedelta(days=7)
    return candidate


def build_alltime_outputs(
    client: SearchClient,
    *,
    generated_at: dt.datetime,
    minimum_stars: int,
    top_limit: int,
    max_pages: int,
) -> tuple[dict[str, Any], dict[str, Any]]:
    items, collection_metrics = collect_alltime_candidates(
        client,
        minimum_stars=minimum_stars,
        top_limit=top_limit,
        max_pages=max_pages,
    )
    entries = build_alltime_entries(items, top_limit=top_limit)
    board = {
        "schema_version": SCHEMA_VERSION,
        "generated_at": isoformat(generated_at),
        "methodology_version": METHODOLOGY_VERSION,
        "source_metrics": {
            "provider": "github_search",
            "sort": "stars",
            "minimum_stars": int(minimum_stars),
            **collection_metrics,
            "api_request_count": int(getattr(client, "request_count", 0)),
            "api_retry_count": int(getattr(client, "retry_count", 0)),
            "ranking_complete": True,
        },
        "ranking_limit": top_limit,
        "entry_count": len(entries),
        "entries": entries,
    }
    index = {
        "schema_version": SCHEMA_VERSION,
        "status": "ready",
        "updated_at": isoformat(generated_at),
        "methodology_version": METHODOLOGY_VERSION,
        "ranking_limit": top_limit,
        "entry_count": len(entries),
        "top_stars": entries[0]["stars_total"],
        "freshness_threshold_hours": FRESHNESS_THRESHOLD_HOURS,
        "next_refresh_at": isoformat(next_weekly_refresh(generated_at)),
    }
    return board, index


def run_alltime_update(
    client: SearchClient,
    *,
    data_dir: Path,
    generated_at: dt.datetime,
    minimum_stars: int = DEFAULT_MINIMUM_STARS,
    top_limit: int = DEFAULT_TOP_LIMIT,
    max_pages: int = DEFAULT_MAX_PAGES,
) -> dict[str, Any]:
    if top_limit < 1 or top_limit > MAX_TOP_LIMIT:
        raise DataIntegrityError(f"全站历史榜发布深度必须在 1 到 {MAX_TOP_LIMIT} 之间")
    if minimum_stars < 0:
        raise DataIntegrityError("最小星标阈值不得为负")
    board, index = build_alltime_outputs(
        client,
        generated_at=generated_at,
        minimum_stars=minimum_stars,
        top_limit=top_limit,
        max_pages=max_pages,
    )
    validate_payload("alltime", board)
    validate_payload("alltime_index", index)
    public_dir = data_dir / "public"
    sync_public_schemas(public_dir)
    atomic_write_json(public_dir / "alltime" / "top-1000.json", board)
    atomic_write_json(public_dir / "alltime" / "index.json", index)
    return {"status": "updated", "board": board, "index": index}


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="采集 GitHub 全站历史最高星仓库榜")
    parser.add_argument("--data-dir", type=Path, required=True)
    parser.add_argument("--minimum-stars", type=int, default=DEFAULT_MINIMUM_STARS)
    parser.add_argument("--top-limit", type=int, default=DEFAULT_TOP_LIMIT)
    parser.add_argument("--max-pages", type=int, default=DEFAULT_MAX_PAGES)
    parser.add_argument("--now", help="测试用 ISO-8601 时间")
    return parser


def main(argv: Optional[Sequence[str]] = None) -> int:
    args = build_parser().parse_args(argv)
    now = parse_timestamp(args.now) if args.now else utc_now()
    try:
        token = os.environ.get("GITHUB_TOKEN")
        if not token:
            raise DataIntegrityError("正式采集必须通过 GITHUB_TOKEN 提供 GitHub API 令牌")
        result = run_alltime_update(
            GitHubClient(token),
            data_dir=args.data_dir.resolve(),
            generated_at=now,
            minimum_stars=args.minimum_stars,
            top_limit=args.top_limit,
            max_pages=args.max_pages,
        )
    except (StarRankError, SchemaValidationError, ValueError) as exc:
        print(f"错误：{exc}", file=sys.stderr)
        return 1
    board = result["board"]
    print(
        json.dumps(
            {
                "status": result["status"],
                "entry_count": board["entry_count"],
                "top_stars": board["entries"][0]["stars_total"],
                "search_result_count": board["source_metrics"]["search_result_count"],
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
