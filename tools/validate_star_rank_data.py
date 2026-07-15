#!/usr/bin/env python3
"""Validate a star-rank data tree before committing or building it."""

from __future__ import annotations

import argparse
import datetime as dt
import json
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

try:
    from tools.star_rank_schema import SchemaValidationError, sync_public_schemas, validate_payload
    from tools.localize_repositories import discover_ranked_repositories, repository_source_hash
except ModuleNotFoundError:  # pragma: no cover - direct script execution fallback
    from star_rank_schema import SchemaValidationError, sync_public_schemas, validate_payload
    from localize_repositories import discover_ranked_repositories, repository_source_hash


def read_json(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise SchemaValidationError(f"无法读取 JSON：{path}: {exc}") from exc


def timestamp(value: str) -> dt.datetime:
    return dt.datetime.fromisoformat(value.replace("Z", "+00:00"))


def validate_ranking_time(payload: dict[str, Any], path: Path) -> None:
    start = timestamp(payload["window_start"])
    end = timestamp(payload["window_end"])
    minutes = int((end - start).total_seconds() // 60)
    quality = payload.get("window_quality")
    if quality is not None and quality["duration_minutes"] != minutes:
        raise SchemaValidationError(f"窗口时长与 window_quality 不一致：{path}")
    if "period_days" in payload and not 1_260 * 60 * payload["period_days"] <= (end - start).total_seconds() <= 1_620 * 60 * payload["period_days"]:
        raise SchemaValidationError(f"周期榜窗口时长超出有效范围：{path}")
    if "period_days" not in payload and not 1_260 * 60 <= (end - start).total_seconds() <= 1_620 * 60:
        raise SchemaValidationError(f"日榜窗口时长超出有效范围：{path}")
    # Version 1.1 used a legacy date label that predates the strict Beijing
    # sampling-window contract. Keep those public files readable without
    # reinterpreting or rewriting their historical labels.
    if payload.get("schema_version") == "1.2.0":
        if "period_days" in payload:
            expected_date = (end.astimezone(ZoneInfo("Asia/Shanghai")).date() - dt.timedelta(days=1)).isoformat()
        else:
            expected_date = start.astimezone(ZoneInfo("Asia/Shanghai")).date().isoformat()
        if payload["date"] != expected_date:
            raise SchemaValidationError(f"榜单日期与统计窗口不一致：{path}")


def validate_data_tree(data_dir: Path, *, sync_schemas: bool = False) -> dict[str, int]:
    root = data_dir.resolve()
    public_dir = root / "public" if (root / "public").is_dir() else root
    schema_dir = Path(__file__).resolve().parents[1] / "schemas" / "star-rank"
    if sync_schemas:
        sync_public_schemas(public_dir, schema_dir)

    counts = {
        "state": 0,
        "snapshot": 0,
        "index": 0,
        "daily": 0,
        "language": 0,
        "period": 0,
        "repositories": 0,
        "event_index": 0,
        "event_daily": 0,
        "localization": 0,
    }
    state_path = root / "state" / "candidates.json"
    if state_path.exists():
        state = read_json(state_path)
        validate_payload("state", state, schema_dir)
        if state["candidate_count"] != len(state["candidates"]):
            raise SchemaValidationError("候选状态 candidate_count 与数组长度不一致")
        if len({item["repository_id"] for item in state["candidates"]}) != len(state["candidates"]):
            raise SchemaValidationError("候选状态包含重复 repository_id")
        counts["state"] += 1

    snapshot_dir = root / "snapshots"
    latest_snapshot: dict[str, Any] | None = None
    if snapshot_dir.exists():
        for path in sorted(snapshot_dir.glob("????-??-??.json")):
            payload = read_json(path)
            validate_payload("snapshot", payload, schema_dir)
            if payload["snapshot_date"] != path.stem:
                raise SchemaValidationError(f"快照日期与文件名不一致：{path}")
            if payload["candidate_count"] != len(payload["repositories"]):
                raise SchemaValidationError(f"快照 candidate_count 与仓库数不一致：{path}")
            collection = payload["collection"]
            if collection["snapshot_expected_count"] != payload["candidate_count"] or collection["snapshot_complete_count"] != payload["candidate_count"] or collection["snapshot_completeness"] != 1:
                raise SchemaValidationError(f"快照完整率不是 100%：{path}")
            if payload.get("schema_version") == "1.2.0":
                local = timestamp(payload["captured_at"]).astimezone(ZoneInfo("Asia/Shanghai"))
                expected_valid = local.hour < 3
                quality = payload["capture_quality"]
                if quality["valid_for_ranking"] != expected_valid or timestamp(quality["local_captured_at"]) != local:
                    raise SchemaValidationError(f"快照 capture_quality 与实际时间不一致：{path}")
            latest_snapshot = payload
            counts["snapshot"] += 1

    index_path = public_dir / "index.json"
    if not index_path.exists():
        raise SchemaValidationError(f"缺少公开索引：{index_path}")
    index = read_json(index_path)
    validate_payload("index", index, schema_dir)
    counts["index"] = 1

    indexed_dates = set(index["available_dates"])
    daily_dir = public_dir / "daily"
    actual_dates = set()
    daily_payloads: list[tuple[Path, dict[str, Any]]] = []
    if daily_dir.exists():
        for path in sorted(daily_dir.glob("????-??-??.json")):
            payload = read_json(path)
            validate_payload("daily", payload, schema_dir)
            validate_ranking_time(payload, path)
            if payload["date"] != path.stem:
                raise SchemaValidationError(f"日榜日期与文件名不一致：{path}")
            actual_dates.add(path.stem)
            daily_payloads.append((path, payload))
            counts["daily"] += 1
    if indexed_dates != actual_dates:
        missing = sorted(indexed_dates - actual_dates)
        extra = sorted(actual_dates - indexed_dates)
        raise SchemaValidationError(f"索引日期与日榜文件不一致；缺失={missing}，多余={extra}")
    if index["latest_date"] != (max(actual_dates) if actual_dates else None):
        raise SchemaValidationError("latest_date 与公开日榜不一致")
    if (index["status"] == "ready") != bool(actual_dates):
        raise SchemaValidationError("status 与公开日榜状态不一致")
    if latest_snapshot is not None and index["updated_at"] != latest_snapshot["captured_at"]:
        raise SchemaValidationError("index.updated_at 与最近快照不一致")
    if latest_snapshot is not None and index["latest_collection"] != latest_snapshot["collection"]:
        raise SchemaValidationError("index.latest_collection 与最近快照不一致")

    if index.get("schema_version") == "1.2.0":
        sampling = index["sampling"]
        for key, required in (("7d", 7), ("30d", 30)):
            progress = sampling["period_progress"][key]
            if progress["required"] != required or progress["completed"] > required:
                raise SchemaValidationError(f"{key} 积累进度不一致")
        if latest_snapshot is not None:
            local = timestamp(latest_snapshot["captured_at"]).astimezone(ZoneInfo("Asia/Shanghai"))
            expected_valid = local.hour < 3
            if sampling["latest_snapshot_at"] != latest_snapshot["captured_at"] or sampling["latest_snapshot_valid"] != expected_valid:
                raise SchemaValidationError("sampling 与最近快照不一致")
        repositories_path = public_dir / "repositories.json"
        language_index_path = public_dir / "language" / "index.json"
        if not repositories_path.is_file() or not language_index_path.is_file():
            raise SchemaValidationError("1.2.0 公开数据缺少项目目录或语言索引")
        repositories = read_json(repositories_path)
        validate_payload("repositories", repositories, schema_dir)
        if repositories["candidate_count"] != len(repositories["repositories"]):
            raise SchemaValidationError("项目目录 candidate_count 与数组长度不一致")
        if repositories["candidate_count"] != index["candidate_count"]:
            raise SchemaValidationError("项目目录与公开索引的候选数不一致")
        repository_ids = {item["repository_id"] for item in repositories["repositories"]}
        if len(repository_ids) != len(repositories["repositories"]):
            raise SchemaValidationError("项目目录包含重复 repository_id")
        for path, payload in daily_payloads:
            if any(item["repository_id"] not in repository_ids for item in payload["entries"]):
                raise SchemaValidationError(f"日榜包含项目目录外的仓库：{path}")
        for repository in repositories["repositories"]:
            history_dates = [item["date"] for item in repository["history_30d"]]
            if history_dates != sorted(set(history_dates)):
                raise SchemaValidationError(f"项目历史日期必须唯一且升序：{repository['repository_id']}")
        counts["repositories"] = 1
        language_index = read_json(language_index_path)
        validate_payload("language_index", language_index, schema_dir)
        language_slugs = [item["slug"] for item in language_index["languages"]]
        if len(set(language_slugs)) != len(language_slugs):
            raise SchemaValidationError("语言索引包含重复 slug")
        indexed_language_dates = {
            item["slug"]: set(item["available_dates"]) for item in language_index["languages"]
        }
        actual_language_dates: dict[str, set[str]] = {}
        language_root = public_dir / "language"
        for path in sorted(language_root.glob("*/daily/????-??-??.json")):
            payload = read_json(path)
            validate_payload("language", payload, schema_dir)
            validate_ranking_time(payload, path)
            if payload["slug"] != path.parents[1].name or payload["date"] != path.stem:
                raise SchemaValidationError(f"语言榜路径与内容不一致：{path}")
            if any(item["repository_id"] not in repository_ids for item in payload["entries"]):
                raise SchemaValidationError(f"语言榜包含项目目录外的仓库：{path}")
            actual_language_dates.setdefault(payload["slug"], set()).add(payload["date"])
            counts["language"] += 1
        for slug, dates in actual_language_dates.items():
            if indexed_language_dates.get(slug, set()) != dates:
                raise SchemaValidationError(f"语言索引日期不一致：{slug}")
        for item in language_index["languages"]:
            dates = set(item["available_dates"])
            if item["latest_date"] != (max(dates) if dates else None):
                raise SchemaValidationError(f"语言索引 latest_date 不一致：{item['slug']}")
            if (item["status"] == "ready") != bool(dates):
                raise SchemaValidationError(f"语言索引 status 不一致：{item['slug']}")

        for days in (7, 30):
            actual_period_dates: set[str] = set()
            for path in sorted((public_dir / "period" / f"{days}d").glob("????-??-??.json")):
                payload = read_json(path)
                validate_payload("period", payload, schema_dir)
                validate_ranking_time(payload, path)
                if payload["period_days"] != days or payload["date"] != path.stem:
                    raise SchemaValidationError(f"周期榜路径与内容不一致：{path}")
                if any(item["repository_id"] not in repository_ids for item in payload["entries"]):
                    raise SchemaValidationError(f"周期榜包含项目目录外的仓库：{path}")
                actual_period_dates.add(path.stem)
                counts["period"] += 1
            if set(index["periods"][f"{days}d"]["available_dates"]) != actual_period_dates:
                raise SchemaValidationError(f"{days} 日榜索引日期不一致")
            if index["periods"][f"{days}d"]["latest_date"] != (max(actual_period_dates) if actual_period_dates else None):
                raise SchemaValidationError(f"{days} 日榜 latest_date 不一致")

    event_index_path = public_dir / "events" / "index.json"
    if event_index_path.exists():
        event_index = read_json(event_index_path)
        validate_payload("event_index", event_index, schema_dir)
        counts["event_index"] = 1
        event_dates: set[str] = set()
        event_payloads: dict[str, dict[str, Any]] = {}
        for path in sorted((public_dir / "events" / "daily").glob("????-??-??.json")):
            payload = read_json(path)
            validate_payload("event_daily", payload, schema_dir)
            if payload["date"] != path.stem:
                raise SchemaValidationError(f"事件榜日期与文件名不一致：{path}")
            start = timestamp(payload["window_start"])
            end = timestamp(payload["window_end"])
            generated_at = timestamp(payload["generated_at"])
            if end - start != dt.timedelta(days=1):
                raise SchemaValidationError(f"事件榜统计窗口必须严格为 24 小时：{path}")
            if start.astimezone(ZoneInfo("Asia/Shanghai")).date().isoformat() != payload["date"]:
                raise SchemaValidationError(f"事件榜日期与北京时间窗口不一致：{path}")
            if generated_at < end:
                raise SchemaValidationError(f"事件榜不得在统计窗口结束前生成：{path}")
            source = payload["source_metrics"]
            expected_tables = sorted(
                {
                    start.astimezone(dt.timezone.utc).strftime("%Y%m%d"),
                    (end.astimezone(dt.timezone.utc) - dt.timedelta(microseconds=1)).strftime("%Y%m%d"),
                }
            )
            if source["table_dates"] != expected_tables:
                raise SchemaValidationError(f"事件榜 GH Archive 日表与统计窗口不一致：{path}")
            if source["estimated_bytes"] > source["maximum_bytes_billed"] or source["bytes_processed"] > source["maximum_bytes_billed"]:
                raise SchemaValidationError(f"事件榜 BigQuery 扫描量超过费用上限：{path}")
            if source["metadata_success_count"] != payload["eligible_count"]:
                raise SchemaValidationError(f"事件榜元数据成功数与可用数不一致：{path}")
            if source["observed_repository_count"] < source["metadata_attempted_count"]:
                raise SchemaValidationError(f"事件榜观察仓库数小于元数据尝试数：{path}")
            if source["metadata_attempted_count"] != source["metadata_success_count"] + source["metadata_not_found_count"] + source["metadata_filtered_count"]:
                raise SchemaValidationError(f"事件榜元数据采集计数不守恒：{path}")
            entries = payload["entries"]
            if len(entries) != 100:
                raise SchemaValidationError(f"事件榜必须完整发布 Top 100：{path}")
            if len({item["repository_id"] for item in entries}) != len(entries):
                raise SchemaValidationError(f"事件榜包含重复仓库 ID：{path}")
            if any(item["watch_events"] < item["stars_added"] for item in entries):
                raise SchemaValidationError(f"事件榜 WatchEvent 数不得小于唯一用户数：{path}")
            expected = sorted(
                entries,
                key=lambda item: (
                    -item["stars_added"], -item["watch_events"], -item["stars_total"], item["full_name"].casefold()
                ),
            )
            if entries != expected or [item["rank"] for item in entries] != list(range(1, len(entries) + 1)):
                raise SchemaValidationError(f"事件榜排序或名次不一致：{path}")
            event_dates.add(path.stem)
            event_payloads[path.stem] = payload
            counts["event_daily"] += 1
        if set(event_index["available_dates"]) != event_dates:
            raise SchemaValidationError("事件榜索引日期与日榜文件不一致")
        if event_index["available_dates"] != sorted(event_dates, reverse=True):
            raise SchemaValidationError("事件榜索引日期必须按倒序排列")
        latest_event_date = max(event_dates) if event_dates else None
        if event_index["latest_date"] != latest_event_date:
            raise SchemaValidationError("事件榜 latest_date 与公开日榜不一致")
        if (event_index["status"] == "ready") != bool(event_dates):
            raise SchemaValidationError("事件榜 status 与公开日榜不一致")
        if latest_event_date:
            latest_event = event_payloads[latest_event_date]
            if event_index["updated_at"] != latest_event["generated_at"] or event_index["latest_source_metrics"] != latest_event["source_metrics"]:
                raise SchemaValidationError("事件榜索引与最新日榜不一致")

    localization_path = public_dir / "i18n" / "zh-CN" / "repositories.json"
    if localization_path.exists():
        localization = read_json(localization_path)
        validate_payload("localization", localization, schema_dir)
        ranked_repositories = discover_ranked_repositories(public_dir)
        entries = localization["repositories"]
        repository_ids = [item["repository_id"] for item in entries]
        if repository_ids != sorted(set(repository_ids)):
            raise SchemaValidationError("中文本地化目录 repository_id 必须唯一且升序")
        if any(repository_id not in ranked_repositories for repository_id in repository_ids):
            raise SchemaValidationError("中文本地化目录包含未进入任何公开榜单的仓库")
        for item in entries:
            source = ranked_repositories[item["repository_id"]]
            if item["source_full_name"] != source["full_name"] or item["source_hash"] != repository_source_hash(source):
                raise SchemaValidationError(f"中文本地化源信息已失效：{item['repository_id']}")
        coverage = localization["coverage"]
        eligible_count = len(ranked_repositories)
        localized_count = len(entries)
        expected_ratio = round(localized_count / eligible_count, 6) if eligible_count else 1
        if coverage["eligible_count"] != eligible_count or coverage["localized_count"] != localized_count:
            raise SchemaValidationError("中文本地化覆盖数量与公开榜单不一致")
        if coverage["pending_count"] != eligible_count - localized_count or coverage["coverage_ratio"] != expected_ratio:
            raise SchemaValidationError("中文本地化待处理数量或覆盖率不一致")
        if coverage["failed_count"] > coverage["pending_count"]:
            raise SchemaValidationError("中文本地化失败数不得超过待处理数")
        counts["localization"] = 1

    published_schemas = public_dir / "schema"
    required_schema_files = [
        "state.schema.json",
        "snapshot.schema.json",
        "index.schema.json",
        "daily.schema.json",
        "language.schema.json",
        "language-index.schema.json",
        "period.schema.json",
        "repositories.schema.json",
        "event-index.schema.json",
        "event-daily.schema.json",
    ]
    if localization_path.exists():
        required_schema_files.append("localization.schema.json")
    for filename in required_schema_files:
        if not (published_schemas / filename).is_file():
            raise SchemaValidationError(f"公开数据缺少 Schema：{published_schemas / filename}")
    return counts


def main() -> int:
    parser = argparse.ArgumentParser(description="验证开源星榜数据目录")
    parser.add_argument("--data-dir", type=Path, required=True)
    parser.add_argument("--sync-schemas", action="store_true")
    args = parser.parse_args()
    try:
        counts = validate_data_tree(args.data_dir, sync_schemas=args.sync_schemas)
    except SchemaValidationError as exc:
        parser.error(str(exc))
    print(json.dumps(counts, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
