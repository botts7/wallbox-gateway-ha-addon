// v0.2 Add-on dashboard.
//
// HA Supervisor ingress: this Add-on is served under a path like
// /api/hassio_ingress/<uuid>/ — absolute URLs (/api/status) would
// route to HA Core's domain root, NOT this Add-on. All fetch paths
// are therefore RELATIVE so the browser appends them to the current
// ingress base URL.

const POLL_MS = 10_000;

const $ = (id) => document.getElementById(id);
const setText = (id, v) => { const el = $(id); if (el) el.textContent = (v ?? '--'); };
const setClass = (id, cls) => { const el = $(id); if (el) el.className = cls; };
const showCard = (id, show) => { const el = $(id); if (el) el.hidden = !show; };

let unreachableShown = false;

async function fetchJSON(path) {
  try {
    const r = await fetch(path, { cache: 'no-store' });
    const body = await r.json().catch(() => ({}));
    return { ok: r.ok, status: r.status, body };
  } catch (e) {
    return { ok: false, status: 0, body: { error: 'fetch_failed', detail: String(e) } };
  }
}

function fmtUptime(seconds) {
  if (typeof seconds !== 'number') return '--';
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

// Charge-reminder banner (#127). next_scheduled_charge (UTC epoch) +
// plug_reminder come straight from /api/status — gateway-computed, no
// charger round-trip. Times render in the browser's locale.
function fmtChargeTime(epoch) {
  try {
    return new Date(epoch * 1000).toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' });
  } catch (e) {
    return new Date(epoch * 1000).toLocaleString();
  }
}
// #129: hide the Mains/House tiles when the charger has no power meter
// (Power Boost absent — r_dca reports unsupported). meter===undefined
// (older gateway firmware) is treated as present, so nothing hides.
function applyMeterCapability(meter) {
  const hide = (meter === false);
  ['stat-mains-tile', 'stat-house-tile'].forEach((id) => {
    const el = $(id);
    if (el) el.style.display = hide ? 'none' : '';
  });
}
// Charge-control owner banner. control_owner (from /api/status) says who may
// drive charging; an external owner pauses the charger's own schedules.
const _CO_INFO = {
  integration: { icon: '\u{1F3E0}', title: 'Controlled by Home Assistant',
    detail: 'The integration’s Charge Assistant is in control — the charger’s own schedules are paused while it manages charging.' },
  addon: { icon: '\u{1F9E9}', title: 'Controlled by the Add-on',
    detail: 'The Add-on is managing charging — the charger’s own schedules are paused.' },
  none: { icon: '\u{1F590}\u{FE0F}', title: 'Manual control only',
    detail: 'No automation is managing charging — schedules are off; start/stop manually or on plug-in.' },
};
// Live "charging now" banner — driven by /api/status charging_now from the
// firmware's charge-interval tracker. Energy is being recorded at the real
// time of day, so cost/heatmap land in the right tariff band.
function updateChargingNow(s) {
  const el = $('charging-banner');
  if (!el) return;
  if (s && s.charging_now) {
    el.style.display = '';
    const det = $('charging-detail');
    if (det) det.textContent = 'Recording this charge at the real time of day for accurate cost.';
  } else {
    el.style.display = 'none';
  }
}
function updateControlOwner(s) {
  const el = $('control-owner');
  if (!el) return;
  const owner = s && s.control_owner;
  const info = _CO_INFO[owner];
  if (!info) { el.hidden = true; return; }   // wallbox_schedule / unknown -> hidden
  el.className = 'banner';
  setText('co-icon', info.icon);
  setText('co-title', info.title);
  setText('co-detail', info.detail);
  el.hidden = false;
}
function updateChargeReminder(s) {
  const el = $('charge-reminder');
  const nav = $('nav-next');
  // Don't trust plug/schedule state when the charger link is down.
  if (!s || s.ble !== 'connected') {
    if (el) el.style.display = 'none';
    if (nav) nav.hidden = true;
    return;
  }
  const nsc = s.next_scheduled_charge;
  // Nav bar: the routine "next scheduled charge" time (informational).
  if (nav) {
    if (nsc) { setText('nav-next-time', fmtChargeTime(nsc)); nav.hidden = false; }
    else nav.hidden = true;
  }
  // Banner: reserved for the plug-in WARNING only (the routine reminder now
  // lives in the nav bar, so it doesn't take a full banner row).
  if (el) {
    if (s.plug_reminder) {
      el.className = 'banner banner-warn';
      setText('charge-reminder-icon', '\u{1F50C}');
      setText('charge-reminder-title', 'Not plugged in');
      setText('charge-reminder-detail',
        nsc ? `Scheduled charge at ${fmtChargeTime(nsc)} — connect the cable so it can start.`
            : 'A scheduled charge is due soon — connect the cable so it can start.');
      el.style.display = '';
    } else {
      el.style.display = 'none';
    }
  }
}
// Week/month cost tiles — the Sessions page owns the tariff + cost engine and
// publishes its computed summary to localStorage; we only display it (no
// duplicated cost math). Hidden until a tariff has been set on Sessions.
function updateCostTiles() {
  let sum = null;
  try { sum = JSON.parse(localStorage.getItem('wb-addon-cost-summary')); } catch (e) {}
  const wt = $('stat-weekcost-tile'), mt = $('stat-monthcost-tile');
  // Always show the tiles so the grid never has a hole; when no tariff is set
  // yet, show a "set on Sessions" hint instead of a number.
  if (wt) wt.hidden = false;
  if (mt) mt.hidden = false;
  if (sum && typeof sum.weekCost === 'number' && typeof sum.monthCost === 'number') {
    const cur = sum.currency || '$';
    setText('stat-weekcost', cur + sum.weekCost.toFixed(2));
    setText('stat-monthcost', cur + sum.monthCost.toFixed(2));
    [wt, mt].forEach((el) => el && el.classList.remove('stat-unset'));
  } else {
    setText('stat-weekcost', 'Set tariff');
    setText('stat-monthcost', 'on Sessions');
    [wt, mt].forEach((el) => el && el.classList.add('stat-unset'));
  }
}

// Charger-status code -> hero text + state class.
// Mirrors STATUS_CODES from the gateway firmware (BAPI 0..18).
const HERO_STATES = {
  0:  { text: 'Ready',                  cls: '' },
  1:  { text: 'Charging',               cls: 'is-charging' },
  2:  { text: 'Connected — waiting',    cls: '' },
  3:  { text: 'Connected — scheduled',  cls: '' },
  4:  { text: 'Paused',                 cls: '' },
  5:  { text: 'Charge complete',        cls: 'is-charging' },
  6:  { text: 'Locked',                 cls: '' },
  7:  { text: 'Error',                  cls: 'is-error' },
  8:  { text: 'Waiting for current',    cls: '' },
  9:  { text: 'Power sharing unconfig', cls: 'is-error' },
  10: { text: 'Queued (Power Boost)',   cls: '' },
  11: { text: 'Discharging',            cls: 'is-charging' },
  12: { text: 'Waiting for admin (MID)',cls: '' },
  13: { text: 'MID margin exceeded',    cls: 'is-error' },
  14: { text: 'OCPP unavailable',       cls: 'is-error' },
  15: { text: 'OCPP finishing',         cls: '' },
  16: { text: 'OCPP reserved',          cls: '' },
  17: { text: 'Updating firmware',      cls: '' },
  18: { text: 'Queued (Eco-Smart)',     cls: '' },
};

// The original/Zentri Pulsar reports a small status enum that doesn't line up
// with the MAX 0..18 codes (esp. st4 = charge ramp, not "Paused"). Used in
// place of HERO_STATES when /api/status reports zentri:true.
const HERO_STATES_ZENTRI = {
  0: { text: 'Ready',                 cls: '' },
  1: { text: 'Charging',              cls: 'is-charging' },
  2: { text: 'Connected',             cls: '' },
  3: { text: 'Connected — scheduled', cls: '' },
  4: { text: 'Starting',              cls: 'is-charging' },
};

// ---- Power Flow card (matches the gateway's own dashboard) ----
// Grid -> Charger -> Vehicle. cp = charging power (vehicle kW), house =
// grid kW, conn = car connected (status-code derived, mirrors firmware
// carConnected()). The Vehicle node swaps to "Plug in" when not connected.
const _pf = { cp: null, en: null, conn: null, green: null, grid: null, charged: null };
function carConn(st) { return [1, 2, 3, 4, 5, 8, 10, 11, 12, 13, 18].indexOf(st) !== -1; }
function pfAnimate(el, on, kw) {
  if (!el) return;
  if (on) {
    const dur = Math.max(500, 1400 - (kw || 0) * 100);
    if (el._anim && Math.abs((el._animDur || 0) - dur) > 50) { el._anim.cancel(); el._anim = null; }
    if (!el._anim) {
      el._anim = el.animate([{ strokeDashoffset: 0 }, { strokeDashoffset: -26 }], { duration: dur, iterations: Infinity });
      el._animDur = dur;
    }
  } else if (el._anim) { el._anim.cancel(); el._anim = null; el._animDur = 0; }
}
function pfRender() {
  const g = _pf.green, gr = _pf.grid, cp = _pf.cp;
  const fmt = (v) => (typeof v === 'number') ? v.toFixed(2) + ' kWh' : '--';
  const total = (typeof _pf.charged === 'number') ? _pf.charged
              : ((g || 0) + (gr || 0)) || null;
  setText('pf-solar-kwh', fmt(g));
  setText('pf-grid-kwh', fmt(gr));
  setText('pf-car-kwh', fmt(typeof total === 'number' ? total : null));
  setText('pf-session', fmt(typeof total === 'number' ? total : null));
  const charging = (typeof cp === 'number' && cp > 0.05);
  setText('pf-live', charging ? cp.toFixed(2) + ' kW' : '');
  // A line is lit when this session drew from that source; grid is the default
  // source while charging even before any energy has accumulated.
  const hasSolar = (g || 0) > 0.001;
  const hasGrid  = (gr || 0) > 0.001 || (charging && !hasSolar);
  const sl = $('pf-solar-line'), gl = $('pf-grid-line');
  if (sl) sl.style.opacity = hasSolar ? '1' : '0';
  if (gl) gl.style.opacity = hasGrid ? '1' : '0';
  pfAnimate(sl, charging && hasSolar, cp);
  pfAnimate(gl, charging && hasGrid, cp);
  const plug = $('pf-plugin'), ck = $('pf-car-kwh');
  if (_pf.conn === false) { if (plug) plug.style.display = ''; if (ck) ck.style.display = 'none'; }
  else { if (plug) plug.style.display = 'none'; if (ck) ck.style.display = ''; }
}
// Status text under the power-flow + the schedule-paused banner toggle.
function setStatus(stateCode, schedulePaused, zentri) {
  const info = (zentri && HERO_STATES_ZENTRI[stateCode]) || HERO_STATES[stateCode];
  const card = $('card-powerflow');
  if (card) card.className = 'card pf-card' + (info && info.cls ? ' ' + info.cls : '');
  setText('pf-status', info ? info.text : (stateCode == null ? 'Offline' : `Code ${stateCode}`));
  const banner = $('paused-banner');
  if (banner) banner.style.display = schedulePaused ? '' : 'none';
}

function setOffline() {
  const card = $('card-powerflow');
  if (card) card.className = 'card pf-card is-offline';
  setText('pf-status', 'Cannot reach the gateway');
  _pf.cp = null; _pf.en = null; _pf.conn = null;
  _pf.green = null; _pf.grid = null; _pf.charged = null;
  setText('pf-solar-kwh', '--'); setText('pf-grid-kwh', '--');
  setText('pf-car-kwh', '--'); setText('pf-session', '--'); setText('pf-live', '');
  pfRender();
  ['dot-ble', 'dot-wifi', 'dot-mqtt'].forEach(id => setClass(id, 'conn-dot is-down'));
  const banner = $('paused-banner');
  if (banner) banner.style.display = 'none';
  const cr = $('charge-reminder');
  if (cr) cr.style.display = 'none';
  const nav = $('nav-next');
  if (nav) nav.hidden = true;
  const co = $('control-owner');
  if (co) co.hidden = true;
}

async function refresh() {
  // ---- Add-on config probe (also gives us the gateway IP for the header) ----
  const cfg = await fetchJSON('api/addon/config');
  if (cfg.ok && !cfg.body.configured) {
    showCard('not-configured', true);
    return;
  }
  showCard('not-configured', false);
  if (cfg.ok) setText('gw-ip', cfg.body.gateway_ip);

  // ---- /api/status ----
  const status = await fetchJSON('api/status');
  if (!status.ok && status.body?.error === 'unreachable') {
    showCard('unreachable', true);
    setText('unreachable-ip', cfg.body?.gateway_ip ?? '?');
    unreachableShown = true;
    setOffline();
    return;
  }
  if (unreachableShown) { showCard('unreachable', false); unreachableShown = false; }

  let chargerName = '--';
  if (status.ok) {
    const s = status.body;
    chargerName = s.dev_name || '--';
    setText('charger-name', s.dev_name);
    setText('charger-fw', s.chg_app_fw);
    setText('charger-project', s.chg_project);
    setText('uptime', fmtUptime(s.uptime));
    setText('heap', s.heap != null ? `${(s.heap / 1024).toFixed(1)} KB` : '--');

    // Connection dots
    if (s.ble === 'connected') {
      setClass('dot-ble', 'conn-dot is-up');
      setText('ble-value', 'Connected');
      setText('ble-rssi', s.rssi != null ? `${s.rssi} dBm` : '--');
    } else {
      setClass('dot-ble', 'conn-dot is-down');
      setText('ble-value', s.ble || 'disconnected');
      setText('ble-rssi', '--');
    }
    if (s.wifi === 'connected') {
      setClass('dot-wifi', 'conn-dot is-up');
      setText('wifi-value', 'Connected');
      setText('wifi-ssid', s.ssid || '');
      setText('ble-value', s.ble === 'connected' ? 'Connected' : (s.ble || '--'));
      // also display WiFi RSSI in BLE row? no — WiFi has its own dBm
      const rssiText = s.wifi_rssi != null ? `${s.wifi_rssi} dBm` : '';
      const detail = $('wifi-ssid');
      if (detail) detail.textContent = (s.ssid || '') + (rssiText ? ' · ' + rssiText : '');
    } else {
      setClass('dot-wifi', 'conn-dot is-down');
      setText('wifi-value', s.wifi || 'disconnected');
      setText('wifi-ssid', '--');
    }
    updateChargeReminder(s);
    applyMeterCapability(s.meter);
    updateControlOwner(s);
    updateChargingNow(s);
    updateCostTiles();
    // Last recorded charge burst (charge-log #141) — surfaces the same datum as
    // the HA last_burst_energy / charge_log_count entities, for surface parity.
    const lbRow = $('pf-lastburst-row');
    if (lbRow) {
      const lbw = s.last_burst_wh, clc = s.charge_log_count;
      if (typeof lbw === 'number' && lbw > 0) {
        lbRow.hidden = false;
        setText('pf-lastburst', (lbw / 1000).toFixed(2) + ' kWh'
          + (typeof clc === 'number' && clc > 0 ? ` · ${clc} recorded` : ''));
      } else {
        lbRow.hidden = true;
      }
    }
  }

  // ---- /api/health ---- (we use loop_max_ms for the device info card)
  const health = await fetchJSON('api/health');
  if (health.ok) {
    setText('loop-max', health.body.loop_max_ms != null ? `${health.body.loop_max_ms} ms` : '--');
  }

  // ---- /api/diag/disconnects ---- (reconnect counters + MQTT health)
  const diag = await fetchJSON('api/diag/disconnects');
  if (diag.ok) {
    setText('ble-reconn', diag.body.ble_reconnects);
    setText('mqtt-reconn', diag.body.mqtt_reconnects);
    setText('wifi-reconn', diag.body.wifi_reconnects);
    // MQTT state inferred from recent reconnect count + uptime
    const r = diag.body.mqtt_reconnects ?? 0;
    if (r === 0) {
      setClass('dot-mqtt', 'conn-dot is-up');
      setText('mqtt-value', 'Stable');
      setText('mqtt-detail', '');
    } else {
      setClass('dot-mqtt', 'conn-dot is-warn');
      setText('mqtt-value', `${r} reconnect${r === 1 ? '' : 's'}`);
      setText('mqtt-detail', '');
    }
  }

  // ---- /api/charger ---- (hero + stats grid)
  const zentri = !!(status.ok && status.body && status.body.zentri);
  const charger = await fetchJSON('api/charger');
  // Gate on status.r (r_dat — present on every charger). realtime.r (r_sta) is
  // OPTIONAL: the original/Zentri Pulsar doesn't serve it, so gating the whole
  // hero/stats block on it would blank kW + status on that hardware.
  if (charger.ok && charger.body && charger.body.status && charger.body.status.r) {
    const st = charger.body.status.r;
    const rt = (charger.body.realtime && charger.body.realtime.r) || {};
    // Status code: r_sta.charger_status when present, else r_dat.st (Zentri,
    // which the firmware also uses for carConnected()).
    let stateCode = (typeof rt.charger_status === 'number') ? rt.charger_status
                  : (typeof st.st === 'number') ? st.st : null;
    if (zentri && typeof st.st === 'number') stateCode = st.st;
    const kw = (typeof st.cp === 'number') ? st.cp : null;
    const sessionKwh = (typeof st.en === 'number') ? st.en / 100 : null;
    const maxCur = (typeof st.cur === 'number') ? st.cur : null;
    const schedulePaused = (typeof st.gen === 'number') && st.gen !== 0;
    setStatus(stateCode, schedulePaused, zentri);
    _pf.cp = kw;
    _pf.en = (typeof st.en === 'number') ? st.en : null;
    _pf.conn = (typeof stateCode === 'number') ? carConn(stateCode) : null;
    pfRender();
    setText('stat-energy', sessionKwh != null ? sessionKwh.toFixed(2) : '--');
    setText('stat-maxcur', maxCur != null ? maxCur : '--');
    syncCurrentSlider(maxCur);
  } else {
    // BLE down or charger not responding — show offline on the power flow
    setStatus(null, false);
    _pf.cp = null; _pf.en = null; _pf.conn = null; pfRender();
    setText('stat-energy', '--');
    setText('stat-maxcur', '--');
  }

  // ---- r_lse (live session energy: solar/grid split) for the Energy flow ----
  const lse = await fetchJSON('api/sess?met=r_lse&par=null&wait=4000');
  if (lse.ok && lse.body && lse.body.r) {
    const r = lse.body.r;
    _pf.green = (typeof r.green_energy === 'number') ? r.green_energy : null;
    _pf.grid = (typeof r.grid_energy === 'number') ? r.grid_energy : null;
    _pf.charged = (typeof r.charged_energy === 'number') ? r.charged_energy : null;
    if (typeof r.charging_power === 'number' && r.charging_power > 0) _pf.cp = r.charging_power;
    pfRender();
  }

  // ---- /api/meter ---- (BAPI r_dca passthrough: mains voltage + house power)
  // Best-effort: BLE-busy gateway returns nulls, which we display as `--`.
  const meter = await fetchJSON('api/meter');
  if (meter.ok && meter.body && meter.body.r) {
    const r = meter.body.r;
    setText('stat-voltage', (typeof r.v1 === 'number') ? r.v1 : '--');
    if (typeof r.p1 === 'number') {
      const house = (r.p1 || 0) + (r.p2 || 0) + (r.p3 || 0);
      setText('stat-house', house);
    } else {
      setText('stat-house', '--');
    }
  } else {
    setText('stat-voltage', '--');
    setText('stat-house', '--');
  }
}

// ---- Controls ----
//
// All control buttons hit /api/command on the Add-on proxy, which
// whitelists action against {start, stop, lock, unlock, current,
// reboot} and forwards to the gateway. BLE-busy / unreachable
// gateway -> toast with the error; the next status poll will pick
// up the new state.

function showToast(msg, kind) {
  const t = $('ctrl-toast');
  if (!t) return;
  t.textContent = msg;
  t.className = 'ctrl-toast is-' + (kind || 'info');
  t.hidden = false;
  // auto-hide after 4s for success/info, leave error visible until next action
  if (kind !== 'err') {
    clearTimeout(t._timer);
    t._timer = setTimeout(() => { t.hidden = true; }, 4000);
  }
}

async function sendCmd(action, btn, extraQs) {
  if (btn) btn.classList.add('is-busy');
  const url = 'api/command?action=' + encodeURIComponent(action)
            + (extraQs ? '&' + extraQs : '');
  showToast(`Sending ${action}...`, 'info');
  const r = await fetchJSON(url);
  if (btn) btn.classList.remove('is-busy');
  if (!r.ok) {
    const detail = r.body?.detail || r.body?.error || ('HTTP ' + r.status);
    showToast(`${action} failed: ${detail}`, 'err');
    return;
  }
  if (r.body && r.body.error) {
    showToast(`${action} rejected: ${r.body.error}`, 'err');
    return;
  }
  showToast(`${action} OK`, 'ok');
  // Force a refresh ~1s later so the hero + connection rows reflect
  // the new state (status takes a beat to propagate from charger -> BLE).
  setTimeout(refresh, 1000);
}
window.sendCmd = sendCmd;  // exposed for the inline onclick handlers

// Resume button inside the paused-banner. Calls action=resume which
// the gateway maps to s_cmode {"mode":0} (clears r_dat.gen).
const btnResume = $('btn-resume');
if (btnResume) {
  btnResume.addEventListener('click', () => sendCmd('resume', btnResume));
}

// Max-current slider: live label + debounced send
const slider = $('cur-slider');
let _curTimer = null;
let _curSliderTouched = false;  // don't fight the poll-driven sync
if (slider) {
  slider.addEventListener('input', (e) => {
    _curSliderTouched = true;
    $('cur-value').textContent = e.target.value;
    if (_curTimer) clearTimeout(_curTimer);
    _curTimer = setTimeout(() => {
      sendCmd('current', null, 'value=' + e.target.value);
      // re-allow poll-driven sync ~3s after the user stops dragging
      setTimeout(() => { _curSliderTouched = false; }, 3000);
    }, 350);
  });
}

// Sync slider to charger's reported max current on each poll, unless
// the user is actively dragging it.
function syncCurrentSlider(amps) {
  if (!_curSliderTouched && slider && typeof amps === 'number') {
    slider.value = amps;
    $('cur-value').textContent = amps;
  }
}

// ---- Charger notifications (r_not) ----
let _notifs = [];
async function loadNotifs() {
  const r = await fetchJSON('api/notifications');
  const bar = $('notif-bar');
  if (!bar) return;
  const v = (r.ok && r.body && Array.isArray(r.body.r)) ? r.body.r : [];
  _notifs = v;
  if (v.length) { setText('notif-count', v.length); bar.hidden = false; }
  else { bar.hidden = true; }
}
function showNotifs() {
  const list = $('notif-list');
  if (!list) return;
  list.textContent = '';
  if (!_notifs.length) {
    const e = document.createElement('div'); e.className = 'notif-empty'; e.textContent = 'No notifications';
    list.appendChild(e);
  } else {
    _notifs.forEach((n, i) => {
      const msg = n.message || n.msg || n.text || JSON.stringify(n);
      const tsv = n.timestamp || n.ts;
      const row = document.createElement('div'); row.className = 'notif-item';
      const m = document.createElement('div'); m.className = 'notif-msg'; m.textContent = `#${i + 1} ${msg}`;
      row.appendChild(m);
      if (tsv) {
        const t = document.createElement('div'); t.className = 'notif-ts';
        try { t.textContent = new Date(tsv * 1000).toLocaleString(); } catch (e) { t.textContent = String(tsv); }
        row.appendChild(t);
      }
      list.appendChild(row);
    });
  }
  $('notif-modal').hidden = false;
}
(function initNotifs() {
  const bar = $('notif-bar'); if (bar) bar.addEventListener('click', showNotifs);
  const close = $('notif-close'); if (close) close.addEventListener('click', () => { $('notif-modal').hidden = true; });
  const modal = $('notif-modal');
  if (modal) modal.addEventListener('click', (e) => { if (e.target === modal) modal.hidden = true; });
})();

// ---- Charge schedules ----
//
// Reads via /api/sched?met=r_schs, writes via s_sch (insert/update, keyed by
// sid) and clr_sch ({"sid":[N]}) — the same proven shapes the gateway's own
// dashboard sends. Times are entered/displayed LOCAL and stored as the UTC
// HHMM the charger keeps (matching the gateway dashboard's conversion).
const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
let _schedules = [];
let _editingSid = null;

const pad2 = (n) => String(n).padStart(2, '0');
function localToUtc(hhmm) {            // "HH:MM" local -> "HHMM" UTC
  const p = String(hhmm).split(':');
  const d = new Date();
  d.setHours(+p[0] || 0, +p[1] || 0, 0, 0);
  return pad2(d.getUTCHours()) + pad2(d.getUTCMinutes());
}
function utcToLocal(hhmm) {            // "1400"/HHMM UTC -> "HH:MM" local
  const s = String(hhmm).padStart(4, '0');
  const d = new Date();
  d.setUTCHours(+s.slice(0, 2) || 0, +s.slice(2) || 0, 0, 0);
  return pad2(d.getHours()) + ':' + pad2(d.getMinutes());
}
function daysBitsToArray(bits) {       // bitmask (bit0=Mon..bit6=Sun) -> [0/1 x7]
  const a = []; for (let i = 0; i < 7; i++) a.push((bits >> i) & 1); return a;
}
function daysLabel(bits) {
  const on = []; for (let i = 0; i < 7; i++) if ((bits >> i) & 1) on.push(DAY_NAMES[i]);
  if (on.length === 7) return 'Every day';
  if (on.length === 0) return 'No days';
  return on.join(' ');
}

// Weekly timeline (7 days x 24h), coloured per schedule — matches the gateway.
const SCH_COLORS = ['#3b82f6', '#22c55e', '#f59e0b', '#a855f7', '#ec4899', '#06b6d4', '#84cc16', '#f97316'];
function utcHHMMtoLocalHour(hhmm) {
  const s = String(hhmm).padStart(4, '0');
  const d = new Date();
  d.setUTCHours(+s.slice(0, 2) || 0, +s.slice(2) || 0, 0, 0);
  return d.getHours() % 24;  // browser-local hour (consistent with utcToLocal)
}
function buildScheduleTimeline() {
  const wrap = $('sch-timeline-wrap'), grid = $('sch-timeline'), legend = $('sch-legend');
  if (!wrap || !grid || !legend) return;
  if (!_schedules.length) { wrap.hidden = true; return; }
  wrap.hidden = false;
  // cells[day][hour] = list of schedule indexes covering it (Mon..Sun, bit0=Mon)
  const cells = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => []));
  _schedules.forEach((s, i) => {
    if (!s.enabled) return;
    let fromH = utcHHMMtoLocalHour(s.start);
    let toH = utcHHMMtoLocalHour(s.stop);
    if (toH === fromH) toH = (fromH + 24) % 24;  // full-day block
    for (let d = 0; d < 7; d++) {
      if (!((s.days >> d) & 1)) continue;
      let h = fromH;
      while (h !== toH) { cells[d][h].push(i); h = (h + 1) % 24; }
    }
  });
  grid.textContent = '';
  const cell = (cls, text, title) => {
    const e = document.createElement('div');
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    if (title) e.title = title;
    return e;
  };
  // header: corner + hour ticks
  grid.appendChild(cell('sch-tl-hd'));
  for (let h = 0; h < 24; h++) grid.appendChild(cell('sch-tl-hd', h % 6 === 0 ? h : ''));
  // day rows
  for (let d = 0; d < 7; d++) {
    grid.appendChild(cell('sch-tl-day', DAY_NAMES[d]));
    for (let h = 0; h < 24; h++) {
      const c = cells[d][h];
      const box = cell('sch-tl-cell', null, `${DAY_NAMES[d]} ${h}:00`);
      if (c.length === 1) {
        box.style.background = SCH_COLORS[c[0] % SCH_COLORS.length];
        box.title += ` — #${_schedules[c[0]].sid}`;
      } else if (c.length > 1) {
        box.style.background = `repeating-linear-gradient(45deg,${SCH_COLORS[c[0] % SCH_COLORS.length]} 0 4px,${SCH_COLORS[c[1] % SCH_COLORS.length]} 4px 8px)`;
        box.title += ` — overlap: #${c.map((i) => _schedules[i].sid).join(', #')}`;
      }
      grid.appendChild(box);
    }
  }
  // legend
  legend.textContent = '';
  _schedules.forEach((s, i) => {
    if (!s.enabled) return;
    const item = document.createElement('span'); item.className = 'sch-tl-leg-item';
    const sw = document.createElement('span'); sw.className = 'sch-tl-leg-sw';
    sw.style.background = SCH_COLORS[i % SCH_COLORS.length];
    item.appendChild(sw);
    item.appendChild(document.createTextNode(`#${s.sid} ${utcToLocal(s.start)}–${utcToLocal(s.stop)}`));
    legend.appendChild(item);
  });
}

