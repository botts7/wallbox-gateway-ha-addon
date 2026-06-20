// Sessions page: totals + weekly heatmap + recent list + simple cost.
// Ingress-relative fetches only. Session reads go through /api/sess (r_ses
// gives the last id, then r_log per session, cached in localStorage so only
// new sessions are fetched on later visits). Sequential = self-throttling
// against the gateway's /api/command rate limiter.

const $ = (id) => document.getElementById(id);
const setText = (id, v) => { const el = $(id); if (el) el.textContent = (v ?? '--'); };
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const CACHE_KEY = 'wb-addon-sessions-v1';
const RATE_KEY = 'wb-addon-rate-v1';

async function fetchJSON(path) {
  try {
    const r = await fetch(path, { cache: 'no-store' });
    const body = await r.json().catch(() => ({}));
    return { ok: r.ok, status: r.status, body };
  } catch (e) {
    return { ok: false, status: 0, body: { error: 'fetch_failed', detail: String(e) } };
  }
}

let _sessions = [];   // [{id, ts, dur, en(Wh)}]
let _lifetimeKwh = null;
// Render all times in the CHARGER's timezone (from g_tzn), not the viewing
// browser's — so times are correct even when viewed from a phone in another
// timezone, and match the gateway's own dashboard. Falls back to browser TZ.
let CHARGER_TZ = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch (e) { return 'UTC'; } })();
// epoch -> {day:0-6 (Sun=0), hour:0-23} in CHARGER_TZ
function tzDayHour(epoch) {
  try {
    const local = new Date(new Date(epoch * 1000).toLocaleString('en-US', { timeZone: CHARGER_TZ }));
    return { day: local.getDay(), hour: local.getHours() };
  } catch (e) {
    const d = new Date(epoch * 1000); return { day: d.getDay(), hour: d.getHours() };
  }
}
function fmtTime(epoch, opts) {
  try { return new Date(epoch * 1000).toLocaleString(undefined, Object.assign({ timeZone: CHARGER_TZ }, opts)); }
  catch (e) { return new Date(epoch * 1000).toLocaleString(undefined, opts); }
}

// ---- tariff model ----
// Stored in localStorage. Either a flat rate, or time-of-use with named rate
// bands (e.g. Off-peak/Shoulder/Peak) and a per-hour band assignment for
// weekday + (optionally separate) weekend. Charger timezone is used for the
// hour-of-day so bands line up with the charger's clock.
const TARIFF_KEY = 'wb-addon-tariff-v1';
const DEFAULT_BANDS = [
  { id: 'off', name: 'Off-peak', rate: 0.18, color: '#22c55e' },
  { id: 'sho', name: 'Shoulder', rate: 0.28, color: '#f59e0b' },
  { id: 'pk', name: 'Peak', rate: 0.45, color: '#ef4444' },
];
function defaultTariff() {
  return {
    type: 'tou', currency: '$', provider: '', flatRate: 0.30,
    bands: DEFAULT_BANDS.map((b) => ({ ...b })),
    weekday: Array(24).fill('off'),
    weekend: Array(24).fill('off'),
    weekendSame: true,
  };
}
function loadTariff() {
  try { const t = JSON.parse(localStorage.getItem(TARIFF_KEY)); if (t && t.type) return t; } catch (e) {}
  return null;
}
function saveTariff(t) { localStorage.setItem(TARIFF_KEY, JSON.stringify(t)); }
function clearTariff() { localStorage.removeItem(TARIFF_KEY); }

function _bandFor(tariff, epoch) {
  const { day, hour } = tzDayHour(epoch);
  const weekend = (day === 0 || day === 6);
  const assign = (weekend && !tariff.weekendSame && tariff.weekend) ? tariff.weekend : tariff.weekday;
  const id = (assign && assign[hour]) || (tariff.bands[0] && tariff.bands[0].id);
  return tariff.bands.find((b) => b.id === id) || tariff.bands[0] || { rate: 0 };
}
// Cost of one session split by rate band: {total, byBand:{id:{kwh,cost,name,color}}}
function _sessionCost(tariff, s) {
  const totalKwh = (s.en || 0) / 1000;
  if (tariff.type === 'flat') {
    const c = totalKwh * (tariff.flatRate || 0);
    return { total: c, byBand: { flat: { kwh: totalKwh, cost: c, name: 'Energy', color: 'var(--primary)' } } };
  }
  const dur = s.dur || 3600, step = 300, n = Math.max(1, Math.ceil(dur / step));
  const per = totalKwh / n;
  const byBand = {}; let total = 0;
  for (let i = 0; i < n; i++) {
    const t = s.ts + i * step;
    if (t >= s.ts + dur) break;
    const band = _bandFor(tariff, t);
    const cost = per * (band.rate || 0);
    total += cost;
    const k = band.id || 'x';
    byBand[k] = byBand[k] || { kwh: 0, cost: 0, name: band.name, color: band.color };
    byBand[k].kwh += per; byBand[k].cost += cost;
  }
  return { total, byBand };
}

