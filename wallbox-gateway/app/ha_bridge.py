"""Home Assistant Core API bridge for the Add-on backend.

The Add-on *frontend* (browser, behind ingress) cannot reach
`http://supervisor/core/api` — only the backend can, using the
`SUPERVISOR_TOKEN` the Supervisor injects when `homeassistant_api: true`
is granted. This module isolates that Core-API I/O so the Flask routes
stay thin and the behaviour is testable in isolation (mirrors how
`proxy.py` isolates the gateway I/O).

It exposes exactly what the Charge Assistant config GUI needs:
  * list_states()  — entities for the pickers + live preview
  * get_config()   — read the integration's current options (pre-fill)
  * set_config()   — write a partial options object back (+ reload)

The SUPERVISOR_TOKEN is held here only and is NEVER returned to the
browser. The Core base URL is overridable for local dev / tests.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from typing import Any

import requests

# Domains the Charge Assistant pickers care about. Keeps the /states
# payload small and the picker lists relevant (SOC, presence, price,
# surplus power, helpers) instead of dumping every entity in HA.
_PICKER_DOMAINS = (
    "sensor",
    "binary_sensor",
    "device_tracker",
    "person",
    "input_number",
    "input_boolean",
    "input_select",
    "number",
    "switch",
)

_INTEGRATION_DOMAIN = "wallbox_gateway"

# Attribute names that signal a price entity carries a usable forecast (mirrors
# the integration's price_planner; cheapest-window needs one of these).
_FORECAST_ATTRS = (
    "raw_today", "raw_tomorrow", "forecast", "forecasts",
    "prices", "today", "tomorrow",
)


@dataclass(frozen=True)
class CoreConfig:
    base_url: str
    token: str

    @property
    def available(self) -> bool:
        return bool(self.token)


class CoreUnavailable(Exception):
    """Raised when the Supervisor token / Core API isn't available."""


class CoreError(Exception):
    """Raised when the Core API returns an error response."""


def config_from_env() -> CoreConfig:
    # SUPERVISOR_TOKEN is injected by the Supervisor for add-ons granted
    # homeassistant_api. WB_HA_BASE_URL lets local dev point at a real
    # HA (e.g. http://homeassistant.local:8123/api) with a long-lived
    # token in WB_HA_TOKEN.
    base = os.environ.get("WB_HA_BASE_URL", "").strip()
    token = os.environ.get("WB_HA_TOKEN", "").strip()
    if not base:
        base = "http://supervisor/core/api"
    if not token:
        token = os.environ.get("SUPERVISOR_TOKEN", "").strip()
    return CoreConfig(base_url=base.rstrip("/"), token=token)


def _headers(cfg: CoreConfig) -> dict[str, str]:
    return {
        "Authorization": f"Bearer {cfg.token}",
        "Content-Type": "application/json",
    }


def _ensure(cfg: CoreConfig) -> None:
    if not cfg.available:
        raise CoreUnavailable(
            "SUPERVISOR_TOKEN not set — is homeassistant_api granted?"
        )


def list_states(cfg: CoreConfig, timeout: float = 8.0) -> list[dict[str, Any]]:
    """Return entities in the picker-relevant domains.

    Each item is trimmed to what the GUI needs: entity_id, state,
    friendly_name, unit, device_class — not the full attribute blob.
    """
    _ensure(cfg)
    try:
        r = requests.get(
            f"{cfg.base_url}/states",
            headers=_headers(cfg),
            timeout=timeout,
        )
    except requests.RequestException as e:
        raise CoreUnavailable(str(e)) from e
    r.raise_for_status()
    out: list[dict[str, Any]] = []
    for s in r.json():
        eid = s.get("entity_id", "")
        domain = eid.split(".", 1)[0] if "." in eid else ""
        if domain not in _PICKER_DOMAINS:
            continue
        attrs = s.get("attributes") or {}
        has_forecast = any(
            isinstance(attrs.get(k), list) and attrs.get(k) for k in _FORECAST_ATTRS
        )
        out.append({
            "entity_id": eid,
            "state": s.get("state"),
            "name": attrs.get("friendly_name", eid),
            "unit": attrs.get("unit_of_measurement"),
            "device_class": attrs.get("device_class"),
            "domain": domain,
            "has_forecast": has_forecast,
        })
    out.sort(key=lambda e: (e["domain"], e["name"].lower()))
    return out


def list_notify_services(cfg: CoreConfig, timeout: float = 8.0) -> list[str]:
    """Return the user's `notify.*` services for the notify-target picker."""
    _ensure(cfg)
    try:
        r = requests.get(f"{cfg.base_url}/services", headers=_headers(cfg), timeout=timeout)
    except requests.RequestException as e:
        raise CoreUnavailable(str(e)) from e
    r.raise_for_status()
    out: list[str] = []
    for d in r.json():
        if d.get("domain") == "notify":
            for name in (d.get("services") or {}):
                out.append(f"notify.{name}")
    out.sort()
    return out


