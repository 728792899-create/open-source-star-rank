#!/usr/bin/env python3
"""Build the public GitHub WatchEvent ranking from GH Archive BigQuery data."""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import re
import sys
from pathlib import Path
from typing import Any, Dict, Mapping, Optional, Protocol, Sequence
from zoneinfo import ZoneInfo

try:
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


SCHEMA_VERSION = "1.1.0"
TIMEZONE = "Asia/Shanghai"
METHODOLOGY_VERSION = "gharchive-public-watch-events-v2"
DEFAULT_MAXIMUM_BYTES_BILLED = 24 * 1024**3
DEFAULT_TOP_LIMIT = 100
DEFAULT_METADATA_ATTEMPT_LIMIT = 900
EVENT_STATE_RETENTION_DAYS = 30
FRESHNESS_THRESHOLD_HOURS = 36
DATASET = "githubarchive.day"
EVENT_SCOPE = "github_public_events_as_archived_by_gh_archive"
COUNTING_UNIT = "unique_actor_repository_pair"


class QueryRunner(Protocol):
    def estimate_bytes(self, query: str) -> int: ...

    def run(self, query: str, *, maximum_bytes_billed: int) -> tuple[list[dict[str, Any]], int]: ...


class BigQueryRunner:
    """Small adapter kept behind a protocol so unit tests never need cloud credentials."""

    def __init__(self, project: str) -> None:
        try:
            from google.cloud import bigquery
        except ImportError as exc:  # pragma: no cover - dependency installation failure
            raise StarRankError("BigQuery 客户端未安装") from exc
        self.bigquery = bigquery
        self.client = bigquery.Client(project=project)

    def estimate_bytes(self, query: str) -> int:
        config = self.bigquery.QueryJobConfig(dry_run=True, use_query_cache=False)
        job = self.client.query(query, job_config=config)
        return int(job.total_bytes_processed or 0)

    def run(self, query: str, *, maximum_bytes_billed: int) -> tuple[list[dict[str, Any]], int]:
        config = self.bigquery.QueryJobConfig(
            use_legacy_sql=False,
            use_query_cache=True,
            maximum_bytes_billed=maximum_bytes_billed,
        )
        job = self.client.query(query, job_config=config)
        rows = [dict(row.items()) for row in job.result()]
        return rows, int(job.total_bytes_processed or 0)


def event_window(date: dt.date) -> tuple[dt.datetime, dt.datetime]:
    start_local = dt.datetime.combine(date, dt.time.min, tzinfo=ZoneInfo(TIMEZONE))
    end_local = start_local + dt.timedelta(days=1)
    return start_local.astimezone(dt.timezone.utc), end_local.astimezone(dt.timezone.utc)


def source_table_dates(date: dt.date) -> list[str]:
    start, end = event_window(date)
    dates = {start.date(), (end - dt.timedelta(microseconds=1)).date()}
    return [item.strftime("%Y%m%d") for item in sorted(dates)]


def _sql_timestamp(value: dt.datetime) -> str:
    return value.astimezone(dt.timezone.utc).strftime("%Y-%m-%d %H:%M:%S+00")


