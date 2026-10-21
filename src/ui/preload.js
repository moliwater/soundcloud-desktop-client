// Bridge between the Soundfast interface and the main process.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('sf', {
  api: (method, ...args) => ipcRenderer.invoke('api', method, args),
  login: () => ipcRenderer.invoke('auth:login'),
  logout: () => ipcRenderer.invoke('auth:logout'),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSetting: (key, value) => ipcRenderer.invoke('settings:set', key, value),
  openExternal: (url) => ipcRenderer.send('open-external', url),
  chooseBackground: () => ipcRenderer.invoke('bg:choose'),
  clearBackground: () => ipcRenderer.invoke('bg:clear'),
  toggleMini: () => ipcRenderer.send('mini:toggle'),
  copy: (text) => ipcRenderer.send('copy', text),
  sendState: (state) => ipcRenderer.send('sc:state', state),
  onCommand: (cb) => ipcRenderer.on('sc:command', (_e, name, arg) => cb(name, arg)),
  onSettings: (cb) => ipcRenderer.on('settings:changed', (_e, s) => cb(s)),
  onAuth: (cb) => ipcRenderer.on('auth:changed', () => cb()),
});
