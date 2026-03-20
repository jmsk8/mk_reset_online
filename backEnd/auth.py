from __future__ import annotations

import functools
from datetime import datetime

from flask import request, abort

from db import get_db_connection


def admin_required(f):
    @functools.wraps(f)
    def decorated_function(*args, **kwargs):
        token = request.headers.get('X-Admin-Token', None)
        if not token:
            abort(403)
        try:
            with get_db_connection() as conn:
                with conn.cursor() as cur:
                    cur.execute("SELECT expires_at FROM api_tokens WHERE token = %s", (token,))
                    res = cur.fetchone()
                    if not res:
                        abort(403)
                    expires_at = res[0]
                    if datetime.now() > expires_at:
                        cur.execute("DELETE FROM api_tokens WHERE token = %s", (token,))
                        conn.commit()
                        abort(403)
        except Exception:
            abort(500)
        return f(*args, **kwargs)
    return decorated_function
