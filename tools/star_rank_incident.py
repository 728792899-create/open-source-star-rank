#!/usr/bin/env python3
"""Create, update, or close a single GitHub Issue used as an incident signal."""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Optional


API_VERSION = "2026-03-10"
DEFAULT_TITLE = "[开源星榜] 每日任务故障"
DEFAULT_LABEL = "star-rank-incident"


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


def incident_body(status: str, details: str) -> str:
    now = dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    heading = "自动检测到开源星榜采集或发布异常。" if status == "open" else "开源星榜已自动恢复。"
    return f"{heading}\n\n- 更新时间：`{now}`\n- 详情：{details}\n\n此 Issue 由 GitHub Actions 自动维护，请勿用于手工记录数据。"


def update_incident(
    client: GitHubIssueClient,
    *,
    status: str,
    title: str,
    label: str,
    details: str,
) -> Optional[int]:
    issue = client.find_open_issue(title)
    body = incident_body(status, details)
    if status == "open":
        client.ensure_label(label)
        if issue:
            client.request("PATCH", f"/issues/{issue['number']}", {"body": body, "labels": [label]})
            return int(issue["number"])
        created = client.request("POST", "/issues", {"title": title, "body": body, "labels": [label]})
        return int(created["number"])
    if issue:
        client.request("PATCH", f"/issues/{issue['number']}", {"body": body, "state": "closed"})
        return int(issue["number"])
    return None


def main() -> int:
    parser = argparse.ArgumentParser(description="维护开源星榜故障 Issue")
    parser.add_argument("--status", choices=("open", "close"), required=True)
    parser.add_argument("--repo", default=os.environ.get("GITHUB_REPOSITORY"))
    parser.add_argument("--title", default=DEFAULT_TITLE)
    parser.add_argument("--label", default=DEFAULT_LABEL)
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
    )
    print(json.dumps({"status": args.status, "issue_number": number}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
