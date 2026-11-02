// One small, safe bridge for every RadTempo window: named IPC calls only.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('rt', {
  send: (ch, ...args) => ipcRenderer.send(ch, ...args),
  invoke: (ch, ...args) => ipcRenderer.invoke(ch, ...args),
  on: (ch, fn) => {
    const h = (_e, ...args) => fn(...args);
    ipcRenderer.on(ch, h);
    return () => ipcRenderer.removeListener(ch, h);
  },
  platform: process.platform,
});
