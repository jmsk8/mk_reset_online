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

# ThreadedConnectionPool, et non SimpleConnectionPool : depuis le 2026-09-17 les
# workers gunicorn sont threadés, et `SimpleConnectionPool` ne pose AUCUN verrou.
# Deux threads qui empruntent une connexion au même instant peuvent recevoir la
# même, et deux curseurs sur une seule connexion produisent des pannes qu'on ne
# sait pas relire : résultats mélangés entre requêtes, transaction validée par
# l'autre thread, « connection already closed » aléatoire.
#
# Même interface (`getconn`/`putconn`), même dimensionnement : seul le verrou
# interne change. Ne JAMAIS revenir à Simple sans repasser les workers en sync.
#
# 20 connexions pour 2 workers x 8 threads = 16 emprunteurs possibles, plus une
# marge pour les tâches d'amorçage. Postgres en accepte 100 par défaut : la
# borne haute doit rester sous ce plafond, workers compris.
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
