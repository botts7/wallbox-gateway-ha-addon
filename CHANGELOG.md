# Changelog

All notable changes to the Wallbox BLE Gateway HA Add-on.

Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.3.0] - 2026-06-08

The control + dashboard-redesign release. v0.1 was read-only, v0.2
added OTA, this brings the Add-on to feature parity with the
gateway's own `/dashboard` for the common control surface.

### Added

- **Charger controls** — Start / Stop / Lock / Unlock buttons plus
  a 6 - 32 A max-current slider. All wired through a new
  `/api/command` proxy on the Add-on that whitelists actions
  (`{start, stop, lock, unlock, current, reboot}`) and forwards
  to the gateway's `/api/command`. Auth headers from the Add-on
  options ride along on the upstream request automatically.
- **Power-meter values in the dashboard** — Mains voltage and
  House power tiles backed by a new `/api/meter` proxy route
  that forwards the BAPI `r_dca` call. Same data the integration
  uses for those sensors.
- **Dashboard redesigned to match the gateway's dark theme.**
  Hero card with charging-state pill, big tabular-nums kW value,
  and charger name. 4-tile stats grid below (Session kWh / Mains V
  / House W / Max curr A). Connections card with status dots for
  BLE / WiFi / MQTT (green/warning/red, SSID + RSSI inline). Same
  palette and card shapes as the firmware's `/dashboard` so the
  surfaces feel like one product.
- **State-aware status mapping** — full 0..18 charger status code
  -> English label table mirrored from the firmware's
  `STATUS_CODES`. Hero status pill colour shifts: green for
  charging/complete/discharging, red for error/MID-exceeded/
  OCPP-unavailable, neutral for the rest.

### Fixed

- **Supervisor ingress URL handling.** The previous build used
  Flask's `url_for('static', filename=...)` (absolute paths) and
  `/api/...` fetch URLs, both of which routed to HA Core's domain
  root under ingress instead of the Add-on. Net effect: CSS never
  loaded (page rendered with default serif), and live values
  never populated (every span stayed at `--`). Every absolute URL
  in templates and JS replaced with a relative path. Flask route
  definitions unchanged — only client-side URL construction.

### Changed

- Add-on `config.yaml` version bumped to `0.3.0`. No new options
  required; existing `gateway_ip` / `gateway_auth_user` /
  `gateway_auth_pass` are reused for the new control + meter
  proxy routes.

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
