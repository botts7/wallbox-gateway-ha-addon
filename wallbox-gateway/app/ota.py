"""OTA upload to the gateway.

Receives a firmware.bin via the Flask request, computes its MD5
(end-to-end integrity check — the gateway's Update.setMD5 verifies
this and refuses to commit if the partition hash doesn't match),
and POSTs it to the gateway's /api/ota endpoint as multipart.

We use a temp file rather than buffering the full image in memory.
Firmware images are ~1.3 MB today which would fit in RAM, but the
temp-file path scales cleanly to whatever future builds grow to
and matches how the gateway's own /api/ota expects the upload.
"""

from __future__ import annotations

import hashlib
import logging
import os
import tempfile
from dataclasses import dataclass

import requests

from proxy import GatewayConfig, GatewayUnreachable, GatewayNotConfigured


log = logging.getLogger("wallbox-addon.ota")

# Read in 64 KiB chunks. The gateway's async OTA handler is
# happy with whatever chunk size lands; this is just our local
# memory ceiling while computing MD5 and streaming to disk.
CHUNK = 64 * 1024


@dataclass
class OtaResult:
    status: int
    body: str
    md5: str
    bytes_sent: int


def save_to_tempfile(reader) -> tuple[str, str, int]:
    """Stream the request body to a temp file, computing MD5 on the
    way through. Returns (path, md5_hex, byte_count). Caller is
    responsible for unlinking the path."""
    h = hashlib.md5()
    total = 0
    fd, path = tempfile.mkstemp(prefix="wb_ota_", suffix=".bin")
    try:
        with os.fdopen(fd, "wb") as out:
            while True:
                chunk = reader.read(CHUNK)
                if not chunk:
                    break
                h.update(chunk)
                out.write(chunk)
                total += len(chunk)
    except Exception:
        try:
            os.unlink(path)
        except OSError:
            pass
        raise
    return path, h.hexdigest(), total


def forward_to_gateway(
    cfg: GatewayConfig,
    file_path: str,
    md5_hex: str,
    filename: str = "firmware.bin",
    timeout: float = 180.0,
) -> OtaResult:
    if not cfg.configured:
        raise GatewayNotConfigured("gateway_ip not set in Add-on options")
    url = cfg.url("/api/ota")
    headers = {"X-Firmware-MD5": md5_hex}
    log.info("OTA forward → %s (md5=%s)", url, md5_hex)
    try:
        with open(file_path, "rb") as f:
            r = requests.post(
                url,
                files={"firmware": (filename, f, "application/octet-stream")},
                headers=headers,
                auth=(cfg.auth_user, cfg.auth_pass) if cfg.auth_pass else None,
                timeout=timeout,
            )
    except requests.RequestException as e:
        raise GatewayUnreachable(str(e)) from e
    bytes_sent = os.path.getsize(file_path)
    return OtaResult(
        status=r.status_code,
        body=r.text,
        md5=md5_hex,
        bytes_sent=bytes_sent,
    )


def cleanup(path: str) -> None:
    try:
        os.unlink(path)
    except OSError:
        log.warning("failed to unlink temp OTA file %s", path)


def validate_firmware_image(path: str) -> tuple[bool, str]:
    """Cheap pre-flight: reject anything that isn't an ESP32 image
    before we burn TCP bandwidth uploading it. The gateway re-checks
    the magic byte too, but failing fast here gives the user a
    useful error in seconds instead of after a 90 s upload.

    ESP32 firmware images start with 0xE9 (ESP_IMAGE_HEADER_MAGIC).
    """
    try:
        with open(path, "rb") as f:
            first = f.read(1)
    except OSError as e:
        return False, f"unreadable: {e}"
    if not first:
        return False, "empty upload"
    if first[0] != 0xE9:
        return False, (
            f"not an ESP32 image (first byte 0x{first[0]:02x}, "
            "expected 0xE9)"
        )
    return True, ""
