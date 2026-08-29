// Sessions page: totals + weekly heatmap + recent list + simple cost.
// Ingress-relative fetches only. Session reads go through /api/sess (r_ses
// gives the last id, then r_log per session, cached in localStorage so only
// new sessions are fetched on later visits). Sequential = self-throttling
// against the gateway's /api/command rate limiter.

const $ = (id) => document.getElementById(id);
const setText = (id, v) => { const el = $(id); if (el) el.textContent = (v ?? '--'); };
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];   // indexed by getDay() (0=Sun)
// Heatmap row order — Monday first so the weekend (Sat, Sun) sits together at the
// bottom. Values are getDay() indices, not row positions.
const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0];
const CACHE_KEY = 'wb-addon-sessions-v2';  // v2: includes gen (green energy) + gap-fill retry
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

let _sessions = [];   // [{id, ts, dur, en(Wh), gen(Wh), usid}]
let _lifetimeKwh = null;
// Real charge windows. _chargeLog is a flat list of [{start,stop,wh}] captured
// by the gateway firmware (ground truth) — mapped to sessions by TIME, since
// the charger's usid is shared across sessions (NOT unique per charge).
// _scheduleWindows holds the enabled native schedules (UTC) used to INFER the
// window for sessions that predate firmware capture. See _chargeSegments().
let _chargeLog = [];
let _scheduleWindows = [];
// Render all times in the CHARGER's timezone (from g_tzn), not the viewing
// browser's — so times are correct even when viewed from a phone in another
// timezone, and match the gateway's own dashboard. Falls back to browser TZ.
let CHARGER_TZ = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch (e) { return 'UTC'; } })();
// Robust epoch -> calendar parts in CHARGER_TZ. Uses Intl.formatToParts (stable
// across engines and DST) instead of re-parsing a locale string back into a Date
// (`new Date(d.toLocaleString(...))`), which is implementation-defined and can be
// silently wrong in some locales / around DST transitions. The formatter is
// cached and rebuilt only when CHARGER_TZ changes (it's set from the charger's
// g_tzn after boot). Locale pinned to en-US so weekday names are always English.
const _DOW = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
let _tzFmt = null, _tzFmtZone = null;
function _tzFormatter() {
  if (_tzFmt && _tzFmtZone === CHARGER_TZ) return _tzFmt;
  const opts = { weekday: 'short', year: 'numeric', month: 'numeric',
                 hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false };
  try { _tzFmt = new Intl.DateTimeFormat('en-US', Object.assign({ timeZone: CHARGER_TZ }, opts)); }
  catch (e) { _tzFmt = new Intl.DateTimeFormat('en-US', opts); }  // bad TZ -> browser-local
  _tzFmtZone = CHARGER_TZ;
  return _tzFmt;
}
// epoch -> {day:0-6(Sun=0), hour:0-23, minute, second, month:0-11, year} in TZ.
function tzParts(epoch) {
  const d = new Date(epoch * 1000);
  try {
    const p = {};
    for (const part of _tzFormatter().formatToParts(d)) p[part.type] = part.value;
    let hour = parseInt(p.hour, 10);
    if (isNaN(hour) || hour === 24) hour = 0;   // some engines emit '24' at midnight
    const day = _DOW[p.weekday];
    return {
      day: (day === undefined ? d.getDay() : day),
      hour,
      minute: parseInt(p.minute, 10) || 0,
      second: parseInt(p.second, 10) || 0,
      month: (parseInt(p.month, 10) || (d.getMonth() + 1)) - 1,  // 0-based, matches getMonth()
      year: parseInt(p.year, 10) || d.getFullYear(),
    };
  } catch (e) {
    return { day: d.getDay(), hour: d.getHours(), minute: d.getMinutes(),
             second: d.getSeconds(), month: d.getMonth(), year: d.getFullYear() };
  }
}
// epoch -> {day:0-6 (Sun=0), hour:0-23} in CHARGER_TZ
function tzDayHour(epoch) { const p = tzParts(epoch); return { day: p.day, hour: p.hour }; }
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
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function defaultTariff() {
  return {
    type: 'tou', currency: '$', provider: '', flatRate: 0.30,
    // Feed-in / export rate (per kWh). Solar self-consumed for charging is
    // valued net of the export income given up: green_kwh * (grid_rate -
    // feedIn). 0 = no export tariff (solar valued at the full avoided grid
    // rate). Rides into HA inside the mirrored tariff object (#151).
    feedIn: 0,
    bands: DEFAULT_BANDS.map((b) => ({ ...b })),
    weekday: Array(24).fill('off'),
    weekend: Array(24).fill('off'),
    weekendSame: true,
    // NEM-style seasonal rates: same hour windows, but band rates differ by
    // season. Months are 0-indexed; ranges wrap the year (e.g. Nov..Feb).
    seasonal: false,
    seasons: [
      { id: 'summer', name: 'Summer', from: 10, to: 1 },  // Nov..Feb
      { id: 'winter', name: 'Winter', from: 5, to: 7 },   // Jun..Aug
    ],
  };
}
function _monthInSeason(month, season) {
  const f = season.from, t = season.to;
  return (f <= t) ? (month >= f && month <= t) : (month >= f || month <= t);
}
function _seasonFor(tariff, epoch) {
  if (!tariff.seasonal || !Array.isArray(tariff.seasons)) return null;
  const month = tzParts(epoch).month;
  for (const s of tariff.seasons) { if (_monthInSeason(month, s)) return s.id; }
  return null;  // shoulder months -> default band.rate
}
function _bandRate(tariff, band, seasonId) {
  if (tariff.seasonal && seasonId && band.seasonRates && band.seasonRates[seasonId] != null) {
    return band.seasonRates[seasonId];
  }
  return band.rate || 0;
}
function loadTariff() {  // the CURRENT tariff (latest rates)
  try { const t = JSON.parse(localStorage.getItem(TARIFF_KEY)); if (t && t.type) return t; } catch (e) {}
  return null;
}
function saveTariff(t) {
  localStorage.setItem(TARIFF_KEY, JSON.stringify(t));
  // Mirror the tariff to the integration so it can compute cost sensors
  // (proper HA entities with statistics). Best-effort: the add-on keeps
  // working from localStorage regardless of whether the bridge is present.
  try {
    fetch('api/ha/config', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ options: { tariff: t } }),
    }).catch(function () {});
  } catch (e) {}
}
function clearTariff() { localStorage.removeItem(TARIFF_KEY); localStorage.removeItem(TARIFF_HIST_KEY); }

