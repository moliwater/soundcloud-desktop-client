'use strict';
// Soundfast interface: pages, navigation and the audio player.

const $ = (id) => document.getElementById(id);
const view = $('view');
const audio = $('audio');
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);
const img = (url, size = 't200x200') => (url ? url.replace('{size}', size) : '');
const bg = (url, size) => (url ? ` style="background-image:url('${img(url, size).replace(/['"()\\\s]/g, encodeURIComponent)}')"` : '');
const fmt = (secs) => {
  secs = Math.max(0, Math.floor(secs || 0));
  const h = Math.floor(secs / 3600), m = Math.floor((secs % 3600) / 60), s = String(secs % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
};
const num = (n) => (n >= 1e6 ? (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(n >= 1e4 ? 0 : 1) + 'K' : String(n || 0));
const plural = (n, w) => `${num(n)} ${w}${n === 1 ? '' : 's'}`;

let me = null;
let loggedIn = false;
let liked = new Set();
let settings = {};
let platform = 'win32';

// ---------------------------------------------------------------------------
// Toast
// ---------------------------------------------------------------------------
let toastTimer;
function toast(msg, action) {
  const t = $('toast');
  t.innerHTML = `<span>${esc(msg)}</span>` + (action ? `<button>${esc(action.label)}</button>` : '');
  if (action) t.querySelector('button').onclick = () => { action.fn(); t.classList.remove('show'); };
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), action ? 7000 : 3500);
}

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------
function inkFor(hex) {
  // Dark text on light accents, white text on dark ones.
  const n = parseInt(hex.slice(1), 16);
  const lin = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  const L = 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
  return L > 0.38 ? '#111114' : '#ffffff';
}

function applyTheme() {
  const root = document.documentElement;
  root.dataset.theme = settings.theme || 'charcoal';
  root.dataset.accent = settings.accent || 'green';
  if (settings.accent === 'custom' && /^#[0-9a-f]{6}$/i.test(settings.accentCustom || '')) {
    root.style.setProperty('--accent', settings.accentCustom);
    root.style.setProperty('--accent-ink', inkFor(settings.accentCustom));
  } else {
    root.style.removeProperty('--accent');
    root.style.removeProperty('--accent-ink');
  }
  // Custom background image (stored by the app; only loaded when set).
  const blur = settings.bgBlur !== false;
  root.classList.toggle('has-bg', !!settings.bgImage);
  root.classList.toggle('bg-blur', blur);
  root.style.setProperty('--bg-dim', `color-mix(in srgb, var(--bg) ${settings.bgDim ?? 45}%, transparent)`);
  root.style.setProperty('--bg-image', settings.bgImage ? `url('sfbg://bg/${blur ? 'background-blur' : 'background'}.jpg?v=${Number(settings.bgImage)}')` : 'none');
  drawWave();
}

// ---------------------------------------------------------------------------
// Sidebar
// ---------------------------------------------------------------------------
const NAV_MAIN = [['home', 'Home', 'home'], ['feed', 'Feed', 'feed'], ['search', 'Search', 'search']];
const NAV_LIB = [['likes', 'Liked tracks', 'heart'], ['library', 'Playlists', 'playlists'], ['history', 'Recently played', 'history'], ['following', 'Following', 'users']];

function renderSidebar() {
  const navBtn = ([id, label, ic]) => `<button data-nav="${id}" title="${label}">${icon(ic)}<span>${label}</span></button>`;
  $('nav-main').innerHTML = NAV_MAIN.map(navBtn).join('');
  $('nav-lib').innerHTML = NAV_LIB.map(navBtn).join('');
  $('nav-bottom').innerHTML =
    navBtn(['settings', 'Settings', 'settings']) +
    (loggedIn ? `<button data-act="logout" title="Sign out">${icon('logout')}<span>Sign out</span></button>` : '');
  $('profile').innerHTML = loggedIn
    ? `<div class="avatar"${bg(me.avatar, 't200x200')}></div><button class="name" data-go="artist:${me.id}">${esc(me.name)}</button><div class="where">${esc(me.city || plural(me.followers, 'follower'))}</div>`
    : `<div class="avatar"></div><div class="name">Welcome</div><div class="where">Sign in for your likes and feed</div><button class="signin" data-act="login">Sign in</button>`;
  markNav();
}

