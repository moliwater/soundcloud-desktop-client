// Small hand-drawn icon set (24x24). Stroke icons unless listed in FILLED.
const ICONS = {
  home: 'M4 10.5 12 4l8 6.5V20h-5v-5.5H9V20H4z',
  feed: 'M5 19.5h.01M5 12.5a6.5 6.5 0 0 1 6.5 6.5M5 5.5A13.5 13.5 0 0 1 18.5 19',
  search: 'M11 4.5a6.5 6.5 0 1 1 0 13 6.5 6.5 0 0 1 0-13zM20 20l-4.4-4.4',
  heart: 'M12 20s-7.5-4.6-7.5-10.2A4.2 4.2 0 0 1 12 7.2a4.2 4.2 0 0 1 7.5 2.6C19.5 15.4 12 20 12 20z',
  playlists: 'M4 6h11M4 11h11M4 16h6M16.5 19.5a2 2 0 1 1 0-.01M18.5 19V8l2.5-.8',
  history: 'M12 4a8 8 0 1 1-7.4 5M4 4.5v4.5h4.5M12 8v4.5l3 2',
  users: 'M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM2.5 20a6.5 6.5 0 0 1 13 0M16 4.3a3.5 3.5 0 0 1 0 6.6M18 14a6 6 0 0 1 3.5 6',
  settings: 'M4 7h9M17 7h3M4 17h3M11 17h9M15 5v4M9 15v4',
  logout: 'M15 4h4v16h-4M10 8l-4 4 4 4M6 12h10',
  login: 'M9 4H5v16h4M14 8l4 4-4 4M18 12H8',
  play: 'M8 5.5v13l10.5-6.5z',
  pause: 'M7 5h3.5v14H7zM13.5 5H17v14h-3.5z',
  prev: 'M6 5h2.2v14H6zM19 5.5v13L9.5 12z',
  next: 'M15.8 5H18v14h-2.2zM5 5.5v13l9.5-6.5z',
  shuffle: 'M4 7h3c4.5 0 5.5 10 10 10h3M17 14l3 3-3 3M4 17h3c1.6 0 2.7-1.3 3.6-3M13.4 10c.9-1.7 2-3 3.6-3h3M17 4l3 3-3 3',
  repeat: 'M5 11.5V9a3 3 0 0 1 3-3h11M16 3l3 3-3 3M19 12.5V15a3 3 0 0 1-3 3H5M8 21l-3-3 3-3',
  volume: 'M4 9.5h3.5L12 5.5v13l-4.5-4H4zM15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11',
  mute: 'M4 9.5h3.5L12 5.5v13l-4.5-4H4zM16 9.5l5 5M21 9.5l-5 5',
  mini: 'M3 5h18v14H3zM12 12h7v5h-7z',
  back: 'M15 5l-7 7 7 7',
  fwd: 'M9 5l7 7-7 7',
  lock: 'M6 11h12v9H6zM8.5 11V8a3.5 3.5 0 0 1 7 0v3',
  external: 'M14 4h6v6M20 4l-9 9M18 14v6H4V6h6',
  disc: 'M12 3.5a8.5 8.5 0 1 1 0 17 8.5 8.5 0 0 1 0-17zM12 10.5a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3z',
  music: 'M9 18.5a2.5 2.5 0 1 1-2.5-2.5H9V5l11-2v13M20 16a2.5 2.5 0 1 1-2.5-2.5H20',
  panel: 'M3 5h18v14H3zM15 5v14',
  close: 'M6 6l12 12M18 6 6 18',
  wifi: 'M2 8.5a15 15 0 0 1 20 0M5.5 12a10 10 0 0 1 13 0M9 15.5a5 5 0 0 1 6 0M12 19h.01',
};
const FILLED = new Set(['play', 'pause', 'prev', 'next']);
function icon(name, extra = '') {
  return `<svg class="i${FILLED.has(name) ? ' f' : ''} ${extra}" viewBox="0 0 24 24" aria-hidden="true"><path d="${ICONS[name]}"/></svg>`;
}