function readCache() { try { return JSON.parse(localStorage.getItem(CACHE_KEY) || '{}'); } catch (e) { return {}; } }
function writeCache(c) { try { localStorage.setItem(CACHE_KEY, JSON.stringify(c)); } catch (e) {} }

// ---- totals + cost ----
function recompute() {
  const now = Date.now() / 1000;
  const weekAgo = now - 7 * 86400;
  const d = new Date(); const monthStart = new Date(d.getFullYear(), d.getMonth(), 1).getTime() / 1000;
  const tariff = loadTariff();
  let wk = 0, mo = 0, wkCost = 0, moCost = 0;
  const monthBands = {};
  _sessions.forEach((s) => {
    const kwh = (s.en || 0) / 1000;
    const inWeek = s.ts >= weekAgo, inMonth = s.ts >= monthStart;
    if (inWeek) wk += kwh;
    if (inMonth) mo += kwh;
    if (tariff && (inWeek || inMonth)) {
      const bd = _sessionCost(tariff, s);
      if (inWeek) wkCost += bd.total;
      if (inMonth) {
        moCost += bd.total;
        for (const [k, v] of Object.entries(bd.byBand)) {
          monthBands[k] = monthBands[k] || { kwh: 0, cost: 0, name: v.name, color: v.color };
          monthBands[k].kwh += v.kwh; monthBands[k].cost += v.cost;
        }
      }
    }
  });
  if (_lifetimeKwh != null) setText('tile-allt', _lifetimeKwh.toFixed(0));
  setText('tile-week', wk.toFixed(1));
  setText('tile-month', mo.toFixed(1));
  updateTariffSummary(tariff);
  const row = $('cost-row'), cb = $('cost-breakdown');
  const cur = (tariff && tariff.currency) || '$';
  if (tariff) {
    row.hidden = false;
    setText('tile-week-cost', cur + wkCost.toFixed(2));
    setText('tile-month-cost', cur + moCost.toFixed(2));
    renderCostBreakdown(monthBands, cur);
  } else {
    row.hidden = true;
    if (cb) cb.hidden = true;
  }
}

function updateTariffSummary(tariff) {
  const el = $('tariff-text');
  if (!el) return;
  if (!tariff) { el.textContent = 'No tariff set — costs hidden.'; return; }
  const cur = tariff.currency || '$';
  if (tariff.type === 'flat') {
    el.textContent = `Flat ${cur}${(tariff.flatRate || 0).toFixed(2)}/kWh${tariff.provider ? ' · ' + tariff.provider : ''}`;
    return;
  }
  const bands = (tariff.bands || []).map((b) => `${b.name} ${cur}${(b.rate || 0).toFixed(2)}`).join(' · ');
  el.textContent = `Time-of-use: ${bands}${tariff.provider ? ' · ' + tariff.provider : ''}`;
}

function renderCostBreakdown(bands, cur) {
  const el = $('cost-breakdown');
  if (!el) return;
  el.textContent = '';
  const entries = Object.values(bands).filter((b) => b.kwh > 0);
  if (entries.length < 2) { el.hidden = true; return; }  // breakdown only meaningful for ToU
  el.hidden = false;
  entries.sort((a, b) => b.cost - a.cost).forEach((b) => {
    const chip = document.createElement('div'); chip.className = 'cb-chip';
    const sw = document.createElement('span'); sw.className = 'cb-sw'; sw.style.background = b.color || 'var(--primary)';
    chip.appendChild(sw);
    const t = document.createElement('span');
    t.textContent = `${b.name || 'Rate'}: ${cur}${b.cost.toFixed(2)} · ${b.kwh.toFixed(1)} kWh`;
    chip.appendChild(t);
    el.appendChild(chip);
  });
}