def build_watch_event_query(date: dt.date) -> str:
    table_dates = source_table_dates(date)
    if any(not re.fullmatch(r"\d{8}", item) for item in table_dates):
        raise DataIntegrityError("GH Archive 表日期格式错误")
    selects = [
        "SELECT id, type, actor.id AS actor_id, repo.id AS repository_id, "
        f"repo.name AS observed_name, created_at FROM `{DATASET}.{item}`"
        for item in table_dates
    ]
    start, end = event_window(date)
    source = "\n  UNION ALL\n  ".join(selects)
    return f"""
WITH source AS (
  {source}
), expected_hours AS (
  SELECT hour
  FROM UNNEST(GENERATE_TIMESTAMP_ARRAY(
    TIMESTAMP('{_sql_timestamp(start)}'),
    TIMESTAMP_SUB(TIMESTAMP('{_sql_timestamp(end)}'), INTERVAL 1 HOUR),
    INTERVAL 1 HOUR
  )) AS hour
), observed_hours AS (
  SELECT TIMESTAMP_TRUNC(created_at, HOUR) AS hour, COUNT(*) AS event_count
  FROM source
  WHERE created_at >= TIMESTAMP('{_sql_timestamp(start)}')
    AND created_at < TIMESTAMP('{_sql_timestamp(end)}')
  GROUP BY hour
), coverage AS (
  SELECT
    COUNTIF(observed.event_count IS NOT NULL) AS observed_hour_count,
    ARRAY_AGG(
      IF(observed.event_count IS NULL, FORMAT_TIMESTAMP('%Y-%m-%dT%H:%M:%SZ', expected.hour), NULL)
      IGNORE NULLS ORDER BY expected.hour
    ) AS missing_hours
  FROM expected_hours AS expected
  LEFT JOIN observed_hours AS observed USING (hour)
), aggregated AS (
  SELECT
    repository_id,
    ARRAY_AGG(observed_name IGNORE NULLS ORDER BY created_at DESC LIMIT 1)[SAFE_OFFSET(0)] AS observed_name,
    COUNT(DISTINCT actor_id) AS stars_added,
    COUNT(DISTINCT id) AS watch_events
  FROM source
  WHERE type = 'WatchEvent'
    AND repository_id IS NOT NULL
    AND actor_id IS NOT NULL
    AND created_at >= TIMESTAMP('{_sql_timestamp(start)}')
    AND created_at < TIMESTAMP('{_sql_timestamp(end)}')
  GROUP BY repository_id
), metrics AS (
  SELECT
    COUNT(*) AS observed_repository_count,
    SUM(watch_events) AS observed_watch_event_count,
    SUM(stars_added) AS unique_star_addition_count
  FROM aggregated
)
SELECT aggregated.*, metrics.*, coverage.observed_hour_count, coverage.missing_hours
FROM aggregated
CROSS JOIN metrics
CROSS JOIN coverage
ORDER BY stars_added DESC, watch_events DESC, repository_id ASC
""".strip()


def _metadata_record(api_item: Mapping[str, Any], aggregate: Mapping[str, Any]) -> dict[str, Any]:
    return {
        "repository_id": int(api_item["id"]),
        "full_name": str(api_item["full_name"]),
        "description": api_item.get("description"),
        "language": api_item.get("language"),
        "stars_total": int(api_item["stargazers_count"]),
        "stars_added": int(aggregate["stars_added"]),
        "watch_events": int(aggregate["watch_events"]),
        "html_url": str(api_item["html_url"]),
        "owner_avatar_url": (api_item.get("owner") or {}).get("avatar_url"),
    }


def enrich_aggregates(
    client: GitHubClient,
    rows: Sequence[Mapping[str, Any]],
    *,
    top_limit: int,
    metadata_attempt_limit: int,
) -> tuple[list[dict[str, Any]], dict[str, int]]:
    enriched: list[dict[str, Any]] = []
    not_found = 0
    filtered = 0
    attempted = 0
    for aggregate in rows[:metadata_attempt_limit]:
        attempted += 1
        payload = client.get_repository_by_id(int(aggregate["repository_id"]))
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
    if len(enriched) < top_limit:
        raise DataIntegrityError(
            f"检查 {attempted} 个全局候选后仅有 {len(enriched)} 个有效仓库，无法完整发布 Top {top_limit}"
        )
    return enriched, {
        "metadata_attempted_count": attempted,
        "metadata_success_count": len(enriched),
        "metadata_not_found_count": not_found,
        "metadata_filtered_count": filtered,
        "api_request_count": int(client.request_count),
        "api_retry_count": int(client.retry_count),
    }


