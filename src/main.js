// Soundfast: a lightweight desktop app for SoundCloud.
const {
  app,
  BrowserWindow,
  Menu,
  Notification,
  Tray,
  ipcMain,
  nativeImage,
  nativeTheme,
  net,
  screen,
  session,
  shell,
} = require('electron');
const fs = require('fs');
const path = require('path');
const store = require('./store');
const { DiscordPresence } = require('./discord');
const adblock = require('./adblock');

const APP_ID = 'com.soundfast.app';
const HOME_URL = 'https://soundcloud.com/';
// Set "homepage" in package.json to your GitHub repo to enable the Help links.
const PKG = require('../package.json');
const PROJECT_URL = (PKG.homepage || '').replace(/\/$/, '');
// Discord shows this app's name: "Listening to <name>". Set "discordClientId"
// in package.json to the Application ID from discord.com/developers.
const DISCORD_CLIENT_ID = process.env.SOUNDFAST_DISCORD_ID || PKG.discordClientId || '';
const GITHUB_REPO = (PROJECT_URL.match(/github\.com\/([^/]+\/[^/]+)/) || [])[1];
const ICON_URL = GITHUB_REPO ? `https://raw.githubusercontent.com/${GITHUB_REPO}/main/assets/icon.png` : '';
const ASSETS = path.join(__dirname, '..', 'assets');
const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';
const START_HIDDEN = process.argv.includes('--hidden');

let mainWindow = null;
let miniWindow = null;
let tray = null;
let quitting = false;
let state = { hasTrack: false, playing: false, title: '', artist: '', position: 0, duration: 0 };
let lastNotifiedKey = '';
let lastBlur = 0;
let presence = null;
let trimTimer = null;
let adCssKey = null;

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    const link = findSoundCloudLink(argv);
    showMain();
    if (link && mainWindow) mainWindow.loadURL(link);
  });
}

app.setName('Soundfast');
// Always keep settings and sign-in in the same folder, however the app is launched.
app.setPath('userData', path.join(app.getPath('appData'), 'Soundfast'));
if (IS_WIN) app.setAppUserModelId(APP_ID);

// ---- Memory -----------------------------------------------------------------
// Chromium extras a single-site app doesn't need:
//  - a spare, pre-started page process kept around "just in case"
//  - the back/forward cache, which keeps whole old pages alive in memory
app.commandLine.appendSwitch('disable-features', 'SpareRendererForSitePerProcess,BackForwardCache');
// Low memory mode (on by default, Settings to turn off; needs a restart).
// Measured roughly halving total memory compared with Soundfast 1.0.0:
//  - no GPU acceleration, and the remaining compositor runs inside the main
//    process instead of a separate GPU process
//  - networking runs inside the main process instead of its own process
//  - embedded third-party frames (ads, sign-in widgets) share SoundCloud's page
//    process instead of each getting their own process
//  - Chromium's low-end-device tuning and V8's optimize-for-size mode: smaller
//    caches and a more eagerly collected JavaScript heap
if (store.get('lowMemory')) {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('in-process-gpu');
  app.commandLine.appendSwitch('enable-features', 'NetworkServiceInProcess,NetworkServiceInProcess2');
  app.commandLine.appendSwitch('disable-site-isolation-trials');
  app.commandLine.appendSwitch('enable-low-end-device-mode');
  app.commandLine.appendSwitch('js-flags', '--optimize-for-size');
}
// Playback keeps going while hidden either way: Chromium never throttles a page
// that is playing audio, so the window is allowed to go idle in the background.

// Look like a normal Chrome browser so SoundCloud (and sign-in pages) treat
// the app as a supported browser.
app.userAgentFallback = app.userAgentFallback
  .replace(/\s*Electron\/\S+/i, '')
  .replace(new RegExp(`\\s*${app.getName()}\\/\\S+`, 'i'), '')
  .replace(/\s*soundfast\/\S+/i, '');

function icon(name) {
  return path.join(ASSETS, name);
}

