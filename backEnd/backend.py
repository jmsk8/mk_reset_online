from __future__ import annotations

import logging

from flask import Flask

# Configure logging before any module import
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = Flask(__name__)

# Register blueprints
from routes_public import public_bp  # noqa: E402
from routes_admin import admin_bp  # noqa: E402

app.register_blueprint(public_bp)
app.register_blueprint(admin_bp)

# Re-export for Dockerfile CMD compatibility
from services import sync_sequences, recalculate_tiers  # noqa: E402, F401

if __name__ == '__main__':
    try:
        sync_sequences()
        recalculate_tiers()
    except Exception as e:
        logger.error(f"Erreur initialisation: {e}")
    app.run(host='0.0.0.0', port=8080)
