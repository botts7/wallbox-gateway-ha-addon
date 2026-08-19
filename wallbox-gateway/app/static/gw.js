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

  // ── Match Home Assistant's theme ────────────────────────────────────────
  // The add-on runs inside HA's ingress iframe (same-origin, unsandboxed), so we
  // lift HA's LIVE theme palette — accent, page background (incl. gradients),
  // card/surface, text and border colours — from the parent frame into --ha-*
  // variables, which the stylesheets consume (falling back to the add-on's own
  // dark defaults). The add-on then adopts the user's actual HA theme. Cross-
  // origin / sandboxed / older HA setups throw and we silently keep the default.
  // Retried briefly in case HA applies its theme a tick after the iframe loads.
  function syncHaTheme() {
    try {
      if (window.parent === window || !window.parent.document) return false;
      var cs = window.parent.getComputedStyle(window.parent.document.documentElement);
      var v = function (n) { return (cs.getPropertyValue(n) || "").trim(); };
      var accent = v("--primary-color");
      if (!accent) return false;   // HA theme not applied yet — retry
      var S = document.documentElement.style;
      var map = {
        "--ha-accent":   accent,
        "--ha-bg":       v("--primary-background-color"),
        "--ha-page-bg":  v("--lovelace-background") || v("--primary-background-color"),
        "--ha-surface":  v("--card-background-color") || v("--ha-card-background"),
        "--ha-elevated": v("--secondary-background-color"),
        "--ha-text":     v("--primary-text-color"),
        "--ha-text2":    v("--secondary-text-color"),
        "--ha-border":   v("--divider-color"),
      };
      Object.keys(map).forEach(function (k) { if (map[k]) S.setProperty(k, map[k]); });
      document.documentElement.setAttribute("data-ha-theme", "1");
      return true;
    } catch (e) { return false; }   // cross-origin / sandboxed — keep defaults
  }
  var HA_VARS = ["--ha-accent", "--ha-bg", "--ha-page-bg", "--ha-surface",
                 "--ha-elevated", "--ha-text", "--ha-text2", "--ha-border"];
  function isPlain() { try { return localStorage.getItem("wb_theme_plain") === "1"; } catch (e) { return false; } }
  function clearHaVars() {
    var S = document.documentElement.style;
    HA_VARS.forEach(function (k) { S.removeProperty(k); });
    document.documentElement.removeAttribute("data-ha-theme");
  }
  // Whether HA's theme is readable at all (inside ingress, same-origin parent).
  function haReadable() {
    try { return window.parent !== window &&
      !!window.parent.getComputedStyle(window.parent.document.documentElement)
        .getPropertyValue("--primary-color").trim(); } catch (e) { return false; }
  }
  // Apply the saved preference: Plain = the add-on's own dark palette (clear the
  // --ha-* overrides); otherwise mirror HA's theme.
  function applyThemePref() { if (isPlain()) { clearHaVars(); return true; } return syncHaTheme(); }
  if (!applyThemePref()) {
    var _haTries = 0;
    var _haTimer = setInterval(function () {
      if (applyThemePref() || ++_haTries >= 5) clearInterval(_haTimer);
    }, 400);
  }
  window.wbApplyThemePref = applyThemePref;
  window.wbIsPlain = isPlain;
  window.wbHaReadable = haReadable;

  // Header "Themed / Plain" toggle. Only shown when HA's theme is readable (i.e.
  // running inside ingress) — outside HA there's nothing to mirror. Persists the
  // choice and applies it live, no reload.
  function injectThemeToggle() {
    if (!haReadable()) return;
    var header = document.querySelector("header");
    if (!header || document.getElementById("wb-theme-toggle")) return;
    var btn = document.createElement("button");
    btn.id = "wb-theme-toggle";
    btn.className = "wb-theme-toggle";
    btn.type = "button";
    function relabel() {
      btn.textContent = "✦ " + (isPlain() ? "Plain" : "Themed");
      btn.title = isPlain()
        ? "Using the add-on's own look — click to match your Home Assistant theme"
        : "Matching your Home Assistant theme — click for the add-on's plain look";
    }
    relabel();
    btn.addEventListener("click", function () {
      try { localStorage.setItem("wb_theme_plain", isPlain() ? "0" : "1"); } catch (e) {}
      applyThemePref();
      relabel();
    });
    header.appendChild(btn);
  }

  // Populate the header IP + inject the switcher when >1 gateway is configured.
  function init() {
    injectThemeToggle();
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
