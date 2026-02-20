const http = require("http");
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const readline = require("readline");

// ─── Paths ──────────────────────────────────────────────────────────────────
// Online devices are stored by the XCenter service in manualDiscoveryIP.json
// There are two possible locations depending on VMP version/install.
// We check both and use whichever has data (preferring the primary).

const XCENTER_PRIMARY = path.join(
  process.env.PROGRAMDATA || "C:\\ProgramData",
  "XCenter",
  "UserConfig"
);
const XCENTER_SECONDARY = path.join(
  process.env.PROGRAMDATA || "C:\\ProgramData",
  "VMP_XCenter",
  "UserConfig"
);
const DISCOVERY_FILENAME = "manualDiscoveryIP.json";
const DEFAULT_PORT = 3847;

function getDiscoveryPaths() {
  const paths = [];
  const primary = path.join(XCENTER_PRIMARY, DISCOVERY_FILENAME);
  const secondary = path.join(XCENTER_SECONDARY, DISCOVERY_FILENAME);
  if (fs.existsSync(primary)) paths.push(primary);
  if (fs.existsSync(secondary)) paths.push(secondary);
  return paths;
}

function getActiveDiscoveryPath() {
  // Prefer primary (C:\ProgramData\XCenter\UserConfig)
  const primary = path.join(XCENTER_PRIMARY, DISCOVERY_FILENAME);
  if (fs.existsSync(primary)) return primary;
  const secondary = path.join(XCENTER_SECONDARY, DISCOVERY_FILENAME);
  if (fs.existsSync(secondary)) return secondary;
  return primary; // default to primary even if doesn't exist yet
}

// ─── Read/write device list ─────────────────────────────────────────────────

function readDevices(filePath) {
  if (!fs.existsSync(filePath)) return {};
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch (e) {
    return {};
  }
}

function writeDevices(filePath, devices) {
  fs.writeFileSync(filePath, JSON.stringify(devices), "utf-8");
}

function parseDeviceList(raw) {
  // Format: { "8001<ip>": "<ip>", "8001": "" (corrupt), ... }
  // The key is always port (4 digits) concatenated with the IP
  const devices = [];
  for (const [key, ip] of Object.entries(raw)) {
    if (!ip || typeof ip !== "string" || !ip.trim()) continue; // skip empty/corrupt
    // Port is always the first 4 characters (e.g. "8001")
    const port = key.substring(0, 4) || "8001";
    devices.push({ key, ip: ip.trim(), port });
  }
  devices.sort((a, b) => {
    const aParts = a.ip.split(".").map(Number);
    const bParts = b.ip.split(".").map(Number);
    for (let i = 0; i < 4; i++) {
      if (aParts[i] !== bParts[i]) return aParts[i] - bParts[i];
    }
    return 0;
  });
  return devices;
}

// ─── Scan all device sources ────────────────────────────────────────────────

function scanAll() {
  const discoveryPaths = getDiscoveryPaths();
  const sources = [];

  for (const dp of discoveryPaths) {
    const raw = readDevices(dp);
    const devices = parseDeviceList(raw);
    const corruptEntries = Object.entries(raw).filter(([k, v]) => !v || !v.trim()).length;
    sources.push({
      path: dp,
      isPrimary: !dp.includes("VMP_XCenter"),
      devices,
      corruptEntries,
      totalRawEntries: Object.keys(raw).length,
    });
  }

  return { sources };
}

// ─── Remove a device IP from a specific file ────────────────────────────────

function removeDevice(filePath, ip) {
  if (!fs.existsSync(filePath)) {
    return { success: false, error: "Config file not found: " + filePath };
  }

  const raw = readDevices(filePath);
  let removed = false;
  const keysToRemove = [];

  for (const [key, value] of Object.entries(raw)) {
    if (value === ip) {
      keysToRemove.push(key);
      removed = true;
    }
  }

  if (!removed) {
    return { success: false, error: "IP not found in config" };
  }

  for (const key of keysToRemove) {
    delete raw[key];
  }

  writeDevices(filePath, raw);
  return { success: true, removedKeys: keysToRemove };
}

