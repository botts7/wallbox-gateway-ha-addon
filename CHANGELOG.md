# Changelog

All notable changes to the Wallbox BLE Gateway HA Add-on.

Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.2.0] - 2026-06-07

The OTA-upload release. Drop a firmware.bin onto the dashboard, the
Add-on streams it to the gateway with end-to-end MD5 verification,
the gateway reboots cleanly. No more `pio run -t upload` from a
developer machine just to update a deployed gateway.

### Added

- **`/ota` page** — drag-and-drop firmware upload zone, file picker,
  XHR-driven progress bar (fetch can't surface upload progress), and a
  what-happens-during-OTA explainer panel.
- **`/api/ota/upload`** Flask endpoint — receives the multipart upload,
  streams to a tempfile while hashing MD5, validates the ESP32 image
  magic byte (`0xE9`), then POSTs to the gateway's `/api/ota` with the
  `X-Firmware-MD5` header. Tempfile is cleaned up in `finally:`.
- Clear surfaced errors: `no_file` (400), `invalid_image` (400),
  `unreachable` (504), `gateway_error` (502 with the gateway's
  response body).

### Changed

- Add-on `config.yaml` version bumped to `0.2.0`. No new options
  required; existing `gateway_ip` / `gateway_auth_user` /
  `gateway_auth_password` are reused for the OTA POST.

## [0.1.0] - 2026-06-07

First release. Read-only dashboard panel surfaced via HA Supervisor
ingress — open the Add-on sidebar entry and see live charger status,
diagnostics, and health without leaving HA.

### Added

- HA Add-on packaging: `repository.yaml`, `config.yaml`, `build.yaml`,
  `Dockerfile` (amd64 + aarch64 base images), s6-overlay services.d
  entrypoint, bashio config loader.
- Flask app behind the Supervisor ingress proxy. Pulls
  `/api/status`, `/api/charger`, `/api/diag/disconnects`,
  `/api/health` from the configured gateway IP and renders a
  read-only dashboard.
- Add-on options: `gateway_ip`, `gateway_auth_user`,
  `gateway_auth_password`, `poll_interval_seconds`.
- Sidebar entry titled **Wallbox Gateway** with the
  `mdi:ev-station` icon.
