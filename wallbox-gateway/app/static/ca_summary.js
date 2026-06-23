// Shared Charge-Assistant summary renderer.
//
// One source of truth for turning a *saved* charge_assistant config object into
// plain English. Pure + DOM-free so it can be reused by:
//   * the Assistant page  (the "Active now" line — what's saved & running)
//   * the dashboard card   (a read-only "what's set" summary)
// Exposes window.CASummary = { text, modeName, MODE_NAMES }.
//
// `text(ca, nameOf)` returns a plain string (no HTML). `nameOf(entity_id)`
// is optional — when omitted, entity ids are shown verbatim.

(function () {
  "use strict";

  const TRIGGERS = ["arrival", "nightly", "lead", "tariff"];
  const MODE_NAMES = { off: "Off", reminder: "Reminder", target_soc: "Smart charge", solar: "Solar" };

  function joinList(parts) {
    if (parts.length === 1) return parts[0];
    if (parts.length === 2) return parts[0] + " or " + parts[1];
    return parts.slice(0, -1).join(", ") + ", or " + parts[parts.length - 1];
  }

  function modeName(ca) { return MODE_NAMES[(ca && ca.mode) || "off"] || "Off"; }

  function text(ca, nameOf) {
    ca = ca || {};
    const n = (eid) => (eid ? (nameOf ? nameOf(eid) : eid) : eid);
    const has = (v) => v != null && v !== "";
    const mode = ca.mode || "off";

    if (mode === "off") return "Off — nothing is automated; your charger works exactly as it does now.";

    if (mode === "reminder") {
      const on = (Array.isArray(ca.triggers) ? ca.triggers : []).filter((t) => TRIGGERS.includes(t));
      if (!on.length) return "Reminder mode — but no triggers are enabled yet.";
      const parts = on.map((t) => {
        if (t === "arrival") return "when " + (n(ca.arrival_entity) || "someone") + " gets home";
        if (t === "nightly") return "every night at " + (ca.nightly_time || "a set time");
        if (t === "lead") return (has(ca.lead_hours) ? ca.lead_hours + "h" : "a few hours") + " before a scheduled charge";
        if (t === "tariff") return "when the price drops to " + (has(ca.tariff_below) ? ca.tariff_below : "your threshold");
        return "";
      });
      let s = "Reminds you to plug in " + joinList(parts);
      if (has(ca.notify_service)) s += " via " + ca.notify_service;
      s += ".";
      if (has(ca.skip_above_pct)) s += " Stays quiet if the battery is already above " + ca.skip_above_pct + "%.";
      return s;
    }

    if (mode === "target_soc") {
      let s = "Charges up to " + (has(ca.target_soc_pct) ? ca.target_soc_pct : 80) + "%";
      if (has(ca.soc_entity)) s += " (reading " + n(ca.soc_entity) + ")";
      if (has(ca.departure_time)) s += ", ready by " + ca.departure_time;
      if (ca.cheapest_window && has(ca.price_entity)) {
        s += ", during the cheapest hours from " + n(ca.price_entity);
      } else if (ca.target_autostart) {
        s += ", auto-starting when below target";
      } else {
        s += ", then stops (no auto-start)";
      }
      if (has(ca.price_cap)) s += ", never above " + ca.price_cap;
      s += ".";
      return s;
    }

    if (mode === "solar") {
      const src = ca.surplus_source || "entity";
      let label = null;
      if (src === "grid") label = has(ca.grid_entity) ? "surplus from " + n(ca.grid_entity) : null;
      else if (src === "solar_load") label = (has(ca.solar_entity) && has(ca.load_entity)) ? n(ca.solar_entity) + " − " + n(ca.load_entity) : null;
      else label = has(ca.surplus_entity) ? n(ca.surplus_entity) : null;
      if (!label) return "Solar mode — but the surplus source isn't set yet.";
      let s = "Charges from excess solar: starts when " + label + " rises to " +
        (has(ca.surplus_start) ? ca.surplus_start : "the start") +
        ", pauses when it falls to " + (has(ca.surplus_stop) ? ca.surplus_stop : "the stop");
      if (ca.solar_dynamic) {
        s += ", modulating the current " + ((has(ca.min_current_a) ? ca.min_current_a : 6) + "–" + (has(ca.max_current_a) ? ca.max_current_a : 32) + " A");
        if (has(ca.load_limit_w) && Number(ca.load_limit_w) > 0) s += " under a " + ca.load_limit_w + " W house limit";
      }
      s += ".";
      return s;
    }
    return "";
  }

  window.CASummary = { text, modeName, MODE_NAMES };
})();