// ─── Remove device from ALL discovery files ─────────────────────────────────

function removeDeviceFromAll(ip) {
  const xcenterWasRunning = isXCenterRunning();

  // XCenter locks the file — stop it first if running
  if (xcenterWasRunning) {
    const stopResult = stopXCenter();
    if (!stopResult.success) {
      return { results: [{ success: false, error: "Cannot stop XCenter to unlock config file. " + (stopResult.error || "Run as Administrator.") }] };
    }
    // Brief pause to let the file handle release
    try { execSync('ping 127.0.0.1 -n 2 >nul', { timeout: 5000 }); } catch (e) {}
  }

  const paths = getDiscoveryPaths();
  const results = [];
  for (const dp of paths) {
    results.push({ path: dp, ...removeDevice(dp, ip) });
  }

  // Restart XCenter if it was running before
  if (xcenterWasRunning) {
    const startResult = startXCenter();
    if (!startResult.success) {
      results.push({ note: "XCenter was stopped but could not be restarted. " + (startResult.error || "") });
    }
  }

  return { results, xcenterRestarted: xcenterWasRunning };
}

// ─── Clean corrupt/empty entries ────────────────────────────────────────────

function cleanCorrupt(filePath) {
  if (!fs.existsSync(filePath)) return { success: false, error: "File not found" };

  const xcenterWasRunning = isXCenterRunning();
  if (xcenterWasRunning) {
    const stopResult = stopXCenter();
    if (!stopResult.success) return { success: false, error: "Cannot stop XCenter. " + (stopResult.error || "Run as Administrator.") };
    try { execSync('ping 127.0.0.1 -n 2 >nul', { timeout: 5000 }); } catch (e) {}
  }

  const raw = readDevices(filePath);
  let cleaned = 0;
  for (const [key, value] of Object.entries(raw)) {
    if (!value || typeof value !== "string" || !value.trim()) {
      delete raw[key];
      cleaned++;
    }
  }
  writeDevices(filePath, raw);

  if (xcenterWasRunning) startXCenter();
  return { success: true, cleaned };
}

// ─── Check if VMP / XCenter is running ──────────────────────────────────────

function isVmpRunning() {
  try {
    const result = execSync(
      'tasklist /FI "IMAGENAME eq VMP.exe" /FO CSV /NH',
      { encoding: "utf-8", timeout: 5000 }
    );
    const lines = result.split(/\r?\n/).filter((l) => l.trim());
    return lines.some((line) => {
      const match = line.match(/^"([^"]+)"/);
      return match && match[1].toLowerCase() === "vmp.exe";
    });
  } catch (e) {
    return false;
  }
}

function isXCenterRunning() {
  try {
    const result = execSync(
      'tasklist /FI "IMAGENAME eq xcenter_win.exe" /FO CSV /NH',
      { encoding: "utf-8", timeout: 5000 }
    );
    const lines = result.split(/\r?\n/).filter((l) => l.trim());
    return lines.some((line) => {
      const match = line.match(/^"([^"]+)"/);
      return match && match[1].toLowerCase() === "xcenter_win.exe";
    });
  } catch (e) {
    return false;
  }
}

// ─── XCenter service control ────────────────────────────────────────────────

function stopXCenter() {
  try {
    execSync('net stop XCenter', { encoding: "utf-8", timeout: 15000 });
    return { success: true };
  } catch (e) {
    // Check if it stopped anyway
    if (!isXCenterRunning()) return { success: true };
    return { success: false, error: e.message.includes("Access is denied")
      ? "Access denied. The app needs to run as Administrator to control services."
      : e.message };
  }
}

function startXCenter() {
  try {
    execSync('net start XCenter', { encoding: "utf-8", timeout: 15000 });
    return { success: true };
  } catch (e) {
    if (isXCenterRunning()) return { success: true };
    return { success: false, error: e.message.includes("Access is denied")
      ? "Access denied. The app needs to run as Administrator to control services."
      : e.message };
  }
}

function restartXCenter() {
  const stopResult = stopXCenter();
  if (!stopResult.success) return stopResult;
  return startXCenter();
}

// ─── Query controller COEX API for screen/project info ─────────────────────

