// The charger's real current ceiling, shared by the dashboard and the Charge
// Assistant page.
//
// Wallbox chargers report their own limit as max_available_current: 32 A on
// most EU units, 40 A or 48 A on US Pulsar Plus, lower when the installer
// limited the circuit. Fixed max="32" controls held US chargers back (#39).
// Same rule as the integration's current_limits.py and the gateway dashboard:
// realtime first, then status, else 32 A.
(function () {
  const DEFAULT = 32;

  function ceilingFrom(realtime, status) {
    for (const src of [realtime, status]) {
      if (!src || typeof src !== "object") continue;
      let v = src.max_available_current;
      if (v === undefined || v === null) v = src.maxAvailableCurrent;
      if (Number.isInteger(v) && v >= 6 && v <= 80) return v;
    }
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

  window.wbCurrentLimits = { DEFAULT, ceilingFrom, applyCeiling };
})();
