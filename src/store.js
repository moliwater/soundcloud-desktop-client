// Tiny JSON settings store kept in the user's app data folder.
// No dependencies, so the app stays small and easy to audit.
const { app } = require('electron');
const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  closeToTray: true,
  notifications: true,
  taskbarProgress: false,
  miniAlwaysOnTop: true,
  openAtLogin: false,
  discordPresence: true,
  adBlock: true,
  lowMemory: true,
  zoom: 1,
  windowBounds: null,
  windowMaximized: false,
  miniBounds: null,
  shortcutCreated: false,
  trayHintShown: false,
  lastUrl: null,
};

let data = null;
let saveTimer = null;

function file() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function load() {
  if (data) return data;
  try {
    data = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(file(), 'utf8')) };
  } catch {
    data = { ...DEFAULTS };
  }
  return data;
}

function flush() {
  clearTimeout(saveTimer);
  saveTimer = null;
  try {
    fs.mkdirSync(path.dirname(file()), { recursive: true });
    fs.writeFileSync(file(), JSON.stringify(load(), null, 2));
  } catch (err) {
    console.error('Could not save settings:', err);
  }
}

function get(key) {
  return load()[key];
}

function set(key, value) {
  load()[key] = value;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flush, 400);
}

module.exports = { get, set, flush };
