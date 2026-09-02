from __future__ import annotations

import logging

from flask import Flask

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = Flask(__name__)

from routes_public import public_bp  # noqa: E402
from routes_admin import admin_bp  # noqa: E402
from routes_auth import auth_bp  # noqa: E402
from routes_comptes import comptes_bp  # noqa: E402
from routes_bot import bot_bp  # noqa: E402

app.register_blueprint(public_bp)
app.register_blueprint(admin_bp)
app.register_blueprint(auth_bp)
app.register_blueprint(comptes_bp)
app.register_blueprint(bot_bp)

from services import sync_sequences, recalculate_tiers  # noqa: E402, F401

if __name__ == '__main__':
    try:
        sync_sequences()
        recalculate_tiers()
    except Exception as e:
        logger.error(f"Erreur initialisation: {e}")
    app.run(host='0.0.0.0', port=8080)