// ---- heatmap (day x hour kWh intensity), browser-local ----
function buildHeatmap() {
  const hm = $('heatmap'); if (!hm) return;
  const grid = Array.from({ length: 7 }, () => Array(24).fill(0));
  let max = 0;
  _sessions.forEach((s) => {
    if (!s.ts || !s.en) return;
    const totalKwh = s.en / 1000;
    const dur = s.dur || 3600;
    const step = 300, n = Math.max(1, Math.ceil(dur / step));
    const per = totalKwh / n;
    for (let i = 0; i < n; i++) {
      const t = s.ts + i * step;
      if (t >= s.ts + dur) break;
      const { day, hour } = tzDayHour(t);
      grid[day][hour] += per;
      if (grid[day][hour] > max) max = grid[day][hour];
    }
  });
  hm.textContent = '';
  const cell = (cls, text, title) => {
    const e = document.createElement('div');
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    if (title) e.title = title;
    return e;
  };
  hm.appendChild(cell('hm-hd'));
  for (let h = 0; h < 24; h++) hm.appendChild(cell('hm-hd', h % 6 === 0 ? h : ''));
  for (let d = 0; d < 7; d++) {
    hm.appendChild(cell('hm-day', DAYS[d]));
    for (let h = 0; h < 24; h++) {
      const v = grid[d][h], it = max > 0 ? v / max : 0;
      let bg = 'var(--elevated)';
      if (it > 0.75) bg = '#1d4ed8'; else if (it > 0.5) bg = 'var(--primary)';
      else if (it > 0.25) bg = 'rgba(59,130,246,.5)'; else if (it > 0) bg = 'rgba(59,130,246,.2)';
      const box = cell('hm-cell', null, `${DAYS[d]} ${h}:00 — ${v.toFixed(1)} kWh`);
      box.style.background = bg;
      hm.appendChild(box);
    }
  }
}