function queryControllerInfo(ip, port) {
  return new Promise((resolve) => {
    const timeout = 3000; // 3 second timeout
    const url = `http://${ip}:${port}/api/v1/screen`;

    const req = http.get(url, { timeout }, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => {
        try {
          const json = JSON.parse(body);
          if (json.code === 0 && json.data) {
            const screens = (json.data.screens || []).map((s) => ({
              screenID: s.screenID,
              screenName: s.screenName || "(unnamed)",
              screenIndex: s.screenIndex,
              workingMode: s.workingMode === 0 ? "Send-only" : s.workingMode === 1 ? "All-in-one" : String(s.workingMode),
            }));
            const groups = (json.data.screenGroups || []).map((g) => ({
              screenGroupID: g.screenGroupID,
              name: g.name || "(unnamed)",
            }));
            resolve({ success: true, ip, screens, groups, reachable: true });
          } else {
            resolve({ success: true, ip, screens: [], groups: [], reachable: true, note: json.message || "No screen data" });
          }
        } catch (e) {
          resolve({ success: false, ip, reachable: true, error: "Invalid JSON response" });
        }
      });
    });

    req.on("error", () => {
      resolve({ success: false, ip, reachable: false, error: "Controller unreachable" });
    });

    req.on("timeout", () => {
      req.destroy();
      resolve({ success: false, ip, reachable: false, error: "Connection timed out" });
    });
  });
}

