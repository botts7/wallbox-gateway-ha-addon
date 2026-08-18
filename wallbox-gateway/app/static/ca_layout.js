/* ============================================================================
   Charge Assistant — layout module (ADDITIVE; no config wiring).
   Adds three things on top of charge_assistant.js without touching any field id
   or the save/load bridge:
     1. a sticky jump-nav rail (desktop) / horizontal chip bar (mobile), rebuilt
        for the active mode from the currently-visible cards;
     2. a deterministic scroll-spy + a bottom spacer so the rail highlight walks
        through every card down to the last one (and the rail stays pinned);
     3. default-collapses the *empty* secondary cards so a mode opens compact.
   Fully decoupled: it only watches #ca-form[data-mode] (which selectMode sets)
   and reuses the collapse mechanism charge_assistant.js already wires up.
   ============================================================================ */
(function () {
  "use strict";
  var form    = document.getElementById("ca-form");
  var rail    = document.getElementById("ca-rail");
  var bodycol = document.querySelector(".ca-bodycol");
  var spacer  = document.querySelector(".ca-endspacer");
  if (!form || !rail || !bodycol) return;   // markup not present — no-op
  var bodyEl  = rail.parentElement;         // .ca-body (the 2-col grid wrapper)

  // Collapse the grid to one column whenever the rail is hidden, so an empty
  // rail track never pushes the content right (off mode / single-card modes).
  function syncGrid() { if (bodyEl) bodyEl.classList.toggle("ca-norail", rail.hidden); }

  var MODE_NAMES = { off: "Off", reminder: "Reminder", target_soc: "Smart charge",
                     solar: "Solar", smart_solar: "Smart + Solar" };

  var links = [], ids = [], idMap = {}, lastCur = null, suppressSpy = 0;

  // Card title = the h2's leading text node (drops the "optional"/"required" tag).
  function labelFor(card) {
    var h = card.querySelector("h2");
    if (!h) return "";
    var t = (h.firstChild && h.firstChild.nodeType === 3) ? h.firstChild.textContent : h.textContent;
    return (t || "").replace(/\s+/g, " ").trim();
  }
  // Visible = laid out (its mode section is active and it isn't [hidden]).
  function visibleCards() {
    return Array.prototype.filter.call(bodycol.querySelectorAll(".ca-card"), function (c) {
      return c.offsetParent !== null && labelFor(c);
    });
  }

  function refreshRail() {
    var mode  = form.dataset.mode || "off";
    var cards = (mode === "off") ? [] : visibleCards();
    links = []; ids = []; idMap = {}; lastCur = null;
    rail.textContent = "";                                   // clear (no innerHTML)
    if (cards.length < 2) { rail.hidden = true; syncGrid(); sizeSpacer(); return; }

    // Build the rail with DOM methods only — labels are set via textContent, so
    // no markup is ever interpolated (avoids any innerHTML/XSS surface).
    var title = document.createElement("p");
    title.className = "ca-rail-title";
    title.textContent = MODE_NAMES[mode] || "";
    rail.appendChild(title);
    var ul = document.createElement("ul");
    cards.forEach(function (c, i) {
      if (!c.id || c.id.indexOf("carail-") === 0) c.id = "carail-" + mode + "-" + i;
      ids.push(c.id);
      var li = document.createElement("li");
      var a = document.createElement("a");
      a.href = "#" + c.id;
      a.setAttribute("data-rail", c.id);
      var dot = document.createElement("span");
      dot.className = "rd";
      a.appendChild(dot);
      a.appendChild(document.createTextNode(labelFor(c)));    // text — never markup
      li.appendChild(a);
      ul.appendChild(li);
      idMap[c.id] = a;
      links.push(a);
    });
    rail.appendChild(ul);
    rail.hidden = false;
    syncGrid();

    defaultCollapseOnce();
    sizeSpacer();
    spy(true);
  }

  // Rail click → expand (if collapsed), jump, flash, own the highlight briefly.
  rail.addEventListener("click", function (e) {
    var a = e.target.closest("a[data-rail]"); if (!a) return;
    e.preventDefault();
    var t = document.getElementById(a.getAttribute("data-rail")); if (!t) return;
    t.classList.remove("ca-collapsed");
    var head = t.querySelector(":scope > .ca-card-head");
    if (head) head.setAttribute("aria-expanded", "true");
    sizeSpacer();                                   // card grew — refresh scroll room
    links.forEach(function (l) { l.classList.remove("current"); });
    a.classList.add("current");
    revealChip(a);                                  // keep the tapped chip in view
    suppressSpy = Date.now() + 700;                 // don't let the spy fight the click
    t.scrollIntoView({ behavior: "smooth", block: "start" });
    t.classList.remove("ca-flash"); void t.offsetWidth; t.classList.add("ca-flash");
  });

  // Deterministic scroll-spy: current = last card whose top has crossed the line.
  function spy(force) {
    if (!force && Date.now() < suppressSpy) return;
    if (!ids.length) return;
    var line = 100, cur = ids[0];
    for (var i = 0; i < ids.length; i++) {
      var el = document.getElementById(ids[i]);
      if (el && el.getBoundingClientRect().top - line <= 0) cur = ids[i];
    }
    if (cur === lastCur) return;
    lastCur = cur;
    links.forEach(function (l) { l.classList.remove("current"); });
    if (idMap[cur]) { idMap[cur].classList.add("current"); revealChip(idMap[cur]); }
  }

  // Keep the active rail item in view: scroll the chip bar horizontally (mobile,
  // the <ul> scrolls) or the rail vertically (desktop). Adjusts only the rail's
  // own scroll — never the page — so following the page-scroll never fights it.
  function revealChip(a) {
    if (!a) return;
    var ul = rail.querySelector("ul"); if (!ul) return;
    var ar = a.getBoundingClientRect();
    var ur = ul.getBoundingClientRect();                 // horizontal (chip bar)
    if (ar.left < ur.left)        ul.scrollLeft -= (ur.left - ar.left) + 14;
    else if (ar.right > ur.right) ul.scrollLeft += (ar.right - ur.right) + 14;
    var rr = rail.getBoundingClientRect();               // vertical (desktop rail)
    if (ar.top < rr.top)            rail.scrollTop -= (rr.top - ar.top) + 14;
    else if (ar.bottom > rr.bottom) rail.scrollTop += (ar.bottom - rr.bottom) + 14;
  }

  // Bottom spacer so the LAST card can scroll up to the line (rail walks the tail
  // instead of snapping). Lives inside .ca-bodycol so the rail stays sticky to it.
  function sizeSpacer() {
    if (!spacer) return;
    var last = ids.length ? document.getElementById(ids[ids.length - 1]) : null;
    if (!last) { spacer.style.height = "0px"; return; }
    var H = parseFloat(spacer.style.height) || 0;
    var contentH = document.documentElement.scrollHeight - H;   // height sans our spacer
    // Keep it one page: if everything already fits on screen, add NO scroll room.
    if (contentH <= window.innerHeight + 4) { spacer.style.height = "0px"; return; }
    // Otherwise add just enough that the last card's top can reach the highlight line.
    var absTop = last.getBoundingClientRect().top + window.scrollY;
    var need = (absTop - 100 + window.innerHeight) - contentH;
    spacer.style.height = Math.max(0, need) + "px";
  }

  // Default-collapse empty secondary cards, once, after setupCollapsible wired heads.
  var collapsedDone = false;
  function isConfigured(card) {
    if (card.querySelector("input:checked")) return true;
    var f = card.querySelectorAll('input[type="text"],input[type="number"],input[type="time"],input[type="datetime-local"]');
    for (var i = 0; i < f.length; i++) { if (f[i].value && f[i].value.trim() !== "") return true; }
    if (card.querySelector("#car-list [data-car-row]")) return true;   // has a vehicle
    return false;
  }
  function defaultCollapseOnce() {
    if (collapsedDone) return;
    if (!document.querySelector(".ca-card-head.ca-collapsible")) {   // wait for wiring
      setTimeout(defaultCollapseOnce, 60); return;
    }
    collapsedDone = true;
    document.querySelectorAll(".ca-card.ca-start-collapsed").forEach(function (card) {
      if (card.tagName === "DETAILS" || isConfigured(card)) return;
      card.classList.add("ca-collapsed");
      var head = card.querySelector(":scope > .ca-card-head");
      if (head) head.setAttribute("aria-expanded", "false");
    });
  }

  // A collapse toggle anywhere in the body changes heights — refresh spacer + spy.
  bodycol.addEventListener("click", function (e) {
    if (e.target.closest("input,select,button,a,.ca-combo")) return;
    if (e.target.closest(".ca-card-head.ca-collapsible")) {
      requestAnimationFrame(function () { sizeSpacer(); lastCur = null; spy(true); });
    }
  });

  var ticking = false;
  window.addEventListener("scroll", function () {
    if (ticking) return; ticking = true;
    requestAnimationFrame(function () { spy(false); ticking = false; });
  }, { passive: true });
  window.addEventListener("resize", function () {
    sizeSpacer(); lastCur = null; spy(true);
  }, { passive: true });

  // Rebuild when the mode changes (charge_assistant.js sets #ca-form[data-mode])
  // OR when the form is first revealed (data-mode may be set while still hidden,
  // when cards have no layout yet — the unhide is our cue to build for real).
  new MutationObserver(function (muts) {
    for (var i = 0; i < muts.length; i++) {
      var n = muts[i].attributeName;
      if (n === "data-mode" || n === "hidden") { refreshRail(); return; }
    }
  }).observe(form, { attributes: true, attributeFilter: ["data-mode", "hidden"] });

  refreshRail();   // initial (data-mode may already be set)
})();
