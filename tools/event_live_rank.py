#!/usr/bin/env python3
"""Build today's provisional WatchEvent ranking from GH Archive hourly files."""

from __future__ import annotations

import argparse
import datetime as dt
import gzip
import io
import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Iterable, Mapping, Optional, Protocol, Sequence
from zoneinfo import ZoneInfo

try:
    from tools.event_star_rank import (
        COUNTING_UNIT,
        DEFAULT_API_REQUEST_BUDGET,
        DEFAULT_METADATA_ATTEMPT_LIMIT,
        DEFAULT_TOP_LIMIT,
        EVENT_SCOPE,
        TIMEZONE,
        _metadata_record,
        load_event_state_history,
    )
    from tools.star_rank import (
        DataIntegrityError,
        GitHubClient,
        StarRankError,
        atomic_write_json,
        isoformat,
        load_json,
        parse_timestamp,
        utc_now,
    )
    from tools.star_rank_schema import SchemaValidationError, sync_public_schemas, validate_payload
except ModuleNotFoundError:  # pragma: no cover - direct script execution fallback
    from event_star_rank import (  # type: ignore
        COUNTING_UNIT,
        DEFAULT_API_REQUEST_BUDGET,
        DEFAULT_METADATA_ATTEMPT_LIMIT,
        DEFAULT_TOP_LIMIT,
        EVENT_SCOPE,
        TIMEZONE,
        _metadata_record,
        load_event_state_history,
    )
    from star_rank import (  # type: ignore
        DataIntegrityError,
        GitHubClient,
        StarRankError,
        atomic_write_json,
        isoformat,
        load_json,
        parse_timestamp,
        utc_now,
    )
    from star_rank_schema import SchemaValidationError, sync_public_schemas, validate_payload  # type: ignore


SCHEMA_VERSION = "1.0.0"
METHODOLOGY_VERSION = "gharchive-hourly-public-watch-events-live-v1"
HOURLY_STATE_VERSION = "1.0.0"
LIVE_LAG_MINUTES = 30
REFRESH_INTERVAL_MINUTES = 60
SOURCE_ROOT = "https://data.gharchive.org"


class HourSource(Protocol):
    def fetch(self, hour_start: dt.datetime) -> Iterable[Mapping[str, Any]]: ...


def source_url(hour_start: dt.datetime) -> str:
    utc = hour_start.astimezone(dt.timezone.utc)
    return f"{SOURCE_ROOT}/{utc:%Y-%m-%d}-{utc.hour}.json.gz"


class GhArchiveHourSource:
    def __init__(self, *, timeout: int = 90, retries: int = 3) -> None:
        self.timeout = timeout
        self.retries = retries

    def fetch(self, hour_start: dt.datetime) -> Iterable[Mapping[str, Any]]:
        url = source_url(hour_start)
        last_error: Exception | None = None
        for attempt in range(1, self.retries + 1):
            try:
                request = urllib.request.Request(url, headers={"User-Agent": "open-source-star-rank/1.0"})
                with urllib.request.urlopen(request, timeout=self.timeout) as response:
                    with gzip.GzipFile(fileobj=response) as compressed:
                        for line in io.TextIOWrapper(compressed, encoding="utf-8"):
                            if line.strip():
                                yield json.loads(line)
                return
            except (OSError, urllib.error.URLError, json.JSONDecodeError) as exc:
                last_error = exc
                if attempt == self.retries:
                    break
        raise StarRankError(f"无法读取 GH Archive 小时文件 {url}: {last_error}")


def live_window(now: dt.datetime) -> tuple[dt.date, dt.datetime, dt.datetime]:
    now = now.astimezone(dt.timezone.utc)
    local_now = now.astimezone(ZoneInfo(TIMEZONE))
    date = local_now.date()
    start_local = dt.datetime.combine(date, dt.time.min, tzinfo=ZoneInfo(TIMEZONE))
    start = start_local.astimezone(dt.timezone.utc)
    ready_at = now - dt.timedelta(minutes=LIVE_LAG_MINUTES)
    cutoff = ready_at.replace(minute=0, second=0, microsecond=0)
    end = start + dt.timedelta(days=1)
    cutoff = min(cutoff, end)
    if cutoff <= start:
        raise DataIntegrityError("今日第一个 GH Archive 完整小时尚未就绪")
    return date, start, cutoff


