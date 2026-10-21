// Bridge between the Soundfast interface and the main process.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('sf', {
  api: (method, ...args) => ipcRenderer.invoke('api', method, args),
  login: () => ipcRenderer.invoke('auth:login'),
  logout: () => ipcRenderer.invoke('auth:logout'),
  accounts: () => ipcRenderer.invoke('accounts:list'),
  refreshAccounts: () => ipcRenderer.invoke('accounts:refresh'),
  addAccount: () => ipcRenderer.invoke('accounts:add'),
  switchAccount: (partition) => ipcRenderer.invoke('accounts:switch', partition),
  removeAccount: (partition) => ipcRenderer.invoke('accounts:remove', partition),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSetting: (key, value) => ipcRenderer.invoke('settings:set', key, value),
  openExternal: (url) => ipcRenderer.send('open-external', url),
  chooseBackground: () => ipcRenderer.invoke('bg:choose'),
  clearBackground: () => ipcRenderer.invoke('bg:clear'),
  toggleMini: () => ipcRenderer.send('mini:toggle'),
  copy: (text) => ipcRenderer.send('copy', text),
  download: (trackId) => ipcRenderer.invoke('download', trackId),
  onDownload: (cb) => ipcRenderer.on('download:progress', (_e, info) => cb(info)),
  showFile: (file) => ipcRenderer.send('show-file', file),
  edit: (what) => ipcRenderer.send('edit', what),
  sendState: (state) => ipcRenderer.send('sc:state', state),
  onCommand: (cb) => ipcRenderer.on('sc:command', (_e, name, arg) => cb(name, arg)),
  onSettings: (cb) => ipcRenderer.on('settings:changed', (_e, s) => cb(s)),
  onAuth: (cb) => ipcRenderer.on('auth:changed', () => cb()),
});
