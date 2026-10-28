'use strict';

const {
  app,
  BaseWindow,
  BrowserWindow,
  WebContentsView,
  Menu,
  ipcMain,
  shell,
  dialog,
  clipboard,
  session,
  Tray,
  desktopCapturer,
} = require('electron');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('node:url');
const crypto = require('crypto');
const { AgentHost } = require('./agent-host');
const { ConfigWriter } = require('./config-writer');
const { inspectPage, closePage } = require('./page-safety');
const { layoutCanvas } = require('./canvas-layout');

// Foreign child HWNDs can use ANGLE's blit swap chain (for example when
// DirectComposition is disabled). Keep FS's own redirection bitmap available
// to those children; a no-redirection Chromium host cannot present their
// normal window drawing. Leave DirectComposition and Agent rendering flags
// unchanged. This must run before Electron initializes its windows/GPU.
if (process.platform === 'win32') {
  const disabledFeatures = app.commandLine.getSwitchValue('disable-features');
  app.commandLine.appendSwitch('disable-features',
    [disabledFeatures, 'RemoveRedirectionBitmap'].filter(Boolean).join(','));
}

// ---------------------------------------------------------------- constants --

const SIDEBAR_WIDTH = 224;
const COLLAPSED_SIDEBAR_WIDTH = 56;
const TOOLBAR_HEIGHT = 48;
const POPUP_TOOLBAR_HEIGHT = 48;
const RECENT_VIEW_COUNT = 5;
const IDLE_VIEW_MS = 15 * 60 * 1000;
const CONFIG_SAVE_DELAY_MS = 80;
const RESOURCE_PRESSURE_BYTES = 768 * 1024 * 1024;
const PARTITION = 'persist:fixed-sites';
const APP_ICON = path.join(__dirname, 'ui-dist', 'brand', 'fixed-sites.ico');
const LOAD_ERROR_TEXT = '无法加载此页面';
const ZOOM_STEPS = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3];

// ------------------------------------------------------------ user data dir --

// The test-only override keeps packaged GUI checks isolated. Normal launches
// continue to use the Windows appData location and existing user data.
if (process.env.FIXED_SITES_TEST_APP_DATA) app.setPath('appData', path.resolve(process.env.FIXED_SITES_TEST_APP_DATA));
// The userData path must be fixed before any window or persistent session exists.
const dataDir = path.join(app.getPath('appData'), 'FixedSitesBrowser');
fs.mkdirSync(dataDir, { recursive: true });
app.setPath('userData', dataDir);

const CONFIG_PATH = path.join(app.getPath('userData'), 'sites.json');
const COVERS_DIR = path.join(app.getPath('userData'), 'site-covers');

// -------------------------------------------------------------------- state --

let mainWindow = null;
let sites = [];
let activeSiteId = null;
let uiReady = false;
let configWritable = true;
let shutdownDone = false;
let savedConfig = {};
let closeToTray = false;
let sidebarCollapsed = false;
let sidebarWidth = SIDEBAR_WIDTH;
let agentSidebarCollapsed = false;
let canvas = { panes: [], activeKey: null, direction: 'horizontal', ratio: .5, expanded: null };
let canvasResizing = false;
let resizeBefore = null;
let lastUndo = null;
let manualSnapshot = null;
let snapshotError = null;
let canvasAgentVisible = false;
const retiredCovers = new Set();
let zoomByOrigin = {};
let immersive = false;
let section = 'my';
let housekeepingTimer = null;
let retiringViews = false;
let sidebarFrameTimer = null;
let pendingSidebarWidth = null;
let lastResourceSample = null;
let workspace = 'web';
let activeAgentId = 'dsh';
let agentHost = null;
let agentError = null;
let agentBusy = false;
let agentPicker = null;
let pickerAgentId = null;
let pickerCandidates = new Map();
let pickerRefresh = 0;
let pickerConnecting = false;
let nativeOperations = Promise.resolve();
let closingAgents = false;
let agentsRestored = false;
let workspaceRequest = 0;
let tray = null;
let quitting = false;
let exitFlight = null;
let exitApproved = false;
let configError = null;
let configOperations = Promise.resolve();
let stateSendPending = false;
let previousStateJson = null;
let metricSequence = 0;

/** siteId -> { view, faviconUrl, loading, error, errorUrl, started } */
const views = new Map();
let presentedView = null;
/** Temporary native windows opened by pages via window.open / target=_blank. */
const popupWindows = new Set();
const popupRecords = new Map();
const popupRecordSet = new Set();
const downloadOwners = new Map();
const activeRequests = new Map();
const configWriter = new ConfigWriter(CONFIG_PATH, {
  delay: CONFIG_SAVE_DELAY_MS,
  onError: () => { configError = '配置尚未保存，请检查磁盘后重试退出。'; sendState(); },
});

// ------------------------------------------------------------------ helpers --

function errorMessage(err) {
  if (err && err.message) return String(err.message);
  return String(err);
}

function emitMetric(name, fields = {}) {
  if (!process.env.FIXED_SITES_METRICS) return;
  console.error('FIXED_SITES_METRIC ' + JSON.stringify({ name, at: Date.now(), ...fields }));
}

function normalizeUrl(input) {
  let raw = String(input == null ? '' : input).trim();
  if (!raw) return { ok: false, error: '请输入 URL。' };

  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(raw);
  if (scheme) {
    const name = scheme[1].toLowerCase();
    const rest = raw.slice(scheme[0].length);
    if (name !== 'http' && name !== 'https') {
      // "example.com:8080" is a host:port, not a protocol; any other scheme is rejected.
      if (!/^[0-9]/.test(rest)) {
        return { ok: false, error: '只支持 http/https 地址。' };
      }
      raw = 'https://' + raw;
    }
  } else {
    raw = 'https://' + raw;
  }

  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return { ok: false, error: 'URL 格式无效。' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, error: '只支持 http/https 地址。' };
  }
  if (!parsed.hostname) return { ok: false, error: 'URL 格式无效。' };

  return { ok: true, url: parsed.toString() };
}

function isHttpUrl(value) {
  if (!value) return false;
  try {
    const parsed = new URL(String(value));
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && !!parsed.hostname;
  } catch {
    return false;
  }
}

// System browser handoff is deliberately narrower than page URL display/copy.
// Never pass credentials or a non-HTTP(S) scheme to the OS shell.
function isSafeExternalHttpUrl(value) {
  if (typeof value !== 'string' || /[\u0000-\u0020\u007f]/.test(value)) return false;
  if (!isHttpUrl(value)) return false;
  try {
    const parsed = new URL(String(value));
    return !parsed.username && !parsed.password;
  } catch {
    return false;
  }
}

function normalizeName(input) {
  return String(input == null ? '' : input).trim();
}

// ------------------------------------------------------------------ config ---

function loadConfig() {
  let raw;
  try {
    raw = fs.readFileSync(CONFIG_PATH, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      sites = [];
      activeSiteId = null;
      return;
    }
    configWritable = false;
    sites = [];
    activeSiteId = null;
    dialog.showErrorBox(
      'Fixed Sites',
      '读取配置文件失败，本次运行不会覆盖该文件：\n' +
        CONFIG_PATH +
        '\n\n' +
        errorMessage(err)
    );
    return;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    configWritable = false;
    sites = [];
    activeSiteId = null;
    dialog.showErrorBox(
      'Fixed Sites',
      '配置文件不是有效的 JSON，本次运行不会覆盖该文件：\n' +
        CONFIG_PATH +
        '\n\n' +
        errorMessage(err)
    );
    return;
  }

  const list = parsed && Array.isArray(parsed.sites) ? parsed.sites : [];
  savedConfig = parsed || {};
  sidebarCollapsed = parsed?.sidebarCollapsed === true;
  agentSidebarCollapsed = parsed?.agentSidebarCollapsed === true;
  sidebarWidth = sidebarCollapsed ? COLLAPSED_SIDEBAR_WIDTH : SIDEBAR_WIDTH;
  closeToTray = parsed?.closeToTray === true;
  zoomByOrigin = parsed?.zoomByOrigin || {};
  activeAgentId = ['dsh', 'antigravity', 'claude', 'codex'].includes(parsed?.activeAgentId) ? parsed.activeAgentId : 'dsh';
  sites = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const name = normalizeName(item.name);
    const urlCheck = normalizeUrl(item.url);
    if (!name || !urlCheck.ok) continue;
    sites.push({
      id: typeof item.id === 'string' && item.id ? item.id : crypto.randomUUID(),
      name,
      url: urlCheck.url,
      faviconUrl: isHttpUrl(item.faviconUrl) ? item.faviconUrl : undefined,
      coverFile: typeof item.coverFile === 'string' && /^[\w-]+\.(png|jpe?g|webp|gif)$/i.test(item.coverFile) ? item.coverFile : undefined,
    });
  }
  activeSiteId =
    typeof parsed?.activeSiteId === 'string' && parsed.activeSiteId ? parsed.activeSiteId : null;
}

function configPayload() {
  if (!configWritable) {
    throw new Error('配置文件读取时出错，本次运行不会覆盖它；改动未保存。');
  }
  return {
    ...savedConfig,
    sites: sites.map((site) => ({ id: site.id, name: site.name, url: site.url, faviconUrl: site.faviconUrl, coverFile: site.coverFile })),
    activeSiteId,
    sidebarCollapsed,
    agentSidebarCollapsed,
    closeToTray,
    zoomByOrigin,
    activeAgentId,
  };
}

function scheduleConfigSave() {
  if (!configWritable) return;
  configWriter.schedule(configPayload());
}

function discardRolledBackConfig() {
  // A failed durable edit may have newer preference snapshots queued behind it.
  // Replace those snapshots with the authoritative rolled-back state before
  // any asynchronous cleanup can yield to a pending retry.
  if (configWritable) configWriter.schedule(configPayload());
}

async function saveConfig() {
  await configWriter.write(configPayload());
  configError = null;
}

async function flushConfigSave() {
  if (configWritable) await saveConfig();
}

function configAction(action) {
  const next = configOperations.then(action);
  configOperations = next.catch(() => {});
  return next;
}

// ------------------------------------------------------------------- state ---

function canvasGeometry() {
  const [width, height] = contentSize();
  return layoutCanvas(canvas, { width, height, left: sidebarWidth,
    right: agentSidebarCollapsed ? COLLAPSED_SIDEBAR_WIDTH : SIDEBAR_WIDTH,
    top: TOOLBAR_HEIGHT, immersive });
}

function captureUndo(label, includeSites = false) {
  return { label, canvas: structuredClone(canvas), activeSiteId, activeAgentId,
    sidebarCollapsed, agentSidebarCollapsed, bounds: mainWindow?.getNormalBounds(), maximized: mainWindow?.isMaximized(),
    ...(includeSites ? { sites: structuredClone(sites) } : {}) };
}

function rememberUndo(before) {
  lastUndo = before;
  const referenced = new Set([...sites, ...(lastUndo?.sites || [])].map(site => site.coverFile).filter(Boolean));
  for (const file of retiredCovers) if (!referenced.has(file)) {
    retiredCovers.delete(file);
    fs.promises.rm(path.join(COVERS_DIR, file), { force: true }).catch(() => {});
  }
  sendState();
}

async function runSiteEdit(label, action) {
  const before = captureUndo(label, true);
  const result = await action();
  if (result?.ok && !result.cancelled && JSON.stringify(before.sites) !== JSON.stringify(sites)) {
    canvas.panes = canvas.panes.filter(p => p.kind !== 'web' || sites.some(site => site.id === p.id));
    if (!canvas.panes.some(p => p.key === canvas.activeKey)) canvas.activeKey = canvas.panes[0]?.key || null;
    if (!canvas.panes.some(p => p.key === canvas.expanded)) canvas.expanded = null;
    rememberUndo(before);
    layoutActiveView();
  }
  return result;
}

function placeCanvasContent(kind, id) {
  let pane = canvas.panes.find(p => p.kind === kind && p.id === id);
  if (!pane) {
    pane = canvas.panes.find(p => p.kind === 'empty');
    if (!pane && kind === 'agent') pane = canvas.panes.find(p => p.kind === 'agent');
    if (!pane && kind === 'web') pane = canvas.panes.find(p => p.key === canvas.activeKey && p.kind === 'web');
    if (!pane && canvas.panes.length < 2) {
      pane = { key: crypto.randomUUID() }; canvas.panes.push(pane);
    }
    if (!pane) pane = canvas.panes.find(p => p.kind === 'web') || canvas.panes[0];
    Object.assign(pane, { kind, id });
  }
  canvas.activeKey = pane.key;
  if (canvas.expanded) canvas.expanded = pane.key;
  section = 'my';
  workspace = kind === 'agent' ? 'agents' : 'web';
  return pane;
}