// ─── Embedded HTML ──────────────────────────────────────────────────────────
const FRONTEND_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>VMP Device Manager</title>
<style>
  :root {
    --bg: #0f1117; --surface: #1a1d27; --surface2: #242836; --border: #2e3348;
    --text: #e2e4ed; --text-dim: #8b8fa3;
    --accent: #5b8aff; --accent-hover: #7aa2ff;
    --danger: #e5484d; --danger-hover: #f27067; --danger-bg: rgba(229,72,77,0.1);
    --success: #30a46c; --warning: #f5a623; --warning-bg: rgba(245,166,35,0.12);
    --radius: 10px; --radius-sm: 6px;
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; background: var(--bg); color: var(--text); min-height: 100vh; }
  .app { max-width: 960px; margin: 0 auto; padding: 32px 24px; }

  .header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 28px; }
  .header-left { display: flex; align-items: center; gap: 14px; }
  .logo { width: 40px; height: 40px; background: linear-gradient(135deg, var(--accent), #8b5cf6); border-radius: var(--radius); display: flex; align-items: center; justify-content: center; font-size: 20px; font-weight: 700; color: #fff; }
  .header h1 { font-size: 22px; font-weight: 600; letter-spacing: -0.3px; }
  .header h1 span { color: var(--text-dim); font-weight: 400; font-size: 14px; margin-left: 8px; }

  .btn { display: inline-flex; align-items: center; gap: 6px; padding: 8px 16px; border-radius: var(--radius-sm); border: 1px solid var(--border); background: var(--surface2); color: var(--text); font-size: 13px; font-weight: 500; cursor: pointer; transition: all 0.15s; }
  .btn:hover { background: var(--border); }
  .btn-danger { background: var(--danger-bg); border-color: rgba(229,72,77,0.3); color: var(--danger); }
  .btn-danger:hover { background: rgba(229,72,77,0.2); border-color: var(--danger); }
  .btn-sm { padding: 5px 10px; font-size: 12px; }
  .btn:disabled { opacity: 0.4; cursor: not-allowed; }

  .banner { padding: 12px 16px; border-radius: var(--radius); margin-bottom: 16px; font-size: 13px; display: flex; align-items: center; gap: 10px; line-height: 1.5; }
  .banner-danger { background: var(--danger-bg); border: 1px solid rgba(229,72,77,0.25); color: var(--danger); }
  .banner-success { background: rgba(48,164,108,0.1); border: 1px solid rgba(48,164,108,0.25); color: var(--success); }
  .banner-warning { background: var(--warning-bg); border: 1px solid rgba(245,166,35,0.25); color: var(--warning); }
  .banner-info { background: rgba(91,138,255,0.08); border: 1px solid rgba(91,138,255,0.2); color: var(--accent); }
  .banner-icon { font-size: 16px; flex-shrink: 0; }

  .section-title { font-size: 13px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; color: var(--text-dim); margin: 24px 0 12px; display: flex; align-items: center; gap: 8px; }
  .section-title .count { background: var(--surface2); border: 1px solid var(--border); border-radius: 4px; padding: 1px 7px; font-size: 11px; font-weight: 600; font-family: "Cascadia Code","Fira Code","Consolas",monospace; }

  .path-bar { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 8px 14px; font-size: 11px; color: var(--text-dim); margin-bottom: 6px; font-family: "Cascadia Code","Fira Code","Consolas",monospace; display: flex; align-items: center; gap: 8px; }

  .device-list { display: flex; flex-direction: column; gap: 8px; }
  .device-card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 14px 18px; display: flex; align-items: center; justify-content: space-between; gap: 12px; transition: border-color 0.15s; }
  .device-card:hover { border-color: #3e4460; }
  .device-card.selected { border-color: var(--danger); background: linear-gradient(135deg, var(--surface), rgba(229,72,77,0.04)); }

  .device-ip { font-size: 16px; font-weight: 600; font-family: "Cascadia Code","Fira Code","Consolas",monospace; letter-spacing: 0.5px; }
  .device-port { font-size: 12px; color: var(--text-dim); margin-top: 2px; }
  .device-screens { margin-top: 6px; display: flex; flex-wrap: wrap; gap: 5px; }
  .screen-tag { display: inline-flex; align-items: center; gap: 4px; background: rgba(91,138,255,0.1); border: 1px solid rgba(91,138,255,0.2); color: var(--accent); border-radius: 4px; padding: 2px 8px; font-size: 11px; font-weight: 500; }
  .screen-tag.unreachable { background: rgba(229,72,77,0.08); border-color: rgba(229,72,77,0.2); color: var(--danger); }
  .screen-tag.loading { background: var(--surface2); border-color: var(--border); color: var(--text-dim); }
  .screen-tag .screen-mode { opacity: 0.6; font-size: 10px; }

  .modal-overlay { display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.6); backdrop-filter: blur(4px); z-index: 100; justify-content: center; align-items: center; }
  .modal-overlay.active { display: flex; }
  .modal { background: var(--surface); border: 1px solid var(--border); border-radius: 14px; padding: 28px; max-width: 440px; width: 90%; box-shadow: 0 20px 60px rgba(0,0,0,0.5); }
  .modal h2 { font-size: 17px; font-weight: 600; margin-bottom: 10px; display: flex; align-items: center; gap: 8px; }
  .modal p { font-size: 13px; color: var(--text-dim); line-height: 1.6; margin-bottom: 8px; }
  .modal .detail-box { background: var(--surface2); border-radius: var(--radius-sm); padding: 10px 14px; margin: 12px 0; font-size: 13px; font-family: "Cascadia Code","Fira Code","Consolas",monospace; color: var(--text); text-align: center; letter-spacing: 0.5px; }
  .modal-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 20px; }
  .modal-actions .btn { padding: 9px 20px; }

  .loading { text-align: center; padding: 60px 20px; color: var(--text-dim); font-size: 14px; }
  .spinner { width: 28px; height: 28px; border: 3px solid var(--border); border-top-color: var(--accent); border-radius: 50%; animation: spin 0.7s linear infinite; margin: 0 auto 14px; }
  @keyframes spin { to { transform: rotate(360deg); } }

  .empty-state { text-align: center; padding: 40px 20px; color: var(--text-dim); }
  .empty-state h3 { font-size: 16px; color: var(--text); margin-bottom: 6px; }

  .toast-container { position: fixed; bottom: 24px; right: 24px; z-index: 200; display: flex; flex-direction: column; gap: 8px; }
  .toast { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 12px 18px; font-size: 13px; box-shadow: 0 8px 30px rgba(0,0,0,0.4); display: flex; align-items: center; gap: 8px; animation: slideIn 0.25s ease; }
  .toast-success { border-color: rgba(48,164,108,0.4); }
  .toast-error { border-color: rgba(229,72,77,0.4); }
  @keyframes slideIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }

  .stats { display: flex; gap: 10px; margin-bottom: 20px; }
  .stat-card { flex: 1; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 14px 16px; }
  .stat-label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; color: var(--text-dim); margin-bottom: 4px; }
  .stat-value { font-size: 22px; font-weight: 700; letter-spacing: -0.5px; }
