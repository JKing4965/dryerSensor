"""
config.py - reads backend settings from the repo-root .env file.

What it does:
    Loads .env (copied from .env.example) and returns a Settings object with the
    database URL, this board's device ID and its Bluetooth name. Values already
    set in the environment win over .env, so you can override one for a single run:
        PowerShell:  $env:DEVICE_ID = "dryer-2"; uv run python -m dryer_backend.ingest ...

Talks to:
    - .env / .env.example in the repo root (one level above backend/).
    - Used by ingest.py and by the tests (tests/conftest.py).
"""

from __future__ import annotations

import asyncio
import os
import sys
from collections.abc import Coroutine
from dataclasses import dataclass
from pathlib import Path
from typing import Any, TypeVar

from dotenv import load_dotenv

REPO_ROOT = Path(__file__).resolve().parents[3]
ENV_FILE = REPO_ROOT / ".env"

T = TypeVar("T")


class ConfigError(RuntimeError):
    """A required setting is missing."""


@dataclass(frozen=True, slots=True)
class Settings:
    database_url: str
    device_id: str
    ble_device_name: str
    flush_interval_s: float = 1.0  # how often buffered samples are written


def load_settings(env_file: Path = ENV_FILE) -> Settings:
    load_dotenv(env_file, override=False)
    url = os.environ.get("DATABASE_URL")
    if not url:
        raise ConfigError(
            f"DATABASE_URL is not set. Copy .env.example to {env_file} "
            "(see README.md, 'One-time setup')."
        )
    return Settings(
        database_url=url,
        device_id=os.environ.get("DEVICE_ID", "dryer-1"),
        ble_device_name=os.environ.get("BLE_DEVICE_NAME", "XIAO-BLE"),
        flush_interval_s=float(os.environ.get("FLUSH_INTERVAL_S", "1.0")),
    )


def run_async(coro: Coroutine[Any, Any, T]) -> T:
    """asyncio.run() that also works on Windows.

    The async PostgreSQL driver (psycopg) can't use Windows' default event loop,
    so on Windows we ask for the selector-based loop instead.
    """
    if sys.platform == "win32":
        return asyncio.run(coro, loop_factory=asyncio.SelectorEventLoop)
    return asyncio.run(coro)
