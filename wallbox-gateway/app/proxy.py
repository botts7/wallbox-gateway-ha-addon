"""Thin HTTP forwarder to the ESP32 gateway.

The Add-on never owns gateway state — it just forwards `/api/*`
reads to the configured gateway IP and surfaces the JSON in a
Home Assistant ingress-friendly UI. This module isolates the
gateway HTTP I/O from the Flask route layer so the routes stay
small and the network behaviour is testable in isolation.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass

import requests


@dataclass(frozen=True)
class GatewayConfig:
    ip: str
    auth_user: str
    auth_pass: str
    name: str = ""

    @property
    def configured(self) -> bool:
        return bool(self.ip)

    def url(self, path: str) -> str:
        return f"http://{self.ip}{path}"


def config_from_env() -> GatewayConfig:
    return GatewayConfig(
        ip=os.environ.get("WB_GATEWAY_IP", "").strip(),
        auth_user=os.environ.get("WB_AUTH_USER", "admin"),
        auth_pass=os.environ.get("WB_AUTH_PASS", ""),
        name=os.environ.get("WB_GATEWAY_NAME", "").strip(),
    )


# Supervisor writes the full add-on options here; it's the clean way to carry the
# multi-gateway list (env vars only carry the legacy single gateway).
_OPTIONS_PATH = "/data/options.json"
_gateways_cache: list[GatewayConfig] | None = None


def _load_gateways() -> list[GatewayConfig]:
    """The configured gateways. Prefers the `gateways` list from add-on options;
    falls back to the legacy single `gateway_ip` (env) so existing installs are
    unaffected. Always returns at least one entry (possibly unconfigured)."""
    try:
        with open(_OPTIONS_PATH, encoding="utf-8") as fh:
            gws = (json.load(fh) or {}).get("gateways")
        if isinstance(gws, list) and gws:
            out = [
                GatewayConfig(
                    ip=str(g.get("ip", "")).strip(),
                    auth_user=str(g.get("auth_user") or "admin"),
                    auth_pass=str(g.get("auth_pass") or ""),
                    name=str(g.get("name") or f"Gateway {i + 1}"),
                )
                for i, g in enumerate(gws)
                if str(g.get("ip", "")).strip()
            ]
            if out:
                return out
    except (OSError, ValueError):
        pass
    legacy = config_from_env()
    return [GatewayConfig(legacy.ip, legacy.auth_user, legacy.auth_pass,
                          legacy.name or "Gateway")]


def gateways() -> list[GatewayConfig]:
    """Cached gateway list (rebuilt on process restart, i.e. after any options
    change — Supervisor restarts the add-on when its config changes)."""
    global _gateways_cache
    if _gateways_cache is None:
        _gateways_cache = _load_gateways()
    return _gateways_cache


def config_for(gw) -> GatewayConfig:
    """The gateway selected by the `?gw=<index>` request param (default 0)."""
    gws = gateways()
    try:
        idx = int(gw)
    except (TypeError, ValueError):
        idx = 0
    return gws[idx] if 0 <= idx < len(gws) else gws[0]


class GatewayUnreachable(Exception):
    """Raised when the gateway can't be contacted."""


class GatewayNotConfigured(Exception):
    """Raised when the Add-on options didn't supply a gateway IP."""


def fetch_json(cfg: GatewayConfig, path: str, timeout: float = 5.0) -> dict:
    if not cfg.configured:
        raise GatewayNotConfigured("gateway_ip not set in Add-on options")
    try:
        r = requests.get(
            cfg.url(path),
            auth=(cfg.auth_user, cfg.auth_pass) if cfg.auth_pass else None,
            timeout=timeout,
        )
    except requests.RequestException as e:
        raise GatewayUnreachable(str(e)) from e
    r.raise_for_status()
    return r.json()


def post_form(cfg: GatewayConfig, path: str, data: dict, timeout: float = 8.0) -> dict:
    """POST form-encoded data to a gateway endpoint (e.g. /api/control_owner).
    The gateway's auth-only API endpoints read form/query args via http.arg()."""
    if not cfg.configured:
        raise GatewayNotConfigured("gateway_ip not set in Add-on options")
    try:
        r = requests.post(
            cfg.url(path),
            data=data or {},
            auth=(cfg.auth_user, cfg.auth_pass) if cfg.auth_pass else None,
            timeout=timeout,
        )
    except requests.RequestException as e:
        raise GatewayUnreachable(str(e)) from e
    r.raise_for_status()
    return r.json()
