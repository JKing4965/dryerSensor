"""
conftest.py - shared pytest setup for the backend tests.

What it does:
    - Creates a separate database "dryer_test" in the LOCAL Docker container from
      backend/db/*.sql once per test run, and drops it afterwards. Real data is never touched.
    - It deliberately does NOT use DATABASE_URL from .env: that may point at Timescale
      Cloud, and tests must never create or drop databases there. The local Docker
      address is used, unless TEST_DATABASE_URL is set to another LOCAL server
      (localhost / 127.0.0.1 / ::1 only; anything else is refused).
    - Empties its tables (and resets the device / receiver rows) before every test that
      uses the `db_url` fixture.
    - Tests that need the database are SKIPPED (not failed) when Docker isn't running.
    - `run` executes an async function from a normal test (works on Windows too).

How to run (from backend/):
    uv run python -m pytest     (start the database first for the DB tests: docker compose up -d)
"""

from __future__ import annotations

import os
from collections.abc import Iterator
from pathlib import Path

import psycopg
import pytest
from psycopg.conninfo import conninfo_to_dict, make_conninfo

from dryer_backend.config import run_async

DB_DIR = Path(__file__).parents[1] / "db"
TEST_DB = "dryer_test"
# Same login as docker-compose.yml / .env.example. Never the cloud database.
LOCAL_DOCKER_URL = "postgresql://dryer:dryer_dev_password@localhost:5432/dryer"
LOCAL_HOSTS = {"localhost", "127.0.0.1", "::1"}


def _admin_url() -> str:
    url = os.environ.get("TEST_DATABASE_URL") or LOCAL_DOCKER_URL
    host = conninfo_to_dict(url).get("host") or "localhost"
    if host not in LOCAL_HOSTS:
        pytest.skip(f"TEST_DATABASE_URL points at '{host}': tests only run against a local database")
    return url


@pytest.fixture(scope="session")
def _test_database() -> Iterator[str]:
    admin_url = _admin_url()
    try:
        admin = psycopg.connect(admin_url, autocommit=True, connect_timeout=3)
    except psycopg.OperationalError as e:
        pytest.skip(f"local test database not available ({e.__class__.__name__}); run: docker compose up -d")
    with admin:
        admin.execute(f"DROP DATABASE IF EXISTS {TEST_DB} WITH (FORCE)")
        admin.execute(f"CREATE DATABASE {TEST_DB}")
    url = make_conninfo(admin_url, dbname=TEST_DB)
    with psycopg.connect(url, autocommit=True) as conn:
        for sql_file in sorted(DB_DIR.glob("*.sql")):  # same order Docker uses
            conn.execute(sql_file.read_text(encoding="utf-8"))
    yield url
    with psycopg.connect(admin_url, autocommit=True) as admin:
        admin.execute(f"DROP DATABASE IF EXISTS {TEST_DB} WITH (FORCE)")


@pytest.fixture
def db_url(_test_database: str) -> str:
    """URL of an empty test database (seed rows only)."""
    with psycopg.connect(_test_database, autocommit=True) as conn:
        conn.execute("TRUNCATE readings, cycles, events RESTART IDENTITY")
        conn.execute(
            "UPDATE device_status SET connected = false, last_seen = NULL, state = NULL, "
            "boot_id = NULL, backlog_count = NULL, protocol_version = NULL, "
            "sensor_in_error = NULL, sensor_out_error = NULL, sensor_error_since = NULL"
        )
        conn.execute(
            "UPDATE receiver_control SET desired = 'disconnected', requested_at = NULL, "
            "receiver_online_at = NULL, receiver_state = NULL, receiver_host = NULL"
        )
    return _test_database


@pytest.fixture
def sql(db_url: str):
    """sql("SELECT ...", params) -> list of row tuples from the test database."""

    def query(statement: str, params: tuple = ()) -> list[tuple]:
        with psycopg.connect(db_url) as conn:
            return conn.execute(statement, params).fetchall()

    return query


@pytest.fixture
def run():
    return run_async
