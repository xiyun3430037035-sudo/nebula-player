'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('player', {
  platform: process.platform,
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node
  },
  openWebLogin: () => ipcRenderer.invoke('open-web-login'),
  closeWebLogin: () => ipcRenderer.invoke('close-web-login'),
  onWebLoginResult: (cb) => {
    ipcRenderer.on('web-login-result', (_e, data) => cb(data));
  },
  onMediaKey: (cb) => {
    ipcRenderer.on('media-key', (_e, action) => cb(action));
  },
  sendLyric: (data) => ipcRenderer.send('lyric-update', data),
  toggleLyricWin: (on) => ipcRenderer.invoke('toggle-lyric-window', on),
  setLyricThrough: (on) => ipcRenderer.invoke('set-lyric-through', on),
  lyricConfigGet: () => ipcRenderer.invoke('lyric-config-get'),
  lyricConfigSet: (cfg) => ipcRenderer.send('lyric-config-set', cfg),
  lyricConfigReset: () => ipcRenderer.send('lyric-config-reset'),
  onLyricWindowClosed: (cb) => {
    ipcRenderer.on('lyric-window-closed', () => cb());
  },
  onRemoteControl: (cb) => {
    ipcRenderer.on('remote-control', (_e, action) => cb(action));
  },
  copyText: (text) => {
    try {
      const { clipboard } = require('electron');
      clipboard.writeText(String(text == null ? '' : text));
      return true;
    } catch (e) { return false; }
  }
});
