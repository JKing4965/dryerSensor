"""
conftest.py - shared pytest setup for the backend tests.

What it does:
    - Creates a separate database "dryer_test" (next to the real "dryer" database,
      in the same Docker container) from backend/db/schema.sql + seed.sql once per
      test run, and drops it afterwards. The real data is never touched.
    - Empties its tables before every test that uses the `db_url` fixture.
    - Tests that need the database are SKIPPED (not failed) when Docker isn't running.
    - `run` executes an async function from a normal test (works on Windows too).

How to run (from backend/):
    uv run pytest          (start the database first for the DB tests: docker compose up -d)
"""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path

import psycopg
import pytest
from psycopg.conninfo import make_conninfo

from dryer_backend.config import ConfigError, load_settings, run_async

DB_DIR = Path(__file__).parents[1] / "db"
TEST_DB = "dryer_test"


@pytest.fixture(scope="session")
def _test_database() -> Iterator[str]:
    try:
        admin_url = load_settings().database_url
        admin = psycopg.connect(admin_url, autocommit=True, connect_timeout=3)
    except (ConfigError, psycopg.OperationalError) as e:
        pytest.skip(f"database not available ({e.__class__.__name__}); run: docker compose up -d")
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
