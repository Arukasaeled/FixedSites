'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const STATE_CHANNEL = 'fixed-sites:state-changed';
const EDIT_CHANNEL = 'fixed-sites:edit-requested';

contextBridge.exposeInMainWorld('fixedSites', {
  getState: () => ipcRenderer.invoke('fixed-sites:get-state'),
  addSite: (payload) => ipcRenderer.invoke('fixed-sites:add-site', payload),
  updateSite: (payload) => ipcRenderer.invoke('fixed-sites:update-site', payload),
  deleteSite: (id) => ipcRenderer.invoke('fixed-sites:delete-site', id),
  reorderSites: (ids) => ipcRenderer.invoke('fixed-sites:reorder-sites', ids),
  selectSite: (id) => ipcRenderer.invoke('fixed-sites:select-site', id),
  showSiteMenu: (id) => ipcRenderer.invoke('fixed-sites:show-site-menu', id),
  chooseSiteCover: (id) => ipcRenderer.invoke('fixed-sites:choose-site-cover', id),
  clearSiteCover: (id) => ipcRenderer.invoke('fixed-sites:clear-site-cover', id),
  goBack: () => ipcRenderer.invoke('fixed-sites:go-back'),
  goForward: () => ipcRenderer.invoke('fixed-sites:go-forward'),
  reload: () => ipcRenderer.invoke('fixed-sites:reload'),
  openExternal: () => ipcRenderer.invoke('fixed-sites:open-external'),
  showWindowMenu: () => ipcRenderer.invoke('fixed-sites:window-menu'),
  setSection: (section) => ipcRenderer.invoke('fixed-sites:set-section', section),
  setWorkspace: (workspace) => ipcRenderer.invoke('fixed-sites:set-workspace', workspace),
  selectAgent: (id, window) => ipcRenderer.invoke('fixed-sites:select-agent', id, window),
  startAgent: (id) => ipcRenderer.invoke('fixed-sites:start-agent', id),
  detachAgent: () => ipcRenderer.invoke('fixed-sites:detach-agent'),
  openAgentPicker: (id) => ipcRenderer.invoke('fixed-sites:open-agent-picker', id),
  getAgentWindows: () => ipcRenderer.invoke('fixed-sites:agent-windows'),
  chooseAgentWindow: (reference) => ipcRenderer.invoke('fixed-sites:choose-agent-window', reference),
  manageAgentWindow: (action) => ipcRenderer.invoke('fixed-sites:manage-agent-window', action),
  closeAgentPicker: () => ipcRenderer.invoke('fixed-sites:close-agent-picker'),
  setSidebarCollapsed: (value) => ipcRenderer.invoke('fixed-sites:set-sidebar-collapsed', value),
  toggleSidebar: () => ipcRenderer.invoke('fixed-sites:toggle-sidebar'),
  toggleAgentSidebar: () => ipcRenderer.invoke('fixed-sites:toggle-agent-sidebar'),
  canvasAction: (action, value) => ipcRenderer.invoke('fixed-sites:canvas-action', action, value),
  resizeCanvas: (phase, ratio) => ipcRenderer.invoke('fixed-sites:canvas-resize', phase, ratio),
  undo: () => ipcRenderer.invoke('fixed-sites:undo'),
  saveSnapshot: () => ipcRenderer.invoke('fixed-sites:save-snapshot'),
  restoreSnapshot: () => ipcRenderer.invoke('fixed-sites:restore-snapshot'),
  // Geometry updates are coalesced by the main process. Keeping this IPC
  // asynchronous avoids blocking the renderer on every sidebar animation frame.
  commitSidebarFrame: (width) => ipcRenderer.send('fixed-sites:sidebar-frame', width),
  setImmersive: (value) => ipcRenderer.invoke('fixed-sites:set-immersive', value),

  onStateChanged: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, state) => callback(state);
    ipcRenderer.on(STATE_CHANNEL, listener);
    return () => ipcRenderer.removeListener(STATE_CHANNEL, listener);
  },

  onEditRequested: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, siteId) => callback(siteId);
    ipcRenderer.on(EDIT_CHANNEL, listener);
    return () => ipcRenderer.removeListener(EDIT_CHANNEL, listener);
  },
});
