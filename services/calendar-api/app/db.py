"""
Shared database + Redis helpers.
Copied per-service to keep containers independent (matching UC1 pattern).
"""
import os
import json
import psycopg
from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool
import redis

# ---- Postgres --------------------------------------------------------------

PG_DSN = (
    f"host={os.getenv('POSTGRES_HOST', 'localhost')} "
    f"port={os.getenv('POSTGRES_PORT', '5432')} "
    f"user={os.getenv('POSTGRES_USER', 'visionuser')} "
    f"password={os.getenv('POSTGRES_PASSWORD', 'visionpass')} "
    f"dbname={os.getenv('POSTGRES_DB', 'vision_employee')}"
)

_pool: ConnectionPool | None = None


def get_pool() -> ConnectionPool:
    global _pool
    if _pool is None:
        _pool = ConnectionPool(conninfo=PG_DSN, min_size=1, max_size=5, kwargs={"row_factory": dict_row})
    return _pool


def query(sql: str, params: tuple = ()) -> list[dict]:
    with get_pool().connection() as conn:
        with conn.cursor() as cur:
            cur.execute(sql, params)
            return cur.fetchall()


def query_one(sql: str, params: tuple = ()) -> dict | None:
    rows = query(sql, params)
    return rows[0] if rows else None


def execute(sql: str, params: tuple = ()) -> int:
    with get_pool().connection() as conn:
        with conn.cursor() as cur:
            cur.execute(sql, params)
            return cur.rowcount


def execute_returning(sql: str, params: tuple = ()) -> dict | None:
    with get_pool().connection() as conn:
        with conn.cursor() as cur:
            cur.execute(sql, params)
            row = cur.fetchone()
            return row


# ---- Redis -----------------------------------------------------------------

_r: redis.Redis | None = None


def get_redis() -> redis.Redis:
    global _r
    if _r is None:
        _r = redis.Redis(
            host=os.getenv("REDIS_HOST", "localhost"),
            port=int(os.getenv("REDIS_PORT", "6379")),
            password=os.getenv("REDIS_PASSWORD") or None,
            decode_responses=True,
        )
    return _r


def cache_get_json(key: str):
    try:
        raw = get_redis().get(key)
        return json.loads(raw) if raw else None
    except Exception:
        return None


def cache_set_json(key: str, value, ttl_seconds: int = 300) -> None:
    try:
        get_redis().set(key, json.dumps(value, default=str), ex=ttl_seconds)
    except Exception:
        pass