function markNav() {
  const r = router.current();
  document.querySelectorAll('[data-nav]').forEach((b) => b.classList.toggle('on', r && b.dataset.nav === r.name));
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------
const router = {
  stack: [],
  idx: -1,
  current() { return this.stack[this.idx]; },
  go(name, arg, push = true) {
    if (push) {
      const cur = this.current();
      if (cur && cur.name === name && JSON.stringify(cur.arg) === JSON.stringify(arg)) return render();
      this.stack = this.stack.slice(0, this.idx + 1);
      this.stack.push({ name, arg });
      this.idx = this.stack.length - 1;
    }
    render();
  },
  back() { if (this.idx > 0) { this.idx--; render(); } },
  forward() { if (this.idx < this.stack.length - 1) { this.idx++; render(); } },
};

let renderToken = 0;
const lists = new Map(); // list id -> tracks, for click-to-play
let listSeq = 0;
function regList(tracks) { const id = 'l' + ++listSeq; lists.set(id, tracks); return id; }

const NEEDS_LOGIN = new Set(['feed', 'likes', 'library', 'history', 'following']);

async function render() {
  const r = router.current();
  if (!r) return;
  const token = ++renderToken;
  lists.clear();
  markNav();
  $('back').disabled = router.idx <= 0;
  $('fwd').disabled = router.idx >= router.stack.length - 1;
  renderTabs(r);
  if (r.name !== 'search' && document.activeElement !== searchBox) searchBox.value = '';
  view.scrollTop = 0;
  if (NEEDS_LOGIN.has(r.name) && !loggedIn) {
    view.innerHTML = empty('login', 'Sign in to see this', 'Your feed, likes, playlists and history come from your SoundCloud account.', '<button class="btn primary" data-act="login">Sign in to SoundCloud</button>');
    return;
  }
  view.innerHTML = loading(r.name);
  try {
    const html = await PAGES[r.name](r.arg, token);
    if (token !== renderToken) return;
    if (html !== undefined) view.innerHTML = html;
  } catch (e) {
    if (token !== renderToken) return;
    console.error(e);
    view.innerHTML = empty('wifi', "Couldn't reach SoundCloud", navigator.onLine ? 'Something went wrong loading this page.' : 'Check your internet connection.', '<button class="btn primary" data-act="retry">Try again</button>');
  }
}

function renderTabs(r) {
  const tabs = r.name === 'home' || r.name === 'feed' ? [['home', 'Discover'], ['feed', 'Feed'], ['history', 'Recent']] : [];
  $('tabs').innerHTML = tabs.map(([id, l]) => `<button role="tab" data-nav="${id}" class="${r.name === id ? 'on' : ''}">${l}</button>`).join('');
}

const loading = (name) =>
  name === 'home'
    ? `<div class="hero skeleton"></div><div class="section"><div class="row-scroll">${'<div><div class="skeleton" style="aspect-ratio:1"></div></div>'.repeat(5)}</div></div>`
    : `<div class="skeleton" style="height:28px;width:220px;margin:6px 0 24px"></div>${'<div class="skeleton" style="height:48px;margin-bottom:10px;border-radius:8px"></div>'.repeat(7)}`;

const empty = (ic, title, text, extra = '') =>
  `<div class="empty">${icon(ic)}<h3>${esc(title)}</h3><p>${esc(text)}</p>${extra}</div>`;

// ---------------------------------------------------------------------------
// Building blocks
// ---------------------------------------------------------------------------
function cardFor(x, listId, i) {
  if (x.kind === 'user') {
    return `<div class="card round" tabindex="0" data-go="artist:${x.id}"><div class="cover"${bg(x.avatar, 't300x300')}></div><div class="t">${esc(x.name)}</div><div class="s">${plural(x.followers, 'follower')}</div></div>`;
  }
  if (x.kind === 'track') {
    return `<div class="card" tabindex="0" data-play="${listId}:${i}"><div class="cover"${bg(x.artwork, 't300x300')}><span class="play">${icon('play')}</span></div><div class="t">${esc(x.title)}</div><div class="s">${esc(x.artist)}</div></div>`;
  }
  const sub = x.kind === 'system' ? x.description || x.user.name : `${x.isAlbum ? 'Album' : 'Playlist'} · ${esc(x.user.name)}`;
  return `<div class="card" tabindex="0" data-go="playlist:${esc(x.id)}"><div class="cover"${bg(x.artwork, 't300x300')}><span class="play" data-playlist="${esc(x.id)}">${icon('play')}</span></div><div class="t">${esc(x.title)}</div><div class="s">${esc(sub)}</div></div>`;
}

function cards(items, cls = 'row-scroll') {
  const tracks = items.filter((x) => x.kind === 'track');
  const lid = regList(tracks);
  let ti = 0;
  return `<div class="${cls}">${items.map((x) => cardFor(x, lid, x.kind === 'track' ? ti++ : 0)).join('')}</div>`;
}

function trackRows(tracks, { offset = 0, listId, extra } = {}) {
  const lid = listId || regList(tracks);
  const cur = P.current();
  return tracks
    .map((t, i) => {
      const locked = t.play === 'protected' || t.play === 'blocked';
      const badge = locked ? `<span class="badge">${icon('lock')}Protected</span>` : t.preview ? '<span class="badge">Preview</span>' : '';
      return `<div class="row${locked ? ' locked' : ''}${cur && cur.id === t.id ? ' now' : ''}" data-play="${lid}:${i}" data-tid="${t.id}">
        <div class="n"><span>${offset + i + 1}</span>${icon('play')}</div>
        <div class="thumb"${bg(t.artwork, 't67x67')}></div>
        <div style="min-width:0"><div class="title">${esc(t.title)}${badge}</div><button class="by" data-go="artist:${t.user.id}">${esc(t.artist)}</button></div>
        <div class="extra">${esc(extra ? extra(t) : t.plays ? plural(t.plays, 'play') : t.genre)}</div>
        <button class="like${liked.has(t.id) ? ' on' : ''}" data-like="${t.id}" title="Like" aria-label="Like">${icon('heart')}</button>
        <div class="dur">${fmt(t.duration)}</div>
      </div>`;
    })
    .join('');
}

function listBlock(tracks, next, opts = {}) {
  const lid = regList(tracks);
  return `<div class="list" data-list="${lid}">${trackRows(tracks, { listId: lid, ...opts })}</div>${next ? moreBtn(next, lid) : ''}`;
}

const moreBtn = (next, lid) => `<button class="btn ghost more" data-more="${esc(next)}" data-list="${lid}">Show more</button>`;

function section(title, body, sub = '') {
  return `<section class="section"><div class="section-head"><h2>${esc(title)}</h2>${sub ? `<p>${esc(sub)}</p>` : ''}</div>${body}</section>`;
}

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------
const PAGES = {
  async home() {
    const [sections, hist] = await Promise.all([sf.api('home'), loggedIn ? sf.api('history').catch(() => null) : null]);
    const pool = sections.flatMap((s) => s.items.map((x) => ({ x, s })));
    const pick = pool.find((p) => p.x.kind !== 'user' && /curated|power|trending/i.test(p.s.title)) || pool.find((p) => p.x.kind !== 'user') || null;
    let html = '';
    if (pick) {
      const x = pick.x;
      const go = x.kind === 'track' ? `data-play="${regList([x])}:0"` : `data-go="playlist:${esc(x.id)}"`;
      html += `<div class="hero"><div class="hero-bg"${bg(x.artwork, 't500x500')}></div>
        <div class="hero-art"${bg(x.artwork, 't500x500')}></div>
        <div class="hero-body"><div class="hero-kicker">${esc(pick.s.title)}</div><div class="hero-title">${esc(x.title)}</div><div class="hero-sub">${esc(x.kind === 'track' ? x.artist : x.description || x.user.name)}</div>
        <button class="btn ghost" ${go} ${x.kind !== 'track' ? `data-playlist-now="${esc(x.id)}"` : ''}>${icon('play')}Listen now</button></div></div>`;
    }
    if (hist && hist.items.length) html += section('Jump back in', cards(hist.items.slice(0, 14)));
    for (const s of sections) html += section(s.title, cards(s.items), s.description);
    return html || empty('music', 'Nothing here yet', 'SoundCloud did not return any recommendations.');
  },

  async feed() {
    const res = await sf.api('feed');
    const tracks = res.items.filter((x) => x.kind === 'track');
    const lists_ = res.items.filter((x) => x.kind !== 'track');
    let html = `<h1 class="view-title">From people you follow</h1>`;
    if (lists_.length) html += section('New playlists and albums', cards(lists_));
    html += tracks.length ? listBlock(tracks, res.next, { extra: (t) => (t.repostedBy ? `Reposted by ${t.repostedBy}` : plural(t.plays, 'play')) }) : empty('feed', 'Your feed is quiet', 'Follow artists on SoundCloud to see their new tracks here.');
    return html;
  },

  async search(arg = {}) {
    const q = (arg.q || '').trim();
    const kind = arg.kind || 'all';
    $('search').value = q;
    if (!q) return empty('search', 'Search SoundCloud', 'Find artists, tracks, playlists and albums.');
    const pills = ['all:All', 'tracks:Tracks', 'people:Artists', 'playlists:Playlists', 'albums:Albums']
      .map((p) => { const [k, l] = p.split(':'); return `<button class="${k === kind ? 'on' : ''}" data-search-kind="${k}">${l}</button>`; })
      .join('');
    const res = await sf.api('search', q, kind);
    let html = `<h1 class="view-title">Results for “${esc(q)}”</h1><div class="pills">${pills}</div>`;
    if (!res.items.length) return html + empty('search', 'No results', 'Try a different spelling or fewer words.');
    const tracks = res.items.filter((x) => x.kind === 'track');
    const users = res.items.filter((x) => x.kind === 'user');
    const pls = res.items.filter((x) => x.kind === 'playlist' || x.kind === 'system');
    if (kind === 'all') {
      if (users.length) html += section('Artists', cards(users));
      if (tracks.length) html += section('Tracks', listBlock(tracks, null));
      if (pls.length) html += section('Playlists and albums', cards(pls));
      if (res.next) html += `<button class="btn ghost more" data-search-kind="tracks">More tracks</button>`;
    } else if (kind === 'tracks') html += listBlock(tracks, res.next);
    else html += `<div data-grid>${cards(res.items, 'grid')}</div>${res.next ? `<button class="btn ghost more" data-more-grid="${esc(res.next)}">Show more</button>` : ''}`;
    return html;
  },

  async likes() {
    const res = await sf.api('likes');
    if (!res.items.length) return `<h1 class="view-title">Liked tracks</h1>` + empty('heart', 'No likes yet', 'Tap the heart on any track to save it here.');
    const lid = regList(res.items);
    return `<div class="page-head"><div class="cover liked-cover">${icon('heart')}</div><div><div class="kind">Your library</div><h1>Liked tracks</h1><div class="meta">${esc(me.name)}</div><div class="actions"><button class="btn primary" data-playall="${lid}">${icon('play')}Play</button><button class="btn ghost" data-shuffleall="${lid}">${icon('shuffle')}Shuffle</button></div></div></div>
      <div class="list" data-list="${lid}">${trackRows(res.items, { listId: lid })}</div>${res.next ? moreBtn(res.next, lid) : ''}`;
  },

  async library() {
    const res = await sf.api('library');
    const html = `<h1 class="view-title">Playlists and albums</h1>`;
    if (!res.items.length) return html + empty('playlists', 'No playlists yet', 'Playlists and albums you make or like on SoundCloud show up here.');
    return html + `<div data-grid>${cards(res.items, 'grid')}</div>${res.next ? `<button class="btn ghost more" data-more-grid="${esc(res.next)}">Show more</button>` : ''}`;
  },

  async history() {
    const res = await sf.api('history');
    const html = `<h1 class="view-title">Recently played</h1>`;
    if (!res.items.length) return html + empty('history', 'Nothing played yet', 'Tracks you play show up here.');
    return html + listBlock(res.items, res.next);
  },

  async following() {
    const res = await sf.api('following');
    const html = `<h1 class="view-title">Following</h1>`;
    if (!res.items.length) return html + empty('users', 'Not following anyone yet', 'Artists you follow on SoundCloud show up here.');
    return html + `<div data-grid>${cards(res.items, 'grid')}</div>${res.next ? `<button class="btn ghost more" data-more-grid="${esc(res.next)}">Show more</button>` : ''}`;
  },

  async playlist(id) {
    const p = await sf.api('playlist', id);
    const lid = regList(p.tracks);
    const total = p.tracks.reduce((a, t) => a + (t.duration || 0), 0);
    const kind = p.kind === 'system' ? 'Mix' : p.isAlbum ? 'Album' : 'Playlist';
    return `<div class="page-head"><div class="cover"${bg(p.artwork, 't500x500')}></div><div style="min-width:0"><div class="kind">${kind}</div><h1>${esc(p.title)}</h1>
      <div class="meta">${p.user && p.user.id ? `<button data-go="artist:${p.user.id}">${esc(p.user.name)}</button>` : esc(p.user ? p.user.name : '')} · ${plural(p.tracks.length, 'track')} · ${fmt(total)}</div>
      <div class="actions"><button class="btn primary" data-playall="${lid}">${icon('play')}Play</button><button class="btn ghost" data-shuffleall="${lid}">${icon('shuffle')}Shuffle</button>${p.url ? `<button class="btn ghost" data-ext="${esc(p.url)}">${icon('external')}SoundCloud</button>` : ''}</div></div></div>
      <div class="list" data-list="${lid}">${trackRows(p.tracks, { listId: lid })}</div>`;
  },

  async artist(id) {
    const a = await sf.api('artist', id);
    const topId = regList(a.top);
    let html = `<div class="page-head"><div class="cover round"${bg(a.avatar, 't500x500')}></div><div style="min-width:0"><div class="kind">Artist</div><h1>${esc(a.name)}</h1>
      <div class="meta">${plural(a.followers, 'follower')} · ${plural(a.tracks, 'track')}${a.city ? ' · ' + esc(a.city) : ''}</div>
      <div class="actions">${a.top.length ? `<button class="btn primary" data-playall="${topId}">${icon('play')}Play</button>` : ''}<button class="btn ghost" data-ext="${esc(a.url)}">${icon('external')}SoundCloud</button></div></div></div>`;
    if (a.top.length) html += section('Popular', `<div class="list" data-list="${topId}">${trackRows(a.top, { listId: topId })}</div>`);
    if (a.latest.items.length) html += section('Latest', listBlock(a.latest.items, a.latest.next, { extra: (t) => (t.created ? new Date(t.created).toLocaleDateString() : '') }));
    if (!a.top.length && !a.latest.items.length) html += empty('music', 'No tracks yet', `${a.name} hasn't uploaded any public tracks.`);
    return html;
  },

  async settings() {
    const themes = [
      ['charcoal', 'Charcoal', '#1c1c1f', '#2b2b30', '#f4f4f5'],
      ['midnight', 'Midnight', '#0e1221', '#1c2239', '#eef1fb'],
      ['black', 'True black', '#000000', '#151517', '#f5f5f5'],
      ['light', 'Light', '#f3f3f5', '#e3e3e9', '#17171a'],
    ];
    const accents = [['green', '#3ddc84'], ['orange', '#ff7a1f'], ['blue', '#4c8dff'], ['purple', '#a274ff'], ['pink', '#ff5ca8'], ['red', '#ff5050']];
    const sw = ([id, label, b, c, t]) => `<button class="theme-card${(settings.theme || 'charcoal') === id ? ' on' : ''}" data-theme-pick="${id}"><div class="sw"><i style="background:${b}"></i><i style="background:${c}"><b style="background:${t};width:70%"></b><b style="background:${t};width:45%"></b><b style="background:var(--accent);width:55%;opacity:1"></b></i><i style="background:${b}"></i></div><span>${label}</span></button>`;
    const tog = (key, label, help) => `<div class="toggle-row"><div><div class="lbl">${label}</div>${help ? `<div class="help">${help}</div>` : ''}</div><button class="switch${settings[key] ? ' on' : ''}" role="switch" aria-checked="${!!settings[key]}" data-toggle="${key}" aria-label="${label}"></button></div>`;
    return `<div class="settings"><h1 class="view-title">Settings</h1>
      <h2>Theme</h2><div class="themes">${themes.map(sw).join('')}</div>
      <h2>Accent color</h2><div class="accents">${accents.map(([id, c]) => `<button class="accent-dot${(settings.accent || 'green') === id ? ' on' : ''}" style="background:${c}" data-accent-pick="${id}" title="${id}" aria-label="${id} accent"></button>`).join('')}
        <label class="accent-custom${settings.accent === 'custom' ? ' on' : ''}${settings.accentCustom ? ' set' : ''}" style="--custom:${esc(settings.accentCustom || '#3ddc84')}" title="Pick your own color"><input type="color" id="accent-input" value="${esc(settings.accentCustom || '#3ddc84')}" aria-label="Pick your own accent color"></label></div>
      <h2>Background</h2>
      <div class="bg-pick"><div class="bg-thumb" style="${settings.bgImage ? `background-image:url('sfbg://bg/background.jpg?v=${Number(settings.bgImage)}')` : ''}">${settings.bgImage ? '' : 'Theme color'}</div>
        <div><div class="help" style="color:var(--muted);font-size:12.5px;margin-bottom:10px">Use one of your own pictures (PNG or JPG) as the app background. Soundfast keeps its own copy, sized to your screen.</div>
        <div class="btns"><button class="btn primary" data-bg="choose">${settings.bgImage ? 'Change image' : 'Choose image'}</button>${settings.bgImage ? '<button class="btn ghost" data-bg="clear">Remove</button>' : ''}</div></div></div>
      ${settings.bgImage ? `${tog('bgBlur', 'Blur background', 'Softens the picture so text stays easy to read.')}
      <div class="range-row"><div class="lbl">Darken background</div><input type="range" min="0" max="85" step="1" value="${settings.bgDim ?? 45}" data-range="bgDim" aria-label="Darken background"><output>${settings.bgDim ?? 45}%</output></div>` : ''}
      <h2>Playback</h2>
      ${tog('discordPresence', "Show what I'm listening to on Discord", 'Shows the track on your Discord profile while it plays.')}
      ${tog('notifications', 'Track change notifications', 'A small notification when a new track starts and Soundfast is in the background.')}
      ${tog('autoplay', 'Keep playing similar tracks', 'When your queue ends, continue with related tracks.')}
      <h2>App</h2>
      ${tog('closeToTray', 'Keep playing when the window is closed', 'Closing the window hides Soundfast in the tray.')}
      ${tog('miniAlwaysOnTop', 'Mini player always on top', '')}
      ${platform === 'linux' ? '' : tog('openAtLogin', platform === 'darwin' ? 'Open at login' : 'Start with Windows', 'Starts quietly in the tray.')}
      ${platform === 'win32' ? tog('taskbarProgress', 'Show track progress on the taskbar', '') : ''}
      ${tog('lowMemory', 'Low memory mode', 'Uses less memory. Soundfast restarts when you change this.')}
      <h2>Account</h2>
      <div class="toggle-row"><div><div class="lbl">${loggedIn ? `Signed in as ${esc(me.name)}` : 'Not signed in'}</div><div class="help">${loggedIn ? 'Your likes, feed and playlists come from this SoundCloud account.' : 'Sign in to see your likes, feed and playlists.'}</div></div>${loggedIn ? '<button class="btn ghost" data-act="logout">Sign out</button>' : '<button class="btn primary" data-act="login">Sign in</button>'}</div>
      <h2>About</h2><div class="toggle-row"><div><div class="lbl">Soundfast ${esc(settings.version || '')}</div><div class="help">An independent app, not made by SoundCloud. Music and data come from SoundCloud.</div></div>${settings.homepage ? `<button class="btn ghost" data-ext="${esc(settings.homepage)}">Project page</button>` : ''}</div>
      </div>`;
  },
};

// ---------------------------------------------------------------------------
// Click handling
// ---------------------------------------------------------------------------
document.addEventListener('click', async (e) => {
  const el = e.target.closest('button, [data-playlist], [data-play], [data-go], [data-nav], a');
  if (!el) return;
  if (el.tagName === 'A') e.preventDefault();
  const d = el.dataset;

  if (d.nav) return d.nav === 'search' ? focusSearch() : router.go(d.nav);
  if (d.act === 'login') return login();
  if (d.act === 'logout') return logout();
  if (d.act === 'retry') return render();
  if (d.like) { e.stopPropagation(); return toggleLike(Number(d.like)); }
  if (d.ext) return sf.openExternal(d.ext);
  if (d.searchKind) return router.go('search', { q: $('search').value, kind: d.searchKind });
  if (d.themePick) return setSetting('theme', d.themePick);
  if (d.accentPick) return setSetting('accent', d.accentPick);
  if (d.toggle) return setSetting(d.toggle, d.toggle === 'bgBlur' ? settings.bgBlur === false : !settings[d.toggle]);
  if (d.bg === 'choose') {
    try {
      const v = await sf.chooseBackground();
      if (v) { settings.bgImage = v; applyTheme(); rerenderSettings(); }
    } catch (err) { toast(/could not be opened/.test(err.message) ? 'That file could not be opened as an image' : "Couldn't use that image"); }
    return;
  }
  if (d.bg === 'clear') { await sf.clearBackground(); settings.bgImage = null; applyTheme(); return rerenderSettings(); }
  if (d.playall) return P.playList(lists.get(d.playall), 0, false);
  if (d.shuffleall) return P.playList(lists.get(d.shuffleall), 0, true);
  if (d.playlist || d.playlistNow) {
    e.stopPropagation();
    try {
      const p = await sf.api('playlist', d.playlist || d.playlistNow);
      return P.playList(p.tracks, 0, false);
    } catch { return toast("Couldn't load that playlist"); }
  }
  if (d.more) return loadMore(el, d.more, d.list);
  if (d.moreGrid) return loadMoreGrid(el, d.moreGrid);
  if (d.go) {
    e.stopPropagation();
    e.preventDefault();
    const [name, ...rest] = d.go.split(':');
    const arg = rest.join(':');
    return router.go(name, name === 'artist' ? Number(arg) : arg);
  }
  if (d.play) {
    const [lid, i] = d.play.split(':');
    const list = lists.get(lid) || [];
    return P.playList(list, Number(i), false);
  }
});

document.addEventListener('keydown', (e) => {
  const typing = /INPUT|TEXTAREA/.test(document.activeElement.tagName);
  if (e.key === 'Enter' && document.activeElement.classList.contains('card')) document.activeElement.click();
  if (typing) return;
  if (e.key === ' ') { e.preventDefault(); P.toggle(); }
  if (e.key === '/') { e.preventDefault(); focusSearch(); }
});

async function loadMore(btn, next, lid) {
  btn.disabled = true;
  try {
    const res = await sf.api('more', next);
    const list = lists.get(lid) || [];
    const tracks = res.items.filter((x) => x.kind === 'track');
    const offset = list.length;
    list.push(...tracks);
    const box = view.querySelector(`.list[data-list="${lid}"]`);
    box.insertAdjacentHTML('beforeend', trackRows(tracks, { listId: lid, offset }).replace(new RegExp(`data-play="${lid}:(\\d+)"`, 'g'), (_, n) => `data-play="${lid}:${Number(n) + offset}"`));
    if (res.next) { btn.dataset.more = res.next; btn.disabled = false; } else btn.remove();
  } catch { btn.disabled = false; toast("Couldn't load more"); }
}

async function loadMoreGrid(btn, next) {
  btn.disabled = true;
  try {
    const res = await sf.api('more', next);
    view.querySelector('[data-grid] .grid').insertAdjacentHTML('beforeend', res.items.map((x) => cardFor(x, regList([x]), 0)).join(''));
    if (res.next) { btn.dataset.moreGrid = res.next; btn.disabled = false; } else btn.remove();
  } catch { btn.disabled = false; toast("Couldn't load more"); }
}

// Search box
const searchBox = $('search');
searchBox.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && searchBox.value.trim()) router.go('search', { q: searchBox.value.trim(), kind: 'all' });
  if (e.key === 'Escape') searchBox.blur();
});
function focusSearch() { searchBox.focus(); searchBox.select(); }

