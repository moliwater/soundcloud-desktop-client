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
    ? `<button class="avatar" data-go="artist:${me.id}" title="Your profile" aria-label="Your profile"${bg(me.avatar, 't200x200')}></button><button class="name" data-go="artist:${me.id}">${esc(me.name)}</button><div class="where">${esc(me.city || plural(me.followers, 'follower'))}</div>`
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
        <div style="min-width:0"><button class="title" data-go="track:${t.id}" title="Open track page">${esc(t.title)}${badge}</button><button class="by" data-go="artist:${t.user.id}">${esc(t.artist)}</button></div>
        <div class="extra">${esc(extra ? extra(t) : t.plays ? plural(t.plays, 'play') : t.genre)}</div>
        <div class="acts"><button class="add" data-addpl="${t.id}" title="Add to playlist" aria-label="Add to playlist">${icon('plus')}</button><button class="like${liked.has(t.id) ? ' on' : ''}" data-like="${t.id}" title="Like" aria-label="Like">${icon('heart')}</button></div>
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
    const html = `<div class="section-head" style="align-items:center"><h1 class="view-title">Playlists and albums</h1><button class="btn primary" data-newpl="1">${icon('plus')}New playlist</button></div>`;
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
      <div class="meta"><button data-go="people:${a.id}:followers">${plural(a.followers, 'follower')}</button> · <button data-go="people:${a.id}:following">${num(a.following)} following</button> · ${plural(a.tracks, 'track')}${a.city ? ' · ' + esc(a.city) : ''}</div>
      <div class="actions">${a.top.length ? `<button class="btn primary" data-playall="${topId}">${icon('play')}Play</button>` : ''}<button class="btn ghost" data-ext="${esc(a.url)}">${icon('external')}SoundCloud</button></div></div></div>`;
    if (a.top.length) html += section('Popular', `<div class="list" data-list="${topId}">${trackRows(a.top, { listId: topId })}</div>`);
    if (a.latest.items.length) html += section('Latest', listBlock(a.latest.items, a.latest.next, { extra: (t) => (t.created ? new Date(t.created).toLocaleDateString() : '') }));
    if (!a.top.length && !a.latest.items.length) html += empty('music', 'No tracks yet', `${a.name} hasn't uploaded any public tracks.`);
    return html;
  },

  async people(arg) {
    const [idStr, kind = 'followers'] = String(arg).split(':');
    const id = Number(idStr);
    const [u, res] = await Promise.all([sf.api('userName', id), sf.api('people', id, kind)]);
    const mine = loggedIn && me && me.id === id;
    const title = kind === 'following' ? (mine ? 'People you follow' : `${u.name} follows`) : mine ? 'Your followers' : `${u.name}'s followers`;
    const pills = `<div class="pills"><button class="${kind === 'followers' ? 'on' : ''}" data-go="people:${id}:followers">${plural(u.followers, 'follower')}</button><button class="${kind === 'following' ? 'on' : ''}" data-go="people:${id}:following">${num(u.following)} following</button></div>`;
    let html = `<h1 class="view-title">${esc(title)}</h1>${pills}`;
    if (!res.items.length) return html + empty('users', kind === 'following' ? 'Not following anyone yet' : 'No followers yet', kind === 'following' ? `${u.name} doesn't follow anyone yet.` : `Nobody follows ${u.name} yet.`);
    return html + `<div data-grid>${cards(res.items, 'grid')}</div>${res.next ? `<button class="btn ghost more" data-more-grid="${esc(res.next)}">Show more</button>` : ''}`;
  },

  async track(id) {
    const [t, cm] = await Promise.all([sf.api('track', id), sf.api('comments', id).catch(() => ({ items: [], next: null }))]);
    if (!t) return empty('music', 'Track not found', 'It may have been removed or made private.');
    const lid = regList([t]);
    const isNow = P.current() && P.current().id === t.id;
    let html = `<div class="page-head"><div class="cover"${bg(t.artwork, 't500x500')}></div><div style="min-width:0"><div class="kind">Track${t.genre ? ' · ' + esc(t.genre) : ''}</div><h1>${esc(t.title)}</h1>
      <div class="meta"><button data-go="artist:${t.user.id}">${esc(t.artist)}</button> · ${plural(t.plays, 'play')} · ${plural(t.likes, 'like')} · ${fmt(t.duration)}</div>
      <div class="actions"><button class="btn primary" data-play="${lid}:0">${icon('play')}${isNow ? 'Play from start' : 'Play'}</button><button class="btn ghost" data-like-btn="${t.id}">${icon('heart')}${liked.has(t.id) ? 'Liked' : 'Like'}</button><button class="btn ghost" data-addpl="${t.id}">${icon('plus')}Add to playlist</button><button class="btn ghost" data-ext="${esc(t.url)}">${icon('external')}SoundCloud</button></div></div></div>`;
    if (t.description) html += `<p class="desc">${esc(t.description)}</p>`;
    trackPageTrack = t;
    html += `<section class="section" id="comments"><div class="section-head"><h2>${plural(t.comments, 'comment')}</h2></div>`;
    if (!t.commentable) html += `<p class="desc">Comments are turned off for this track.</p>`;
    else if (!loggedIn) html += `<div class="comment-form"><div class="me"></div><button class="btn ghost" data-act="login">Sign in to comment</button></div>`;
    else html += `<form class="comment-form" id="comment-form"><div class="me"${bg(me.avatar, 't67x67')}></div><div class="box"><input id="comment-input" type="text" placeholder="Write a comment" autocomplete="off" aria-label="Write a comment"><span class="at" id="comment-at"></span><button class="btn primary" type="submit">Post</button></div></form>`;
    html += `<div class="comments" id="comment-list">${cm.items.map(commentHtml).join('') || (t.commentable ? '<p class="desc" id="no-comments">No comments yet.</p>' : '')}</div>${cm.next ? `<button class="btn ghost more" data-more-comments="${esc(cm.next)}">Show more comments</button>` : ''}</section>`;
    setTimeout(updateCommentAt, 0);
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
      ${settings.bgBlur !== false ? `<div class="range-row"><div class="lbl">Blur strength</div><input type="range" min="1" max="100" step="1" value="${settings.bgBlurAmount ?? 40}" data-range="bgBlurAmount" aria-label="Blur strength"><output>${settings.bgBlurAmount ?? 40}%</output></div>` : ''}
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
  if (d.likeBtn) { await toggleLike(Number(d.likeBtn)); el.innerHTML = icon('heart') + (liked.has(Number(d.likeBtn)) ? 'Liked' : 'Like'); return; }
  if (d.addpl) { e.stopPropagation(); return openAddToPlaylist(Number(d.addpl)); }
  if (d.newpl) return openAddToPlaylist(null);
  if (d.seek) return seekComment(Number(d.seek));
  if (d.moreComments) return loadMoreComments(el, d.moreComments);
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
    return router.go(name, name === 'artist' || name === 'track' ? Number(arg) : arg);
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

// ---------------------------------------------------------------------------
// Comments
// ---------------------------------------------------------------------------
let trackPageTrack = null;

function timeAgo(iso) {
  const t = Date.parse(iso);
  if (!t) return '';
  const s = Math.max(0, (Date.now() - t) / 1000);
  const steps = [[60, 'second'], [60, 'minute'], [24, 'hour'], [7, 'day'], [4.35, 'week'], [12, 'month'], [Infinity, 'year']];
  let v = s;
  for (const [n, unit] of steps) {
    if (v < n) { const r = Math.floor(v); return r <= 0 && unit === 'second' ? 'just now' : `${r} ${unit}${r === 1 ? '' : 's'} ago`; }
    v /= n;
  }
  return '';
}

function commentHtml(c) {
  const mine = loggedIn && me && c.user.id === me.id;
  return `<div class="comment${mine ? ' mine' : ''}"><button class="pic" data-go="artist:${c.user.id}" aria-label="${esc(c.user.name)}"${bg(c.user.avatar, 't67x67')}></button>
    <div style="min-width:0"><div class="top"><button class="who" data-go="artist:${c.user.id}">${esc(c.user.name)}</button>${c.at !== null && c.at !== undefined ? `<button class="stamp" data-seek="${c.at}" title="Play from here">at ${fmt(c.at)}</button>` : ''}<span>${esc(timeAgo(c.created))}</span></div>
    <div class="text">${esc(c.body)}</div></div></div>`;
}

// The comment is timed to where the track is now if it is the one playing.
function commentAt() {
  const t = trackPageTrack;
  return t && P.current() && P.current().id === t.id && audio.currentTime > 0 ? Math.floor(audio.currentTime) : null;
}
function updateCommentAt() {
  const el = $('comment-at');
  if (!el) return;
  const at = commentAt();
  el.textContent = at === null ? '' : `at ${fmt(at)}`;
}

function seekComment(at) {
  const t = trackPageTrack;
  if (!t) return;
  if (P.current() && P.current().id === t.id) {
    audio.currentTime = at;
    if (audio.paused) P.toggle();
  } else {
    P.pendingSeek = at;
    P.playList([t], 0, false);
  }
}

async function loadMoreComments(btn, next) {
  btn.disabled = true;
  try {
    const res = await sf.api('comments', trackPageTrack.id, next);
    $('comment-list').insertAdjacentHTML('beforeend', res.items.map(commentHtml).join(''));
    if (res.next) { btn.dataset.moreComments = res.next; btn.disabled = false; } else btn.remove();
  } catch { btn.disabled = false; toast("Couldn't load more comments"); }
}

view.addEventListener('submit', async (e) => {
  if (e.target.id !== 'comment-form') return;
  e.preventDefault();
  const input = $('comment-input');
  const text = input.value.trim();
  if (!text || !trackPageTrack) return;
  const btn = e.target.querySelector('button[type="submit"]');
  btn.disabled = true;
  try {
    const c = await sf.api('postComment', trackPageTrack.id, text, commentAt());
    input.value = '';
    const empty = $('no-comments');
    if (empty) empty.remove();
    $('comment-list').insertAdjacentHTML('afterbegin', commentHtml(c));
    toast('Comment posted');
  } catch (err) {
    toast(/Sign in/.test(err.message) ? 'Sign in to comment' : "Couldn't post your comment");
  } finally {
    btn.disabled = false;
  }
});

// ---------------------------------------------------------------------------
// Add to playlist / new playlist dialog
// ---------------------------------------------------------------------------
const modal = $('modal');
let lastFocus = null;

function closeModal() {
  modal.hidden = true;
  modal.innerHTML = '';
  if (lastFocus) lastFocus.focus();
}
modal.addEventListener('click', (e) => { if (e.target === modal || e.target.closest('[data-close]')) closeModal(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !modal.hidden) closeModal(); }, true);

function findTrack(id) {
  if (P.current() && P.current().id === id) return P.current();
  if (trackPageTrack && trackPageTrack.id === id) return trackPageTrack;
  for (const list of lists.values()) { const t = list.find((x) => x && x.id === id); if (t) return t; }
  return P.queue.find((x) => x.id === id) || null;
}

async function openAddToPlaylist(trackId) {
  if (!loggedIn) return toast('Sign in to use playlists', { label: 'Sign in', fn: login });
  lastFocus = document.activeElement;
  const t = trackId ? findTrack(trackId) : null;
  const head = `<div class="dialog-head"><h2>${trackId ? 'Add to playlist' : 'New playlist'}</h2><button class="icon-btn" data-close aria-label="Close">${icon('close')}</button></div>`;
  const trackBox = t ? `<div class="dialog-track"><div class="thumb"${bg(t.artwork, 't67x67')}></div><div style="min-width:0"><div class="t">${esc(t.title)}</div><div class="s">${esc(t.artist)}</div></div></div>` : '';
  modal.innerHTML = `<div class="dialog" role="dialog" aria-modal="true" aria-label="${trackId ? 'Add to playlist' : 'New playlist'}">${head}${trackBox}<div class="dialog-list" id="pl-list"><div class="hint">Loading your playlists…</div></div></div>`;
  modal.hidden = false;
  if (!trackId) return showCreateForm(null);
  modal.querySelector('[data-close]').focus();
  let pls = [];
  try { pls = await sf.api('myPlaylists'); } catch { $('pl-list').innerHTML = `<div class="hint">Couldn't load your playlists.</div>`; return; }
  if (modal.hidden) return;
  $('pl-list').innerHTML =
    `<button class="pl-item new" data-pl-new><div class="cover">${icon('plus')}</div><div><div class="t">New playlist</div><div class="s">Create one with this track</div></div><span></span></button>` +
    (pls.length ? pls.map((p) => `<button class="pl-item" data-pl="${p.id}"><div class="cover"${bg(p.artwork, 't67x67')}>${p.artwork ? '' : icon('playlists')}</div><div style="min-width:0"><div class="t">${esc(p.title)}</div><div class="s">${plural(p.count, 'track')}</div></div><span class="state"></span></button>`).join('') : `<div class="hint">You don't have any playlists yet.</div>`);
  $('pl-list').onclick = async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if ('plNew' in b.dataset) return showCreateForm(trackId);
    if (!b.dataset.pl || b.disabled) return;
    b.disabled = true;
    try {
      const r = await sf.api('addToPlaylist', Number(b.dataset.pl), trackId);
      b.querySelector('.state').innerHTML = icon('check');
      if (r.already) toast(`Already in “${r.title}”`);
      else { b.querySelector('.s').textContent = plural(r.count, 'track'); toast(`Added to “${r.title}”`); }
    } catch (err) {
      b.disabled = false;
      toast(/full/.test(err.message) ? err.message : "Couldn't add to that playlist");
    }
  };
}

