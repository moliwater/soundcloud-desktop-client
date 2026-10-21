// Discord Rich Presence ("Listening to SoundCloud") without any dependencies.
// Talks to the Discord desktop app over its local IPC socket / named pipe.
// Nothing is sent anywhere if Discord isn't running or the feature is off.
const net = require('net');
const path = require('path');

const OP = { HANDSHAKE: 0, FRAME: 1, CLOSE: 2, PING: 3, PONG: 4 };
const ACTIVITY_LISTENING = 2;
const MIN_GAP_MS = 4100; // Discord allows 5 activity updates per 20 seconds
const RETRY_MS = 15000;
const SEEK_TOLERANCE_MS = 3000;

function socketPaths() {
  const out = [];
  for (let i = 0; i < 10; i++) {
    if (process.platform === 'win32') {
      out.push(`\\\\?\\pipe\\discord-ipc-${i}`);
      continue;
    }
    const env = process.env;
    const bases = [env.XDG_RUNTIME_DIR, env.TMPDIR, env.TMP, env.TEMP, '/tmp'].filter(Boolean);
    for (const base of new Set(bases)) {
      out.push(path.join(base, `discord-ipc-${i}`));
      out.push(path.join(base, 'app', 'com.discordapp.Discord', `discord-ipc-${i}`)); // Flatpak
      out.push(path.join(base, 'snap.discord', `discord-ipc-${i}`)); // Snap
    }
  }
  return out;
}

function encode(op, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  const head = Buffer.alloc(8);
  head.writeInt32LE(op, 0);
  head.writeInt32LE(body.length, 4);
  return Buffer.concat([head, body]);
}

function clamp(text, max = 128) {
  let s = String(text || '').replace(/\s+/g, ' ').trim();
  if (s.length > max) s = s.slice(0, max - 1) + '…';
  if (s.length === 1) s += ' '; // Discord rejects 1-character fields
  return s;
}

function httpsUrl(url, max = 512) {
  return typeof url === 'string' && /^https:\/\//i.test(url) && url.length <= max ? url : '';
}

class DiscordPresence {
  constructor({ clientId, iconUrl, log = () => {} }) {
    this.clientId = clientId;
    this.iconUrl = httpsUrl(iconUrl);
    this.log = log;
    this.enabled = false;
    this.socket = null;
    this.ready = false;
    this.buffer = Buffer.alloc(0);
    this.retryTimer = null;
    this.sendTimer = null;
    this.lastSentAt = 0;
    this.nonce = 0;
    this.track = null; // latest player state
    this.sent = null; // what Discord currently shows: { key, startMs } or null
  }

  get configured() {
    return /^\d{15,25}$/.test(String(this.clientId || ''));
  }

  start() {
    if (!this.configured || this.enabled) return;
    this.enabled = true;
    this.connect();
  }

  stop() {
    this.enabled = false;
    clearTimeout(this.retryTimer);
    clearTimeout(this.sendTimer);
    this.retryTimer = this.sendTimer = null;
    if (this.socket && this.ready && this.sent) {
      // Clear the status right away, then disconnect.
      try {
        this.socket.write(this.frame(null));
      } catch {
        /* ignore */
      }
    }
    this.teardown();
  }

  update(state) {
    this.track = state;
    this.schedule();
  }

  // ---- connection -------------------------------------------------------

  connect(paths = socketPaths()) {
    if (!this.enabled || this.socket) return;
    if (!paths.length) return this.retryLater();
    const [p, ...rest] = paths;
    const sock = net.createConnection(p);
    let opened = false;
    sock.once('connect', () => {
      opened = true;
      this.socket = sock;
      this.buffer = Buffer.alloc(0);
      sock.write(encode(OP.HANDSHAKE, { v: 1, client_id: String(this.clientId) }));
    });
    sock.on('data', (chunk) => this.onData(chunk));
    sock.on('error', () => {
      if (!opened) {
        sock.destroy();
        this.connect(rest);
      }
    });
    sock.on('close', () => {
      if (!opened) return;
      if (this.socket === sock) {
        this.log('Discord disconnected');
        this.teardown();
        this.retryLater();
      }
    });
  }

