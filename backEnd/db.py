from __future__ import annotations

import os
import sys
import logging
from contextlib import contextmanager

import psycopg2
from psycopg2 import pool

logger = logging.getLogger(__name__)

try:
    POSTGRES_DB = os.environ['POSTGRES_DB']
    POSTGRES_USER = os.environ['POSTGRES_USER']
    POSTGRES_PASSWORD = os.environ.get('POSTGRES_PASSWORD', '')
    POSTGRES_HOST = os.environ.get('POSTGRES_HOST', '')
    POSTGRES_PORT = os.environ.get('POSTGRES_PORT', '5432')
except KeyError:
    sys.exit(1)

# Pool threadé : les workers gunicorn utilisent plusieurs threads (2 x 4).
# La borne haute doit rester au-dessus de ce produit et sous la limite de Postgres.
try:
    db_pool = pool.ThreadedConnectionPool(
        1, 20,
        user=POSTGRES_USER,
        password=POSTGRES_PASSWORD,
        host=POSTGRES_HOST,
        port=POSTGRES_PORT,
        database=POSTGRES_DB
    )
except (Exception, psycopg2.DatabaseError):
    sys.exit(1)


@contextmanager
def get_db_connection():
    conn = db_pool.getconn()
    try:
        yield conn
    finally:
        db_pool.putconn(conn)
