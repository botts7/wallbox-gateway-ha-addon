# Changelog

All notable changes to the Wallbox BLE Gateway HA Add-on.

Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.46.0] - 2026-07-05

### Added
- **Customizable dashboard cards.** A new **⚙️ Cards** button (top-right of the
  dashboard) opens a panel to **show/hide** each card and **drag to reorder**
  them — Energy flow, Controls, Halo LED, Quick stats, Charging savings, Charge
  Assistant, Connections, Device info, Reconnect counters and Charge schedules.
  Your arrangement is saved in the browser (per device); **Reset to default**
  restores the original layout. Cards your charger doesn't provide (no meter,
  no Halo, integration not linked) are tagged *unavailable* and stay hidden
  until they're available. System alerts/banners are pinned above the deck.

## [0.45.0] - 2026-07-04

### Added
- **Solar-charging parity with the integration** on the Charge Assistant page:
  the *use native Eco-Smart* toggle and the *when a managed charge finishes*
  resume-mode select on the Solar / Smart + Solar steps.

## [0.44.0] - 2026-07-04

### Fixed
- **Weekly heatmap now matches the gateway's.** The add-on heatmap was built
  from the cached per-session list and mapped to charge-log intervals, so any
  interval whose session read had failed/returned 0 was dropped and the grid
  diverged from the gateway's. It now builds **directly from the firmware
  charge-log** — the same source and placement (each interval at its start over
  its duration, in the charger's timezone) the gateway's own `/sessions` heatmap
  uses — so the two are identical. Verified cell-for-cell against the charge-log.

## [0.43.0] - 2026-07-04

### Fixed
- **Sessions list showed 0.00 kWh per session and an empty heatmap** on some
  chargers, even though the totals were correct (mo-harry). The per-session
  energy came from the charger's `r_log` read, which returns `en:0` on some
  firmwares. The recent-session list, the weekly heatmap, and the CSV export now
  derive each session's energy from the firmware **charge-log** (the same
  ground-truth source the totals and the gateway's own `/sessions` page already
  use), mapped to the session by time — falling back to `r_log` only for
  sessions that predate charge-log capture. No change to already-correct chargers.

## [0.42.0] - 2026-07-03

### Added
- **Halo LED card** on the dashboard — a **Standby** toggle (dim the ring when
  idle) + a **Brightness** slider (0–100 %), for parity with the ESP web UI and
  the integration. Reads the charger's real config on load; writes are optimistic
  (the control updates instantly) with a bounded retry + backoff, and re-read to
  correct only if a write fails. Hidden automatically if the charger has no halo.
  New scoped `/api/halo` GET/POST proxy (keeps the `/api/command` whitelist tight).

### Fixed
- **`fetchJSON` now forwards request options** (`method`/`headers`/`body`) — POST
  callers previously silently fell back to a GET. Also **hardened the Halo read
  with retry/backoff** so a lost boot-burst race against the gateway's rate limit
  doesn't leave the card hidden.

## [0.41.0] - 2026-07-03

### Added
- **Gateway-firmware compatibility warning.** The dashboard now reads the
  gateway's firmware version (`gw_fw`, added in firmware v3.2.0-beta.8) and shows
  a banner when it's older than **v3.0.0** — the point below which older firmware
  may not emit the status fields the dashboard reads (so the status grid shows
  `--`). Closes the third compatibility axis: **gateway firmware ⇄ add-on**.