function renderSchedules() {
  buildScheduleTimeline();
  const list = $('sched-list');
  if (!list) return;
  if (!_schedules.length) {
    list.textContent = '';
    const e = document.createElement('div'); e.className = 'sched-empty'; e.textContent = 'No schedules yet.';
    list.appendChild(e); return;
  }
  list.textContent = '';
  // Built with textContent / createElement (no innerHTML) so charger-returned
  // values can never be interpreted as HTML.
  const mk = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };
  _schedules.forEach((s) => {
    const row = mk('div', 'sched-item' + (s.enabled ? '' : ' is-off'));
    const bits = (typeof s.days === 'number') ? s.days : 0;
    const when = mk('div', 'sched-when');
    when.appendChild(mk('strong', null, `${utcToLocal(s.start)}–${utcToLocal(s.stop)}`));
    when.appendChild(mk('span', 'sched-days-lbl', daysLabel(bits)));
    row.appendChild(when);
    row.appendChild(mk('div', 'sched-meta', `${s.mcr || '--'} A${s.enabled ? '' : ' · paused'}`));
    const act = mk('div', 'sched-actions');
    const edit = mk('button', 'sched-mini', 'Edit');
    edit.onclick = () => openSchedForm(s);
    const del = mk('button', 'sched-mini sched-del', 'Delete');
    del.onclick = () => deleteSchedule(s.sid);
    act.appendChild(edit); act.appendChild(del);
    row.appendChild(act);
    list.appendChild(row);
  });
}

