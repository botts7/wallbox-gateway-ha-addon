// How r_log addresses a charger's sessions (esp32-wallbox #79).
//
// r_log takes a SLOT, not the session number: session n lives in slot
// (n - 1) % size, where size is r_ses.size. The original Pulsar keeps a ring of
// 512, so only the newest 512 can be read; the Pulsar MAX reports 99999 (no
// wrap in practice) and its r_log <last> comes back empty. A charger that does
// take the session number is still handled: the probe decides, by number
// first (on a slot charger r_log <last> is empty or out of the ring), then by
// slot. On a number charger slot last-1 is session last-1, so a hit is refused
// when its uid names the neighbouring session the wrong addressing would
// return (the MAX's uid ends in the session number: ...00350 for 350). A uid
// in any other form never refuses, so an unknown format can't hide history.
(function () {
  function ringOf(rses) {
    const s = rses && rses.size;
    return Number.isInteger(s) && s > 0 ? s : 0;
  }

  // mode: { slot: bool, ring: int }
  function logPar(n, mode) {
    if (!mode || !mode.slot) return n;
    return mode.ring ? (n - 1) % mode.ring : n - 1;
  }

  // Oldest session number the charger can still return.
  function oldest(last, mode) {
    return mode && mode.slot && mode.ring ? Math.max(1, last - mode.ring + 1) : 1;
  }

  // Whether a record's uid ends in session number n (false for a uid in any
  // other form).
  function uidIs(rec, n) {
    const u = String((rec && rec.uid) || '');
    if (!/^\d+$/.test(u)) return false;
    const s = String(n);
    return u.slice(-s.length) === s;
  }

  // A probe hit: a real record that isn't, by its uid, the `wrong` session.
  function hit(rec, last, wrong) {
    return !!(rec && rec.start) && (uidIs(rec, last) || !uidIs(rec, wrong));
  }

  // Learn the addressing from the newest session. fetchLog(par) resolves to an
  // r_log record or null. Resolves to a mode, or null when neither works.
  async function probe(last, ring, fetchLog, known) {
    const tryNumber = async () => {
      const r = await fetchLog(last);
      return hit(r, last, last + 1) ? { slot: false, ring: 0 } : null;
    };
    const trySlot = async () => {
      const mode = { slot: true, ring };
      const r = await fetchLog(logPar(last, mode));
      return hit(r, last, last - 1) ? mode : null;
    };
    if (known && known.slot) return (await trySlot()) || (await tryNumber());
    return (await tryNumber()) || (await trySlot());
  }

  window.wbSessionSlots = { ringOf, logPar, oldest, uidIs, probe };
})();
