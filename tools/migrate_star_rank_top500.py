#!/usr/bin/env python3
"""Audit and safely expand retained historical rankings to Top 500.

The default mode is read-only. ``--apply`` only rewrites a ranking when its
same-day exploration pool contains the source records needed to reproduce it;
missing history is reported and never invented.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
from pathlib import Path
from typing import Any, Mapping, Optional, Sequence

try:
    from tools.star_rank import atomic_write_json, load_json, utc_now
    from tools.star_rank_schema import validate_payload
    from tools.validate_star_rank_data import validate_data_tree
except ModuleNotFoundError:  # pragma: no cover
    from star_rank import atomic_write_json, load_json, utc_now  # type: ignore
    from star_rank_schema import validate_payload  # type: ignore
    from validate_star_rank_data import validate_data_tree  # type: ignore


RANKING_LIMIT = 500
PAGE_SIZE = 100


def _files(root: Path) -> list[Path]:
    return sorted(root.glob("????-??-??.json")) if root.exists() else []


def _record(
    *, kind: str, date: str, current: int, source: int, estimated: int,
    can_recompute: bool, reason: str, path: Path,
) -> dict[str, Any]:
    return {
        "kind": kind,
        "date": date,
        "path": path.as_posix(),
        "current_entry_count": current,
        "source_entry_count": source,
        "estimated_entry_count": estimated,
        "can_recompute": can_recompute,
        "reason": reason,
    }


def build_manifest(data_dir: Path) -> dict[str, Any]:
    public = data_dir / "public"
    records: list[dict[str, Any]] = []
    for kind, output_dir, source_dir in (
        ("daily", public / "daily", public / "explore" / "daily"),
        ("period_7d", public / "period" / "7d", public / "explore" / "period" / "7d"),
        ("period_30d", public / "period" / "30d", public / "explore" / "period" / "30d"),
    ):
        for path in _files(output_dir):
            current = load_json(path, {})
            source = load_json(source_dir / path.name, {})
            current_count = len(current.get("entries", []))
            source_count = len(source.get("entries", []))
            already = current.get("schema_version") == "1.3.0" and current.get("entry_count") == current_count
            can = not already and source_count > current_count and source.get("date") == current.get("date")
            reason = "already_top500_contract" if already else "same_day_source_available" if can else "source_pool_missing_or_not_deeper"
            records.append(_record(
                kind=kind, date=path.stem, current=current_count, source=source_count,
                estimated=min(RANKING_LIMIT, source_count), can_recompute=can,
                reason=reason, path=path.relative_to(data_dir),
            ))

    language_root = public / "language"
    if language_root.exists():
        for slug_dir in sorted(path for path in language_root.iterdir() if path.is_dir()):
            for path in _files(slug_dir / "daily"):
                current = load_json(path, {})
                pool = load_json(public / "explore" / "daily" / path.name, {})
                matching = [item for item in pool.get("entries", []) if item.get("language") == current.get("language")]
                current_count = len(current.get("entries", []))
                already = current.get("schema_version") == "1.3.0" and current.get("entry_count") == current_count
                can = not already and len(matching) >= 5 and len(matching) > current_count
                reason = "already_top500_contract" if already else "same_day_language_source_available" if can else "source_pool_missing_or_not_deeper"
                records.append(_record(
                    kind=f"language:{slug_dir.name}", date=path.stem, current=current_count,
                    source=len(matching), estimated=min(RANKING_LIMIT, len(matching)),
                    can_recompute=can, reason=reason, path=path.relative_to(data_dir),
                ))

    for path in _files(public / "events" / "daily"):
        current = load_json(path, {})
        pool = load_json(public / "events" / "category" / path.name, {})
        state_exists = (data_dir / "state" / "events" / "daily" / path.name).is_file()
        current_count = len(current.get("entries", []))
        source_count = len(pool.get("entries", []))
        already = current.get("schema_version") == "1.2.0" and current_count == RANKING_LIMIT
        if already:
            reason = "already_top500_contract"
        elif source_count < RANKING_LIMIT:
            reason = "extended_metadata_pool_below_500"
        elif not state_exists:
            reason = "complete_private_aggregate_state_missing"
        else:
            # v1/v2 coverage counted all public event hours, so it cannot prove
            # the v3 WatchEvent-only 24-hour quality gate.
            reason = "v3_watchevent_hour_coverage_not_proven"
        records.append(_record(
            kind="event_daily", date=path.stem, current=current_count, source=source_count,
            estimated=RANKING_LIMIT if source_count >= RANKING_LIMIT else current_count,
            can_recompute=False, reason=reason, path=path.relative_to(data_dir),
        ))

    return {
        "schema_version": "1.0.0",
        "mode": "read_only_audit",
        "ranking_limit": RANKING_LIMIT,
        "generated_at": utc_now().isoformat().replace("+00:00", "Z"),
        "summary": {
            "record_count": len(records),
            "recomputable_count": sum(item["can_recompute"] for item in records),
            "blocked_count": sum(not item["can_recompute"] and item["reason"] != "already_top500_contract" for item in records),
        },
        "records": records,
    }


def _rerank(entries: Sequence[Mapping[str, Any]], previous: Optional[Mapping[str, Any]]) -> list[dict[str, Any]]:
    previous_ranks = {
        int(item["repository_id"]): int(item["rank"])
        for item in (previous or {}).get("entries", [])
    }
    result: list[dict[str, Any]] = []
    for rank, source in enumerate(entries[:RANKING_LIMIT], start=1):
        repository_id = int(source["repository_id"])
        prior = previous_ranks.get(repository_id)
        result.append({
            **dict(source),
            "rank": rank,
            "rank_change": None if prior is None else prior - rank,
        })
    return result


def _upgrade_base(
    current: Mapping[str, Any], source_entries: Sequence[Mapping[str, Any]],
    previous: Optional[Mapping[str, Any]], recomputed_at: str,
) -> dict[str, Any]:
    entries = _rerank(source_entries, previous)
    return {
        **dict(current),
        "schema_version": "1.3.0",
        "ranking_limit": RANKING_LIMIT,
        "entry_count": len(entries),
        "eligible_count": max(int(current.get("eligible_count", 0)), len(source_entries)),
        "recomputed_at": recomputed_at,
        "entries": entries,
    }


def apply_manifest(data_dir: Path, manifest: Mapping[str, Any], *, recomputed_at: str) -> int:
    public = data_dir / "public"
    selected = {
        (item["kind"], item["date"])
        for item in manifest.get("records", [])
        if item.get("can_recompute") is True
    }
    written = 0
    previous_by_kind: dict[str, Mapping[str, Any]] = {}

    for date_path in _files(public / "daily"):
        date = date_path.stem
        current = load_json(date_path, {})
        if ("daily", date) in selected:
            source = load_json(public / "explore" / "daily" / date_path.name, {})
            current = _upgrade_base(current, source.get("entries", []), previous_by_kind.get("daily"), recomputed_at)
            validate_payload("daily", current)
            atomic_write_json(date_path, current)
            written += 1
        previous_by_kind["daily"] = current

    for days in (7, 30):
        kind = f"period_{days}d"
        for date_path in _files(public / "period" / f"{days}d"):
            date = date_path.stem
            current = load_json(date_path, {})
            if (kind, date) in selected:
                source = load_json(public / "explore" / "period" / f"{days}d" / date_path.name, {})
                current = _upgrade_base(current, source.get("entries", []), previous_by_kind.get(kind), recomputed_at)
                validate_payload("period", current)
                atomic_write_json(date_path, current)
                written += 1
            previous_by_kind[kind] = current

    language_root = public / "language"
    if language_root.exists():
        for slug_dir in sorted(path for path in language_root.iterdir() if path.is_dir()):
            kind = f"language:{slug_dir.name}"
            previous: Optional[Mapping[str, Any]] = None
            for date_path in _files(slug_dir / "daily"):
                date = date_path.stem
                current = load_json(date_path, {})
                if (kind, date) in selected:
                    source = load_json(public / "explore" / "daily" / date_path.name, {})
                    matching = [item for item in source.get("entries", []) if item.get("language") == current.get("language")]
                    current = _upgrade_base(current, matching, previous, recomputed_at)
                    validate_payload("language", current)
                    atomic_write_json(date_path, current)
                    written += 1
                previous = current

    index_path = public / "index.json"
    index = load_json(index_path)
    if isinstance(index, dict) and index.get("latest_date"):
        latest = load_json(public / "daily" / f"{index['latest_date']}.json")
        if isinstance(latest, dict) and latest.get("schema_version") == "1.3.0":
            index.update({"schema_version": "1.3.0", "ranking_limit": RANKING_LIMIT, "page_size": PAGE_SIZE})
            validate_payload("index", index)
            atomic_write_json(index_path, index)
    validate_data_tree(data_dir)
    return written


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="审计并安全迁移可重算的历史榜单至 Top 500")
    parser.add_argument("--data-dir", type=Path, required=True)
    parser.add_argument("--manifest", type=Path)
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--now", help="迁移时间（ISO-8601）")
    return parser


def main(argv: Optional[Sequence[str]] = None) -> int:
    args = build_parser().parse_args(argv)
    data_dir = args.data_dir.resolve()
    manifest = build_manifest(data_dir)
    if args.manifest:
        atomic_write_json(args.manifest.resolve(), manifest)
    written = 0
    if args.apply:
        recomputed_at = args.now or dt.datetime.now(dt.timezone.utc).isoformat().replace("+00:00", "Z")
        written = apply_manifest(data_dir, manifest, recomputed_at=recomputed_at)
    print(json.dumps({**manifest["summary"], "applied_count": written}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