function focusCanvasPane(key, focus = true) {
  const pane = canvas.panes.find(p => p.key === key);
  if (!pane) return { ok: false, error: '面板已关闭。' };
  canvas.activeKey = key;
  if (pane.kind === 'web') {
    workspace = 'web'; activeSiteId = pane.id;
    if (focus) views.get(pane.id)?.view.webContents.focus();
  } else if (pane.kind === 'agent') {
    workspace = 'agents'; activeAgentId = pane.id;
    if (focus) agentHost?.focus().catch(reportAgentError);
  } else {
    workspace = 'web'; activeSiteId = null;
  }
  sendState();
  return { ok: true };
}

async function canvasAction(action, value) {
  if (action === 'focus') return focusCanvasPane(value, false);
  const before = captureUndo({ horizontal: '左右布局', vertical: '上下布局', swap: '互换位置', expand: '铺满面板', close: '收起面板' }[action] || '调整布局');
  if (action === 'horizontal' || action === 'vertical') {
    canvas.direction = action; canvas.expanded = null;
    let firstEmpty = null;
    while (canvas.panes.length < 2) {
      const empty = { key: crypto.randomUUID(), kind: 'empty' };
      canvas.panes.push(empty); firstEmpty ||= empty.key;
    }
    if (firstEmpty) canvas.activeKey = firstEmpty;
    canvas.ratio = .5;
  } else if (action === 'swap') canvas.panes.reverse();
  else if (action === 'expand') {
    if (!canvas.panes.some(p => p.key === value && p.kind !== 'empty')) return { ok: false, error: '请先打开网页或 Agent。' };
    canvas.expanded = canvas.expanded === value ? null : value;
    canvas.activeKey = value;
  } else if (action === 'close') {
    canvas.panes = canvas.panes.filter(p => p.key !== value);
    if (canvas.activeKey === value) canvas.activeKey = canvas.panes[0]?.key || null;
    if (canvas.expanded === value) canvas.expanded = null;
  } else return { ok: false, error: '未知布局操作。' };
  section = 'my'; immersive = false;
  if (JSON.stringify(before.canvas) !== JSON.stringify(canvas)) rememberUndo(before);
  layoutActiveView();
  if (canvas.activeKey) focusCanvasPane(canvas.activeKey, false);
  else { activeSiteId = null; workspace = 'web'; }
  sendState();
  return { ok: true };
}

async function resizeCanvas(phase, ratio) {
  if (phase === 'begin') { resizeBefore = captureUndo('调整分栏大小'); canvasResizing = true; }
  if (Number.isFinite(ratio)) canvas.ratio = Math.max(.2, Math.min(.8, ratio));
  if (phase === 'end') {
    canvasResizing = false;
    if (resizeBefore && resizeBefore.canvas.ratio !== canvas.ratio) rememberUndo(resizeBefore);
    resizeBefore = null;
  }
  layoutActiveView(); sendState();
  return { ok: true };
}

async function undoLastOperation() {
  const previous = lastUndo;
  if (!previous) return { ok: false, error: '当前没有可以撤销的操作。' };
  if (previous.sites) {
    const wanted = new Map(previous.sites.map(site => [site.id, site]));
    for (const [id] of views) {
      const old = sites.find(site => site.id === id), next = wanted.get(id);
      if ((!next || old?.url !== next.url) && !(await releaseSiteView(id, { interactive: true })))
        return { ok: false, error: '已保留网页，撤销尚未执行。' };
    }
    const current = sites;
    sites = structuredClone(previous.sites);
    try { await saveConfig(); } catch (error) { sites = current; discardRolledBackConfig(); throw error; }
  }
  await restoreCanvas(previous.canvas, previous.activeSiteId, previous.activeAgentId);
  sidebarCollapsed = previous.sidebarCollapsed; agentSidebarCollapsed = previous.agentSidebarCollapsed;
  sidebarWidth = sidebarCollapsed ? COLLAPSED_SIDEBAR_WIDTH : SIDEBAR_WIDTH;
  if (previous.bounds) { if (mainWindow.isMaximized()) mainWindow.unmaximize(); mainWindow.setBounds(previous.bounds); }
  if (previous.maximized) mainWindow.maximize();
  layoutActiveView(); scheduleConfigSave();
  lastUndo = null; sendState();
  return { ok: true };
}

async function restoreCanvas(next, siteId, agentId) {
  canvas = structuredClone(next); section = 'my'; immersive = false;
  activeSiteId = siteId; activeAgentId = agentId;
  for (const pane of canvas.panes) if (pane.kind === 'web') {
    const site = sites.find(s => s.id === pane.id);
    if (!site) { pane.kind = 'empty'; delete pane.id; continue; }
    let entry = views.get(site.id);
    if (!entry) { entry = createSiteView(site); startLoad(entry, site); }
  }
  const agent = canvas.panes.find(p => p.kind === 'agent');
  const restoredCanvas = structuredClone(canvas);
  if (agent) await setWorkspace('agents', agent.id);
  // Connecting an Agent selects and may expand it; retain the saved arrangement.
  canvas = restoredCanvas;
  layoutActiveView();
  if (canvas.activeKey) focusCanvasPane(canvas.activeKey, false);
  sendState();
}

function loadManualSnapshot() {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(dataDir, 'manual-snapshot.json'), 'utf8'));
    if (value.version !== 1 || !Array.isArray(value.canvas?.panes) || value.canvas.panes.length > 2) throw new Error('快照格式不受支持');
    manualSnapshot = value;
  } catch (error) { if (error.code !== 'ENOENT') snapshotError = '无法读取手动快照，原文件已保留。'; }
}

async function saveManualSnapshot() {
  const pages = [];
  for (const pane of canvas.panes) if (pane.kind === 'web') {
    const wc = views.get(pane.id)?.view.webContents;
    if (!wc || wc.isDestroyed()) continue;
    let scroll = null;
    try { scroll = await Promise.race([wc.executeJavaScript('({ x: window.scrollX, y: window.scrollY })'),
      new Promise(resolve => setTimeout(() => resolve(null), 800))]); } catch { /* site unavailable */ }
    pages.push({ id: pane.id, url: wc.getURL(), scroll });
  }
  const snapshot = { version: 1, savedAt: new Date().toISOString(), canvas: structuredClone(canvas),
    activeSiteId, activeAgentId, sidebarCollapsed, agentSidebarCollapsed,
    bounds: mainWindow.getNormalBounds(), maximized: mainWindow.isMaximized(), pages };
  if (manualSnapshot || snapshotError) {
    const answer = await dialog.showMessageBox(mainWindow, { type: 'question', message: '替换上一次手动快照？',
      detail: '仅保留一个手动快照；不会保存网页表单或 Agent 内部内容。', buttons: ['保存当前快照', '取消'], defaultId: 1, cancelId: 1 });
    if (answer.response !== 0) return { ok: true, cancelled: true };
  }
  await new ConfigWriter(path.join(dataDir, 'manual-snapshot.json')).write(snapshot);
  manualSnapshot = snapshot; snapshotError = null; sendState();
  return { ok: true };
}

async function restoreManualSnapshot() {
  if (!manualSnapshot) return { ok: false, error: snapshotError || '还没有手动快照。' };
  if (manualSnapshot.canvas.panes.some(p => p.kind === 'web' && !sites.some(s => s.id === p.id)))
    return { ok: false, error: '快照中的网站已从清单移除，请先撤销删除或重新保存快照。' };
  const before = captureUndo('恢复快照');
  for (const page of manualSnapshot.pages) {
    const entry = views.get(page.id);
    if (entry && safeCurrentUrl(entry.view.webContents) !== page.url && !(await confirmCloseSiteDraft(entry)))
      return { ok: false, error: '已保留当前网页，快照尚未恢复。' };
  }
  sidebarCollapsed = manualSnapshot.sidebarCollapsed;
  agentSidebarCollapsed = manualSnapshot.agentSidebarCollapsed;
  sidebarWidth = sidebarCollapsed ? COLLAPSED_SIDEBAR_WIDTH : SIDEBAR_WIDTH;
  await restoreCanvas(manualSnapshot.canvas, manualSnapshot.activeSiteId, manualSnapshot.activeAgentId);
  for (const page of manualSnapshot.pages) {
    const entry = views.get(page.id);
    if (!entry || !isHttpUrl(page.url)) continue;
    const wc = entry.view.webContents;
    const scroll = () => {
      if (page.scroll && !wc.isDestroyed()) wc.executeJavaScript(`window.scrollTo(${Number(page.scroll.x) || 0}, ${Number(page.scroll.y) || 0})`).catch(() => {});
    };
    if (wc.getURL() !== page.url) { wc.once('did-finish-load', scroll); startLoad(entry, { url: page.url }); }
    else if (wc.isLoading()) wc.once('did-finish-load', scroll);
    else scroll();
  }
  if (manualSnapshot.bounds) { if (mainWindow.isMaximized()) mainWindow.unmaximize(); mainWindow.setBounds(manualSnapshot.bounds); }
  if (manualSnapshot.maximized) mainWindow.maximize();
  rememberUndo(before); layoutActiveView(); scheduleConfigSave(); sendState();
  return { ok: true };
}

function safeCurrentUrl(webContents) {
  try {
    const url = webContents.getURL();
    return typeof url === 'string' && url ? url : '';
  } catch {
    return '';
  }
}

function getState() {
  const list = sites.map((site) => {
    const siteEntry = views.get(site.id);
    return {
      id: site.id,
      name: site.name,
      url: site.url,
      faviconUrl: siteEntry?.faviconUrl || site.faviconUrl || new URL('/favicon.ico', site.url).href,
      coverUrl: site.coverFile ? pathToFileURL(path.join(COVERS_DIR, site.coverFile)).href : null,
    };
  });

  const entry = activeSiteId ? views.get(activeSiteId) : null;
  let activePage = null;
  if (entry) {
    const webContents = entry.view.webContents;
    let canGoBack = false;
    let canGoForward = false;
    try {
      canGoBack = webContents.navigationHistory.canGoBack();
      canGoForward = webContents.navigationHistory.canGoForward();
    } catch {
      /* webContents already gone */
    }
    activePage = {
      currentUrl: safeCurrentUrl(webContents),
      loading: entry.loading,
      canGoBack,
      canGoForward,
      error: entry.error,
      zoomFactor: webContents.isDestroyed() ? 1 : webContents.getZoomFactor(),
      crashed: entry.crashed,
      readyToShow: entry.readyToShow,
    };
  }

  return {
    sites: list, activeSiteId, activePage, section, sidebarCollapsed, closeToTray, configError, immersive,
    agentSidebarCollapsed, undoLabel: lastUndo?.label || null,
    snapshotSavedAt: manualSnapshot?.savedAt || null, snapshotError,
    canvas: { ...canvas, ...canvasGeometry(), resizing: canvasResizing,
      pages: canvas.panes.filter(p => p.kind === 'web').map(p => {
        const entry = views.get(p.id), wc = entry?.view.webContents;
        return { id: p.id, loading: entry?.loading, error: entry?.error, currentUrl: wc && !wc.isDestroyed() ? wc.getURL() : '',
          canGoBack: wc && !wc.isDestroyed() && wc.navigationHistory.canGoBack(), canGoForward: wc && !wc.isDestroyed() && wc.navigationHistory.canGoForward() };
      }) },
    workspace, activeAgentId, agents: agentHost?.observedAgents || [], agentError, agentBusy,
    agentConfigError: agentHost?.configError || null,
    sidebarWidth,
    sidebarTargetWidth: sidebarCollapsed ? COLLAPSED_SIDEBAR_WIDTH : SIDEBAR_WIDTH,
    toolbarHeight: TOOLBAR_HEIGHT,
  };
}

function sendState() {
  if (!uiReady || !mainWindow || mainWindow.isDestroyed() || stateSendPending) return;
  stateSendPending = true;
  setImmediate(() => {
    stateSendPending = false;
    if (!uiReady || !mainWindow || mainWindow.isDestroyed()) return;
    const state = getState();
    const json = JSON.stringify(state);
    if (previousStateJson === json) return;
    previousStateJson = json;
    mainWindow.webContents.send('fixed-sites:state-changed', state);
  });
}

// ------------------------------------------------------------------ views ----

function contentSize() {
  if (!mainWindow || mainWindow.isDestroyed()) return [0, 0];
  return mainWindow.getContentSize();
}

