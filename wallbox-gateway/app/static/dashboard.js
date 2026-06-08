// v0.1 Add-on dashboard. Polls the four read-only endpoints exposed
// by server.py and updates the cards in place. No state mutation —
// OTA upload arrives in v0.2 once this baseline has shaken out.

const POLL_MS = 10_000;

const $ = (id) => document.getElementById(id);
const setText = (id, v) => { const el = $(id); if (el) el.textContent = (v ?? '—'); };
const showCard = (id, show) => { const el = $(id); if (el) el.hidden = !show; };

let unreachableShown = false;

// HA Supervisor ingress: this Add-on is served under a path like
// /api/hassio_ingress/<uuid>/ — absolute URLs (/api/status) would
// route to HA Core's domain root, NOT this Add-on. All fetch paths
// are therefore RELATIVE so the browser appends them to the current
// ingress base URL.
async function fetchJSON(path) {
  const r = await fetch(path, { cache: 'no-store' });
  const body = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, body };
}

function fmtBool(v) {
  if (v === true) return 'yes';
  if (v === false) return 'no';
  return '—';
}

function fmtUptime(seconds) {
  if (typeof seconds !== 'number') return '—';
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

async function refresh() {
  const cfg = await fetchJSON('api/addon/config');
  if (cfg.ok && !cfg.body.configured) {
    showCard('not-configured', true);
    return;
  }
  showCard('not-configured', false);
  if (cfg.ok) $('gw-ip').textContent = cfg.body.gateway_ip;

  const status = await fetchJSON('api/status');
  if (!status.ok && status.body?.error === 'unreachable') {
    showCard('unreachable', true);
    $('unreachable-ip').textContent = cfg.body?.gateway_ip ?? '?';
    unreachableShown = true;
    return;
  }
  if (unreachableShown) {
    showCard('unreachable', false);
    unreachableShown = false;
  }

  if (status.ok) {
    const s = status.body;
    setText('ble-state', s.ble ?? '—');
    setText('charger-name', s.dev_name ?? '—');
    setText('charger-fw', s.chg_app_fw ?? '—');
    setText('wifi-rssi', s.wifi_rssi != null ? `${s.wifi_rssi} dBm` : '—');
    setText('uptime', fmtUptime(s.uptime));
    setText('heap', s.heap != null ? `${(s.heap / 1024).toFixed(1)} KB` : '—');
  }

  const health = await fetchJSON('api/health');
  if (health.ok) {
    setText('health-ok', fmtBool(health.body.ok));
    setText('loop-max', health.body.loop_max_ms);
    setText('ota-proven', fmtBool(health.body.ota_proven));
  }

  const diag = await fetchJSON('api/diag/disconnects');
  if (diag.ok) {
    setText('ble-reconn', diag.body.ble_reconnects);
    setText('mqtt-reconn', diag.body.mqtt_reconnects);
    setText('wifi-reconn', diag.body.wifi_reconnects);
  }
}

$('poll-s').textContent = POLL_MS / 1000;
refresh();
setInterval(refresh, POLL_MS);
