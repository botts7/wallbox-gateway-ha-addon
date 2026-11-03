// The charger's real current ceiling, shared by the dashboard and the Charge
// Assistant page.
//
// Wallbox chargers report their own limit as max_available_current: 32 A on
// most EU units, 40 A or 48 A on US Pulsar Plus, lower when the installer
// limited the circuit. Fixed max="32" controls held US chargers back (#39).
// Same rule as the integration's current_limits.py and the gateway dashboard:
// realtime first, then status, then the gateway's saved ceiling
// (max_current_ceiling in /api/status, known from boot on newer firmware),
// else 32 A.
(function () {
  const DEFAULT = 32;

  function ceilingFrom(realtime, status, gateway) {
    for (const src of [realtime, status]) {
      if (!src || typeof src !== "object") continue;
      let v = src.max_available_current;
      if (v === undefined || v === null) v = src.maxAvailableCurrent;
      if (Number.isInteger(v) && v >= 6 && v <= 80) return v;
    }
    const g = gateway && gateway.max_current_ceiling;
    if (Number.isInteger(g) && g >= 6 && g <= 80) return g;
    return DEFAULT;
  }

  // Set each input's max (and placeholder, when it showed the old 32) to the
  // ceiling, and pull a value above it back down.
  function applyCeiling(ceiling, ids) {
    ids.forEach((id) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.max = String(ceiling);
      if (el.placeholder === String(DEFAULT)) el.placeholder = String(ceiling);
      if (el.value !== "" && Number(el.value) > ceiling) el.value = String(ceiling);
    });
  }

  // A saved limit below the charger's ceiling, else null. Older integration
  // forms saved 32 A on their own, so a 40/48 A charger can be held back by a
  // value nobody chose. Same rule as the integration's below_ceiling().
  function belowCeiling(value, ceiling) {
    if (value === "" || value === null || value === undefined) return null;
    const v = Number(value);
    return Number.isFinite(v) && v > 0 && v < ceiling ? v : null;
  }

  window.wbCurrentLimits = { DEFAULT, ceilingFrom, applyCeiling, belowCeiling };
})();