function findSoundCloudLink(argv) {
  return (argv || []).find((a) => /^https:\/\/([a-z0-9-]+\.)?soundcloud\.com\//i.test(a)) || null;
}

// ---------------------------------------------------------------------------
// Which pages stay inside the app
// ---------------------------------------------------------------------------

function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function isSoundCloud(url) {
  const h = hostOf(url);
  return h === 'soundcloud.com' || h.endsWith('.soundcloud.com') || h === 'on.soundcloud.com';
}

// Sign-in providers SoundCloud uses for "Continue with Google / Facebook / Apple".
const AUTH_HOSTS = [
  'accounts.google.com',
  'accounts.youtube.com',
  'www.facebook.com',
  'm.facebook.com',
  'facebook.com',
  'appleid.apple.com',
  'idmsa.apple.com',
];

function isAuth(url) {
  const h = hostOf(url);
  return AUTH_HOSTS.includes(h);
}

function openExternal(url) {
  if (/^(https?|mailto):/i.test(url)) shell.openExternal(url);
}

function hardenContents(contents) {
  contents.setWindowOpenHandler(({ url }) => {
    if (isSoundCloud(url) && !isAuth(url) && contents === mainWindow?.webContents && !/secure\.soundcloud\.com/.test(url)) {
      // Plain SoundCloud links (e.g. "open in new tab") load in the main window.
      mainWindow.loadURL(url);
      return { action: 'deny' };
    }
    if (isSoundCloud(url) || isAuth(url)) {
      // Login pop-ups need to stay in the app so the session is shared.
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          width: 520,
          height: 720,
          parent: mainWindow || undefined,
          autoHideMenuBar: true,
          backgroundColor: '#ffffff',
          icon: icon('icon.png'),
          webPreferences: { partition: 'persist:soundcloud', sandbox: true, contextIsolation: true },
        },
      };
    }
    openExternal(url);
    return { action: 'deny' };
  });

  contents.on('will-navigate', (e, url) => {
    if (url.startsWith('file:')) return;
    if (!isSoundCloud(url) && !isAuth(url)) {
      e.preventDefault();
      openExternal(url);
    }
  });
}

app.on('web-contents-created', (_e, contents) => {
  if (contents.getType() === 'window') hardenContents(contents);
});

// ---------------------------------------------------------------------------
// Main window
// ---------------------------------------------------------------------------

function boundsAreVisible(b) {
  if (!b) return false;
  return screen.getAllDisplays().some(({ workArea: d }) =>
    b.x < d.x + d.width - 80 && b.x + b.width > d.x + 80 && b.y >= d.y - 20 && b.y < d.y + d.height - 80
  );
}

