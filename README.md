<p align="center">
  <img src="branding/logo.png" alt="Wallbox Gateway" width="600">
</p>

# Wallbox BLE Gateway HA Add-on

Home Assistant Add-on for managing the
[ESP32 Wallbox BLE Gateway](https://github.com/botts7/esp32-wallbox).

## What it does

Adds a sidebar panel to Home Assistant for the gateway: live
charging state, controls (Start / Stop / Lock / Unlock / Max
current), connection health for BLE / WiFi / MQTT, and a
drag-and-drop OTA firmware upload. Same dark theme as the
gateway's own `/dashboard` — they're meant to feel like one
product.

The Add-on doesn't replace the MQTT discovery the gateway
already publishes — entities you've already set up keep working
as before. This is for HAOS / HA Supervised users who want a
sidebar panel for the gateway without leaving Home Assistant.

Roadmap:

- **v0.1.0** — read-only dashboard (status + health + diagnostics)
- **v0.2.0** — OTA firmware upload from inside HA
- **v0.3.0** — Supervisor ingress URL fix · redesigned dashboard
  (dark theme · hero card · stats grid) · controls (Start / Stop /
  Lock / Unlock / Max current) · power-meter values (mains V,
  house W)
- **v0.4.0** — recent-events sparkline + boot history surface
- **v0.5.0** — schedule editor (mirror of the gateway's
  `/settings` schedule UI)
- **v1.0.0** — submit to community-hassio-addons for upstream
  store listing

## Installation

1. In Home Assistant, go to **Settings → Add-ons → Add-on Store**.
2. Open the three-dot menu (⋮) and choose **Repositories**.
3. Paste this repo's URL:
   ```
   https://github.com/botts7/wallbox-gateway-ha-addon
   ```
4. Reload the store and install **Wallbox BLE Gateway Manager**.
5. Open the Add-on's **Configuration** tab, set:
   - `gateway_ip` — local IP of the gateway (e.g. `192.168.1.42`)
   - `gateway_auth_user` / `gateway_auth_pass` — gateway web auth,
     if you enabled it. Leave blank if the gateway is open.
6. Start the Add-on. A "Wallbox Gateway" entry appears in the
   sidebar.

## Compatibility

- Home Assistant OS or HA Supervised. Add-ons don't run on the
  HA Container or Core installs.
- Gateway firmware **v3.0.0 or newer** (`/api/health` and the
  diagnostic endpoints landed in 3.0).

## Layout

```
wallbox-gateway-ha-addon/
├── repository.yaml          ← tells HA this is an Add-on repo
├── README.md
└── wallbox-gateway/         ← the Add-on
    ├── config.yaml          ← name, version, options, ingress
    ├── build.yaml           ← multi-arch base images
    ├── Dockerfile
    ├── rootfs/              ← copied into the image
    │   └── etc/services.d/wallbox/run
    └── app/                 ← Flask service
        ├── server.py
        ├── proxy.py
        ├── templates/
        └── static/
```

## Why Flask, not FastAPI

See the planning doc upstream — short version: 2026 Starlette
CVEs made FastAPI's dependency tree higher-churn than Flask's,
and our workload is small request/response with no async benefit.
