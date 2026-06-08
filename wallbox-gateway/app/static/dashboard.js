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

function setHero(stateCode, powerKw, detail, schedulePaused) {
  const hero = $('hero');
  const info = HERO_STATES[stateCode];
  if (!hero) return;
  // Reset state classes, apply current one
  hero.className = 'hero' + (info && info.cls ? ' ' + info.cls : '');
  setText('hero-status', info ? info.text : (stateCode == null ? 'Offline' : `Code ${stateCode}`));
  if (typeof powerKw === 'number') {
    $('hero-power-num').textContent = powerKw.toFixed(2);
    $('hero-power-unit').textContent = 'kW';
  } else {
    $('hero-power-num').textContent = '--';
    $('hero-power-unit').textContent = '';
  }
  setText('hero-detail', detail || '');
  // r_dat.gen is the sticky manual-override flag: != 0 means the
  // Wallbox app's "Schedules & Solar charging paused" label is on,
  // regardless of charging state.
  const banner = $('paused-banner');
  if (banner) banner.style.display = schedulePaused ? '' : 'none';
}

function setOffline() {
  const hero = $('hero');
  if (hero) hero.className = 'hero is-offline';
  setText('hero-status', 'Offline');
  $('hero-power-num').textContent = '--';
  $('hero-power-unit').textContent = '';
  setText('hero-detail', 'Cannot reach the gateway');
  // also blank all connection dots
  ['dot-ble','dot-wifi','dot-mqtt'].forEach(id => setClass(id, 'conn-dot is-down'));
  // gateway is offline; whatever the previous paused state was, hide it
  const banner = $('paused-banner');
  if (banner) banner.style.display = 'none';
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
  const charger = await fetchJSON('api/charger');
  if (charger.ok && charger.body && charger.body.realtime && charger.body.realtime.r) {
    const rt = charger.body.realtime.r;
    const st = (charger.body.status && charger.body.status.r) || {};
    const stateCode = (typeof rt.charger_status === 'number') ? rt.charger_status : null;
    const kw = (typeof st.cp === 'number') ? st.cp : null;
    const sessionKwh = (typeof st.en === 'number') ? st.en / 100 : null;
    const maxCur = (typeof st.cur === 'number') ? st.cur : null;
    const schedulePaused = (typeof st.gen === 'number') && st.gen !== 0;
    setHero(stateCode, kw, chargerName !== '--' ? chargerName : '', schedulePaused);
    setText('stat-energy', sessionKwh != null ? sessionKwh.toFixed(2) : '--');
    setText('stat-maxcur', maxCur != null ? maxCur : '--');
    syncCurrentSlider(maxCur);
  } else {
    // BLE down or charger not responding — keep hero showing offline
    setHero(null, null, 'Gateway online but charger not responding');
    setText('stat-energy', '--');
    setText('stat-maxcur', '--');
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

$('poll-s').textContent = POLL_MS / 1000;
refresh();
setInterval(refresh, POLL_MS);
