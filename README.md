# Wallbox BLE Gateway HA Add-on

Home Assistant Add-on for managing the
[ESP32 Wallbox BLE Gateway](https://github.com/botts7/esp32-wallbox).

## What it does

Adds a sidebar panel to Home Assistant for read-only gateway
status, health, and connection diagnostics. The gateway itself
keeps publishing entities via MQTT discovery — this Add-on does
not replace that path.

Roadmap:

- **v0.1** — read-only dashboard (status + health + diagnostics)
- **v0.2** — OTA firmware upload from inside HA
- **v0.3** — recent-events sparkline + boot history surface

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