function createMainWindow() {
  const saved = store.get('windowBounds');
  const bounds = boundsAreVisible(saved) ? saved : { width: 1280, height: 820 };

  mainWindow = new BrowserWindow({
    ...bounds,
    minWidth: 820,
    minHeight: 560,
    title: 'Soundfast',
    icon: icon(IS_WIN ? 'icon.ico' : 'icon.png'),
    backgroundColor: '#111111',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      partition: 'persist:soundcloud',
      contextIsolation: true,
      sandbox: true,
      spellcheck: false,
    },
  });
  mainWindow.setMenuBarVisibility(false);

  if (store.get('windowMaximized')) mainWindow.maximize();

  mainWindow.once('ready-to-show', () => {
    if (!START_HIDDEN) mainWindow.show();
  });

  const startUrl = findSoundCloudLink(process.argv) || HOME_URL;
  mainWindow.loadURL(startUrl);

  const wc = mainWindow.webContents;
  wc.setZoomFactor(store.get('zoom') || 1);

  wc.on('did-finish-load', () => wc.setZoomFactor(store.get('zoom') || 1));
  wc.on('dom-ready', () => {
    adCssKey = null;
    applyAdCss();
  });

  // Show a friendly page instead of a blank window when offline.
  wc.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
    if (!isMainFrame || code === -3 /* aborted */) return;
    const retry = isSoundCloud(url) ? url : HOME_URL;
    mainWindow.loadFile(path.join(__dirname, 'offline.html'), { query: { retry, reason: desc } });
  });

  // Keep our own window title: "Track — Artist".
  mainWindow.on('page-title-updated', (e) => {
    e.preventDefault();
    updateTitle();
  });

  // Mouse back/forward buttons on Windows.
  mainWindow.on('app-command', (_e, cmd) => {
    if (cmd === 'browser-backward') goBack();
    if (cmd === 'browser-forward') goForward();
  });

  const saveBounds = debounce(() => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    store.set('windowMaximized', mainWindow.isMaximized());
    if (!mainWindow.isMaximized() && !mainWindow.isMinimized() && !mainWindow.isFullScreen()) {
      store.set('windowBounds', mainWindow.getBounds());
    }
  }, 500);
  mainWindow.on('resize', saveBounds);
  mainWindow.on('move', saveBounds);
  mainWindow.on('maximize', saveBounds);
  mainWindow.on('unmaximize', saveBounds);

  mainWindow.on('close', (e) => {
    if (quitting || !store.get('closeToTray')) return;
    e.preventDefault();
    mainWindow.hide();
    if (!store.get('trayHintShown') && Notification.isSupported()) {
      store.set('trayHintShown', true);
      new Notification({
        title: 'Soundfast is still running',
        body: 'Your music keeps playing. Open Soundfast from the tray icon, or turn this off in Settings.',
        icon: icon('icon.png'),
        silent: true,
      }).show();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  mainWindow.on('show', () => {
    updateThumbar();
    clearInterval(trimTimer);
    trimTimer = null;
  });
  // Free image and script caches while the window is hidden or minimized.
  const startTrimming = () => {
    clearInterval(trimTimer);
    setTimeout(() => command('trim'), 5000);
    trimTimer = setInterval(() => command('trim'), 5 * 60 * 1000);
  };
  mainWindow.on('hide', startTrimming);
  mainWindow.on('minimize', startTrimming);
  mainWindow.on('restore', () => {
    clearInterval(trimTimer);
    trimTimer = null;
  });
  mainWindow.on('blur', () => (lastBlur = Date.now()));
}

function showMain() {
  if (!mainWindow) createMainWindow();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function toggleMain() {
  // Clicking the tray takes focus away from the window first, so "was focused
  // a moment ago" counts as focused.
  const wasFocused = mainWindow && (mainWindow.isFocused() || Date.now() - lastBlur < 400);
  if (mainWindow && mainWindow.isVisible() && !mainWindow.isMinimized() && wasFocused) {
    mainWindow.hide();
  } else {
    showMain();
  }
}

function goBack() {
  const wc = mainWindow?.webContents;
  if (!wc) return;
  const h = wc.navigationHistory;
  if (h ? h.canGoBack() : wc.canGoBack()) h ? h.goBack() : wc.goBack();
}

function goForward() {
  const wc = mainWindow?.webContents;
  if (!wc) return;
  const h = wc.navigationHistory;
  if (h ? h.canGoForward() : wc.canGoForward()) h ? h.goForward() : wc.goForward();
}

async function applyAdCss() {
  const wc = mainWindow?.webContents;
  if (!wc || wc.isDestroyed()) return;
  try {
    if (store.get('adBlock') && !adCssKey) adCssKey = await wc.insertCSS(adblock.HIDE_CSS);
    else if (!store.get('adBlock') && adCssKey) {
      await wc.removeInsertedCSS(adCssKey);
      adCssKey = null;
    }
  } catch {
    /* page navigating */
  }
}

function setAdBlock(on) {
  adblock.apply(session.fromPartition('persist:soundcloud'), on);
  applyAdCss();
}

function setZoom(z) {
  const zoom = Math.round(Math.min(Math.max(z, 0.5), 2) * 10) / 10;
  store.set('zoom', zoom);
  mainWindow?.webContents.setZoomFactor(zoom);
}

// ---------------------------------------------------------------------------
// Playback
// ---------------------------------------------------------------------------

function command(name, arg) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('sc:command', name, arg);
}

ipcMain.on('sc:state', (e, next) => {
  if (!mainWindow || e.sender !== mainWindow.webContents) return;
  const prev = state;
  state = next || state;
  const trackChanged = prev.title !== state.title || prev.artist !== state.artist;
  const playChanged = prev.playing !== state.playing;

  if (trackChanged || playChanged) {
    updateTitle();
    updateTray();
    updateThumbar();
  }
  if (trackChanged && state.playing) notifyTrack();
  if (!trackChanged && playChanged && state.playing) notifyTrack();
  updateProgress();

  if (miniWindow && !miniWindow.isDestroyed()) miniWindow.webContents.send('mini:state', state);
  presence?.update(state);
});

// Real mouse click inside the page (used for seeking on the timeline).
ipcMain.on('sc:click-at', (e, { x, y }) => {
  if (!mainWindow || e.sender !== mainWindow.webContents) return;
  const z = mainWindow.webContents.getZoomFactor();
  const pt = { x: Math.round(x * z), y: Math.round(y * z) };
  const wc = mainWindow.webContents;
  wc.sendInputEvent({ type: 'mouseMove', ...pt });
  wc.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...pt });
  wc.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...pt });
});