// ---------------------------------------------------------------------------
// Account
// ---------------------------------------------------------------------------
async function refreshAuth() {
  try {
    const s = await sf.api('status');
    loggedIn = s.loggedIn;
    me = s.me || null;
    liked = new Set(loggedIn ? await sf.api('likedIds') : []);
  } catch {
    loggedIn = false;
  }
  renderSidebar();
  updateNow();
}

async function login() {
  const ok = await sf.login();
  if (ok) { await refreshAuth(); render(); toast(`Signed in as ${me ? me.name : 'you'}`); }
}

async function logout() {
  await sf.logout();
  await refreshAuth();
  router.go('home');
  toast('Signed out');
}

async function toggleLike(id) {
  if (!loggedIn) return toast('Sign in to like tracks', { label: 'Sign in', fn: login });
  const on = !liked.has(id);
  on ? liked.add(id) : liked.delete(id);
  syncLikes(id);
  try {
    await sf.api('setLike', id, on);
  } catch {
    on ? liked.delete(id) : liked.add(id);
    syncLikes(id);
    toast("Couldn't update your like");
  }
}

function syncLikes(id) {
  document.querySelectorAll(`[data-like="${id}"]`).forEach((b) => b.classList.toggle('on', liked.has(id)));
  updateNow();
}