def _ws_url(cfg: CoreConfig) -> str:
    """Derive the Core WebSocket URL from the REST base_url.
    http://supervisor/core/api -> ws://supervisor/core/websocket
    http://host:8123/api       -> ws://host:8123/api/websocket"""
    u = cfg.base_url
    scheme = "wss" if u.startswith("https") else "ws"
    host_path = u.split("://", 1)[-1]
    if host_path.endswith("/core/api"):
        host_path = host_path[: -len("/core/api")] + "/core/websocket"
    elif host_path.endswith("/api"):
        host_path = host_path[: -len("/api")] + "/api/websocket"
    else:
        host_path = host_path.rstrip("/") + "/api/websocket"
    return f"{scheme}://{host_path}"


def _lovelace_paths(dashboards: list[dict], configs: dict) -> list[str]:
    """Pure: build dashboard/view paths from the dashboards list + each
    dashboard's lovelace config. ``configs`` is keyed by url_path (None = the
    default 'Overview' dashboard). Returns de-duplicated, order-preserving."""
    urls = [None] + [d.get("url_path") for d in (dashboards or []) if d.get("url_path")]
    out: list[str] = []
    for url in urls:
        root = "/lovelace" if not url else f"/{url}"
        out.append(root)
        for idx, v in enumerate(((configs.get(url) or {}).get("views")) or []):
            vp = v.get("path") or idx
            out.append(f"{root}/{vp}")
    seen, res = set(), []
    for p in out:
        if p not in seen:
            seen.add(p)
            res.append(p)
    return res


def list_pages(cfg: CoreConfig, timeout: float = 6.0) -> list[str]:
    """Lovelace dashboard + view paths via the WS API (there's no REST
    equivalent). Best-effort: any failure (missing websocket-client, auth, a
    YAML/auto dashboard that won't serve its config) returns [] / partial, and
    the GUI just falls back to free-text."""
    if not cfg.available:
        return []
    try:
        import websocket  # websocket-client; lazy so a missing dep degrades gracefully
    except Exception:
        return []

    def _recv() -> dict:
        return json.loads(ws.recv())

    try:
        ws = websocket.create_connection(_ws_url(cfg), timeout=timeout)
    except Exception:
        return []
    try:
        if _recv().get("type") != "auth_required":
            return []
        ws.send(json.dumps({"type": "auth", "access_token": cfg.token}))
        if _recv().get("type") != "auth_ok":
            return []
        ws.send(json.dumps({"id": 1, "type": "lovelace/dashboards/list"}))
        msg = _recv()
        dashboards = msg.get("result") or [] if msg.get("success") else []
        configs: dict = {}
        i = 2
        for url in [None] + [d.get("url_path") for d in dashboards if d.get("url_path")]:
            ws.send(json.dumps({"id": i, "type": "lovelace/config", "url_path": url}))
            r = _recv()
            if r.get("success"):
                configs[url] = r.get("result") or {}
            i += 1
        return _lovelace_paths(dashboards, configs)
    except Exception:
        return []
    finally:
        try:
            ws.close()
        except Exception:
            pass


def get_config(
    cfg: CoreConfig, host: str | None = None, timeout: float = 8.0
) -> dict[str, Any]:
    """Call wallbox_gateway.get_config and return its response data."""
    _ensure(cfg)
    body: dict[str, Any] = {}
    if host:
        body["host"] = host
    try:
        r = requests.post(
            f"{cfg.base_url}/services/{_INTEGRATION_DOMAIN}/get_config"
            "?return_response",
            headers=_headers(cfg),
            json=body,
            timeout=timeout,
        )
    except requests.RequestException as e:
        raise CoreUnavailable(str(e)) from e
    if r.status_code >= 400:
        raise CoreError(f"get_config HTTP {r.status_code}: {r.text[:200]}")
    data = r.json()
    # HA wraps service-response data as {"service_response": {...}} (or
    # {"changed_states": [], "service_response": {...}}). Unwrap it.
    if isinstance(data, dict) and "service_response" in data:
        return data["service_response"] or {}
    return data if isinstance(data, dict) else {}


def set_config(
    cfg: CoreConfig,
    options: dict[str, Any],
    host: str | None = None,
    timeout: float = 10.0,
) -> None:
    """Call wallbox_gateway.set_config to merge options + reload."""
    _ensure(cfg)
    body: dict[str, Any] = {"options": options}
    if host:
        body["host"] = host
    try:
        r = requests.post(
            f"{cfg.base_url}/services/{_INTEGRATION_DOMAIN}/set_config",
            headers=_headers(cfg),
            json=body,
            timeout=timeout,
        )
    except requests.RequestException as e:
        raise CoreUnavailable(str(e)) from e
    if r.status_code >= 400:
        raise CoreError(f"set_config HTTP {r.status_code}: {r.text[:200]}")


def call_test_reminder(cfg: CoreConfig, timeout: float = 10.0) -> None:
    """Fire wallbox_gateway.test_reminder (sends the reminder notification now,
    using the saved config) so the user can verify their notify + message."""
    _ensure(cfg)
    try:
        r = requests.post(
            f"{cfg.base_url}/services/{_INTEGRATION_DOMAIN}/test_reminder",
            headers=_headers(cfg),
            json={},
            timeout=timeout,
        )
    except requests.RequestException as e:
        raise CoreUnavailable(str(e)) from e
    if r.status_code >= 400:
        raise CoreError(f"test_reminder HTTP {r.status_code}: {r.text[:200]}")