def validate_event_coverage(rows: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
    if not rows:
        raise DataIntegrityError("GH Archive 未返回任何 WatchEvent 仓库")
    first = rows[0]
    observed_hour_count = int(first.get("observed_hour_count") or 0)
    missing_hours = [str(item) for item in (first.get("missing_hours") or [])]
    if observed_hour_count != 24 or missing_hours:
        raise DataIntegrityError(
            f"GH Archive 小时覆盖不完整：{observed_hour_count}/24，缺失={missing_hours}"
        )
    unique_star_addition_count = int(first.get("unique_star_addition_count") or 0)
    observed_watch_event_count = int(first.get("observed_watch_event_count") or 0)
    if unique_star_addition_count < 1 or unique_star_addition_count > observed_watch_event_count:
        raise DataIntegrityError("GH Archive 唯一新增数与 WatchEvent 总数不一致")
    return {
        "observed_hour_count": observed_hour_count,
        "missing_hours": missing_hours,
        "unique_star_addition_count": unique_star_addition_count,
        "observed_watch_event_count": observed_watch_event_count,
        "observed_repository_count": int(first.get("observed_repository_count") or 0),
    }


def load_event_state_history(state_dir: Path, *, end_date: dt.date) -> dict[dt.date, Mapping[str, Any]]:
    result: dict[dt.date, Mapping[str, Any]] = {}
    for offset in range(7):
        date = end_date - dt.timedelta(days=offset)
        payload = load_json(state_dir / f"{date.isoformat()}.json")
        if isinstance(payload, dict):
            result[date] = payload
    return result


def build_event_outputs(
    *,
    date: dt.date,
    generated_at: dt.datetime,
    rows: Sequence[Mapping[str, Any]],
    enriched: Sequence[Mapping[str, Any]],
    metadata_metrics: Mapping[str, int],
    estimated_bytes: int,
    bytes_processed: int,
    maximum_bytes_billed: int,
    state_history: Mapping[dt.date, Mapping[str, Any]],
    previous_ranking: Optional[Mapping[str, Any]],
    top_limit: int,
) -> tuple[dict[str, Any], dict[str, Any]]:
    if len(enriched) != top_limit:
        raise DataIntegrityError(
            f"元数据补全后有 {len(enriched)} 个可用仓库，不等于发布门槛 {top_limit}"
        )
    previous_ranks = {
        int(item["repository_id"]): int(item["rank"])
        for item in (previous_ranking or {}).get("entries", [])
    }
    history = dict(state_history)
    raw_entries = [
        {
            "repository_id": int(item["repository_id"]),
            "observed_name": str(item.get("observed_name") or ""),
            "stars_added": int(item["stars_added"]),
            "watch_events": int(item["watch_events"]),
        }
        for item in rows
    ]
    history[date] = {"date": date.isoformat(), "entries": raw_entries}
    by_day = {
        day: {int(item["repository_id"]): int(item["stars_added"]) for item in payload.get("entries", [])}
        for day, payload in history.items()
    }
    entries: list[dict[str, Any]] = []
    for rank, item in enumerate(enriched, start=1):
        repository_id = int(item["repository_id"])
        prior_rank = previous_ranks.get(repository_id)
        trend = [
            by_day.get(date - dt.timedelta(days=offset), {}).get(repository_id)
            for offset in range(6, -1, -1)
        ]
        entries.append(
            {
                **item,
                "rank": rank,
                "rank_change": None if prior_rank is None else prior_rank - rank,
                "trend_7d": trend,
            }
        )
    coverage = validate_event_coverage(rows)
    source_metrics = {
        "provider": "gh_archive_bigquery",
        "dataset": DATASET,
        "scope": EVENT_SCOPE,
        "counting_unit": COUNTING_UNIT,
        "table_dates": source_table_dates(date),
        "expected_hour_count": 24,
        "observed_hour_count": coverage["observed_hour_count"],
        "missing_hours": coverage["missing_hours"],
        "estimated_bytes": estimated_bytes,
        "bytes_processed": bytes_processed,
        "maximum_bytes_billed": maximum_bytes_billed,
        "unique_star_addition_count": coverage["unique_star_addition_count"],
        "observed_watch_event_count": coverage["observed_watch_event_count"],
        "observed_repository_count": coverage["observed_repository_count"],
        "ranking_complete": True,
        **dict(metadata_metrics),
    }
    start, end = event_window(date)
    daily = {
        "schema_version": SCHEMA_VERSION,
        "date": date.isoformat(),
        "timezone": TIMEZONE,
        "window_start": isoformat(start),
        "window_end": isoformat(end),
        "generated_at": isoformat(generated_at),
        "methodology_version": METHODOLOGY_VERSION,
        "source_metrics": source_metrics,
        "eligible_count": len(enriched),
        "entries": entries,
    }
    raw_state = {
        "schema_version": SCHEMA_VERSION,
        "date": date.isoformat(),
        "generated_at": isoformat(generated_at),
        "methodology_version": METHODOLOGY_VERSION,
        "entries": raw_entries,
    }
    return daily, raw_state


def build_event_index(public_dir: Path, *, include: Optional[Mapping[str, Any]] = None) -> dict[str, Any]:
    rankings: dict[str, Mapping[str, Any]] = {}
    daily_dir = public_dir / "events" / "daily"
    if daily_dir.exists():
        for path in daily_dir.glob("????-??-??.json"):
            payload = load_json(path)
            if isinstance(payload, dict):
                rankings[path.stem] = payload
    if include is not None:
        rankings[str(include["date"])] = include
    dates = sorted(rankings, reverse=True)
    latest = rankings[dates[0]] if dates else None
    schema_version = str(latest.get("schema_version", SCHEMA_VERSION)) if latest else SCHEMA_VERSION
    methodology_version = (
        str(latest.get("methodology_version", METHODOLOGY_VERSION)) if latest else METHODOLOGY_VERSION
    )
    return {
        "schema_version": schema_version,
        "status": "ready" if latest else "initializing",
        "timezone": TIMEZONE,
        "updated_at": latest["generated_at"] if latest else None,
        "latest_date": latest["date"] if latest else None,
        "available_dates": dates,
        "methodology_version": methodology_version,
        "freshness_threshold_hours": FRESHNESS_THRESHOLD_HOURS,
        "latest_source_metrics": latest["source_metrics"] if latest else None,
    }


def prune_event_states(state_dir: Path, *, current_date: dt.date) -> list[Path]:
    cutoff = current_date - dt.timedelta(days=EVENT_STATE_RETENTION_DAYS - 1)
    removed: list[Path] = []
    if not state_dir.exists():
        return removed
    for path in state_dir.glob("????-??-??.json"):
        try:
            date = dt.date.fromisoformat(path.stem)
        except ValueError:
            continue
        if date < cutoff:
            path.unlink()
            removed.append(path)
    return sorted(removed)


def rebuild_dependent_rankings(
    public_dir: Path,
    state_dir: Path,
    *,
    date: dt.date,
    ranking: Mapping[str, Any],
    raw_state: Mapping[str, Any],
) -> dict[dt.date, dict[str, Any]]:
    """Recompute derived rank/trend fields when a recent historical day is backfilled."""

    daily_dir = public_dir / "events" / "daily"
    rankings: dict[dt.date, Mapping[str, Any]] = {}
    if daily_dir.exists():
        for path in daily_dir.glob("????-??-??.json"):
            try:
                ranking_date = dt.date.fromisoformat(path.stem)
            except ValueError:
                continue
            payload = load_json(path)
            if isinstance(payload, dict):
                rankings[ranking_date] = payload
    rankings[date] = ranking

    rebuilt: dict[dt.date, dict[str, Any]] = {}
    for current_date in sorted(item for item in rankings if item >= date):
        current = rankings[current_date]
        previous_date = current_date - dt.timedelta(days=1)
        previous = rebuilt.get(previous_date) or rankings.get(previous_date)
        previous_ranks = {
            int(item["repository_id"]): int(item["rank"])
            for item in (previous or {}).get("entries", [])
        }
        by_day: dict[dt.date, dict[int, int]] = {}
        for offset in range(7):
            history_date = current_date - dt.timedelta(days=offset)
            state = raw_state if history_date == date else load_json(state_dir / f"{history_date.isoformat()}.json")
            if isinstance(state, dict):
                by_day[history_date] = {
                    int(item["repository_id"]): int(item["stars_added"])
                    for item in state.get("entries", [])
                }
        entries: list[dict[str, Any]] = []
        for item in current.get("entries", []):
            repository_id = int(item["repository_id"])
            prior_rank = previous_ranks.get(repository_id)
            entries.append(
                {
                    **item,
                    "rank_change": None if prior_rank is None else prior_rank - int(item["rank"]),
                    "trend_7d": [
                        by_day.get(current_date - dt.timedelta(days=offset), {}).get(repository_id)
                        for offset in range(6, -1, -1)
                    ],
                }
            )
        rebuilt[current_date] = {**current, "entries": entries}
    return rebuilt


def validate_requested_date(date: dt.date, *, now: dt.datetime) -> None:
    yesterday = now.astimezone(ZoneInfo(TIMEZONE)).date() - dt.timedelta(days=1)
    age = (yesterday - date).days
    if age < 0 or age > 6:
        raise DataIntegrityError("事件榜日期必须是昨日或最近 7 天内的单个日期")


def run_event_update(
    runner: QueryRunner,
    github: GitHubClient,
    *,
    data_dir: Path,
    date: dt.date,
    generated_at: dt.datetime,
    maximum_bytes_billed: int = DEFAULT_MAXIMUM_BYTES_BILLED,
    top_limit: int = DEFAULT_TOP_LIMIT,
    metadata_attempt_limit: int = DEFAULT_METADATA_ATTEMPT_LIMIT,
    dry_run: bool = False,
    validate_only: bool = False,
    replace_day: bool = False,
) -> dict[str, Any]:
    validate_requested_date(date, now=generated_at)
    if maximum_bytes_billed < 1 or maximum_bytes_billed > DEFAULT_MAXIMUM_BYTES_BILLED:
        raise DataIntegrityError(f"maximum-bytes-billed 不得超过 {DEFAULT_MAXIMUM_BYTES_BILLED}")
    if top_limit != DEFAULT_TOP_LIMIT:
        raise DataIntegrityError("事件榜必须完整发布 Top 100")
    if metadata_attempt_limit < top_limit or metadata_attempt_limit > DEFAULT_METADATA_ATTEMPT_LIMIT:
        raise DataIntegrityError(
            f"元数据检查上限必须在 {top_limit} 到 {DEFAULT_METADATA_ATTEMPT_LIMIT} 之间"
        )
    if dry_run and validate_only:
        raise DataIntegrityError("dry-run 与 validate-only 不能同时使用")

    public_dir = data_dir / "public"
    public_path = public_dir / "events" / "daily" / f"{date.isoformat()}.json"
    state_dir = data_dir / "state" / "events" / "daily"
    state_path = state_dir / f"{date.isoformat()}.json"
    existing = load_json(public_path)
    if existing is not None and not replace_day and not dry_run and not validate_only:
        index = build_event_index(public_dir)
        validate_payload("event_index", index)
        sync_public_schemas(public_dir)
        atomic_write_json(public_dir / "events" / "index.json", index)
        return {"status": "reused", "ranking": existing, "index": index, "estimated_bytes": 0}

    query = build_watch_event_query(date)
    estimated_bytes = runner.estimate_bytes(query)
    if estimated_bytes > maximum_bytes_billed:
        raise DataIntegrityError(
            f"BigQuery 预计扫描 {estimated_bytes} 字节，超过上限 {maximum_bytes_billed}"
        )
    if dry_run:
        return {"status": "validated", "ranking": None, "index": None, "estimated_bytes": estimated_bytes}

    rows, bytes_processed = runner.run(query, maximum_bytes_billed=maximum_bytes_billed)
    if bytes_processed > maximum_bytes_billed:
        raise DataIntegrityError("BigQuery 实际扫描量超过配置上限")
    coverage = validate_event_coverage(rows)
    if len(rows) < top_limit or coverage["observed_repository_count"] != len(rows):
        raise DataIntegrityError(f"GH Archive 仅返回 {len(rows)} 个仓库，拒绝发布")
    if validate_only:
        return {
            "status": "validated",
            "ranking": None,
            "index": None,
            "estimated_bytes": estimated_bytes,
            "bytes_processed": bytes_processed,
            "coverage": coverage,
        }
    enriched, metadata_metrics = enrich_aggregates(
        github,
        rows,
        top_limit=top_limit,
        metadata_attempt_limit=metadata_attempt_limit,
    )
    history = load_event_state_history(state_dir, end_date=date)
    previous = load_json(public_dir / "events" / "daily" / f"{(date - dt.timedelta(days=1)).isoformat()}.json")
    ranking, raw_state = build_event_outputs(
        date=date,
        generated_at=generated_at,
        rows=rows,
        enriched=enriched,
        metadata_metrics=metadata_metrics,
        estimated_bytes=estimated_bytes,
        bytes_processed=bytes_processed,
        maximum_bytes_billed=maximum_bytes_billed,
        state_history=history,
        previous_ranking=previous,
        top_limit=top_limit,
    )
    rebuilt = rebuild_dependent_rankings(
        public_dir,
        state_dir,
        date=date,
        ranking=ranking,
        raw_state=raw_state,
    )
    index = build_event_index(public_dir, include=rebuilt[date])
    for payload in rebuilt.values():
        validate_payload("event_daily", payload)
    validate_payload("event_index", index)
    sync_public_schemas(public_dir)
    atomic_write_json(state_path, raw_state)
    for ranking_date, payload in rebuilt.items():
        atomic_write_json(public_dir / "events" / "daily" / f"{ranking_date.isoformat()}.json", payload)
    atomic_write_json(public_dir / "events" / "index.json", index)
    removed = prune_event_states(state_dir, current_date=date)
    return {
        "status": "updated",
        "ranking": rebuilt[date],
        "index": index,
        "estimated_bytes": estimated_bytes,
        "removed_state_count": len(removed),
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="生成 GitHub 全站公开事件新增 Star 榜")
    parser.add_argument("--data-dir", type=Path, required=True)
    parser.add_argument("--date", help="北京时间榜单日期（默认昨日）")
    parser.add_argument("--maximum-bytes-billed", type=int, default=DEFAULT_MAXIMUM_BYTES_BILLED)
    parser.add_argument("--top-limit", type=int, default=DEFAULT_TOP_LIMIT)
    parser.add_argument("--metadata-attempt-limit", type=int, default=DEFAULT_METADATA_ATTEMPT_LIMIT)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--validate-only", action="store_true")
    parser.add_argument("--replace-day", action="store_true")
    parser.add_argument("--now", help="测试用 ISO-8601 时间")
    return parser


def main(argv: Optional[Sequence[str]] = None) -> int:
    args = build_parser().parse_args(argv)
    now = parse_timestamp(args.now) if args.now else utc_now()
    yesterday = now.astimezone(ZoneInfo(TIMEZONE)).date() - dt.timedelta(days=1)
    try:
        date = dt.date.fromisoformat(args.date) if args.date else yesterday
        project = os.environ.get("GCP_PROJECT_ID") or os.environ.get("GOOGLE_CLOUD_PROJECT")
        if not project:
            raise DataIntegrityError("必须通过 GCP_PROJECT_ID 提供 BigQuery 作业项目")
        token = os.environ.get("GITHUB_TOKEN")
        if not token and not args.dry_run and not args.validate_only:
            raise DataIntegrityError("正式采集必须通过 GITHUB_TOKEN 提供 GitHub API 令牌")
        result = run_event_update(
            BigQueryRunner(project),
            GitHubClient(token),
            data_dir=args.data_dir.resolve(),
            date=date,
            generated_at=now,
            maximum_bytes_billed=args.maximum_bytes_billed,
            top_limit=args.top_limit,
            metadata_attempt_limit=args.metadata_attempt_limit,
            dry_run=args.dry_run,
            validate_only=args.validate_only,
            replace_day=args.replace_day,
        )
    except (StarRankError, SchemaValidationError, ValueError) as exc:
        print(f"错误：{exc}", file=sys.stderr)
        return 1
    ranking = result.get("ranking")
    print(
        json.dumps(
            {
                "status": result["status"],
                "date": ranking.get("date") if ranking else date.isoformat(),
                "published_entries": len(ranking.get("entries", [])) if ranking else 0,
                "estimated_bytes": result.get("estimated_bytes", 0),
                "bytes_processed": (
                    ranking.get("source_metrics", {}).get("bytes_processed", 0)
                    if ranking
                    else result.get("bytes_processed", 0)
                ),
                "observed_hours": result.get("coverage", {}).get("observed_hour_count"),
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