### Fixed
- **Charge Assistant `get_config` bridge robustness.** The service call now sends
  an explicit `return_response=1` (some HA versions read the flag by value, not
  just presence — a `SupportsResponse.ONLY` service 400s if HA thinks the
  response wasn't requested). Addresses "`get_config HTTP 400: Bad Request`" on
  the Charge Assistant page.

## [0.40.0] - 2026-07-02

### Added
- **Multiple gateways from one Add-on.** Add a `gateways:` list in the Add-on
  Configuration tab (one entry per charger — `name`, `ip`, `auth_user`,
  `auth_pass`) to manage several Pulsars from a single install. A charger
  switcher appears in the header on every page; your selection is remembered for
  the browser session and every dashboard / sessions / OTA / Charge-Assistant
  call targets the chosen gateway. Existing single-gateway installs are
  unaffected — the legacy `gateway_ip` fields still work when `gateways` is empty.

### Changed
- **Clearer Charge Assistant error when the integration is out of date.** If the
  **Wallbox Gateway** integration is installed but older than **0.18.0** (no
  `get_config`/`set_config` services), the page now says *"Update the Wallbox
  Gateway integration to ≥ 0.18.0"* with a link hint, instead of the misleading
  generic "Home Assistant link unavailable". Requires **integration ≥ 0.18.0**.

### Notes
- Each ESP32 gateway remains fully independent (its own MQTT device keyed by
  charger serial). The Add-on is the config/monitoring GUI; entities still come
  from firmware MQTT discovery and/or the (multi-instance) HACS integration.
- **Compatibility:** this Add-on (≥ 0.40.0) needs the HACS **Wallbox Gateway
  integration ≥ 0.18.0** for the Charge Assistant. Update both together.

## [0.39.1] - 2026-06-28

### Fixed
- **Collapsible cards no longer corrupt the native `<details>` "Dynamic current"
  / "Integration settings" cards** (was adding a second chevron and breaking their
  keyboard toggle).
- **Commute defaults (20% / 10% / 1 day / 7 days / 18 kWh/100km) now seed** when
  you pick Smart charge / Smart + Solar (the relocated card was outside the scope
  the default-seeder scanned).
- Vehicle-picker dropdowns are cleaned up when a row is removed (no orphaned DOM);
  a loaded vehicle's live battery/odometer value shows immediately.

## [0.39.0] - 2026-06-28

### Added
- **"When unsure which car is plugged in" policy** in the Vehicles card
  (conservative / ask / assume) — pairs with integration 0.18.0b14. Controls how
  the assistant charges while the plugged-in car is still a guess.

## [0.38.0] - 2026-06-28

### Changed
- **Vehicles + Commute now apply to Smart + Solar too** (not just Smart charge).
  Both cards are shared across the target-bearing strategies, so Smart + Solar
  gets per-car profiles and the learned commute target. Pure Solar stays
  surplus-driven (grabs all available solar up to its ceiling) and doesn't show
  them. Verified saving in both Smart charge and Smart + Solar.

## [0.37.1] - 2026-06-28

### Fixed
- **Static assets are cache-busted** (`?v=<mtime>` on JS/CSS + 5-min max-age), so
  a new build no longer serves a stale cached page — you see the new UI on reload
  without a manual hard-refresh.

## [0.37.0] - 2026-06-28

### Added
- **Vehicles list (multi-car, P1)** in the Smart-charge mode — add the cars that
  share one charger, each with its own battery entity, capacity, target, ready-by
  and commute settings (incl. per-car learn-from source). Add / edit / remove
  rows; saved as the `cars` profile list (pairs with integration 0.18.0b10).
  Leave empty for single-car (the flat Battery settings are used).
- **Collapsible cards** — every config section's header now collapses/expands
  (click or Enter/Space, chevron shows state), so the page isn't a wall of fields.

### Fixed
- Re-running picker setup (when adding a vehicle row) no longer rebuilds and
  wipes already-selected entity pickers.

## [0.36.0] - 2026-06-28

### Changed
- Commute card now points at the new **Projected SOC after a day's driving**
  sensor (integration 0.18.0b9) alongside Daily use / Commute target, so you can
  see at a glance whether you'll make it without charging.

## [0.35.0] - 2026-06-28

### Added
- **"Learn from" dropdown in the Commute card** (pairs with integration
  0.18.0b8). Choose how daily use is measured: **Charger energy delivered**
  (default), **Car odometer (km) + efficiency**, or **Car battery-level drop
  (SOC)**. Picking odometer reveals an odometer-entity picker + efficiency field;
  SOC reuses the battery-level entity already chosen above. The live summary
  states which source it's learning from.

## [0.34.0] - 2026-06-28

### Added
- **Commute charging** card in the Charge Assistant's Target-charge mode (pairs
  with integration 0.18.0b7). Tick "Charge for my daily commute" and the
  assistant learns how much you drive (from real charge history) and sets the
  target automatically — enough for the commute plus a margin, capped at your
  everyday target. Tunables: always-keep floor, safety margin, days-to-cover and
  the learning window. The live summary explains exactly what it'll do, and the
  config preview shows the learned daily use.

