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
function updateChargeReminder(s) {
  const el = $('charge-reminder');
  if (!el) return;
  // Don't trust plug/schedule state when the charger link is down.
  if (!s || s.ble !== 'connected') { el.style.display = 'none'; return; }
  const nsc = s.next_scheduled_charge;
  if (s.plug_reminder) {
    el.className = 'banner banner-warn';
    setText('charge-reminder-icon', '\u{1F50C}');
    setText('charge-reminder-title', 'Not plugged in');
    setText('charge-reminder-detail',
      nsc ? `Scheduled charge at ${fmtChargeTime(nsc)} — connect the cable so it can start.`
          : 'A scheduled charge is due soon — connect the cable so it can start.');
    el.style.display = '';
  } else if (nsc) {
    el.className = 'banner';
    setText('charge-reminder-icon', '\u{1F5D3}\u{FE0F}');
    setText('charge-reminder-title', 'Next scheduled charge');
    setText('charge-reminder-detail', fmtChargeTime(nsc));
    el.style.display = '';
  } else {
    el.style.display = 'none';
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

// ---- Power Flow card (matches the gateway's own dashboard) ----
// Grid -> Charger -> Vehicle. cp = charging power (vehicle kW), house =
// grid kW, conn = car connected (status-code derived, mirrors firmware
// carConnected()). The Vehicle node swaps to "Plug in" when not connected.
const _pf = { cp: null, en: null, house: null, conn: null };
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
  if (typeof _pf.cp === 'number') setText('pf-veh-kw', _pf.cp.toFixed(2) + ' kW');
  if (typeof _pf.house === 'number') setText('pf-grid-kw', (_pf.house / 1000).toFixed(2) + ' kW');
  if (typeof _pf.en === 'number') setText('pf-session', (_pf.en / 100).toFixed(2) + ' kWh');
  const charging = (typeof _pf.cp === 'number' && _pf.cp > 0.05);
  const l1 = $('pf-line1'), l2 = $('pf-line2');
  if (l1) l1.style.opacity = charging ? '1' : '0';
  if (l2) l2.style.opacity = charging ? '1' : '0';
  pfAnimate(l1, charging, _pf.cp); pfAnimate(l2, charging, _pf.cp);
  const plug = $('pf-plugin'), vk = $('pf-veh-kw');
  if (_pf.conn === false) { if (plug) plug.style.display = ''; if (vk) vk.style.display = 'none'; }
  else { if (plug) plug.style.display = 'none'; if (vk) vk.style.display = ''; }
}
// Status text under the power-flow + the schedule-paused banner toggle.
function setStatus(stateCode, schedulePaused) {
  const info = HERO_STATES[stateCode];
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
  _pf.cp = null; _pf.en = null; _pf.house = null; _pf.conn = null;
  setText('pf-veh-kw', '--'); setText('pf-grid-kw', '--'); setText('pf-session', '--');
  pfRender();
  ['dot-ble', 'dot-wifi', 'dot-mqtt'].forEach(id => setClass(id, 'conn-dot is-down'));
  const banner = $('paused-banner');
  if (banner) banner.style.display = 'none';
  const cr = $('charge-reminder');
  if (cr) cr.style.display = 'none';
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
    setStatus(stateCode, schedulePaused);
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

  // ---- /api/meter ---- (BAPI r_dca passthrough: mains voltage + house power)
  // Best-effort: BLE-busy gateway returns nulls, which we display as `--`.
  const meter = await fetchJSON('api/meter');
  if (meter.ok && meter.body && meter.body.r) {
    const r = meter.body.r;
    setText('stat-voltage', (typeof r.v1 === 'number') ? r.v1 : '--');
    if (typeof r.p1 === 'number') {
      const house = (r.p1 || 0) + (r.p2 || 0) + (r.p3 || 0);
      setText('stat-house', house);
      _pf.house = house; pfRender();   // grid kW on the Power Flow card
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

function renderSchedules() {
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
// Stagger the schedule read so it doesn't pile onto refresh()'s request
// burst and trip the gateway's /api/command rate limiter.
setTimeout(loadSchedules, 1200);
setInterval(refresh, POLL_MS);
