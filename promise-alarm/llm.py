# -*- coding: utf-8 -*-
"""调用 OpenAI Chat Completions 或 Anthropic Messages 兼容的聊天接口。"""
import json
import os
import time
import urllib.request
from datetime import datetime, timezone
from urllib.error import HTTPError, URLError

import config


class LLMError(RuntimeError):
    pass


def _record_model_request(settings: dict, api_format: str, request_body: dict, response_payload: dict, status: int, duration_ms: int) -> None:
    webhook_url = str(settings.get("webhook_url") or "")
    if not webhook_url:
        return
    endpoint = webhook_url.rsplit("/", 1)[0] + "/usage"
    usage = response_payload.get("usage") or {}
    details = usage.get("prompt_tokens_details") or usage.get("input_tokens_details") or {}
    api_base = str(settings.get("api_base") or "").lower()
    record = {
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "provider": "zenmux" if "zenmux" in api_base else "promise-alarm",
        "model": str(settings.get("model") or ""),
        "format": api_format,
        "status": int(status),
        "durationMs": max(0, int(duration_ms)),
        "inputTokens": int(usage.get("prompt_tokens") or usage.get("input_tokens") or 0),
        "outputTokens": int(usage.get("completion_tokens") or usage.get("output_tokens") or 0),
        "cachedTokens": int(details.get("cached_tokens") or usage.get("cache_read_input_tokens") or 0),
        "requestJSON": request_body,
        "responseJSON": response_payload,
    }
    payload = json.dumps({"record": record}, ensure_ascii=False).encode("utf-8")
    request = urllib.request.Request(
        endpoint,
        data=payload,
        headers={"Authorization": f"Bearer {settings.get('webhook_token') or ''}", "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=3):
            pass
    except Exception as error:
        print(f"promise-alarm usage log failed: {error}")


def available() -> bool:
    return bool(config.load()["api_key"])


def _uses_anthropic(settings: dict) -> bool:
    explicit = os.environ.get("PROMISE_NATIVE_ANTHROPIC", "").lower() == "true"
    return explicit or "anthropic.com" in str(settings.get("api_base") or "").lower()


def _anthropic_request(settings: dict, messages: list[dict], max_tokens: int, temperature: float) -> str:
    system_parts = []
    converted = []
    for message in messages:
        role = str(message.get("role") or "user")
        content = str(message.get("content") or "")
        if role == "system":
            system_parts.append(content)
        else:
            converted.append({"role": "assistant" if role == "assistant" else "user", "content": content})
    body = {
        "model": settings["model"],
        "max_tokens": max_tokens,
        "messages": converted,
        "stream": False,
    }
    if system_parts:
        body["system"] = "\n\n".join(system_parts)
    if temperature is not None:
        body["temperature"] = temperature
    request = urllib.request.Request(
        settings["api_base"].rstrip("/") + "/messages",
        data=json.dumps(body).encode("utf-8"),
        headers={
            "x-api-key": settings["api_key"],
            "anthropic-version": "2023-06-01",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    started = time.monotonic()
    try:
        with urllib.request.urlopen(request, timeout=90) as response:
            payload = json.loads(response.read().decode("utf-8"))
        _record_model_request(settings, "anthropic", body, payload, 200, int((time.monotonic() - started) * 1000))
    except HTTPError as error:
        try:
            error_payload = json.loads(error.read().decode("utf-8", errors="replace"))
        except Exception:
            error_payload = {"error": str(error)}
        _record_model_request(settings, "anthropic", body, error_payload, error.code, int((time.monotonic() - started) * 1000))
        raise
    blocks = payload.get("content") or []
    text = "\n".join(str(block.get("text") or "") for block in blocks if isinstance(block, dict) and block.get("type") == "text")
    return text.strip()


def _openai_request(settings: dict, messages: list[dict], max_tokens: int, temperature: float, json_mode: bool) -> str:
    body = {
        "model": settings["model"],
        "messages": messages,
        "max_tokens": max_tokens,
        "stream": False,
    }
    # ZenMux's OpenAI-compatible Anthropic routes reject temperature on Claude models.
    model_name = str(settings.get("model") or "").lower()
    if temperature is not None and "claude" not in model_name and "anthropic/" not in model_name:
        body["temperature"] = temperature
    if json_mode:
        body["response_format"] = {"type": "json_object"}
    request = urllib.request.Request(
        settings["api_base"].rstrip("/") + "/chat/completions",
        data=json.dumps(body).encode("utf-8"),
        headers={"Authorization": f"Bearer {settings['api_key']}", "Content-Type": "application/json"},
        method="POST",
    )
    started = time.monotonic()
    try:
        with urllib.request.urlopen(request, timeout=90) as response:
            payload = json.loads(response.read().decode("utf-8"))
        _record_model_request(settings, "openai", body, payload, 200, int((time.monotonic() - started) * 1000))
    except HTTPError as error:
        try:
            error_payload = json.loads(error.read().decode("utf-8", errors="replace"))
        except Exception:
            error_payload = {"error": str(error)}
        _record_model_request(settings, "openai", body, error_payload, error.code, int((time.monotonic() - started) * 1000))
        raise
    return str(payload["choices"][0]["message"]["content"] or "").strip()


def chat(messages: list[dict], max_tokens: int = 600, temperature: float = 0.7, json_mode: bool = False) -> str:
    settings = config.load()
    if not settings["api_key"]:
        raise LLMError("还没有填 API Key（见 README「填配置」）。")
    try:
        if _uses_anthropic(settings):
            return _anthropic_request(settings, messages, max_tokens, temperature)
        return _openai_request(settings, messages, max_tokens, temperature, json_mode)
    except HTTPError as error:
        try:
            detail = error.read().decode("utf-8", errors="replace").strip()
        except Exception:
            detail = ""
        detail = " ".join(detail.split())[:400]
        suffix = f"：{detail}" if detail else ""
        raise LLMError(f"接口返回 {error.code}{suffix}") from error
    except (URLError, TimeoutError) as error:
        raise LLMError("连不上模型接口，检查网络和 api_base。") from error
    except (KeyError, IndexError, TypeError, ValueError) as error:
        raise LLMError("模型接口返回的格式不对。") from error


def chat_via_lumi(session_id: str, messages: list[dict], max_tokens: int = 400) -> str:
    """Generate scheduled reminder text through Lumi's per-chat model route."""
    settings = config.load()
    webhook_url = str(settings.get("webhook_url") or "")
    if not webhook_url.endswith("/v1/internal/promise-alarm/fire"):
        raise LLMError("Lumi model gateway is not configured.")
    endpoint = webhook_url[:-len("/fire")] + "/generate"
    payload = json.dumps({
        "session_id": str(session_id or "default")[:80],
        "messages": messages,
        "max_tokens": max_tokens,
    }, ensure_ascii=False).encode("utf-8")
    request = urllib.request.Request(
        endpoint,
        data=payload,
        headers={
            "Authorization": f"Bearer {settings.get('webhook_token') or ''}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=100) as response:
            result = json.loads(response.read().decode("utf-8"))
    except HTTPError as error:
        detail = error.read().decode("utf-8", errors="replace").strip()
        raise LLMError(f"Lumi model gateway returned {error.code}: {detail[:300]}") from error
    except (URLError, TimeoutError) as error:
        raise LLMError("Cannot reach Lumi model gateway.") from error
    content = str(result.get("content") or "").strip()
    if not content:
        raise LLMError("Lumi model gateway returned an empty response.")
    return content


def chat_json(messages: list[dict], max_tokens: int = 300) -> dict:
    text = chat(messages, max_tokens=max_tokens, temperature=0.1, json_mode=True)
    fence = chr(96) * 3
    text = text.strip().removeprefix(fence + "json").removeprefix(fence).removesuffix(fence).strip()
    try:
        data = json.loads(text or "{}")
    except ValueError:
        return {}
    return data if isinstance(data, dict) else {}