</style>
</head>
<body>
<div class="app">
  <div class="header">
    <div class="header-left">
      <div class="logo">V</div>
      <h1>VMP Device Manager <span>NovaStar</span></h1>
    </div>
    <button class="btn" onclick="loadData()">
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M1.5 8a6.5 6.5 0 0 1 11.25-4.5M14.5 8a6.5 6.5 0 0 1-11.25 4.5"/><path d="M13 1v3.5h-3.5M3 15v-3.5h3.5"/></svg>
      Refresh
    </button>
  </div>
  <div id="bannerArea"></div>
  <div id="content">
    <div class="loading"><div class="spinner"></div>Scanning for remembered controllers...</div>
  </div>
</div>

<div class="modal-overlay" id="confirmModal">
  <div class="modal">
    <h2>
      <svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="var(--danger)" stroke-width="1.8"><circle cx="8" cy="8" r="6.5"/><path d="M8 5v3.5M8 10.5v.5"/></svg>
      Remove Controller
    </h2>
    <p id="modalText"></p>
    <div class="detail-box" id="modalDetail"></div>
    <p style="color: var(--text-dim); font-size: 12px;">The controller can be re-added later from within VMP.</p>
    <p id="modalRestart" style="color: var(--warning); font-size: 12px; display:none;">You will need to restart VMP for this to take effect.</p>
    <div class="modal-actions">
      <button class="btn" onclick="closeModal()">Cancel</button>
      <button class="btn btn-danger" id="confirmBtn" onclick="confirmRemove()">Remove Controller</button>
    </div>
  </div>
</div>

<div class="toast-container" id="toasts"></div>

<script>
var data = null;
var pendingRemoveIp = null;

async function loadData() {
  var content = document.getElementById("content");
  content.innerHTML = '<div class="loading"><div class="spinner"></div>Scanning for remembered controllers...</div>';
  try {
    var res = await fetch("/api/devices");
    data = await res.json();
    render();
    fetchScreenNames();
  } catch (e) {
    content.innerHTML = '<div class="empty-state"><h3>Connection Error</h3><p>Could not connect to the server.</p></div>';
  }
}