async function setSetting(key, value, rerender = true) {
  settings[key] = value;
  if (['theme', 'accent', 'accentCustom', 'bgBlur', 'bgDim'].includes(key)) applyTheme();
  await sf.setSetting(key, value);
  if (rerender) rerenderSettings();
}

async function rerenderSettings() {
  if (router.current().name !== 'settings') return;
  const top = view.scrollTop;
  view.innerHTML = await PAGES.settings();
  view.scrollTop = top;
}

// Live sliders and the custom color picker on the Settings page.
view.addEventListener('input', (e) => {
  const el = e.target;
  if (el.dataset.range === 'bgDim') {
    el.nextElementSibling.textContent = el.value + '%';
    settings.bgDim = Number(el.value);
    applyTheme();
  }
  if (el.id === 'accent-input') {
    settings.accent = 'custom';
    settings.accentCustom = el.value;
    applyTheme();
    const box = el.parentElement;
    box.classList.add('on', 'set');
    box.style.setProperty('--custom', el.value);
    view.querySelectorAll('.accent-dot.on').forEach((d) => d.classList.remove('on'));
  }
});
view.addEventListener('change', (e) => {
  const el = e.target;
  if (el.dataset.range === 'bgDim') setSetting('bgDim', Number(el.value), false);
  if (el.id === 'accent-input') { setSetting('accentCustom', el.value, false); setSetting('accent', 'custom', false); }
});

