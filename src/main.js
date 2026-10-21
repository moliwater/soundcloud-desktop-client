// Soundfast: a lightweight desktop app for SoundCloud with its own interface.
const {
  app,
  BrowserWindow,
  Menu,
  clipboard,
  dialog,
  protocol,
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
const { pathToFileURL } = require('url');
const store = require('./store');
const { DiscordPresence } = require('./discord');
const adblock = require('./adblock');
const scapi = require('./scapi');

const APP_ID = 'com.soundfast.app';
const SIGNIN_URL = 'https://soundcloud.com/signin';
const UI_FILE = path.join(__dirname, 'ui', 'index.html');
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
let loginWin = null;
let loginPromise = null;

// Title bar colors per theme (the window controls sit over the Now playing
// panel, so they use that panel's color).
const THEMES = {
  charcoal: { bg: '#1c1c1f', panel: '#232327', text: '#f4f4f5', dark: true },
  midnight: { bg: '#0e1221', panel: '#151a2d', text: '#eef1fb', dark: true },
  black: { bg: '#000000', panel: '#0c0c0d', text: '#f5f5f5', dark: true },
  light: { bg: '#f3f3f5', panel: '#ffffff', text: '#17171a', dark: false },
};
const theme = () => THEMES[store.get('theme')] || THEMES.charcoal;

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    const link = findSoundCloudLink(argv);
    showMain();
    if (link) command('openUrl', link);
  });
}

