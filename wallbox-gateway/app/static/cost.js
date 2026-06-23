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

  function tzDayHour(epoch) {
    try {
      const local = new Date(new Date(epoch * 1000).toLocaleString('en-US', { timeZone: CHARGER_TZ }));
      return { day: local.getDay(), hour: local.getHours() };
    } catch (e) {
      const d = new Date(epoch * 1000); return { day: d.getDay(), hour: d.getHours() };
    }
  }

  // ---- tariff model (mirrors sessions.js) ----
  function _monthInSeason(month, season) {
    const f = season.from, t = season.to;
    return (f <= t) ? (month >= f && month <= t) : (month >= f || month <= t);
  }
  function _seasonFor(tariff, epoch) {
    if (!tariff.seasonal || !Array.isArray(tariff.seasons)) return null;
    let month;
    try { month = new Date(new Date(epoch * 1000).toLocaleString('en-US', { timeZone: CHARGER_TZ })).getMonth(); }
    catch (e) { month = new Date(epoch * 1000).getMonth(); }
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
  function _monBit(epoch) { return ((new Date(epoch * 1000).getUTCDay() + 6) % 7); }

  function _governingStart(ts, dur) {
    if (!_scheduleWindows.length) return null;
    let best = null;
    _scheduleWindows.forEach((w) => {
      const dayStart = Math.floor(ts / 86400) * 86400;
      let cand = dayStart + w.startMinUTC * 60;
      if (ts >= cand + w.lenS) cand += 86400;
      for (let g = 0; g < 8; g++) {
        if (w.days & (1 << _monBit(cand))) break;
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
    try {
      const l = new Date(new Date(epoch * 1000).toLocaleString('en-US', { timeZone: CHARGER_TZ }));
      return epoch - (l.getHours() * 3600 + l.getMinutes() * 60 + l.getSeconds());
    } catch (e) { return Math.floor(epoch / 86400) * 86400; }
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

  // Recompute week/month cost from the cached sessions + fresh windows, and
  // publish wb-addon-cost-summary (same shape sessions.js writes).
  async function refresh() {
    const tz = await fetchJSON('api/sess?met=g_tzn&par=null&wait=4000');
    if (tz.ok && tz.body.r && tz.body.r.timezone) CHARGER_TZ = tz.body.r.timezone;
    await Promise.all([loadChargeLog(), loadScheduleWindows()]);
    const tariff = loadTariff();
    if (!tariff) { try { localStorage.removeItem(SUMMARY_KEY); } catch (e) {} return null; }
    const sessions = loadCachedSessions();
    const now = Date.now() / 1000;
    const weekAgo = now - 7 * 86400;
    const d = new Date(); const monthStart = new Date(d.getFullYear(), d.getMonth(), 1).getTime() / 1000;
    let wk = 0, mo = 0, wkCost = 0, moCost = 0;
    let wkShift = 0, moShift = 0, wkSolar = 0, moSolar = 0;
    sessions.forEach((s) => {
      const kwh = (s.en || 0) / 1000;
      const inWeek = s.ts >= weekAgo, inMonth = s.ts >= monthStart;
      if (inWeek) wk += kwh;
      if (inMonth) mo += kwh;
      if (inWeek || inMonth) {
        const t = _tariffForSession(s);
        const bd = _sessionCost(t, s);
        // Time-shift saving = what charging-at-plug-in would have cost minus the
        // actual cost. Solar saving = grid cost the green kWh avoided.
        const shift = Math.max(0, _baselineCost(t, s) - bd.total);
        if (inWeek) { wkCost += bd.total; wkShift += shift; wkSolar += bd.saved; }
        if (inMonth) { moCost += bd.total; moShift += shift; moSolar += bd.saved; }
      }
    });
    const summary = {
      weekCost: wkCost, monthCost: moCost, weekKwh: wk, monthKwh: mo,
      // Savings (estimates vs a "charged at plug-in" baseline — see _baselineCost).
      weekShiftSaved: wkShift, monthShiftSaved: moShift,
      weekSolarSaved: wkSolar, monthSolarSaved: moSolar,
      weekSaved: wkShift + wkSolar, monthSaved: moShift + moSolar,
      savingsBaseline: 'plug-in',
      currency: (tariff.currency || '$'), ts: Math.floor(Date.now() / 1000),
    };
    try { localStorage.setItem(SUMMARY_KEY, JSON.stringify(summary)); } catch (e) {}
    return summary;
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
  };

  return { refresh: refresh, _debug: _debug };
})();