// Tariff history: archived PRIOR tariff versions, each with its own validFrom.
// The current tariff (TARIFF_KEY) carries validFrom = when its rates took
// effect (0 = always). _tariffForSession bills each session at the rate that
// was in effect WHEN it happened, so changing rates doesn't rewrite the past.
const TARIFF_HIST_KEY = 'wb-addon-tariff-history-v1';
function loadTariffHistory() {
  try {
    const h = JSON.parse(localStorage.getItem(TARIFF_HIST_KEY));
    if (Array.isArray(h)) return h.slice().sort((a, b) => (a.validFrom || 0) - (b.validFrom || 0));
  } catch (e) {}
  return [];
}
function saveTariffHistory(arr) { localStorage.setItem(TARIFF_HIST_KEY, JSON.stringify(arr)); }
function _tariffForSession(s) {
  const cur = loadTariff();
  if (!cur) return null;
  const ts = s.ts || 0;
  if (ts >= (cur.validFrom || 0)) return cur;       // session on/after current rates
  const hist = loadTariffHistory();
  for (let i = hist.length - 1; i >= 0; i--) {
    if (ts >= (hist[i].validFrom || 0)) return hist[i];
  }
  return hist[0] || cur;  // before any recorded period -> earliest known rates
}

// Cheapest band by base rate — the safe default for any hour the user left
// unpainted (never silently bill an unassigned hour at the most expensive band).
function _cheapestBand(tariff) {
  const bands = tariff.bands || [];
  if (!bands.length) return { rate: 0 };
  return bands.reduce((a, b) => ((b.rate || 0) < (a.rate || 0) ? b : a), bands[0]);
}
function _bandFor(tariff, epoch) {
  const { day, hour } = tzDayHour(epoch);
  const weekend = (day === 0 || day === 6);
  const assign = (weekend && !tariff.weekendSame && tariff.weekend) ? tariff.weekend : tariff.weekday;
  const painted = assign && assign[hour];
  if (painted) {
    const b = tariff.bands.find((x) => x.id === painted);
    if (b) return b;
  }
  return _cheapestBand(tariff);  // unpainted hour -> cheapest band, not bands[0]
}
// "HHMM" -> minutes since midnight. Schedule times are stored UTC.
function _parseHHMM(v) {
  const n = parseInt(String(v), 10) || 0;
  return Math.floor(n / 100) * 60 + (n % 100);
}
// UTC weekday as the charger's day-bitmask bit. The charger is Sunday-first
// (bit0=Sun..bit6=Sat, verified against the Wallbox app), so getUTCDay() (0=Sun)
// is already the bit index — no Monday shift.
function _dayBit(epoch) { return new Date(epoch * 1000).getUTCDay(); }

// Infer the real charge-START epoch for a session that has no firmware
// interval, using the enabled native schedule: the car waits and charges in
// the schedule window, not at plug-in. Returns null when no schedule governs
// (then we fall back to the plug-in time).
function _governingStart(ts, dur) {
  if (!_scheduleWindows.length) return null;
  let best = null;
  _scheduleWindows.forEach((w) => {
    const dayStart = Math.floor(ts / 86400) * 86400;  // UTC midnight of plug-in
    let cand = dayStart + w.startMinUTC * 60;
    if (ts >= cand + w.lenS) cand += 86400;  // window already passed today -> next day
    for (let g = 0; g < 8; g++) {            // honour the schedule's day-of-week set
      if (w.days & (1 << _dayBit(cand))) break;
      cand += 86400;
    }
    const start = Math.max(ts, cand);        // plugged in mid-window -> start now
    if (best === null || start < best) best = start;
  });
  return best;
}