function showCreateForm(trackId) {
  const list = $('pl-list');
  list.outerHTML = `<form class="create-form" id="create-form"><label>Playlist name<input type="text" id="pl-title" maxlength="100" placeholder="My playlist" autocomplete="off" required></label>
    <div class="seg" role="radiogroup" aria-label="Who can see it"><button type="button" class="on" data-share="public" role="radio" aria-checked="true">Public</button><button type="button" data-share="private" role="radio" aria-checked="false">Private</button></div>
    <div class="row-btns"><button type="button" class="btn ghost" data-close>Cancel</button><button type="submit" class="btn primary">Create</button></div></form>`;
  const form = $('create-form');
  let isPrivate = false;
  form.querySelector('.seg').onclick = (e) => {
    const b = e.target.closest('[data-share]');
    if (!b) return;
    isPrivate = b.dataset.share === 'private';
    form.querySelectorAll('[data-share]').forEach((x) => { x.classList.toggle('on', x === b); x.setAttribute('aria-checked', String(x === b)); });
  };
  form.onsubmit = async (e) => {
    e.preventDefault();
    const title = $('pl-title').value.trim();
    if (!title) return $('pl-title').focus();
    const btn = form.querySelector('[type="submit"]');
    btn.disabled = true;
    try {
      const p = await sf.api('createPlaylist', title, isPrivate, trackId ? [trackId] : []);
      closeModal();
      toast(`Created “${p.title || title}”`, p.id ? { label: 'Open', fn: () => router.go('playlist', String(p.id)) } : null);
      if (router.current().name === 'library') render();
    } catch {
      btn.disabled = false;
      toast("Couldn't create the playlist");
    }
  };
  $('pl-title').focus();
}

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
let blurTimer = null;
let lastBlurSent = 0;
view.addEventListener('input', (e) => {
  const el = e.target;
  if (el.dataset.range === 'bgDim') {
    el.nextElementSibling.textContent = el.value + '%';
    settings.bgDim = Number(el.value);
    applyTheme();
  }
  if (el.dataset.range === 'bgBlurAmount') {
    el.nextElementSibling.textContent = el.value + '%';
    settings.bgBlurAmount = Number(el.value);
    // Re-blur while dragging, at most a few times a second.
    clearTimeout(blurTimer);
    const since = performance.now() - lastBlurSent;
    blurTimer = setTimeout(() => { lastBlurSent = performance.now(); sf.setSetting('bgBlurAmount', settings.bgBlurAmount); }, since > 150 ? 0 : 150 - since);
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
// While the mouse is held down on a progress bar, `scrub` is where it points
// (0-1). The bars and times follow it; the track jumps there on release.
let scrub = null;
const trackDuration = () => {
  const t = P.current();
  return audio.duration && isFinite(audio.duration) ? audio.duration : (t && t.duration) || 0;
};
const shownTime = () => (scrub !== null ? scrub * trackDuration() : audio.currentTime);

function updateProgressBar() {
  const t = P.current();
  const dur = trackDuration();
  const pct = dur && t ? Math.min(100, (shownTime() / dur) * 100) : 0;
  $('bb-fill').style.width = pct + '%';
  $('bb-knob').style.left = pct + '%';
  $('bb-t1').textContent = fmt(t ? shownTime() : 0);
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
  if (scrub === null) {
    $('t1').textContent = fmt(audio.currentTime);
    if (settings.panelOpen !== false) drawWave();
    updateProgressBar();
  }
  updateCommentAt();
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
    $('np-title').title = `${t.title} · open track page`;
    $('np-title').dataset.go = `track:${t.id}`;
    $('np-artist').textContent = t.artist;
    $('np-artist').dataset.go = `artist:${t.user.id}`;
    $('t2').textContent = fmt(t.duration);
    document.title = `${t.title} · ${t.artist}`;
  } else {
    artEl.classList.add('empty');
    artEl.innerHTML = icon('disc');
    artEl.style.backgroundImage = '';
    $('np-title').textContent = 'Nothing playing';
    delete $('np-title').dataset.go;
    $('np-artist').textContent = 'Pick a track to start';
    delete $('np-artist').dataset.go;
  }
  const bbArt = $('bb-art');
  bbArt.style.backgroundImage = t && t.artwork ? `url('${img(t.artwork, 't120x120')}')` : '';
  bbArt.innerHTML = t && t.artwork ? '' : icon('disc');
  $('bb-title').textContent = t ? t.title : 'Nothing playing';
  $('bb-title').title = t ? `${t.title} · open track page` : '';
  if (t) $('bb-title').dataset.go = `track:${t.id}`;
  else delete $('bb-title').dataset.go;
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
  const prog = dur ? shownTime() / dur : 0;
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
// Press, hold and drag on a progress bar to choose where to jump to.
function makeScrubbable(el) {
  const at = (e) => { const r = el.getBoundingClientRect(); return Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)); };
  const show = () => {
    $('t1').textContent = fmt(shownTime());
    drawWave();
    updateProgressBar();
  };
  el.addEventListener('pointerdown', (e) => {
    if (!P.current() || e.button !== 0) return;
    e.preventDefault();
    el.setPointerCapture(e.pointerId);
    el.classList.add('scrubbing');
    scrub = at(e);
    show();
    const move = (ev) => { scrub = at(ev); show(); };
    const end = (ev) => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', end);
      el.removeEventListener('pointercancel', end);
      el.classList.remove('scrubbing');
      const target = ev.type === 'pointerup' ? at(ev) : null;
      scrub = null;
      if (target !== null) P.seek(target);
      show();
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
  });
}
makeScrubbable($('wave'));
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
  makeScrubbable(bar);
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
const openComments = async () => {
  if (!P.current()) return;
  router.go('track', P.current().id);
  setTimeout(() => { const c = $('comments'); if (c) c.scrollIntoView({ block: 'start' }); }, 400);
};
for (const id of ['np-add', 'bb-add']) $(id).onclick = () => P.current() && openAddToPlaylist(P.current().id);
for (const id of ['np-comments', 'bb-comments']) $(id).onclick = openComments;
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
for (const id of ['np-add', 'bb-add']) $(id).innerHTML = icon('plus');
for (const id of ['np-comments', 'bb-comments']) $(id).innerHTML = icon('comment');

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
