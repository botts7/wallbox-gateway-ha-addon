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

function loadRate() { const v = parseFloat(localStorage.getItem(RATE_KEY)); return isNaN(v) ? null : v; }
function saveRate(v) { if (v > 0) localStorage.setItem(RATE_KEY, String(v)); else localStorage.removeItem(RATE_KEY); }

function readCache() { try { return JSON.parse(localStorage.getItem(CACHE_KEY) || '{}'); } catch (e) { return {}; } }
function writeCache(c) { try { localStorage.setItem(CACHE_KEY, JSON.stringify(c)); } catch (e) {} }

// ---- totals + cost ----
function recompute() {
  const now = Date.now() / 1000;
  const weekAgo = now - 7 * 86400;
  const d = new Date(); const monthStart = new Date(d.getFullYear(), d.getMonth(), 1).getTime() / 1000;
  let wk = 0, mo = 0;
  _sessions.forEach((s) => {
    const kwh = (s.en || 0) / 1000;
    if (s.ts >= weekAgo) wk += kwh;
    if (s.ts >= monthStart) mo += kwh;
  });
  if (_lifetimeKwh != null) setText('tile-allt', _lifetimeKwh.toFixed(0));
  setText('tile-week', wk.toFixed(1));
  setText('tile-month', mo.toFixed(1));
  const rate = loadRate();
  const row = $('cost-row');
  if (rate != null && rate > 0) {
    row.hidden = false;
    setText('tile-week-cost', (wk * rate).toFixed(2));
    setText('tile-month-cost', (mo * rate).toFixed(2));
  } else { row.hidden = true; }
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
  const ri = $('rate-input'); if (ri) { const r = loadRate(); if (r != null) ri.value = r; }
  const rs = $('rate-save'); if (rs) rs.addEventListener('click', () => { saveRate(parseFloat($('rate-input').value)); recompute(); });
  const cb = $('csv-btn'); if (cb) cb.addEventListener('click', exportCsv);
  loadSessions();
})();
