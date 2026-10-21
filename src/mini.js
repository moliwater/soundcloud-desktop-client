const $ = (id) => document.getElementById(id);
const PLAY = '<path d="M8 5v14l11-7z"/>';
const PAUSE = '<path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z"/>';

let current = {};
let shownArt = null;

function fmt(secs) {
  secs = Math.max(0, Math.floor(secs || 0));
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = String(secs % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

function render(s) {
  current = s || {};
  document.body.classList.toggle('idle', !current.hasTrack);
  $('title').textContent = current.hasTrack ? current.title : 'Nothing playing';
  $('artist').textContent = current.hasTrack ? current.artist || 'SoundCloud' : 'Pick something on SoundCloud';
  $('title').title = $('title').textContent;
  document.title = current.hasTrack ? `${current.title} — Soundfast` : 'Soundfast mini player';

  $('playIcon').innerHTML = current.playing ? PAUSE : PLAY;
  $('play').title = current.playing ? 'Pause' : 'Play';
  $('play').setAttribute('aria-label', $('play').title);

  $('like').classList.toggle('on', !!current.liked);
  $('like').title = current.liked ? 'Unlike' : 'Like';
  $('like').style.visibility = current.canLike ? 'visible' : 'hidden';

  const art = current.artwork || '';
  if (art !== shownArt) {
    shownArt = art;
    const safe = art.replace(/["\\\n]/g, '');
    $('art').style.backgroundImage = safe ? `url("${safe}")` : '';
    $('art').classList.toggle('empty', !safe);
    $('backdrop').style.backgroundImage = safe ? `url("${safe}")` : '';
  }

  const dur = current.duration || 0;
  const pos = current.position || 0;
  $('fill').style.width = dur ? `${Math.min(100, (pos / dur) * 100)}%` : '0%';
  $('time').textContent = current.hasTrack && dur ? `${fmt(pos)} / ${fmt(dur)}` : '';
}

const send = (name, arg) => window.soundfast.command(name, arg);
$('play').onclick = () => send('playPause');
$('prev').onclick = () => send('prev');
$('next').onclick = () => send('next');
$('like').onclick = () => send('like');
$('art').onclick = () => current.hasTrack && send('openTrack');
$('expand').onclick = () => send('expand');
$('close').onclick = () => send('close');
$('pin').onclick = () => send('pin');
$('bar').onclick = (e) => {
  if (!current.hasTrack) return;
  const r = $('bar').getBoundingClientRect();
  send('seek', (e.clientX - r.left) / r.width);
};

document.addEventListener('keydown', (e) => {
  if (e.key === ' ' || e.key === 'k') { e.preventDefault(); send('playPause'); }
  else if (e.key === 'ArrowRight') send('next');
  else if (e.key === 'ArrowLeft') send('prev');
  else if (e.key === 'Escape') send('close');
});

window.soundfast.onState(render);
window.soundfast.onPinned((on) => $('pin').classList.toggle('on', on));
window.soundfast.isPinned().then((on) => $('pin').classList.toggle('on', !!on));
render({});
