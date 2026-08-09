#!/usr/bin/env python3
"""Create, update, or close a single GitHub Issue used as an incident signal."""

from __future__ import annotations

import argparse
import base64
import datetime as dt
import hashlib
import json
import os
import re
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Optional


API_VERSION = "2026-03-10"
DEFAULT_TITLE = "[开源星榜] 每日任务故障"
DEFAULT_LABEL = "star-rank-incident"
STATE_VERSION = 1
STATE_PATTERN = re.compile(r"<!-- star-rank-incident-state:([A-Za-z0-9_-]+) -->")
COMPONENT_NAMES = {
    "collector": "采集器",
    "data_pipeline": "数据处理与发布",
    "data_freshness": "数据分支新鲜度",
    "pages_publish": "Pages 构建或发布",
    "consistency": "数据分支与站点一致性",
    "pipeline": "采集发布流水线",
}


class GitHubIssueClient:
    def __init__(self, token: str, repository: str) -> None:
        self.repository = repository
        self.headers = {
            "Accept": "application/vnd.github+json",
            "Authorization": f"Bearer {token}",
            "X-GitHub-Api-Version": API_VERSION,
            "User-Agent": "open-source-star-rank-incident",
        }

    def request(self, method: str, path: str, payload: Optional[dict[str, Any]] = None, *, allow_404: bool = False) -> Any:
        url = f"https://api.github.com/repos/{self.repository}{path}"
        body = json.dumps(payload).encode("utf-8") if payload is not None else None
        request = urllib.request.Request(url, data=body, headers=self.headers, method=method)
        try:
            with urllib.request.urlopen(request, timeout=20) as response:
                content = response.read()
                return json.loads(content.decode("utf-8")) if content else None
        except urllib.error.HTTPError as exc:
            if allow_404 and exc.code == 404:
                return None
            detail = exc.read().decode("utf-8")[:500]
            raise RuntimeError(f"GitHub Issue API 请求失败 ({exc.code})：{detail}") from exc

    def ensure_label(self, label: str) -> None:
        encoded = urllib.parse.quote(label, safe="")
        if self.request("GET", f"/labels/{encoded}", allow_404=True) is None:
            self.request(
                "POST",
                "/labels",
                {"name": label, "color": "b42318", "description": "开源星榜自动化故障"},
            )

    def find_open_issue(self, title: str) -> Optional[dict[str, Any]]:
        issues = self.request("GET", "/issues?state=open&per_page=100")
        return next((issue for issue in issues if issue.get("title") == title and "pull_request" not in issue), None)