function nowPlayingText() {
  if (!state.hasTrack) return 'Soundfast';
  return state.artist ? `${state.title} — ${state.artist}` : state.title;
}

function updateTitle() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.setTitle(state.hasTrack ? `${nowPlayingText()} · Soundfast` : 'Soundfast');
}

function updateProgress() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (store.get('taskbarProgress') && state.hasTrack && state.duration > 0) {
    mainWindow.setProgressBar(Math.min(state.position / state.duration, 1), {
      mode: state.playing ? 'normal' : 'paused',
    });
  } else {
    mainWindow.setProgressBar(-1);
  }
}

async function fetchArtwork(url) {
  if (!url) return null;
  try {
    const res = await net.fetch(url);
    if (!res.ok) return null;
    const img = nativeImage.createFromBuffer(Buffer.from(await res.arrayBuffer()));
    return img.isEmpty() ? null : img.resize({ width: 128, height: 128 });
  } catch {
    return null;
  }
}

async function notifyTrack() {
  if (!store.get('notifications') || !state.hasTrack || !Notification.isSupported()) return;
  if (mainWindow && mainWindow.isVisible() && mainWindow.isFocused()) return;
  const key = `${state.title}|${state.artist}`;
  if (key === lastNotifiedKey) return;
  lastNotifiedKey = key;
  const art = await fetchArtwork(state.artwork);
  const n = new Notification({
    title: state.title,
    body: state.artist || 'SoundCloud',
    icon: art || icon('icon.png'),
    silent: true,
  });
  n.on('click', showMain);
  n.show();
}

// Windows taskbar thumbnail buttons: previous / play-pause / next.
function updateThumbar() {
  if (!IS_WIN || !mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.setThumbarButtons([
    { tooltip: 'Previous', icon: nativeImage.createFromPath(icon('thumb-prev.png')), click: () => command('prev') },
    {
      tooltip: state.playing ? 'Pause' : 'Play',
      icon: nativeImage.createFromPath(icon(state.playing ? 'thumb-pause.png' : 'thumb-play.png')),
      click: () => command('playPause'),
    },
    { tooltip: 'Next', icon: nativeImage.createFromPath(icon('thumb-next.png')), click: () => command('next') },
  ]);
}

// ---------------------------------------------------------------------------
// Mini player
// ---------------------------------------------------------------------------

function toggleMini() {
  if (miniWindow && !miniWindow.isDestroyed()) {
    miniWindow.close();
    return;
  }
  const saved = store.get('miniBounds');
  const size = { width: 360, height: 112 };
  let pos = {};
  if (saved && boundsAreVisible({ ...saved, ...size })) pos = { x: saved.x, y: saved.y };
  else {
    const { workArea } = screen.getPrimaryDisplay();
    pos = { x: workArea.x + workArea.width - size.width - 24, y: workArea.y + workArea.height - size.height - 24 };
  }

  miniWindow = new BrowserWindow({
    ...size,
    ...pos,
    frame: false,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: false,
    alwaysOnTop: store.get('miniAlwaysOnTop'),
    title: 'Soundfast mini player',
    icon: icon(IS_WIN ? 'icon.ico' : 'icon.png'),
    backgroundColor: '#141414',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'mini-preload.js'),
      contextIsolation: true,
      sandbox: true,
    },
  });
  miniWindow.loadFile(path.join(__dirname, 'mini.html'));
  miniWindow.once('ready-to-show', () => {
    miniWindow.show();
    miniWindow.webContents.send('mini:state', state);
  });
  const save = debounce(() => {
    if (miniWindow && !miniWindow.isDestroyed()) {
      const b = miniWindow.getBounds();
      store.set('miniBounds', { x: b.x, y: b.y });
    }
  }, 400);
  miniWindow.on('move', save);
  miniWindow.on('closed', () => {
    miniWindow = null;
    buildMenus();
  });
  buildMenus();
}

