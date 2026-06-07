"""Flask entrypoint for the Wallbox BLE Gateway HA Add-on.

v0.1 scope (locked in docs/plans/3.x-ha-addon.md): read-only
dashboard only. The Add-on talks to the configured gateway over
plain HTTP and proxies the four diagnostic endpoints that drive
the dashboard. No state mutation surface yet — OTA upload lands
in v0.2 once the Add-on plumbing has shaken out.

Run via the s6 service in rootfs/etc/services.d/wallbox/run.
For local dev: WB_GATEWAY_IP=... python3 server.py
"""

from __future__ import annotations

import logging
from typing import Tuple

from flask import Flask, jsonify, render_template
from requests import HTTPError

from proxy import (
    GatewayNotConfigured,
    GatewayUnreachable,
    config_from_env,
    fetch_json,
)


app = Flask(__name__)
logging.basicConfig(level=logging.INFO)
log = logging.getLogger("wallbox-addon")


def _gateway_error(exc: Exception) -> Tuple[dict, int]:
    if isinstance(exc, GatewayNotConfigured):
        return {"error": "not_configured", "detail": str(exc)}, 503
    if isinstance(exc, GatewayUnreachable):
        return {"error": "unreachable", "detail": str(exc)}, 504
    if isinstance(exc, HTTPError):
        return {"error": "upstream", "detail": str(exc)}, 502
    return {"error": "unknown", "detail": repr(exc)}, 500


@app.route("/")
def dashboard():
    return render_template("index.html")


@app.route("/api/health")
def api_health():
    cfg = config_from_env()
    try:
        return jsonify(fetch_json(cfg, "/api/health"))
    except Exception as e:
        body, code = _gateway_error(e)
        return jsonify(body), code


@app.route("/api/status")
def api_status():
    cfg = config_from_env()
    try:
        return jsonify(fetch_json(cfg, "/api/status"))
    except Exception as e:
        body, code = _gateway_error(e)
        return jsonify(body), code


@app.route("/api/charger")
def api_charger():
    cfg = config_from_env()
    try:
        return jsonify(fetch_json(cfg, "/api/charger"))
    except Exception as e:
        body, code = _gateway_error(e)
        return jsonify(body), code


@app.route("/api/diag/disconnects")
def api_diag_disconnects():
    cfg = config_from_env()
    try:
        return jsonify(fetch_json(cfg, "/api/diag/disconnects"))
    except Exception as e:
        body, code = _gateway_error(e)
        return jsonify(body), code


@app.route("/api/addon/config")
def api_addon_config():
    """Surface non-secret Add-on options so the SPA knows whether
    a gateway IP is configured. Auth password is never returned."""
    cfg = config_from_env()
    return jsonify({
        "configured": cfg.configured,
        "gateway_ip": cfg.ip,
        "auth_user": cfg.auth_user,
    })


if __name__ == "__main__":
    # HA's ingress proxy hits us on 0.0.0.0:8099.
    app.run(host="0.0.0.0", port=8099, debug=False)