// ---------------------------------------------------------------------------
// Player
// ---------------------------------------------------------------------------
const P = {
  queue: [],
  index: -1,
  order: null, // shuffled play order (indices), or null
  repeat: 'none', // none | all | one
  token: 0,
  recorded: false,
  retried: false,
  pendingSeek: 0,

  current() { return this.queue[this.index] || null; },

  playList(list, start = 0, shuffle = false) {
    if (!list || !list.length) return;
    this.queue = list.slice();
    this.index = start;
    if (shuffle) {
      settings.shuffle = true;
      sf.setSetting('shuffle', true);
      this.index = Math.floor(Math.random() * list.length);
    }
    this.order = null;
    if (settings.shuffle) this.makeOrder();
    this.load(this.index, true);
  },

  makeOrder() {
    const rest = this.queue.map((_, i) => i).filter((i) => i !== this.index);
    for (let i = rest.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [rest[i], rest[j]] = [rest[j], rest[i]]; }
    this.order = [this.index, ...rest];
  },

  upcoming() {
    if (this.index < 0) return [];
    if (this.order) { const p = this.order.indexOf(this.index); return this.order.slice(p + 1); }
    return this.queue.map((_, i) => i).slice(this.index + 1);
  },

  nextIndex() {
    const up = this.upcoming();
    if (up.length) return up[0];
    if (this.repeat === 'all' && this.queue.length) return this.order ? this.order[0] : 0;
    return -1;
  },

  prevIndex() {
    if (this.order) { const p = this.order.indexOf(this.index); return p > 0 ? this.order[p - 1] : -1; }
    return this.index > 0 ? this.index - 1 : -1;
  },

  async load(i, autoplay = true, skips = 0) {
    const t = this.queue[i];
    if (!t) return;
    this.index = i;
    this.recorded = false;
    this.retried = false;
    const my = ++this.token;
    updateNow();
    highlightRows();
    loadWave(t);
    if (t.play === 'protected' || t.play === 'blocked') return this.skipLocked(t, skips);
    try {
      const s = await sf.api('stream', t.id);
      if (my !== this.token) return;
      await attach(s);
      if (this.pendingSeek) { audio.currentTime = this.pendingSeek; this.pendingSeek = 0; }
      if (autoplay) await audio.play().catch((err) => { if (err.name !== 'AbortError') throw err; });
    } catch (err) {
      if (my !== this.token) return;
      if (/protected/i.test(err.message || '')) { t.play = 'protected'; return this.skipLocked(t, skips); }
      console.error(err);
      toast(`Couldn't play “${t.title}”`);
    }
    sendState();
  },

  skipLocked(t, skips) {
    toast(`“${t.title}” is protected by SoundCloud and only plays on their site.`, { label: 'Open on SoundCloud', fn: () => sf.openExternal(t.url) });
    const n = this.nextIndex();
    if (n >= 0 && skips < this.queue.length) this.load(n, true, skips + 1);
    else { audio.pause(); sendState(); }
  },

  async next(auto = false) {
    if (auto && this.repeat === 'one') { audio.currentTime = 0; return audio.play(); }
    let n = this.nextIndex();
    if (n < 0 && settings.autoplay !== false && this.current()) {
      const more = await sf.api('related', this.current().id).catch(() => []);
      const have = new Set(this.queue.map((t) => t.id));
      const add = more.filter((t) => !have.has(t.id) && t.play === 'ok');
      if (add.length) {
        const start = this.queue.length;
        this.queue.push(...add);
        if (this.order) this.order.push(...add.map((_, k) => start + k));
        n = this.nextIndex();
      }
    }
    if (n >= 0) this.load(n, true);
    else { audio.pause(); audio.currentTime = 0; sendState(); }
  },

  prev() {
    if (audio.currentTime > 3 || this.prevIndex() < 0) { audio.currentTime = 0; return; }
    this.load(this.prevIndex(), true);
  },

  toggle() {
    if (!this.current()) return;
    if (!audio.src) return this.load(this.index, true);
    audio.paused ? audio.play().catch(() => {}) : audio.pause();
  },

  seek(fraction) {
    const d = audio.duration || (this.current() && this.current().duration) || 0;
    if (d && isFinite(d)) audio.currentTime = Math.max(0, Math.min(d - 0.5, fraction * d));
  },

  setShuffle(on) {
    settings.shuffle = on;
    if (on) this.makeOrder(); else this.order = null;
    sf.setSetting('shuffle', on);
    updateNow();
    renderQueue();
  },

  cycleRepeat() {
    this.repeat = { none: 'all', all: 'one', one: 'none' }[this.repeat];
    sf.setSetting('repeat', this.repeat);
    updateNow();
  },
};