ipcMain.on('mini:command', (e, name, arg) => {
  if (!miniWindow || e.sender !== miniWindow.webContents) return;
  if (name === 'close') return miniWindow.close();
  if (name === 'expand') return showMain();
  if (name === 'pin') {
    const on = !miniWindow.isAlwaysOnTop();
    miniWindow.setAlwaysOnTop(on);
    store.set('miniAlwaysOnTop', on);
    miniWindow.webContents.send('mini:pinned', on);
    return buildMenus();
  }
  const allowed = ['playPause', 'next', 'prev', 'like', 'seek', 'openTrack'];
  if (allowed.includes(name)) {
    if (name === 'openTrack') showMain();
    command(name, arg);
  }
});

ipcMain.handle('mini:pinned', () => store.get('miniAlwaysOnTop'));

// ---------------------------------------------------------------------------
// Tray and menus
// ---------------------------------------------------------------------------

function settingsMenu() {
  const toggle = (label, key, after) => ({
    label,
    type: 'checkbox',
    checked: !!store.get(key),
    click: (item) => {
      store.set(key, item.checked);
      if (after) after(item.checked);
      buildMenus();
    },
  });
  const items = [
    toggle(IS_MAC ? 'Keep playing when window is closed' : 'Close to tray (keep playing)', 'closeToTray'),
    toggle('Block ads', 'adBlock', setAdBlock),
    toggle('Show a notification when the track changes', 'notifications'),
    toggle('Mini player always on top', 'miniAlwaysOnTop', (on) => miniWindow?.setAlwaysOnTop(on)),
  ];
  if (presence?.configured) {
    items.unshift(
      toggle("Show what I'm listening to on Discord", 'discordPresence', (on) => {
        if (on) {
          presence.start();
          presence.update(state);
        } else {
          presence.stop();
        }
      })
    );
  }
  if (IS_WIN) items.push(toggle('Show track progress on the taskbar', 'taskbarProgress', updateProgress));
  items.push(toggle('Low memory mode (restarts Soundfast)', 'lowMemory', restartApp));
  if (IS_WIN || IS_MAC) {
    items.push(
      toggle(IS_WIN ? 'Start with Windows' : 'Open at login', 'openAtLogin', (on) =>
        app.setLoginItemSettings({ openAtLogin: on, args: ['--hidden'] })
      )
    );
  }
  if (IS_WIN) {
    items.push({ type: 'separator' }, { label: 'Create desktop shortcut', click: () => createShortcut('desktop') });
  }
  return items;
}

function playbackMenu() {
  return [
    { label: state.playing ? 'Pause' : 'Play', click: () => command('playPause') },
    { label: 'Next track', click: () => command('next') },
    { label: 'Previous track', click: () => command('prev') },
    { label: state.liked ? 'Unlike' : 'Like', enabled: !!state.hasTrack, click: () => command('like') },
  ];
}