function render() {
  var bannerArea = document.getElementById("bannerArea");
  var content = document.getElementById("content");
  var banners = "";

  if (data.vmpRunning) {
    banners += '<div class="banner banner-warning"><span class="banner-icon">&#9888;</span><span><strong>VMP is running.</strong> You can still remove controllers, but you will need to restart VMP for changes to take effect.</span></div>';
  }
  if (data.xcenterRunning) {
    banners += '<div class="banner banner-info" style="justify-content:space-between;flex-wrap:wrap;gap:8px"><div style="display:flex;align-items:center;gap:10px"><span class="banner-icon">&#8635;</span><span><strong>XCenter service is running.</strong> Restart it after removing controllers.</span></div><div style="display:flex;gap:6px"><button class="btn btn-sm" onclick="xcenterAction(\\'restart\\')">Restart XCenter</button><button class="btn btn-sm btn-danger" onclick="xcenterAction(\\'stop\\')">Stop XCenter</button></div></div>';
  }
  if (!data.vmpRunning && !data.xcenterRunning) {
    banners += '<div class="banner banner-success" style="justify-content:space-between;flex-wrap:wrap;gap:8px"><div style="display:flex;align-items:center;gap:10px"><span class="banner-icon">&#10003;</span><span>VMP and XCenter are not running. Changes will take effect on next launch.</span></div><button class="btn btn-sm" onclick="xcenterAction(\\'start\\')">Start XCenter</button></div>';
  }
  bannerArea.innerHTML = banners;

  var html = "";
  var totalDevices = 0;

  if (!data.sources || data.sources.length === 0) {
    content.innerHTML = '<div class="empty-state"><h3>No Discovery Config Found</h3><p>Could not find manualDiscoveryIP.json in ProgramData. Make sure VMP has been installed.</p></div>';
    return;
  }

  for (var si = 0; si < data.sources.length; si++) {
    var src = data.sources[si];
    totalDevices += src.devices.length;
    var label = src.isPrimary ? "XCenter (Active)" : "VMP_XCenter (Legacy)";

    html += '<div class="section-title">' + label + ' <span class="count">' + src.devices.length + ' controller' + (src.devices.length !== 1 ? 's' : '') + '</span></div>';
    html += '<div class="path-bar">' + src.path + '</div>';

    if (src.corruptEntries > 0) {
      html += '<div class="banner banner-warning" style="margin: 8px 0"><span class="banner-icon">&#9888;</span><span>' + src.corruptEntries + ' corrupt/empty entries found. <a href="#" onclick="cleanCorrupt(\\'' + src.path.replace(/\\\\/g, '\\\\\\\\') + '\\'); return false;" style="color:var(--warning);text-decoration:underline;">Clean up</a></span></div>';
    }

    if (src.devices.length === 0) {
      html += '<div class="empty-state" style="padding:20px"><h3>No controllers remembered</h3></div>';
    } else {
      html += '<div class="device-list">';
      for (var di = 0; di < src.devices.length; di++) {
        var d = src.devices[di];
        var ipId = d.ip.replace(/\\./g, '-');
        html += '<div class="device-card" id="dev-' + ipId + '">' +
          '<div style="flex:1;min-width:0">' +
            '<div class="device-ip">' + d.ip + '</div>' +
            '<div class="device-port">Port ' + d.port + '</div>' +
            '<div class="device-screens" id="screens-' + ipId + '">' +
              '<span class="screen-tag loading">&#8987; Querying...</span>' +
            '</div>' +
          '</div>' +
          '<button class="btn btn-sm btn-danger" onclick="requestRemove(\\'' + d.ip + '\\')">' +
            '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 5h10M5.5 5V3.5a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1V5M6.5 7.5v4M9.5 7.5v4"/><path d="M4 5l.5 8.5a1 1 0 0 0 1 .5h5a1 1 0 0 0 1-.5L12 5"/></svg> Remove' +
          '</button>' +
        '</div>';
      }
      html += '</div>';
    }
  }

  content.innerHTML = html;
}

function requestRemove(ip) {
  pendingRemoveIp = ip;
  document.getElementById("modalText").innerHTML = 'Remove controller <strong>' + ip + '</strong> from VMP? It will no longer auto-connect to this device.';
  document.getElementById("modalDetail").textContent = ip;
  document.getElementById("modalRestart").style.display = (data.vmpRunning || data.xcenterRunning) ? "block" : "none";

  document.querySelectorAll(".device-card").forEach(function(c) { c.classList.remove("selected"); });
  var card = document.getElementById("dev-" + ip.replace(/\\./g, "-"));
  if (card) card.classList.add("selected");

  document.getElementById("confirmModal").classList.add("active");
}

function closeModal() {
  document.getElementById("confirmModal").classList.remove("active");
  document.querySelectorAll(".device-card").forEach(function(c) { c.classList.remove("selected"); });
  pendingRemoveIp = null;
}

async function confirmRemove() {
  if (!pendingRemoveIp) return;
  var ip = pendingRemoveIp;
  var btn = document.getElementById("confirmBtn");
  btn.textContent = "Removing...";
  btn.disabled = true;
  try {
    var res = await fetch("/api/remove-device", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ip: ip }) });
    var result = await res.json();
    closeModal();
    if (result.success) {
      var msg = "Controller " + ip + " removed.";
      if (result.xcenterRestarted) msg += " XCenter restarted.";
      showToast(msg, "success");
      loadData();
    }
    else { showToast("Error: " + (result.error || "Unknown error"), "error"); }
  } catch (e) { closeModal(); showToast("Network error: " + e.message, "error"); }
  finally { btn.textContent = "Remove Controller"; btn.disabled = false; }
}

