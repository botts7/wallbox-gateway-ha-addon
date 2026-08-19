// Multi-gateway support, shared across every Add-on page. Loaded first (in
// <head>) so the fetch patch is active before any page script makes an API call.
(function () {
  "use strict";

  // Active gateway index for this browser session — switching on any page
  // carries to the others. Default 0 = the first (or only) gateway.
  function activeGw() { return sessionStorage.getItem("wb_gw") || "0"; }
  window.wbActiveGw = activeGw;
  window.wbGateways = [];
  window.wbActiveGatewayIp = function () { return ""; };
  // Resolves (to the active gateway, or null) once /api/gateways has loaded.
  // Pages that must target the active gateway's IP (e.g. the Charge Assistant's
  // HA-bridge calls) should `await window.wbReady` before reading the IP.
  var _resolveReady;
  window.wbReady = new Promise(function (res) { _resolveReady = res; });

  // Append ?gw=<active> to every gateway-proxy call so it targets the selected
  // charger. The HA-bridge routes (/api/ha/*) and the switcher's own list are
  // left alone (they're not per-gateway, or carry their own host param).
  var realFetch = window.fetch.bind(window);
  window.fetch = function (url, opts) {
    if (typeof url === "string" &&
        /(^|\/)api\//.test(url) &&
        !/(^|\/)api\/(ha|gateways)\b/.test(url) &&
        !/[?&]gw=/.test(url)) {
      url += (url.indexOf("?") >= 0 ? "&" : "?") + "gw=" + encodeURIComponent(activeGw());
    }
    return realFetch(url, opts);
  };

  // ── Match Home Assistant's accent ──────────────────────────────────────
  // The add-on runs inside HA's ingress iframe. When the parent frame is
  // same-origin-readable we lift HA's LIVE theme accent (--primary-color) into
  // --ha-accent, which the stylesheets consume (falling back to the add-on's
  // blue). So the add-on picks up the user's actual HA theme colour, not just
  // our default. Cross-origin / sandboxed setups throw and we silently keep the
  // default. Retried briefly in case HA applies its theme a tick after load.
  function syncHaAccent() {
    try {
      if (window.parent === window || !window.parent.document) return false;
      var cs = window.parent.getComputedStyle(window.parent.document.documentElement);
      var accent = (cs.getPropertyValue("--primary-color") || "").trim();
      if (!accent) return false;
      document.documentElement.style.setProperty("--ha-accent", accent);
      document.documentElement.setAttribute("data-ha-accent", "1");
      return true;
    } catch (e) { return false; }   // cross-origin / sandboxed — keep the default
  }
  if (!syncHaAccent()) {
    var _haTries = 0;
    var _haTimer = setInterval(function () {
      if (syncHaAccent() || ++_haTries >= 5) clearInterval(_haTimer);
    }, 400);
  }

  // Populate the header IP + inject the switcher when >1 gateway is configured.
  function init() {
    realFetch("api/gateways").then(function (r) { return r.json(); }).then(function (d) {
      var gws = (d && d.gateways) || [];
      window.wbGateways = gws;
      var active = null;
      for (var i = 0; i < gws.length; i++) {
        if (String(gws[i].index) === activeGw()) { active = gws[i]; break; }
      }
      if (active) {
        window.wbActiveGatewayIp = function () { return active.ip || ""; };
        var ipEl = document.getElementById("gw-ip");
        if (ipEl && active.ip) ipEl.textContent = active.ip;
      }
      _resolveReady(active);
      if (gws.length < 2) return;
      var header = document.querySelector("header");
      if (!header || document.getElementById("wb-gw-switch")) return;
      var sel = document.createElement("select");
      sel.id = "wb-gw-switch";
      sel.className = "wb-gw-switch";
      sel.title = "Charger / gateway";
      gws.forEach(function (g) {
        var o = document.createElement("option");
        o.value = String(g.index);
        o.textContent = (g.name || ("Gateway " + (g.index + 1))) + (g.configured ? "" : " (not set)");
        if (String(g.index) === activeGw()) o.selected = true;
        sel.appendChild(o);
      });
      sel.addEventListener("change", function () {
        sessionStorage.setItem("wb_gw", sel.value);
        location.reload();   // simplest correct reload of all per-gateway state
      });
      header.appendChild(sel);
    }).catch(function () { _resolveReady(null); /* no switcher if the list can't load */ });
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else { init(); }
})();
