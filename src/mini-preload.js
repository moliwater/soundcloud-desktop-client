const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('soundfast', {
  onState: (cb) => ipcRenderer.on('mini:state', (_e, state) => cb(state)),
  onPinned: (cb) => ipcRenderer.on('mini:pinned', (_e, on) => cb(on)),
  isPinned: () => ipcRenderer.invoke('mini:pinned'),
  command: (name, arg) => ipcRenderer.send('mini:command', name, arg),
});