// The user's own background image is served to the interface from this
// scheme, so the interface never needs general access to files on disk.
protocol.registerSchemesAsPrivileged([{ scheme: 'sfbg', privileges: { standard: true, secure: true } }]);

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
    const fromUi = contents === mainWindow?.webContents || contents === miniWindow?.webContents;
    if (!fromUi && (isSoundCloud(url) || isAuth(url))) {
      // Login pop-ups need to stay in the app so the session is shared.
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          width: 520,
          height: 720,
          parent: loginWin || mainWindow || undefined,
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
    const isUi = contents === mainWindow?.webContents || contents === miniWindow?.webContents;
    if (isUi || (!isSoundCloud(url) && !isAuth(url))) {
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
    backgroundColor: theme().bg,
    autoHideMenuBar: true,
    show: false,
    // Our own dark title bar; the system window buttons sit on top of it.
    ...(IS_MAC
      ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 18, y: 18 } }
      : { titleBarStyle: 'hidden', titleBarOverlay: overlay() }),
    webPreferences: {
      preload: path.join(__dirname, 'ui', 'preload.js'),
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

  mainWindow.loadFile(UI_FILE);
  const startLink = findSoundCloudLink(process.argv);
  const wc = mainWindow.webContents;
  wc.on('did-finish-load', () => {
    wc.setZoomFactor(store.get('zoom') || 1);
    if (startLink) setTimeout(() => command('openUrl', startLink), 1500);
  });

  // Keep our own window title: "Track — Artist".
  mainWindow.on('page-title-updated', (e) => {
    e.preventDefault();
    updateTitle();
  });

  // Mouse back/forward buttons on Windows.
  mainWindow.on('app-command', (_e, cmd) => {
    if (cmd === 'browser-backward') command('nav', 'back');
    if (cmd === 'browser-forward') command('nav', 'forward');
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

  mainWindow.on('show', updateThumbar);
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

function overlay() {
  const t = theme();
  // With a background image the window buttons sit on the picture.
  return { color: store.get('bgImage') ? '#00000000' : t.panel, symbolColor: t.text, height: 44 };
}

// ---------------------------------------------------------------------------
// Custom background image
// ---------------------------------------------------------------------------

const bgFile = (name = 'background.jpg') => path.join(app.getPath('userData'), name);

// Copies the chosen picture into Soundfast's own folder, scaled down to the
// screen size so a huge photo doesn't cost extra memory when shown.
// Three passes of a box blur approximate a Gaussian blur.
function blurImage(img, radius) {
  const { width: w, height: h } = img.getSize();
  const a = Buffer.from(img.toBitmap());
  const b = Buffer.alloc(a.length);
  const pass = (src, dst, len, lines, step, lineStep) => {
    const div = radius * 2 + 1;
    for (let line = 0; line < lines; line++) {
      const base = line * lineStep;
      for (let c = 0; c < 4; c++) {
        const at = (i) => src[base + Math.min(len - 1, Math.max(0, i)) * step + c];
        let acc = 0;
        for (let k = -radius; k <= radius; k++) acc += at(k);
        for (let i = 0; i < len; i++) {
          dst[base + i * step + c] = Math.round(acc / div);
          acc += at(i + radius + 1) - at(i - radius);
        }
      }
    }
  };
  for (let n = 0; n < 3; n++) {
    pass(a, b, w, h, 4, w * 4); // horizontal
    pass(b, a, h, w, w * 4, 4); // vertical
  }
  return nativeImage.createFromBitmap(a, { width: w, height: h });
}

// Blur strength 1-100 maps to a blur radius on the small (480px) copy.
const blurRadius = () => Math.max(1, Math.round((store.get('bgBlurAmount') ?? 40) * 0.24));

function writeBlurred(img) {
  const s = img.getSize();
  const small = img.resize({ width: 480, height: Math.max(1, Math.round((480 * s.height) / s.width)), quality: 'better' });
  fs.writeFileSync(bgFile('background-blur.jpg'), blurImage(small, blurRadius()).toJPEG(86));
}

// Re-blur after the strength slider moves (a few milliseconds on the small copy).
function reblurBackground() {
  if (!store.get('bgImage') || !fs.existsSync(bgFile())) return;
  const img = nativeImage.createFromPath(bgFile());
  if (img.isEmpty()) return;
  writeBlurred(img);
  const version = Date.now();
  store.set('bgImage', version);
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('settings:changed', { bgImage: version });
}

async function chooseBackground() {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose a background image',
    properties: ['openFile'],
    filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg'] }],
  });
  if (res.canceled || !res.filePaths[0]) return null;
  let img = nativeImage.createFromPath(res.filePaths[0]);
  if (img.isEmpty()) throw new Error('That file could not be opened as an image');
  const disp = screen.getPrimaryDisplay();
  const maxW = Math.min(3840, Math.round(disp.size.width * disp.scaleFactor));
  const maxH = Math.min(2160, Math.round(disp.size.height * disp.scaleFactor));
  const { width, height } = img.getSize();
  const scale = Math.min(1, maxW / width, maxH / height);
  if (scale < 1) img = img.resize({ width: Math.round(width * scale), height: Math.round(height * scale), quality: 'good' });
  fs.writeFileSync(bgFile(), img.toJPEG(90));
  // A pre-blurred copy for "Blur background", made once here so the window
  // never runs a live blur effect. It is small; the window stretches it, which
  // looks smooth because the picture is already soft.
  writeBlurred(img);
  const version = Date.now();
  applySetting('bgImage', version);
  return version;
}

function clearBackground() {
  try {
    fs.rmSync(bgFile(), { force: true });
    fs.rmSync(bgFile('background-blur.jpg'), { force: true });
  } catch {
    /* already gone */
  }
  applySetting('bgImage', null);
}

ipcMain.handle('bg:choose', (e) => (e.sender === mainWindow?.webContents ? chooseBackground() : null));
ipcMain.handle('bg:clear', (e) => {
  if (e.sender === mainWindow?.webContents) clearBackground();
});

function applyTheme() {
  const t = theme();
  nativeTheme.themeSource = t.dark ? 'dark' : 'light';
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.setBackgroundColor(t.bg);
  if (!IS_MAC && mainWindow.setTitleBarOverlay) {
    try {
      mainWindow.setTitleBarOverlay(overlay());
    } catch {
      /* not supported on this system */
    }
  }
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
    click: (item) => applySetting(key, item.checked, after),
  });
  const radio = (label, key, options) => ({
    label,
    submenu: options.map(([value, text]) => ({
      label: text,
      type: 'radio',
      checked: store.get(key) === value,
      click: () => applySetting(key, value),
    })),
  });
  const items = [
    radio('Theme', 'theme', [['charcoal', 'Charcoal'], ['midnight', 'Midnight'], ['black', 'True black'], ['light', 'Light']]),
    radio('Accent color', 'accent', [
      ['green', 'Green'], ['orange', 'Orange'], ['blue', 'Blue'], ['purple', 'Purple'], ['pink', 'Pink'], ['red', 'Red'],
      ...(store.get('accentCustom') ? [['custom', 'Custom']] : []),
    ]),
    { type: 'separator' },
    toggle(IS_MAC ? 'Keep playing when window is closed' : 'Close to tray (keep playing)', 'closeToTray'),
    toggle('Show a notification when the track changes', 'notifications'),
    toggle('Keep playing similar tracks when the queue ends', 'autoplay'),
    toggle('Mini player always on top', 'miniAlwaysOnTop', (on) => miniWindow?.setAlwaysOnTop(on)),
  ];
  if (presence?.configured) {
    items.splice(3, 0, 
      toggle("Show what I'm listening to on Discord", 'discordPresence')
    );
  }
  if (IS_WIN) items.push(toggle('Show track progress on the taskbar', 'taskbarProgress', updateProgress));
  items.push(toggle('Low memory mode (restarts Soundfast)', 'lowMemory'));
  if (IS_WIN || IS_MAC) {
    items.push(
      toggle(IS_WIN ? 'Start with Windows' : 'Open at login', 'openAtLogin')
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
        { label: 'Show / hide Now playing', accelerator: 'CmdOrCtrl+B', click: () => command('togglePanel') },
        { label: 'Settings', submenu: settingsMenu() },
        { type: 'separator' },
        { label: 'Quit', accelerator: 'CmdOrCtrl+Q', click: quit },
      ],
    },
    {
      label: 'Navigate',
      submenu: [
        { label: 'Home', accelerator: 'CmdOrCtrl+Shift+H', click: () => nav('home') },
        { label: 'Feed', accelerator: 'CmdOrCtrl+Shift+F', click: () => nav('feed') },
        { label: 'Search', accelerator: 'CmdOrCtrl+L', click: () => { showMain(); command('focusSearch'); } },
        { label: 'Liked tracks', accelerator: 'CmdOrCtrl+Shift+L', click: () => nav('likes') },
        { label: 'Playlists', accelerator: 'CmdOrCtrl+Shift+Y', click: () => nav('library') },
        { label: 'Recently played', accelerator: 'CmdOrCtrl+Shift+R', click: () => nav('history') },
        { label: 'Artist of the playing track', accelerator: 'CmdOrCtrl+J', click: () => { showMain(); command('openTrack'); } },
        { label: 'Settings', accelerator: 'CmdOrCtrl+,', click: () => nav('settings') },
        { type: 'separator' },
        { label: 'Back', accelerator: 'Alt+Left', click: () => command('nav', 'back') },
        { label: 'Forward', accelerator: 'Alt+Right', click: () => command('nav', 'forward') },
        { label: 'Reload', accelerator: 'CmdOrCtrl+R', click: () => mainWindow?.webContents.reload() },
        { label: 'Copy link to playing track', accelerator: 'CmdOrCtrl+Shift+C', click: () => command('copyLink') },
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

function nav(page) {
  showMain();
  command('nav', page);
}

// ---------------------------------------------------------------------------
// Settings (from the in-app Settings page, the tray and the menu bar)
// ---------------------------------------------------------------------------

const SETTING_KEYS = new Set([
  'theme', 'accent', 'discordPresence', 'notifications', 'autoplay', 'closeToTray', 'miniAlwaysOnTop',
  'openAtLogin', 'taskbarProgress', 'lowMemory', 'shuffle', 'repeat', 'panelOpen',
  'accentCustom', 'bgImage', 'bgBlur', 'bgDim', 'bgBlurAmount',
]);

function applySetting(key, value, after) {
  if (!SETTING_KEYS.has(key)) return;
  if (key === 'accentCustom' && !/^#[0-9a-f]{6}$/i.test(String(value))) return;
  if (key === 'bgDim') value = Math.max(0, Math.min(85, Math.round(Number(value) || 0)));
  if (key === 'bgBlurAmount') value = Math.max(1, Math.min(100, Math.round(Number(value) || 1)));
  const before = store.get(key);
  store.set(key, value);
  if (key === 'theme' || key === 'bgImage') applyTheme();
  if (key === 'bgBlurAmount') reblurBackground();
  if (key === 'discordPresence') {
    if (value) {
      presence?.start();
      presence?.update(state);
    } else presence?.stop();
  }
  if (key === 'openAtLogin' && (IS_WIN || IS_MAC)) app.setLoginItemSettings({ openAtLogin: !!value, args: ['--hidden'] });
  if (key === 'miniAlwaysOnTop') miniWindow?.setAlwaysOnTop(!!value);
  if (key === 'taskbarProgress') updateProgress();
  if (after) after(value);
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('settings:changed', { [key]: value });
  buildMenus();
  if (key === 'lowMemory' && before !== value) restartApp();
}

ipcMain.handle('settings:get', (e) => {
  if (e.sender !== mainWindow?.webContents) return null;
  return { settings: { ...store.all(), scClientId: undefined, version: app.getVersion(), homepage: PROJECT_URL }, platform: process.platform };
});
ipcMain.handle('settings:set', (e, key, value) => {
  if (e.sender !== mainWindow?.webContents || key === 'bgImage') return;
  applySetting(key, value);
});

// ---------------------------------------------------------------------------
// SoundCloud data and sign-in
// ---------------------------------------------------------------------------

ipcMain.handle('api', (e, method, args) => {
  if (e.sender !== mainWindow?.webContents) throw new Error('Not allowed');
  return scapi.call(method, Array.isArray(args) ? args : []);
});

// Sign-in happens on SoundCloud's own sign-in page in a small window; once
// SoundCloud sets your session, the window closes by itself.
function openLogin() {
  if (loginWin && !loginWin.isDestroyed()) {
    loginWin.focus();
    return loginPromise;
  }
  loginWin = new BrowserWindow({
    width: 500,
    height: 760,
    parent: mainWindow || undefined,
    title: 'Sign in to SoundCloud',
    icon: icon(IS_WIN ? 'icon.ico' : 'icon.png'),
    autoHideMenuBar: true,
    backgroundColor: '#121212',
    webPreferences: { partition: 'persist:soundcloud', contextIsolation: true, sandbox: true },
  });
  loginWin.loadURL(SIGNIN_URL);
  loginPromise = new Promise((resolve) => {
    let finished = false;
    const finish = (ok) => {
      if (finished) return;
      finished = true;
      clearInterval(timer);
      resolve(ok);
      if (loginWin && !loginWin.isDestroyed()) loginWin.close();
    };
    const timer = setInterval(async () => {
      if (await scapi.getToken()) finish(true);
    }, 800);
    loginWin.on('closed', () => {
      loginWin = null;
      scapi.getToken().then((t) => finish(!!t));
    });
  });
  return loginPromise;
}

ipcMain.handle('auth:login', (e) => (e.sender === mainWindow?.webContents ? openLogin() : false));
ipcMain.handle('auth:logout', async (e) => {
  if (e.sender !== mainWindow?.webContents) return;
  await scapi.logout();
});

ipcMain.on('open-external', (e, url) => {
  if (e.sender === mainWindow?.webContents && typeof url === 'string') openExternal(url);
});
ipcMain.on('copy', (e, text) => {
  if (e.sender === mainWindow?.webContents && typeof text === 'string') clipboard.writeText(text.slice(0, 2000));
});
ipcMain.on('mini:toggle', (e) => {
  if (e.sender === mainWindow?.webContents) toggleMini();
});

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
  protocol.handle('sfbg', (req) => {
    const name = new URL(req.url).pathname.includes('blur') ? 'background-blur.jpg' : 'background.jpg';
    return net.fetch(pathToFileURL(bgFile(name)).toString());
  });
  applyTheme();

  // The SoundCloud session is only used for data requests and the sign-in
  // window. Ads and trackers on the sign-in page are blocked (adds no memory).
  const ses = session.fromPartition('persist:soundcloud');
  adblock.apply(ses, true);
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