def _timestamp(value: Optional[dt.datetime] = None) -> str:
    current = value or dt.datetime.now(dt.timezone.utc)
    if current.tzinfo is None:
        raise ValueError("incident timestamp must include a timezone")
    return current.astimezone(dt.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _new_state(first_seen: str) -> dict[str, Any]:
    return {
        "version": STATE_VERSION,
        "first_seen": first_seen,
        "last_seen": first_seen,
        "last_success": None,
        "failures": {},
    }


def incident_state_from_body(body: str) -> Optional[dict[str, Any]]:
    """Return the machine-readable incident state embedded in an Issue body."""

    match = STATE_PATTERN.search(body or "")
    if not match:
        return None
    try:
        encoded = match.group(1)
        padding = "=" * (-len(encoded) % 4)
        state = json.loads(base64.urlsafe_b64decode(encoded + padding).decode("utf-8"))
    except (UnicodeDecodeError, ValueError, json.JSONDecodeError):
        return None
    if not isinstance(state, dict) or state.get("version") != STATE_VERSION:
        return None
    if not isinstance(state.get("failures"), dict):
        return None
    return state


def _state_marker(state: dict[str, Any]) -> str:
    raw = json.dumps(state, ensure_ascii=False, separators=(",", ":"), sort_keys=True).encode("utf-8")
    encoded = base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")
    return f"<!-- star-rank-incident-state:{encoded} -->"


def _load_state(issue: Optional[dict[str, Any]], now: str) -> dict[str, Any]:
    if issue:
        existing = incident_state_from_body(str(issue.get("body") or ""))
        if existing is not None:
            return existing
        created_at = issue.get("created_at")
        if isinstance(created_at, str) and created_at:
            return _new_state(created_at)
    return _new_state(now)


def _error_fingerprint(component: str, details: str, supplied: Optional[str]) -> str:
    if supplied:
        if len(supplied) > 160 or not re.fullmatch(r"[A-Za-z0-9._:/-]+", supplied):
            raise ValueError("fingerprint 只能包含字母、数字及 . _ : / -，且长度不得超过 160")
        return supplied
    digest = hashlib.sha256(f"{component}\0{details}".encode("utf-8")).hexdigest()[:16]
    return f"sha256:{digest}"


def _record_failure(
    state: dict[str, Any],
    *,
    component: str,
    details: str,
    fingerprint: str,
    now: str,
) -> None:
    failures = state["failures"]
    previous = failures.get(component)
    repeated = (
        isinstance(previous, dict)
        and previous.get("fingerprint") == fingerprint
        and previous.get("resolved_at") is None
    )
    first_seen = previous.get("first_seen", now) if isinstance(previous, dict) else now
    first_details = previous.get("first_details", details) if isinstance(previous, dict) else details
    total_failures = int(previous.get("total_failures", 0)) + 1 if isinstance(previous, dict) else 1
    failures[component] = {
        "first_seen": first_seen,
        "last_seen": now,
        "fingerprint": fingerprint,
        "consecutive_failures": int(previous.get("consecutive_failures", 0)) + 1 if repeated else 1,
        "total_failures": total_failures,
        "first_details": first_details,
        "latest_details": details,
        "resolved_at": None,
    }
    state["last_seen"] = now


def _record_success(state: dict[str, Any], *, component: str, details: str, now: str, resolve_all: bool) -> None:
    state["last_success"] = {"at": now, "component": component, "details": details}
    if resolve_all:
        for failure in state["failures"].values():
            if isinstance(failure, dict) and failure.get("resolved_at") is None:
                failure["resolved_at"] = now
        state["resolved_at"] = now


def incident_body(status: str, details: str, state: dict[str, Any]) -> str:
    if status == "close":
        heading = "开源星榜已自动恢复。"
    elif status == "success":
        heading = "采集与发布流水线已恢复，等待线上一致性确认。"
    else:
        heading = "自动检测到开源星榜采集或发布异常。"
    lines = [
        heading,
        "",
        f"- 首次发现：`{state['first_seen']}`",
        f"- 最近发现：`{state['last_seen']}`",
    ]
    last_success = state.get("last_success")
    if isinstance(last_success, dict):
        lines.append(f"- 最近成功：`{last_success.get('at')}`（{last_success.get('details')}）")
    else:
        lines.append("- 最近成功：尚无自动确认记录")
    lines.extend(["", "## 故障明细", ""])
    failures = state.get("failures", {})
    if failures:
        for component, failure in failures.items():
            component_name = COMPONENT_NAMES.get(component, component)
            resolution = failure.get("resolved_at")
            failure_status = f"已于 `{resolution}` 恢复" if resolution else "仍待一致性检查确认"
            lines.extend(
                [
                    f"### {component_name} (`{component}`)",
                    "",
                    f"- 状态：{failure_status}",
                    f"- 错误指纹：`{failure.get('fingerprint')}`",
                    f"- 首次/最近发现：`{failure.get('first_seen')}` / `{failure.get('last_seen')}`",
                    f"- 当前连续次数 / 累计次数：{failure.get('consecutive_failures')} / {failure.get('total_failures')}",
                    f"- 首次详情：{failure.get('first_details')}",
                    f"- 最近详情：{failure.get('latest_details')}",
                    "",
                ]
            )
    else:
        lines.extend(["暂无故障明细。", ""])
    lines.extend(["## 本次观察", "", details, "", "此 Issue 由 GitHub Actions 自动维护，请勿用于手工记录数据。", "", _state_marker(state)])
    return "\n".join(lines)


def update_incident(
    client: GitHubIssueClient,
    *,
    status: str,
    title: str,
    label: str,
    details: str,
    component: str = "pipeline",
    fingerprint: Optional[str] = None,
    now: Optional[dt.datetime] = None,
) -> Optional[int]:
    if status not in {"open", "success", "close"}:
        raise ValueError(f"unsupported incident status: {status}")
    observed_at = _timestamp(now)
    issue = client.find_open_issue(title)
    if status != "open" and issue is None:
        return None
    state = _load_state(issue, observed_at)
    if status == "open":
        _record_failure(
            state,
            component=component,
            details=details,
            fingerprint=_error_fingerprint(component, details, fingerprint),
            now=observed_at,
        )
    else:
        _record_success(state, component=component, details=details, now=observed_at, resolve_all=status == "close")
    body = incident_body(status, details, state)
    if status == "open":
        client.ensure_label(label)
        if issue:
            client.request("PATCH", f"/issues/{issue['number']}", {"body": body})
            return int(issue["number"])
        created = client.request("POST", "/issues", {"title": title, "body": body, "labels": [label]})
        return int(created["number"])
    payload: dict[str, Any] = {"body": body}
    if status == "close":
        payload["state"] = "closed"
    client.request("PATCH", f"/issues/{issue['number']}", payload)
    return int(issue["number"])


def main() -> int:
    parser = argparse.ArgumentParser(description="维护开源星榜故障 Issue")
    parser.add_argument("--status", choices=("open", "success", "close"), required=True)
    parser.add_argument("--repo", default=os.environ.get("GITHUB_REPOSITORY"))
    parser.add_argument("--title", default=DEFAULT_TITLE)
    parser.add_argument("--label", default=DEFAULT_LABEL)
    parser.add_argument("--component", default="pipeline")
    parser.add_argument("--fingerprint")
    parser.add_argument("--details", required=True)
    args = parser.parse_args()
    token = os.environ.get("GITHUB_TOKEN")
    if not token or not args.repo:
        parser.error("必须提供 GITHUB_TOKEN 和仓库名称")
    number = update_incident(
        GitHubIssueClient(token, args.repo),
        status=args.status,
        title=args.title,
        label=args.label,
        details=args.details,
        component=args.component,
        fingerprint=args.fingerprint,
    )
    print(json.dumps({"status": args.status, "issue_number": number}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
