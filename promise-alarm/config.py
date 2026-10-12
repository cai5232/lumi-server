# -*- coding: utf-8 -*-
"""Read local settings, with server environment variables taking precedence."""
import json
import os
from datetime import timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent
CONFIG_PATH = ROOT / "config.json"

DEFAULTS = {
    "api_base": "https://api.deepseek.com/v1",
    "api_key": "",
    "model": "deepseek-chat",
    "utc_offset_hours": 8,
    "char_name": "小机",
    "persona": "你是小机，她的 AI 恋人。说话温柔、简短、像微信聊天，偶尔调侃。",
    "webhook_url": "",
    "webhook_token": "",
}


def load() -> dict:
    settings = dict(DEFAULTS)
    try:
        saved = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
        if isinstance(saved, dict):
            settings.update({key: value for key, value in saved.items() if key in DEFAULTS})
    except (OSError, ValueError):
        pass
    settings["api_base"] = os.environ.get("PROMISE_API_BASE", "") or str(settings["api_base"] or "")
    settings["api_key"] = os.environ.get("PROMISE_API_KEY", "") or str(settings["api_key"] or "")
    settings["model"] = os.environ.get("PROMISE_MODEL", "") or str(settings["model"] or "")
    settings["persona"] = os.environ.get("PROMISE_PERSONA", "") or str(settings["persona"] or "")
    settings["webhook_url"] = os.environ.get("PROMISE_WEBHOOK_URL", "") or str(settings["webhook_url"] or "")
    settings["webhook_token"] = os.environ.get("PROMISE_WEBHOOK_TOKEN", "") or str(settings["webhook_token"] or "")
    try:
        settings["utc_offset_hours"] = float(os.environ.get("PROMISE_UTC_OFFSET_HOURS", settings["utc_offset_hours"]))
    except (TypeError, ValueError):
        pass
    return settings


def local_zone() -> timezone:
    try:
        hours = float(load()["utc_offset_hours"])
    except (TypeError, ValueError):
        hours = 8
    return timezone(timedelta(hours=hours))