def expected_hours(start: dt.datetime, cutoff: dt.datetime) -> list[dt.datetime]:
    if start.minute or start.second or cutoff.minute or cutoff.second or cutoff <= start:
        raise DataIntegrityError("实时榜小时窗口无效")
    count = int((cutoff - start).total_seconds() // 3600)
    if count < 1 or count > 23:
        raise DataIntegrityError(f"实时榜只能覆盖今日 1–23 个完整小时，当前为 {count}")
    return [start + dt.timedelta(hours=offset) for offset in range(count)]


def build_hour_state(
    hour_start: dt.datetime,
    records: Iterable[Mapping[str, Any]],
    *,
    fetched_at: dt.datetime,
) -> dict[str, Any]:
    hour_start = hour_start.astimezone(dt.timezone.utc)
    hour_end = hour_start + dt.timedelta(hours=1)
    repositories: dict[int, dict[str, Any]] = {}
    watch_count = 0
    for record in records:
        if record.get("type") != "WatchEvent":
            continue
        created_at = parse_timestamp(str(record.get("created_at") or ""))
        if not hour_start <= created_at < hour_end:
            raise DataIntegrityError(f"GH Archive 小时文件包含窗口外 WatchEvent：{created_at.isoformat()}")
        actor = record.get("actor") or {}
        repository = record.get("repo") or {}
        repository_id = int(repository.get("id") or 0)
        actor_id = int(actor.get("id") or 0)
        event_id = str(record.get("id") or "")
        if repository_id < 1 or actor_id < 1 or not event_id:
            raise DataIntegrityError("GH Archive WatchEvent 缺少仓库、用户或事件 ID")
        current = repositories.setdefault(
            repository_id,
            {"repository_id": repository_id, "observed_name": "", "actor_ids": set(), "event_ids": set()},
        )
        current["observed_name"] = str(repository.get("name") or current["observed_name"])
        current["actor_ids"].add(actor_id)
        current["event_ids"].add(event_id)
        watch_count += 1
    if watch_count < 1:
        raise DataIntegrityError(f"GH Archive 小时文件没有 WatchEvent：{source_url(hour_start)}")
    entries = [
        {
            "repository_id": item["repository_id"],
            "observed_name": item["observed_name"],
            "actor_ids": sorted(item["actor_ids"]),
            "event_ids": sorted(item["event_ids"]),
        }
        for item in repositories.values()
    ]
    entries.sort(key=lambda item: item["repository_id"])
    return {
        "schema_version": HOURLY_STATE_VERSION,
        "hour_start": isoformat(hour_start),
        "hour_end": isoformat(hour_end),
        "source_url": source_url(hour_start),
        "fetched_at": isoformat(fetched_at),
        "watch_event_count": watch_count,
        "entries": entries,
    }


def validate_hour_state(payload: Mapping[str, Any], hour_start: dt.datetime) -> None:
    if payload.get("schema_version") != HOURLY_STATE_VERSION:
        raise DataIntegrityError("实时小时状态版本不兼容")
    if parse_timestamp(str(payload.get("hour_start"))) != hour_start:
        raise DataIntegrityError("实时小时状态与文件路径不一致")
    if parse_timestamp(str(payload.get("hour_end"))) - hour_start != dt.timedelta(hours=1):
        raise DataIntegrityError("实时小时状态窗口不是一小时")
    if payload.get("source_url") != source_url(hour_start) or int(payload.get("watch_event_count") or 0) < 1:
        raise DataIntegrityError("实时小时状态来源或计数无效")
    repository_ids = [int(item["repository_id"]) for item in payload.get("entries", [])]
    if repository_ids != sorted(set(repository_ids)):
        raise DataIntegrityError("实时小时状态包含重复或乱序仓库")


def aggregate_hour_states(states: Sequence[Mapping[str, Any]]) -> list[dict[str, Any]]:
    repositories: dict[int, dict[str, Any]] = {}
    for state in states:
        for entry in state.get("entries", []):
            repository_id = int(entry["repository_id"])
            current = repositories.setdefault(
                repository_id,
                {"repository_id": repository_id, "observed_name": "", "actor_ids": set(), "event_ids": set()},
            )
            current["observed_name"] = str(entry.get("observed_name") or current["observed_name"])
            current["actor_ids"].update(int(item) for item in entry.get("actor_ids", []))
            current["event_ids"].update(str(item) for item in entry.get("event_ids", []))
    rows = [
        {
            "repository_id": item["repository_id"],
            "observed_name": item["observed_name"],
            "stars_added": len(item["actor_ids"]),
            "watch_events": len(item["event_ids"]),
        }
        for item in repositories.values()
    ]
    rows.sort(key=lambda item: (-item["stars_added"], -item["watch_events"], item["repository_id"]))
    return rows


def load_metadata_cache(public_dir: Path) -> dict[int, Mapping[str, Any]]:
    cache: dict[int, Mapping[str, Any]] = {}
    live = load_json(public_dir / "events" / "live.json")
    if isinstance(live, dict):
        cache.update({int(item["repository_id"]): item for item in live.get("entries", [])})
    index = load_json(public_dir / "events" / "index.json")
    latest_date = index.get("latest_date") if isinstance(index, dict) else None
    if latest_date:
        for relative in (f"events/category/{latest_date}.json", f"events/daily/{latest_date}.json"):
            payload = load_json(public_dir / relative)
            if isinstance(payload, dict):
                for item in payload.get("entries", []):
                    cache.setdefault(int(item["repository_id"]), item)
    return cache


def enrich_live_aggregates(
    client: GitHubClient,
    rows: Sequence[Mapping[str, Any]],
    *,
    metadata_cache: Mapping[int, Mapping[str, Any]],
    top_limit: int = DEFAULT_TOP_LIMIT,
    metadata_attempt_limit: int = DEFAULT_METADATA_ATTEMPT_LIMIT,
) -> tuple[list[dict[str, Any]], dict[str, int]]:
    enriched: list[dict[str, Any]] = []
    request_start = int(client.request_count)
    retry_start = int(client.retry_count)
    attempted = cached = not_found = filtered = 0
    for aggregate in rows[:metadata_attempt_limit]:
        attempted += 1
        repository_id = int(aggregate["repository_id"])
        cached_item = metadata_cache.get(repository_id)
        if cached_item is not None:
            cached_api_shape = {
                "id": repository_id,
                "full_name": cached_item["full_name"],
                "description": cached_item.get("description"),
                "language": cached_item.get("language"),
                "stargazers_count": cached_item["stars_total"],
                "html_url": cached_item["html_url"],
                "owner": {"avatar_url": cached_item.get("owner_avatar_url")},
            }
            enriched.append(_metadata_record(cached_api_shape, aggregate))
            cached += 1
        else:
            payload = client.get_repository_by_id(repository_id)
            if payload is None:
                not_found += 1
                continue
            if (
                payload.get("private")
                or payload.get("visibility") not in (None, "public")
                or payload.get("fork")
                or payload.get("archived")
                or payload.get("disabled")
            ):
                filtered += 1
                continue
            enriched.append(_metadata_record(payload, aggregate))
        if len(enriched) == top_limit:
            break
    if not enriched:
        raise DataIntegrityError("实时榜没有可发布的有效公开仓库")
    return enriched, {
        "metadata_attempted_count": attempted,
        "metadata_success_count": len(enriched),
        "metadata_cached_count": cached,
        "metadata_not_found_count": not_found,
        "metadata_filtered_count": filtered,
        "api_request_count": int(client.request_count) - request_start,
        "api_retry_count": int(client.retry_count) - retry_start,
    }


def build_live_output(
    *,
    date: dt.date,
    start: dt.datetime,
    cutoff: dt.datetime,
    generated_at: dt.datetime,
    rows: Sequence[Mapping[str, Any]],
    enriched: Sequence[Mapping[str, Any]],
    metadata_metrics: Mapping[str, int],
    states: Sequence[Mapping[str, Any]],
    state_history: Mapping[dt.date, Mapping[str, Any]],
    previous_live: Optional[Mapping[str, Any]],
) -> dict[str, Any]:
    previous_same_day = previous_live if previous_live and previous_live.get("date") == date.isoformat() else None
    previous_ranks = {
        int(item["repository_id"]): int(item["rank"])
        for item in (previous_same_day or {}).get("entries", [])
    }
    by_day = {
        day: {int(item["repository_id"]): int(item["stars_added"]) for item in payload.get("entries", [])}
        for day, payload in state_history.items()
    }
    current_by_repository = {int(item["repository_id"]): int(item["stars_added"]) for item in rows}
    entries: list[dict[str, Any]] = []
    for rank, item in enumerate(enriched, start=1):
        repository_id = int(item["repository_id"])
        prior_rank = previous_ranks.get(repository_id)
        trend = [
            by_day.get(date - dt.timedelta(days=offset), {}).get(repository_id)
            for offset in range(6, 0, -1)
        ] + [current_by_repository.get(repository_id)]
        entries.append({
            **item,
            "rank": rank,
            "rank_change": None if prior_rank is None else prior_rank - rank,
            "trend_7d": trend,
        })
    observed_watch_events = sum(len(item.get("event_ids", [])) for state in states for item in state.get("entries", []))
    unique_additions = sum(int(item["stars_added"]) for item in rows)
    observed_hours = len(states)
    next_refresh = generated_at.astimezone(dt.timezone.utc) + dt.timedelta(minutes=REFRESH_INTERVAL_MINUTES)
    return {
        "schema_version": SCHEMA_VERSION,
        "date": date.isoformat(),
        "timezone": TIMEZONE,
        "window_start": isoformat(start),
        "window_end": isoformat(cutoff),
        "generated_at": isoformat(generated_at),
        "next_refresh_at": isoformat(next_refresh),
        "provisional": True,
        "methodology_version": METHODOLOGY_VERSION,
        "ranking_limit": DEFAULT_TOP_LIMIT,
        "entry_count": len(entries),
        "eligible_count": len(entries),
        "rank_change_basis": "previous_live_refresh" if previous_same_day else "new_live_day",
        "source_metrics": {
            "provider": "gh_archive_hourly_files",
            "scope": EVENT_SCOPE,
            "counting_unit": COUNTING_UNIT,
            "expected_hour_count": 24,
            "observed_hour_count": observed_hours,
            "remaining_hour_count": 24 - observed_hours,
            "missing_completed_hours": [],
            "source_files": [str(item["source_url"]) for item in states],
            "unique_star_addition_count": unique_additions,
            "observed_watch_event_count": observed_watch_events,
            "observed_repository_count": len(rows),
            "ranking_complete": len(entries) == DEFAULT_TOP_LIMIT,
            **dict(metadata_metrics),
        },
        "entries": entries,
    }


def run_live_update(
    source: HourSource,
    github: GitHubClient,
    *,
    data_dir: Path,
    generated_at: dt.datetime,
    validate_only: bool = False,
) -> dict[str, Any]:
    date, start, cutoff = live_window(generated_at)
    hours = expected_hours(start, cutoff)
    public_dir = data_dir / "public"
    live_path = public_dir / "events" / "live.json"
    previous_live = load_json(live_path)
    if (
        isinstance(previous_live, dict)
        and previous_live.get("date") == date.isoformat()
        and parse_timestamp(str(previous_live.get("window_end"))) >= cutoff
        and not validate_only
    ):
        validate_payload("event_live", previous_live)
        return {"status": "reused", "ranking": previous_live, "fetched_hours": 0}

    state_root = data_dir / "state" / "events" / "live-hours" / date.isoformat()
    states: list[dict[str, Any]] = []
    pending: list[tuple[Path, dict[str, Any]]] = []
    for hour in hours:
        path = state_root / f"{hour:%H}.json"
        payload = load_json(path)
        if not isinstance(payload, dict):
            payload = build_hour_state(hour, source.fetch(hour), fetched_at=generated_at)
            pending.append((path, payload))
        validate_hour_state(payload, hour)
        states.append(payload)
    if len(states) != len(hours):
        raise DataIntegrityError("实时榜完整小时覆盖不连续")
    rows = aggregate_hour_states(states)
    if not rows:
        raise DataIntegrityError("实时榜聚合结果为空")
    enriched, metadata_metrics = enrich_live_aggregates(
        github,
        rows,
        metadata_cache=load_metadata_cache(public_dir),
    )
    history = load_event_state_history(data_dir / "state" / "events" / "daily", end_date=date - dt.timedelta(days=1))
    ranking = build_live_output(
        date=date,
        start=start,
        cutoff=cutoff,
        generated_at=generated_at,
        rows=rows,
        enriched=enriched,
        metadata_metrics=metadata_metrics,
        states=states,
        state_history=history,
        previous_live=previous_live if isinstance(previous_live, dict) else None,
    )
    validate_payload("event_live", ranking)
    if validate_only:
        return {"status": "validated", "ranking": ranking, "fetched_hours": len(pending)}
    sync_public_schemas(public_dir)
    for path, payload in pending:
        atomic_write_json(path, payload)
    atomic_write_json(live_path, ranking)
    # Keep enough private hourly state for a delayed retry around date rollover.
    live_hours_root = data_dir / "state" / "events" / "live-hours"
    cutoff_date = date - dt.timedelta(days=2)
    if live_hours_root.exists():
        for directory in live_hours_root.iterdir():
            if directory.is_dir():
                try:
                    directory_date = dt.date.fromisoformat(directory.name)
                except ValueError:
                    continue
                if directory_date < cutoff_date:
                    for item in directory.glob("*.json"):
                        item.unlink()
                    directory.rmdir()
    return {"status": "updated", "ranking": ranking, "fetched_hours": len(pending)}


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="生成今日实时公开 WatchEvent 新增 Star 榜")
    parser.add_argument("--data-dir", type=Path, required=True)
    parser.add_argument("--api-request-budget", type=int, default=DEFAULT_API_REQUEST_BUDGET)
    parser.add_argument("--validate-only", action="store_true")
    parser.add_argument("--now", help="测试用 ISO-8601 时间")
    return parser


