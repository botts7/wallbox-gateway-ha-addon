// Shared charging-cost engine. Self-contained IIFE (no global symbol clashes
// with dashboard.js / sessions.js) exposing window.WBCost.
//
// WBCost.refresh() loads the tariff + real charge windows (firmware charge-log)
// + native schedules + the cached session list, recomputes the week/month cost
// exactly as the Sessions page does, and writes `wb-addon-cost-summary` to
// localStorage. The dashboard calls it so its cost tiles stay current without
// the user opening the Sessions page.
//
// NOTE: the cost logic here mirrors sessions.js verbatim (same inputs -> same
// numbers). Consolidating sessions.js onto this module is a follow-up so there
// is a single copy; until then keep the two in sync.
window.WBCost = (function () {
  'use strict';
  const TARIFF_KEY = 'wb-addon-tariff-v1';
  const TARIFF_HIST_KEY = 'wb-addon-tariff-history-v1';
  const SESSIONS_KEY = 'wb-addon-sessions-v2';
  const SUMMARY_KEY = 'wb-addon-cost-summary';
  const BASELINE_KEY = 'wb-addon-savings-baseline-v1';
  const DEFAULT_BANDS = [
    { id: 'off', name: 'Off-peak', rate: 0.18, color: '#22c55e' },
    { id: 'sho', name: 'Shoulder', rate: 0.28, color: '#f59e0b' },
    { id: 'pk', name: 'Peak', rate: 0.45, color: '#ef4444' },
  ];

  let CHARGER_TZ = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch (e) { return 'UTC'; } })();
  let _chargeLog = [];
  let _scheduleWindows = [];

  async function fetchJSON(path) {
    try {
      const r = await fetch(path, { cache: 'no-store' });
      const body = await r.json().catch(() => ({}));
      return { ok: r.ok, status: r.status, body };
    } catch (e) {
      return { ok: false, status: 0, body: {} };
    }
  }

  // Robust epoch -> calendar parts in CHARGER_TZ via Intl.formatToParts (stable
  // across engines and DST) — see sessions.js for the rationale. Cached formatter
  // rebuilds when CHARGER_TZ changes (set from the charger's g_tzn after boot).
  const _DOW = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  let _tzFmt = null, _tzFmtZone = null;
  function _tzFormatter() {
    if (_tzFmt && _tzFmtZone === CHARGER_TZ) return _tzFmt;
    const opts = { weekday: 'short', year: 'numeric', month: 'numeric', day: '2-digit',
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
  function tzDayHour(epoch) { const p = tzParts(epoch); return { day: p.day, hour: p.hour }; }

  // ---- tariff model (mirrors sessions.js) ----
  function _monthInSeason(month, season) {
    const f = season.from, t = season.to;
    return (f <= t) ? (month >= f && month <= t) : (month >= f || month <= t);
  }
  function _seasonFor(tariff, epoch) {
    if (!tariff.seasonal || !Array.isArray(tariff.seasons)) return null;
    const month = tzParts(epoch).month;
    for (const s of tariff.seasons) { if (_monthInSeason(month, s)) return s.id; }
    return null;
  }
  function _bandRate(tariff, band, seasonId) {
    if (tariff.seasonal && seasonId && band.seasonRates && band.seasonRates[seasonId] != null) {
      return band.seasonRates[seasonId];
    }
    return band.rate || 0;
  }
  function loadTariff() {
    try { const t = JSON.parse(localStorage.getItem(TARIFF_KEY)); if (t && t.type) return t; } catch (e) {}
    return null;
  }
  function loadTariffHistory() {
    try {
      const h = JSON.parse(localStorage.getItem(TARIFF_HIST_KEY));
      if (Array.isArray(h)) return h.slice().sort((a, b) => (a.validFrom || 0) - (b.validFrom || 0));
    } catch (e) {}
    return [];
  }
  function _tariffForSession(s) {
    const cur = loadTariff();
    if (!cur) return null;
    const ts = s.ts || 0;
    if (ts >= (cur.validFrom || 0)) return cur;
    const hist = loadTariffHistory();
    for (let i = hist.length - 1; i >= 0; i--) {
      if (ts >= (hist[i].validFrom || 0)) return hist[i];
    }
    return hist[0] || cur;
  }
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
      const b = (tariff.bands || []).find((x) => x.id === painted);
      if (b) return b;
    }
    return _cheapestBand(tariff);
  }
  function _parseHHMM(v) {
    const n = parseInt(String(v), 10) || 0;
    return Math.floor(n / 100) * 60 + (n % 100);
  }
  // Charger day-bitmask is Sunday-first (bit0=Sun..bit6=Sat), so getUTCDay()
  // (0=Sun) is already the bit index — no Monday shift.
  function _dayBit(epoch) { return new Date(epoch * 1000).getUTCDay(); }

  function _governingStart(ts, dur) {
    if (!_scheduleWindows.length) return null;
    let best = null;
    _scheduleWindows.forEach((w) => {
      const dayStart = Math.floor(ts / 86400) * 86400;
      let cand = dayStart + w.startMinUTC * 60;
      if (ts >= cand + w.lenS) cand += 86400;
      for (let g = 0; g < 8; g++) {
        if (w.days & (1 << _dayBit(cand))) break;
        cand += 86400;
      }
      const start = Math.max(ts, cand);
      if (best === null || start < best) best = start;
    });
    return best;
  }

  function _chargeSegments(s) {
    const spanEnd = (s.stop && s.stop > s.ts) ? s.stop : (s.ts + (s.dur || 3600) + 86400);
    const ivals = _chargeLog.filter((iv) => iv.start >= s.ts && iv.start <= spanEnd);
    if (ivals.length) {
      const totWh = ivals.reduce((a, b) => a + (b.wh || 0), 0) || 1;
      const totGwh = ivals.reduce((a, b) => a + (b.gwh || 0), 0);
      return ivals.map((iv) => ({
        start: iv.start,
        dur: Math.max(60, (iv.stop || iv.start) - iv.start),
        frac: (iv.wh || 0) / totWh,
        gFrac: totGwh > 0 ? (iv.gwh || 0) / totGwh : (iv.wh || 0) / totWh,
      }));
    }
    const dur = s.dur || 3600;
    const gs = _governingStart(s.ts, dur);
    if (gs != null) return [{ start: gs, dur, frac: 1, gFrac: 1 }];
    return [{ start: s.ts, dur, frac: 1, gFrac: 1 }];
  }

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
    const step = 300;
    const seasonId = _seasonFor(tariff, s.ts);
    const segs = _chargeSegments(s);
    const rawGrid = segs.map((sg) => Math.max(0, en * sg.frac - green * sg.gFrac));
    const sumRaw = rawGrid.reduce((a, b) => a + b, 0);
    const gridPer = (sumRaw > 0)
      ? rawGrid.map((g) => g * gridKwh / sumRaw)
      : segs.map((sg) => gridKwh * sg.frac);
    const greenPer = segs.map((sg) => green * sg.gFrac);
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

  // What "without the assistant" means, per the user. Lets the savings number
  // match their real alternative instead of an assumption.
  //   plug_in   — charge immediately at plug-in (default)
  //   fixed_time— charge from a fixed clock time (e.g. an old timer)
  //   flat_avg  — no time-awareness: grid kWh at the day's average rate
  function loadBaseline() {
    try { const b = JSON.parse(localStorage.getItem(BASELINE_KEY)); if (b && b.mode) return b; } catch (e) {}
    return { mode: 'plug_in', fixedTime: '00:00' };
  }
  function _hhmmToMin(v) {
    const m = String(v || '').split(':');
    return (parseInt(m[0], 10) || 0) * 60 + (parseInt(m[1], 10) || 0);
  }
  function _localMidnight(epoch) {
    const p = tzParts(epoch);
    return epoch - (p.hour * 3600 + p.minute * 60 + p.second);
  }
  function _fixedStart(ts, hhmm) {
    let start = _localMidnight(ts) + _hhmmToMin(hhmm) * 60;
    if (start < ts) start += 86400;       // next occurrence at/after plug-in
    return start;
  }

  // Counterfactual baseline: the SAME grid kWh, charged per the chosen baseline
  // mode, costed on the same tariff. Savings = baseline − actual is the value of
  // time-shifting. An estimate vs a stated baseline — measured energy + real
  // tariff; only the start-time is assumed. Flat tariffs yield zero time-shift.
  function _baselineCost(tariff, s) {
    const en = (s.en || 0) / 1000, gen = (s.gen || 0) / 1000;
    const green = Math.max(0, Math.min(en, gen));
    const gridKwh = Math.max(0, en - green);
    if (gridKwh <= 0) return 0;
    if (tariff.type === 'flat') return gridKwh * (tariff.flatRate || 0);
    const seasonId = _seasonFor(tariff, s.ts);
    const cfg = loadBaseline();

    if (cfg.mode === 'flat_avg') {
      // No time preference: average of the day's 24 hourly band rates.
      const mid = _localMidnight(s.ts);
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

  // ---- data loaders (mirror sessions.js) ----
  async function loadChargeLog() {
    const r = await fetchJSON('api/charge_log');
    _chargeLog = (r.ok && r.body && Array.isArray(r.body.intervals)) ? r.body.intervals : [];
  }
  async function loadScheduleWindows() {
    const r = await fetchJSON('api/sched?met=r_schs&par=null&wait=6000');
    const scheds = (r.ok && r.body.r && Array.isArray(r.body.r.schedules)) ? r.body.r.schedules : [];
    _scheduleWindows = scheds.filter((s) => s.enabled).map((s) => {
      const startMin = _parseHHMM(s.start), stopMin = _parseHHMM(s.stop);
      const lenMin = ((stopMin - startMin) + 1440) % 1440 || 1440;
      return { startMinUTC: startMin, lenS: lenMin * 60, days: parseInt(s.days, 10) || 0 };
    });
  }
  function loadCachedSessions() {
    try {
      const c = JSON.parse(localStorage.getItem(SESSIONS_KEY) || '{}');
      return c.s ? Object.keys(c.s).map((k) => c.s[k]) : [];
    } catch (e) { return []; }
  }

  // Week/month cost + savings straight from the firmware CHARGE-LOG — the
  // ground-truth cp-based charge windows, each carrying its real green share
  // (gwh). This is the single source of truth for cost: it avoids the browser
  // session cache, which could go stale (frozen when the Sessions page isn't
  // open) AND mis-record daytime solar as grid (green=0), wildly inflating the
  // month figure. Each burst is billed as a mini-session at the rate of the
  // hours it actually ran; solar (gwh) is free.
  function summarizeFromLog(tariff) {
    const now = Date.now() / 1000;
    const weekAgo = now - 7 * 86400;
    const d = new Date();
    const monthStart = new Date(d.getFullYear(), d.getMonth(), 1).getTime() / 1000;
    let wkC = 0, moC = 0, wkK = 0, moK = 0, wkSol = 0, moSol = 0, wkSh = 0, moSh = 0;
    (_chargeLog || []).forEach((iv) => {
      const st = iv.start || 0;
      if (st < weekAgo && st < monthStart) return;
      const stop = (iv.stop && iv.stop > st) ? iv.stop : st;
      const bs = { ts: st, stop, en: iv.wh || 0, gen: iv.gwh || 0, dur: Math.max(60, stop - st) };
      const t = _tariffForSession(bs);
      const bd = _sessionCost(t, bs);
      const kwh = (iv.wh || 0) / 1000;
      const shift = Math.max(0, _baselineCost(t, bs) - bd.total);
      // Solar value net of the feed-in/export rate: what we gave up by self-
      // consuming instead of exporting. feedIn 0 -> gross avoided-grid value (#151).
      const solar = Math.max(0, (bd.saved || 0) - (bd.green || 0) * (t.feedIn || 0));
      if (st >= weekAgo) { wkC += bd.total; wkK += kwh; wkSol += solar; wkSh += shift; }
      if (st >= monthStart) { moC += bd.total; moK += kwh; moSol += solar; moSh += shift; }
    });
    return {
      weekCost: wkC, monthCost: moC, weekKwh: wkK, monthKwh: moK,
      weekShiftSaved: wkSh, monthShiftSaved: moSh,
      weekSolarSaved: wkSol, monthSolarSaved: moSol,
    };
  }

  // Recompute week/month cost from the firmware charge-log + fresh windows, and
  // publish wb-addon-cost-summary (same shape sessions.js writes).
  async function refresh() {
    const tz = await fetchJSON('api/sess?met=g_tzn&par=null&wait=4000');
    if (tz.ok && tz.body.r && tz.body.r.timezone) CHARGER_TZ = tz.body.r.timezone;
    await Promise.all([loadChargeLog(), loadScheduleWindows()]);
    const tariff = loadTariff();
    if (!tariff) { try { localStorage.removeItem(SUMMARY_KEY); } catch (e) {} return null; }
    // Cost + savings from the charge-log (ground truth) — never the session
    // cache (could be stale / mis-record solar as grid).
    const s = summarizeFromLog(tariff);
    const summary = {
      weekCost: s.weekCost, monthCost: s.monthCost, weekKwh: s.weekKwh, monthKwh: s.monthKwh,
      weekShiftSaved: s.weekShiftSaved, monthShiftSaved: s.monthShiftSaved,
      weekSolarSaved: s.weekSolarSaved, monthSolarSaved: s.monthSolarSaved,
      weekSaved: s.weekShiftSaved + s.weekSolarSaved,
      monthSaved: s.monthShiftSaved + s.monthSolarSaved,
      source: 'charge-log',
      currency: (tariff.currency || '$'), ts: Math.floor(Date.now() / 1000),
    };
    try { localStorage.setItem(SUMMARY_KEY, JSON.stringify(summary)); } catch (e) {}
    return summary;
  }

  // Charger-tz UTC offset (minutes east of UTC) at `epoch`, taken from the
  // platform's real tz database via Intl — DST-correct, nothing hardcoded.
  // "Wall clock in tz composed as if UTC" minus the real UTC instant = offset.
  function tzOffsetMin(epoch) {
    try {
      const d = new Date(epoch * 1000);
      const p = {};
      for (const x of _tzFormatter().formatToParts(d)) p[x.type] = x.value;
      let hr = parseInt(p.hour, 10); if (hr === 24 || isNaN(hr)) hr = 0;
      const asUTC = Date.UTC(+p.year, (parseInt(p.month, 10) || 1) - 1, +p.day,
                             hr, +p.minute || 0, +p.second || 0);
      return Math.round((asUTC - d.getTime()) / 60000);
    } catch (e) { return 0; }
  }

  // Next scheduled charge as a UTC epoch, computed from the ENABLED native
  // schedules in the charger's LOCAL time. The charger stores `days` as the
  // local weekday (bit0=Sun) but `start` as a UTC minute-of-day, so we convert
  // each start to a local time-of-day (via the Intl-derived offset) before
  // pairing it with the local day bit. This is why the firmware's UTC-only
  // value landed a local-midnight window on the wrong day. Returns 0 when no
  // schedule/timezone is loaded yet (caller falls back to the firmware value).
  function nextChargeEpoch(nowEpoch) {
    nowEpoch = nowEpoch || Math.floor(Date.now() / 1000);
    if (!_scheduleWindows.length) return 0;
    const off = tzOffsetMin(nowEpoch);
    const lp = tzParts(nowEpoch);                       // charger-local now
    const nowMow = lp.day * 1440 + lp.hour * 60 + lp.minute;
    let best = Infinity;
    _scheduleWindows.forEach((w) => {
      if (!w.days) return;
      const localStart = (((w.startMinUTC + off) % 1440) + 1440) % 1440;
      for (let d = 0; d < 7; d++) {
        if (!((w.days >> d) & 1)) continue;
        let delta = (d * 1440 + localStart) - nowMow;
        if (delta < 0) delta += 7 * 1440;               // soonest future occurrence
        if (delta < best) best = delta;
      }
    });
    if (!isFinite(best)) return 0;
    // now stays UTC; local-minute delta == elapsed real minutes barring a DST
    // jump inside the next week (self-corrects on the next refresh).
    return nowEpoch - lp.second + best * 60;
  }

  // Format an epoch in the CHARGER's timezone (so the weekday shown matches the
  // schedule the user set, regardless of the viewing browser's timezone).
  function fmtLocal(epoch, opts) {
    try { return new Date(epoch * 1000).toLocaleString(undefined, Object.assign({ timeZone: CHARGER_TZ }, opts)); }
    catch (e) { return new Date(epoch * 1000).toLocaleString(undefined, opts); }
  }

  // Test hook: lets a headless/browser test inject the windows that are
  // normally fetched, then exercise the pure cost/baseline math directly.
  const _debug = {
    setData: (chargeLog, scheduleWindows, tz) => {
      _chargeLog = chargeLog || [];
      _scheduleWindows = scheduleWindows || [];
      if (tz) CHARGER_TZ = tz;
    },
    sessionCost: (tariff, s) => _sessionCost(tariff, s),
    baselineCost: (tariff, s) => _baselineCost(tariff, s),
    summarizeFromLog: (tariff) => summarizeFromLog(tariff),
  };

  return { refresh: refresh, nextChargeEpoch: nextChargeEpoch, fmtLocal: fmtLocal, _debug: _debug };
})();
