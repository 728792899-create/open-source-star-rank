#!/usr/bin/env python3
"""Collect GitHub repository snapshots and build the Open Source Star Rank.

The collector deliberately ranks a documented observation pool. GitHub's
repository search cannot sort by daily star growth, so this script discovers a
bounded candidate set and calculates net growth from consecutive snapshots.
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
import re
import sys
import tempfile
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Dict, Iterable, List, Mapping, MutableMapping, Optional, Sequence, Tuple
from zoneinfo import ZoneInfo

try:
    from tools.star_rank_schema import (
        SchemaValidationError,
        sync_public_schemas,
        validate_payload,
    )
except ModuleNotFoundError:  # pragma: no cover - direct script execution fallback
    from star_rank_schema import SchemaValidationError, sync_public_schemas, validate_payload


API_ROOT = "https://api.github.com"
API_VERSION = "2026-03-10"
SCHEMA_VERSION = "1.2.0"
REPOSITORY_SCHEMA_VERSION = "1.3.0"
RANKING_SCHEMA_VERSION = "1.4.0"
TIMEZONE = "Asia/Shanghai"
DEFAULT_MAX_CANDIDATES = 2_000
TOP_LIMIT = 500
LANGUAGE_TOP_LIMIT = 500
PAGE_SIZE = 100
LANGUAGE_MIN_ELIGIBLE = 5
SEARCH_PAGE_SIZE = 100
SNAPSHOT_RETENTION_DAYS = 90
FRESHNESS_THRESHOLD_HOURS = 36
CAPTURE_TARGET_MINUTE = 20
CAPTURE_WINDOW_END_MINUTE = 3 * 60
MIN_DAILY_WINDOW_MINUTES = 21 * 60
MAX_DAILY_WINDOW_MINUTES = 27 * 60
PERIOD_DAYS = (7, 30)


class StarRankError(RuntimeError):
    """Base error for safe, user-facing collector failures."""


class DataIntegrityError(StarRankError):
    """Raised when an API response or local data file is incomplete."""


class RateLimitError(StarRankError):
    """Raised when GitHub refuses a request because the token is exhausted."""


def utc_now() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc).replace(microsecond=0)


def isoformat(value: dt.datetime) -> str:
    return value.astimezone(dt.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def parse_timestamp(value: str) -> dt.datetime:
    return dt.datetime.fromisoformat(value.replace("Z", "+00:00"))


def local_date(value: dt.datetime) -> dt.date:
    return value.astimezone(ZoneInfo(TIMEZONE)).date()


def local_datetime(value: dt.datetime) -> dt.datetime:
    if value.tzinfo is None:
        raise DataIntegrityError("采样时间必须包含时区")
    return value.astimezone(ZoneInfo(TIMEZONE))


def capture_quality(captured_at: dt.datetime) -> Dict[str, Any]:
    local = local_datetime(captured_at)
    minute_of_day = local.hour * 60 + local.minute
    valid = 0 <= minute_of_day < CAPTURE_WINDOW_END_MINUTE
    return {
        "local_captured_at": local.replace(microsecond=0).isoformat(),
        "scheduled_offset_minutes": minute_of_day - CAPTURE_TARGET_MINUTE,
        "valid_for_ranking": valid,
        "reason": "within_window" if valid else "outside_window",
    }


def snapshot_quality(snapshot: Mapping[str, Any]) -> Dict[str, Any]:
    quality = snapshot.get("capture_quality")
    if isinstance(quality, dict):
        return dict(quality)
    captured_at = snapshot.get("captured_at")
    if not isinstance(captured_at, str):
        raise DataIntegrityError("快照缺少 captured_at")
    return capture_quality(parse_timestamp(captured_at))


def snapshot_is_valid(snapshot: Mapping[str, Any]) -> bool:
    return bool(snapshot_quality(snapshot)["valid_for_ranking"])


def window_quality(
    previous_snapshot: Mapping[str, Any], current_snapshot: Mapping[str, Any]
) -> Dict[str, Any]:
    previous_at = parse_timestamp(str(previous_snapshot["captured_at"]))
    current_at = parse_timestamp(str(current_snapshot["captured_at"]))
    duration_seconds = (current_at - previous_at).total_seconds()
    duration_minutes = int(duration_seconds // 60)
    previous_date = dt.date.fromisoformat(str(previous_snapshot["snapshot_date"]))
    current_date = dt.date.fromisoformat(str(current_snapshot["snapshot_date"]))
    consecutive_dates = current_date - previous_date == dt.timedelta(days=1)
    valid = (
        consecutive_dates
        and snapshot_is_valid(previous_snapshot)
        and snapshot_is_valid(current_snapshot)
        and MIN_DAILY_WINDOW_MINUTES * 60 <= duration_seconds <= MAX_DAILY_WINDOW_MINUTES * 60
    )
    if not consecutive_dates:
        reason = "non_consecutive_dates"
    elif not snapshot_is_valid(previous_snapshot) or not snapshot_is_valid(current_snapshot):
        reason = "invalid_capture"
    elif not MIN_DAILY_WINDOW_MINUTES * 60 <= duration_seconds <= MAX_DAILY_WINDOW_MINUTES * 60:
        reason = "invalid_duration"
    else:
        reason = "valid"
    return {
        "duration_minutes": duration_minutes,
        "valid_for_ranking": valid,
        "reason": reason,
    }


def snapshot_pair_is_valid(
    previous_snapshot: Mapping[str, Any], current_snapshot: Mapping[str, Any]
) -> bool:
    return bool(window_quality(previous_snapshot, current_snapshot)["valid_for_ranking"])


def load_json(path: Path, default: Any = None) -> Any:
    if not path.exists():
        return default
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise DataIntegrityError(f"无法读取 JSON：{path}: {exc}") from exc


def atomic_write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    encoded = json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=False) + "\n"
    temporary_name: Optional[str] = None
    try:
        with tempfile.NamedTemporaryFile(
            "w", encoding="utf-8", dir=path.parent, prefix=f".{path.name}.", delete=False
        ) as handle:
            temporary_name = handle.name
            handle.write(encoded)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary_name, path)
    finally:
        if temporary_name and os.path.exists(temporary_name):
            os.unlink(temporary_name)


def require_repository_shape(item: Mapping[str, Any]) -> None:
    required = ("id", "full_name", "html_url", "stargazers_count")
    missing = [key for key in required if item.get(key) is None]
    if missing:
        raise DataIntegrityError(f"GitHub 仓库响应缺少字段：{', '.join(missing)}")
    if not isinstance(item["id"], int) or not isinstance(item["stargazers_count"], int):
        raise DataIntegrityError("GitHub 仓库响应中的 id 或 stargazers_count 类型错误")


def repository_record(
    item: Mapping[str, Any],
    *,
    observed_date: str,
    source: str,
    existing: Optional[Mapping[str, Any]] = None,
    pinned: bool = False,
) -> Dict[str, Any]:
    require_repository_shape(item)
    sources = set(existing.get("discovery_sources", []) if existing else [])
    sources.add(source)
    return {
        "repository_id": item["id"],
        "full_name": item["full_name"],
        "description": item.get("description"),
        "language": item.get("language"),
        "stars_total": item["stargazers_count"],
        "html_url": item["html_url"],
        "owner_avatar_url": (item.get("owner") or {}).get("avatar_url"),
        "created_at": item.get("created_at"),
        "pushed_at": item.get("pushed_at"),
        "archived": bool(item.get("archived", False)),
        "disabled": bool(item.get("disabled", False)),
        "fork": bool(item.get("fork", False)),
        "first_seen_date": (existing or {}).get("first_seen_date", observed_date),
        "last_seen_date": observed_date,
        "last_refreshed_date": observed_date,
        "discovery_sources": sorted(sources),
        "pinned": bool(pinned or (existing or {}).get("pinned", False)),
    }


class GitHubClient:
    def __init__(
        self,
        token: Optional[str],
        *,
        timeout: int = 20,
        retries: int = 3,
        max_requests: Optional[int] = None,
    ) -> None:
        self.token = token
        self.timeout = timeout
        self.retries = retries
        self.max_requests = max_requests
        self.request_count = 0
        self.retry_count = 0

    def _request_json(self, path: str, *, not_found_ok: bool = False) -> Any:
        url = path if path.startswith("http") else f"{API_ROOT}{path}"
        headers = {
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": API_VERSION,
            "User-Agent": "open-source-star-rank",
        }
        if self.token:
            headers["Authorization"] = f"Bearer {self.token}"
        request = urllib.request.Request(url, headers=headers)

        for attempt in range(self.retries):
            if self.max_requests is not None and self.request_count >= self.max_requests:
                raise RateLimitError(
                    f"GitHub API 请求已达任务安全上限 {self.max_requests}；拒绝超额采集"
                )
            self.request_count += 1
            if attempt:
                self.retry_count += 1
            try:
                with urllib.request.urlopen(request, timeout=self.timeout) as response:
                    return json.loads(response.read().decode("utf-8"))
            except urllib.error.HTTPError as exc:
                if exc.code == 404 and not_found_ok:
                    return None
                remaining = exc.headers.get("X-RateLimit-Remaining")
                if exc.code in (403, 429) and remaining == "0":
                    raise RateLimitError("GitHub API 额度已耗尽；保留上一版数据并稍后重试") from exc
                if exc.code >= 500 and attempt + 1 < self.retries:
                    time.sleep(2**attempt)
                    continue
                try:
                    detail = exc.read().decode("utf-8")[:500]
                except OSError:
                    detail = ""
                raise StarRankError(f"GitHub API 请求失败 ({exc.code})：{detail or url}") from exc
            except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
                if attempt + 1 < self.retries:
                    time.sleep(2**attempt)
                    continue
                raise StarRankError(f"GitHub API 网络或响应错误：{url}: {exc}") from exc
        raise AssertionError("unreachable")

    def search_repository_page(
        self,
        query: str,
        *,
        sort: str,
        page: int,
        per_page: int = SEARCH_PAGE_SIZE,
    ) -> Mapping[str, Any]:
        params = urllib.parse.urlencode(
            {
                "q": query,
                "sort": sort,
                "order": "desc",
                "per_page": per_page,
                "page": page,
            }
        )
        payload = self._request_json(f"/search/repositories?{params}")
        if (
            not isinstance(payload, dict)
            or not isinstance(payload.get("items"), list)
            or not isinstance(payload.get("total_count"), int)
        ):
            raise DataIntegrityError("GitHub 搜索响应结构不完整")
        if payload.get("incomplete_results") is True:
            raise DataIntegrityError("GitHub 搜索标记为 incomplete_results，拒绝生成不完整榜单")
        for item in payload["items"]:
            require_repository_shape(item)
        return payload

    def search_repositories(self, query: str, *, sort: str, pages: int) -> List[Mapping[str, Any]]:
        results: List[Mapping[str, Any]] = []
        for page in range(1, pages + 1):
            payload = self.search_repository_page(query, sort=sort, page=page)
            items = payload["items"]
            results.extend(items)
            if len(items) < SEARCH_PAGE_SIZE:
                break
        return results

    def get_repository_by_id(self, repository_id: int) -> Optional[Mapping[str, Any]]:
        payload = self._request_json(f"/repositories/{repository_id}", not_found_ok=True)
        if payload is not None:
            require_repository_shape(payload)
        return payload

    def get_repository(self, full_name: str) -> Optional[Mapping[str, Any]]:
        owner, separator, name = full_name.partition("/")
        if not separator or not owner or not name:
            raise DataIntegrityError(f"仓库名格式错误：{full_name}")
        payload = self._request_json(
            f"/repos/{urllib.parse.quote(owner)}/{urllib.parse.quote(name)}", not_found_ok=True
        )
        if payload is not None:
            require_repository_shape(payload)
        return payload


def load_seed_repositories(projects_file: Path) -> List[str]:
    projects = load_json(projects_file, [])
    if not isinstance(projects, list):
        raise DataIntegrityError(f"项目索引必须是数组：{projects_file}")
    repositories: List[str] = []
    for project in projects:
        repository = project.get("repository") if isinstance(project, dict) else None
        if isinstance(repository, str) and "/" in repository:
            repositories.append(repository)
    return sorted(set(repositories), key=str.lower)


def snapshot_files(snapshot_dir: Path, *, before: Optional[dt.date] = None, limit: int = 9) -> List[Path]:
    found: List[Tuple[dt.date, Path]] = []
    if snapshot_dir.exists():
        for path in snapshot_dir.glob("????-??-??.json"):
            try:
                date = dt.date.fromisoformat(path.stem)
            except ValueError:
                continue
            if before is None or date < before:
                found.append((date, path))
    found.sort(reverse=True)
    return [path for _, path in found[:limit]]


def recent_growth_by_repository(snapshot_dir: Path, *, before: dt.date) -> Dict[int, int]:
    paths = list(reversed(snapshot_files(snapshot_dir, before=before, limit=8)))
    snapshots = [load_json(path) for path in paths]
    growth: Dict[int, int] = {}
    for previous, current in zip(snapshots, snapshots[1:]):
        if not snapshot_pair_is_valid(previous, current):
            continue
        previous_repos = previous.get("repositories", {})
        current_repos = current.get("repositories", {})
        for repository_id, current_item in current_repos.items():
            previous_item = previous_repos.get(repository_id)
            if previous_item is None:
                continue
            delta = current_item["stars_total"] - previous_item["stars_total"]
            numeric_id = int(repository_id)
            growth[numeric_id] = max(growth.get(numeric_id, 0), delta)
    return growth


def select_candidate_pool(
    candidates: Iterable[Mapping[str, Any]],
    *,
    recent_growth: Mapping[int, int],
    observed_date: str,
    max_candidates: int,
) -> List[Dict[str, Any]]:
    eligible = [
        dict(item)
        for item in candidates
        if not item.get("fork") and not item.get("archived") and not item.get("disabled")
    ]

    def priority(item: Mapping[str, Any]) -> Tuple[Any, ...]:
        growth = recent_growth.get(int(item["repository_id"]), 0)
        if item.get("pinned"):
            group = 0
        elif growth > 0:
            group = 1
        elif item.get("first_seen_date") == observed_date:
            group = 2
        else:
            group = 3
        return (
            group,
            -growth,
            -int(item.get("stars_total", 0)),
            str(item.get("full_name", "")).lower(),
        )

    eligible.sort(key=priority)
    return eligible[:max_candidates]


def discover_candidates(
    client: GitHubClient,
    *,
    observed_date: dt.date,
    existing: Mapping[int, Mapping[str, Any]],
) -> Tuple[Dict[int, Dict[str, Any]], Dict[str, int]]:
    start_recent = observed_date - dt.timedelta(days=30)
    start_active = observed_date - dt.timedelta(days=7)
    queries = (
        (
            f"created:>={start_recent.isoformat()} fork:false archived:false",
            "stars",
            10,
            "recent-created",
        ),
        (
            f"pushed:>={start_active.isoformat()} stars:>=100 fork:false archived:false",
            "updated",
            5,
            "recent-active",
        ),
        (
            f"pushed:>={start_active.isoformat()} stars:>=10000 fork:false archived:false",
            "updated",
            5,
            "established-active",
        ),
    )
    discovered: Dict[int, Dict[str, Any]] = {}
    search_result_counts = {
        "recent_created": 0,
        "recent_active": 0,
        "established_active": 0,
    }
    date_text = observed_date.isoformat()
    for query, sort, pages, source in queries:
        results = client.search_repositories(query, sort=sort, pages=pages)
        search_result_counts[source.replace("-", "_")] = len(results)
        for item in results:
            repository_id = int(item["id"])
            prior = discovered.get(repository_id) or existing.get(repository_id)
            discovered[repository_id] = repository_record(
                item,
                observed_date=date_text,
                source=source,
                existing=prior,
            )
    return discovered, search_result_counts


def merge_and_refresh_candidates(
    client: GitHubClient,
    *,
    previous: Sequence[Mapping[str, Any]],
    discovered: Mapping[int, Mapping[str, Any]],
    pinned_repositories: Sequence[str],
    snapshot_dir: Path,
    observed_date: dt.date,
    max_candidates: int,
) -> List[Dict[str, Any]]:
    date_text = observed_date.isoformat()
    merged: Dict[int, Dict[str, Any]] = {int(item["repository_id"]): dict(item) for item in previous}
    for repository_id, item in discovered.items():
        prior = merged.get(repository_id)
        merged[repository_id] = {**(prior or {}), **dict(item)}

    pinned_names = {name.lower() for name in pinned_repositories}
    for item in merged.values():
        if str(item.get("full_name", "")).lower() in pinned_names:
            item["pinned"] = True

    known_pinned_names = {
        str(item.get("full_name", "")).lower() for item in merged.values() if item.get("pinned")
    }
    for full_name in pinned_repositories:
        if full_name.lower() in known_pinned_names:
            continue
        payload = client.get_repository(full_name)
        if payload is None:
            continue
        item = repository_record(
            payload,
            observed_date=date_text,
            source="knowledge-base-seed",
            pinned=True,
        )
        merged[int(item["repository_id"])] = item

    growth = recent_growth_by_repository(snapshot_dir, before=observed_date)
    selected = select_candidate_pool(
        merged.values(),
        recent_growth=growth,
        observed_date=date_text,
        max_candidates=max_candidates,
    )

    refreshed: List[Dict[str, Any]] = []
    for candidate in selected:
        if candidate.get("last_refreshed_date") == date_text:
            current = candidate
        else:
            payload = client.get_repository_by_id(int(candidate["repository_id"]))
            if payload is None:
                continue
            current = repository_record(
                payload,
                observed_date=date_text,
                source="tracked-refresh",
                existing=candidate,
                pinned=bool(candidate.get("pinned")),
            )
        if current.get("fork") or current.get("archived") or current.get("disabled"):
            continue
        refreshed.append(current)

    refreshed.sort(key=lambda item: str(item["full_name"]).lower())
    if not refreshed:
        raise DataIntegrityError("候选池为空，拒绝写入快照")
    return refreshed


def empty_collection_metrics(candidate_count: int) -> Dict[str, Any]:
    return {
        "search_result_counts": {
            "recent_created": 0,
            "recent_active": 0,
            "established_active": 0,
        },
        "unique_discovered_count": 0,
        "candidate_added_count": 0,
        "candidate_removed_count": 0,
        "api_request_count": 0,
        "api_retry_count": 0,
        "snapshot_expected_count": candidate_count,
        "snapshot_complete_count": candidate_count,
        "snapshot_completeness": 1.0,
    }


def build_snapshot(
    candidates: Sequence[Mapping[str, Any]],
    *,
    captured_at: dt.datetime,
    collection: Optional[Mapping[str, Any]] = None,
) -> Dict[str, Any]:
    repositories = {
        str(item["repository_id"]): {
            "stars_total": int(item["stars_total"]),
            "full_name": item["full_name"],
        }
        for item in candidates
    }
    return {
        "schema_version": SCHEMA_VERSION,
        "snapshot_date": local_date(captured_at).isoformat(),
        "captured_at": isoformat(captured_at),
        "timezone": TIMEZONE,
        "capture_quality": capture_quality(captured_at),
        "candidate_count": len(candidates),
        "collection": dict(collection or empty_collection_metrics(len(candidates))),
        "repositories": repositories,
    }


def daily_delta(
    snapshots_by_date: Mapping[dt.date, Mapping[str, Any]], repository_id: str, end_date: dt.date
) -> Optional[int]:
    current = snapshots_by_date.get(end_date)
    previous = snapshots_by_date.get(end_date - dt.timedelta(days=1))
    if not current or not previous or not snapshot_pair_is_valid(previous, current):
        return None
    current_item = current.get("repositories", {}).get(repository_id)
    previous_item = previous.get("repositories", {}).get(repository_id)
    if current_item is None or previous_item is None:
        return None
    return int(current_item["stars_total"]) - int(previous_item["stars_total"])


def rankable_entries(
    *,
    previous_snapshot: Mapping[str, Any],
    current_snapshot: Mapping[str, Any],
    candidates: Sequence[Mapping[str, Any]],
    snapshot_history: Mapping[dt.date, Mapping[str, Any]],
    knowledge_repositories: Mapping[str, str],
    ranking_date: Optional[dt.date] = None,
    require_daily_pair: bool = True,
) -> List[Dict[str, Any]]:
    previous_date = dt.date.fromisoformat(previous_snapshot["snapshot_date"])
    if require_daily_pair and not snapshot_pair_is_valid(previous_snapshot, current_snapshot):
        raise DataIntegrityError("只允许使用有效的连续零点快照生成榜单")
    trend_date = ranking_date or previous_date

    metadata = {str(item["repository_id"]): item for item in candidates}
    rankable: List[Dict[str, Any]] = []
    previous_repositories = previous_snapshot.get("repositories", {})
    current_repositories = current_snapshot.get("repositories", {})
    for repository_id, current_item in current_repositories.items():
        prior = previous_repositories.get(repository_id)
        candidate = metadata.get(repository_id)
        if prior is None or candidate is None:
            continue
        gained = int(current_item["stars_total"]) - int(prior["stars_total"])
        rankable.append(
            {
                "repository_id": int(repository_id),
                "full_name": candidate["full_name"],
                "description": candidate.get("description"),
                "language": candidate.get("language"),
                "stars_total": int(current_item["stars_total"]),
                "created_at": candidate.get("created_at"),
                "pushed_at": candidate.get("pushed_at"),
                "stars_gained": gained,
                "html_url": candidate["html_url"],
                "owner_avatar_url": candidate.get("owner_avatar_url"),
                "knowledge_url": knowledge_repositories.get(str(candidate["full_name"]).lower()),
            }
        )

    rankable.sort(key=lambda item: (-item["stars_gained"], -item["stars_total"], item["full_name"].lower()))
    for item in rankable:
        trend: List[Optional[int]] = []
        for offset in range(6, -1, -1):
            day = trend_date - dt.timedelta(days=offset)
            trend.append(daily_delta(snapshot_history, str(item["repository_id"]), day + dt.timedelta(days=1)))
        item["trend_7d"] = trend
    return rankable


def ranked_entries(
    rankable: Sequence[Mapping[str, Any]],
    *,
    previous_ranking: Optional[Mapping[str, Any]],
    limit: int,
) -> List[Dict[str, Any]]:
    previous_ranks = {
        int(item["repository_id"]): int(item["rank"])
        for item in (previous_ranking or {}).get("entries", [])
    }
    entries: List[Dict[str, Any]] = []
    for rank, source in enumerate(rankable[:limit], start=1):
        item = dict(source)
        prior_rank = previous_ranks.get(item["repository_id"])
        entries.append(
            {
                **item,
                "rank": rank,
                "rank_change": None if prior_rank is None else prior_rank - rank,
            }
        )
    return entries


def build_exploration_pool(
    *,
    board_kind: str,
    ranking: Mapping[str, Any],
    rankable: Sequence[Mapping[str, Any]],
) -> Dict[str, Any]:
    """Build the permanent, bounded source pool used by in-page re-ranking.

    The public Top 500 remains the authoritative paginated ranking.  This pool keeps
    the same global ordering for every comparable candidate so the browser can
    apply one or more taxonomy filters and derive a transparent filtered Top 500.
    """

    entries = ranked_entries(rankable, previous_ranking=None, limit=len(rankable))
    return {
        "schema_version": "1.1.0",
        "board_kind": board_kind,
        "date": ranking["date"],
        "timezone": ranking["timezone"],
        "window_start": ranking["window_start"],
        "window_end": ranking["window_end"],
        "pool_size": len(entries),
        "entries": entries,
    }


def build_daily_ranking(
    *,
    previous_snapshot: Mapping[str, Any],
    current_snapshot: Mapping[str, Any],
    candidates: Sequence[Mapping[str, Any]],
    snapshot_history: Mapping[dt.date, Mapping[str, Any]],
    previous_ranking: Optional[Mapping[str, Any]],
    knowledge_repositories: Mapping[str, str],
) -> Dict[str, Any]:
    ranking_date = dt.date.fromisoformat(previous_snapshot["snapshot_date"])
    rankable = rankable_entries(
        previous_snapshot=previous_snapshot,
        current_snapshot=current_snapshot,
        candidates=candidates,
        snapshot_history=snapshot_history,
        knowledge_repositories=knowledge_repositories,
    )

    return {
        "schema_version": RANKING_SCHEMA_VERSION,
        "ranking_limit": TOP_LIMIT,
        "entry_count": min(len(rankable), TOP_LIMIT),
        "date": ranking_date.isoformat(),
        "timezone": TIMEZONE,
        "window_start": previous_snapshot["captured_at"],
        "window_end": current_snapshot["captured_at"],
        "window_quality": window_quality(previous_snapshot, current_snapshot),
        "candidate_count": current_snapshot["candidate_count"],
        "eligible_count": len(rankable),
        "collection": current_snapshot["collection"],
        "entries": ranked_entries(rankable, previous_ranking=previous_ranking, limit=TOP_LIMIT),
    }


def language_slug(language: str) -> str:
    special = {"C++": "c-plus-plus", "C#": "c-sharp", "F#": "f-sharp"}
    if language in special:
        return special[language]
    normalized = unicodedata.normalize("NFKD", language).encode("ascii", "ignore").decode("ascii")
    base = re.sub(r"[^a-z0-9]+", "-", normalized.lower()).strip("-") or "language"
    digest = hashlib.sha256(language.encode("utf-8")).hexdigest()[:8]
    return f"{base}-{digest}"


def build_language_rankings(
    *,
    daily_ranking: Mapping[str, Any],
    all_rankable: Sequence[Mapping[str, Any]],
    public_dir: Path,
) -> List[Dict[str, Any]]:
    by_language: Dict[str, List[Mapping[str, Any]]] = {}
    for item in all_rankable:
        language = item.get("language")
        if isinstance(language, str) and language.strip():
            by_language.setdefault(language, []).append(item)
    results: List[Dict[str, Any]] = []
    ranking_date = str(daily_ranking["date"])
    for language in sorted(by_language, key=str.casefold):
        items = by_language[language]
        if len(items) < LANGUAGE_MIN_ELIGIBLE:
            continue
        slug = language_slug(language)
        previous_date = (dt.date.fromisoformat(ranking_date) - dt.timedelta(days=1)).isoformat()
        previous_ranking = load_json(public_dir / "language" / slug / "daily" / f"{previous_date}.json")
        results.append(
            {
                **{key: daily_ranking[key] for key in (
                    "schema_version", "date", "timezone", "window_start", "window_end",
                    "window_quality", "candidate_count", "collection"
                )},
                "language": language,
                "slug": slug,
                "eligible_count": len(items),
                "ranking_limit": LANGUAGE_TOP_LIMIT,
                "entry_count": min(len(items), LANGUAGE_TOP_LIMIT),
                "entries": ranked_entries(
                    items, previous_ranking=previous_ranking, limit=LANGUAGE_TOP_LIMIT
                ),
            }
        )
    return results


def complete_period_window(
    snapshot_history: Mapping[dt.date, Mapping[str, Any]], *, end_date: dt.date, days: int
) -> bool:
    for offset in range(days):
        current = snapshot_history.get(end_date - dt.timedelta(days=offset))
        previous = snapshot_history.get(end_date - dt.timedelta(days=offset + 1))
        if not current or not previous or not snapshot_pair_is_valid(previous, current):
            return False
    return True


def build_period_ranking(
    *,
    days: int,
    end_snapshot: Mapping[str, Any],
    start_snapshot: Mapping[str, Any],
    candidates: Sequence[Mapping[str, Any]],
    snapshot_history: Mapping[dt.date, Mapping[str, Any]],
    previous_ranking: Optional[Mapping[str, Any]],
    knowledge_repositories: Mapping[str, str],
    limit: int = TOP_LIMIT,
) -> Dict[str, Any]:
    end_date = dt.date.fromisoformat(str(end_snapshot["snapshot_date"]))
    if not complete_period_window(snapshot_history, end_date=end_date, days=days):
        raise DataIntegrityError(f"近 {days} 日窗口包含缺失或无效快照")
    rankable = rankable_entries(
        previous_snapshot=start_snapshot,
        current_snapshot=end_snapshot,
        candidates=candidates,
        snapshot_history=snapshot_history,
        knowledge_repositories=knowledge_repositories,
        ranking_date=end_date - dt.timedelta(days=1),
        require_daily_pair=False,
    )
    start_date = end_date - dt.timedelta(days=days)
    continuously_observed: Optional[set[str]] = None
    for offset in range(days + 1):
        observed = set(snapshot_history[start_date + dt.timedelta(days=offset)].get("repositories", {}))
        continuously_observed = observed if continuously_observed is None else continuously_observed & observed
    rankable = [item for item in rankable if str(item["repository_id"]) in (continuously_observed or set())]
    quality = {
        "duration_minutes": int(
            (parse_timestamp(str(end_snapshot["captured_at"])) - parse_timestamp(str(start_snapshot["captured_at"]))).total_seconds()
            // 60
        ),
        "valid_for_ranking": True,
        "reason": "valid",
    }
    return {
        "schema_version": RANKING_SCHEMA_VERSION,
        "ranking_limit": limit,
        "entry_count": min(len(rankable), limit),
        "date": (end_date - dt.timedelta(days=1)).isoformat(),
        "period_days": days,
        "timezone": TIMEZONE,
        "window_start": start_snapshot["captured_at"],
        "window_end": end_snapshot["captured_at"],
        "window_quality": quality,
        "candidate_count": end_snapshot["candidate_count"],
        "eligible_count": len(rankable),
        "collection": end_snapshot["collection"],
        "entries": ranked_entries(rankable, previous_ranking=previous_ranking, limit=limit),
    }


def knowledge_repository_map(projects_file: Path) -> Dict[str, str]:
    projects = load_json(projects_file, [])
    result: Dict[str, str] = {}
    for project in projects:
        if not isinstance(project, dict):
            continue
        repository = project.get("repository")
        document = project.get("document")
        if isinstance(repository, str) and isinstance(document, str):
            result[repository.lower()] = document
    return result


def load_snapshot_history(snapshot_dir: Path, *, include: Optional[Mapping[str, Any]] = None) -> Dict[dt.date, Any]:
    history: Dict[dt.date, Any] = {}
    for path in snapshot_files(snapshot_dir, limit=32):
        payload = load_json(path)
        history[dt.date.fromisoformat(payload["snapshot_date"])] = payload
    if include is not None:
        history[dt.date.fromisoformat(include["snapshot_date"])] = include
    return history


def consecutive_valid_windows(
    snapshot_history: Mapping[dt.date, Mapping[str, Any]], latest_date: Optional[dt.date] = None
) -> int:
    if not snapshot_history:
        return 0
    current_date = latest_date or max(snapshot_history)
    current = snapshot_history.get(current_date)
    if current is None or not snapshot_is_valid(current):
        return 0
    count = 0
    while True:
        previous_date = current_date - dt.timedelta(days=1)
        previous = snapshot_history.get(previous_date)
        if previous is None or not snapshot_pair_is_valid(previous, current):
            break
        count += 1
        current_date = previous_date
        current = previous
    return count


def local_schedule(date: dt.date, hour: int, minute: int) -> str:
    return dt.datetime(date.year, date.month, date.day, hour, minute, tzinfo=ZoneInfo(TIMEZONE)).isoformat()


def build_sampling_state(
    snapshot_history: Mapping[dt.date, Mapping[str, Any]], *, ranking_ready: bool
) -> Dict[str, Any]:
    if not snapshot_history:
        return {
            "target_local_time": "00:20",
            "valid_window_start": "00:00",
            "valid_window_end": "03:00",
            "latest_snapshot_at": None,
            "latest_snapshot_valid": False,
            "latest_snapshot_reason": "missing",
            "latest_valid_snapshot_at": None,
            "consecutive_valid_snapshots": 0,
            "next_scheduled_at": None,
            "expected_first_ranking_at": None,
            "period_progress": {
                "7d": {"completed": 0, "required": 7},
                "30d": {"completed": 0, "required": 30},
            },
        }
    latest_date = max(snapshot_history)
    latest = snapshot_history[latest_date]
    latest_quality = snapshot_quality(latest)
    valid_dates = [date for date, snapshot in snapshot_history.items() if snapshot_is_valid(snapshot)]
    latest_valid = snapshot_history[max(valid_dates)] if valid_dates else None
    windows = consecutive_valid_windows(snapshot_history, latest_date)
    if ranking_ready:
        expected_first = None
    elif latest_quality["valid_for_ranking"]:
        expected_first = local_schedule(latest_date + dt.timedelta(days=1), 1, 0)
    else:
        expected_first = local_schedule(latest_date + dt.timedelta(days=2), 1, 0)
    return {
        "target_local_time": "00:20",
        "valid_window_start": "00:00",
        "valid_window_end": "03:00",
        "latest_snapshot_at": latest["captured_at"],
        "latest_snapshot_valid": bool(latest_quality["valid_for_ranking"]),
        "latest_snapshot_reason": latest_quality["reason"],
        "latest_valid_snapshot_at": latest_valid["captured_at"] if latest_valid else None,
        "consecutive_valid_snapshots": min(2, windows + 1) if latest_quality["valid_for_ranking"] else 0,
        "next_scheduled_at": local_schedule(latest_date + dt.timedelta(days=1), 0, CAPTURE_TARGET_MINUTE),
        "expected_first_ranking_at": expected_first,
        "period_progress": {
            "7d": {"completed": min(windows, 7), "required": 7},
            "30d": {"completed": min(windows, 30), "required": 30},
        },
    }


def build_repository_catalog(
    *,
    candidates: Sequence[Mapping[str, Any]],
    snapshot_history: Mapping[dt.date, Mapping[str, Any]],
    public_dir: Path,
    knowledge_repositories: Mapping[str, str],
    updated_at: str,
    additional_ranking: Optional[Mapping[str, Any]] = None,
) -> Dict[str, Any]:
    latest_snapshot_date = max(snapshot_history) if snapshot_history else local_date(parse_timestamp(updated_at))
    final_day = latest_snapshot_date - dt.timedelta(days=1)
    ranking_by_date: Dict[dt.date, Dict[int, int]] = {}
    for offset in range(30):
        day = final_day - dt.timedelta(days=offset)
        ranking = load_json(public_dir / "daily" / f"{day.isoformat()}.json")
        if additional_ranking is not None and additional_ranking.get("date") == day.isoformat():
            ranking = additional_ranking
        ranking_by_date[day] = {
            int(item["repository_id"]): int(item["rank"])
            for item in (ranking or {}).get("entries", [])
        }
    repositories: List[Dict[str, Any]] = []
    for candidate in sorted(candidates, key=lambda item: str(item["full_name"]).casefold()):
        repository_id = str(candidate["repository_id"])
        history: List[Dict[str, Any]] = []
        for offset in range(29, -1, -1):
            day = final_day - dt.timedelta(days=offset)
            end_snapshot = snapshot_history.get(day + dt.timedelta(days=1))
            previous_snapshot = snapshot_history.get(day)
            previous_item = (previous_snapshot or {}).get("repositories", {}).get(repository_id)
            end_item = (end_snapshot or {}).get("repositories", {}).get(repository_id)
            comparable = bool(
                previous_snapshot
                and end_snapshot
                and previous_item is not None
                and end_item is not None
                and snapshot_pair_is_valid(previous_snapshot, end_snapshot)
            )
            history.append(
                {
                    "date": day.isoformat(),
                    "stars_total": int(end_item["stars_total"]) if comparable else None,
                    "stars_gained": daily_delta(snapshot_history, repository_id, day + dt.timedelta(days=1)) if comparable else None,
                    "rank": ranking_by_date.get(day, {}).get(int(repository_id)) if comparable else None,
                }
            )
        repositories.append(
            {
                "repository_id": int(repository_id),
                "full_name": candidate["full_name"],
                "description": candidate.get("description"),
                "language": candidate.get("language"),
                "stars_total": int(candidate["stars_total"]),
                "html_url": candidate["html_url"],
                "owner_avatar_url": candidate.get("owner_avatar_url"),
                "created_at": candidate.get("created_at"),
                "pushed_at": candidate.get("pushed_at"),
                "knowledge_url": knowledge_repositories.get(str(candidate["full_name"]).lower()),
                "first_seen_date": candidate.get("first_seen_date"),
                "last_seen_date": candidate.get("last_seen_date"),
                "history_30d": history,
            }
        )
    return {
        "schema_version": REPOSITORY_SCHEMA_VERSION,
        "updated_at": updated_at,
        "timezone": TIMEZONE,
        "candidate_count": len(repositories),
        "repositories": repositories,
    }


def build_language_index(
    *,
    candidates: Sequence[Mapping[str, Any]],
    public_dir: Path,
    updated_at: str,
    additional_rankings: Sequence[Mapping[str, Any]] = (),
) -> Dict[str, Any]:
    counts: Dict[str, int] = {}
    for candidate in candidates:
        language = candidate.get("language")
        if isinstance(language, str) and language.strip():
            counts[language] = counts.get(language, 0) + 1
    languages: List[Dict[str, Any]] = []
    for language in sorted(counts, key=str.casefold):
        slug = language_slug(language)
        daily_dir = public_dir / "language" / slug / "daily"
        dates = set(path.stem for path in daily_dir.glob("????-??-??.json")) if daily_dir.exists() else set()
        dates.update(str(item["date"]) for item in additional_rankings if item.get("slug") == slug)
        sorted_dates = sorted(dates, reverse=True)
        languages.append(
            {
                "language": language,
                "slug": slug,
                "candidate_count": counts[language],
                "latest_date": sorted_dates[0] if sorted_dates else None,
                "available_dates": sorted_dates,
                "status": "ready" if sorted_dates else "accumulating",
            }
        )
    return {
        "schema_version": RANKING_SCHEMA_VERSION,
        "updated_at": updated_at,
        "timezone": TIMEZONE,
        "ranking_limit": LANGUAGE_TOP_LIMIT,
        "page_size": PAGE_SIZE,
        "languages": languages,
    }


def build_index(
    public_dir: Path,
    *,
    snapshot_dir: Path,
    candidate_count: int,
    updated_at: Optional[str],
    latest_collection: Optional[Mapping[str, Any]],
    additional_dates: Sequence[str] = (),
    additional_period_dates: Optional[Mapping[int, Sequence[str]]] = None,
    include_snapshot: Optional[Mapping[str, Any]] = None,
) -> Dict[str, Any]:
    dates = set(additional_dates)
    daily_dir = public_dir / "daily"
    if daily_dir.exists():
        for path in daily_dir.glob("????-??-??.json"):
            try:
                dt.date.fromisoformat(path.stem)
            except ValueError:
                continue
            dates.add(path.stem)
    sorted_dates = sorted(dates, reverse=True)
    history = load_snapshot_history(snapshot_dir, include=include_snapshot)
    ready = bool(sorted_dates)
    periods: Dict[str, Any] = {}
    for days in PERIOD_DAYS:
        period_dir = public_dir / "period" / f"{days}d"
        found_period_dates = set(path.stem for path in period_dir.glob("????-??-??.json")) if period_dir.exists() else set()
        found_period_dates.update((additional_period_dates or {}).get(days, ()))
        period_dates = sorted(found_period_dates, reverse=True)
        periods[f"{days}d"] = {
            "latest_date": period_dates[0] if period_dates else None,
            "available_dates": period_dates,
        }
    return {
        "schema_version": RANKING_SCHEMA_VERSION,
        "status": "ready" if ready else "initializing",
        "timezone": TIMEZONE,
        "updated_at": updated_at,
        "latest_date": sorted_dates[0] if sorted_dates else None,
        "available_dates": sorted_dates,
        "candidate_count": candidate_count,
        "methodology_version": "candidate-pool-snapshot-v1",
        "freshness_threshold_hours": FRESHNESS_THRESHOLD_HOURS,
        "ranking_limit": TOP_LIMIT,
        "page_size": PAGE_SIZE,
        "latest_collection": dict(latest_collection) if latest_collection is not None else None,
        "sampling": build_sampling_state(history, ranking_ready=ready),
        "periods": periods,
    }


def prune_old_snapshots(snapshot_dir: Path, *, current_date: dt.date) -> List[Path]:
    cutoff = current_date - dt.timedelta(days=SNAPSHOT_RETENTION_DAYS - 1)
    removed: List[Path] = []
    if not snapshot_dir.exists():
        return removed
    for path in snapshot_dir.glob("????-??-??.json"):
        try:
            snapshot_date = dt.date.fromisoformat(path.stem)
        except ValueError:
            continue
        if snapshot_date < cutoff:
            path.unlink()
            removed.append(path)
    return sorted(removed)


def run_update(
    client: GitHubClient,
    *,
    data_dir: Path,
    projects_file: Path,
    captured_at: dt.datetime,
    max_candidates: int = DEFAULT_MAX_CANDIDATES,
    dry_run: bool = False,
    replace_snapshot: bool = False,
    replace_date: Optional[dt.date] = None,
    require_valid_capture: bool = False,
) -> Dict[str, Any]:
    snapshot_date = local_date(captured_at)
    if replace_snapshot and replace_date != snapshot_date:
        raise DataIntegrityError(
            f"替换快照必须明确确认当日北京时间日期 {snapshot_date.isoformat()}"
        )
    state_path = data_dir / "state" / "candidates.json"
    snapshot_dir = data_dir / "snapshots"
    public_dir = data_dir / "public"
    snapshot_path = snapshot_dir / f"{snapshot_date.isoformat()}.json"
    # The public rank is independent from any private knowledge base. Keep the
    # nullable contract field for 1.2 compatibility, but never publish links to
    # external analysis material.
    knowledge_repositories: Dict[str, str] = {}

    existing_snapshot = load_json(snapshot_path)
    if existing_snapshot is not None and not replace_snapshot:
        state = load_json(state_path, {"candidates": []})
        candidates = state.get("candidates", []) if isinstance(state, dict) else []
        if not isinstance(candidates, list):
            raise DataIntegrityError("候选池状态文件中的 candidates 必须是数组")
        history = load_snapshot_history(snapshot_dir)
        index = build_index(
            public_dir,
            snapshot_dir=snapshot_dir,
            candidate_count=int(existing_snapshot["candidate_count"]),
            updated_at=existing_snapshot["captured_at"],
            latest_collection=existing_snapshot.get("collection"),
        )
        repositories = build_repository_catalog(
            candidates=candidates,
            snapshot_history=history,
            public_dir=public_dir,
            knowledge_repositories=knowledge_repositories,
            updated_at=str(existing_snapshot["captured_at"]),
        )
        language_index = build_language_index(
            candidates=candidates,
            public_dir=public_dir,
            updated_at=str(existing_snapshot["captured_at"]),
        )
        if not dry_run:
            validate_payload("index", index)
            validate_payload("repositories", repositories)
            validate_payload("language_index", language_index)
            sync_public_schemas(public_dir)
            atomic_write_json(public_dir / "index.json", index)
            atomic_write_json(public_dir / "repositories.json", repositories)
            atomic_write_json(public_dir / "language" / "index.json", language_index)
        return {
            "status": "reused",
            "snapshot": existing_snapshot,
            "index": index,
            "ranking": None,
            "language_rankings": [],
            "period_rankings": [],
        }

    if require_valid_capture and not capture_quality(captured_at)["valid_for_ranking"]:
        raise DataIntegrityError("正式快照只能在北京时间 00:00（含）至 03:00（不含）采集")

    state = load_json(state_path, {"candidates": []})
    previous_candidates = state.get("candidates", []) if isinstance(state, dict) else []
    if not isinstance(previous_candidates, list):
        raise DataIntegrityError("候选池状态文件中的 candidates 必须是数组")
    existing_map = {int(item["repository_id"]): item for item in previous_candidates}
    seeds = load_seed_repositories(projects_file)
    discovered, search_result_counts = discover_candidates(
        client, observed_date=snapshot_date, existing=existing_map
    )
    candidates = merge_and_refresh_candidates(
        client,
        previous=previous_candidates,
        discovered=discovered,
        pinned_repositories=seeds,
        snapshot_dir=snapshot_dir,
        observed_date=snapshot_date,
        max_candidates=max_candidates,
    )
    previous_ids = set(existing_map)
    current_ids = {int(item["repository_id"]) for item in candidates}
    candidate_count = len(candidates)
    collection = {
        "search_result_counts": search_result_counts,
        "unique_discovered_count": len(discovered),
        "candidate_added_count": len(current_ids - previous_ids),
        "candidate_removed_count": len(previous_ids - current_ids),
        "api_request_count": int(getattr(client, "request_count", 0)),
        "api_retry_count": int(getattr(client, "retry_count", 0)),
        "snapshot_expected_count": candidate_count,
        "snapshot_complete_count": candidate_count,
        "snapshot_completeness": 1.0,
    }
    snapshot = build_snapshot(candidates, captured_at=captured_at, collection=collection)

    previous_date = snapshot_date - dt.timedelta(days=1)
    previous_snapshot = load_json(snapshot_dir / f"{previous_date.isoformat()}.json")
    history = load_snapshot_history(snapshot_dir, include=snapshot)
    ranking: Optional[Dict[str, Any]] = None
    all_rankable: List[Dict[str, Any]] = []
    if previous_snapshot is not None and snapshot_pair_is_valid(previous_snapshot, snapshot):
        previous_ranking = load_json(public_dir / "daily" / f"{(previous_date - dt.timedelta(days=1)).isoformat()}.json")
        ranking = build_daily_ranking(
            previous_snapshot=previous_snapshot,
            current_snapshot=snapshot,
            candidates=candidates,
            snapshot_history=history,
            previous_ranking=previous_ranking,
            knowledge_repositories=knowledge_repositories,
        )
        all_rankable = rankable_entries(
            previous_snapshot=previous_snapshot,
            current_snapshot=snapshot,
            candidates=candidates,
            snapshot_history=history,
            knowledge_repositories=knowledge_repositories,
        )

    language_rankings = (
        build_language_rankings(daily_ranking=ranking, all_rankable=all_rankable, public_dir=public_dir)
        if ranking is not None
        else []
    )
    exploration_pools: List[Dict[str, Any]] = []
    if ranking is not None:
        exploration_pools.append(
            build_exploration_pool(
                board_kind="candidate_daily",
                ranking=ranking,
                rankable=all_rankable,
            )
        )
    period_rankings: List[Dict[str, Any]] = []
    for days in PERIOD_DAYS:
        start_snapshot = history.get(snapshot_date - dt.timedelta(days=days))
        if start_snapshot is None or not complete_period_window(history, end_date=snapshot_date, days=days):
            continue
        period_date = (snapshot_date - dt.timedelta(days=1)).isoformat()
        previous_period_date = (dt.date.fromisoformat(period_date) - dt.timedelta(days=1)).isoformat()
        previous_period = load_json(public_dir / "period" / f"{days}d" / f"{previous_period_date}.json")
        full_period_ranking = build_period_ranking(
                days=days,
                end_snapshot=snapshot,
                start_snapshot=start_snapshot,
                candidates=candidates,
                snapshot_history=history,
                previous_ranking=previous_period,
                knowledge_repositories=knowledge_repositories,
                limit=len(candidates),
            )
        period_rankings.append(
            {
                **full_period_ranking,
                "ranking_limit": TOP_LIMIT,
                "entry_count": min(len(full_period_ranking["entries"]), TOP_LIMIT),
                "entries": full_period_ranking["entries"][:TOP_LIMIT],
            }
        )
        exploration_pools.append(
            build_exploration_pool(
                board_kind=f"candidate_period_{days}d",
                ranking=full_period_ranking,
                rankable=full_period_ranking["entries"],
            )
        )

    updated_at = snapshot["captured_at"]
    state_payload = {
        "schema_version": SCHEMA_VERSION,
        "updated_at": updated_at,
        "candidate_count": len(candidates),
        "candidates": candidates,
    }
    additional_dates = [ranking["date"]] if ranking is not None else []
    additional_period_dates = {
        days: [str(item["date"]) for item in period_rankings if item["period_days"] == days]
        for days in PERIOD_DAYS
    }
    index = build_index(
        public_dir,
        snapshot_dir=snapshot_dir,
        candidate_count=len(candidates),
        updated_at=updated_at,
        latest_collection=collection,
        additional_dates=additional_dates,
        additional_period_dates=additional_period_dates,
        include_snapshot=snapshot,
    )
    repositories = build_repository_catalog(
        candidates=candidates,
        snapshot_history=history,
        public_dir=public_dir,
        knowledge_repositories=knowledge_repositories,
        updated_at=updated_at,
        additional_ranking=ranking,
    )
    language_index = build_language_index(
        candidates=candidates,
        public_dir=public_dir,
        updated_at=updated_at,
        additional_rankings=language_rankings,
    )
    try:
        validate_payload("state", state_payload)
        validate_payload("snapshot", snapshot)
        if ranking is not None:
            validate_payload("daily", ranking)
        for language_ranking in language_rankings:
            validate_payload("language", language_ranking)
        for period_ranking in period_rankings:
            validate_payload("period", period_ranking)
        for exploration_pool in exploration_pools:
            validate_payload("exploration_pool", exploration_pool)
        validate_payload("repositories", repositories)
        validate_payload("language_index", language_index)
        validate_payload("index", index)
    except SchemaValidationError as exc:
        raise DataIntegrityError(str(exc)) from exc
    if not dry_run:
        sync_public_schemas(public_dir)
        atomic_write_json(state_path, state_payload)
        atomic_write_json(snapshot_path, snapshot)
        if ranking is not None:
            atomic_write_json(public_dir / "daily" / f"{ranking['date']}.json", ranking)
        for language_ranking in language_rankings:
            atomic_write_json(
                public_dir / "language" / str(language_ranking["slug"]) / "daily" / f"{language_ranking['date']}.json",
                language_ranking,
            )
        for period_ranking in period_rankings:
            atomic_write_json(
                public_dir / "period" / f"{period_ranking['period_days']}d" / f"{period_ranking['date']}.json",
                period_ranking,
            )
        for exploration_pool in exploration_pools:
            board_kind = str(exploration_pool["board_kind"])
            if board_kind == "candidate_daily":
                destination = public_dir / "explore" / "daily" / f"{exploration_pool['date']}.json"
            else:
                period = board_kind.removeprefix("candidate_period_")
                destination = public_dir / "explore" / "period" / period / f"{exploration_pool['date']}.json"
            atomic_write_json(destination, exploration_pool)
        atomic_write_json(public_dir / "repositories.json", repositories)
        atomic_write_json(public_dir / "language" / "index.json", language_index)
        atomic_write_json(public_dir / "index.json", index)
        removed_snapshots = prune_old_snapshots(snapshot_dir, current_date=snapshot_date)
    else:
        removed_snapshots = []
    return {
        "status": "updated",
        "snapshot": snapshot,
        "ranking": ranking,
        "language_rankings": language_rankings,
        "period_rankings": period_rankings,
        "exploration_pools": exploration_pools,
        "index": index,
        "removed_snapshots": [str(path) for path in removed_snapshots],
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="生成开源星榜候选池快照与每日排行")
    parser.add_argument("--data-dir", type=Path, required=True, help="star-rank-data 分支工作目录")
    parser.add_argument(
        "--seed-repositories-file",
        dest="projects_file",
        type=Path,
        default=Path("data/seed-repositories.json"),
        help="固定纳入候选池的公开 GitHub 仓库列表",
    )
    parser.add_argument("--max-candidates", type=int, default=DEFAULT_MAX_CANDIDATES)
    parser.add_argument("--dry-run", action="store_true", help="完成 API 与数据校验但不写文件")
    parser.add_argument("--replace-snapshot", action="store_true", help="显式替换当天快照")
    parser.add_argument("--replace-date", help="替换模式的北京时间日期确认（YYYY-MM-DD）")
    parser.add_argument(
        "--require-valid-capture",
        action="store_true",
        help="新建或替换正式快照时要求北京时间 00:00–03:00",
    )
    parser.add_argument("--now", help="测试用 ISO-8601 UTC 时间；默认当前时间")
    return parser


def main(argv: Optional[Sequence[str]] = None) -> int:
    args = build_parser().parse_args(argv)
    if args.max_candidates < 1 or args.max_candidates > DEFAULT_MAX_CANDIDATES:
        print(f"错误：max-candidates 必须在 1 到 {DEFAULT_MAX_CANDIDATES} 之间", file=sys.stderr)
        return 2
    token = os.environ.get("GITHUB_TOKEN")
    if not token:
        print("错误：必须通过 GITHUB_TOKEN 提供 GitHub API 令牌", file=sys.stderr)
        return 2
    try:
        captured_at = parse_timestamp(args.now) if args.now else utc_now()
        replace_date = dt.date.fromisoformat(args.replace_date) if args.replace_date else None
        result = run_update(
            GitHubClient(token),
            data_dir=args.data_dir.resolve(),
            projects_file=args.projects_file.resolve(),
            captured_at=captured_at,
            max_candidates=args.max_candidates,
            dry_run=args.dry_run,
            replace_snapshot=args.replace_snapshot,
            replace_date=replace_date,
            require_valid_capture=args.require_valid_capture,
        )
    except (StarRankError, SchemaValidationError, ValueError) as exc:
        print(f"错误：{exc}", file=sys.stderr)
        return 1
    summary = {
        "status": result["status"],
        "snapshot_date": result["snapshot"]["snapshot_date"],
        "candidate_count": result["snapshot"]["candidate_count"],
        "ranking_date": result["ranking"]["date"] if result.get("ranking") else None,
        "published_entries": len(result["ranking"]["entries"]) if result.get("ranking") else 0,
        "published_language_rankings": len(result.get("language_rankings", [])),
        "published_period_rankings": len(result.get("period_rankings", [])),
        "collection": result["snapshot"]["collection"],
        "removed_snapshot_count": len(result.get("removed_snapshots", [])),
        "dry_run": args.dry_run,
    }
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