// The actual charge window(s) for a session, as segments
// [{start, dur, frac, gFrac}] where frac is the share of session ENERGY and
// gFrac the share of session GREEN in that segment. Priority: (1) real firmware
// intervals (by time, with per-burst green from gwh), (2) schedule inference,
// (3) plug-in time. Every time-based surface (cost, heatmap) uses this so energy
// — and its solar/grid mix — lands when it was really delivered.
// Firmware charge-log intervals that belong to this session, mapped by TIME
// (the charger's usid is shared across sessions, NOT unique per charge). Shared
// by _chargeSegments (energy PLACEMENT for cost/heatmap) and _sessionWh /
// _sessionGreenWh (the authoritative per-session ENERGY).
function _sessionIntervals(s) {
  const spanEnd = (s.stop && s.stop > s.ts) ? s.stop : (s.ts + (s.dur || 3600) + 86400);
  return _chargeLog.filter((iv) => iv.start >= s.ts && iv.start <= spanEnd);
}
// Authoritative session energy (Wh): prefer the firmware charge-log sum (ground
// truth — the same source the totals and the gateway's own /sessions page use),
// falling back to the per-session r_log value only for sessions that predate
// charge-log capture. The per-session r_log read returns en:0 on some charger
// firmwares, which showed every session as 0.00 kWh with an empty heatmap even
// though the metered totals were correct (mo-harry).
function _sessionWh(s) {
  const ivals = _sessionIntervals(s);
  if (ivals.length) return ivals.reduce((a, b) => a + (b.wh || 0), 0);
  return s.en || 0;
}
function _sessionGreenWh(s) {
  const ivals = _sessionIntervals(s);
  if (ivals.length) return ivals.reduce((a, b) => a + (b.gwh || 0), 0);
  return s.gen || 0;
}
function _chargeSegments(s) {
  // (1) Ground truth: firmware intervals whose start falls within this
  // session's plug-in span [ts, stop]. Mapped by TIME (usid isn't per-session).
  const ivals = _sessionIntervals(s);
  if (ivals.length) {
    const totWh = ivals.reduce((a, b) => a + (b.wh || 0), 0) || 1;
    const totGwh = ivals.reduce((a, b) => a + (b.gwh || 0), 0);
    return ivals.map((iv) => ({
      start: iv.start,
      dur: Math.max(60, (iv.stop || iv.start) - iv.start),
      frac: (iv.wh || 0) / totWh,
      // per-burst green share when the firmware captured it; else mirror energy.
      gFrac: totGwh > 0 ? (iv.gwh || 0) / totGwh : (iv.wh || 0) / totWh,
    }));
  }
  const dur = s.dur || 3600;
  const gs = _governingStart(s.ts, dur);     // (2) schedule inference
  if (gs != null) return [{ start: gs, dur, frac: 1, gFrac: 1 }];
  return [{ start: s.ts, dur, frac: 1, gFrac: 1 }];     // (3) plug-in fallback
}

// Cost of one session. Solar (green) energy is free; only the GRID portion
// (total - green) is billed. `saved` = what the green kWh WOULD have cost at
// the same tariff (so the UI can show the solar dollar saving).
// Returns {total, green, saved, byBand:{id:{kwh,cost,name,color}}}.
function _sessionCost(tariff, s) {
  const en = (s.en || 0) / 1000, gen = (s.gen || 0) / 1000;
  const green = Math.max(0, Math.min(en, gen));
  const gridKwh = Math.max(0, en - green);
  if (tariff.type === 'flat') {
    const rate = tariff.flatRate || 0;
    const c = gridKwh * rate;
    return { total: c, green, saved: green * rate,
             byBand: { grid: { kwh: gridKwh, cost: c, name: 'Grid', color: 'var(--primary)' } } };
  }
  // ToU: distribute an arbitrary kWh amount across the session's REAL charge
  // segments (firmware intervals / schedule-inferred / plug-in fallback) and,
  // within each segment, across its hours — summing the per-band cost. Used for
  // both the billed grid kWh and the saved green kWh, so each lands in the band
  // for the time it was actually delivered.
  const step = 300;
  const seasonId = _seasonFor(tariff, s.ts);  // season is fixed for the session
  const segs = _chargeSegments(s);
  // Per-segment grid + green kWh: each segment's grid = its total energy minus
  // its OWN green (so a midday solar burst is mostly free and an evening grid
  // burst is mostly billed — not the session average smeared across both).
  // Sums stay = the r_log session totals (en, green).
  // Grid per segment, then RESCALE so it always sums to the authoritative
  // session grid (en-green) — a skewed gFrac (or firmware gwh>wh) can't over- or
  // under-bill across bands. Normal case: shares already sum right, no change.
  const rawGrid = segs.map((sg) => Math.max(0, en * sg.frac - green * sg.gFrac));
  const sumRaw = rawGrid.reduce((a, b) => a + b, 0);
  const gridPer = (sumRaw > 0)
    ? rawGrid.map((g) => g * gridKwh / sumRaw)
    : segs.map((sg) => gridKwh * sg.frac);
  const greenPer = segs.map((sg) => green * sg.gFrac);  // Σ == green (gFrac sums to 1)
  const dist = (amounts, accum) => {
    let sum = 0;
    segs.forEach((seg, si) => {
      const n = Math.max(1, Math.ceil(seg.dur / step));
      const per = amounts[si] / n;
      for (let i = 0; i < n; i++) {
        const t = seg.start + i * step;
        if (t >= seg.start + seg.dur) break;
        const band = _bandFor(tariff, t);
        const cost = per * _bandRate(tariff, band, seasonId);
        sum += cost;
        if (accum) {
          const k = band.id || 'x';
          accum[k] = accum[k] || { kwh: 0, cost: 0, name: band.name, color: band.color };
          accum[k].kwh += per; accum[k].cost += cost;
        }
      }
    });
    return sum;
  };
  const byBand = {};
  const total = dist(gridPer, byBand);
  const saved = green > 0 ? dist(greenPer, null) : 0;
  return { total, green, saved, byBand };
}

