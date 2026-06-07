"""Thin HTTP forwarder to the ESP32 gateway.

The Add-on never owns gateway state — it just forwards `/api/*`
reads to the configured gateway IP and surfaces the JSON in a
Home Assistant ingress-friendly UI. This module isolates the
gateway HTTP I/O from the Flask route layer so the routes stay
small and the network behaviour is testable in isolation.
"""

from __future__ import annotations

import os
from dataclasses import dataclass

import requests


@dataclass(frozen=True)
class GatewayConfig:
    ip: str
    auth_user: str
    auth_pass: str

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
    )


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
