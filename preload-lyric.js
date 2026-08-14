'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('lyricWin', {
  onData: (cb) => {
    ipcRenderer.on('lyric-data', (_e, d) => cb(d));
  },
  onThroughState: (cb) => {
    ipcRenderer.on('lyric-through-state', (_e, on) => cb(on));
  },
  onConfig: (cb) => {
    ipcRenderer.on('lyric-config', (_e, cfg) => cb(cfg));
  },
  getConfig: () => ipcRenderer.invoke('lyric-config-get'),
  close: () => ipcRenderer.send('lyric-close'),
  startDrag: () => ipcRenderer.send('lyric-drag-start'),
  endDrag: () => ipcRenderer.send('lyric-drag-end'),
  control: (action) => ipcRenderer.send('remote-control', action)
});