function readCache() { try { return JSON.parse(localStorage.getItem(CACHE_KEY) || '{}'); } catch (e) { return {}; } }
function writeCache(c) { try { localStorage.setItem(CACHE_KEY, JSON.stringify(c)); } catch (e) {} }

// Savings baseline (mirrors cost.js) — what "without the assistant" would cost.
const BASELINE_KEY = 'wb-addon-savings-baseline-v1';
function loadBaseline() {
  try { const b = JSON.parse(localStorage.getItem(BASELINE_KEY)); if (b && b.mode) return b; } catch (e) {}
  return { mode: 'plug_in', fixedTime: '00:00' };
}
function _hhmmToMin(v) { const m = String(v || '').split(':'); return (parseInt(m[0], 10) || 0) * 60 + (parseInt(m[1], 10) || 0); }
function _localMidnightS(epoch) {
  const p = tzParts(epoch);
  return epoch - (p.hour * 3600 + p.minute * 60 + p.second);
}
function _fixedStart(ts, hhmm) { let s = _localMidnightS(ts) + _hhmmToMin(hhmm) * 60; if (s < ts) s += 86400; return s; }
function _baselineCost(tariff, s) {
  const en = (s.en || 0) / 1000, gen = (s.gen || 0) / 1000;
  const green = Math.max(0, Math.min(en, gen));
  const gridKwh = Math.max(0, en - green);
  if (gridKwh <= 0) return 0;
  if (tariff.type === 'flat') return gridKwh * (tariff.flatRate || 0);
  const seasonId = _seasonFor(tariff, s.ts);
  const cfg = loadBaseline();
  if (cfg.mode === 'flat_avg') {
    const mid = _localMidnightS(s.ts);
    let rate = 0;
    for (let h = 0; h < 24; h++) rate += _bandRate(tariff, _bandFor(tariff, mid + h * 3600), seasonId);
    return gridKwh * (rate / 24);
  }
  const segs = _chargeSegments(s);
  const dur = segs.reduce((a, sg) => a + (sg.dur || 0), 0) || (s.dur || 3600);
  const startTs = (cfg.mode === 'fixed_time') ? _fixedStart(s.ts, cfg.fixedTime) : s.ts;
  const step = 300, n = Math.max(1, Math.ceil(dur / step)), per = gridKwh / n;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const t = startTs + i * step;
    if (t >= startTs + dur) break;
    sum += per * _bandRate(tariff, _bandFor(tariff, t), seasonId);
  }
  return sum;
}

// Cost + savings from the firmware CHARGE-LOG (ground truth: real cp-based
// charge windows with per-burst green=gwh) rather than the session cache — the
// cache can mis-record daytime solar as grid (green=0), which inflated the cost.
// Each burst is billed as a mini-session at the rate of the hours it ran.
function _summarizeFromLog(tariff) {
  const now = Date.now() / 1000;
  const weekAgo = now - 7 * 86400;
  const d = new Date();
  const monthStart = new Date(d.getFullYear(), d.getMonth(), 1).getTime() / 1000;
  let wkCost = 0, moCost = 0, wkK = 0, moK = 0, wkSaved = 0, moSaved = 0,
    wkShift = 0, moShift = 0, moGrid = 0, moGreen = 0;
  const monthBands = {};
  (_chargeLog || []).forEach((iv) => {
    const st = iv.start || 0;
    if (st < weekAgo && st < monthStart) return;
    const stop = (iv.stop && iv.stop > st) ? iv.stop : st;
    const bs = { ts: st, stop, en: iv.wh || 0, gen: iv.gwh || 0, dur: Math.max(60, stop - st) };
    const t = _tariffForSession(bs);
    const bd = _sessionCost(t, bs);
    const kwh = (iv.wh || 0) / 1000, green = bd.green || 0;
    const shift = Math.max(0, _baselineCost(t, bs) - bd.total);
    // Solar value net of the feed-in/export rate (#151). feedIn 0 -> gross.
    const solar = Math.max(0, (bd.saved || 0) - green * (t.feedIn || 0));
    if (st >= weekAgo) { wkCost += bd.total; wkK += kwh; wkSaved += solar; wkShift += shift; }
    if (st >= monthStart) {
      moCost += bd.total; moK += kwh; moSaved += solar; moShift += shift;
      moGreen += green; moGrid += Math.max(0, kwh - green);
      for (const [k, v] of Object.entries(bd.byBand)) {
        monthBands[k] = monthBands[k] || { kwh: 0, cost: 0, name: v.name, color: v.color };
        monthBands[k].kwh += v.kwh; monthBands[k].cost += v.cost;
      }
    }
  });
  return { wkCost, moCost, wkK, moK, wkSaved, moSaved, wkShift, moShift, moGrid, moGreen, monthBands };
}