// Native HLS playback is built into this version of Chromium; hls.js is a
// fallback loaded only if a system ever lacks it, so it costs nothing normally.
let hls = null;
const nativeHls = () => audio.canPlayType('application/vnd.apple.mpegurl') !== '';
async function attach(s) {
  if (hls) { hls.destroy(); hls = null; }
  if (s.protocol === 'hls' && !nativeHls()) {
    if (!window.Hls) await new Promise((res, rej) => { const sc = document.createElement('script'); sc.src = 'vendor/hls.light.min.js'; sc.onload = res; sc.onerror = rej; document.head.appendChild(sc); });
    hls = new window.Hls({ maxBufferLength: 20 });
    hls.loadSource(s.url);
    hls.attachMedia(audio);
    return;
  }
  audio.src = s.url;
}

audio.addEventListener('ended', () => P.next(true));
audio.addEventListener('durationchange', () => {
  if (isFinite(audio.duration) && audio.duration > 0) $('t2').textContent = $('bb-t2').textContent = fmt(audio.duration);
});
function updateProgressBar() {
  const t = P.current();
  const dur = audio.duration && isFinite(audio.duration) ? audio.duration : (t && t.duration) || 0;
  const pct = dur && t ? Math.min(100, (audio.currentTime / dur) * 100) : 0;
  $('bb-fill').style.width = pct + '%';
  $('bb-knob').style.left = pct + '%';
  $('bb-t1').textContent = fmt(t ? audio.currentTime : 0);
  $('bb-bar').setAttribute('aria-valuenow', String(Math.round(pct)));
}
audio.addEventListener('play', () => { updatePlayIcon(); sendState(); });
audio.addEventListener('pause', () => { updatePlayIcon(); sendState(); saveSession(); });
audio.addEventListener('error', () => {
  // Stream links expire after a while; get a fresh one and carry on.
  const t = P.current();
  if (!t || P.retried || !audio.src) return;
  P.retried = true;
  P.pendingSeek = audio.currentTime || 0;
  P.load(P.index, true);
});
let lastTick = 0;
audio.addEventListener('timeupdate', () => {
  const now = performance.now();
  if (now - lastTick < 250) return;
  lastTick = now;
  $('t1').textContent = fmt(audio.currentTime);
  if (settings.panelOpen !== false) drawWave();
  updateProgressBar();
  if (!P.recorded && audio.currentTime > 5 && P.current()) { P.recorded = true; sf.api('recordPlay', P.current().id).catch(() => {}); }
  if (now - lastStateSent > 1000) sendState();
  if ('mediaSession' in navigator && isFinite(audio.duration)) {
    try { navigator.mediaSession.setPositionState({ duration: audio.duration, position: Math.min(audio.currentTime, audio.duration), playbackRate: 1 }); } catch {}
  }
  if (now - lastSave > 5000) saveSession();
});
audio.addEventListener('volumechange', () => { updateVolume(); localStorage.setItem('sf.volume', String(audio.volume)); localStorage.setItem('sf.muted', audio.muted ? '1' : ''); });

// ---------------------------------------------------------------------------
// Now playing panel (closeable; when closed, a playback bar shows at the bottom)
// ---------------------------------------------------------------------------
function applyPanel() {
  const open = settings.panelOpen !== false;
  document.querySelector('.app').classList.toggle('panel-closed', !open);
  if (open) drawWave();
}
function setPanel(open) {
  settings.panelOpen = open;
  applyPanel();
  sf.setSetting('panelOpen', open);
}
$('close-panel').onclick = () => setPanel(false);
$('bb-open').onclick = () => setPanel(true);
$('bb-art').onclick = () => setPanel(true);
function updatePlayIcon() {
  const playing = !audio.paused;
  for (const id of ['play', 'bb-play']) {
    $(id).innerHTML = icon(playing ? 'pause' : 'play');
    $(id).title = playing ? 'Pause' : 'Play';
    $(id).setAttribute('aria-label', $(id).title);
  }
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = P.current() ? (playing ? 'playing' : 'paused') : 'none';
}