## [0.33.0] - 2026-06-28

### Added
- **"Auto-resume Eco-Smart / native schedule after a manual charge"** toggle in
  Integration settings (default on). Pairs with integration 0.18.0b6 — after a
  manual charge stops and leaves the charger paused + idle, the integration clears
  the override so your charger's own Solar + schedule control resumes, no manual
  "Resume schedule" tap needed.

## [0.32.0] - 2026-06-28

### Fixed
- **Switching the Charge Assistant mode to "Off" no longer wipes your config.**
  Previously, picking "Off" saved only `{mode: "off"}` and erased your window,
  target, departure, surplus source, etc. Now "Off" **preserves all your
  settings** (so flipping back to a mode doesn't make you reconfigure) while
  staying fully inert — strategy off = no charging, and the plug-in reminder
  layer is disabled so nothing nudges either.

## [0.31.0] - 2026-06-27

### Added
- **"Solar available" plug-in reminder** in the reminder layer — nudges you to
  plug in when there's spare solar and the car's unplugged (with a surplus
  threshold), plus an **"Only when home"** presence picker so it only fires when
  you're home. Pairs with integration 0.18.0b4.

## [0.30.0] - 2026-06-27

### Added
- **Clearly-defined "Charging breakdown" on the Sessions page** — every charging
  metric, each labelled with a hover definition, all from the accurate charge-log
  (charging only, never whole-house):
  - **Energy charged** (total kWh this month)
  - **⚡ Grid (billed)** — kWh + % of charging that came from the grid (the part
    you pay for)
  - **☀️ Solar (free)** — kWh + % from your solar (never billed)
  - **Charging cost** — grid energy × your tariff; explicitly "charging only, not
    your whole-house bill"
  - **Solar value** — what that solar charging would have cost at grid rates

### Changed
- Week/month **kWh tiles** on the Sessions page now also come from the charge-log,
  so the tiles, the breakdown and the cost are one consistent figure (no more a
  session-cache total that disagrees with the cost).

## [0.29.0] - 2026-06-27

### Fixed
- **Charging cost was wildly over-stated** (e.g. a month showing ~$105 — closer
  to a whole-house bill than EV charging). Two causes, both fixed:
  - Cost was computed from the browser **session cache**, which could go **stale**
    (frozen whenever the Sessions page wasn't open — so recent cheap overnight
    charging was missing) and, worse, **mis-recorded daytime solar charges with
    green = 0**, so free solar got billed as grid at peak rates.
  - Cost (week + month, the dashboard tiles **and** the savings card) now comes
    from the firmware **charge-log** — the ground-truth cp-based charge windows,
    each carrying its real green share (`gwh`). Solar is never billed; each burst
    is costed at the rate of the hours it actually ran. Reloaded fresh every time,
    so it can't go stale. Applied in both the dashboard (cost.js) and the Sessions
    page (sessions.js) so neither overwrites the other.

### Known follow-up
- The session **history list** still reflects the gateway's own per-session
  records, some of which logged green = 0 for solar charges (a firmware
  `green_energy` issue). Cost no longer depends on those, but the session-list
  kWh totals can still look high until the firmware recording is fixed.

## [0.28.0] - 2026-06-27

### Added
- **"Solar can fill up to %" field** in the Smart + Solar config — the ceiling
  for free solar charging past the SOC target (`solar_max_soc`, default 100% =
  grab all available solar). Lower it (e.g. 90%) to protect the battery while
  still letting solar charge beyond the grid target. Dev-tested: field renders,
  defaults to 100, saves under `solar_max_soc`.

## [0.27.0] - 2026-06-27

### Added
- **Charging-savings clarity.** The savings card now shows an explicit
  **☀️ Solar saved** figure alongside **⏱️ Time-shift**, so the solar number
  lines up with the official Wallbox app's "green" value (the two were measuring
  different things — solar vs time-of-use shifting — which was confusing).
