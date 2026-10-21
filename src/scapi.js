// SoundCloud data layer for Soundfast's own interface.
//
// Uses the same web API (api-v2) that soundcloud.com itself uses: the public
// "client id" is read from SoundCloud's own scripts, and once you sign in,
// requests carry your session token so likes, feed and library work.
// Responses are trimmed to the few fields the interface needs before they are
// handed over, which keeps the interface's memory small.
const { session } = require('electron');
const store = require('./store');

const API = 'https://api-v2.soundcloud.com';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36';

let clientId = null; // read from settings on first use (after the app has set its data folder)
let clientIdPromise = null;
let meCache = null;
const mediaCache = new Map(); // track id -> { transcodings, auth }
const MEDIA_CACHE_MAX = 600;

// Each signed-in account has its own browser session (its own SoundCloud
// login), so several accounts can stay signed in at once. `active` is the one
// the interface is using right now.
const DEFAULT_PARTITION = 'persist:soundcloud';
let active = DEFAULT_PARTITION;
const ses = (p = active) => session.fromPartition(p);

function setActive(partition) {
  if (partition === active) return;
  active = partition;
  meCache = null;
}
const activePartition = () => active;

async function httpGet(url, headers = {}) {
  return ses().fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json, text/plain, */*', ...headers } });
}

// ---- client id -----------------------------------------------------------

async function discoverClientId() {
  const html = await (await httpGet('https://soundcloud.com/')).text();
  const scripts = [...html.matchAll(/<script[^>]+src="(https:\/\/a-v2\.sndcdn\.com\/assets\/[^"]+\.js)"/g)].map((m) => m[1]);
  for (const src of scripts.reverse()) {
    const js = await (await httpGet(src)).text();
    const m = js.match(/client_id\s*[:=]\s*"([a-zA-Z0-9]{32})"/);
    if (m) return m[1];
  }
  throw new Error('Could not connect to SoundCloud (client id not found)');
}

async function getClientId(refresh = false) {
  if (!clientId && !refresh) clientId = store.get('scClientId') || null;
  if (clientId && !refresh) return clientId;
  if (!clientIdPromise) {
    clientIdPromise = discoverClientId()
      .then((id) => {
        clientId = id;
        store.set('scClientId', id);
        return id;
      })
      .finally(() => {
        clientIdPromise = null;
      });
  }
  return clientIdPromise;
}

// ---- auth ----------------------------------------------------------------

async function getToken(p = active) {
  const cookies = await ses(p).cookies.get({ name: 'oauth_token' });
  const c = cookies.find((x) => /soundcloud\.com$/.test(x.domain.replace(/^\./, '')));
  return c ? c.value : null;
}

async function logout(p = active) {
  if (p === active) meCache = null;
  const s = ses(p);
  const cookies = await s.cookies.get({});
  await Promise.all(
    cookies
      .filter((c) => /soundcloud\.com$/.test(c.domain.replace(/^\./, '')))
      .map((c) => s.cookies.remove(`https://${c.domain.replace(/^\./, '')}${c.path}`, c.name).catch(() => {}))
  );
  await s.clearStorageData({ origins: ['https://soundcloud.com', 'https://secure.soundcloud.com'] }).catch(() => {});
}

// Who is signed in on a given account session (null if nobody).
async function whoAmI(p) {
  if (!(await getToken(p))) return null;
  try {
    return user(await request('/me', { partition: p }));
  } catch (e) {
    if (e.status === 401) return null;
    throw e;
  }
}

// ---- requests ------------------------------------------------------------

async function request(pathOrUrl, { method = 'GET', body, form, auth = true, retry = true, partition = active } = {}) {
  const id = await getClientId();
  let url = pathOrUrl.startsWith('http') ? pathOrUrl : API + pathOrUrl;
  if (!/[?&]client_id=/.test(url)) url += (url.includes('?') ? '&' : '?') + `client_id=${id}`;
  const headers = { 'User-Agent': UA, Accept: 'application/json, text/plain, */*' };
  const token = auth ? await getToken(partition) : null;
  if (token) headers.Authorization = `OAuth ${token}`;
  let payload;
  if (body) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  } else if (form) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded; charset=UTF-8';
    payload = new URLSearchParams(form).toString();
  }
  const res = await ses(partition).fetch(url, { method, headers, body: payload });
  if ((res.status === 401 || res.status === 403) && retry && !token) {
    // The public client id rotates now and then; fetch a fresh one once.
    await getClientId(true);
    return request(pathOrUrl, { method, body, form, auth, retry: false, partition });
  }
  if (!res.ok) {
    const err = new Error(`SoundCloud returned ${res.status}`);
    err.status = res.status;
    throw err;
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

// ---- shaping -------------------------------------------------------------

const art = (url) => (url ? url.replace(/-(large|t\d+x\d+|crop|small|badge|tiny|mini|original)\./, '-{size}.') : '');

function remember(t) {
  if (!t.media) return;
  if (mediaCache.size > MEDIA_CACHE_MAX) mediaCache.delete(mediaCache.keys().next().value);
  mediaCache.set(t.id, { transcodings: t.media.transcodings || [], auth: t.track_authorization });
}

function playability(t) {
  const list = (t.media && t.media.transcodings) || [];
  const plain = list.some((x) => x.format && /^(hls|progressive)$/.test(x.format.protocol));
  if (t.policy === 'BLOCK') return 'blocked';
  if (!list.length) return t.kind === 'track' ? 'unknown' : 'none';
  return plain ? 'ok' : 'protected';
}

function track(t) {
  if (!t || t.kind !== 'track') return null;
  if (!t.title) return { kind: 'track', id: t.id, stub: true };
  remember(t);
  const u = t.user || {};
  const pm = t.publisher_metadata || {};
  return {
    kind: 'track',
    id: t.id,
    title: t.title,
    artist: pm.artist && pm.artist.length < 60 ? pm.artist : u.username || '',
    user: { id: u.id, name: u.username || '', url: u.permalink_url || '' },
    url: t.permalink_url,
    artwork: art(t.artwork_url || u.avatar_url),
    duration: Math.round((t.full_duration || t.duration || 0) / 1000),
    waveform: t.waveform_url || '',
    plays: t.playback_count || 0,
    likes: t.likes_count || 0,
    genre: t.genre || '',
    created: t.created_at || '',
    play: playability(t),
    preview: t.policy === 'SNIP',
  };
}

function user(u) {
  if (!u || u.kind !== 'user') return null;
  return {
    kind: 'user',
    id: u.id,
    name: u.username,
    fullName: u.full_name || '',
    avatar: art(u.avatar_url),
    banner: u.visuals && u.visuals.visuals && u.visuals.visuals[0] ? u.visuals.visuals[0].visual_url : '',
    city: [u.city, u.country_code].filter(Boolean).join(', '),
    followers: u.followers_count || 0,
    following: u.followings_count || 0,
    tracks: u.track_count || 0,
    url: u.permalink_url,
    description: (u.description || '').slice(0, 600),
  };
}

function playlist(p) {
  if (!p) return null;
  if (p.kind === 'system-playlist') {
    return {
      kind: 'system',
      id: p.urn,
      title: p.title || p.short_title || 'Playlist',
      description: p.short_description || p.description || '',
      artwork: art(p.artwork_url || p.calculated_artwork_url || (p.tracks && p.tracks[0] && p.tracks[0].artwork_url)),
      user: { name: (p.user && p.user.username) || 'SoundCloud' },
      count: (p.tracks && p.tracks.length) || 0,
      url: p.permalink_url,
    };
  }
  if (p.kind !== 'playlist') return null;
  const first = (p.tracks || []).find((t) => t && t.artwork_url);
  return {
    kind: 'playlist',
    id: p.id,
    title: p.title,
    isAlbum: !!p.is_album,
    artwork: art(p.artwork_url || (first && first.artwork_url) || (p.user && p.user.avatar_url)),
    user: { id: p.user && p.user.id, name: (p.user && p.user.username) || '' },
    count: p.track_count || (p.tracks && p.tracks.length) || 0,
    url: p.permalink_url,
  };
}

function item(x) {
  if (!x) return null;
  if (x.kind === 'track') return track(x);
  if (x.kind === 'user') return user(x);
  if (x.kind === 'playlist' || x.kind === 'system-playlist') return playlist(x);
  return null;
}

// Fill in tracks that came back as id-only stubs (long playlists do this).
async function fillStubs(list) {
  const missing = list.filter((t) => t && t.stub).map((t) => t.id);
  if (!missing.length) return list;
  const byId = new Map();
  for (let i = 0; i < missing.length; i += 50) {
    const chunk = await request(`/tracks?ids=${missing.slice(i, i + 50).join(',')}`);
    for (const t of chunk || []) byId.set(t.id, track(t));
  }
  return list.map((t) => (t && t.stub ? byId.get(t.id) || null : t)).filter(Boolean);
}

const page = (res, map) => ({ items: (res.collection || []).map(map).filter(Boolean), next: res.next_href || null });

// ---- public methods (called from the interface) --------------------------

const methods = {
  async status() {
    const p = active;
    const token = await getToken(p);
    if (!token) {
      if (p === active) meCache = null;
      return { loggedIn: false };
    }
    if (meCache && p === active) return { loggedIn: true, me: meCache };
    try {
      const u = user(await request('/me', { partition: p }));
      if (p === active) meCache = u;
      return { loggedIn: true, me: u };
    } catch (e) {
      if (e.status === 401) return { loggedIn: false };
      throw e;
    }
  },

  async home() {
    const res = await request('/mixed-selections?limit=10');
    return (res.collection || [])
      .map((s) => ({
        title: s.title || '',
        description: s.description || '',
        items: ((s.items && s.items.collection) || []).map(item).filter(Boolean).slice(0, 12),
      }))
      .filter((s) => s.items.length);
  },

  async feed(next) {
    const res = await request(next || '/stream?limit=30');
    const items = [];
    for (const e of res.collection || []) {
      const x = item(e.track || e.playlist);
      if (x) items.push({ ...x, repostedBy: e.type && e.type.includes('repost') && e.user ? e.user.username : '' });
    }
    return { items, next: res.next_href || null };
  },

  async search(q, kind = 'all', next) {
    const path = { all: '/search', tracks: '/search/tracks', people: '/search/users', playlists: '/search/playlists_without_albums', albums: '/search/albums' }[kind] || '/search';
    const res = await request(next || `${path}?q=${encodeURIComponent(q)}&limit=30`);
    return page(res, item);
  },

  async likes(next) {
    const me = (await methods.status()).me;
    if (!me) return { items: [], next: null };
    const res = await request(next || `/users/${me.id}/track_likes?limit=40`);
    return page(res, (x) => track(x.track));
  },

  async likedIds() {
    try {
      const res = await request('/me/track_likes/ids?limit=5000');
      return (res.collection || res || []).map(Number);
    } catch {
      return [];
    }
  },

  async library(next) {
    const res = await request(next || '/me/library/all?limit=40');
    return page(res, (x) => playlist(x.playlist || x.system_playlist) || item(x));
  },

  async history(next) {
    const res = await request(next || '/me/play-history/tracks?limit=40');
    return page(res, (x) => track(x.track));
  },

  async following(next) {
    const me = (await methods.status()).me;
    if (!me) return { items: [], next: null };
    const res = await request(next || `/users/${me.id}/followings?limit=40`);
    return page(res, user);
  },

  // Followers / following of any user.
  async people(id, kind = 'followers', next) {
    const path = kind === 'following' ? 'followings' : 'followers';
    const res = await request(next || `/users/${id}/${path}?limit=40`);
    return page(res, user);
  },

  async userName(id) {
    const u = await request(`/users/${id}`);
    return { id: u.id, name: u.username, followers: u.followers_count || 0, following: u.followings_count || 0 };
  },

  async track(id) {
    const t = await request(`/tracks/${id}`);
    const x = track(t);
    return x && { ...x, comments: t.comment_count || 0, commentable: t.commentable !== false, description: (t.description || '').slice(0, 2000) };
  },

  async comments(trackId, next) {
    const res = await request(next || `/tracks/${trackId}/comments?threaded=0&sort=newest&limit=30`);
    return {
      items: (res.collection || []).map((c) => ({
        id: c.id,
        body: c.body || '',
        at: typeof c.timestamp === 'number' && isFinite(c.timestamp) ? Math.floor(c.timestamp / 1000) : null,
        created: c.created_at || '',
        user: c.user ? { id: c.user.id, name: c.user.username, avatar: art(c.user.avatar_url) } : { id: c.user_id, name: '', avatar: '' },
      })),
      next: res.next_href || null,
    };
  },

  // Playlists you own (only these can have tracks added).
  async myPlaylists() {
    const me = (await methods.status()).me;
    if (!me) return [];
    const res = await request(`/users/${me.id}/playlists_without_albums?limit=200`);
    return (res.collection || []).filter((p) => p.user && p.user.id === me.id).map(playlist);
  },

  async playlist(id) {
    const isSystem = String(id).startsWith('soundcloud:system-playlists');
    const p = await request(isSystem ? `/system-playlists/${encodeURIComponent(id)}` : `/playlists/${id}?representation=full`);
    const info = playlist(p);
    const tracks = await fillStubs((p.tracks || []).map((t) => (t.title ? track(t) : { kind: 'track', id: t.id, stub: true })));
    return { ...info, count: tracks.length, tracks };
  },

  async artist(id) {
    const [u, top, all] = await Promise.all([
      request(`/users/${id}`),
      request(`/users/${id}/toptracks?limit=10`).catch(() => ({ collection: [] })),
      request(`/users/${id}/tracks?limit=30`).catch(() => ({ collection: [] })),
    ]);
    return { ...user(u), top: page(top, track).items, latest: page(all, track) };
  },

  // Every remaining track after a "Show more" link, fetched 200 at a time,
  // so Play and Shuffle can use a whole list (likes, history, feed, ...).
  async allTracks(next, max = 10000) {
    const big = (u) => (/[?&]limit=\d+/.test(u) ? u.replace(/([?&])limit=\d+/, '$1limit=200') : u + (u.includes('?') ? '&' : '?') + 'limit=200');
    const out = [];
    const seen = new Set();
    let url = next ? big(next) : null;
    while (url && out.length < max) {
      const res = await request(url);
      for (const x of res.collection || []) {
        const t = item(x.track || x.playlist || x);
        if (t && t.kind === 'track' && !seen.has(t.id)) {
          seen.add(t.id);
          out.push(t);
        }
      }
      url = res.next_href ? big(res.next_href) : null;
    }
    return { items: out.slice(0, max), truncated: !!url };
  },

  async more(next) {
    // Generic "load more" for any next_href.
    const res = await request(next);
    return page(res, (x) => item(x.track || x.playlist || x));
  },

  async related(id) {
    const res = await request(`/tracks/${id}/related?limit=20`);
    return page(res, track).items;
  },

  async resolve(url) {
    return item(await request(`/resolve?url=${encodeURIComponent(url)}`));
  },

  async waveform(url) {
    if (!url) return null;
    try {
      const res = await httpGet(url);
      const j = await res.json();
      const s = j.samples || [];
      const out = [];
      const n = 72;
      for (let i = 0; i < n; i++) {
        const slice = s.slice(Math.floor((i * s.length) / n), Math.floor(((i + 1) * s.length) / n));
        out.push(slice.length ? Math.max(...slice) / (j.height || 140) : 0);
      }
      return out;
    } catch {
      return null;
    }
  },

  async stream(id) {
    let m = mediaCache.get(id);
    if (!m) {
      const t = await request(`/tracks/${id}`);
      track(t);
      m = mediaCache.get(id);
    }
    if (!m) throw new Error('Track not found');
    const pick =
      m.transcodings.find((x) => x.format.protocol === 'hls' && /mp4a|aac/.test(x.format.mime_type) && x.quality === 'hq') ||
      m.transcodings.find((x) => x.format.protocol === 'hls' && /mp4a|aac/.test(x.format.mime_type) && x.preset === 'aac_160k') ||
      m.transcodings.find((x) => x.format.protocol === 'hls' && /mp4a|aac/.test(x.format.mime_type)) ||
      m.transcodings.find((x) => x.format.protocol === 'progressive') ||
      m.transcodings.find((x) => x.format.protocol === 'hls');
    if (!pick) {
      const e = new Error('protected');
      e.code = 'PROTECTED';
      throw e;
    }
    const res = await request(`${pick.url}${pick.url.includes('?') ? '&' : '?'}track_authorization=${encodeURIComponent(m.auth || '')}`);
    return { url: res.url, protocol: pick.format.protocol };
  },

  async setLike(trackId, liked) {
    const me = (await methods.status()).me;
    if (!me) throw new Error('Sign in to like tracks');
    await request(`/users/${me.id}/track_likes/${trackId}`, { method: liked ? 'PUT' : 'DELETE' });
    return liked;
  },

  // Request formats below match what soundcloud.com itself sends.
  async postComment(trackId, text, atSeconds) {
    if (!(await getToken())) throw new Error('Sign in to comment');
    const bodyText = String(text || '').trim();
    if (!bodyText) throw new Error('Write something first');
    const form = { body: bodyText };
    if (typeof atSeconds === 'number' && isFinite(atSeconds) && atSeconds >= 0) form.timestamp = String(Math.floor(atSeconds * 1000));
    const c = await request(`/tracks/${trackId}/comments`, { method: 'POST', form });
    const me = (await methods.status()).me;
    return {
      id: c && c.id,
      body: (c && c.body) || bodyText,
      at: c && typeof c.timestamp === 'number' ? Math.floor(c.timestamp / 1000) : form.timestamp ? Math.floor(Number(form.timestamp) / 1000) : null,
      created: (c && c.created_at) || new Date().toISOString(),
      user: me ? { id: me.id, name: me.name, avatar: me.avatar } : { id: 0, name: 'You', avatar: '' },
    };
  },

  async addToPlaylist(playlistId, trackId) {
    if (!(await getToken())) throw new Error('Sign in to edit playlists');
    const p = await request(`/playlists/${playlistId}?representation=full`);
    const ids = (p.tracks || []).map((t) => t.id);
    if (ids.includes(trackId)) return { already: true, title: p.title };
    if (ids.length >= 500) throw new Error('This playlist is full (500 tracks)');
    ids.push(trackId);
    await request(`/playlists/${playlistId}`, { method: 'PUT', body: { playlist: { tracks: ids } } });
    return { added: true, title: p.title, count: ids.length };
  },

  async createPlaylist(title, isPrivate, trackIds = []) {
    if (!(await getToken())) throw new Error('Sign in to create playlists');
    const name = String(title || '').trim();
    if (!name) throw new Error('Give the playlist a name');
    const res = await request('/playlists', {
      method: 'POST',
      body: { playlist: { title: name, sharing: isPrivate ? 'private' : 'public', tracks: trackIds.map((id) => ({ id })), _resource_type: 'playlist' } },
    });
    return playlist(res) || { kind: 'playlist', id: res && res.id, title: name };
  },

  async recordPlay(trackId) {
    if (!(await getToken())) return;
    await request('/me/play-history', { method: 'POST', body: { track_urn: `soundcloud:tracks:${trackId}` } }).catch(() => {});
  },
};

async function call(name, args = []) {
  const fn = methods[name];
  if (!fn) throw new Error(`Unknown method ${name}`);
  return fn(...args);
}

module.exports = { call, getToken, logout, getClientId, whoAmI, setActive, activePartition, DEFAULT_PARTITION };