function updateNow() {
  const t = P.current();
  const artEl = $('np-art');
  if (t) {
    artEl.classList.remove('empty');
    artEl.innerHTML = '';
    artEl.style.backgroundImage = t.artwork ? `url('${img(t.artwork, 't500x500')}')` : '';
    $('np-title').textContent = t.title;
    $('np-title').title = t.title;
    $('np-artist').textContent = t.artist;
    $('np-artist').dataset.go = `artist:${t.user.id}`;
    $('t2').textContent = fmt(t.duration);
    document.title = `${t.title} · ${t.artist}`;
  } else {
    artEl.classList.add('empty');
    artEl.innerHTML = icon('disc');
    artEl.style.backgroundImage = '';
    $('np-title').textContent = 'Nothing playing';
    $('np-artist').textContent = 'Pick a track to start';
    delete $('np-artist').dataset.go;
  }
  const bbArt = $('bb-art');
  bbArt.style.backgroundImage = t && t.artwork ? `url('${img(t.artwork, 't120x120')}')` : '';
  bbArt.innerHTML = t && t.artwork ? '' : icon('disc');
  $('bb-title').textContent = t ? t.title : 'Nothing playing';
  $('bb-title').title = t ? t.title : '';
  $('bb-artist').textContent = t ? t.artist : '';
  if (t) $('bb-artist').dataset.go = `artist:${t.user.id}`;
  else delete $('bb-artist').dataset.go;
  if (t) $('bb-t2').textContent = fmt(t.duration);
  for (const id of ['np-like', 'bb-like']) $(id).classList.toggle('on', !!(t && liked.has(t.id)));
  for (const p of ['', 'bb-']) {
    $(p + 'shuffle').classList.toggle('on', !!settings.shuffle);
    $(p + 'repeat').classList.toggle('on', P.repeat !== 'none');
    $(p + 'repeat').classList.toggle('rep1', P.repeat === 'one');
    $(p + 'repeat').title = { none: 'Repeat', all: 'Repeat all', one: 'Repeat one' }[P.repeat];
  }
  updateProgressBar();
  updatePlayIcon();
  renderQueue();
  setMediaSession(t);
}

function renderQueue() {
  const up = P.upcoming().slice(0, 40);
  $('q-count').textContent = P.current() ? `${P.upcoming().length} tracks` : '';
  if (!P.current()) { $('queue').innerHTML = '<div class="hint">Tracks you play will line up here.</div>'; return; }
  if (!up.length) { $('queue').innerHTML = `<div class="hint">${settings.autoplay !== false ? 'Similar tracks will play next.' : 'This is the last track.'}</div>`; return; }
  $('queue').innerHTML = up
    .map((i) => { const t = P.queue[i]; return `<div class="q" data-q="${i}"><div class="thumb"${bg(t.artwork, 't67x67')}></div><div style="min-width:0"><div class="title">${esc(t.title)}</div><div class="by">${esc(t.artist)}</div></div><div class="dur">${fmt(t.duration)}</div></div>`; })
    .join('');
}
$('queue').addEventListener('click', (e) => { const q = e.target.closest('[data-q]'); if (q) P.load(Number(q.dataset.q), true); });

function highlightRows() {
  const t = P.current();
  view.querySelectorAll('.row.now').forEach((r) => r.classList.remove('now'));
  if (t) view.querySelectorAll(`.row[data-tid="${t.id}"]`).forEach((r) => r.classList.add('now'));
}

// Waveform from SoundCloud's own waveform data.
let wave = null;
let waveFor = null;
async function loadWave(t) {
  waveFor = t.id;
  wave = null;
  drawWave();
  const w = await sf.api('waveform', t.waveform).catch(() => null);
  if (waveFor === t.id) { wave = w; drawWave(); }
}
function drawWave() {
  const c = $('wave');
  const w = c.clientWidth;
  if (!w) return;
  const dpr = window.devicePixelRatio || 1;
  c.width = Math.round(w * dpr);
  c.height = Math.round(34 * dpr);
  const g = c.getContext('2d');
  const css = getComputedStyle(document.documentElement);
  const accent = css.getPropertyValue('--accent').trim();
  const base = css.getPropertyValue('--faint').trim();
  const t = P.current();
  const dur = audio.duration && isFinite(audio.duration) ? audio.duration : (t && t.duration) || 0;
  const prog = dur ? audio.currentTime / dur : 0;
  const n = wave ? wave.length : 56;
  const gap = 2 * dpr;
  const bw = Math.max(1, (c.width - gap * (n - 1)) / n);
  for (let i = 0; i < n; i++) {
    const v = wave ? Math.max(0.12, wave[i]) : 0.22;
    const h = Math.max(2 * dpr, v * c.height);
    g.globalAlpha = (i + 0.5) / n <= prog ? 1 : 0.55;
    g.fillStyle = (i + 0.5) / n <= prog ? accent : base;
    g.beginPath();
    g.roundRect ? g.roundRect(i * (bw + gap), (c.height - h) / 2, bw, h, bw / 2) : g.rect(i * (bw + gap), (c.height - h) / 2, bw, h);
    g.fill();
  }
}
$('wave').addEventListener('click', (e) => { const r = e.currentTarget.getBoundingClientRect(); P.seek((e.clientX - r.left) / r.width); });
window.addEventListener('resize', () => drawWave());

function updateVolume() {
  const v = audio.muted ? 0 : audio.volume;
  for (const p of ['', 'bb-']) {
    $(p + 'vol').value = v;
    $(p + 'vol').style.setProperty('--v', `${v * 100}%`);
    $(p + 'vol-btn').innerHTML = icon(v === 0 ? 'mute' : 'volume');
  }
}
$('vol').addEventListener('input', (e) => { audio.muted = false; audio.volume = Number(e.target.value); });
$('vol-btn').onclick = () => { audio.muted = !audio.muted; };
$('bb-vol').addEventListener('input', (e) => { audio.muted = false; audio.volume = Number(e.target.value); });
$('bb-vol-btn').onclick = () => { audio.muted = !audio.muted; };
$('bb-play').onclick = () => P.toggle();
$('bb-next').onclick = () => P.next();
$('bb-prev').onclick = () => P.prev();
$('bb-shuffle').onclick = () => P.setShuffle(!settings.shuffle);
$('bb-repeat').onclick = () => P.cycleRepeat();
$('bb-like').onclick = () => P.current() && toggleLike(P.current().id);
$('bb-mini').onclick = () => sf.toggleMini();
// Seek by clicking or dragging the bottom progress bar, or with arrow keys.
(() => {
  const bar = $('bb-bar');
  const at = (e) => { const r = bar.getBoundingClientRect(); return Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)); };
  bar.addEventListener('pointerdown', (e) => {
    if (!P.current()) return;
    bar.setPointerCapture(e.pointerId);
    P.seek(at(e));
    const move = (ev) => P.seek(at(ev));
    const up = () => { bar.removeEventListener('pointermove', move); bar.removeEventListener('pointerup', up); };
    bar.addEventListener('pointermove', move);
    bar.addEventListener('pointerup', up);
  });
  bar.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowRight') audio.currentTime = Math.min(audio.currentTime + 5, audio.duration || audio.currentTime);
    if (e.key === 'ArrowLeft') audio.currentTime = Math.max(0, audio.currentTime - 5);
  });
})();
$('play').onclick = () => P.toggle();
$('next').onclick = () => P.next();
$('prev').onclick = () => P.prev();
$('shuffle').onclick = () => P.setShuffle(!settings.shuffle);
$('repeat').onclick = () => P.cycleRepeat();
$('np-like').onclick = () => P.current() && toggleLike(P.current().id);
$('open-sc').onclick = () => P.current() && sf.openExternal(P.current().url);
$('mini').onclick = () => sf.toggleMini();

