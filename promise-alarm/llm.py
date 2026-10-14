# -*- coding: utf-8 -*-
"""调用 OpenAI Chat Completions 或 Anthropic Messages 兼容的聊天接口。"""
import json
import os
import urllib.request
from urllib.error import HTTPError, URLError

import config


class LLMError(RuntimeError):
    pass


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
    with urllib.request.urlopen(request, timeout=90) as response:
        payload = json.loads(response.read().decode("utf-8"))
    blocks = payload.get("content") or []
    text = "\n".join(str(block.get("text") or "") for block in blocks if isinstance(block, dict) and block.get("type") == "text")
    return text.strip()


def _openai_request(settings: dict, messages: list[dict], max_tokens: int, temperature: float, json_mode: bool) -> str:
    body = {
        "model": settings["model"],
        "messages": messages,
        "max_tokens": max_tokens,
        "temperature": temperature,
        "stream": False,
    }
    if json_mode:
        body["response_format"] = {"type": "json_object"}
    request = urllib.request.Request(
        settings["api_base"].rstrip("/") + "/chat/completions",
        data=json.dumps(body).encode("utf-8"),
        headers={"Authorization": f"Bearer {settings['api_key']}", "Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=90) as response:
        payload = json.loads(response.read().decode("utf-8"))
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
        raise LLMError(f"接口返回 {error.code}，检查 API Key、地址和模型名。") from error
    except (URLError, TimeoutError) as error:
        raise LLMError("连不上模型接口，检查网络和 api_base。") from error
    except (KeyError, IndexError, TypeError, ValueError) as error:
        raise LLMError("模型接口返回的格式不对。") from error


def chat_json(messages: list[dict], max_tokens: int = 300) -> dict:
    text = chat(messages, max_tokens=max_tokens, temperature=0.1, json_mode=True)
    fence = chr(96) * 3
    text = text.strip().removeprefix(fence + "json").removeprefix(fence).removesuffix(fence).strip()
    try:
        data = json.loads(text or "{}")
    except ValueError:
        return {}
    return data if isinstance(data, dict) else {}
