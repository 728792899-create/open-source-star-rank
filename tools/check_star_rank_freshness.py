#!/usr/bin/env python3
"""Fail when the published star-rank index is missing or stale."""

from __future__ import annotations

import argparse
import datetime as dt
import json
from pathlib import Path
from zoneinfo import ZoneInfo


TIMEZONE = ZoneInfo("Asia/Shanghai")


def parse_time(value: str) -> dt.datetime:
    parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise ValueError("updated_at 必须包含时区")
    return parsed


def check_freshness(
    index: dict,
    *,
    now: dt.datetime,
    require_today: bool = False,
    require_valid_capture: bool = False,
    require_yesterday_date: bool = False,
    require_complete_event_coverage: bool = False,
) -> dict:
    updated_text = index.get("updated_at")
    if not isinstance(updated_text, str):
        raise ValueError("公开索引尚无 updated_at")
    updated_at = parse_time(updated_text)
    threshold = int(index.get("freshness_threshold_hours", 36))
    age = now.astimezone(dt.timezone.utc) - updated_at.astimezone(dt.timezone.utc)
    if age < -dt.timedelta(minutes=5):
        raise ValueError("公开索引的更新时间晚于当前时间")
    if age > dt.timedelta(hours=threshold):
        raise ValueError(f"公开数据已超过 {threshold} 小时未更新")
    if require_today and updated_at.astimezone(TIMEZONE).date() != now.astimezone(TIMEZONE).date():
        raise ValueError("北京时间今日快照尚未发布")
    if require_valid_capture:
        sampling = index.get("sampling")
        if isinstance(sampling, dict):
            valid = sampling.get("latest_snapshot_valid") is True
        else:
            local = updated_at.astimezone(TIMEZONE)
            valid = local.hour < 3
        if not valid:
            raise ValueError("最近快照不在北京时间 00:00–03:00 有效窗口内")
    if require_yesterday_date:
        expected = (now.astimezone(TIMEZONE).date() - dt.timedelta(days=1)).isoformat()
        if index.get("latest_date") != expected:
            raise ValueError(f"北京时间昨日事件榜尚未发布，期望 {expected}")
    if require_complete_event_coverage:
        if index.get("schema_version") != "1.1.0":
            raise ValueError("全站公开事件索引尚未升级至 1.1.0")
        metrics = index.get("latest_source_metrics")
        if not isinstance(metrics, dict):
            raise ValueError("全站公开事件索引缺少来源指标")
        if (
            metrics.get("scope") != "github_public_events_as_archived_by_gh_archive"
            or metrics.get("counting_unit") != "unique_actor_repository_pair"
            or metrics.get("expected_hour_count") != 24
            or metrics.get("observed_hour_count") != 24
            or metrics.get("missing_hours") != []
        ):
            raise ValueError("全站公开事件小时覆盖或统计口径不完整")
        if metrics.get("ranking_complete") is not True or metrics.get("metadata_success_count") != 100:
            raise ValueError("全站公开事件 Top 100 不完整")
    return {
        "updated_at": updated_text,
        "age_hours": round(max(0.0, age.total_seconds() / 3600), 2),
        "status": index.get("status"),
        "latest_date": index.get("latest_date"),
        "latest_snapshot_valid": (index.get("sampling") or {}).get("latest_snapshot_valid"),
        "observed_hour_count": (index.get("latest_source_metrics") or {}).get("observed_hour_count"),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="检查开源星榜数据新鲜度")
    parser.add_argument("--index", type=Path, required=True)
    parser.add_argument("--now", help="用于测试的 ISO-8601 时间")
    parser.add_argument("--require-today", action="store_true")
    parser.add_argument("--require-valid-capture", action="store_true")
    parser.add_argument("--require-yesterday-date", action="store_true")
    parser.add_argument("--require-complete-event-coverage", action="store_true")
    args = parser.parse_args()
    now = parse_time(args.now) if args.now else dt.datetime.now(dt.timezone.utc)
    try:
        index = json.loads(args.index.read_text(encoding="utf-8"))
        result = check_freshness(
            index,
            now=now,
            require_today=args.require_today,
            require_valid_capture=args.require_valid_capture,
            require_yesterday_date=args.require_yesterday_date,
            require_complete_event_coverage=args.require_complete_event_coverage,
        )
    except (OSError, json.JSONDecodeError, TypeError, ValueError) as exc:
        parser.error(str(exc))
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