function layoutActiveView() {
  if (closingAgents) return;
  const panels = section === 'my' && !canvasResizing ? canvasGeometry().panels : [];
  for (const [id, entry] of views) {
    if (panels.some(p => p.kind === 'web' && p.id === id)) attachView(entry);
    else if (isAttached(entry)) detachView(entry);
  }
  const agent = panels.find(p => p.kind === 'agent');
  if (agent && agentHost?.process) {
    agentHost.resize({ ...agent.content, immersive }).then(() => {
      if (!canvasAgentVisible && section === 'my' && !canvasResizing && canvasGeometry().panels.some(p => p.kind === 'agent')) {
        canvasAgentVisible = true; return agentHost.show();
      }
    }).catch(reportAgentError);
  } else if (canvasAgentVisible) {
    canvasAgentVisible = false; agentHost?.hide().catch(reportAgentError);
  }
  sendState();
}

function layoutWebView(entry) {
  const pane = canvasGeometry().panels.find(p => p.kind === 'web' && views.get(p.id) === entry);
  if (pane) entry.view.setBounds(pane.content);
}

function isAttached(entry) {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  return mainWindow.contentView.children.includes(entry.view);
}

function attachView(entry) {
  if (!mainWindow || mainWindow.isDestroyed() || section !== 'my' || canvasResizing ||
      !canvasGeometry().panels.some(p => p.kind === 'web' && views.get(p.id) === entry)) return;
  // Present the requested native view immediately, including progressive cold
  // loading. DOMContentLoaded is not a paint boundary and must not hold it back.
  layoutWebView(entry);
  if (!entry.started || entry.crashed || entry.error) return;
  if (!isAttached(entry)) mainWindow.contentView.addChildView(entry.view);
  entry.view.setVisible(true);
  if (views.get(activeSiteId) === entry) presentedView = entry;
}

function detachView(entry, { touch = true } = {}) {
  if (presentedView === entry) presentedView = null;
  if (touch) entry.lastUsedAt = Date.now();
  entry.view.setVisible(false);
  if (isAttached(entry)) mainWindow.contentView.removeChildView(entry.view);
}

function detachWebViews() {
  for (const entry of views.values()) if (isAttached(entry)) detachView(entry);
}

function reportAgentError(err) {
  agentError = errorMessage(err);
  sendState();
}

function agentBounds() {
  const pane = canvasGeometry().panels.find(p => p.kind === 'agent');
  return { ...(pane?.content || { x: sidebarWidth, y: TOOLBAR_HEIGHT, width: 1, height: 1 }), immersive };
}

// Serialize only native UI actions, so a quick Web/Agents/Web sequence cannot
// finish a late attach after the user has already returned to the webpage.
function nativeAction(action) {
  if (closingAgents) return Promise.reject(new Error('正在恢复 Agent 窗口并退出。'));
  const result = nativeOperations.then(() => {
    if (closingAgents) throw new Error('正在恢复 Agent 窗口并退出。');
    return action();
  });
  nativeOperations = result.catch(() => {});
  return result;
}

function setWorkspace(next, agentId = activeAgentId, agentWindow = null, allowLaunch = false) {
  const request = ++workspaceRequest;
  // Interrupt an outstanding launch wait before entering the serialized queue.
  // Cancelling the wait only cancels attachment, never the Agent process.
  if (agentBusy) agentHost.cancelWait().catch(reportAgentError);
  return nativeAction(async () => {
    if (request !== workspaceRequest) return { ok: true, cancelled: true };
    if (next === 'web') {
      workspace = 'web';
      immersive = false;
      mainWindow.setTitle('Fixed Sites');
      const entry = views.get(activeSiteId);
      if (section === 'my' && entry) { placeCanvasContent('web', activeSiteId); layoutActiveView(); entry.view.webContents.focus(); }
      else mainWindow.webContents.focus();
      sendState();
      return { ok: true };
    }
    if (!agentHost.presets.some((preset) => preset.id === agentId)) return { ok: false, error: '未知 Agent。' };
    immersive = false;
    mainWindow.setTitle('Fixed Sites');
    placeCanvasContent('agent', agentId);
    workspace = 'agents';
    activeAgentId = agentId;
    agentError = null;
    agentBusy = true;
    sendState();
    try {
       scheduleConfigSave();
      await agentHost.resize(agentBounds());
      if (request !== workspaceRequest) return { ok: true, cancelled: true };
      await agentHost.connect(activeAgentId, agentWindow, allowLaunch);
      canvasAgentVisible = true;
      layoutActiveView();
      if (request !== workspaceRequest) return { ok: true, cancelled: true };
      if (agentHost.agents.find((item) => item.id === activeAgentId)?.phase === 'selecting') openAgentPicker(activeAgentId);
      return { ok: true };
    } catch (err) {
      reportAgentError(err);
      return { ok: false, error: agentError };
    } finally {
      agentBusy = false;
      sendState();
    }
  });
}

function openAgentPicker(id) {
  if (!agentHost.presets.some((item) => item.id === id)) return { ok: false, error: '未知 Agent。' };
  if (agentPicker && !agentPicker.isDestroyed()) {
    if (pickerAgentId === id) { agentPicker.show(); agentPicker.focus(); return { ok: true }; }
    agentPicker.close();
  }
  pickerAgentId = id;
  pickerCandidates = new Map();
  const preset = agentHost.presets.find((item) => item.id === id);
  const window = new BrowserWindow({
    parent: mainWindow, modal: false, width: 860, height: 660, minWidth: 640, minHeight: 460,
    title: `${preset.name} · 窗口接入`, icon: APP_ICON, backgroundColor: '#151c25',
    show: false, skipTaskbar: true, autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), nodeIntegration: false, contextIsolation: true, sandbox: true },
  });
  agentPicker = window;
  window.removeMenu();
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.once('ready-to-show', () => window.show());
  window.on('close', () => {
    if (pickerConnecting && agentPicker === window) {
      ++workspaceRequest;
      agentHost.cancelWait().catch(reportAgentError);
    }
  });
  window.on('closed', () => {
    if (agentPicker === window) { agentPicker = null; pickerAgentId = null; pickerCandidates.clear(); ++pickerRefresh; }
  });
  window.loadFile(path.join(__dirname, 'ui-dist', 'index.html'), { query: { windowPicker: id } });
  return { ok: true };
}

function windowIdentity(candidate, preset) {
  const image = candidate.executablePath || '';
  if (/\\OpenAI\.Codex_/i.test(image)) return { identity: 'Codex Desktop', identityEvidence: '可执行文件位于 OpenAI.Codex Windows 应用包内' };
  if (/\\OpenAI\.(?:ChatGPT|ChatGPTDesktop)_/i.test(image)) return { identity: 'ChatGPT Desktop', identityEvidence: '可执行文件位于 ChatGPT Windows 应用包内' };
  const browsers = { 'chrome.exe': 'Google Chrome', 'msedge.exe': 'Microsoft Edge', 'firefox.exe': 'Firefox' };
  const browser = browsers[path.win32.basename(image).toLowerCase()];
  if (browser) return { identity: `${browser} 浏览器`, identityEvidence: '依据可执行文件名称' };
  if (image && (image.toLowerCase() === preset.launchPath?.toLowerCase() ||
    candidate.productName?.toLowerCase() === preset.name.toLowerCase() ||
    preset.id === 'dsh' && candidate.productName === 'DSH NEXT' || preset.id === 'claude' && /\\Claude_/i.test(image))) {
    return { identity: preset.name, identityEvidence: '依据已保存的程序路径或可执行文件产品信息' };
  }
  return { identity: '身份未知', identityEvidence: '未取得可确认的程序路径或产品信息；不依据窗口标题推断' };
}

function usableWindowThumbnail(image) {
  if (!image || image.isEmpty()) return false;
  const { width, height } = image.getSize();
  if (width < 8 || height < 8) return false;
  const pixels = image.toBitmap();
  let min = 255, max = 0;
  for (let y = 4; y < height - 4; y += 4) for (let x = 4; x < width - 4; x += 4) {
    const offset = (y * width + x) * 4;
    const brightness = (pixels[offset] + pixels[offset + 1] + pixels[offset + 2]) / 3;
    min = Math.min(min, brightness); max = Math.max(max, brightness);
  }
  // A uniform blank frame is labelled unavailable, never disguised as a preview.
  return max - min > 8;
}

async function agentWindowPreviews() {
  const window = agentPicker, id = pickerAgentId, refresh = ++pickerRefresh;
  const preset = agentHost.presets.find((item) => item.id === id);
  const candidates = await agentHost.discover(id);
  let sources = [], captureError = null;
  try { sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 480, height: 300 }, fetchWindowIcons: true }); }
  catch { captureError = '系统未提供窗口预览；仍可查看真实窗口与进程信息。'; }
  const captures = new Map(sources.map((source) => {
    const value = /^window:(\d+):/.exec(source.id)?.[1];
    return [value ? `0x${BigInt(value).toString(16).toUpperCase()}` : '', source];
  }));
  const rows = await Promise.all(candidates.map(async (candidate) => {
    const source = captures.get(candidate.hwnd);
    let icon = source?.appIcon && !source.appIcon.isEmpty() ? source.appIcon.toDataURL() : null;
    if (!icon && candidate.executablePath) {
      try { icon = (await app.getFileIcon(candidate.executablePath, { size: 'normal' })).toDataURL(); } catch { }
    }
    const available = usableWindowThumbnail(source?.thumbnail);
    return { ...candidate, ...windowIdentity(candidate, preset), icon,
      thumbnail: available ? `data:image/jpeg;base64,${source.thumbnail.toJPEG(80).toString('base64')}` : null,
      previewNote: available ? candidate.minimized ? '最小化窗口：系统预览可能为缓存帧' : '一次性系统窗口预览' :
        candidate.current ? '当前窗口已嵌入，请在 FS 主窗口查看内容' : candidate.minimized ? '最小化窗口：未取得可辨认预览，不会为截图还原窗口' :
        candidate.unavailableReason || captureError || (!source ? '此 HWND 未出现在系统窗口捕获目录中；未为预览改变窗口状态' : '系统返回了空白预览；无法确认当前画面'),
    };
  }));
  if (agentPicker !== window || pickerAgentId !== id || pickerRefresh !== refresh) return { ok: true, cancelled: true };
  pickerCandidates = new Map(rows.map((candidate) => [candidate.hwnd, candidate]));
  const current = agentHost.observedAgents.find((item) => item.id === id);
  return { ok: true, name: preset.name, windows: rows, current, captureError };
}

function manageAgentWindow(id, action) {
  if (!agentHost.presets.some((item) => item.id === id)) return Promise.resolve({ ok: false, error: '未知 Agent。' });
  ++workspaceRequest;
  agentHost.cancelWait().catch(reportAgentError);
  return nativeAction(async () => {
    agentBusy = true; agentError = null; sendState();
    try {
      if (action === 'sync') {
        if (workspace !== 'agents' || activeAgentId !== id) throw new Error('请先切换到这个 Agent，再同步显示区域。');
        await agentHost.resize(agentBounds());
        await agentHost.sync(id);
      } else {
        await agentHost.detach(id, action === 'show');
        if (id === activeAgentId) { immersive = false; mainWindow.setTitle('Fixed Sites'); }
      }
      return { ok: true };
    } catch (error) { reportAgentError(error); return { ok: false, error: errorMessage(error) }; }
    finally { agentBusy = false; sendState(); }
  });
}

async function setSection(next) {
  section = next === 'explore' ? 'explore' : next === 'library' ? 'library' : 'my';
  if (section !== 'my') workspace = 'web';
  immersive = false;
  mainWindow.setTitle('Fixed Sites');
  const entry = views.get(activeSiteId);
  if (entry) {
    if (section !== 'my') detachWebViews();
    else {
      entry.lastUsedAt = Date.now();
      attachView(entry);
      entry.view.webContents.focus();
    }
  }
  if (section === 'my' && !entry) restoreSelection();
  if (section !== 'my') mainWindow.webContents.focus();
  layoutActiveView();
  sendState();
  return { ok: true };
}

function setImmersive(value) {
  return nativeAction(async () => {
   if (value == null) value = !immersive;
  if (value && (workspace === 'web' ? !activeSiteId || section !== 'my' :
      !agentHost.agents.find((agent) => agent.id === activeAgentId)?.attached))
    return { ok: false, error: '请先打开一个网站或 Agent。' };
  immersive = Boolean(value);
  // Resize the native child before exposing Sidebar/toolbar again.
  if (workspace === 'agents') await agentHost.resize(agentBounds());
  if (closingAgents) return { ok: true, cancelled: true };
  mainWindow.setTitle(immersive ? 'Fixed Sites · 沉浸模式（Esc / F11 恢复）' : 'Fixed Sites');
  layoutActiveView();
  sendState();
  if (workspace === 'web') views.get(activeSiteId)?.view.webContents.focus();
   else await agentHost.focus();
  return { ok: true };
  });
}

function setSidebarCollapsed(value) {
  return nativeAction(async () => {
  const previous = sidebarCollapsed;
   sidebarCollapsed = value == null ? !sidebarCollapsed : Boolean(value);
  try {
     scheduleConfigSave();
  } catch (err) {
    sidebarCollapsed = previous;
    return { ok: false, error: errorMessage(err) };
  }
  sendState();
  return { ok: true };
  });
}