function updateTray() {
  if (!tray) return;
  tray.setToolTip(state.hasTrack ? `${state.playing ? '▶' : '❚❚'} ${nowPlayingText()}`.slice(0, 127) : 'Soundfast');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: state.hasTrack ? nowPlayingText().slice(0, 60) : 'Nothing playing', enabled: false },
      { type: 'separator' },
      ...playbackMenu(),
      { type: 'separator' },
      { label: 'Show Soundfast', click: showMain },
      { label: miniWindow ? 'Hide mini player' : 'Show mini player', click: toggleMini },
      { label: 'Settings', submenu: settingsMenu() },
      { type: 'separator' },
      { label: 'Quit Soundfast', click: quit },
    ])
  );
}

function createTray() {
  const img = nativeImage.createFromPath(icon(IS_MAC ? 'trayTemplate.png' : IS_WIN ? 'tray.ico' : 'tray.png'));
  tray = new Tray(img);
  tray.on('click', () => (IS_MAC ? tray.popUpContextMenu() : toggleMain()));
  tray.on('double-click', showMain);
  updateTray();
}

function buildAppMenu() {
  const template = [
    ...(IS_MAC ? [{ role: 'appMenu' }] : []),
    {
      label: 'Soundfast',
      submenu: [
        { label: 'Mini player', accelerator: 'CmdOrCtrl+M', click: toggleMini },
        { label: 'Settings', submenu: settingsMenu() },
        { type: 'separator' },
        { label: 'Quit', accelerator: 'CmdOrCtrl+Q', click: quit },
      ],
    },
    {
      label: 'Navigate',
      submenu: [
        { label: 'Home', accelerator: 'CmdOrCtrl+Shift+H', click: () => mainWindow?.loadURL(HOME_URL) },
        { label: 'Search', accelerator: 'CmdOrCtrl+L', click: () => command('focusSearch') },
        { label: 'Your Likes', accelerator: 'CmdOrCtrl+Shift+L', click: () => mainWindow?.loadURL('https://soundcloud.com/you/likes') },
        { label: 'Your Library', accelerator: 'CmdOrCtrl+Shift+Y', click: () => mainWindow?.loadURL('https://soundcloud.com/you/library') },
        { label: 'Go to playing track', accelerator: 'CmdOrCtrl+J', click: () => command('openTrack') },
        { type: 'separator' },
        { label: 'Back', accelerator: 'Alt+Left', click: goBack },
        { label: 'Forward', accelerator: 'Alt+Right', click: goForward },
        { label: 'Reload', accelerator: 'CmdOrCtrl+R', click: () => mainWindow?.webContents.reload() },
        { label: 'Reload (F5)', accelerator: 'F5', visible: false, click: () => mainWindow?.webContents.reload() },
        { label: 'Copy link to current page', accelerator: 'CmdOrCtrl+Shift+C', click: copyCurrentUrl },
      ],
    },
    {
      label: 'Playback',
      submenu: [
        { label: 'Play / Pause', accelerator: 'CmdOrCtrl+P', click: () => command('playPause') },
        { label: 'Next track', accelerator: 'CmdOrCtrl+Right', click: () => command('next') },
        { label: 'Previous track', accelerator: 'CmdOrCtrl+Left', click: () => command('prev') },
        { label: 'Like / Unlike', accelerator: 'CmdOrCtrl+D', click: () => command('like') },
        { label: 'Shuffle', accelerator: 'CmdOrCtrl+S', click: () => command('shuffle') },
        { label: 'Repeat', accelerator: 'CmdOrCtrl+E', click: () => command('repeat') },
      ],
    },
    {
      label: 'View',
      submenu: [
        { label: 'Zoom in', accelerator: 'CmdOrCtrl+=', click: () => setZoom((store.get('zoom') || 1) + 0.1) },
        { label: 'Zoom in (+)', accelerator: 'CmdOrCtrl+Plus', visible: false, click: () => setZoom((store.get('zoom') || 1) + 0.1) },
        { label: 'Zoom out', accelerator: 'CmdOrCtrl+-', click: () => setZoom((store.get('zoom') || 1) - 0.1) },
        { label: 'Actual size', accelerator: 'CmdOrCtrl+0', click: () => setZoom(1) },
        { type: 'separator' },
        { role: 'togglefullscreen', accelerator: 'F11' },
        { label: 'Developer tools', accelerator: 'CmdOrCtrl+Shift+I', click: () => mainWindow?.webContents.toggleDevTools() },
      ],
    },
    {
      label: 'Help',
      submenu: [
        ...(PROJECT_URL
          ? [
              { label: 'Project page', click: () => shell.openExternal(PROJECT_URL) },
              { label: 'Report a problem', click: () => shell.openExternal(`${PROJECT_URL}/issues`) },
              { type: 'separator' },
            ]
          : []),
        { label: `Soundfast ${app.getVersion()}`, enabled: false },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function buildMenus() {
  buildAppMenu();
  updateTray();
}

function copyCurrentUrl() {
  const url = mainWindow?.webContents.getURL();
  if (url && isSoundCloud(url)) require('electron').clipboard.writeText(url);
}

// ---------------------------------------------------------------------------
// Windows shortcuts (lets the portable build appear in Start / search and
// makes Windows notifications work)
// ---------------------------------------------------------------------------

function createShortcut(where) {
  if (!IS_WIN) return false;
  const dir =
    where === 'desktop'
      ? app.getPath('desktop')
      : path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs');
  const target = path.join(dir, 'Soundfast.lnk');
  try {
    const exe = process.execPath;
    const ico = path.join(path.dirname(exe), 'resources', 'app', 'assets', 'icon.ico');
    return shell.writeShortcutLink(target, fs.existsSync(target) ? 'replace' : 'create', {
      target: exe,
      cwd: path.dirname(exe),
      description: 'SoundCloud desktop app',
      icon: fs.existsSync(ico) ? ico : exe,
      iconIndex: 0,
      appUserModelId: APP_ID,
    });
  } catch (err) {
    console.error('Shortcut failed', err);
    return false;
  }
}

function ensureStartMenuShortcut() {
  if (!IS_WIN || !app.isPackaged) return;
  const lnk = path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Soundfast.lnk');
  if (fs.existsSync(lnk)) {
    store.set('shortcutCreated', true);
    return;
  }
  if (!store.get('shortcutCreated') && createShortcut('startmenu')) store.set('shortcutCreated', true);
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

function quit() {
  quitting = true;
  app.quit();
}

function restartApp() {
  store.flush();
  quitting = true;
  app.relaunch({ args: process.argv.slice(1).filter((a) => a !== '--hidden') });
  app.quit();
}

function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

app.whenReady().then(() => {
  nativeTheme.themeSource = 'dark';

  // Analytics trackers are always blocked; ads are blocked unless turned off
  // in Settings. See adblock.js: it adds no memory.
  const ses = session.fromPartition('persist:soundcloud');
  adblock.apply(ses, store.get('adBlock'));
  // Only grant what a music site needs.
  ses.setPermissionRequestHandler((_wc, permission, cb) => {
    cb(['mediaKeySystem', 'notifications', 'clipboard-sanitized-write', 'fullscreen'].includes(permission));
  });

  presence = new DiscordPresence({
    clientId: DISCORD_CLIENT_ID,
    iconUrl: ICON_URL,
    log: (msg) => console.log(`[discord] ${msg}`),
  });
  if (store.get('discordPresence')) presence.start();

  createMainWindow();
  createTray();
  buildMenus();
  ensureStartMenuShortcut();
  if (store.get('openAtLogin') && (IS_WIN || IS_MAC)) {
    app.setLoginItemSettings({ openAtLogin: true, args: ['--hidden'] });
  }
});

app.on('activate', showMain);

app.on('before-quit', () => {
  quitting = true;
  presence?.stop();
  store.flush();
});

app.on('window-all-closed', () => {
  if (!IS_MAC && !store.get('closeToTray')) app.quit();
});