async function loadSchedules(retry) {
  const r = await fetchJSON('api/sched?met=r_schs&par=null&wait=6000');
  if (!(r.ok && r.body && r.body.r)) {
    // Transient (the gateway rate-limits /api/command; the dashboard's poll
    // burst can momentarily exhaust its token bucket). Retry once after it
    // refills before declaring "no schedules".
    if (!retry) { setTimeout(() => loadSchedules(true), 1800); return; }
    renderSchedules(); return;
  }
  const rr = r.body.r;
  const rows = Array.isArray(rr) ? rr : (Array.isArray(rr.schedules) ? rr.schedules : []);
  _schedules = rows.filter((x) => x && typeof x.sid !== 'undefined')
    .map((x) => ({ sid: +x.sid, start: x.start, stop: x.stop, days: +x.days || 0, mcr: +x.mcr || 0, enabled: x.enabled ? 1 : 0 }));
  renderSchedules();
}

function openSchedForm(s) {
  _editingSid = s ? s.sid : null;
  $('sched-form-title').textContent = s ? `Edit schedule #${s.sid}` : 'New schedule';
  $('sf-start').value = s ? utcToLocal(s.start) : '23:00';
  $('sf-stop').value = s ? utcToLocal(s.stop) : '07:00';
  const bits = s ? s.days : 0;
  $('sf-days').querySelectorAll('input').forEach((c, i) => { c.checked = !!((bits >> i) & 1); });
  $('sf-cur').value = s ? (s.mcr || 32) : 32;
  $('sf-cur-v').textContent = $('sf-cur').value;
  $('sf-en').checked = s ? !!s.enabled : true;
  $('sched-form').hidden = false;
}