function sampleResourcePressure() {
  try {
    const metrics = app.getAppMetrics();
    // getAppMetrics().memory is in KB. Deduplicate PIDs and use private memory
    // so shared Chromium pages are not counted several times.
    const unique = new Map(metrics.map(metric => [metric.pid, metric]));
    const totalBytes = [...unique.values()].reduce((sum, metric) =>
      sum + Number(metric.memory?.privateBytes || 0) * 1024, 0);
    lastResourceSample = { at: Date.now(), totalBytes };
    return totalBytes >= RESOURCE_PRESSURE_BYTES;
  } catch {
    lastResourceSample = null;
    return false;
  }
}

async function hasUnsavedDraft(entry) {
  const activity = await inspectPage(entry.view.webContents);
  return activity.draft || activity.unknown;
}

async function confirmCloseSiteDraft(entry) {
  if (!entry || entry.view.webContents.isDestroyed()) return true;
  if (!(await hasUnsavedDraft(entry))) {
    entry.hasUserInput = false;
    entry.mouseTouched = false;
    return true;
  }
  const owner = ownerWindowForContents(entry.view.webContents, entry.primary !== false);
  const result = await dialog.showMessageBox(owner, {
    type: 'warning',
    title: '网页可能有未提交内容',
    message: '此网页看起来包含尚未提交的内容。',
    detail: '如果继续关闭或重新打开，草稿可能会丢失。',
    buttons: ['继续关闭', '取消'],
    defaultId: 1,
    cancelId: 1,
  });
  return result.response === 0;
}

// A soft working set: never evict the most recent pages, pages with active
// media/loading/downloads/popups, or pages whose draft status cannot be read.
async function retireIdleViews() {
  if (retiringViews) return;
  retiringViews = true;
  try {
  sampleResourcePressure();
  // Keep the existing five-page/fifteen-minute policy. Pressure is observed,
  // not used to force eviction of uncertain or recently used pages.
  const keepCount = RECENT_VIEW_COUNT;
  const recent = [...views.entries()].sort((a, b) => b[1].lastUsedAt - a[1].lastUsedAt);
  const now = Date.now();
  for (const [id, entry] of recent.slice(keepCount)) {
    if (protectedView(id, entry)) continue;
    try { if (entry.view.webContents.isCurrentlyAudible()) continue; } catch { continue; }
    if (now - entry.lastUsedAt < IDLE_VIEW_MS) continue;
    const checkedLastUsedAt = entry.lastUsedAt;
    const checkedEpoch = entry.activityEpoch;
    const activity = await inspectPage(entry.view.webContents);
    if (activity.draft || activity.media || activity.unknown) continue;
    // A form can have been submitted while its AI job is still running. A
    // stateful document with prior input/interaction is never inferred idle.
    if ((entry.hasUserInput || entry.mouseTouched) && activity.stateful) continue;
    const canClose = () => views.get(id) === entry && !protectedView(id, entry) &&
      entry.activityEpoch === checkedEpoch && entry.lastUsedAt === checkedLastUsedAt &&
      Date.now() - entry.lastUsedAt >= IDLE_VIEW_MS &&
      ![...views.values()].sort((a, b) => b.lastUsedAt - a.lastUsedAt).slice(0, keepCount).includes(entry);
    if (!canClose()) continue;
    entry.hasUserInput = false;
    entry.mouseTouched = false;
    await releaseSiteView(id, { canClose });
  }
  } finally { retiringViews = false; }
}

function protectedView(id, entry) {
  if (canvas.panes.some(p => p.kind === 'web' && p.id === id)) return true;
  if (!entry || closingAgents || entry.closing || id === activeSiteId || entry === presentedView ||
      entry.loading || entry.mediaActive || entry.unresponsive || entry.captureActive || entry.unknownTask ||
      entry.popupCount > 0 || entry.downloadCount > 0 || entry.activeRequests > 0) return true;
  try { return entry.view.webContents.isDestroyed() || entry.view.webContents.isCurrentlyAudible(); }
  catch { return true; }
}

function touchEntry(entry, kind = 'interaction') {
  if (!entry) return;
  entry.activityEpoch = (entry.activityEpoch || 0) + 1;
  entry.lastUsedAt = Date.now();
  if (kind === 'input') entry.hasUserInput = true;
  if (kind === 'mouse') entry.mouseTouched = true;
}

function installKeyboardShortcuts(webContents, entry = null, primary = false, targetContents = null) {
  if (entry) {
    // A click may start voice input, paste, autofill or editing. Protect it too;
    // the soft limit must never require guessing whether a form is disposable.
    webContents.on('before-mouse-event', (_event, mouse) => {
      if (mouse.type === 'mouseDown' && mouse.button === 'left') touchEntry(entry, 'mouse');
    });
  }
  webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const key = input.key.toLowerCase();
    const command = input.control || input.meta;
    const popup = popupRecordForContents(webContents);
    if (popup && !input.isComposing && !input.isAutoRepeat) {
      if (command && !input.alt && !input.shift && key === 'w') {
        event.preventDefault(); requestPopupClose(popup).catch(() => {}); return;
      }
      if (key === 'f11' && !command && !input.alt && !input.shift) {
        event.preventDefault(); popup.frameFullScreen = !popup.window.isFullScreen();
        popup.window.setFullScreen(popup.frameFullScreen); layoutPopup(popup); return;
      }
      if (key === 'escape' && popup.frameFullScreen && !popup.htmlFullScreen) {
        event.preventDefault(); popup.frameFullScreen = false; popup.window.setFullScreen(false); return;
      }
    }
    if (input.isComposing) {
      touchEntry(entry, 'input');
      return;
    }
    if (primary && key === 'escape' && immersive) {
      event.preventDefault();
      setImmersive(false);
      return;
    }
    if (primary && key === 'f11' && !command && !input.alt && !input.shift && !input.isAutoRepeat) {
      event.preventDefault();
       setImmersive();
      return;
    }
    if (primary && command && !input.alt &&
        ((key === '\\' && !input.shift) || (input.shift && key === 'b')) && !input.isAutoRepeat) {
      event.preventDefault();
       setSidebarCollapsed();
      return;
    }
    if (primary && workspace === 'web' && command && !input.alt && !input.isAutoRepeat && !closingAgents) {
      let nextSite = null;
      if (!input.shift && /^[1-9]$/.test(key)) nextSite = sites[Number(key) - 1];
      else if (key === 'tab' && sites.length) {
        const index = sites.findIndex((site) => site.id === activeSiteId);
        const next = index < 0 ? (input.shift ? sites.length - 1 : 0) :
          (index + (input.shift ? -1 : 1) + sites.length) % sites.length;
        nextSite = sites[next];
      }
      if (nextSite) {
        event.preventDefault();
        const result = selectSite(nextSite.id);
        if (!result.ok) dialog.showErrorBox('Fixed Sites', result.error);
        return;
      }
    }
    const target = targetContents || (entry ? webContents : primary && workspace === 'web' && section === 'my' ? views.get(activeSiteId)?.view.webContents : null);
    if (target && command && !input.alt && (['+', '=', '-', '0'].includes(key) ||
        ['NumpadAdd', 'NumpadSubtract'].includes(input.code))) {
      event.preventDefault();
      changePageZoom(target, key === '0' ? 0 : key === '-' || input.code === 'NumpadSubtract' ? -1 : 1);
      return;
    }
    if (target && ((command && !input.shift && !input.alt && key === 'r') ||
        (key === 'f5' && !command && !input.alt && !input.shift))) {
      event.preventDefault();
      target.reload();
      return;
    }
    if (target && input.alt && !command && !input.shift && (key === 'arrowleft' || key === 'arrowright')) {
      event.preventDefault();
      const history = target.navigationHistory;
      if (key === 'arrowleft' && history.canGoBack()) history.goBack();
      if (key === 'arrowright' && history.canGoForward()) history.goForward();
      return;
    }
    // Conservatively protect pages that received text, deletion or paste.
    // This uses native input events; no script is injected into third-party pages.
    if (entry && (input.isComposing || (!command && !input.alt && input.key.length === 1) ||
        key === 'backspace' || key === 'delete' || (command && ['v', 'x', 'z'].includes(key)) ||
        (input.shift && key === 'insert'))) touchEntry(entry, 'input');
  });
}

function applySavedZoom(webContents) {
  const url = safeCurrentUrl(webContents);
  if (isHttpUrl(url)) webContents.setZoomFactor(zoomByOrigin[new URL(url).origin] || 1);
}

function changePageZoom(webContents, direction) {
  const url = safeCurrentUrl(webContents);
  if (!isHttpUrl(url)) return;
  const factor = webContents.getZoomFactor();
  const next = direction === 0 ? 1 : direction > 0 ?
    ZOOM_STEPS.find((step) => step > factor + 0.01) || ZOOM_STEPS.at(-1) :
    [...ZOOM_STEPS].reverse().find((step) => step < factor - 0.01) || ZOOM_STEPS[0];
  zoomByOrigin[new URL(url).origin] = next;
  webContents.setZoomFactor(next);
  scheduleConfigSave();
  sendState();
}

function installPageZoom(webContents) {
  webContents.on('did-navigate', () => applySavedZoom(webContents));
  webContents.on('zoom-changed', (_event, direction) => changePageZoom(webContents, direction === 'in' ? 1 : -1));
}

function popupRecordForContents(webContents) {
  return webContents ? popupRecords.get(webContents.id) || null : null;
}

function ownerWindowForContents(webContents, primary = false) {
  if (primary) return mainWindow;
  return popupRecordForContents(webContents)?.window || BrowserWindow.fromWebContents(webContents);
}

function installPageContextMenu(webContents, entry, primary) {
  webContents.on('context-menu', (_event, params) => {
    const items = [];
    const ownerWindow = ownerWindowForContents(webContents, primary);
    if (primary && immersive) {
      items.push({ label: '退出沉浸模式（Esc / F11）', click: () => setImmersive(false) }, { type: 'separator' });
    }
    if (params.isEditable) {
      touchEntry(entry, 'input');
      items.push({ role: 'undo', label: '撤销' }, { role: 'redo', label: '重做' }, { type: 'separator' },
        { role: 'cut', label: '剪切' }, { role: 'copy', label: '复制' },
        { label: '粘贴', click: () => { touchEntry(entry, 'input'); webContents.paste(); } },
        { role: 'selectAll', label: '全选' });
    } else if (params.selectionText) {
      items.push({ role: 'copy', label: '复制' });
    }
    if (isHttpUrl(params.linkURL)) {
      items.push({ label: '复制链接', click: () => clipboard.writeText(params.linkURL) });
      if (isSafeExternalHttpUrl(params.linkURL)) {
        items.push({ label: '在系统浏览器打开链接', click: () => shell.openExternal(params.linkURL).catch((err) => {
          if (ownerWindow && !ownerWindow.isDestroyed()) dialog.showErrorBox('无法打开链接', errorMessage(err));
        }) });
      }
    }
    if (items.length) items.push({ type: 'separator' });
    const currentUrl = safeCurrentUrl(webContents);
    items.push(
      {
        label: '查看当前页面地址',
        enabled: Boolean(currentUrl),
        click: () => {
          const url = safeCurrentUrl(webContents);
          if (!url) return;
          dialog.showMessageBox(ownerWindow && !ownerWindow.isDestroyed() ? ownerWindow : undefined, {
            type: 'info',
            title: '当前页面地址',
            message: '当前页面地址',
            detail: url,
            buttons: ['关闭'],
            noLink: true,
          }).catch(() => {});
        },
      },
      {
        label: '复制当前页面 URL',
        enabled: Boolean(currentUrl),
        click: () => {
          const url = safeCurrentUrl(webContents);
          if (url) clipboard.writeText(url);
        },
      },
      {
        label: '在系统浏览器打开当前页面',
        enabled: isSafeExternalHttpUrl(currentUrl),
        click: () => {
          const url = safeCurrentUrl(webContents);
          if (!isSafeExternalHttpUrl(url)) return;
          shell.openExternal(url).catch((err) => {
            if (ownerWindow && !ownerWindow.isDestroyed()) dialog.showErrorBox('无法打开当前页面', errorMessage(err));
          });
        },
      },
      { type: 'separator' },
    );
    items.push(
      { label: '返回', enabled: webContents.navigationHistory.canGoBack(), click: () => webContents.navigationHistory.goBack() },
      { label: '前进', enabled: webContents.navigationHistory.canGoForward(), click: () => webContents.navigationHistory.goForward() },
      { label: '刷新', click: () => webContents.reload() },
      { type: 'separator' },
      { label: '放大', click: () => changePageZoom(webContents, 1) },
      { label: '缩小', click: () => changePageZoom(webContents, -1) },
      { label: `实际大小（当前 ${Math.round(webContents.getZoomFactor() * 100)}%）`, click: () => changePageZoom(webContents, 0) },
    );
    Menu.buildFromTemplate(items).popup({ window: ownerWindow });
  });
}