async function cleanCorrupt(filePath) {
  try {
    var res = await fetch("/api/clean-corrupt", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ filePath: filePath }) });
    var result = await res.json();
    if (result.success) { showToast("Cleaned " + result.cleaned + " corrupt entries.", "success"); loadData(); }
    else { showToast("Error: " + result.error, "error"); }
  } catch (e) { showToast("Error: " + e.message, "error"); }
}

function showToast(message, type) {
  var container = document.getElementById("toasts");
  var toast = document.createElement("div");
  toast.className = "toast toast-" + type;
  toast.innerHTML = '<span>' + (type === "success" ? "&#10003;" : "!") + '</span> ' + message;
  container.appendChild(toast);
  setTimeout(function() { toast.remove(); }, 5000);
}

async function xcenterAction(action) {
  showToast(action === "restart" ? "Restarting XCenter..." : action === "stop" ? "Stopping XCenter..." : "Starting XCenter...", "success");
  try {
    var res = await fetch("/api/xcenter", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: action }) });
    var result = await res.json();
    if (result.success) {
      showToast("XCenter " + (action === "restart" ? "restarted" : action === "stop" ? "stopped" : "started") + " successfully.", "success");
    } else {
      showToast("Failed: " + result.error, "error");
    }
    setTimeout(loadData, 1500);
  } catch (e) { showToast("Error: " + e.message, "error"); }
}

function fetchScreenNames() {
  if (!data || !data.sources) return;
  var allDevices = [];
  for (var si = 0; si < data.sources.length; si++) {
    for (var di = 0; di < data.sources[si].devices.length; di++) {
      allDevices.push(data.sources[si].devices[di]);
    }
  }
  // Deduplicate by IP (same IP may appear in both primary/secondary)
  var seen = {};
  var unique = [];
  for (var i = 0; i < allDevices.length; i++) {
    if (!seen[allDevices[i].ip]) {
      seen[allDevices[i].ip] = true;
      unique.push(allDevices[i]);
    }
  }
  for (var i = 0; i < unique.length; i++) {
    (function(d) {
      var ipId = d.ip.replace(/\\./g, "-");
      var el = document.getElementById("screens-" + ipId);
      if (!el) return;
      fetch("/api/device-info?ip=" + encodeURIComponent(d.ip) + "&port=" + encodeURIComponent(d.port))
        .then(function(res) { return res.json(); })
        .then(function(info) {
          if (!info.success && !info.reachable) {
            el.innerHTML = '<span class="screen-tag unreachable">&#10007; Offline / Unreachable</span>';
            return;
          }
          if (!info.screens || info.screens.length === 0) {
            el.innerHTML = '<span class="screen-tag" style="opacity:0.5">No screens configured</span>';
            return;
          }
          var tags = "";
          for (var s = 0; s < info.screens.length; s++) {
            var scr = info.screens[s];
            tags += '<span class="screen-tag">' +
              '&#9632; ' + scr.screenName +
              (scr.workingMode ? ' <span class="screen-mode">(' + scr.workingMode + ')</span>' : '') +
              '</span>';
          }
          if (info.groups && info.groups.length > 0) {
            for (var g = 0; g < info.groups.length; g++) {
              tags += '<span class="screen-tag" style="background:rgba(139,92,246,0.1);border-color:rgba(139,92,246,0.2);color:#a78bfa">&#9670; ' + info.groups[g].name + '</span>';
            }
          }
          el.innerHTML = tags;
        })
        .catch(function() {
          el.innerHTML = '<span class="screen-tag unreachable">&#10007; Error</span>';
        });
    })(unique[i]);
  }
}

