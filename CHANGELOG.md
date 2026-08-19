# Changelog

All notable changes to the Wallbox BLE Gateway HA Add-on.

Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.53.0] - 2026-08-19

### Changed
- **Redesigned Charge Assistant config page** — a guided layout with a sticky
  jump-nav rail (mobile chip bar), scroll-spy highlighting, and empty cards
  collapsed by default so each mode opens compact. No settings changed.
- **Consistent look across every page** — Dashboard, Sessions, OTA and the
  Charge Assistant now share one design system.
- **Matches your Home Assistant theme.** Inside HA the add-on adopts your
  active theme (accent, background, cards, text). A **Themed / Plain** header
  toggle switches back to the add-on's own dark look, remembered per browser.
- **Tidier dashboard** — the "Manual control only" status now sits in the top
  nav row (full text on hover) instead of a full-width banner.

### Fixed
- Page styles no longer go stale after an add-on update (assets are
  cache-busted on rebuild).
- Header controls are grouped on the right and the gateway IP no longer
  collides with the title.

## [0.52.0] - 2026-08-16

### Added
- **Feed-in / export tariff.** The tariff editor now has a "Feed-in / export
  rate" field. Solar self-consumed for charging is valued *net* of this rate —
  the export income you gave up by charging instead of exporting — so the solar
  savings figure reflects the real benefit. Defaults to 0 (solar valued at the
  full avoided-grid rate, unchanged). Works for flat and time-of-use tariffs.

### Changed
- **Savings now flow to Home Assistant.** The savings baseline you pick on the
  dashboard is mirrored to the integration alongside the tariff, so the new HA
  savings sensors (Charging savings 7-day/month, Solar savings, Off-peak
  savings — integration v0.33.0) compare against the same counterfactual the
  add-on shows. Requires integration v0.33.0+.

## [0.45.0] - 2026-07-05

### Added

- **Charge Assistant · native Eco-Smart controls** (Solar and Smart + Solar
  modes) — matching two new integration options:
  - **"Use the charger's built-in Eco-Smart when available"** (default on):
    when the charger has a native Full Green / Eco Smart solar feature, let it
    follow the sun itself instead of Home Assistant driving start/stop. Turn
    off to force HA emulation (HA modulates charge current to follow surplus).
  - **"When the assistant finishes, return the charger to"** — hand back to a
    native mode after a managed charge ends: *Leave as set* (default),
    *Full Green*, *Eco Smart*, or *Disabled*.

## [0.21.0] - 2026-06-20

The cost-accuracy + charge-log release. The Add-on now bills charging
at the rate and the time it actually happened, and visualises where the
energy came from.

### Added

- **Schedule editor** (create / edit / delete native charger schedules),
  **charger notifications bar**, **weekly schedule timeline**, and a
  **Sessions page** (totals, day×hour energy heatmap, recent list, CSV).
- **HA-style Energy-flow card** — Solar + Grid → Vehicle with per-source
  kWh from the gateway's `r_lse` feed and animated flows when charging.
- **⚡ Charging-now banner** and a **control-owner banner** (who's driving
  charging; native schedules paused under external control).
- **Time-of-use tariff editor** with named rate bands, tap-to-paint
  weekday/weekend hours, NEM seasonal rates, and per-band cost breakdown.
- **Dashboard cost tiles** (week / month) — computed once on the Sessions
  page and mirrored to the dashboard; **next scheduled charge in the nav
  bar**; **last-charge-burst** readout (parity with the HA entities).

### Changed / Fixed

- **Schedule-aware, time-accurate cost.** Energy is now billed in the
  *real* charge window (the gateway firmware records each `cp>0` burst),
  not at plug-in time — so an overnight off-peak charge is no longer
  billed at the evening peak rate. Per-burst solar/grid split is honoured.
- **Solar is free** — only the grid portion of each charge is billed;
  shows the dollar value solar saved.
- **Tariff effective-dates** — changing your rates no longer rewrites the
  past; each session keeps the rate that was in effect when it happened.
- **Cheapest-band fallback** — unpainted tariff hours default to the
  cheapest band, never silently the most expensive.
- **Missing-sessions fix** — gap-fill + retry loader; weekly/monthly
  totals now match the official app.

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
- **Schedule-paused banner with inline Resume button** — amber
  warning between the hero card and the controls when the charger
  is in manual override (`r_dat.gen != 0`). Mirrors the Wallbox
  app's "Schedule & Solar charging paused" label. Independent of
  charging state: stays visible if you Start charging without
  resuming. The inline Resume button calls the gateway's new
  `/api/command?action=resume` (proxied through the Add-on with
  `resume` added to the action whitelist), which sends
  `s_cmode {"mode":0}` and clears the override.

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