function requestExternalProtocol(url, ownerWindow = mainWindow) {
  let protocol;
  try { protocol = new URL(url).protocol; } catch { return; }
  if (/[\u0000-\u0020\u007f]/.test(url) || ['javascript:', 'file:', 'electron:', 'chrome:', 'chrome-extension:', 'devtools:', 'about:', 'data:', 'blob:',
    'shell:', 'powershell:', 'cmd:', 'ms-msdt:', 'ms-appinstaller:', 'search-ms:'].includes(protocol)) return;
  dialog.showMessageBox(ownerWindow, { type: 'question', title: '打开外部应用',
    message: '此链接需要使用系统中的其他应用打开。', detail: url,
    buttons: ['打开应用', '取消'], defaultId: 1, cancelId: 1,
  }).then(({ response }) => { if (response === 0) shell.openExternal(url).catch(() => dialog.showErrorBox('无法打开应用', '系统未能打开此链接。')); }).catch(() => {});
}

function isAllowedEmbeddedNavigation(url) {
  let protocol;
  try { protocol = new URL(url).protocol; } catch { return false; }
  if (protocol === 'about:') return String(url) === 'about:blank';
  return ['http:', 'https:', 'blob:', 'data:'].includes(protocol);
}

function popupState(record) {
  const webContents = record.pageView.webContents;
  let canGoBack = false;
  let canGoForward = false;
  try {
    canGoBack = webContents.navigationHistory.canGoBack();
    canGoForward = webContents.navigationHistory.canGoForward();
  } catch { /* page is closing */ }
  const currentUrl = safeCurrentUrl(webContents);
  return {
    currentUrl,
    title: (() => { try { return webContents.getTitle() || ''; } catch { return ''; } })(),
    loading: Boolean(record.loading),
    error: record.error || null,
    canGoBack,
    canGoForward,
    externalUrlAllowed: isSafeExternalHttpUrl(currentUrl),
  };
}

function sendPopupState(record) {
  if (!record || record.closed || record.closing || !record.chromeView.webContents || record.chromeView.webContents.isDestroyed()) return;
  const state = popupState(record);
  const title = state.title.trim().replace(/[\u0000-\u001f]/g, '').slice(0, 180);
  if (!record.window.isDestroyed()) record.window.setTitle(title ? `${title} · Fixed Sites` : 'Fixed Sites');
  const json = JSON.stringify(state);
  if (record.lastStateJson === json) return;
  record.lastStateJson = json;
  record.chromeView.webContents.send('fixed-sites:popup-state', state);
}

function layoutPopup(record) {
  if (!record || record.closed || record.window.isDestroyed()) return;
  const [width, height] = record.window.getContentSize();
  const toolbarHeight = record.htmlFullScreen ? 0 : Math.min(POPUP_TOOLBAR_HEIGHT, Math.max(0, height));
  record.chromeView.setVisible(!record.htmlFullScreen);
  record.chromeView.setBounds({ x: 0, y: 0, width: Math.max(0, width), height: toolbarHeight });
  record.pageView.setBounds({ x: 0, y: toolbarHeight, width: Math.max(0, width), height: Math.max(0, height - toolbarHeight) });
}

function popupNavigation(record, action) {
  if (!record || record.closed) return { ok: false, error: '窗口已关闭。' };
  const webContents = record.pageView.webContents;
  try {
    const history = webContents.navigationHistory;
    if (action === 'back' && history.canGoBack()) history.goBack();
    else if (action === 'forward' && history.canGoForward()) history.goForward();
    else if (action === 'reload') webContents.reload();
    else return { ok: false, error: '未知导航操作。' };
    webContents.focus();
    return { ok: true };
  } catch {
    return { ok: false, error: '网页窗口已不可用。' };
  }
}

async function popupCopyUrl(record) {
  if (!record || record.closed) return { ok: false, error: '窗口已关闭。' };
  const url = safeCurrentUrl(record.pageView.webContents);
  if (!url) return { ok: false, error: '当前页面没有可复制的地址。' };
  await clipboard.writeText(url);
  return { ok: true };
}

async function popupOpenExternal(record) {
  if (!record || record.closed) return { ok: false, error: '窗口已关闭。' };
  const url = safeCurrentUrl(record.pageView.webContents);
  if (!isSafeExternalHttpUrl(url)) return { ok: false, error: '当前地址不是可安全打开的 HTTP/HTTPS 地址。' };
  await shell.openExternal(url);
  return { ok: true };
}

function disposePopupRecord(record) {
  if (!record || record.closed) return;
  record.closed = true;
  popupRecords.delete(record.pageContentsId);
  popupRecords.delete(record.chromeContentsId);
  popupWindows.delete(record.window);
  downloadOwners.delete(record.pageContentsId);
  if (record.entry) record.entry.popupCount = Math.max(0, record.entry.popupCount - 1);
  popupRecordSet.delete(record);
}

function closePopupRecord(record) {
  if (!record || record.closed || record.closing) return;
  record.closing = true;
  try { record.pageView.webContents.close({ waitForBeforeUnload: false }); } catch { /* already gone */ }
  try { record.chromeView.webContents.close({ waitForBeforeUnload: false }); } catch { /* already gone */ }
  try { record.window.destroy(); } catch { /* already gone */ }
  disposePopupRecord(record);
}

async function confirmUnload(owner) {
  const result = await dialog.showMessageBox(owner && !owner.isDestroyed() ? owner : mainWindow, {
    type: 'warning', title: '网页请求保留当前内容',
    message: '网页提示仍有未保存的内容或正在进行的工作。',
    buttons: ['关闭网页', '继续保留'], defaultId: 1, cancelId: 1,
  });
  return result.response === 0;
}

async function requestPopupClose(record, { interactive = true, draftApproved = false } = {}) {
  if (!record || record.closed) return true;
  if (record.closeFlight) return record.closeFlight;
  record.closeFlight = (async () => {
    if (interactive && !draftApproved && !(await confirmCloseSiteDraft(record.activity))) return false;
    for (const child of [...popupRecordSet]) if (child.openerContentsId === record.pageContentsId) {
      if (!(await requestPopupClose(child, { interactive, draftApproved }))) return false;
    }
    const contents = record.pageView.webContents;
    if (!contents || contents.isDestroyed()) { closePopupRecord(record); return true; }
    const closed = await closePage(contents, { confirm: interactive ? () => confirmUnload(record.window) : null });
    if (closed) closePopupRecord(record);
    return closed;
  })();
  try { return await record.closeFlight; }
  finally { record.closeFlight = null; }
}

function createPopupWindow(options, entry, openerContents) {
  // Keep the native window independent; the adopted webContents retains its opener.
  const host = new BaseWindow({
    width: Number.isFinite(options?.width) ? Math.max(480, Math.min(1800, options.width)) : 1000,
    height: Number.isFinite(options?.height) ? Math.max(320, Math.min(1200, options.height)) : 740,
    minWidth: 480,
    minHeight: 320,
    title: 'Fixed Sites',
    icon: APP_ICON,
    backgroundColor: '#151C25',
    autoHideMenuBar: true,
    skipTaskbar: false,
    show: false,
  });
  const chromeView = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'popup', 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });
  if (!options?.webContents) throw new Error('Electron 没有提供可接入的新窗口 webContents。');
  const pageView = new WebContentsView({ webContents: options.webContents });
  chromeView.setVisible(true);
  pageView.setVisible(true);
  host.contentView.addChildView(chromeView);
  host.contentView.addChildView(pageView);
  const record = { window: host, chromeView, pageView, pageContentsId: pageView.webContents.id, chromeContentsId: chromeView.webContents.id,
    openerContentsId: openerContents?.id, entry, loading: true, error: null, closed: false, closing: false,
    activity: { view: pageView, primary: false, hasUserInput: false, mouseTouched: false, activityEpoch: 0 } };
  popupRecords.set(record.chromeContentsId, record);
  popupRecords.set(record.pageContentsId, record);
  popupRecordSet.add(record);
  popupWindows.add(host);
  if (entry) entry.popupCount += 1;
  applyWindowOpenPolicy(pageView.webContents, entry);
  installKeyboardShortcuts(pageView.webContents, record.activity, false);
  installKeyboardShortcuts(chromeView.webContents, null, false, pageView.webContents);
  installPageContextMenu(pageView.webContents, record.activity, false);
  installPageZoom(pageView.webContents);
  chromeView.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  chromeView.webContents.on('will-navigate', event => event.preventDefault());
  chromeView.webContents.on('will-redirect', event => event.preventDefault());
  pageView.webContents.on('did-start-loading', () => { record.loading = true; record.error = null; sendPopupState(record); });
  pageView.webContents.on('did-stop-loading', () => { record.loading = false; sendPopupState(record); });
  pageView.webContents.on('did-navigate', () => { record.activity.hasUserInput = false; record.activity.mouseTouched = false; sendPopupState(record); });
  pageView.webContents.on('did-redirect-navigation', () => sendPopupState(record));
  pageView.webContents.on('did-navigate-in-page', () => sendPopupState(record));
  pageView.webContents.on('page-title-updated', () => sendPopupState(record));
  pageView.webContents.on('render-process-gone', () => { record.loading = false; record.error = '网页进程已退出，刷新可恢复。'; sendPopupState(record); });
  pageView.webContents.on('enter-html-full-screen', () => {
    record.htmlFullScreen = true; host.setFullScreen(true); layoutPopup(record);
  });
  pageView.webContents.on('leave-html-full-screen', () => {
    record.htmlFullScreen = false; host.setFullScreen(Boolean(record.frameFullScreen)); layoutPopup(record);
  });
  pageView.webContents.on('did-fail-load', (_event, errorCode, _description, _validatedURL, isMainFrame) => {
    if (!isMainFrame || errorCode === -3) return;
    record.loading = false;
    record.error = LOAD_ERROR_TEXT;
    sendPopupState(record);
  });
  pageView.webContents.on('destroyed', () => { if (!record.closed && !record.closing) closePopupRecord(record); });
  chromeView.webContents.on('dom-ready', () => {
    if (record.closed || host.isDestroyed()) return;
    layoutPopup(record);
    if (!host.isDestroyed()) host.show();
    record.lastStateJson = null;
    sendPopupState(record);
    if (!pageView.webContents.isDestroyed()) pageView.webContents.focus();
  });
  for (const event of ['resize', 'resized', 'maximize', 'unmaximize', 'restore']) host.on(event, () => layoutPopup(record));
  host.on('app-command', (_event, command) => {
    // Chromium handles XButtons when the remote page owns focus. Handle the
    // native command only over the local toolbar to avoid navigating twice.
    if (pageView.webContents?.isFocused()) return;
    if (command === 'browser-backward') popupNavigation(record, 'back');
    else if (command === 'browser-forward') popupNavigation(record, 'forward');
  });
  host.on('close', event => {
    if (record.closing || record.closed) return;
    event.preventDefault();
    requestPopupClose(record).catch(() => {});
  });
  host.on('closed', () => {
    if (!record.closed && !record.closing) {
      record.closing = true;
      try { record.pageView.webContents.close({ waitForBeforeUnload: false }); } catch { /* already gone */ }
      try { record.chromeView.webContents.close({ waitForBeforeUnload: false }); } catch { /* already gone */ }
    }
    disposePopupRecord(record);
  });
  chromeView.webContents.loadFile(path.join(__dirname, 'popup', 'index.html')).catch(() => {});
  layoutPopup(record);
  return pageView.webContents;
}

function applyWindowOpenPolicy(webContents, entry) {
  downloadOwners.set(webContents.id, entry);
  const contentsId = webContents.id;
  webContents.once('destroyed', () => {
    downloadOwners.delete(contentsId);
    if (entry) {
      entry.unknownContents?.delete(contentsId);
      entry.captureContents?.delete(contentsId);
      entry.unknownTask = Boolean(entry.unknownContents?.size);
      entry.captureActive = Boolean(entry.captureContents?.size);
    }
    for (const [id, request] of activeRequests) if (request.contentsId === contentsId) {
      request.entry.activeRequests = Math.max(0, request.entry.activeRequests - 1);
      activeRequests.delete(id);
    }
  });
  webContents.setWindowOpenHandler(({ url }) => {
    let protocol = '';
    try {
      protocol = new URL(url).protocol;
    } catch {
      protocol = '';
    }
    if (!isAllowedEmbeddedNavigation(url)) {
      if (protocol) requestExternalProtocol(url, ownerWindowForContents(webContents));
      return { action: 'deny' };
    }
    return {
      action: 'allow',
      createWindow: (options) => createPopupWindow(options, entry, webContents),
      overrideBrowserWindowOptions: {
        icon: APP_ICON,
        autoHideMenuBar: true,
        // Native system frame; no application preload; Node.js disabled.
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true,
          partition: PARTITION,
          backgroundThrottling: true,
        },
      },
    };
  });
  webContents.on('will-navigate', (event, url) => {
    if (!isAllowedEmbeddedNavigation(url)) {
      event.preventDefault(); requestExternalProtocol(url, ownerWindowForContents(webContents));
    }
  });
  webContents.on('will-redirect', (event, url) => {
    if (!isAllowedEmbeddedNavigation(url)) {
      event.preventDefault(); requestExternalProtocol(url, ownerWindowForContents(webContents));
    }
  });
}