// Media keys, headset buttons and the Windows media flyout.
function setMediaSession(t) {
  if (!('mediaSession' in navigator)) return;
  navigator.mediaSession.metadata = t
    ? new MediaMetadata({ title: t.title, artist: t.artist, album: 'SoundCloud', artwork: t.artwork ? [{ src: img(t.artwork, 't500x500'), sizes: '500x500', type: 'image/jpeg' }] : [] })
    : null;
}
if ('mediaSession' in navigator) {
  const ms = navigator.mediaSession;
  const h = {
    play: () => P.toggle(),
    pause: () => audio.pause(),
    previoustrack: () => P.prev(),
    nexttrack: () => P.next(),
    seekto: (d) => { audio.currentTime = d.seekTime; },
    seekbackward: (d) => { audio.currentTime = Math.max(0, audio.currentTime - (d.seekOffset || 10)); },
    seekforward: (d) => { audio.currentTime = audio.currentTime + (d.seekOffset || 10); },
  };
  for (const [k, fn] of Object.entries(h)) try { ms.setActionHandler(k, fn); } catch {}
}

// State for the tray, mini player, Discord and notifications.
let lastStateSent = 0;
function sendState() {
  lastStateSent = performance.now();
  const t = P.current();
  sf.sendState({
    hasTrack: !!t,
    title: t ? t.title : '',
    artist: t ? t.artist : '',
    artwork: t ? img(t.artwork, 't500x500') : '',
    url: t ? t.url : '',
    playing: !!t && !audio.paused,
    position: Math.floor(audio.currentTime || 0),
    duration: Math.floor(isFinite(audio.duration) ? audio.duration : (t && t.duration) || 0),
    liked: !!(t && liked.has(t.id)),
    canLike: !!t,
    shuffle: !!settings.shuffle,
    repeat: P.repeat,
  });
}

// Commands from the tray, menus, mini player and taskbar buttons.
sf.onCommand((name, arg) => {
  const t = P.current();
  switch (name) {
    case 'playPause': return P.toggle();
    case 'play': return audio.paused && P.toggle();
    case 'pause': return audio.pause();
    case 'next': return P.next();
    case 'prev': return P.prev();
    case 'like': return t && toggleLike(t.id);
    case 'seek': return P.seek(Number(arg));
    case 'shuffle': return P.setShuffle(!settings.shuffle);
    case 'repeat': return P.cycleRepeat();
    case 'openTrack': return t && router.go('artist', t.user.id);
    case 'focusSearch': return focusSearch();
    case 'copyLink': if (t) { sf.copy(t.url); toast('Link copied'); } return;
    case 'openUrl': return openSoundCloudUrl(arg);
    case 'togglePanel': return setPanel(settings.panelOpen === false);
    case 'nav':
      if (arg === 'back') return router.back();
      if (arg === 'forward') return router.forward();
      return router.go(arg);
  }
});
async function openSoundCloudUrl(url) {
  try {
    const x = await sf.api('resolve', url);
    if (!x) return toast("Couldn't open that link");
    if (x.kind === 'track') return P.playList([x], 0, false);
    if (x.kind === 'user') return router.go('artist', x.id);
    return router.go('playlist', x.id);
  } catch { toast("Couldn't open that link"); }
}

sf.onSettings((s) => { settings = { ...settings, ...s }; applyTheme(); updateNow(); });
sf.onAuth(async () => { await refreshAuth(); render(); });
$('back').innerHTML = icon('back');
$('fwd').innerHTML = icon('fwd');
$('back').onclick = () => router.back();
$('fwd').onclick = () => router.forward();
$('search-ico').innerHTML = icon('search');
$('shuffle').innerHTML = icon('shuffle');
$('prev').innerHTML = icon('prev');
$('next').innerHTML = icon('next');
$('repeat').innerHTML = icon('repeat');
$('np-like').innerHTML = icon('heart');
$('open-sc').innerHTML = icon('external');
$('mini').innerHTML = icon('mini');
$('close-panel').innerHTML = icon('close');
$('bb-shuffle').innerHTML = icon('shuffle');
$('bb-prev').innerHTML = icon('prev');
$('bb-next').innerHTML = icon('next');
$('bb-repeat').innerHTML = icon('repeat');
$('bb-like').innerHTML = icon('heart');
$('bb-mini').innerHTML = icon('mini');
$('bb-open').innerHTML = icon('panel');

// ---------------------------------------------------------------------------
// Remember the queue between launches
// ---------------------------------------------------------------------------
let lastSave = 0;
function saveSession() {
  lastSave = performance.now();
  try {
    const start = Math.max(0, P.index - 20);
    localStorage.setItem('sf.session', JSON.stringify({ queue: P.queue.slice(start, start + 120), index: P.index - start, position: Math.floor(audio.currentTime || 0) }));
  } catch {}
}
function restoreSession() {
  try {
    const s = JSON.parse(localStorage.getItem('sf.session') || 'null');
    if (s && s.queue && s.queue[s.index]) {
      P.queue = s.queue;
      P.index = s.index;
      P.pendingSeek = s.position || 0;
      if (settings.shuffle) P.makeOrder();
      loadWave(P.current());
    }
  } catch {}
  const v = Number(localStorage.getItem('sf.volume'));
  audio.volume = isFinite(v) && localStorage.getItem('sf.volume') !== null ? v : 1;
  audio.muted = !!localStorage.getItem('sf.muted');
  updateVolume();
}
window.addEventListener('beforeunload', saveSession);

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
(async function start() {
  const s = await sf.getSettings();
  settings = s.settings;
  platform = s.platform;
  document.documentElement.classList.toggle('mac', platform === 'darwin');
  P.repeat = settings.repeat || 'none';
  applyTheme();
  applyPanel();
  restoreSession();
  renderSidebar();
  updateNow();
  router.go('home');
  await refreshAuth();
  if (loggedIn && router.current().name === 'home') render();
  sendState();
})();