// ---- totals + cost ----
function recompute() {
  const now = Date.now() / 1000;
  const weekAgo = now - 7 * 86400;
  const d = new Date(); const monthStart = new Date(d.getFullYear(), d.getMonth(), 1).getTime() / 1000;
  const tariff = loadTariff();
  // Week/month kWh come from the charge-log (real metered charge windows) so the
  // tiles, the breakdown and the cost are all the SAME, consistent figure — not
  // a stale / solar-as-grid session total. Falls back to the session cache only
  // if the firmware has no charge-log.
  let wk = 0, mo = 0;
  if (_chargeLog && _chargeLog.length) {
    _chargeLog.forEach((iv) => {
      const st = iv.start || 0, k = (iv.wh || 0) / 1000;
      if (st >= weekAgo) wk += k;
      if (st >= monthStart) mo += k;
    });
  } else {
    _sessions.forEach((s) => {
      const kwh = (s.en || 0) / 1000;
      if (s.ts >= weekAgo) wk += kwh;
      if (s.ts >= monthStart) mo += kwh;
    });
  }
  const L = tariff ? _summarizeFromLog(tariff) : null;
  const wkCost = L ? L.wkCost : 0, moCost = L ? L.moCost : 0;
  const moGreen = L ? L.moGreen : 0, moGrid = L ? L.moGrid : 0, moSaved = L ? L.moSaved : 0;
  const monthBands = L ? L.monthBands : {};
  if (_lifetimeKwh != null) setText('tile-allt', _lifetimeKwh.toFixed(0));
  setText('tile-week', wk.toFixed(1));
  setText('tile-month', mo.toFixed(1));
  renderSourceSplit(moGrid, moGreen, tariff ? moSaved : 0, tariff && tariff.currency || '$', tariff && L ? L.moCost : null);
  updateTariffSummary(tariff);
  const row = $('cost-row'), cb = $('cost-breakdown'), heroCost = $('hero-cost');
  const cur = (tariff && tariff.currency) || '$';
  if (tariff) {
    row.hidden = false;
    if (heroCost) heroCost.hidden = false;   // month cost inline in the hero
    setText('tile-week-cost', cur + wkCost.toFixed(2));
    setText('tile-month-cost', cur + moCost.toFixed(2));
    renderCostBreakdown(monthBands, cur);
  } else {
    row.hidden = true;
    if (heroCost) heroCost.hidden = true;
    if (cb) cb.hidden = true;
  }
  // Rich hero: this-month grid/solar split bar + (when priced) solar savings.
  const heroSplit = $('hero-split');
  if (heroSplit) {
    const totKwh = moGrid + moGreen;
    if (totKwh > 0) {
      const solarPct = Math.round((moGreen / totKwh) * 100);
      const gridPct = 100 - solarPct;
      setText('hero-grid-pct', gridPct + '%');
      setText('hero-solar-pct', solarPct + '%');
      const gb = $('hero-bar-grid'); if (gb) gb.style.width = gridPct + '%';
      const sb = $('hero-bar-solar'); if (sb) sb.style.width = solarPct + '%';
      heroSplit.hidden = false;
    } else {
      heroSplit.hidden = true;
    }
  }
  const heroSaved = $('hero-saved');
  if (heroSaved) heroSaved.textContent = (tariff && moSaved > 0)
    ? ('· saved ' + cur + moSaved.toFixed(2) + ' on solar') : '';
  // Publish the cost summary so the Dashboard can show week/month cost tiles
  // without duplicating the tariff/cost engine (single source of truth here).
  try {
    if (tariff && L) {
      localStorage.setItem('wb-addon-cost-summary', JSON.stringify({
        weekCost: L.wkCost, monthCost: L.moCost, weekKwh: L.wkK, monthKwh: L.moK,
        weekShiftSaved: L.wkShift, monthShiftSaved: L.moShift,
        weekSolarSaved: L.wkSaved, monthSolarSaved: L.moSaved,
        weekSaved: L.wkShift + L.wkSaved, monthSaved: L.moShift + L.moSaved,
        source: 'charge-log', currency: cur, ts: Math.floor(Date.now() / 1000),
      }));
    } else {
      localStorage.removeItem('wb-addon-cost-summary');
    }
  } catch (e) { /* localStorage full / disabled — tiles just stay hidden */ }
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
  const extra = (tariff.seasonal ? ' · seasonal' : '') + (tariff.provider ? ' · ' + tariff.provider : '');
  el.textContent = `Time-of-use: ${bands}${extra}`;
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

// This-month grid vs solar (green) energy split. Solar is free; only grid is
// billed. Hidden until sessions carry the green field (cache v2).
// Clearly-defined charging breakdown for THIS MONTH, all from the charge-log
// (charging only — never whole-house). Each row is what it says + a hover note.
function renderSourceSplit(grid, green, saved, cur, cost) {
  const el = $('src-split');
  if (!el) return;
  const total = grid + green;
  if (total <= 0) { el.hidden = true; return; }   // no charging logged yet
  el.hidden = false;
  el.textContent = '';
  const gPct = Math.round((grid / total) * 100), sPct = 100 - gPct;
  const head = document.createElement('div');
  head.className = 'cbrk-head';
  head.textContent = 'Charging breakdown · this month';
  el.appendChild(head);
  const row = (label, value, def, cls) => {
    const r = document.createElement('div'); r.className = 'cbrk-row' + (cls ? ' ' + cls : '');
    const l = document.createElement('span'); l.className = 'cbrk-label'; l.textContent = label;
    if (def) { l.title = def; const i = document.createElement('span'); i.className = 'cbrk-i'; i.textContent = ' ⓘ'; l.appendChild(i); }
    const v = document.createElement('span'); v.className = 'cbrk-val'; v.textContent = value;
    r.appendChild(l); r.appendChild(v);
    el.appendChild(r);
  };
  row('Energy charged', `${total.toFixed(1)} kWh`,
    'All energy delivered to the car this month (grid + solar).');
  row('⚡ Grid (billed)', `${grid.toFixed(1)} kWh · ${gPct}%`,
    'Energy charged from the grid — the only part you pay for.');
  row('☀️ Solar (free)', `${green.toFixed(1)} kWh · ${sPct}%`,
    'Energy charged from your solar — free, never billed.');
  if (cost != null) {
    row('Charging cost', `${cur}${(cost || 0).toFixed(2)}`,
      'Grid energy used for charging × your tariff. Solar is excluded — this is charging only, not your whole-house bill.', 'cbrk-cost');
  }
  if (saved > 0) {
    row('Solar value', `${cur}${saved.toFixed(2)}`,
      'What that free solar charging WOULD have cost at grid rates — your saving.', 'cbrk-saved');
  }
}

// ---- heatmap (day x hour kWh intensity), browser-local ----
function buildHeatmap() {
  const hm = $('heatmap'); if (!hm) return;
  const grid = Array.from({ length: 7 }, () => Array(24).fill(0));
  let max = 0;
  const step = 300;
  // Spread `kwh` across [ts, ts+dur] in `step`-second buckets, binned by
  // day/hour in the charger's timezone.
  const place = (ts, dur, kwh) => {
    const span = dur || 3600;
    const n = Math.max(1, Math.ceil(span / step));
    const per = kwh / n;
    for (let i = 0; i < n; i++) {
      const t = ts + i * step;
      if (t >= ts + span) break;
      const { day, hour } = tzDayHour(t);
      grid[day][hour] += per;
      if (grid[day][hour] > max) max = grid[day][hour];
    }
  };
  if (_chargeLog && _chargeLog.length) {
    // Ground truth: place each firmware charge-log interval directly, exactly
    // as the gateway's own /sessions heatmap does (id 'cl'+start). Iterating the
    // SAME source with the SAME placement is what keeps the two heatmaps
    // identical — going via cached r_ses sessions dropped intervals whose
    // per-session r_log read failed / returned 0, so the grids diverged.
    _chargeLog.forEach((iv) => {
      const wh = iv.wh || 0;
      if (!wh) return;
      place(iv.start, Math.max(60, (iv.stop || iv.start) - iv.start), wh / 1000);
    });
  } else {
    // No firmware charge-log (older gateway) — fall back to the session cache,
    // placing energy in the real/inferred charge window.
    _sessions.forEach((s) => {
      const wh = _sessionWh(s);
      if (!s.ts || !wh) return;
      _chargeSegments(s).forEach((seg) => place(seg.start, seg.dur, (wh / 1000) * seg.frac));
    });
  }
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
  for (const d of DAY_ORDER) {          // Mon→Sun rows; grid[] is getDay()-indexed
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
const SESS_COLLAPSED = 8;   // enough rows to fill the card next to the taller Costs card
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
    meta.textContent = `${(_sessionWh(s) / 1000).toFixed(2)} kWh · ${mins} min`;
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
  // Re-fetch any session in the most-recent window that isn't cached — covers
  // NEW sessions AND earlier ones whose read previously failed (rate-limit /
  // BLE busy). Without this, a single failed read permanently dropped a
  // session from the totals (the old code only tracked the highest id).
  const startSid = Math.max(1, last - 59);
  const missing = [];
  for (let sid = startSid; sid <= last; sid++) {
    if (!cache.s[sid]) missing.push(sid);
  }
  if (!missing.length) { writeCache(cache); return; }
  const listEl = $('sess-list');
  const firstLoad = !Object.keys(cache.s).length;
  let done = 0;
  for (const sid of missing) {
    if (firstLoad && listEl) listEl.textContent = `Loading ${done + 1} / ${missing.length}…`;
    const sd = await _fetchLog(sid);  // retries on transient failure
    if (sd) {
      cache.s[sid] = {
        id: sid, ts: sd.start, stop: sd.stop || 0,  // plug-in span [ts, stop]
        dur: sd.sec || sd.dur || sd.duration || 0,   // actual CHARGE seconds
        en: sd.en || sd.energy || 0,
        gen: sd.gen || 0,  // green (solar) energy — free, not billed
      };
      // Persist incrementally so progress survives a mid-load reload.
      _sessions = Object.values(cache.s); writeCache(cache);
    }
    done++;
  }
  _sessions = Object.values(cache.s);
  writeCache(cache);
  renderAll();
}

// One session log, retried on transient failure (gateway rate-limit / BLE busy)
// with a short backoff, so a session is never silently skipped.
async function _fetchLog(sid, attempts = 3) {
  for (let i = 0; i < attempts; i++) {
    const r = await fetchJSON('api/sess?met=r_log&par=' + sid + '&wait=6000');
    if (r.ok && r.body && r.body.r && r.body.r.start) return r.body.r;
    await new Promise((res) => setTimeout(res, 600));
  }
  return null;
}

function exportCsv() {
  const rows = [['id', 'start_iso', 'duration_min', 'energy_kwh']];
  _sessions.slice().sort((a, b) => a.ts - b.ts).forEach((s) => {
    rows.push([s.id, new Date(s.ts * 1000).toISOString(), Math.round((s.dur || 0) / 60), (_sessionWh(s) / 1000).toFixed(3)]);
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
  if (typeof _edit.seasonal !== 'boolean') _edit.seasonal = false;
  if (!Array.isArray(_edit.seasons) || _edit.seasons.length < 2) _edit.seasons = defaultTariff().seasons;
  $('tm-provider').value = _edit.provider || '';
  $('tm-currency').value = _edit.currency || '$';
  $('tm-feed-in').value = _edit.feedIn != null ? _edit.feedIn : '';
  $('tm-flat-rate').value = _edit.flatRate != null ? _edit.flatRate : '';
  document.querySelectorAll('input[name="tm-type"]').forEach((r) => { r.checked = (r.value === _edit.type); });
  $('tm-weekend-same').checked = !!_edit.weekendSame;
  $('tm-seasonal').checked = !!_edit.seasonal;
  $('tm-paint-hint').textContent = 'Tip: tap an hour repeatedly to cycle through your rate bands.';
  const eff = $('tm-effective'); if (eff) eff.value = _epochToDateInput(_edit.validFrom || 0);
  populateMonthSelects();
  renderTariffType(); renderSeasons(); renderHours(); renderWeekendWrap(); renderTariffHistory();
  $('tariff-modal').hidden = false;
}
function _fillMonthSelect(id, selected) {
  const sel = $(id); if (!sel) return;
  sel.textContent = '';
  MONTHS.forEach((m, i) => {
    const o = document.createElement('option'); o.value = i; o.textContent = m;
    if (i === selected) o.selected = true;
    sel.appendChild(o);
  });
}
function populateMonthSelects() {
  const sum = _edit.seasons.find((s) => s.id === 'summer') || _edit.seasons[0];
  const win = _edit.seasons.find((s) => s.id === 'winter') || _edit.seasons[1];
  _fillMonthSelect('tm-sum-from', sum.from); _fillMonthSelect('tm-sum-to', sum.to);
  _fillMonthSelect('tm-win-from', win.from); _fillMonthSelect('tm-win-to', win.to);
}
function renderSeasons() { $('tm-seasons').hidden = !_edit.seasonal; renderBands(); }
function closeTariff() { $('tariff-modal').hidden = true; _edit = null; }
function renderTariffType() { $('tm-flat').hidden = _edit.type !== 'flat'; $('tm-tou').hidden = _edit.type !== 'tou'; }
function renderWeekendWrap() { $('tm-weekend-wrap').hidden = !!_edit.weekendSame; }

function renderBands() {
  const wrap = $('tm-bands'); wrap.textContent = '';
  _edit.bands.forEach((b, i) => {
    const cont = document.createElement('div'); cont.className = 'tm-band-wrap';
    const row = document.createElement('div'); row.className = 'tm-band';
    const sw = document.createElement('input'); sw.type = 'color'; sw.value = b.color || '#3b82f6'; sw.className = 'tm-band-color';
    sw.oninput = () => { b.color = sw.value; renderHours(); };
    const name = document.createElement('input'); name.type = 'text'; name.value = b.name || ''; name.placeholder = 'Name'; name.className = 'tm-band-name';
    name.oninput = () => { b.name = name.value; };
    const rate = document.createElement('input'); rate.type = 'number'; rate.min = '0'; rate.step = '0.01'; rate.className = 'tm-band-rate';
    rate.placeholder = _edit.seasonal ? 'default' : '0.00';
    rate.value = b.rate != null ? b.rate : '';
    rate.oninput = () => { b.rate = parseFloat(rate.value) || 0; };
    row.appendChild(sw); row.appendChild(name); row.appendChild(rate);
    if (_edit.bands.length > 1) {
      const rm = document.createElement('button'); rm.type = 'button'; rm.className = 'tm-band-rm'; rm.textContent = '×';
      rm.onclick = () => removeBand(i);
      row.appendChild(rm);
    }
    cont.appendChild(row);
    if (_edit.seasonal) {
      b.seasonRates = b.seasonRates || {};
      const sr = document.createElement('div'); sr.className = 'tm-band-seasons';
      _edit.seasons.forEach((s) => {
        const lbl = document.createElement('label'); lbl.className = 'tm-srate-lbl';
        lbl.appendChild(document.createTextNode(s.name + ' '));
        const inp = document.createElement('input'); inp.type = 'number'; inp.min = '0'; inp.step = '0.01'; inp.className = 'tm-band-srate';
        inp.placeholder = String(b.rate != null ? b.rate : '');
        if (b.seasonRates[s.id] != null) inp.value = b.seasonRates[s.id];
        inp.oninput = () => { b.seasonRates[s.id] = (inp.value === '') ? undefined : (parseFloat(inp.value) || 0); };
        lbl.appendChild(inp);
        sr.appendChild(lbl);
      });
      cont.appendChild(sr);
    }
    wrap.appendChild(cont);
  });
}
function removeBand(i) {
  const removed = _edit.bands[i].id;
  _edit.bands.splice(i, 1);
  const fb = _cheapestBand(_edit).id;  // orphaned hours -> cheapest band (visible + billed alike)
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
      const band = _edit.bands.find((b) => b.id === _edit[which][h]) || _cheapestBand(_edit);
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
  _edit.feedIn = parseFloat($('tm-feed-in').value) || 0;
  _edit.flatRate = parseFloat($('tm-flat-rate').value) || 0;
  _edit.weekendSame = $('tm-weekend-same').checked;
  _edit.seasonal = $('tm-seasonal').checked;
  const setSeason = (id, f, t) => {
    const s = _edit.seasons.find((x) => x.id === id);
    if (s) { s.from = parseInt($(f).value, 10); s.to = parseInt($(t).value, 10); }
  };
  setSeason('summer', 'tm-sum-from', 'tm-sum-to');
  setSeason('winter', 'tm-win-from', 'tm-win-to');
  // Effective-date handling: if these rates start LATER than the current
  // tariff's, archive the current period and begin a new one — so sessions
  // before the change keep the old rates.
  const effFrom = _dateInputToEpoch($('tm-effective').value);
  const cur = loadTariff();
  if (cur && effFrom > (cur.validFrom || 0)) {
    const hist = loadTariffHistory();
    hist.push(JSON.parse(JSON.stringify(cur)));  // keeps its own validFrom
    saveTariffHistory(hist);
    _edit.validFrom = effFrom;
  } else {
    _edit.validFrom = effFrom || (cur && cur.validFrom) || 0;
  }
  saveTariff(_edit);
  closeTariff();
  recompute();
}
function _epochToDateInput(epoch) {
  if (!epoch) return '';
  const d = new Date(epoch * 1000), p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function _dateInputToEpoch(v) {
  if (!v) return 0;
  const t = new Date(v + 'T00:00:00').getTime();
  return isNaN(t) ? 0 : Math.floor(t / 1000);
}
function renderTariffHistory() {
  const el = $('tm-history'); if (!el) return;
  el.textContent = '';
  const cur = loadTariff();
  const periods = loadTariffHistory();
  if (cur) periods.push(cur);
  if (periods.length <= 1) {
    el.textContent = 'One rate period — applies to all sessions. Set a date above when your rates change so past costs stay accurate.';
    return;
  }
  const title = document.createElement('div');
  title.textContent = 'Rate periods (older sessions keep older rates):';
  title.style.fontWeight = '600'; el.appendChild(title);
  periods.forEach((p, i) => {
    const from = p.validFrom ? _epochToDateInput(p.validFrom) : 'always';
    const to = (i < periods.length - 1) ? _epochToDateInput(periods[i + 1].validFrom) : 'now';
    const rates = p.type === 'flat'
      ? `flat ${p.currency || ''}${(p.flatRate || 0).toFixed(2)}`
      : (p.bands || []).map((b) => (b.rate || 0).toFixed(2)).join('/');
    const row = document.createElement('div');
    row.textContent = `• ${from} → ${to}: ${rates}`;
    el.appendChild(row);
  });
  const reset = document.createElement('button');
  reset.type = 'button'; reset.className = 'ctrl-btn'; reset.style.marginTop = '6px';
  reset.textContent = 'Clear rate history';
  reset.onclick = () => { saveTariffHistory([]); renderTariffHistory(); recompute(); };
  el.appendChild(reset);
}
(function initTariffUI() {
  const open = $('tariff-edit'); if (open) open.addEventListener('click', openTariff);
  const close = $('tm-close'); if (close) close.addEventListener('click', closeTariff);
  const modal = $('tariff-modal'); if (modal) modal.addEventListener('click', (e) => { if (e.target === modal) closeTariff(); });
  document.querySelectorAll('input[name="tm-type"]').forEach((r) => r.addEventListener('change', () => { if (_edit) { _edit.type = r.value; renderTariffType(); } }));
  const ws = $('tm-weekend-same'); if (ws) ws.addEventListener('change', () => { if (_edit) { _edit.weekendSame = ws.checked; renderWeekendWrap(); } });
  const ssn = $('tm-seasonal'); if (ssn) ssn.addEventListener('change', () => { if (_edit) { _edit.seasonal = ssn.checked; renderSeasons(); } });
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
  // Load the real/inferred charge windows BEFORE rendering so cost + heatmap
  // place energy correctly on first paint. Both are best-effort.
  await Promise.all([loadChargeLog(), loadScheduleWindows()]);
  loadSessions();
})();

// Enabled native schedules as UTC windows — used to infer the charge window
// for sessions that predate firmware capture (the car charges in the window,
// not at plug-in). start/stop are "HHMM" UTC; days is a Mon-indexed bitmask.
async function loadScheduleWindows() {
  const r = await fetchJSON('api/sched?met=r_schs&par=null&wait=6000');
  const scheds = (r.ok && r.body.r && Array.isArray(r.body.r.schedules)) ? r.body.r.schedules : [];
  _scheduleWindows = scheds.filter((s) => s.enabled).map((s) => {
    const startMin = _parseHHMM(s.start);
    let lenMin = _parseHHMM(s.stop) - startMin;
    if (lenMin <= 0) lenMin += 1440;  // window wraps past midnight
    return { startMinUTC: startMin, lenS: lenMin * 60, days: parseInt(s.days, 10) || 0 };
  });
}

// Real charge intervals recorded by the gateway firmware (flat list, mapped to
// sessions by time in _chargeSegments). Ground truth; overrides inference.
async function loadChargeLog() {
  const r = await fetchJSON('api/charge_log');
  _chargeLog = (r.ok && r.body && Array.isArray(r.body.intervals)) ? r.body.intervals : [];
}