function configureDownloads() {
  const webSession = session.fromPartition(PARTITION);
  webSession.webRequest.onBeforeRequest((details, callback) => {
    const entry = downloadOwners.get(details.webContentsId);
    if (entry && !activeRequests.has(details.id)) {
      entry.activeRequests = (entry.activeRequests || 0) + 1;
      activeRequests.set(details.id, { entry, contentsId: details.webContentsId });
      if (details.resourceType === 'webSocket') { entry.unknownContents?.add(details.webContentsId); entry.unknownTask = true; }
      if (['POST', 'PUT', 'PATCH'].includes(details.method)) touchEntry(entry);
    }
    callback({});
  });
  const finished = details => {
    const request = activeRequests.get(details.id);
    if (!request) return;
    request.entry.activeRequests = Math.max(0, (request.entry.activeRequests || 0) - 1);
    activeRequests.delete(details.id);
  };
  webSession.webRequest.onCompleted(finished);
  webSession.webRequest.onErrorOccurred(finished);
  session.fromPartition(PARTITION).on('will-download', (_event, item, webContents) => {
    const entry = webContents ? downloadOwners.get(webContents.id) : null;
    if (entry) { entry.downloadCount += 1; touchEntry(entry); }
    // Leave Electron's native Save As flow intact, including Blob downloads.
    item.setSaveDialogOptions({ defaultPath: path.join(app.getPath('downloads'), item.getFilename()) });
    item.once('done', (_doneEvent, state) => {
      if (entry) entry.downloadCount -= 1;
      if (state === 'interrupted' && mainWindow && !mainWindow.isDestroyed()) {
        dialog.showMessageBox(mainWindow, { type: 'error', title: '下载未完成', message: item.getFilename() + ' 下载中断，请在网站中重试。' });
      }
    });
  });
}

function permissionOriginAllowed(webContents, requestingOrigin) {
  if (!webContents || webContents.isDestroyed()) return false;
  let requested;
  let current;
  try {
    requested = new URL(String(requestingOrigin || ''));
    current = new URL(safeCurrentUrl(webContents));
  } catch { return false; }
  return downloadOwners.has(webContents.id) && ['http:', 'https:'].includes(requested.protocol) &&
    ['http:', 'https:'].includes(current.protocol) && requested.origin === current.origin;
}

function configureSessionSecurity() {
  const persistedSession = session.fromPartition(PARTITION);
  const granted = new Set();
  const pending = new Map();
  const automatic = new Set(['fullscreen', 'clipboard-sanitized-write', 'pointerLock', 'mediaKeySystem']);
  const labels = { media: '摄像头或麦克风', notifications: '通知', geolocation: '位置信息',
    'clipboard-read': '读取剪贴板', 'display-capture': '屏幕共享', 'local-network': '本地网络',
    'local-network-access': '本地网络', 'speaker-selection': '选择音频输出' };
  const key = (permission, origin) => `${new URL(origin).origin}:${permission}`;
  persistedSession.setPermissionCheckHandler((webContents, permission, requestingOrigin) => {
    if (!permissionOriginAllowed(webContents, requestingOrigin)) return false;
    if (granted.has(key(permission, requestingOrigin)) && ['media', 'display-capture'].includes(permission)) {
      const entry = downloadOwners.get(webContents.id);
      if (entry) { entry.captureContents?.add(webContents.id); entry.captureActive = true; }
    }
    return automatic.has(permission) || granted.has(key(permission, requestingOrigin));
  });
  persistedSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const origin = details?.requestingOrigin || safeCurrentUrl(webContents);
    if (!permissionOriginAllowed(webContents, origin)) return callback(false);
    if (automatic.has(permission)) return callback(true);
    if (!labels[permission]) return callback(false);
    const grantKey = key(permission, origin);
    if (granted.has(grantKey)) return callback(true);
    if (!pending.has(grantKey)) {
      const owner = ownerWindowForContents(webContents) || mainWindow;
      pending.set(grantKey, dialog.showMessageBox(owner, { type: 'question', title: '网页权限',
        message: `允许此网站使用${labels[permission]}？`, detail: new URL(origin).origin,
        buttons: ['允许本次运行', '拒绝'], defaultId: 1, cancelId: 1,
      }).then(({ response }) => response === 0).catch(() => false).finally(() => pending.delete(grantKey)));
    }
    pending.get(grantKey).then(allowed => {
      const valid = allowed && permissionOriginAllowed(webContents, origin);
      if (valid) {
        granted.add(grantKey);
        const entry = downloadOwners.get(webContents.id);
        if (entry && ['media', 'display-capture'].includes(permission)) { entry.captureContents?.add(webContents.id); entry.captureActive = true; touchEntry(entry); }
      }
      callback(valid);
    });
  });
}

function createSiteView(site) {
  const view = new WebContentsView({
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      partition: PARTITION,
      backgroundThrottling: true,
    },
  });
  view.setBackgroundColor('#f4f1ea');
  view.setVisible(false);

  const webContents = view.webContents;
  const entry = {
    view,
    faviconUrl: null,
    loading: false,
    error: null,
    errorUrl: null,
    started: false,
    readyToShow: false,
    crashed: false,
    lastUsedAt: Date.now(),
    hasUserInput: false,
    mouseTouched: false,
    primary: true,
    activityEpoch: 0,
    activeRequests: 0,
    captureActive: false,
    unknownTask: false,
    unknownContents: new Set(),
    captureContents: new Set(),
    closing: false,
    mediaActive: false,
    unresponsive: false,
    switchStartedAt: null,
    switchSequence: 0,
    popupCount: 0,
    downloadCount: 0,
  };
  views.set(site.id, entry);

  applyWindowOpenPolicy(webContents, entry);
  installKeyboardShortcuts(webContents, entry, true);
  installPageContextMenu(webContents, entry, true);
  installPageZoom(webContents);

  const isActive = () => canvas.panes.some(p => p.kind === 'web' && p.id === site.id) && views.get(site.id) === entry;
  webContents.on('focus', () => {
    const pane = canvas.panes.find(p => p.kind === 'web' && p.id === site.id);
    if (pane) focusCanvasPane(pane.key, false);
  });
  const showDocument = () => {
    entry.readyToShow = true;
    if (isActive() && section === 'my') {
      const changed = presentedView !== entry;
      attachView(entry);
      if (changed && entry.switchStartedAt) {
        emitMetric('view-attached', { sequence: entry.switchSequence, ms: Number(process.hrtime.bigint() - entry.switchStartedAt) / 1e6 });
        entry.switchStartedAt = null;
      }
      // A late load must not steal focus while the user types in the Sidebar.
      if (changed && activeSiteId === site.id && workspace === 'web' && mainWindow.isFocused() && !mainWindow.webContents.isFocused()) entry.view.webContents.focus();
    }
  };
  webContents.on('dom-ready', showDocument);
  webContents.on('render-process-gone', () => {
    entry.crashed = true; entry.started = false; entry.loading = false;
    entry.readyToShow = false;
    entry.error = '网页进程已退出，点击网站或刷新恢复。';
    if (isAttached(entry)) detachView(entry, { touch: false });
    if (isActive()) sendState();
  });
  webContents.on('unresponsive', () => {
    entry.unresponsive = true;
    entry.error = '网页暂时没有响应。';
    if (isActive()) sendState();
  });
  webContents.on('responsive', () => {
    entry.unresponsive = false;
    if (entry.error === '网页暂时没有响应。') entry.error = null;
    if (isActive()) sendState();
  });
  webContents.on('media-started-playing', () => { entry.mediaActive = true; touchEntry(entry); });
  webContents.on('media-paused', () => { entry.mediaActive = false; touchEntry(entry); });
  webContents.on('destroyed', () => {
    if (views.get(site.id) === entry) {
      views.delete(site.id);
      if (presentedView === entry) presentedView = null;
      if (activeSiteId === site.id) sendState();
    }
  });

  webContents.on('did-start-loading', () => {
    touchEntry(entry);
    entry.crashed = false;
    entry.unresponsive = false;
    entry.started = true;
    entry.loading = true;
    entry.error = null;
    entry.errorUrl = null;
    if (isActive()) sendState();
  });

  webContents.on('did-stop-loading', () => {
    entry.loading = false;
    if (entry.switchStartedAt) emitMetric('site-load-stop', { sequence: entry.switchSequence, ms: Number(process.hrtime.bigint() - entry.switchStartedAt) / 1e6 });
    if (isActive()) sendState();
  });

  webContents.on('did-navigate', () => {
    touchEntry(entry);
    entry.captureContents.delete(webContents.id);
    entry.unknownContents.delete(webContents.id);
    entry.captureActive = entry.captureContents.size > 0;
    entry.unknownTask = entry.unknownContents.size > 0;
    entry.mediaActive = false;
    entry.hasUserInput = false;
    entry.mouseTouched = false;
    if (isActive()) sendState();
  });

  webContents.on('did-navigate-in-page', () => {
    touchEntry(entry);
    if (isActive()) sendState();
  });

  webContents.on(
    'did-fail-load',
    (event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (!isMainFrame) return;
      if (errorCode === -3) return; // ERR_ABORTED
      entry.loading = false;
      entry.error = LOAD_ERROR_TEXT;
      entry.errorUrl = validatedURL || null;
      entry.readyToShow = false;
      if (isAttached(entry)) detachView(entry, { touch: false });
      if (isActive()) sendState();
    }
  );

  webContents.on('page-favicon-updated', (event, favicons) => {
    const found = Array.isArray(favicons) ? favicons.find((url) => isHttpUrl(url)) : null;
    entry.faviconUrl = found || null;
    if (found && found !== site.faviconUrl) {
      site.faviconUrl = found;
      scheduleConfigSave();
    }
    if (isActive() || found !== null) sendState();
  });

  return entry;
}

async function releaseSiteView(siteId, { interactive = false, canClose = () => true } = {}) {
  const entry = views.get(siteId);
  if (!entry) return true;
  if (interactive && !(await confirmCloseSiteDraft(entry))) return false;
  if (!canClose()) return false;
  for (const record of [...popupRecordSet]) if (record.entry === entry) {
    if (!(await requestPopupClose(record, { interactive }))) return false;
  }
  if (!canClose()) return false;
  const closed = await closePage(entry.view.webContents, {
    canClose,
    confirm: interactive ? () => confirmUnload(mainWindow) : null,
  });
  if (!closed) return false;
  if (views.get(siteId) === entry) views.delete(siteId);
  if (presentedView === entry) presentedView = null;
  if (isAttached(entry)) mainWindow.contentView.removeChildView(entry.view);
  return true;
}

function startLoad(entry, site) {
  entry.crashed = false;
  entry.started = true;
  entry.loading = true;
  entry.error = null;
  entry.errorUrl = null;
  entry.readyToShow = false;
  // Not awaited: the caller returns to the UI immediately, loading continues via events.
  entry.view.webContents.loadURL(site.url).catch(() => {
    /* surfaced through did-fail-load */
  });
}

// Switches the visible site view. Previously created views keep their WebContents.
function activateSite(siteId) {
  const site = sites.find((item) => item.id === siteId);
  if (!site) return;

  placeCanvasContent('web', siteId);
  section = 'my';
  activeSiteId = siteId;

  let entry = views.get(siteId);
  if (!entry) {
    entry = createSiteView(site);
    entry.switchSequence = ++metricSequence;
    entry.switchStartedAt = process.hrtime.bigint();
    emitMetric('site-feedback', { sequence: entry.switchSequence });
    startLoad(entry, site);
    attachView(entry);
  } else {
    touchEntry(entry);
    entry.switchSequence = ++metricSequence;
    entry.switchStartedAt = process.hrtime.bigint();
    emitMetric('site-feedback', { sequence: entry.switchSequence });
    if (entry.crashed || !entry.started) startLoad(entry, site);
    attachView(entry);
  }

  if (presentedView === entry && entry.switchStartedAt) {
    emitMetric('view-attached', { sequence: entry.switchSequence, ms: Number(process.hrtime.bigint() - entry.switchStartedAt) / 1e6 });
    entry.switchStartedAt = null;
  }

  try {
    if (presentedView === entry) entry.view.webContents.focus();
  } catch {
    /* not focusable yet */
  }
  if (views.size > RECENT_VIEW_COUNT && (!lastResourceSample || Date.now() - lastResourceSample.at > 60000))
    setImmediate(() => retireIdleViews().catch(() => {}));
  layoutActiveView();
}