- **Baseline toggle with tooltips.** A quick **"Compared to: vs plug-in /
  vs avg rate"** toggle on the savings card, each with a hover tooltip explaining
  what it means:
  - *vs plug-in* — what charging the moment you plugged in would have cost (no
    time-shifting); the realistic "if I did nothing" baseline, usually smaller.
  - *vs avg rate* — what it would have cost at your tariff's all-day average rate
    (peak + off-peak blended); shows the full value of charging off-peak.
  The toggle mirrors (and stays in sync with) the advanced selector, which still
  offers the third "fixed time" baseline.

## [0.26.0] - 2026-06-27

### Changed
- **Charging-window help text** now reflects that the window *bounds* the charge:
  it starts just-in-time to finish by the window end and **stops at the window
  end**, and a departure deadline only pushes charging outside the cheap hours if
  you enable overrun / pre-start. (Previously it implied "your departure time
  always wins", which is no longer how the integration behaves — the window wins
  by default.)

### Notes
- Pairs with integration **0.18.0b1**, which makes the window govern grid
  charging, re-asserts a forced start against Eco-Smart, and adds a
  **Next charge start** sensor (shows when a just-in-time charge will begin).

## [0.25.4] - 2026-06-25

### Added
- **"Send test reminder"** button — saves the current config and fires the
  reminder notification immediately, so you can check the message + tap-path +
  notify service on your phone without waiting for a trigger.
- The **charging window** now shows its **length** (e.g. "6h 0m", handling
  midnight wrap) and warns when start == end.

## [0.25.3] - 2026-06-25

### Added
- **"Tap opens (path)"** in the plug-in reminder is now a **dropdown of your
  actual Lovelace dashboards + views** (fetched over the HA WebSocket API), while
  still accepting any free-text path. Falls back to free-text if the list can't
  be fetched. (Adds the `websocket-client` dependency — installed best-effort so
  the build never fails on it.)

## [0.25.2] - 2026-06-25

### Fixed
- Entity pickers show the **live value** of the selected entity again — picking
  an entity wasn't refreshing the side preview (only the initial page load did),
  so it stuck on "—".

### Changed
- **Charging window + Auto-start grace** now show only for **Smart charge** and
  **Smart + Solar** (they gate *grid* charging) and are **hidden for pure Solar**,
  where neither applies. In **Smart + Solar** the window description makes clear
  it limits only **grid top-up** — *solar still charges anytime there's surplus*
  (a night window does not block daytime solar). Mirrored in the integration's
  options flow.

## [0.25.1] - 2026-06-24

### Fixed
- Dashboard status now reads **"Connected — not charging"** for an idle charger
  (status 4 with `gen=0`) instead of "Paused", reserving "Paused" for a real
  Schedule/Solar override — matching the integration's charger-status sensor.

## [0.25.0] - 2026-06-24

### Added
- **Auto-start grace period** field on the acting (Smart charge / Solar / Smart +
  Solar) config — when set, the assistant notifies "charging will start in N min
  — tap to cancel" before it begins, so you can hold off. 0 = start immediately.
  (Backed by the integration's managed-override session, which also suppresses
  the charger's Eco-Smart Solar-Only pause during a grid charge and restores it
  + resumes native schedule control when the charge finishes.)

## [0.24.0] - 2026-06-24

Composable Charge Assistant — mix behaviours instead of picking one mode.

### Added
- **Plug-in reminders as a layer** — enable plug-in nudges *on top of* Smart
  charge or Solar (not just as a standalone mode). Charge-event alerts and
  reminder nudges can target different notify services.
