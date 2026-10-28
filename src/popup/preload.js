'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const STATE_CHANNEL = 'fixed-sites:popup-state';

contextBridge.exposeInMainWorld('fixedSitesPopup', {
  getState: () => ipcRenderer.invoke('fixed-sites:popup-get-state'),
  navigate: (action) => ipcRenderer.invoke('fixed-sites:popup-navigate', action),
  copyUrl: () => ipcRenderer.invoke('fixed-sites:popup-copy-url'),
  openExternal: () => ipcRenderer.invoke('fixed-sites:popup-open-external'),
  onStateChanged: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, state) => callback(state);
    ipcRenderer.on(STATE_CHANNEL, listener);
    return () => ipcRenderer.removeListener(STATE_CHANNEL, listener);
  },
});