// ------------------------------------------------------------------ actions --

async function addSite(payload) {
  const name = normalizeName(payload && payload.name);
  if (!name) return { ok: false, error: '请输入网站名称。' };
  const urlCheck = normalizeUrl(payload && payload.url);
  if (!urlCheck.ok) return { ok: false, error: urlCheck.error };

  const existing = sites.find((item) => item.url === urlCheck.url);
  if (existing) {
    const result = payload.activate === false ? { ok: true } : selectSite(existing.id);
    return { ...result, alreadyAdded: true, siteId: existing.id };
  }

  const site = { id: crypto.randomUUID(), name, url: urlCheck.url };
  sites.push(site);

  // Activate before saving: activateSite sets activeSiteId and detaches the
  // previous view, so the persisted activeSiteId matches what the UI shows.
  const previousActive = activeSiteId;
  const shouldActivate = payload.activate !== false;
  if (shouldActivate) activateSite(site.id);
  try {
    await saveConfig();
  } catch (err) {
    sites.pop();
    if (activeSiteId === site.id) activeSiteId = previousActive;
    discardRolledBackConfig();
    await releaseSiteView(site.id);
    if (activeSiteId === previousActive && previousActive && shouldActivate) activateSite(previousActive);
    sendState();
    return { ok: false, error: errorMessage(err) };
  }
  sendState();
  return { ok: true, siteId: site.id };
}

async function updateSite(payload) {
  const id = payload && payload.id;
  const site = sites.find((item) => item.id === id);
  if (!site) return { ok: false, error: '网站不存在。' };

  const name = normalizeName(payload && payload.name);
  if (!name) return { ok: false, error: '请输入网站名称。' };
  const urlCheck = normalizeUrl(payload && payload.url);
  if (!urlCheck.ok) return { ok: false, error: urlCheck.error };

  const previousName = site.name;
  const previousUrl = site.url;
  const urlChanged = previousUrl !== urlCheck.url;

  if (urlChanged && views.has(id) && !(await releaseSiteView(id, { interactive: true }))) {
    return { ok: false, error: '已取消关闭网页，未修改网站。' };
  }

  site.name = name;
  site.url = urlCheck.url;
  try {
    await saveConfig();
  } catch (err) {
    site.name = previousName;
    site.url = previousUrl;
    discardRolledBackConfig();
    if (urlChanged && activeSiteId === id && !views.has(id)) activateSite(id);
    sendState();
    return { ok: false, error: errorMessage(err) };
  }

  if (urlChanged) {
    const wasActive = activeSiteId === id;
    if (wasActive) {
      const entry = createSiteView(site);
      startLoad(entry, site);
      attachView(entry);
      try {
        entry.view.webContents.focus();
      } catch {
        /* not focusable yet */
      }
    }
  }

  sendState();
  return { ok: true };
}

async function deleteSite(id) {
  const index = sites.findIndex((item) => item.id === id);
  if (index === -1) return { ok: false, error: '网站不存在。' };

  const previousActive = activeSiteId;
  const wasActive = activeSiteId === id;
  if (views.has(id) && !(await releaseSiteView(id, { interactive: true }))) {
    return { ok: false, error: '已取消删除，网页内容仍保留。' };
  }
  const removed = sites.splice(index, 1)[0];
  if (wasActive) {
    const next = sites[index] || sites[index - 1] || null;
    activeSiteId = next ? next.id : null;
  }
  try {
    await saveConfig();
  } catch (err) {
    sites.splice(index, 0, removed);
    activeSiteId = previousActive;
    discardRolledBackConfig();
    if (wasActive && activeSiteId && !views.has(activeSiteId)) activateSite(activeSiteId);
    sendState();
    return { ok: false, error: errorMessage(err) };
  }

  if (removed.coverFile) retiredCovers.add(removed.coverFile);

  if (wasActive && activeSiteId && section === 'my') activateSite(activeSiteId);

  sendState();
  return { ok: true };
}

async function reorderSites(ids) {
  if (!Array.isArray(ids)) return { ok: false, error: '顺序无效。' };

  const byId = new Map(sites.map((site) => [site.id, site]));
  const next = [];
  for (const id of ids) {
    const site = byId.get(id);
    if (site) {
      next.push(site);
      byId.delete(id);
    }
  }
  for (const site of byId.values()) next.push(site);

  const previous = sites;
  sites = next;
  try {
    await saveConfig();
  } catch (err) {
    sites = previous;
    discardRolledBackConfig();
    return { ok: false, error: errorMessage(err) };
  }

  sendState();
  return { ok: true };
}

function selectSite(id) {
  const site = sites.find((item) => item.id === id);
  if (!site) return { ok: false, error: '网站不存在。' };
  // Repeat click on the current site: leave the page exactly as it is.
  if (activeSiteId === id && views.has(id) && !views.get(id).crashed && section === 'my' &&
      canvas.panes.some(p => p.kind === 'web' && p.id === id) && canvas.panes.find(p => p.key === canvas.activeKey)?.kind !== 'empty') {
    views.get(id).view.webContents.focus();
    return { ok: true };
  }

  activateSite(id);
  scheduleConfigSave();

  sendState();
  return { ok: true };
}

function withActiveContents(fn) {
  const entry = activeSiteId ? views.get(activeSiteId) : null;
  if (!entry) return { ok: false, error: '当前没有选中网站。' };
  fn(entry.view.webContents);
  sendState();
  return { ok: true };
}

function navigate(action) {
  return withActiveContents((webContents) => {
    try {
      const history = webContents.navigationHistory;
      if (action === 'back' && history.canGoBack()) {
        history.goBack();
      } else if (action === 'forward' && history.canGoForward()) {
        history.goForward();
      }
    } catch {
      /* navigation target gone */
    }
  });
}

function reloadActive() {
  const entry = views.get(activeSiteId);
  const site = sites.find(item => item.id === activeSiteId);
  if (entry?.crashed || entry?.error) {
    if (entry && site) { startLoad(entry, { ...site, url: entry.errorUrl && isHttpUrl(entry.errorUrl) ? entry.errorUrl : safeCurrentUrl(entry.view.webContents) || site.url }); attachView(entry); sendState(); return { ok: true }; }
  }
  return withActiveContents((webContents) => {
    try {
      webContents.reload();
    } catch {
      /* nothing to reload */
    }
  });
}

async function openActiveExternally() {
  const site = sites.find((item) => item.id === activeSiteId);
  const entry = activeSiteId ? views.get(activeSiteId) : null;
  if (!site || !entry) return { ok: false, error: '当前没有选中网站。' };

  // Failed main-frame URL wins; otherwise the live URL; finally the saved entry URL.
  let target = entry.error && entry.errorUrl ? entry.errorUrl : safeCurrentUrl(entry.view.webContents);
  if (!isHttpUrl(target)) target = site.url;
  if (!isSafeExternalHttpUrl(target)) return { ok: false, error: '当前地址不是可安全打开的 HTTP/HTTPS 地址。' };

  await shell.openExternal(target);
  return { ok: true };
}

function showSiteMenu(id) {
  const site = sites.find((item) => item.id === id);
  if (!site) return { ok: false, error: '网站不存在。' };

  const menu = Menu.buildFromTemplate([
    {
      label: '修改网站',
      click: () => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('fixed-sites:edit-requested', id);
        }
      },
    },
    {
      label: '选择封面图片…',
      click: () => configAction(() => runSiteEdit('更换网站封面', () => chooseSiteCover(id))).catch((err) => dialog.showErrorBox('Fixed Sites', errorMessage(err))),
    },
    {
      label: '恢复网站图标',
      enabled: Boolean(site.coverFile),
      click: () => configAction(() => runSiteEdit('恢复网站图标', () => clearSiteCover(id))).catch((err) => dialog.showErrorBox('Fixed Sites', errorMessage(err))),
    },
    {
      label: '删除网站',
      click: () => {
        configAction(() => runSiteEdit('删除网站', () => deleteSite(id))).catch((err) => dialog.showErrorBox('Fixed Sites', '删除失败：\n' + errorMessage(err)));
      },
    },
  ]);
  menu.popup({ window: mainWindow });
  return { ok: true };
}

// --------------------------------------------------------------------- ipc ---

async function chooseSiteCover(id) {
  const site = sites.find((item) => item.id === id);
  if (!site) return { ok: false, error: '网站不存在。' };
  const result = await dialog.showOpenDialog(mainWindow, {
    title: `为 ${site.name} 选择封面图片`,
    properties: ['openFile'],
    filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }],
  });
  if (result.canceled) return { ok: true, cancelled: true };
  const source = result.filePaths[0];
  const file = `${crypto.randomUUID()}${path.extname(source).toLowerCase()}`;
  await fs.promises.mkdir(COVERS_DIR, { recursive: true });
  await fs.promises.copyFile(source, path.join(COVERS_DIR, file));
  const previous = site.coverFile;
  site.coverFile = file;
  try { await saveConfig(); } catch (err) {
    site.coverFile = previous;
    discardRolledBackConfig();
    await fs.promises.rm(path.join(COVERS_DIR, file), { force: true });
    throw err;
  }
  sendState();
  if (previous) retiredCovers.add(previous);
  return { ok: true };
}

async function clearSiteCover(id) {
  const site = sites.find((item) => item.id === id);
  if (!site) return { ok: false, error: '网站不存在。' };
  const previous = site.coverFile;
  delete site.coverFile;
  try { await saveConfig(); } catch (err) { site.coverFile = previous; discardRolledBackConfig(); throw err; }
  sendState();
  if (previous) retiredCovers.add(previous);
  return { ok: true };
}

function isTrustedSender(event) {
  if (closingAgents) return false;
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  if (event.sender !== mainWindow.webContents) return false;
  const frame = event.senderFrame;
  if (!frame) return false;
  return frame === mainWindow.webContents.mainFrame;
}

function handle(channel, handler) {
  ipcMain.handle(channel, async (event, ...args) => {
    if (!isTrustedSender(event)) {
      return { ok: false, error: '请求来源无效。' };
    }
    try {
      return await handler(...args);
    } catch (err) {
      return { ok: false, error: errorMessage(err) };
    }
  });
}

