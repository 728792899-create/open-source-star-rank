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
except ModuleNotFoundError:  # pragma: no cover - direct script execution fallback
    from star_rank_schema import SchemaValidationError, sync_public_schemas, validate_payload


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

    published_schemas = public_dir / "schema"
    for filename in (
        "state.schema.json",
        "snapshot.schema.json",
        "index.schema.json",
        "daily.schema.json",
        "language.schema.json",
        "language-index.schema.json",
        "period.schema.json",
        "repositories.schema.json",
    ):
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