def main(argv: Optional[Sequence[str]] = None) -> int:
    args = build_parser().parse_args(argv)
    now = parse_timestamp(args.now) if args.now else utc_now()
    try:
        if args.api_request_budget < 1 or args.api_request_budget > DEFAULT_API_REQUEST_BUDGET:
            raise DataIntegrityError(f"GitHub API 请求预算必须在 1 到 {DEFAULT_API_REQUEST_BUDGET} 之间")
        token = os.environ.get("GITHUB_TOKEN")
        if not token:
            raise DataIntegrityError("实时采集必须通过 GITHUB_TOKEN 提供 GitHub API 令牌")
        result = run_live_update(
            GhArchiveHourSource(),
            GitHubClient(token, max_requests=args.api_request_budget),
            data_dir=args.data_dir.resolve(),
            generated_at=now,
            validate_only=args.validate_only,
        )
    except (StarRankError, SchemaValidationError, ValueError) as exc:
        print(f"错误：{exc}", file=sys.stderr)
        return 1
    ranking = result["ranking"]
    print(json.dumps({
        "status": result["status"],
        "date": ranking["date"],
        "cutoff": ranking["window_end"],
        "observed_hours": ranking["source_metrics"]["observed_hour_count"],
        "published_entries": ranking["entry_count"],
        "fetched_hours": result["fetched_hours"],
    }, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
