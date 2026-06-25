// Charge Assistant config page.
//
// HA Supervisor ingress: all fetch paths are RELATIVE (see dashboard.js) so
// they append to the current ingress base. This page reads HA entities +
// the integration's current config via the Add-on backend's /api/ha/* bridge
// (the backend holds the SUPERVISOR_TOKEN — it's never exposed here), lets the
// user build the Charge Assistant config with live entity pickers, and writes
// it back through the same bridge. The integration remains the single brain.

(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);

  // Field id -> CA option key. Mode-specific notify fields all map to the same
  // notify_service key; we resolve which one to read by the active mode.
  const FIELDS = {
    // reminder
    arrival_entity: "arrival_entity",
    nightly_time: "nightly_time",
    lead_hours: "lead_hours",
    tariff_entity: "tariff_entity",
    tariff_below: "tariff_below",
    soc_entity: "soc_entity",
    skip_above_pct: "skip_above_pct",
    soc_max_age_min: "soc_max_age_min",
    quiet_start: "quiet_start",
    quiet_end: "quiet_end",
    scheduled_within_h: "scheduled_within_h",
    notify_service: "notify_service",
    title: "title",
    tap_path: "tap_path",
    message: "message",
    escalate_min: "escalate_min",
    // target
    soc_entity_t: "soc_entity",
    target_soc_pct: "target_soc_pct",
    departure_time: "departure_time",
    battery_kwh: "battery_kwh",
    charge_power_kw: "charge_power_kw",
    price_entity: "price_entity",
    trip_target_pct: "trip_target_pct",
    trip_until: "trip_until",
    price_cap: "price_cap",
    notify_service_t: "notify_service",
    // solar
    surplus_source: "surplus_source",
    surplus_entity: "surplus_entity",
    grid_entity: "grid_entity",
    solar_entity: "solar_entity",
    load_entity: "load_entity",
    surplus_start: "surplus_start",
    surplus_stop: "surplus_stop",
    surplus_debounce_min: "surplus_debounce_min",
    notify_service_s: "notify_service",
    // solar — dynamic current (Phase 2)
    min_current_a: "min_current_a",
    max_current_a: "max_current_a",
    supply_voltage: "supply_voltage",
    supply_phases: "supply_phases",
    load_limit_w: "load_limit_w",
    load_power_entity: "load_power_entity",
    // smart_solar — combined (target fields + surplus fields), own field ids
    soc_entity_ss: "soc_entity",
    target_soc_pct_ss: "target_soc_pct",
    departure_time_ss: "departure_time",
    battery_kwh_ss: "battery_kwh",
    charge_power_kw_ss: "charge_power_kw",
    surplus_source_ss: "surplus_source",
    surplus_entity_ss: "surplus_entity",
    grid_entity_ss: "grid_entity",
    solar_entity_ss: "solar_entity",
    load_entity_ss: "load_entity",
    surplus_start_ss: "surplus_start",
    notify_service_ss: "notify_service",
  };
  const CHECKS = {
    only_if_scheduled: "only_if_scheduled",
    actionable: "actionable",
    target_autostart: "target_autostart",
    cheapest_window: "cheapest_window",
    solar_dynamic: "solar_dynamic",
    grid_export_negative: "grid_export_negative",
    grid_export_negative_ss: "grid_export_negative",
  };
  const NUM_KEYS = new Set([
    "lead_hours", "tariff_below", "skip_above_pct", "soc_max_age_min",
    "scheduled_within_h", "escalate_min", "target_soc_pct", "battery_kwh",
    "charge_power_kw", "surplus_start", "surplus_stop", "surplus_debounce_min",
    "min_current_a", "max_current_a", "supply_voltage", "supply_phases",
    "load_limit_w", "trip_target_pct", "price_cap",
  ]);
  // Which CA keys belong to each mode — only these are written on save, so
  // switching modes doesn't carry stale fields from another mode.
  const MODE_KEYS = {
    reminder: [
      "triggers", "arrival_entity", "nightly_time", "lead_hours",
      "tariff_entity", "tariff_below", "soc_entity", "skip_above_pct",
      "soc_max_age_min", "quiet_start", "quiet_end", "only_if_scheduled",
      "scheduled_within_h", "notify_service", "title", "tap_path", "message",
      "actionable", "escalate_min",
    ],
    target_soc: [
      "soc_entity", "target_soc_pct", "target_autostart", "departure_time",
      "battery_kwh", "charge_power_kw", "cheapest_window", "price_entity",
      "trip_target_pct", "trip_until", "price_cap", "notify_service",
    ],
    solar: [
      "surplus_source", "surplus_entity", "grid_entity", "grid_export_negative",
      "solar_entity", "load_entity",
      "surplus_start", "surplus_stop", "surplus_debounce_min", "notify_service",
      "solar_dynamic", "min_current_a", "max_current_a", "supply_voltage",
      "supply_phases", "load_limit_w", "load_power_entity",
    ],
    smart_solar: [
      "soc_entity", "target_soc_pct", "departure_time", "battery_kwh",
      "charge_power_kw", "surplus_source", "surplus_entity", "grid_entity",
      "grid_export_negative", "solar_entity", "load_entity", "surplus_start",
      "notify_service",
    ],
    off: [],
  };
  const TRIGGERS = ["arrival", "nightly", "lead", "tariff"];

  // Acting strategies drive charging (vs reminder which only notifies). The
  // shared "Charging window" card is shown for these. Window fields live in a
  // card outside the per-mode sections, so they're gathered/applied explicitly
  // (like poll_interval) rather than via the section-scoped FIELDS loop.
  const ACTING_MODES = ["target_soc", "solar", "smart_solar"];
  const WINDOW_FIELDS = { window_start: "window_start", window_end: "window_end" };
  const WINDOW_CHECKS = {
    window_enabled: "window_enabled", window_overrun: "window_overrun",
    window_prestart: "window_prestart", window_cost_warn: "window_cost_warn",
  };

  // Plug-in reminder LAYER — saved as a nested `reminder` sub-dict so it can
  // ride on top of an acting strategy. Distinct field ids (…_l) so they don't
  // collide with the standalone Reminder mode's fields.
  const RL_TRIGGERS = ["arrival", "nightly", "lead", "tariff"];
  const RL_FIELDS = {   // layer field id -> reminder sub-dict key
    arrival_entity_l: "arrival_entity", nightly_time_l: "nightly_time",
    lead_hours_l: "lead_hours", tariff_entity_l: "tariff_entity",
    tariff_below_l: "tariff_below", notify_service_l: "notify_service",
  };
  const RL_NUM = new Set(["lead_hours", "tariff_below"]);

  // Smart defaults — filled the moment a mode is picked (only into empty
  // fields), so the user starts from a sensible config instead of a blank form.
  const DEFAULTS = {
    reminder: {
      skip_above_pct: 80, escalate_min: 0,
      title: "Plug in your car",
      message: "Your car isn't plugged in — plug it in to charge.",
    },
    target_soc: { target_soc_pct: 80, battery_kwh: 60, charge_power_kw: 7.4 },
    solar: {
      surplus_start: 1.4, surplus_stop: 0.4, surplus_debounce_min: 3,
      min_current_a: 6, max_current_a: 32, supply_voltage: 230, supply_phases: 1,
    },
    smart_solar: {
      target_soc_pct: 80, battery_kwh: 60, charge_power_kw: 7.4, surplus_start: 1.4,
    },
  };
  const OWNER_NAMES = {
    wallbox_schedule: "Wallbox native schedule",
    integration: "Home Assistant Integration",
    addon: "Home Assistant Add-on",
    none: "None (manual / plug-in only)",
  };

  let entities = [];
  let entById = {};
  let notifyServices = [];     // the user's notify.* services (for the picker)
  let host = null;
  let currentMode = "off";
  let ownerState = null;       // gateway charge-control owner (from /api/status)

  let hideUnavailable = false;  // GUI toggle: only show entities with a live value

  // Saved-vs-editing state. savedSig is the signature of the config currently
  // committed to the integration; comparing it to the live form tells us
  // whether there are unsaved changes. savedCa is the saved config object,
  // rendered into the "Active now" line so the user always sees what's running.
  let savedSig = null;
  let savedCa = { mode: "off" };
  let isDirty = false;

  // Escapes for both text and double-quoted attribute contexts (entity ids land
  // in a value="…" attribute at line ~184; friendly names from HA state reach
  // innerHTML via buildSummary). Covers & < > " '.
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const nameOf = (eid) => (eid && entById[eid] ? entById[eid].name : eid);
  const DEAD = ["unavailable", "unknown", "none", ""];
  const isAvailable = (e) => !!e && e.state != null && !DEAD.includes(String(e.state).toLowerCase());
  const liveOf = (eid) => {
    const e = eid ? entById[eid] : null;
    if (!e || e.state == null) return null;
    return e.unit ? `${e.state} ${e.unit}` : `${e.state}`;
  };

  async function fetchJSON(path, opts) {
    try {
      const r = await fetch(path, Object.assign({ cache: "no-store" }, opts || {}));
      const body = await r.json().catch(() => ({}));
      return { ok: r.ok, status: r.status, body };
    } catch (e) {
      return { ok: false, status: 0, body: { error: "fetch_failed", detail: String(e) } };
    }
  }

  // ── entity / notify pickers — single type-to-search comboboxes ──
  function pickerSelects() {
    return Array.from(document.querySelectorAll("select[data-domains]"));
  }
  function notifyInputs() {
    return Array.from(document.querySelectorAll("input[data-notify]"));
  }

  function setupComboboxes() {
    // Entity pickers: single-select, value held in the (hidden) <select>.
    pickerSelects().forEach((sel) => {
      const domains = (sel.dataset.domains || "").split(",").map((s) => s.trim());
      const dc = sel.dataset.deviceClass || "";
      let matches = entities.filter((e) => domains.includes(e.domain));
      if (dc) {
        matches.sort((a, b) =>
          ((a.device_class === dc ? 0 : 1) - (b.device_class === dc ? 0 : 1)) ||
          a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
      }
      // Keep the hidden select populated so its .value can hold any entity_id.
      sel.innerHTML = '<option value=""></option>' +
        matches.map((e) => `<option value="${esc(e.entity_id)}"></option>`).join("");
      sel.style.display = "none";
      attachCombobox(sel, {
        multi: false,
        placeholder: "🔍 Search entities…",
        items: () => matches.map((e) => {
          const avail = isAvailable(e);
          return {
            value: e.entity_id, label: e.name, sub: e.entity_id,
            val: avail ? liveOf(e.entity_id) : "unavailable",
            avail,
            tag: dc && e.device_class === dc ? "suggested" : "",
          };
        }),
        display: (v) => (entById[v] ? entById[v].name : v),
        onChange: () => { updateLive(sel.id); updateSummary(); },
      });
      updateLive(sel.id);
    });
    // Notify fields: multi-select chips, value = comma-joined services.
    notifyInputs().forEach((inp) => {
      inp.style.display = "none";
      attachCombobox(inp, {
        multi: true,
        freeText: true,
        placeholder: "🔍 Add notify service…",
        items: () => notifyServices.map((s) => ({ value: s, label: s })),
        onChange: () => updateSummary(),
      });
    });
    // Fixed-positioned dropdowns must close on scroll/resize so they don't
    // drift away from their input. Ignore scrolls inside a list itself.
    if (!setupComboboxes._scrollBound) {
      setupComboboxes._scrollBound = true;
      window.addEventListener("scroll", (e) => {
        if (e.target && e.target.classList && e.target.classList.contains("ca-combo-list")) return;
        repositionOpenLists();
      }, true);
      window.addEventListener("resize", repositionOpenLists);
    }
  }

  // Reusable combobox over a hidden value-holder (a <select> or <input>).
  // value: single = "entity_id"; multi = "a,b,c".
  function attachCombobox(holder, cfg) {
    let C = holder._combo;
    if (!C) {
      const wrap = document.createElement("div");
      wrap.className = "ca-combo" + (cfg.multi ? " ca-combo-multi" : "");
      const chips = document.createElement("div");
      chips.className = "ca-combo-chips";
      const inp = document.createElement("input");
      inp.type = "text"; inp.className = "ca-combo-input"; inp.autocomplete = "off";
      inp.placeholder = cfg.placeholder || "Search…";
      const list = document.createElement("div");
      list.className = "ca-combo-list"; list.hidden = true;
      if (cfg.multi) wrap.appendChild(chips);
      wrap.appendChild(inp);
      holder.parentNode.insertBefore(wrap, holder);
      // The dropdown lives on <body>, not inside the form: a card's fade-in
      // transform would otherwise become the containing block for this
      // position:fixed element and throw off its coordinates. On body it's
      // always viewport-relative.
      document.body.appendChild(list);
      C = holder._combo = { wrap, chips, inp, list, cfg };
      inp.addEventListener("focus", () => openList(holder, inp.value));
      inp.addEventListener("input", () => openList(holder, inp.value));
      inp.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter" && cfg.multi && cfg.freeText && inp.value.trim()) {
          ev.preventDefault(); addMulti(holder, inp.value.trim()); inp.value = ""; openList(holder, "");
        } else if (ev.key === "Escape") { C.list.hidden = true; }
      });
      inp.addEventListener("blur", () => setTimeout(() => {
        C.list.hidden = true;
        if (!cfg.multi) syncSingle(holder); else inp.value = "";
      }, 160));
      // Selecting/clearing a value dispatches "change" on the hidden control.
      // Run the combo's own onChange (live preview + summary) — previously only
      // the form-level summary listener caught it, so the live value never
      // refreshed when you PICKED an entity (only on initial load).
      holder.addEventListener("change", () => { if (C.cfg.onChange) C.cfg.onChange(); });
    }
    refreshCombo(holder);
  }

  function openList(holder, query) {
    const C = holder._combo, q = (query || "").trim().toLowerCase();
    let items = C.cfg.items();
    if (C.cfg.multi) {
      const chosen = new Set(splitVals(holder.value));
      items = items.filter((it) => !chosen.has(it.value));
    }
    if (q) {
      const terms = q.split(/\s+/).filter(Boolean);   // each term must appear (substring, anywhere)
      items = items.filter((it) => {
        const hay = (it.label + " " + (it.sub || "")).toLowerCase();
        return terms.every((t) => hay.includes(t));
      });
    }
    if (hideUnavailable && !C.cfg.multi) {
      items = items.filter((it) => it.avail !== false || it.value === holder.value);
    }
    items = items.slice(0, 300);
    C.list.innerHTML = "";
    if (!C.cfg.multi) {
      C.list.appendChild(makeItem(holder, { value: "", label: "— none —" }));
    }
    items.forEach((it) => C.list.appendChild(makeItem(holder, it)));
    C.list.hidden = false;
    positionList(C);
  }

  // Fixed-position the dropdown to the input so it's never clipped by a card
  // or covered by a later card (escapes all overflow / stacking contexts).
  function positionList(C) {
    const r = C.inp.getBoundingClientRect();
    const maxH = 260, below = window.innerHeight - r.bottom;
    C.list.style.position = "fixed";
    C.list.style.left = r.left + "px";
    C.list.style.width = r.width + "px";
    if (below < maxH && r.top > below) {     // not enough room below → flip up
      C.list.style.top = "auto";
      C.list.style.bottom = (window.innerHeight - r.top + 4) + "px";
      C.list.style.maxHeight = Math.min(maxH, r.top - 8) + "px";
    } else {
      C.list.style.bottom = "auto";
      C.list.style.top = (r.bottom + 4) + "px";
      C.list.style.maxHeight = Math.min(maxH, below - 8) + "px";
    }
  }

  function closeAllLists() {
    [...pickerSelects(), ...notifyInputs()].forEach((h) => { if (h._combo) h._combo.list.hidden = true; });
  }

  // On page scroll/resize, keep any open dropdown glued to its input rather
  // than closing it — only close if the input scrolls out of view.
  function repositionOpenLists() {
    [...pickerSelects(), ...notifyInputs()].forEach((h) => {
      const C = h._combo;
      if (!C || C.list.hidden) return;
      const r = C.inp.getBoundingClientRect();
      if (r.bottom < 0 || r.top > window.innerHeight) { C.list.hidden = true; return; }
      positionList(C);
    });
  }

  function makeItem(holder, it) {
    const C = holder._combo;
    const row = document.createElement("div");
    row.className = "ca-combo-item"
      + (it.tag === "suggested" ? " suggested" : "")
      + (it.avail === false ? " unavail" : "");
    const main = document.createElement("div");
    main.className = "ci-main";
    const name = document.createElement("span");
    name.className = "ci-name"; name.textContent = it.label;
    main.appendChild(name);
    if (it.sub && it.sub !== it.label) {
      const sub = document.createElement("span");
      sub.className = "ci-sub"; sub.textContent = it.sub;
      main.appendChild(sub);
    }
    row.appendChild(main);
    if (it.val != null) {
      const v = document.createElement("span");
      v.className = "ci-val" + (it.avail === false ? " bad" : "");
      v.textContent = it.val;
      row.appendChild(v);
    }
    row.addEventListener("mousedown", (ev) => {
      ev.preventDefault();
      if (C.cfg.multi) { if (it.value) addMulti(holder, it.value); C.inp.value = ""; openList(holder, ""); }
      else { holder.value = it.value; syncSingle(holder); C.list.hidden = true; holder.dispatchEvent(new Event("change", { bubbles: true })); }
    });
    return row;
  }

  function splitVals(v) {
    return String(v || "").split(",").map((s) => s.trim()).filter(Boolean);
  }
  function addMulti(holder, val) {
    const vals = splitVals(holder.value);
    if (!vals.includes(val)) vals.push(val);
    holder.value = vals.join(",");
    refreshCombo(holder);
    holder.dispatchEvent(new Event("change", { bubbles: true }));
  }
  function removeMulti(holder, val) {
    holder.value = splitVals(holder.value).filter((v) => v !== val).join(",");
    refreshCombo(holder);
    holder.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function syncSingle(holder) {
    const C = holder._combo;
    C.inp.value = holder.value ? C.cfg.display(holder.value) : "";
  }

  function refreshCombo(holder) {
    const C = holder._combo;
    if (!C) return;
    if (C.cfg.multi) {
      C.chips.innerHTML = "";
      splitVals(holder.value).forEach((val) => {
        const chip = document.createElement("span");
        chip.className = "ca-chip";
        const t = document.createElement("span"); t.textContent = val; chip.appendChild(t);
        const x = document.createElement("button");
        x.type = "button"; x.className = "ca-chip-x"; x.textContent = "×";
        x.addEventListener("click", () => removeMulti(holder, val));
        chip.appendChild(x);
        C.chips.appendChild(chip);
      });
    } else {
      syncSingle(holder);
    }
  }

  function refreshAllCombos() {
    pickerSelects().forEach((s) => s._combo && refreshCombo(s));
    notifyInputs().forEach((i) => i._combo && refreshCombo(i));
  }

  // ── tooltips (hover help on every field) ────────────────────────
  const MODE_TIPS = {
    off: "Assistant does nothing — your charger works exactly as it does now.",
    reminder: "Only sends notifications to nudge you to plug in. Never controls charging.",
    target_soc: "Charges up to a target battery level then stops; can time it for a departure, follow cheapest hours, and cap price.",
    solar: "Charges from excess solar — starts/stops (and optionally modulates current) to follow your surplus.",
  };
  const TOOLTIPS = {
    "trig-arrival": "Remind me when a presence entity turns 'home'.",
    arrival_entity: "The person/device_tracker whose arrival home triggers a reminder.",
    "trig-nightly": "Remind me at a fixed time every evening.",
    nightly_time: "Local time of the nightly reminder.",
    "trig-lead": "Remind me a set number of hours before the charger's next scheduled charge.",
    lead_hours: "How many hours before the scheduled charge to remind.",
    "trig-tariff": "Remind me when the electricity price drops to/below a threshold.",
    tariff_entity: "A price sensor (e.g. Amber). The reminder fires when its value drops to your threshold.",
    tariff_below: "Notify when the price entity is at or below this value.",
    soc_entity: "Your car's battery-level sensor. Used to skip reminders when already charged enough.",
    skip_above_pct: "Don't remind if the battery is already at/above this %.",
    soc_max_age_min: "Ignore the battery reading if it's older than this many minutes (stale data).",
    quiet_start: "Start of quiet hours — no reminders during this window.",
    quiet_end: "End of quiet hours.",
    only_if_scheduled: "Only remind if a charge is scheduled within the window below.",
    scheduled_within_h: "How many hours ahead counts as 'scheduled soon'.",
    notify_service: "HA notify service(s) that push to your phone. Add more than one to notify several targets.",
    title: "Notification title.",
    tap_path: "Dashboard path the notification opens when tapped (e.g. /lovelace/energy).",
    message: "Notification body text.",
    actionable: "Add Start / Snooze / Skip buttons to the notification (HA mobile app).",
    escalate_min: "Re-send the reminder after this many minutes if still unplugged (0 = don't).",
    soc_entity_t: "Required — the battery-level sensor the assistant reads to know when to stop.",
    target_soc_pct: "Everyday charge ceiling. Charging stops here (80% is kind to the battery).",
    target_autostart: "Also START charging when below target and plugged in (not just stop at target).",
    departure_time: "Be ready by this time — charging starts just-in-time to reach target by then.",
    battery_kwh: "Battery capacity, used to estimate how long charging takes.",
    charge_power_kw: "Typical charge power, used to estimate charging duration.",
    cheapest_window: "Charge only during the cheapest forecast hours that still reach target by departure.",
    price_entity: "A price sensor with a forecast (Amber/Nord Pool/Tibber). Required for cheapest-hours.",
    trip_target_pct: "A higher one-off target for an upcoming trip (e.g. 100%).",
    trip_until: "The trip target applies until this date/time, then reverts to the everyday target.",
    price_cap: "Never charge above this price (your departure time still overrides if needed to be ready).",
    notify_service_t: "HA notify service(s) for charge start/stop alerts. Optional.",
    surplus_source: "Where 'available surplus' comes from: a sensor, your grid power, or solar minus house load.",
    surplus_entity: "A sensor that reports power available to divert to charging.",
    grid_entity: "Your grid-power sensor (exported power becomes surplus).",
    grid_export_negative: "Tick if your grid sensor reads negative when exporting (most whole-home meters do).",
    solar_entity: "Solar production sensor.",
    load_entity: "House load sensor. Surplus = solar − house load.",
    surplus_start: "Start charging when surplus rises to/above this (your sensor's units).",
    surplus_stop: "Stop charging when surplus falls to/below this.",
    surplus_debounce_min: "Surplus must hold past the threshold this long before acting (rides out clouds).",
    solar_dynamic: "Advanced: modulate the charge current to track surplus instead of plain on/off.",
    min_current_a: "Lowest charge current the assistant will set (charger min is 6 A).",
    max_current_a: "Highest charge current the assistant will set (charger max is 32 A).",
    supply_voltage: "Your supply voltage — used to convert surplus power to amps.",
    supply_phases: "Number of phases — used to convert surplus power to amps.",
    load_limit_w: "Trim charge current so total house draw stays under this (0 = off).",
    load_power_entity: "House/grid power sensor for the load limit (else the charger's own meter is used).",
    notify_service_s: "HA notify service(s) for solar charge start/stop alerts. Optional.",
    poll_interval: "How often the integration reads the gateway (5–300 s).",
    window_enabled: "Only let the assistant charge during a set window — e.g. midnight–6am — so it never runs when power is expensive.",
    window_start: "Start of the cheap window (local time). Can be later than the end to cross midnight.",
    window_end: "End of the cheap window (local time).",
    window_overrun: "If the target isn't reached by the window end, keep charging past it until it is.",
    window_prestart: "If a departure is set and the cheap window is too short, start before it so you're still ready in time.",
    window_cost_warn: "Send a notification whenever a charge runs outside the cheap window (a pricier period), so you can stop it if you'd rather wait.",
    rl_enabled: "Also send plug-in reminders on top of this charging strategy. Notifications only — never controls charging.",
    arrival_entity_l: "Remind me to plug in when this person/device gets home.",
    nightly_time_l: "Remind me to plug in at this time every evening.",
    lead_hours_l: "Remind me this many hours before the charger's next scheduled charge.",
    tariff_entity_l: "Price sensor that triggers a reminder when the rate drops.",
    tariff_below_l: "Remind me when the price entity is at/below this value.",
    notify_service_l: "HA notify service for the plug-in reminders (can differ from the charge-event alerts).",
  };
  function applyTooltips() {
    Object.entries(TOOLTIPS).forEach(([id, tip]) => {
      const el = $(id);
      if (!el) return;
      const field = el.closest(".ca-field") || el.closest(".ca-trigger") || el.closest(".ca-check") || el;
      field.title = tip;                          // hover anywhere on the field
      // Visible ⓘ affordance on the field's label so the help is discoverable.
      const label = field.matches(".ca-check") ? field : (field.querySelector("label") || field);
      if (label && !label.querySelector(".ca-tip")) {
        const tip_el = document.createElement("span");
        tip_el.className = "ca-tip";
        tip_el.textContent = "ⓘ";
        tip_el.title = tip;
        label.appendChild(tip_el);
      }
    });
    document.querySelectorAll(".ca-mode").forEach((m) => {
      const t = MODE_TIPS[m.dataset.mode];
      if (t) m.title = t;
    });
  }

  function updateLive(selId) {
    const span = document.querySelector(`[data-live-for="${selId}"]`);
    if (!span) return;
    const sel = $(selId);
    const e = sel && sel.value ? entById[sel.value] : null;
    span.classList.remove("live-ok", "live-bad");
    if (!e) { span.textContent = "—"; return; }
    if (!isAvailable(e)) {                 // warn: picked entity has no usable value
      span.textContent = "⚠ unavailable";
      span.classList.add("live-bad");
      return;
    }
    span.textContent = e.unit ? `${e.state} ${e.unit}` : `${e.state}`;
    span.classList.add("live-ok");
  }

  // ── load ────────────────────────────────────────────────────────
  async function loadEntities() {
    const r = await fetchJSON("api/ha/states");
    if (!r.ok) {
      $("ca-no-bridge").hidden = false;
      $("ca-bridge-detail").textContent = r.body.detail || r.body.error || `HTTP ${r.status}`;
      $("ca-form").hidden = true;
      return false;
    }
    entities = r.body.entities || [];
    entById = {};
    entities.forEach((e) => { entById[e.entity_id] = e; });
    return true;
  }

  async function loadConfig() {
    const r = await fetchJSON("api/ha/config");
    if (!r.ok) {
      $("ca-no-bridge").hidden = false;
      $("ca-bridge-detail").textContent = r.body.detail || r.body.error || `HTTP ${r.status}`;
      $("ca-form").hidden = true;
      return;
    }
    if (!r.body.found) {
      $("ca-no-integration").hidden = false;
      $("ca-form").hidden = true;
      return;
    }
    host = r.body.host || null;
    const opts = r.body.options || {};
    const ca = opts.charge_assistant || {};
    // Top-level integration tunables (not under charge_assistant).
    const pi = $("poll_interval");
    if (pi) pi.value = opts.poll_interval == null ? "" : opts.poll_interval;
    applyConfig(ca);
    $("ca-form").hidden = false;
    $("ca-actionbar").hidden = false;
    snapshotSaved();   // form now mirrors the saved config → Active-now + clean
    loadOwner();
  }

  // Charge-control owner — read the gateway's current value and reflect it in
  // the dropdown. Settable here (writes straight to the gateway via the
  // /api/control_owner proxy) so the user never opens the gateway's own page.
  async function loadOwner() {
    const sel = $("ctrl-owner-select");
    const r = await fetchJSON("api/status");
    const owner = r.ok && r.body ? (r.body.control_owner || "") : "";
    ownerState = owner || null;
    if (sel && owner) sel.value = owner;
    // Capability gating: the original Zentri Pulsar can't do live current
    // control over BLE — disable dynamic-current for it.
    applyCapabilities(r.ok && r.body ? !!r.body.zentri : false);
    updateOwnerWarn();
    updateSummary();
  }

  // Write the owner to the gateway. Returns true on success.
  async function setOwner(owner) {
    const r = await fetchJSON("api/control_owner", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "owner=" + encodeURIComponent(owner),
    });
    if (r.ok && r.body && r.body.ok) {
      ownerState = owner;
      const sel = $("ctrl-owner-select");
      if (sel) sel.value = owner;
      updateOwnerWarn();
      updateSummary();
      return true;
    }
    return false;
  }

  function applyCapabilities(isZentri) {
    const warn = $("ca-dyn-warn");
    const dyn = $("solar_dynamic");
    if (warn) warn.hidden = !isZentri;
    if (dyn && isZentri) {
      dyn.checked = false;
      dyn.disabled = true;
    } else if (dyn) {
      dyn.disabled = false;
    }
  }

  function applyConfig(ca) {
    // scalar + entity fields
    Object.entries(FIELDS).forEach(([fid, key]) => {
      const el = $(fid);
      if (!el) return;
      const v = ca[key];
      el.value = v == null ? "" : v;
    });
    // checkboxes
    Object.entries(CHECKS).forEach(([fid, key]) => {
      const el = $(fid);
      if (el) el.checked = !!ca[key];
    });
    // triggers
    const trigs = Array.isArray(ca.triggers) ? ca.triggers : [];
    TRIGGERS.forEach((t) => {
      const cb = $(`trig-${t}`);
      if (cb) cb.checked = trigs.includes(t);
    });
    refreshTriggerBodies();
    toggleScheduledWithin();
    toggleCheapest();
    // Surplus-source defaults (entity mode; grid-export-negative defaults on).
    if (!$("surplus_source").value) $("surplus_source").value = "entity";
    $("grid_export_negative").checked = ca.grid_export_negative !== false;
    toggleSurplusSource();
    // smart_solar surplus source mirrors the solar one (own fields).
    if ($("surplus_source_ss") && !$("surplus_source_ss").value) $("surplus_source_ss").value = "entity";
    if ($("grid_export_negative_ss")) $("grid_export_negative_ss").checked = ca.grid_export_negative !== false;
    toggleSurplusSourceSS();
    // Auto-start grace + charging window (shared acting-mode card).
    if ($("autostart_grace_min")) $("autostart_grace_min").value = ca.autostart_grace_min || 0;
    Object.entries(WINDOW_FIELDS).forEach(([fid, key]) => {
      const el = $(fid); if (el) el.value = ca[key] == null ? "" : ca[key];
    });
    Object.entries(WINDOW_CHECKS).forEach(([fid, key]) => {
      const el = $(fid); if (el) el.checked = !!ca[key];
    });
    toggleWindow();
    // Plug-in reminder layer (nested `reminder` sub-dict).
    const rl = (ca.reminder && typeof ca.reminder === "object") ? ca.reminder : {};
    if ($("rl_enabled")) $("rl_enabled").checked = !!rl.enabled;
    RL_TRIGGERS.forEach((t) => {
      const cb = $(`rl-trig-${t}`);
      if (cb) cb.checked = Array.isArray(rl.triggers) && rl.triggers.includes(t);
    });
    Object.entries(RL_FIELDS).forEach(([fid, key]) => {
      const el = $(fid); if (el) el.value = rl[key] == null ? "" : rl[key];
    });
    toggleReminderLayer();
    refreshRLTriggerBodies();
    refreshAllCombos();   // sync combobox displays/chips to the loaded values
    pickerSelects().forEach((s) => updateLive(s.id));
    selectMode(ca.mode || "off", { fromLoad: true });
  }

  // ── mode + conditional UI ───────────────────────────────────────
  const MODE_NAMES = { off: "Off", reminder: "Reminder", target_soc: "Smart charge", solar: "Solar", smart_solar: "Smart + Solar" };

  function selectMode(mode, opts) {
    if (!MODE_KEYS[mode]) mode = "off";
    currentMode = mode;
    document.querySelectorAll(".ca-mode").forEach((el) => {
      el.classList.toggle("active", el.dataset.mode === mode);
    });
    document.querySelectorAll(".ca-mode-section").forEach((el) => {
      el.classList.toggle("ca-active", el.dataset.section === mode);
    });
    // Shared acting-mode cards. data-acting = ANY acting strategy (e.g. the
    // plug-in reminder layer). data-modes = only the listed strategies (the
    // grace + window cards: pure Solar uses neither, so they hide there).
    const acting = ACTING_MODES.includes(mode);
    document.querySelectorAll("[data-acting]").forEach((el) => { el.hidden = !acting; });
    document.querySelectorAll("[data-modes]").forEach((el) => {
      el.hidden = !el.dataset.modes.split(",").map((s) => s.trim()).includes(mode);
    });
    // The window only gates GRID charging in Smart+Solar — solar still charges
    // on surplus anytime — so a night window must not read as "blocks solar".
    const wd = $("window-desc");
    if (wd) wd.textContent = (mode === "smart_solar")
      ? "Limits GRID top-up to cheap hours (e.g. midnight–6am). Solar still charges anytime there's surplus."
      : "Restrict charging to cheap hours (e.g. midnight–6am) so it never runs when power is expensive.";
    const form = $("ca-form");
    if (form) form.dataset.mode = mode;
    const pill = $("ca-mode-pill");
    if (pill) { pill.textContent = MODE_NAMES[mode] || ""; pill.hidden = (mode === "off"); }
    // On a user click (not initial load), seed empty fields with smart defaults.
    if (!(opts && opts.fromLoad)) applyDefaults(mode);
    updateOwnerWarn();
    updateSummary();
  }

  function applyDefaults(mode) {
    const d = DEFAULTS[mode];
    if (!d) return;
    const section = document.querySelector(`.ca-mode-section[data-section="${mode}"]`);
    Object.entries(FIELDS).forEach(([fid, key]) => {
      if (!(key in d)) return;
      const el = $(fid);
      if (!el || (section && !section.contains(el))) return;
      if (el.value === "" || el.value == null) el.value = d[key];
    });
  }

  // Acting modes (target/solar) only run when the gateway hands us control.
  function updateOwnerWarn() {
    const warn = $("ca-owner-warn");
    if (!warn) return;
    const acting = currentMode === "target_soc" || currentMode === "solar";
    const blocked = acting && ownerState && ownerState !== "integration";
    warn.hidden = !blocked;
    if (blocked) $("ca-owner-cur").textContent = OWNER_NAMES[ownerState] || ownerState;
  }

  // Live plain-English summary of what the assistant will do.
  function updateSummary() {
    updatePriceForecastHint();
    const box = $("ca-summary");
    const out = $("ca-summary-text");
    if (box && out) {
      const html = buildSummary();
      if (!html) { box.hidden = true; }
      else { box.hidden = false; out.innerHTML = html; }
    }
    checkDirty();
  }

  // ── saved vs. being-edited ──────────────────────────────────────
  // A stable signature of the config the form currently describes. Compared to
  // the saved signature to detect unsaved changes. Object key order from
  // gather() + FIELDS iteration is deterministic, so JSON string compare works.
  function signature() {
    const ca = gather();
    const pi = $("poll_interval");
    const poll = pi && pi.value !== "" && Number.isFinite(Number(pi.value)) ? Number(pi.value) : null;
    return JSON.stringify({ ca, poll });
  }

  // Capture the current form as "saved" — after load and after a successful
  // save. Renders the Active-now line and resets the dirty state to clean.
  function snapshotSaved() {
    savedCa = gather();
    savedSig = signature();
    renderActive();
    setDirty(false);
  }

  function checkDirty() {
    if (savedSig == null) return;        // nothing snapshotted yet (initial load)
    setDirty(signature() !== savedSig);
  }

  function setDirty(dirty) {
    isDirty = dirty;
    const d = $("ca-dirty");
    if (d) {
      d.textContent = dirty ? "● Unsaved changes" : "✓ Up to date";
      d.className = "ca-dirty " + (dirty ? "dirty" : "clean");
    }
    const tag = $("ca-summary-tag");
    if (tag) tag.hidden = !dirty;        // mark the live summary as a preview while dirty
    const save = $("ca-save");
    if (save) save.disabled = !dirty;    // nothing to save when the form matches saved
    const bar = $("ca-actionbar");
    if (bar) bar.classList.toggle("has-changes", dirty);
  }

  // Render the "Active now" line from the SAVED config (not the live form),
  // using the shared summary module so it matches the dashboard card exactly.
  function renderActive() {
    const box = $("ca-active");
    const txt = $("ca-active-text");
    if (!box || !txt || !window.CASummary) return;
    txt.textContent = CASummary.text(savedCa, nameOf);
    box.hidden = false;
  }

  function buildSummary() {
    const b = (s) => `<b>${esc(s)}</b>`;
    if (currentMode === "off") return "";

    if (currentMode === "reminder") {
      const on = TRIGGERS.filter((t) => { const cb = $(`trig-${t}`); return cb && cb.checked; });
      if (!on.length) return "Pick at least one trigger above to get reminders.";
      const parts = on.map((t) => {
        if (t === "arrival") return `when ${b(nameOf($("arrival_entity").value) || "someone")} gets home`;
        if (t === "nightly") return `every night at ${b($("nightly_time").value || "a set time")}`;
        if (t === "lead") { const h = $("lead_hours").value; return `${b(h ? h + "h" : "a few hours")} before a scheduled charge`; }
        if (t === "tariff") return `when the price drops to ${b($("tariff_below").value || "your threshold")}`;
        return "";
      });
      let s = `If the car isn't plugged in, I'll remind you ${joinList(parts)}`;
      const svc = $("notify_service").value;
      s += svc ? ` via ${b(svc)}.` : ".";
      const conds = [];
      if ($("skip_above_pct").value) conds.push(`already above ${b($("skip_above_pct").value + "%")}`);
      if ($("quiet_start").value && $("quiet_end").value) conds.push(`between ${b($("quiet_start").value)} and ${b($("quiet_end").value)}`);
      if ($("only_if_scheduled").checked) s += " Only when a charge is scheduled soon.";
      if (conds.length) s += ` I'll stay quiet if the battery is ${conds.join(" or ")}.`;
      return s;
    }

    if (currentMode === "target_soc") {
      const soc = $("soc_entity_t").value;
      if (!soc) return "Pick a battery-level entity so I know when to stop.";
      let s = `I'll charge up to ${b(($("target_soc_pct").value || "80") + "%")}`;
      if ($("departure_time").value) s += `, ready by ${b($("departure_time").value)}`;
      s += `, reading ${b(nameOf(soc))}`;
      const live = liveOf(soc);
      if (live) s += ` (now ${b(live)})`;
      s += ".";
      if ($("cheapest_window").checked) {
        const pe = $("price_entity").value;
        const e = pe ? entById[pe] : null;
        if (pe && e && e.has_forecast) {
          s += ` I'll charge only in the cheapest hours from ${b(nameOf(pe))}, but always ready in time.`;
        } else if (pe) {
          s += " (Cheapest-hours is on, but that price sensor has no forecast — I'll just charge in time for departure.)";
        } else {
          s += " Pick a price forecast entity to charge in the cheapest hours.";
        }
      } else if ($("target_autostart").checked) {
        s += " I'll also start charging when it drops below target.";
      } else {
        s += " I'll stop at the target but won't auto-start.";
      }
      return s + windowClause() + reminderLayerClause();
    }

    if (currentMode === "solar") {
      const src = ($("surplus_source").value) || "entity";
      let label = null, liveEnt = null;
      if (src === "grid") {
        const ge = $("grid_entity").value;
        if (ge) { label = "surplus from " + nameOf(ge); liveEnt = ge; }
      } else if (src === "solar_load") {
        const se = $("solar_entity").value, le = $("load_entity").value;
        if (se && le) label = nameOf(se) + " − " + nameOf(le);
      } else {
        const sp = $("surplus_entity").value;
        if (sp) { label = nameOf(sp); liveEnt = sp; }
      }
      if (!label) return "Pick your surplus source to follow.";
      let s = `I'll charge when ${b(label)} rises to ${b($("surplus_start").value || "the start")}`;
      const live = liveEnt ? liveOf(liveEnt) : null;
      if (live) s += ` (now ${b(live)})`;
      s += `, and pause when it falls to ${b($("surplus_stop").value || "the stop")}.`;
      if ($("solar_dynamic").checked) {
        s += ` I'll modulate the current ${b(($("min_current_a").value || "6") + "–" + ($("max_current_a").value || "32") + " A")} to track the surplus`;
        s += $("load_limit_w").value && Number($("load_limit_w").value) > 0
          ? `, keeping total house draw under ${b($("load_limit_w").value + " W")}.` : ".";
      }
      return s + windowClause() + reminderLayerClause();
    }

    if (currentMode === "smart_solar") {
      const soc = $("soc_entity_ss").value;
      if (!soc) return "Pick a battery-level entity so I know when to stop.";
      let s = `I'll charge up to ${b(($("target_soc_pct_ss").value || "80") + "%")} on ${b(nameOf(soc))}`;
      const live = liveOf(soc);
      if (live) s += ` (now ${b(live)})`;
      s += ", from <b>solar surplus</b> whenever it's available";
      if ($("departure_time_ss").value) {
        s += `, topping up from grid only as needed to be ready by ${b($("departure_time_ss").value)}`;
      } else {
        s += ", topping up from grid inside your window";
      }
      s += ".";
      return s + windowClause() + reminderLayerClause();
    }
    return "";
  }

  function joinList(parts) {
    if (parts.length === 1) return parts[0];
    if (parts.length === 2) return `${parts[0]} or ${parts[1]}`;
    return parts.slice(0, -1).join(", ") + ", or " + parts[parts.length - 1];
  }

  function refreshTriggerBodies() {
    document.querySelectorAll(".ca-trigger").forEach((el) => {
      const cb = $(`trig-${el.dataset.trigger}`);
      el.classList.toggle("on", !!(cb && cb.checked));
    });
  }

  function toggleScheduledWithin() {
    const w = $("scheduled_within_wrap");
    if (w) w.hidden = !$("only_if_scheduled").checked;
  }

  function toggleCheapest() {
    const w = $("cheapest-wrap");
    if (w) w.hidden = !$("cheapest_window").checked;
    updatePriceForecastHint();
  }

  function toggleSurplusSource() {
    const src = ($("surplus_source") || {}).value || "entity";
    document.querySelectorAll(".ss-block").forEach((el) => { el.hidden = el.dataset.ss !== src; });
  }
  function toggleSurplusSourceSS() {
    const src = ($("surplus_source_ss") || {}).value || "entity";
    document.querySelectorAll(".ss-block-ss").forEach((el) => { el.hidden = el.dataset.ssx !== src; });
  }

  function toggleWindow() {
    const w = $("window-wrap");
    if (w) w.hidden = !($("window_enabled") && $("window_enabled").checked);
  }

  function toggleReminderLayer() {
    const w = $("rl-wrap");
    if (w) w.hidden = !($("rl_enabled") && $("rl_enabled").checked);
  }
  function refreshRLTriggerBodies() {
    document.querySelectorAll("[data-rl-trigger]").forEach((el) => {
      const cb = $(`rl-trig-${el.dataset.rlTrigger}`);
      el.classList.toggle("on", !!(cb && cb.checked));
    });
  }

  // Plain-English clause for the plug-in reminder layer, appended to acting
  // strategies' summaries.
  function reminderLayerClause() {
    const en = $("rl_enabled");
    if (!en || !en.checked) return "";
    const on = RL_TRIGGERS.filter((t) => { const cb = $(`rl-trig-${t}`); return cb && cb.checked; });
    if (!on.length) return " It'll also remind you to plug in (pick when).";
    const b = (s) => `<b>${esc(s)}</b>`;
    const parts = on.map((t) => {
      if (t === "arrival") return "you get home";
      if (t === "nightly") { const v = $("nightly_time_l").value; return v ? `nightly at ${b(v)}` : "nightly"; }
      if (t === "lead") return "before a scheduled charge";
      if (t === "tariff") return "the price drops";
      return "";
    });
    let s = " It'll also remind you to plug in when " + joinList(parts);
    const svc = $("notify_service_l").value;
    s += svc ? ` via ${b(svc)}.` : ".";
    return s;
  }

  // Plain-English clause for the allowed charging window, appended to acting
  // strategies' summaries.
  function windowClause() {
    const en = $("window_enabled");
    if (!en || !en.checked) return "";
    const a = $("window_start").value, b = $("window_end").value;
    if (!a || !b) return " Charging is limited to a set window (set the times).";
    let s = ` Charges only between <b>${esc(a)}–${esc(b)}</b>`;
    const extra = [];
    if ($("window_prestart").checked) extra.push("starting earlier if needed for departure");
    if ($("window_overrun").checked) extra.push("finishing late if the target isn't reached");
    if (extra.length) s += ", " + extra.join(" and ");
    s += ".";
    return s;
  }

  // Be honest about forecast availability — cheapest-window is impossible
  // without one, and many price sensors don't publish a forecast.
  function updatePriceForecastHint() {
    const hint = $("price-forecast-hint");
    if (!hint) return;
    const sel = $("price_entity");
    const eid = sel ? sel.value : "";
    const e = eid ? entById[eid] : null;
    hint.classList.remove("hint-warn", "hint-ok");
    if (!eid) {
      hint.textContent = "Needs a sensor that publishes a price forecast (Amber, Nord Pool, Tibber…).";
    } else if (e && e.has_forecast) {
      hint.textContent = "✓ Forecast detected — cheapest-window will plan against it.";
      hint.classList.add("hint-ok");
    } else {
      hint.textContent = "⚠ No price forecast on this sensor — cheapest-window can't plan ahead. "
        + "It falls back to charging just-in-time for your departure. Pick a forecast sensor for real savings.";
      hint.classList.add("hint-warn");
    }
  }

  // ── gather + save ───────────────────────────────────────────────
  function readField(fid) {
    const el = $(fid);
    if (!el) return undefined;
    const key = FIELDS[fid];
    let v = el.value;
    if (v === "" || v == null) return undefined;
    if (NUM_KEYS.has(key)) {
      const n = Number(v);
      return Number.isFinite(n) ? n : undefined;
    }
    return v;
  }

  function gather() {
    const ca = { mode: currentMode };
    if (currentMode === "off") return ca;

    if (currentMode === "reminder") {
      ca.triggers = TRIGGERS.filter((t) => { const cb = $(`trig-${t}`); return cb && cb.checked; });
    }

    const wanted = new Set(MODE_KEYS[currentMode]);
    // scalar/entity fields — read only the field id that lives in the active
    // mode's section. Several keys (notify_service, soc_entity) have a distinct
    // field id per mode; scoping to the active section picks the right one and
    // ignores the others' (empty) inputs.
    const activeSection = document.querySelector(`.ca-mode-section[data-section="${currentMode}"]`);
    Object.entries(FIELDS).forEach(([fid, key]) => {
      if (!wanted.has(key)) return;
      const el = $(fid);
      if (!el) return;
      if (activeSection && !activeSection.contains(el)) return;
      const v = readField(fid);
      if (v !== undefined) ca[key] = v;
    });
    // checkboxes for this mode — section-scoped, since some keys (e.g.
    // grid_export_negative) have a distinct field id per mode.
    Object.entries(CHECKS).forEach(([fid, key]) => {
      if (!wanted.has(key)) return;
      const el = $(fid);
      if (!el) return;
      if (activeSection && !activeSection.contains(el)) return;
      ca[key] = !!el.checked;
    });
    // Shared acting-mode cards (not section-scoped): charging window + the
    // plug-in reminder layer (nested `reminder` sub-dict).
    if (ACTING_MODES.includes(currentMode)) {
      const gm = $("autostart_grace_min");
      if (gm) ca.autostart_grace_min = Math.max(0, Number(gm.value) || 0);
      Object.entries(WINDOW_FIELDS).forEach(([fid, key]) => {
        const el = $(fid); if (el && el.value) ca[key] = el.value;
      });
      Object.entries(WINDOW_CHECKS).forEach(([fid, key]) => {
        const el = $(fid); if (el) ca[key] = !!el.checked;
      });
      if ($("rl_enabled") && $("rl_enabled").checked) {
        const rl = {
          enabled: true,
          triggers: RL_TRIGGERS.filter((t) => { const cb = $(`rl-trig-${t}`); return cb && cb.checked; }),
        };
        Object.entries(RL_FIELDS).forEach(([fid, key]) => {
          const el = $(fid);
          if (!el || el.value === "" || el.value == null) return;
          if (RL_NUM.has(key)) {
            const n = Number(el.value);
            if (Number.isFinite(n)) rl[key] = n;
          } else {
            rl[key] = el.value;
          }
        });
        ca.reminder = rl;
      } else {
        ca.reminder = { enabled: false };
      }
    }
    return ca;
  }

  async function save() {
    const status = $("ca-save-status");
    status.className = "ca-save-status";
    status.textContent = "Saving…";
    const ca = gather();
    const options = { charge_assistant: ca };
    // Top-level integration tunables ride along in the same merge.
    const pi = $("poll_interval");
    if (pi && pi.value !== "") {
      const n = Number(pi.value);
      if (Number.isFinite(n)) options.poll_interval = n;
    }
    const payload = { options };
    if (host) payload.host = host;
    const r = await fetchJSON("api/ha/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (r.ok && r.body.ok) {
      status.className = "ca-save-status ok";
      status.textContent = "Saved — assistant reloaded.";
      snapshotSaved();   // this config is now the saved one → Active-now + clean
      const overview = (buildSummary() || "").replace(/<[^>]+>/g, "").trim();
      showToast("✓ Saved. " + (overview || "Assistant is off — nothing automated."), "ok");
      maybePromptOwner();   // offer to hand control to HA if an acting mode needs it
    } else {
      const msg = "Save failed: " + (r.body.detail || r.body.error || `HTTP ${r.status}`);
      status.className = "ca-save-status err";
      status.textContent = msg;
      showToast("⚠ " + msg, "err");
    }
  }

  // After saving an acting mode, if the gateway owner isn't the integration,
  // the assistant won't actually control charging — offer to fix that here so
  // the user never has to open the gateway's own settings page.
  function maybePromptOwner() {
    if (!ACTING_MODES.includes(currentMode)) return;
    if (ownerState === "integration") return;
    showOwnerPrompt();
  }

  function showOwnerPrompt() {
    const old = $("ca-owner-prompt");
    if (old) old.remove();
    const cur = ownerState ? (OWNER_NAMES[ownerState] || ownerState) : "not set";
    const m = document.createElement("div");
    m.id = "ca-owner-prompt";
    m.className = "ca-modal";
    m.innerHTML =
      '<div class="ca-modal-box" role="dialog" aria-modal="true">' +
      '<h3>Let Home Assistant control charging?</h3>' +
      '<p>This mode drives charging, but the gateway’s control owner is ' +
      '<b>' + esc(cur) + '</b> — so the assistant won’t act yet. ' +
      'Hand charge control to Home Assistant now?</p>' +
      '<div class="ca-modal-btns">' +
      '<button type="button" class="ca-btn ca-btn-ghost" data-act="no">Not now</button>' +
      '<button type="button" class="ca-btn ca-btn-primary" data-act="yes">Enable HA control</button>' +
      '</div></div>';
    document.body.appendChild(m);
    m.addEventListener("click", async (e) => {
      if (e.target === m || e.target.dataset.act === "no") { m.remove(); return; }
      if (e.target.dataset.act === "yes") {
        e.target.disabled = true;
        const ok = await setOwner("integration");
        m.remove();
        showToast(ok ? "✓ Home Assistant now controls charging."
                     : "⚠ Couldn’t set the owner on the gateway.", ok ? "ok" : "err");
      }
    });
  }

  let _toastTimer = null;
  function showToast(msg, kind) {
    let t = $("ca-toast");
    if (!t) {
      t = document.createElement("div");
      t.id = "ca-toast";
      document.body.appendChild(t);
    }
    t.textContent = msg;
    t.className = "ca-toast " + (kind || "") + " show";
    clearTimeout(_toastTimer);
    _toastTimer = setTimeout(() => { t.className = "ca-toast " + (kind || ""); }, 3200);
  }

  // ── wire up ─────────────────────────────────────────────────────
  function wire() {
    document.querySelectorAll(".ca-mode").forEach((el) => {
      el.addEventListener("click", () => selectMode(el.dataset.mode));
    });
    TRIGGERS.forEach((t) => {
      const cb = $(`trig-${t}`);
      if (cb) cb.addEventListener("change", () => { refreshTriggerBodies(); updateSummary(); });
    });
    $("only_if_scheduled").addEventListener("change", () => { toggleScheduledWithin(); updateSummary(); });
    $("cheapest_window").addEventListener("change", () => { toggleCheapest(); updateSummary(); });
    $("surplus_source").addEventListener("change", () => { toggleSurplusSource(); updateSummary(); });
    const sss = $("surplus_source_ss");
    if (sss) sss.addEventListener("change", () => { toggleSurplusSourceSS(); updateSummary(); });
    const os = $("ctrl-owner-select");
    if (os) os.addEventListener("change", async () => {
      const v = os.value;
      const ok = await setOwner(v);
      if (ok) showToast("✓ Charge-control owner set to " + (OWNER_NAMES[v] || v), "ok");
      else { showToast("⚠ Couldn't set the owner on the gateway.", "err"); if (ownerState) os.value = ownerState; }
    });
    const we = $("window_enabled");
    if (we) we.addEventListener("change", () => { toggleWindow(); updateSummary(); });
    const rle = $("rl_enabled");
    if (rle) rle.addEventListener("change", () => { toggleReminderLayer(); updateSummary(); });
    RL_TRIGGERS.forEach((t) => {
      const cb = $(`rl-trig-${t}`);
      if (cb) cb.addEventListener("change", () => { refreshRLTriggerBodies(); updateSummary(); });
    });
    const hu = $("ca-hide-unavail");
    if (hu) hu.addEventListener("change", (e) => { hideUnavailable = e.target.checked; });
    // Any field edit re-renders the live summary — the always-on feedback that
    // makes this clearer than HA's blind native options flow.
    const form = $("ca-form");
    form.addEventListener("input", updateSummary);
    form.addEventListener("change", updateSummary);
    $("ca-save").addEventListener("click", save);
    $("ca-reload").addEventListener("click", () => init());
  }

  async function loadNotifyServices() {
    const r = await fetchJSON("api/ha/notify_services");
    notifyServices = (r.ok && r.body.services) || [];
  }

  // Warn (and explain) when the Add-on has no gateway IP configured — the
  // assistant can't read charger state or drive charging without it.
  async function loadAddonConfig() {
    const r = await fetchJSON("api/addon/config");
    const warn = $("ca-no-gateway");
    if (!warn) return;
    const configured = !!(r.ok && r.body && r.body.configured);
    warn.hidden = configured;
  }

  async function init() {
    $("ca-no-bridge").hidden = true;
    $("ca-no-integration").hidden = true;
    const ok = await loadEntities();
    if (!ok) return;
    await loadNotifyServices();   // before combobox setup so notify list is ready
    setupComboboxes();
    applyTooltips();
    loadAddonConfig();            // best-effort gateway-config warning
    await loadConfig();
  }

  document.addEventListener("DOMContentLoaded", () => {
    wire();
    init();
  });
})();