// ---- recent session list (collapsed to a few, with expand) ----
const SESS_COLLAPSED = 5;
let _sessExpanded = false;
function renderList() {
  const list = $('sess-list'); if (!list) return;
  list.textContent = '';
  if (!_sessions.length) {
    const e = document.createElement('span'); e.className = 'sched-empty'; e.textContent = 'No sessions yet.';
    list.appendChild(e); return;
  }
  const sorted = _sessions.slice().sort((a, b) => b.ts - a.ts);
  const shown = _sessExpanded ? sorted : sorted.slice(0, SESS_COLLAPSED);
  shown.forEach((s) => {
    const row = document.createElement('div'); row.className = 'sess-item';
    const when = document.createElement('div'); when.className = 'sess-when';
    when.textContent = fmtTime(s.ts, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    const meta = document.createElement('div'); meta.className = 'sess-meta';
    const mins = Math.round((s.dur || 0) / 60);
    meta.textContent = `${((s.en || 0) / 1000).toFixed(2)} kWh · ${mins} min`;
    row.appendChild(when); row.appendChild(meta);
    list.appendChild(row);
  });
  if (sorted.length > SESS_COLLAPSED) {
    const btn = document.createElement('button');
    btn.className = 'sess-toggle';
    btn.textContent = _sessExpanded ? 'Show less' : `Show all ${sorted.length}`;
    btn.onclick = () => { _sessExpanded = !_sessExpanded; renderList(); };
    list.appendChild(btn);
  }
}

function renderAll() { recompute(); buildHeatmap(); renderList(); }

// ---- load (sequential r_log, cached) ----
async function loadSessions() {
  const cache = readCache();
  if (!cache.s) cache.s = {};
  _sessions = Object.values(cache.s);
  if (typeof cache.lifetimeKwh === 'number') _lifetimeKwh = cache.lifetimeKwh;
  if (_sessions.length) renderAll();

  const dca = await fetchJSON('api/sess?met=r_dca&par=null&wait=4000');
  if (dca.ok && dca.body.r && typeof dca.body.r.e === 'number') {
    _lifetimeKwh = dca.body.r.e / 1000; cache.lifetimeKwh = _lifetimeKwh; recompute();
  }

  const ses = await fetchJSON('api/sess?met=r_ses&par=null&wait=6000');
  const last = (ses.ok && ses.body.r && ses.body.r.last) ? ses.body.r.last : 0;
  if (!last) { if (!_sessions.length) renderList(); return; }
  const cachedSids = Object.keys(cache.s).map(Number);
  const maxCached = cachedSids.length ? Math.max(...cachedSids) : 0;
  if (maxCached >= last) { writeCache(cache); return; }
  // First load: cap to the most recent 60 sessions; later loads: only new ones.
  let sid = maxCached === 0 ? Math.max(1, last - 59) : maxCached + 1;
  const total = last - sid + 1;
  const listEl = $('sess-list');
  let done = 0;
  while (sid <= last) {
    if (!Object.keys(cache.s).length && listEl) listEl.textContent = `Loading ${done + 1} / ${total}…`;
    const r = await fetchJSON('api/sess?met=r_log&par=' + sid + '&wait=6000');
    if (r.ok && r.body.r && r.body.r.start) {
      const sd = r.body.r;
      cache.s[sid] = { id: sid, ts: sd.start, dur: sd.sec || sd.dur || sd.duration || 0, en: sd.en || sd.energy || 0 };
    }
    sid++; done++;
  }
  _sessions = Object.values(cache.s);
  writeCache(cache);
  renderAll();
}

function exportCsv() {
  const rows = [['id', 'start_iso', 'duration_min', 'energy_kwh']];
  _sessions.slice().sort((a, b) => a.ts - b.ts).forEach((s) => {
    rows.push([s.id, new Date(s.ts * 1000).toISOString(), Math.round((s.dur || 0) / 60), ((s.en || 0) / 1000).toFixed(3)]);
  });
  const csv = rows.map((r) => r.join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = 'wallbox-sessions.csv';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ---- tariff editor modal ----
let _edit = null;  // working copy while the modal is open

function openTariff() {
  const cur = loadTariff();
  _edit = cur ? JSON.parse(JSON.stringify(cur)) : defaultTariff();
  if (!Array.isArray(_edit.bands) || !_edit.bands.length) _edit.bands = DEFAULT_BANDS.map((b) => ({ ...b }));
  if (!Array.isArray(_edit.weekday) || _edit.weekday.length !== 24) _edit.weekday = Array(24).fill(_edit.bands[0].id);
  if (!Array.isArray(_edit.weekend) || _edit.weekend.length !== 24) _edit.weekend = Array(24).fill(_edit.bands[0].id);
  $('tm-provider').value = _edit.provider || '';
  $('tm-currency').value = _edit.currency || '$';
  $('tm-flat-rate').value = _edit.flatRate != null ? _edit.flatRate : '';
  document.querySelectorAll('input[name="tm-type"]').forEach((r) => { r.checked = (r.value === _edit.type); });
  $('tm-weekend-same').checked = !!_edit.weekendSame;
  $('tm-paint-hint').textContent = 'Tip: tap an hour repeatedly to cycle through your rate bands.';
  renderTariffType(); renderBands(); renderHours(); renderWeekendWrap();
  $('tariff-modal').hidden = false;
}
function closeTariff() { $('tariff-modal').hidden = true; _edit = null; }
function renderTariffType() { $('tm-flat').hidden = _edit.type !== 'flat'; $('tm-tou').hidden = _edit.type !== 'tou'; }
function renderWeekendWrap() { $('tm-weekend-wrap').hidden = !!_edit.weekendSame; }

function renderBands() {
  const wrap = $('tm-bands'); wrap.textContent = '';
  _edit.bands.forEach((b, i) => {
    const row = document.createElement('div'); row.className = 'tm-band';
    const sw = document.createElement('input'); sw.type = 'color'; sw.value = b.color || '#3b82f6'; sw.className = 'tm-band-color';
    sw.oninput = () => { b.color = sw.value; renderHours(); };
    const name = document.createElement('input'); name.type = 'text'; name.value = b.name || ''; name.placeholder = 'Name'; name.className = 'tm-band-name';
    name.oninput = () => { b.name = name.value; };
    const rate = document.createElement('input'); rate.type = 'number'; rate.min = '0'; rate.step = '0.01'; rate.placeholder = '0.00'; rate.className = 'tm-band-rate';
    rate.value = b.rate != null ? b.rate : '';
    rate.oninput = () => { b.rate = parseFloat(rate.value) || 0; };
    row.appendChild(sw); row.appendChild(name); row.appendChild(rate);
    if (_edit.bands.length > 1) {
      const rm = document.createElement('button'); rm.type = 'button'; rm.className = 'tm-band-rm'; rm.textContent = '×';
      rm.onclick = () => removeBand(i);
      row.appendChild(rm);
    }
    wrap.appendChild(row);
  });
}
function removeBand(i) {
  const removed = _edit.bands[i].id;
  _edit.bands.splice(i, 1);
  const fb = _edit.bands[0].id;
  ['weekday', 'weekend'].forEach((w) => { _edit[w] = _edit[w].map((id) => (id === removed ? fb : id)); });
  renderBands(); renderHours();
}
function addBand() {
  const colors = ['#3b82f6', '#a855f7', '#06b6d4', '#84cc16', '#ec4899'];
  _edit.bands.push({ id: 'b' + Date.now().toString(36), name: 'Rate ' + (_edit.bands.length + 1), rate: 0.30, color: colors[_edit.bands.length % colors.length] });
  renderBands();
}

function renderHours() {
  ['weekday', 'weekend'].forEach((which) => {
    const grid = $(which === 'weekday' ? 'tm-weekday' : 'tm-weekend');
    if (!grid) return;
    grid.textContent = '';
    for (let h = 0; h < 24; h++) {
      const band = _edit.bands.find((b) => b.id === _edit[which][h]) || _edit.bands[0];
      const cell = document.createElement('button');
      cell.type = 'button'; cell.className = 'tm-hr';
      cell.style.background = band.color || 'var(--elevated)';
      cell.textContent = h;
      cell.title = `${h}:00 — ${band.name}`;
      cell.onclick = () => cycleHour(which, h);
      grid.appendChild(cell);
    }
  });
}
function cycleHour(which, h) {
  const ids = _edit.bands.map((b) => b.id);
  _edit[which][h] = ids[(ids.indexOf(_edit[which][h]) + 1) % ids.length];
  renderHours();
}
function saveTariffEdit() {
  _edit.provider = $('tm-provider').value.trim();
  _edit.currency = $('tm-currency').value.trim() || '$';
  _edit.flatRate = parseFloat($('tm-flat-rate').value) || 0;
  _edit.weekendSame = $('tm-weekend-same').checked;
  saveTariff(_edit);
  closeTariff();
  recompute();
}
(function initTariffUI() {
  const open = $('tariff-edit'); if (open) open.addEventListener('click', openTariff);
  const close = $('tm-close'); if (close) close.addEventListener('click', closeTariff);
  const modal = $('tariff-modal'); if (modal) modal.addEventListener('click', (e) => { if (e.target === modal) closeTariff(); });
  document.querySelectorAll('input[name="tm-type"]').forEach((r) => r.addEventListener('change', () => { if (_edit) { _edit.type = r.value; renderTariffType(); } }));
  const ws = $('tm-weekend-same'); if (ws) ws.addEventListener('change', () => { if (_edit) { _edit.weekendSame = ws.checked; renderWeekendWrap(); } });
  const ab = $('tm-add-band'); if (ab) ab.addEventListener('click', addBand);
  const sv = $('tm-save'); if (sv) sv.addEventListener('click', saveTariffEdit);
  const cl = $('tm-clear'); if (cl) cl.addEventListener('click', () => { clearTariff(); closeTariff(); recompute(); });
})();

// ---- init ----
(async function init() {
  const cfg = await fetchJSON('api/addon/config');
  if (cfg.ok && !cfg.body.configured) { const nc = $('not-configured'); if (nc) nc.hidden = false; return; }
  // Resolve the charger's timezone so all times render in it.
  const tz = await fetchJSON('api/sess?met=g_tzn&par=null&wait=4000');
  if (tz.ok && tz.body.r && tz.body.r.timezone) CHARGER_TZ = tz.body.r.timezone;
  const total = $('sess-total');
  const st = await fetchJSON('api/status');
  if (st.ok && typeof st.body.chg_sessions === 'number' && total) total.textContent = st.body.chg_sessions + ' total';
  const cb = $('csv-btn'); if (cb) cb.addEventListener('click', exportCsv);
  loadSessions();
})();
