// Runs inside the SoundCloud page (isolated from SoundCloud's own scripts).
// It reads what is playing from SoundCloud's player bar and presses its buttons
// when you use media keys, the tray, the taskbar buttons or the mini player.
const { ipcRenderer, webFrame } = require('electron');

const SEL = {
  play: '.playControls__play',
  prev: '.playControls__prev',
  next: '.playControls__next',
  shuffle: '.shuffleControl',
  repeat: '.repeatControl',
  title: '.playbackSoundBadge__titleLink',
  artist: '.playbackSoundBadge__lightLink',
  artwork: '.playbackSoundBadge [style*="background-image"]',
  like: '.playbackSoundBadge__like',
  timePassed: '.playbackTimeline__timePassed',
  duration: '.playbackTimeline__duration',
  timeline: '.playbackTimeline__progressWrapper',
};

const $ = (sel) => document.querySelector(sel);

function cleanText(el) {
  if (!el) return '';
  const visible = el.querySelector('span[aria-hidden="true"]');
  return ((visible && visible.textContent) || el.getAttribute('title') || el.textContent || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseTime(raw) {
  if (!raw) return { secs: 0, negative: false };
  const match = String(raw).match(/(-)?\s*(\d+(?::\d{1,2}){1,2})/);
  if (!match) return { secs: 0, negative: false };
  const secs = match[2].split(':').map(Number).reduce((a, b) => a * 60 + b, 0);
  return { secs, negative: !!match[1] };
}

function bigArtwork(url) {
  if (!url) return '';
  return url.replace(/-(t\d+x\d+|large|small|badge|tiny|mini|crop)\.(jpg|png|webp)/, '-t500x500.$2');
}

function readArtwork() {
  const el = $(SEL.artwork);
  if (el) {
    const m = (el.style.backgroundImage || '').match(/url\(["']?(.*?)["']?\)/);
    if (m && m[1]) return bigArtwork(m[1]);
  }
  const meta = navigator.mediaSession && navigator.mediaSession.metadata;
  if (meta && meta.artwork && meta.artwork.length) {
    return meta.artwork[meta.artwork.length - 1].src;
  }
  return '';
}

function readState() {
  const playBtn = $(SEL.play);
  const titleEl = $(SEL.title);
  const meta = navigator.mediaSession && navigator.mediaSession.metadata;

  let title = cleanText(titleEl) || (meta && meta.title) || '';
  let artist = cleanText($(SEL.artist)) || (meta && meta.artist) || '';

  let playing = false;
  if (playBtn) playing = playBtn.classList.contains('playing');
  else if (navigator.mediaSession) playing = navigator.mediaSession.playbackState === 'playing';

  const passed = parseTime(cleanText($(SEL.timePassed))).secs;
  const dur = parseTime(cleanText($(SEL.duration)));
  // SoundCloud can show "remaining" time (e.g. -2:31) instead of the total.
  const duration = dur.negative ? passed + dur.secs : dur.secs;

  const likeBtn = $(SEL.like);
  const shuffleBtn = $(SEL.shuffle);
  const repeatBtn = $(SEL.repeat);
  let repeat = 'none';
  if (repeatBtn) {
    if (repeatBtn.classList.contains('m-one')) repeat = 'one';
    else if (repeatBtn.classList.contains('m-all')) repeat = 'all';
  }

  return {
    hasTrack: !!title,
    title,
    artist,
    artwork: readArtwork(),
    url: titleEl ? titleEl.href : '',
    playing,
    position: passed,
    duration,
    liked: !!(likeBtn && likeBtn.classList.contains('sc-button-selected')),
    canLike: !!likeBtn,
    shuffle: !!(shuffleBtn && shuffleBtn.classList.contains('m-shuffling')),
    repeat,
  };
}

function press(sel) {
  const el = $(sel);
  if (el && !el.disabled) {
    el.click();
    return true;
  }
  return false;
}

function key(keyName, opts = {}) {
  const target = document.body;
  const init = { key: keyName, bubbles: true, cancelable: true, ...opts };
  target.dispatchEvent(new KeyboardEvent('keydown', init));
  target.dispatchEvent(new KeyboardEvent('keyup', init));
}

const actions = {
  playPause() {
    if (!press(SEL.play)) key(' ', { code: 'Space', keyCode: 32 });
  },
  play() {
    if (!readState().playing) actions.playPause();
  },
  pause() {
    if (readState().playing) actions.playPause();
  },
  next() {
    if (!press(SEL.next)) key('ArrowRight', { shiftKey: true });
  },
  prev() {
    if (!press(SEL.prev)) key('ArrowLeft', { shiftKey: true });
  },
  like() {
    press(SEL.like);
  },
  shuffle() {
    press(SEL.shuffle);
  },
  repeat() {
    press(SEL.repeat);
  },
  openTrack() {
    press(SEL.title);
  },
  seek(fraction) {
    const bar = $(SEL.timeline);
    if (!bar) return;
    const r = bar.getBoundingClientRect();
    if (!r.width) return;
    const f = Math.min(Math.max(Number(fraction) || 0, 0), 0.999);
    // The main process sends a real mouse click here, which SoundCloud's
    // timeline accepts more reliably than a synthetic DOM event.
    ipcRenderer.send('sc:click-at', { x: r.left + r.width * f, y: r.top + r.height / 2 });
  },
  trim() {
    // Drop decoded images and cached resources the page isn't using right now.
    webFrame.clearCache();
  },
  focusSearch() {
    const input = document.querySelector('input[type="search"], .headerSearch__input');
    if (input) {
      input.focus();
      input.select();
    }
  },
};

ipcRenderer.on('sc:command', (_e, name, arg) => {
  const fn = actions[name];
  if (fn) {
    try {
      fn(arg);
    } catch (err) {
      console.error('[Soundfast] command failed', name, err);
    }
  }
  setTimeout(tick, 120);
});

// Media keys, headset buttons and the Windows media flyout route through the
// Media Session API. Make sure next/previous always work, even if SoundCloud
// has not registered its own handlers.
function setupMediaSession() {
  if (!('mediaSession' in navigator)) return;
  const handlers = {
    play: actions.play,
    pause: actions.pause,
    previoustrack: actions.prev,
    nexttrack: actions.next,
  };
  for (const [name, fn] of Object.entries(handlers)) {
    try {
      navigator.mediaSession.setActionHandler(name, () => fn());
    } catch {
      /* unsupported action */
    }
  }
}

// If SoundCloud has not filled in the now-playing info for Windows' media
// flyout, fill it in ourselves.
function syncMetadata(state) {
  if (!('mediaSession' in navigator) || !state.hasTrack || typeof MediaMetadata === 'undefined') return;
  const meta = navigator.mediaSession.metadata;
  if (meta && meta.title === state.title && meta.artwork && meta.artwork.length) return;
  if (meta && meta.title && meta.title !== state.title) return; // SoundCloud manages it
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: state.title,
      artist: state.artist,
      album: 'SoundCloud',
      artwork: state.artwork ? [{ src: state.artwork, sizes: '500x500', type: 'image/jpeg' }] : [],
    });
  } catch {
    /* ignore */
  }
}

let last = '';
let lastSent = 0;
function tick() {
  let state;
  try {
    state = readState();
  } catch {
    return;
  }
  const json = JSON.stringify(state);
  const now = Date.now();
  if (json !== last || now - lastSent > 5000) {
    last = json;
    lastSent = now;
    ipcRenderer.send('sc:state', state);
    syncMetadata(state);
  }
}

window.addEventListener('DOMContentLoaded', () => {
  setupMediaSession();
  setInterval(tick, 500);
  tick();
});
