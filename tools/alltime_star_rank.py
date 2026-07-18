#!/usr/bin/env python3
"""Collect the all-time most-starred public GitHub repositories.

Unlike the daily boards, this ranking is a static "hall of fame" sorted by the
cumulative star count reported by the GitHub Search API. GitHub caps a single
search at 1,000 results (10 pages of 100), which is exactly the published depth,
so a `sort=stars` descending query returns the true global top 1,000.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import sys
from pathlib import Path
from typing import Any, Mapping, Optional, Protocol, Sequence

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


SCHEMA_VERSION = "1.0.0"
METHODOLOGY_VERSION = "github-search-most-starred-v1"
DEFAULT_TOP_LIMIT = 1000
MAX_TOP_LIMIT = 1000
DEFAULT_MINIMUM_STARS = 10_000
DEFAULT_MAX_PAGES = 10
FRESHNESS_THRESHOLD_HOURS = 192


class SearchClient(Protocol):
    request_count: int
    retry_count: int

    def search_repositories(
        self, query: str, *, sort: str, pages: int
    ) -> Sequence[Mapping[str, Any]]: ...


def _entry(item: Mapping[str, Any], rank: int) -> dict[str, Any]:
    return {
        "repository_id": int(item["id"]),
        "full_name": str(item["full_name"]),
        "description": item.get("description"),
        "language": item.get("language"),
        "stars_total": int(item["stargazers_count"]),
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
    if not entries:
        raise DataIntegrityError("GitHub 搜索未返回任何可发布的全站高星仓库")
    return entries


def build_alltime_outputs(
    client: SearchClient,
    *,
    generated_at: dt.datetime,
    minimum_stars: int,
    top_limit: int,
    max_pages: int,
) -> tuple[dict[str, Any], dict[str, Any]]:
    items = client.search_repositories(
        f"stars:>={minimum_stars}", sort="stars", pages=max_pages
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
            "search_result_count": len(items),
            "api_request_count": int(getattr(client, "request_count", 0)),
            "api_retry_count": int(getattr(client, "retry_count", 0)),
        },
        "entry_count": len(entries),
        "entries": entries,
    }
    index = {
        "schema_version": SCHEMA_VERSION,
        "status": "ready",
        "updated_at": isoformat(generated_at),
        "methodology_version": METHODOLOGY_VERSION,
        "entry_count": len(entries),
        "top_stars": entries[0]["stars_total"],
        "freshness_threshold_hours": FRESHNESS_THRESHOLD_HOURS,
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