  retryLater() {
    if (!this.enabled || this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.connect();
    }, RETRY_MS);
  }

  teardown() {
    const sock = this.socket;
    this.socket = null;
    this.ready = false;
    this.sent = null;
    if (sock) {
      sock.removeAllListeners('close');
      sock.end();
      setTimeout(() => sock.destroy(), 500);
    }
  }

  onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 8) {
      const op = this.buffer.readInt32LE(0);
      const len = this.buffer.readInt32LE(4);
      if (this.buffer.length < 8 + len) return;
      let msg = null;
      try {
        msg = JSON.parse(this.buffer.subarray(8, 8 + len).toString('utf8'));
      } catch {
        /* ignore */
      }
      this.buffer = this.buffer.subarray(8 + len);
      this.onMessage(op, msg);
    }
  }

  onMessage(op, msg) {
    if (op === OP.PING) {
      this.socket?.write(encode(OP.PONG, msg));
    } else if (op === OP.CLOSE) {
      // Usually means the Application ID is wrong.
      this.log(`Discord closed the connection: ${msg && msg.message}`);
      const sock = this.socket;
      this.teardown();
      sock?.destroy();
      this.retryLater();
    } else if (op === OP.FRAME && msg) {
      if (msg.evt === 'READY') {
        this.ready = true;
        this.log(`Connected to Discord as ${msg.data?.user?.username || 'user'}`);
        this.schedule(true);
      } else if (msg.evt === 'ERROR') {
        this.log(`Discord rejected the status: ${msg.data?.message}`);
      }
    }
  }

  // ---- activity ---------------------------------------------------------

  desired() {
    const t = this.track;
    if (!t || !t.hasTrack || !t.playing || !t.title) return null;
    const now = Date.now();
    const startMs = Math.round(now - (t.position || 0) * 1000);
    const activity = {
      type: ACTIVITY_LISTENING,
      details: clamp(t.title),
      state: clamp(t.artist ? `by ${t.artist}` : 'on SoundCloud'),
      timestamps: { start: startMs },
      assets: {},
      instance: false,
    };
    if (t.duration > 0) activity.timestamps.end = startMs + Math.round(t.duration * 1000);
    const art = httpsUrl(t.artwork, 256);
    if (art) {
      activity.assets.large_image = art;
      activity.assets.large_text = clamp(t.title);
    } else if (this.iconUrl) {
      activity.assets.large_image = this.iconUrl;
    }
    if (art && this.iconUrl) {
      activity.assets.small_image = this.iconUrl;
      activity.assets.small_text = 'Soundfast';
    }
    if (!Object.keys(activity.assets).length) delete activity.assets;
    const link = httpsUrl(t.url);
    if (link && /^https:\/\/([a-z0-9-]+\.)?soundcloud\.com\//i.test(link)) {
      activity.buttons = [{ label: 'Listen on SoundCloud', url: link }];
    }
    return { key: `${t.title}|${t.artist}|${t.duration}|${t.artwork}`, startMs, activity };
  }

  needsUpdate(want) {
    if (!want) return this.sent !== null;
    if (!this.sent) return true;
    if (want.key !== this.sent.key) return true;
    return Math.abs(want.startMs - this.sent.startMs) > SEEK_TOLERANCE_MS; // seeked
  }

  schedule(force = false) {
    if (!this.enabled || !this.ready || this.sendTimer) return;
    if (!force && !this.needsUpdate(this.desired())) return;
    const wait = Math.max(0, this.lastSentAt + MIN_GAP_MS - Date.now());
    this.sendTimer = setTimeout(() => {
      this.sendTimer = null;
      this.flush(force);
    }, wait);
  }

  flush(force) {
    if (!this.enabled || !this.ready || !this.socket) return;
    const want = this.desired();
    if (!force && !this.needsUpdate(want)) return;
    this.socket.write(this.frame(want ? want.activity : null));
    this.sent = want ? { key: want.key, startMs: want.startMs } : null;
    this.lastSentAt = Date.now();
  }

  frame(activity) {
    return encode(OP.FRAME, {
      cmd: 'SET_ACTIVITY',
      args: activity ? { pid: process.pid, activity } : { pid: process.pid },
      nonce: `${Date.now()}-${++this.nonce}`,
    });
  }
}

module.exports = { DiscordPresence, socketPaths };
