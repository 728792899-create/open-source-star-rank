"""Bounded, non-redirecting transport for explicitly configured enrichment APIs."""
from __future__ import annotations

import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any


class ModelResponseError(RuntimeError):
    pass


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def validate_endpoint(endpoint: str) -> str:
    try:
        url = urllib.parse.urlsplit(endpoint)
        port = url.port
    except ValueError:
        raise ModelResponseError("模型接口地址无效") from None
    if (url.scheme != "https" or not url.hostname or url.username or url.password
            or url.query or url.fragment or port == 0
            or not url.path.endswith("/chat/completions")):
        raise ModelResponseError("模型接口必须是无凭据、无查询参数的 HTTPS /chat/completions 地址")
    if url.hostname.lower().rstrip(".") == "models.github.ai":
        raise ModelResponseError("GitHub Models 已退役，请配置新的模型接口")
    return endpoint


def runtime_config(offline: bool, model: str | None) -> tuple[str | None, str | None]:
    if offline:
        return None, None
    endpoint = os.environ.get("ENRICHMENT_API_URL", "").strip()
    token = os.environ.get("ENRICHMENT_API_KEY", "").strip()
    if not endpoint or not token or not model:
        print("warning: 模型补全未配置完整（接口、专用密钥、模型 ID）；仅保留缓存与待处理队列，不调用已退役的 GitHub Models。", file=sys.stderr)
        return None, None
    validate_endpoint(endpoint)
    return token, endpoint


def parse_response(raw: bytes) -> list[dict[str, Any]]:
    try:
        body = json.loads(raw)
    except (ValueError, UnicodeError):
        raise ModelResponseError(f"模型接口返回非 JSON 响应（{len(raw)} bytes），未包含可用推理结果") from None
    if not isinstance(body, dict) or not isinstance(body.get("choices"), list) or not body["choices"]:
        raise ModelResponseError("模型响应缺少 choices")
    choice = body["choices"][0]
    if not isinstance(choice, dict) or choice.get("finish_reason") != "stop":
        raise ModelResponseError("模型响应未正常结束（截断、过滤或结束状态缺失），拒绝写入")
    message = choice.get("message")
    if not isinstance(message, dict) or message.get("refusal"):
        raise ModelResponseError("模型消息无效或拒绝生成")
    content = message.get("content")
    if not isinstance(content, str) or not content.strip():
        raise ModelResponseError("模型返回空内容或非文本内容")
    try:
        decoded = json.loads(content)
    except ValueError:
        raise ModelResponseError("模型内容不是完整 JSON；未尝试修补或提取片段") from None
    entries = decoded.get("repositories") if isinstance(decoded, dict) else None
    if not isinstance(entries, list) or not all(isinstance(item, dict) for item in entries):
        raise ModelResponseError("模型返回的 repositories 不是对象数组")
    return entries


def request_entries(endpoint, token, payload, *, timeout=45, opener=None, sleeper=time.sleep):
    validate_endpoint(endpoint)
    open_request = opener or urllib.request.build_opener(NoRedirect()).open
    request = urllib.request.Request(endpoint, data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        method="POST", headers={"Accept": "application/json", "Content-Type": "application/json", "Authorization": f"Bearer {token}"})
    for attempt in range(2):
        try:
            with open_request(request, timeout=timeout) as response:
                return parse_response(response.read())
        except urllib.error.HTTPError as exc:
            status = exc.code
            exc.close()
            # Do not echo provider bodies/URLs: they may include credentials or prompts.
            if status < 500 or attempt == 1:
                raise ModelResponseError(f"模型接口 HTTP {status}") from None
        except (urllib.error.URLError, TimeoutError, OSError):
            if attempt == 1:
                raise ModelResponseError("模型接口网络异常或超时") from None
        except ModelResponseError:
            if attempt == 1:
                raise
        sleeper(float(2**attempt))
    raise ModelResponseError("模型接口不可用")