function schedToast(msg, kind) {
  const t = $('sched-toast'); if (!t) return;
  t.textContent = msg; t.className = 'ctrl-toast is-' + (kind || 'info'); t.hidden = false;
  if (kind !== 'err') { clearTimeout(t._timer); t._timer = setTimeout(() => { t.hidden = true; }, 4000); }
}

async function saveSchedule() {
  const daysArr = Array.from($('sf-days').querySelectorAll('input')).map((c) => c.checked ? 1 : 0);
  if (!daysArr.some(Boolean)) { schedToast('Pick at least one day', 'err'); return; }
  let sid = _editingSid;
  if (sid === null) sid = _schedules.length ? Math.max(..._schedules.map((s) => s.sid)) + 1 : 0;
  const entry = {
    sid, start: parseInt(localToUtc($('sf-start').value), 10),
    stop: parseInt(localToUtc($('sf-stop').value), 10), days: daysArr,
    mcr: parseInt($('sf-cur').value, 10) || 32, type: 0,
    enabled: $('sf-en').checked ? 1 : 0, target: { type: 0, value: 0 }, repeat: 1,
  };
  const par = encodeURIComponent(JSON.stringify({ schedules: [entry] }));
  schedToast('Saving…', 'info');
  const r = await fetchJSON(`api/sched?met=s_sch&par=${par}&wait=6000`);
  if (!r.ok || (r.body && r.body.error)) {
    schedToast('Save failed: ' + (r.body?.error?.message || r.body?.error || r.body?.detail || 'HTTP ' + r.status), 'err');
    return;
  }
  schedToast(`Schedule #${sid} saved`, 'ok');
  $('sched-form').hidden = true; _editingSid = null;
  setTimeout(loadSchedules, 1500);  // async write — let it land before re-reading
}