document.addEventListener("keydown", function(e) { if (e.key === "Escape") closeModal(); });
loadData();
</script>
</body>
</html>`;

// ─── Wait for keypress (keeps console window open) ─────────────────────────

function waitForKey(message) {
  console.log("");
  console.log("  " + (message || "Press any key to exit..."));
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
    }
    process.stdin.resume();
    process.stdin.once("data", () => { rl.close(); resolve(); });
  });
}

process.on("uncaughtException", async (err) => {
  console.error("");
  console.error("  ERROR: " + err.message);
  console.error("");
  await waitForKey("Press any key to exit...");
  process.exit(1);
});

// ─── Validate environment ───────────────────────────────────────────────────

const discoveryPaths = getDiscoveryPaths();
if (discoveryPaths.length === 0) {
  console.error("");
  console.error("  ERROR: No VMP device discovery config found!");
  console.error("  Checked:");
  console.error("    " + path.join(XCENTER_PRIMARY, DISCOVERY_FILENAME));
  console.error("    " + path.join(XCENTER_SECONDARY, DISCOVERY_FILENAME));
  console.error("");
  console.error("  Make sure NovaStar VMP has been installed and connected to at least one controller.");
  waitForKey("Press any key to exit...").then(() => process.exit(1));
} else {

// ─── HTTP server ────────────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  const url = new URL(req.url, `http://localhost:${DEFAULT_PORT}`);

  if (url.pathname === "/" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(FRONTEND_HTML);
    return;
  }

  if (url.pathname === "/api/devices" && req.method === "GET") {
    const result = scanAll();
    result.vmpRunning = isVmpRunning();
    result.xcenterRunning = isXCenterRunning();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(result));
    return;
  }

  if (url.pathname === "/api/remove-device" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try {
        const { ip } = JSON.parse(body);
        if (!ip || !/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ip)) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: false, error: "Invalid IP address" }));
          return;
        }
        const result = removeDeviceFromAll(ip);
        const anySuccess = result.results.some((r) => r.success);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: anySuccess, details: result.results }));
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: e.message }));
      }
    });
    return;
  }

  if (url.pathname === "/api/device-info" && req.method === "GET") {
    const ip = url.searchParams.get("ip");
    const port = url.searchParams.get("port") || "8001";
    if (!ip || !/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ip)) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: "Invalid IP" }));
      return;
    }
    queryControllerInfo(ip, port).then((info) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(info));
    });
    return;
  }

  if (url.pathname === "/api/clean-corrupt" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try {
        const { filePath } = JSON.parse(body);
        // Validate path is one of our known config files
        const valid = getDiscoveryPaths();
        if (!valid.includes(path.resolve(filePath))) {
          res.writeHead(403, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: false, error: "Path not allowed" }));
          return;
        }
        const result = cleanCorrupt(filePath);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result));
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: e.message }));
      }
    });
    return;
  }

  if (url.pathname === "/api/xcenter" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try {
        const { action } = JSON.parse(body);
        let result;
        if (action === "stop") result = stopXCenter();
        else if (action === "start") result = startXCenter();
        else if (action === "restart") result = restartXCenter();
        else { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ success: false, error: "Invalid action" })); return; }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: e.message }));
      }
    });
    return;
  }

  res.writeHead(404);
  res.end("Not found");
});

// ─── Start server ───────────────────────────────────────────────────────────

function tryListen(port) {
  server.listen(port, "127.0.0.1", () => {
    const actualPort = server.address().port;
    console.log("");
    console.log("  ================================================================");
    console.log("       VMP Device Manager v2.0");
    console.log("  ================================================================");
    console.log(`   URL:  http://127.0.0.1:${actualPort}`);
    console.log("  ----------------------------------------------------------------");
    console.log("   Config files:");
    for (const dp of discoveryPaths) {
      console.log("    > " + dp);
    }
    console.log("  ----------------------------------------------------------------");
    console.log("   Do NOT close this window while managing devices.");
    console.log("   Press Ctrl+C to stop the server.");
    console.log("  ================================================================");
    console.log("");

    try { execSync(`start http://127.0.0.1:${actualPort}`); } catch (e) {}
  });

  server.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      if (port === DEFAULT_PORT) {
        console.log(`  Port ${DEFAULT_PORT} is busy, finding an available port...`);
        tryListen(0);
      } else {
        console.error("  ERROR: Could not find an available port.");
        waitForKey("Press any key to exit...").then(() => process.exit(1));
      }
    } else {
      console.error("  ERROR: " + err.message);
      waitForKey("Press any key to exit...").then(() => process.exit(1));
    }
  });
}

tryListen(DEFAULT_PORT);

} // end of discovery path check