- **Smart + Solar** strategy — charge from excess solar whenever it's
  available (free), and top up from grid only inside your cheap window or just
  in time to reach the target by departure.
- **Charging window** — restrict charging to cheap hours (e.g. 00:00–06:00),
  with *pre-start* (begin early to be ready by departure), *overrun* (finish
  past the window if the target isn't reached), and a notification when a
  charge runs outside the window.
- Live summary + the dashboard card describe the whole composed setup in one
  sentence. Native HA options flow brought to parity (new Smart + Solar step,
  window + reminder-layer fields).
- **Charge-control owner is now settable from the Add-on** — a dropdown on the
  Assistant page writes straight to the gateway (no need to open its own
  Settings page). After saving an acting mode while the owner isn't Home
  Assistant, a prompt offers to hand control over so the assistant actually
  runs.

Requires Wallbox Gateway integration ≥ 0.16.0 and gateway firmware with the
`/api/control_owner` endpoint (v3.2.0-beta.6+).

## [0.23.0] - 2026-06-23

Saved-state visibility — you can always see what the assistant is set to.

### Added
- **"Active now" line** on the Charge Assistant page — shows, in plain
  English, the config currently **saved and running** on the integration,
  separate from the live preview of what you're editing.
- **Unsaved-changes indicator** in the action bar (**● Unsaved changes**
  vs **✓ Up to date**), a *Preview — not saved yet* tag on the live
  summary, and the **Save** button disables when nothing has changed.
  Opening the page loads the existing setup for editing.
- **Charge Assistant card on the dashboard** — a read-only summary of the
  current setup with an **Edit setup →** link, rendered by a shared
  `ca_summary` module so the dashboard and the Assistant page always agree.

### Fixed
- Mode-section cards rendered at different widths (a CSS class-name
  collision with the new saved-state box); cards are uniform width again.

## [0.22.0] - 2026-06-22

The Charge Assistant release — Phase 1. The Add-on becomes the rich,
primary place to configure the integration's Charge Assistant, so you
never need the native options-flow wizard again.

### Added
- **Charge Assistant page** (new **🤖 Assistant** nav entry) — a full GUI
  for the integration's Charge Assistant: pick **Off / Reminder / Smart
  charge / Solar**, then configure each mode with **live entity pickers**
  (battery level, presence, price, solar-surplus) that show the entity's
  **current value inline** so you pick the right one. Covers all the
  reminder triggers (arrival / nightly / lead-time / price), conditions
  (SOC skip, quiet hours, only-if-scheduled), and the notification
  (service, title, message, actionable buttons, re-remind). Save applies
  immediately — the integration reloads the assistant with the new config.
- **Works without Wallbox accessories** — every input is a free choice of
  **any** Home Assistant sensor (device-class matches are suggested first,
  but the full list is always selectable, so template/non-standard sensors
  work too). Battery level, solar surplus, electricity price, presence, and
  the house/grid-power source for load-limiting can all come from your
  existing HA entities — no Power Boost meter required.
- **Tariff now feeds the integration** — saving your tariff also mirrors it to
  the Wallbox Gateway integration (via the config bridge), so the integration
  can publish native **Charging cost** sensors (with HA long-term statistics).
  The Add-on keeps working from its own copy regardless; best-effort, nothing
  changes if the integration isn't installed. Needs integration **0.15.0+**.
- **Surplus source wizard** (Solar mode) — no ready-made "surplus" sensor? Pick
  **grid power** (export = surplus) or **solar − house load** and the assistant
  derives it. The live summary updates to match your source.
- **Battery care & limits** (Smart-charge) — the target is your everyday ceiling
  (80% is kind to the battery); set a higher **trip target** that applies only
  until a date/time (then reverts), and a **price cap** so it never charges
  above a price you set (your departure time still wins).
- **Dynamic current control** (Solar mode, advanced) — modulate the charge
  current to follow available solar surplus instead of plain on/off, within
  configurable min/max amps, with a supply voltage/phases setting to convert
  power to current. Optional **house-load limit** trims charge current so
  total draw stays under a cap (reads your chosen grid-power sensor, or the
  charger's own meter).
- **Integration settings** section on the same page — poll interval (editable)
  and the current charge-control owner (read-only; changed on the gateway's
  own Settings page).

- **Cheapest-hours charging** in Smart-charge — pick a price-forecast sensor and
  the assistant charges only in the cheapest hours that still reach your target
  by departure. The picker **detects whether the sensor actually has a forecast**
  and says so (✓ / ⚠), since cheapest-hours is impossible without one.
- **Capability-aware** — the page reads your charger model from the gateway and
  **disables features it can't do** (live dynamic-current is hidden on the
  original Pulsar, and labelled experimental everywhere) instead of offering
  things that silently won't work.
- **Charging savings** card on the dashboard — what time-shifting into cheaper
  hours (+ using solar) is worth, as week / month / projected-per-year. It's an
  honest **estimate vs a baseline you choose** ("without the assistant I'd
  charge: immediately at plug-in / at a fixed time / whenever") — measured
  energy × your real tariff, only the baseline behaviour is assumed; never shown
  as a guarantee. Includes 👍/👎 feedback with an **Export** that copies an
  anonymised bundle for you to share — **stored on-device, nothing is ever sent
  automatically**.

### Changed
- The Charge Assistant page got a full **redesign** — a familiar HA-style
  single-column flow with a mode selector, **live plain-English summary** of
  what the assistant will do, smart defaults, inline live entity values, and a
  sticky action bar. Responsive desktop + mobile.
- **HA bridge** — the Add-on backend now reads HA entity states and the
  integration's current config (and writes it back) using the
  `homeassistant_api` permission (the same grant ESPHome / Node-RED use).
  The Supervisor token stays in the backend and is never exposed to the
  browser; new `/api/ha/states` + `/api/ha/config` routes proxy it.

### Notes
- The integration remains the single automation brain — this page only
  *configures* it. Basic charger setup (host, credentials) still lives in
  the integration; everything here writes back to it.
- Requires the **Wallbox BLE Gateway** integration **0.15.0+** (adds the
  `get_config` / `set_config` services this page calls).

## [0.21.4] - 2026-06-22

### Changed
- Dashboard **cost tiles now auto-refresh** — they recompute from the real
  charge windows (firmware charge-log) + your tariff on load and every 5 min,
  so they stay current without opening the Sessions page (previously the tiles
  only updated when you visited Sessions, so they could show a stale figure).
  New shared `cost.js` engine drives it; the Sessions page remains the
  authoritative calc.

## [0.21.3] - 2026-06-21

### Changed
- Energy-flow card now shows **live power (kW)** at each node instead of
  cumulative session energy: Vehicle = live charging power, Grid = live
  house/grid power (from the Power Meter), Solar = live solar surplus
  *available*. Flow lines animate only while charging (idle no longer looks
  like active flow). The **"Since plugged in" footer now shows the cumulative
  green (solar used) vs grid energy split** — the official app's "green"
  number — so solar-used (kWh) and solar-available (kW) are both visible and
  no longer conflated. The charger exposes no live solar-vs-grid *power*
  split, so the lines approximate it from solar surplus.
- Grid node shows grid **import** only (clamped to ≥ 0). When you're exporting
  solar surplus the meter reads negative — that surplus now shows on the Solar
  node instead of as a confusing negative Grid value.

## [0.21.2] - 2026-06-21

### Fixed
- Original/Zentri Pulsar (#12): the dashboard no longer blanks the kW / status /
  session tiles when the charger doesn't serve `r_sta` — the hero + stats block
  now keys off `r_dat` (`status.r`) and uses `r_dat.st` for the status code on
  that hardware. Added a Zentri status-name set (st4 = "Starting", not
  "Paused"). Charging power comes from the firmware's derived `cp` — needs
  gateway firmware **v3.2.0-beta.2+**.

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