async function deleteSchedule(sid) {
  if (!confirm(`Delete schedule #${sid}?`)) return;
  const par = encodeURIComponent(JSON.stringify({ sid: [sid] }));
  schedToast(`Deleting #${sid}…`, 'info');
  const r = await fetchJSON(`api/sched?met=clr_sch&par=${par}&wait=6000`);
  if (!r.ok || (r.body && r.body.error)) {
    schedToast('Delete failed: ' + (r.body?.error?.message || r.body?.error || r.body?.detail || 'HTTP ' + r.status), 'err');
    loadSchedules(); return;
  }
  schedToast(`Schedule #${sid} deleted`, 'ok');
  loadSchedules();
}

// Build the day checkboxes once + wire the form buttons.
(function initSchedUI() {
  const days = $('sf-days');
  if (days) {
    DAY_NAMES.forEach((name, i) => {
      const l = document.createElement('label'); l.className = 'sched-day';
      const cb = document.createElement('input'); cb.type = 'checkbox'; cb.dataset.day = i;
      const sp = document.createElement('span'); sp.textContent = name;
      l.appendChild(cb); l.appendChild(sp);
      days.appendChild(l);
    });
  }
  const cur = $('sf-cur');
  if (cur) cur.addEventListener('input', (e) => { $('sf-cur-v').textContent = e.target.value; });
  const add = $('btn-add-sched'); if (add) add.addEventListener('click', () => openSchedForm(null));
  const save = $('sf-save'); if (save) save.addEventListener('click', saveSchedule);
  const cancel = $('sf-cancel'); if (cancel) cancel.addEventListener('click', () => { $('sched-form').hidden = true; _editingSid = null; });
})();

$('poll-s').textContent = POLL_MS / 1000;
refresh();
// Stagger the BAPI-passthrough reads (schedules, notifications) so they
// don't pile onto refresh()'s request burst and trip the gateway's
// /api/command rate limiter.
setTimeout(loadSchedules, 1200);
setTimeout(loadNotifs, 2400);
setInterval(refresh, POLL_MS);
setInterval(loadNotifs, 60_000);   // charger notifications refresh slowly
