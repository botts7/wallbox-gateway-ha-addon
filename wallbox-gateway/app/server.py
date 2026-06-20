"""Flask entrypoint for the Wallbox BLE Gateway HA Add-on.

v0.2 scope: read-only dashboard (v0.1) PLUS firmware OTA upload
proxy. User drops a firmware.bin onto the OTA page, the Add-on
streams it to the gateway's /api/ota with the MD5 attached for
end-to-end integrity verification.

Run via the s6 service in rootfs/etc/services.d/wallbox/run.
For local dev: WB_GATEWAY_IP=... python3 server.py
"""

from __future__ import annotations

import logging
from typing import Tuple

from flask import Flask, jsonify, render_template, request
from requests import HTTPError

from proxy import (
    GatewayNotConfigured,
    GatewayUnreachable,
    config_from_env,
    fetch_json,
)
import ota


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


@app.route("/ota")
def ota_page():
    return render_template("ota.html")


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


@app.route("/api/meter")
def api_meter():
    """Proxy the BAPI `r_dca` realtime power-meter call through the
    gateway's /api/command endpoint. Surfaces v1 (L1 voltage) and
    p1+p2+p3 (total house power) for the Add-on dashboard's Mains /
    House stats. Best-effort: a BLE-busy gateway will return null
    fields, which the dashboard renders as `--`.
    """
    cfg = config_from_env()
    try:
        return jsonify(fetch_json(
            cfg,
            "/api/command?action=bapi&met=r_dca&par=null&wait=2000",
        ))
    except Exception as e:
        body, code = _gateway_error(e)
        return jsonify(body), code


# Whitelist of control actions we allow through the proxy. Limiting
# the surface here means the Add-on never accidentally forwards a
# malformed or unsafe query string from the browser (anything else
# returns 400). The gateway's /api/command handler does its own
# validation too — this is belt-and-braces.
_ALLOWED_ACTIONS = {"start", "stop", "resume", "lock", "unlock", "current", "reboot"}


@app.route("/api/command")
def api_command():
    """Proxy charger control commands to the gateway's /api/command.

    Used by the dashboard's Controls section for Start / Stop /
    Lock / Unlock / Max current / Reboot. Action whitelist enforced;
    extra query params (like &value= for current) are forwarded.
    """
    cfg = config_from_env()
    action = (request.args.get("action") or "").strip().lower()
    if action not in _ALLOWED_ACTIONS:
        return jsonify({
            "error": "bad_action",
            "detail": f"action '{action}' not allowed",
            "allowed": sorted(_ALLOWED_ACTIONS),
        }), 400
    # Forward the entire query string — preserves &value=N for
    # the current setter and &wait=ms for fine-tuning timeouts.
    qs = request.query_string.decode("utf-8")
    path = "/api/command" + (("?" + qs) if qs else "")
    try:
        return jsonify(fetch_json(cfg, path, timeout=8.0))
    except Exception as e:
        body, code = _gateway_error(e)
        return jsonify(body), code


# Schedule BAPI methods the dashboard's schedule editor may call. Reads
# (r_schs/r_sch) + writes (s_sch insert/update, clr_sch delete, w_sch for the
# original Pulsar). Whitelisted so the proxy never forwards an arbitrary met.
_ALLOWED_SCHED_METS = {"r_schs", "r_sch", "s_sch", "clr_sch", "w_sch"}


@app.route("/api/sched")
def api_sched():
    """Proxy schedule reads/writes to the gateway's BAPI passthrough.

    The browser builds the par (UTC HHMM start/stop, Mon-Sun days bit-array,
    etc — same shape the gateway's own dashboard sends) and we forward it,
    forcing action=bapi and validating the met against the whitelist.
    """
    cfg = config_from_env()
    met = (request.args.get("met") or "").strip()
    if met not in _ALLOWED_SCHED_METS:
        return jsonify({
            "error": "bad_met",
            "detail": f"met '{met}' not allowed",
            "allowed": sorted(_ALLOWED_SCHED_METS),
        }), 400
    qs = request.query_string.decode("utf-8")
    path = "/api/command?action=bapi&" + qs
    try:
        return jsonify(fetch_json(cfg, path, timeout=9.0))
    except Exception as e:
        body, code = _gateway_error(e)
        return jsonify(body), code


@app.route("/api/notifications")
def api_notifications():
    """Proxy the BAPI `r_not` call — active charger notifications/alerts.
    Best-effort: a BLE-busy gateway returns null/0, rendered as 'none'.
    """
    cfg = config_from_env()
    try:
        return jsonify(fetch_json(
            cfg,
            "/api/command?action=bapi&met=r_not&par=null&wait=4000",
            timeout=7.0,
        ))
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


@app.route("/api/ota/upload", methods=["POST"])
def api_ota_upload():
    """Receive firmware.bin from the browser, validate it's an
    ESP32 image, compute MD5 for end-to-end integrity, then forward
    as multipart/form-data to the gateway's /api/ota.

    The gateway responds 200 "OK" on a successful flash (and reboots
    ~1 s later — that 200 is what we forward back to the user). On
    rejection it returns 503+Retry-After (admission guard) or 500
    (truncation / bad magic / Update.end failure).
    """
    cfg = config_from_env()
    if not cfg.configured:
        return jsonify({
            "error": "not_configured",
            "detail": "gateway_ip not set in Add-on options",
        }), 503

    if "firmware" not in request.files:
        return jsonify({
            "error": "no_file",
            "detail": "missing 'firmware' form field",
        }), 400
    f = request.files["firmware"]
    if not f.filename:
        return jsonify({
            "error": "no_file",
            "detail": "empty filename",
        }), 400

    tmp_path = None
    try:
        tmp_path, md5_hex, byte_count = ota.save_to_tempfile(f.stream)
        ok, msg = ota.validate_firmware_image(tmp_path)
        if not ok:
            return jsonify({
                "error": "invalid_image",
                "detail": msg,
            }), 400
        log.info(
            "OTA: %d bytes md5=%s -> forwarding to %s",
            byte_count, md5_hex, cfg.ip,
        )
        result = ota.forward_to_gateway(
            cfg, tmp_path, md5_hex,
            f.filename or "firmware.bin",
        )
        return jsonify({
            "ok": result.status == 200,
            "status": result.status,
            "body": result.body,
            "md5": result.md5,
            "bytes": result.bytes_sent,
        }), result.status
    except GatewayNotConfigured as e:
        return jsonify({"error": "not_configured", "detail": str(e)}), 503
    except GatewayUnreachable as e:
        return jsonify({"error": "unreachable", "detail": str(e)}), 504
    except Exception as e:
        log.exception("OTA upload failed")
        return jsonify({
            "error": "internal",
            "detail": repr(e),
        }), 500
    finally:
        if tmp_path:
            ota.cleanup(tmp_path)


if __name__ == "__main__":
    # HA's ingress proxy hits us on 0.0.0.0:8099.
    app.run(host="0.0.0.0", port=8099, debug=False)
