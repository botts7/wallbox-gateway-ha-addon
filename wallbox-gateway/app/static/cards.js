/* Wallbox Gateway Add-on — dashboard card manager.
 *
 * Lets the user show/hide the dashboard cards and drag to reorder them.
 * The layout (order + hidden set) is persisted per-browser in localStorage;
 * there is no backend round-trip. Cards live inside #card-deck (a masonry
 * column container); reordering is done by re-ordering the deck's children,
 * hiding by adding the `data-wb-hidden` attribute.
 *
 * `data-wb-hidden` is deliberately separate from the `[hidden]` attribute that
 * dashboard.js toggles for availability (halo/savings/assistant): a card is
 * shown only when it is NEITHER logic-hidden NOR user-hidden, so the two
 * mechanisms compose instead of fighting. This module never touches
 * `[hidden]` — it only owns the user's preference.
 *
 * We use an ATTRIBUTE (not a class) on purpose: dashboard.js reassigns some
 * cards' `className` wholesale on every poll (e.g. the Energy-flow card via
 * setStatus/setOffline), which would wipe a hide *class*. Attributes survive
 * that, so the user's hide sticks for every card.
 */
(function () {
  "use strict";

  var LS_KEY = "wb-addon-card-layout-v1";

  // Default order = this array's order (must match the markup in index.html).
  var REGISTRY = [
    { id: "energy-flow", label: "Energy flow",       icon: "⚡" },
    { id: "controls",    label: "Controls",          icon: "🎛️" },
    { id: "halo",        label: "Halo LED",          icon: "💡" },
    { id: "stats",       label: "Quick stats",       icon: "📊" },
    { id: "savings",     label: "Charging savings",  icon: "💰" },
    { id: "assistant",   label: "Charge Assistant",  icon: "🤖" },
    { id: "connections", label: "Connections",       icon: "📶" },
    { id: "device-info", label: "Device info",       icon: "ℹ️" },
    { id: "reconnect",   label: "Reconnect counters",icon: "🔁" },
    { id: "schedules",   label: "Charge schedules",  icon: "🗓️" },
  ];
  var DEFAULT_ORDER = REGISTRY.map(function (c) { return c.id; });
  var META = {};
  REGISTRY.forEach(function (c) { META[c.id] = c; });

  function deck() { return document.getElementById("card-deck"); }
  function cardEl(id) {
    var d = deck();
    return d ? d.querySelector('[data-card="' + id + '"]') : null;
  }
  // The card ids actually present in the deck, in DOM order. This — not the
  // hardcoded REGISTRY — is the source of truth for what can be reordered/
  // hidden, so a card added to index.html can never be silently dropped from
  // the feature just because it's missing a REGISTRY entry.
  function presentIds() {
    var d = deck();
    if (!d) return [];
    return Array.prototype.map.call(
      d.querySelectorAll("[data-card]"),
      function (el) { return el.getAttribute("data-card"); }
    );
  }
  // Metadata for a card id, with a humanized fallback for any deck card that
  // lacks a REGISTRY entry (so it still shows a sensible label/icon).
  function metaFor(id) {
    return META[id] || {
      id: id,
      label: id.replace(/[-_]+/g, " ").replace(/\b\w/g, function (c) { return c.toUpperCase(); }),
      icon: "▫️",
    };
  }

  // --- persistence ---------------------------------------------------------

  function load() {
    try {
      var raw = localStorage.getItem(LS_KEY);
      if (!raw) return null;
      var o = JSON.parse(raw);
      if (!o || typeof o !== "object") return null;
      return {
        order: Array.isArray(o.order) ? o.order : [],
        hidden: Array.isArray(o.hidden) ? o.hidden : [],
      };
    } catch (e) { return null; }
  }

  function save(order, hidden) {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify({ order: order, hidden: hidden }));
    } catch (e) { /* private mode / quota — layout just won't persist */ }
  }

  // Resolve the effective order from what's actually in the deck: the saved
  // order first (present ids only), then registry default order (stable slot
  // for known cards), then any remaining present cards (new/unknown) at the
  // end — so nothing vanishes on upgrade and nothing is dropped.
  function effectiveOrder(saved, present) {
    var order = [];
    var seen = {};
    function add(id) { if (present.indexOf(id) >= 0 && !seen[id]) { order.push(id); seen[id] = 1; } }
    if (saved && saved.order) saved.order.forEach(add);
    DEFAULT_ORDER.forEach(add);
    present.forEach(function (id) { if (!seen[id]) { order.push(id); seen[id] = 1; } });
    return order;
  }

  // --- apply to the live DOM ----------------------------------------------

  function apply() {
    var d = deck();
    if (!d) return;
    var saved = load();
    var present = presentIds();
    var order = effectiveOrder(saved, present);
    var hidden = (saved && saved.hidden) || [];
    var hiddenSet = {};
    hidden.forEach(function (id) { hiddenSet[id] = 1; });

    // Reorder: append in the resolved order (appendChild moves in place).
    order.forEach(function (id) {
      var el = cardEl(id);
      if (el) d.appendChild(el);
    });
    // Visibility (attribute, not class — see file header) over every present
    // card, so unknown/new cards are governed too.
    present.forEach(function (id) {
      var el = cardEl(id);
      if (!el) return;
      if (hiddenSet[id]) el.setAttribute("data-wb-hidden", "");
      else el.removeAttribute("data-wb-hidden");
    });
  }

  // --- customize panel -----------------------------------------------------

  var panel = null;

  function currentState() {
    // Read order + hidden straight from the live deck so the panel always
    // reflects reality (including any live apply()).
    var d = deck();
    var order = [];
    var hidden = [];
    if (d) {
      var cards = d.querySelectorAll("[data-card]");
      cards.forEach(function (el) {
        var id = el.getAttribute("data-card");
        if (!id) return;
        order.push(id);
        if (el.hasAttribute("data-wb-hidden")) hidden.push(id);
      });
    }
    return { order: order, hidden: hidden };
  }

  function persistFromRows() {
    var list = panel.querySelector(".cards-list");
    var order = [];
    var hidden = [];
    list.querySelectorAll(".cards-row").forEach(function (row) {
      var id = row.getAttribute("data-id");
      order.push(id);
      if (!row.querySelector(".cards-toggle").checked) hidden.push(id);
    });
    save(order, hidden);
    apply();
  }

  function rowAfter(list, y) {
    var rows = Array.prototype.slice.call(
      list.querySelectorAll(".cards-row:not(.dragging)")
    );
    var closest = null, closestOffset = Number.NEGATIVE_INFINITY;
    rows.forEach(function (row) {
      var box = row.getBoundingClientRect();
      var offset = y - box.top - box.height / 2;
      if (offset < 0 && offset > closestOffset) {
        closestOffset = offset; closest = row;
      }
    });
    return closest;
  }

  function buildRow(id) {
    var m = metaFor(id);
    var el = cardEl(id);
    var visible = el && !el.hasAttribute("data-wb-hidden");
    var unavailable = el && el.hasAttribute("hidden"); // logic-hidden right now

    var row = document.createElement("div");
    row.className = "cards-row";
    row.setAttribute("data-id", id);
    row.setAttribute("draggable", "true");

    row.innerHTML =
      '<span class="cards-grip" title="Drag to reorder" aria-hidden="true">☰</span>' +
      '<span class="cards-icon">' + m.icon + "</span>" +
      '<span class="cards-name">' + m.label +
        (unavailable ? ' <span class="cards-tag">unavailable</span>' : "") +
      "</span>" +
      '<label class="cards-switch"><input type="checkbox" class="cards-toggle"' +
        (visible ? " checked" : "") + '><span class="cards-slider"></span></label>';

    // Drag wiring
    row.addEventListener("dragstart", function () {
      row.classList.add("dragging");
    });
    row.addEventListener("dragend", function () {
      row.classList.remove("dragging");
      persistFromRows();
    });
    // Toggle
    row.querySelector(".cards-toggle").addEventListener("change", persistFromRows);
    return row;
  }

  function buildPanel() {
    var overlay = document.createElement("div");
    overlay.className = "cards-panel";
    overlay.id = "cards-panel";
    overlay.setAttribute("hidden", "");

    var inner = document.createElement("div");
    inner.className = "cards-panel-inner";
    inner.innerHTML =
      '<div class="cards-panel-head">' +
        "<h3>⚙️ Customize dashboard</h3>" +
        '<button type="button" class="cards-close" aria-label="Close">×</button>' +
      "</div>" +
      '<p class="cards-help">Toggle cards on/off and drag ☰ to reorder. ' +
        "Saved to this browser.</p>" +
      '<div class="cards-list"></div>' +
      '<div class="cards-panel-foot">' +
        '<button type="button" class="ctrl-btn cards-reset">Reset to default</button>' +
        '<button type="button" class="ctrl-btn ctrl-success cards-done">Done</button>' +
      "</div>";
    overlay.appendChild(inner);
    document.body.appendChild(overlay);

    var list = inner.querySelector(".cards-list");
    // Drag-over routing on the list container.
    list.addEventListener("dragover", function (e) {
      e.preventDefault();
      var dragging = list.querySelector(".dragging");
      if (!dragging) return;
      var after = rowAfter(list, e.clientY);
      if (after == null) list.appendChild(dragging);
      else list.insertBefore(dragging, after);
    });

    // Close handlers
    inner.querySelector(".cards-close").addEventListener("click", close);
    inner.querySelector(".cards-done").addEventListener("click", close);
    overlay.addEventListener("click", function (e) {
      if (e.target === overlay) close();
    });
    inner.querySelector(".cards-reset").addEventListener("click", function () {
      try { localStorage.removeItem(LS_KEY); } catch (e2) {}
      apply();
      renderRows();
    });
    return overlay;
  }

  function renderRows() {
    var list = panel.querySelector(".cards-list");
    list.innerHTML = "";
    var st = currentState();
    st.order.forEach(function (id) { list.appendChild(buildRow(id)); });
  }

  function open() {
    if (!panel) panel = buildPanel();
    renderRows();
    panel.removeAttribute("hidden");
  }
  function close() {
    if (panel) panel.setAttribute("hidden", "");
  }

  // --- boot ----------------------------------------------------------------

  function init() {
    apply();
    var btn = document.getElementById("cards-customize");
    if (btn) btn.addEventListener("click", open);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  // Expose for other modules / debugging.
  window.WBCards = { open: open, apply: apply };
})();