function registerIpc() {
  const pickerHandle = (channel, action) => ipcMain.handle(channel, async (event, ...args) => {
    if (!agentPicker || agentPicker.isDestroyed() || event.sender !== agentPicker.webContents || event.senderFrame !== agentPicker.webContents.mainFrame)
      return { ok: false, error: '窗口选择器来源无效。' };
    try { return await action(...args); } catch (error) { return { ok: false, error: errorMessage(error) }; }
  });
  const popupHandle = (channel, action) => ipcMain.handle(channel, async (event, ...args) => {
    const record = popupRecords.get(event.sender.id);
    if (!record || record.closed || event.sender !== record.chromeView.webContents || event.senderFrame !== record.chromeView.webContents.mainFrame)
      return { ok: false, error: '网页窗口来源无效。' };
    try { return await action(record, ...args); } catch (error) { return { ok: false, error: errorMessage(error) }; }
  });
  popupHandle('fixed-sites:popup-get-state', (record) => popupState(record));
  popupHandle('fixed-sites:popup-navigate', (record, action) => popupNavigation(record, action));
  popupHandle('fixed-sites:popup-copy-url', (record) => popupCopyUrl(record));
  popupHandle('fixed-sites:popup-open-external', (record) => popupOpenExternal(record));
  pickerHandle('fixed-sites:agent-windows', () => agentWindowPreviews());
  pickerHandle('fixed-sites:choose-agent-window', async (reference) => {
    const candidate = pickerCandidates.get(reference.hwnd);
    if (!candidate || candidate.pid !== reference.pid || candidate.startTicks !== reference.startTicks || !candidate.eligible)
      return { ok: false, error: '候选窗口已更新或不可接入，请刷新后重选。' };
    const window = agentPicker;
    const agent = pickerAgentId;
    pickerConnecting = true;
    let result;
    try { result = await setWorkspace('agents', agent, candidate); }
    finally { pickerConnecting = false; }
    if (result.ok && !result.cancelled && !window.isDestroyed()) {
      const closed = new Promise((resolve) => window.once('closed', resolve));
      window.close();
      await closed;
      // Closing the chooser reactivates Electron's renderer. Commit the native
      // pane's layout/z-order once after that transition, not via a focus loop.
      if (workspace === 'agents' && activeAgentId === agent && !closingAgents)
        result = await manageAgentWindow(agent, 'sync');
    }
    return { ...result, current: agentHost.observedAgents.find((item) => item.id === agent) };
  });
  pickerHandle('fixed-sites:manage-agent-window', (action) => {
    if (!['sync', 'detach', 'show'].includes(action)) return { ok: false, error: '未知窗口操作。' };
    return manageAgentWindow(pickerAgentId, action);
  });
  pickerHandle('fixed-sites:close-agent-picker', () => { agentPicker.close(); return { ok: true }; });
  ipcMain.on('fixed-sites:sidebar-frame', (event, width) => {
    if (!isTrustedSender(event)) return;
    pendingSidebarWidth = Math.round(Math.min(SIDEBAR_WIDTH, Math.max(COLLAPSED_SIDEBAR_WIDTH, Number(width) || SIDEBAR_WIDTH)));
    if (sidebarFrameTimer) return;
    sidebarFrameTimer = setImmediate(() => {
      sidebarFrameTimer = null;
      if (pendingSidebarWidth == null || closingAgents) return;
      sidebarWidth = pendingSidebarWidth;
      pendingSidebarWidth = null;
      layoutActiveView();
    });
  });
  ipcMain.handle('fixed-sites:get-state', (event) => {
    if (!isTrustedSender(event)) return null;
    return getState();
  });

  handle('fixed-sites:add-site', payload => configAction(() => runSiteEdit('添加网站', () => addSite(payload))));
  handle('fixed-sites:update-site', payload => configAction(() => runSiteEdit('修改网站', () => updateSite(payload))));
  handle('fixed-sites:delete-site', id => configAction(() => runSiteEdit('删除网站', () => deleteSite(id))));
  handle('fixed-sites:reorder-sites', ids => configAction(() => runSiteEdit('调整网站顺序', () => reorderSites(ids))));
  handle('fixed-sites:select-site', id => selectSite(id));
  handle('fixed-sites:show-site-menu', (id) => showSiteMenu(id));
  handle('fixed-sites:choose-site-cover', id => configAction(() => runSiteEdit('更换网站封面', () => chooseSiteCover(id))));
  handle('fixed-sites:clear-site-cover', id => configAction(() => runSiteEdit('恢复网站图标', () => clearSiteCover(id))));
  handle('fixed-sites:go-back', () => navigate('back'));
  handle('fixed-sites:go-forward', () => navigate('forward'));
  handle('fixed-sites:reload', () => reloadActive());
  handle('fixed-sites:open-external', () => openActiveExternally());
  handle('fixed-sites:set-section', (next) => setSection(next));
  handle('fixed-sites:set-workspace', (next) => setWorkspace(next));
  handle('fixed-sites:select-agent', (id, window) => setWorkspace('agents', id, window));
  handle('fixed-sites:start-agent', (id) => setWorkspace('agents', id, null, true));
  handle('fixed-sites:open-agent-picker', (id) => openAgentPicker(id || activeAgentId));
  handle('fixed-sites:detach-agent', () => manageAgentWindow(activeAgentId, 'show'));
  handle('fixed-sites:set-sidebar-collapsed', (value) => setSidebarCollapsed(value));
  handle('fixed-sites:toggle-sidebar', () => setSidebarCollapsed());
  handle('fixed-sites:toggle-agent-sidebar', () => {
    agentSidebarCollapsed = !agentSidebarCollapsed; layoutActiveView(); scheduleConfigSave(); sendState(); return { ok: true };
  });
  handle('fixed-sites:canvas-action', (action, value) => canvasAction(action, value));
  handle('fixed-sites:canvas-resize', (phase, ratio) => resizeCanvas(phase, ratio));
  handle('fixed-sites:undo', () => configAction(undoLastOperation));
  handle('fixed-sites:save-snapshot', () => configAction(saveManualSnapshot));
  handle('fixed-sites:restore-snapshot', () => configAction(restoreManualSnapshot));
  handle('fixed-sites:window-menu', () => { buildTrayMenu().popup({ window: mainWindow }); return { ok: true }; });
  handle('fixed-sites:set-immersive', (value) => setImmersive(value));
}

// ------------------------------------------------------------------ window ---

function restoreSelection() {
  if (!sites.length) {
    activeSiteId = null;
    return;
  }
  let target = sites.find((site) => site.id === activeSiteId);
  if (!target) {
    target = sites[0];
    activeSiteId = target.id;
    scheduleConfigSave();
  }
  activateSite(target.id);
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  layoutActiveView();
  mainWindow.focus();
  if (tray) tray.setToolTip('Fixed Sites · 正在显示');
}

function hideMainWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.hide();
  if (tray) tray.setToolTip('Fixed Sites · 后台运行，单击恢复');
}

function quitFromTray() {
  if (mainWindow && !mainWindow.isDestroyed()) requestExit();
  else app.quit();
}

async function confirmExitDrafts() {
  const entries = [...views.values(), ...[...popupRecordSet].map(record => record.activity)];
  let uncertain = 0;
  for (const entry of entries) if (entry.view.webContents && !entry.view.webContents.isDestroyed() && await hasUnsavedDraft(entry)) uncertain++;
  if (!uncertain) return true;
  const result = await dialog.showMessageBox(mainWindow, {
    type: 'warning', title: '退出 Fixed Sites？',
    message: `${uncertain} 个网页可能有未提交内容，或无法确认能否安全关闭。`,
    detail: '退出会关闭网页。Agent 窗口会恢复为独立窗口，进程和任务继续运行。',
    buttons: ['继续退出', '保留程序'], defaultId: 1, cancelId: 1,
  });
  return result.response === 0;
}

function requestExit() {
  if (exitFlight) return exitFlight;
  quitting = true;
  closingAgents = true;
  ++workspaceRequest;
  exitFlight = (async () => {
    try {
      await configOperations;
      if (!(await confirmExitDrafts())) return false;
      await flushConfigSave();
      // Restore foreign windows before destroying their native parent. If this
      // fails the host remains alive and none of the pages have been closed.
      if (agentHost && (agentHost.process || agentHost.hasRecovery)) {
        await agentHost.cancelWait();
        await agentHost.exit();
        agentsRestored = true;
      }
      for (const record of [...popupRecordSet]) if (!(await requestPopupClose(record, { draftApproved: true }))) return false;
      for (const [id, entry] of [...views]) {
        if (!(await closePage(entry.view.webContents, { confirm: () => confirmUnload(mainWindow) }))) return false;
        if (views.get(id) === entry) views.delete(id);
      }
      await flushConfigSave();
      agentHost?.stopObserving();
      exitApproved = true;
      mainWindow?.close();
      return true;
    } catch {
      if (mainWindow && !mainWindow.isDestroyed()) {
        showMainWindow();
        await dialog.showMessageBox(mainWindow, { type: 'error', title: '尚未退出 Fixed Sites',
          message: '保存配置或恢复 Agent 窗口尚未完成，程序已保留。',
          detail: '请检查磁盘与 Agent 响应后重试退出。', buttons: ['保留程序'], noLink: true });
      }
      return false;
    } finally {
      if (!exitApproved) {
        closingAgents = false;
        quitting = false;
        if (agentHost && !agentHost.process) { agentHost.stopping = false; agentHost.ready = null; }
        showMainWindow();
        if (section === 'my' && workspace === 'web' && !views.has(activeSiteId)) restoreSelection();
        sendState();
      }
      exitFlight = null;
    }
  })();
  return exitFlight;
}

function buildTrayMenu() {
  return Menu.buildFromTemplate([
    { label: '显示 Fixed Sites', click: showMainWindow },
    { label: '隐藏主窗口', enabled: Boolean(mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()), click: hideMainWindow },
    { type: 'separator' },
    { label: '关闭时最小化到托盘', type: 'checkbox', checked: closeToTray, enabled: Boolean(tray), click: (item) => { closeToTray = item.checked; scheduleConfigSave(); sendState(); } },
    { type: 'separator' },
    { label: '退出程序', click: quitFromTray },
  ]);
}

function createTray() {
  if (tray) return;
  try {
    tray = new Tray(APP_ICON);
    tray.setToolTip('Fixed Sites');
    tray.on('click', showMainWindow);
    tray.on('right-click', () => tray?.popUpContextMenu(buildTrayMenu()));
  } catch (err) {
    tray = null;
    console.warn('创建系统托盘失败：', errorMessage(err));
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 800,
    minHeight: 560,
    title: 'Fixed Sites',
    icon: APP_ICON,
    backgroundColor: '#151C25',
    autoHideMenuBar: true,
    skipTaskbar: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });

  mainWindow.setMenuBarVisibility(false);
  mainWindow.removeMenu();
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', event => event.preventDefault());
  mainWindow.webContents.on('will-redirect', event => event.preventDefault());
  createTray();
  agentHost = new AgentHost(app.isPackaged ? path.join(process.resourcesPath, 'native', 'AgentBridge.exe') :
    path.join(__dirname, 'native', 'bin', 'AgentBridge-1.0.1.exe'), mainWindow, sendState, (shortcut) => {
    const pane = canvas.panes.find(p => p.kind === 'agent');
    if (pane) focusCanvasPane(pane.key, false);
    if (shortcut === 'focus-agent') return;
    const action = shortcut === 'sidebar' ? setSidebarCollapsed() :
      setImmersive(shortcut === 'leave-immersive' ? false : undefined);
    action.catch(reportAgentError);
  }, path.join(app.getPath('userData'), 'agents.json'));
  if (!(process.env.FIXED_SITES_TEST_APP_DATA && process.env.FIXED_SITES_TEST_OBSERVER === 'off')) agentHost.observe();
  installKeyboardShortcuts(mainWindow.webContents, null, true);
  mainWindow.on('app-command', (_event, command) => {
    if (workspace !== 'web' || section !== 'my' || views.get(activeSiteId)?.view.webContents.isFocused()) return;
    if (command === 'browser-backward') navigate('back');
    else if (command === 'browser-forward') navigate('forward');
  });
  mainWindow.on('focus', () => {
    if (workspace === 'agents' && !closingAgents) agentHost.focus().catch(reportAgentError);
  });

  for (const event of [
    'resize',
    'resized',
    'maximize',
    'unmaximize',
    'restore',
    'enter-full-screen',
    'leave-full-screen',
  ]) {
    mainWindow.on(event, layoutActiveView);
  }

  mainWindow.on('close', (event) => {
    if (exitApproved) return;
    if (closeToTray && tray && !quitting) {
      event.preventDefault();
      hideMainWindow();
      return;
    }
    event.preventDefault();
    requestExit();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
    shutdownAll();
    app.quit();
  });

  restoreSelection();
  housekeepingTimer = setInterval(() => retireIdleViews().catch(() => {}), 60 * 1000);
  housekeepingTimer.unref();

  mainWindow.webContents.setZoomFactor(1);
  mainWindow.loadFile(path.join(__dirname, 'ui-dist', 'index.html'));

  mainWindow.webContents.once('did-finish-load', () => {
    uiReady = true;
    sendState();
  });

  mainWindow.once('ready-to-show', () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.show();
  });
}

function shutdownAll() {
  if (shutdownDone) return;
  shutdownDone = true;
  clearInterval(housekeepingTimer);
  if (sidebarFrameTimer) { clearImmediate(sidebarFrameTimer); sidebarFrameTimer = null; }
  agentHost?.stopObserving();

  for (const record of [...popupRecordSet]) closePopupRecord(record);
  for (const win of popupWindows) { try { win.destroy(); } catch { /* already gone */ } }
  popupWindows.clear();
  popupRecordSet.clear();
  popupRecords.clear();
  if (tray) { try { tray.destroy(); } catch { /* already gone */ } tray = null; }

  for (const entry of views.values()) {
    try {
      entry.view.webContents.close({ waitForBeforeUnload: false });
    } catch {
      /* already gone */
    }
  }
  views.clear();
  activeSiteId = null;
}

// -------------------------------------------------------------------- boot ---

app.on('window-all-closed', () => {
  shutdownAll();
  app.quit();
});

app.on('will-quit', shutdownAll);
app.on('before-quit', (event) => {
  if (mainWindow && !mainWindow.isDestroyed() && !exitApproved) {
    event.preventDefault();
    requestExit();
  }
});

const singleInstance = app.requestSingleInstanceLock();
if (!singleInstance) {
  app.quit();
} else {
  app.on('second-instance', () => {
    showMainWindow();
  });
  app.whenReady().then(() => {
    if (process.platform === 'win32') app.setAppUserModelId('local.fixedsites.browser');
    Menu.setApplicationMenu(null);
    loadConfig();
    loadManualSnapshot();
    registerIpc();
    configureDownloads();
    configureSessionSecurity();
    createWindow();
  });
}
