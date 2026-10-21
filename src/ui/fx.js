'use strict';
// Sound effects for the player: a 10-band equalizer with presets, speed and
// pitch (including the classic "sped up" / "slowed" sound) and reverb.
//
// Speed uses the audio element's own playback rate, which costs nothing. The
// equalizer, a separate pitch shift and reverb run the music through Web
// Audio; that graph is only built the first time one of them is turned on, so
// people who never use them pay nothing for it.
const FX = (() => {
  const BANDS = [32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
  const ZERO = BANDS.map(() => 0);

  // Gains in dB for the bands above.
  const EQ_PRESETS = [
    ['flat', 'Flat', ZERO],
    ['bass', 'Bass boost', [6, 5.5, 4.5, 3, 1, 0, 0, 0, 0, 0]],
    ['bassx', 'Extra bass', [9, 8, 6, 3.5, 1, 0, 0, 0, 0, 0]],
    ['bassless', 'Bass reducer', [-6, -5, -4, -2.5, -1, 0, 0, 0, 0, 0]],
    ['treble', 'Treble boost', [0, 0, 0, 0, 0, 1, 2.5, 4, 5, 6]],
    ['vocal', 'Vocal', [-2, -2, -1, 1, 3, 4, 3.5, 2, 1, 0]],
    ['hiphop', 'Hip-hop', [5, 4.5, 2, 3, -1, -1, 1, -0.5, 1.5, 2.5]],
    ['rnb', 'R&B', [2.5, 6.5, 5, 1.5, -2, -1.5, 2, 2.5, 3, 3.5]],
    ['pop', 'Pop', [-1, -0.5, 0.5, 2, 3.5, 3.5, 2, 0.5, -0.5, -1]],
    ['rock', 'Rock', [4.5, 3.5, 2, 0.5, -1, -0.5, 1.5, 3, 4, 4.5]],
    ['electronic', 'Electronic', [4.5, 4, 1.5, 0, -2, 1.5, 0.5, 1.5, 4, 4.5]],
    ['vshape', 'Bass + treble', [5, 4, 2, 0, -1.5, -1.5, 0, 2, 4, 5]],
    ['acoustic', 'Acoustic', [4, 3.5, 2.5, 1, 1.5, 1.5, 3, 3.5, 3, 2]],
    ['jazz', 'Jazz', [3.5, 2.5, 1, 2, -1.5, -1.5, 0, 1.5, 3, 3.5]],
    ['classical', 'Classical', [4, 3, 2.5, 2, -1, -1, 0, 2, 3, 3.5]],
    ['loudness', 'Loudness', [5, 4, 0, 0, -1.5, 0, -1, -4, 4, 1]],
    ['night', 'Late night', [3, 2, 1, 0, 0, 0, -1, -2, -3, -4]],
    ['small', 'Small speakers', [5, 4, 3.5, 2.5, 1, 0, -1, -2, -3, -4]],
  ];

  // link: pitch follows speed (the "sped up" / "slowed" sound).
  const SPEED_PRESETS = [
    ['daycore', 'Daycore', { speed: 0.75, link: true, pitch: 0, reverb: 0 }],
    ['slowed', 'Slowed', { speed: 0.85, link: true, pitch: 0, reverb: 0 }],
    ['slowrev', 'Slowed + reverb', { speed: 0.85, link: true, pitch: 0, reverb: 45 }],
    ['normal', 'Normal', { speed: 1, link: true, pitch: 0, reverb: 0 }],
    ['sped', 'Sped up', { speed: 1.25, link: true, pitch: 0, reverb: 0 }],
    ['nightcore', 'Nightcore', { speed: 1.35, link: true, pitch: 0, reverb: 0 }],
  ];

  const KEY = 'sf.fx';
  const DEFAULTS = { eqOn: false, eqPreset: 'flat', gains: ZERO.slice(), custom: null, speed: 1, pitch: 0, link: true, reverb: 0 };
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, Number(v) || 0));

  function load() {
    try {
      const s = { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) || '{}') };
      s.gains = Array.isArray(s.gains) && s.gains.length === BANDS.length ? s.gains.map((g) => clamp(g, -12, 12)) : ZERO.slice();
      s.custom = Array.isArray(s.custom) && s.custom.length === BANDS.length ? s.custom.map((g) => clamp(g, -12, 12)) : null;
      s.speed = clamp(s.speed || 1, 0.5, 2);
      s.pitch = Math.round(clamp(s.pitch, -12, 12));
      s.reverb = Math.round(clamp(s.reverb, 0, 100));
      s.link = s.link !== false;
      s.eqOn = !!s.eqOn;
      return s;
    } catch {
      return { ...DEFAULTS, gains: ZERO.slice() };
    }
  }
  function save() {
    try {
      localStorage.setItem(KEY, JSON.stringify(st));
    } catch {
      /* storage unavailable: settings last until the app closes */
    }
  }

  let st = load();
  let audio = null;
  const listeners = [];
  const emit = () => listeners.forEach((fn) => fn(state()));
  const state = () => ({ ...st, gains: st.gains.slice() });

  // ---- Web Audio graph ------------------------------------------------------
  // audio -> preamp -> 10 filters -> [pitch shifter] -> dry ----------> out
  //                                                  \-> reverb -> wet -/
  let ctx = null;
  let filters = [];
  let pre, dry, wet, out, verb, verbTone;
  let shifter = null;
  let wired = '';

  const needsGraph = () => (st.eqOn && st.gains.some((g) => g !== 0)) || (!st.link && st.pitch !== 0) || st.reverb > 0;

  function impulse() {
    // A soft, roomy tail: noise fading out over about 2.6 seconds.
    const sr = ctx.sampleRate;
    const len = Math.floor(sr * 2.6);
    const buf = ctx.createBuffer(2, len, sr);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3);
    }
    return buf;
  }

  // Pitch shift without changing speed: two overlapping read heads glide
  // through a short delay line at the new rate and cross-fade, so the sound is
  // played back higher or lower while keeping time with the music.
  function makeShifter() {
    const node = ctx.createScriptProcessor(4096, 2, 2);
    const W = Math.round(ctx.sampleRate * 0.05); // 50 ms grains
    const SIZE = 1 << 15;
    const MASK = SIZE - 1;
    const bufL = new Float32Array(SIZE);
    const bufR = new Float32Array(SIZE);
    let w = 0;
    let phase = 0;
    const sh = { node, ratio: 1 };
    const read = (buf, pos) => {
      const i = Math.floor(pos);
      const f = pos - i;
      const a = buf[i & MASK];
      return a + (buf[(i + 1) & MASK] - a) * f;
    };
    node.onaudioprocess = (e) => {
      const inp = e.inputBuffer;
      const inL = inp.getChannelData(0);
      const inR = inp.numberOfChannels > 1 ? inp.getChannelData(1) : inL;
      const oL = e.outputBuffer.getChannelData(0);
      const oR = e.outputBuffer.getChannelData(1);
      const step = (1 - sh.ratio) / W;
      for (let i = 0; i < inL.length; i++) {
        bufL[w] = inL[i];
        bufR[w] = inR[i];
        phase += step;
        phase -= Math.floor(phase);
        const p2 = phase >= 0.5 ? phase - 0.5 : phase + 0.5;
        const d1 = w - (phase * W + 2);
        const d2 = w - (p2 * W + 2);
        const s = Math.sin(Math.PI * phase);
        const g1 = s * s;
        const g2 = 1 - g1;
        oL[i] = read(bufL, d1) * g1 + read(bufL, d2) * g2;
        oR[i] = read(bufR, d1) * g1 + read(bufR, d2) * g2;
        w = (w + 1) & MASK;
      }
    };
    return sh;
  }

  function ensureGraph() {
    if (ctx) return true;
    try {
      ctx = new AudioContext({ latencyHint: 'playback' });
      const src = ctx.createMediaElementSource(audio);
      pre = ctx.createGain();
      filters = BANDS.map((f, i) => {
        const b = ctx.createBiquadFilter();
        b.type = i === 0 ? 'lowshelf' : i === BANDS.length - 1 ? 'highshelf' : 'peaking';
        b.frequency.value = f;
        b.Q.value = 1.1;
        b.gain.value = 0;
        return b;
      });
      dry = ctx.createGain();
      wet = ctx.createGain();
      out = ctx.createGain();
      verb = ctx.createConvolver();
      verb.buffer = impulse();
      verbTone = ctx.createBiquadFilter();
      verbTone.type = 'lowpass';
      verbTone.frequency.value = 6500;
      src.connect(pre);
      let node = pre;
      for (const f of filters) {
        node.connect(f);
        node = f;
      }
      verb.connect(verbTone);
      verbTone.connect(wet);
      out.connect(ctx.destination);
      return true;
    } catch (err) {
      console.error('[fx] Web Audio unavailable', err);
      ctx = null;
      return false;
    }
  }

  function rewire() {
    const useShift = !st.link && st.pitch !== 0;
    const useVerb = st.reverb > 0;
    const key = `${useShift}|${useVerb}`;
    if (key === wired) return;
    wired = key;
    const last = filters[filters.length - 1];
    for (const n of [last, shifter && shifter.node, dry, wet]) {
      try {
        if (n) n.disconnect();
      } catch {
        /* not connected */
      }
    }
    let tail = last;
    if (useShift) {
      if (!shifter) shifter = makeShifter();
      tail.connect(shifter.node);
      tail = shifter.node;
    } else if (shifter) {
      shifter.node.onaudioprocess = null;
      shifter = null;
    }
    tail.connect(dry);
    dry.connect(out);
    if (useVerb) {
      tail.connect(verb);
      wet.connect(out);
    }
  }

  function apply() {
    if (!audio) return;
    const rate = clamp(st.speed, 0.5, 2);
    audio.defaultPlaybackRate = rate; // survives loading the next track
    audio.playbackRate = rate;
    audio.preservesPitch = !st.link;
    if (!ctx && !needsGraph()) return;
    if (!ensureGraph()) return;
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    const now = ctx.currentTime;
    const gains = st.eqOn ? st.gains : ZERO;
    filters.forEach((f, i) => f.gain.setTargetAtTime(gains[i], now, 0.03));
    // Leave headroom when boosting so loud songs don't distort.
    const boost = Math.max(0, ...gains);
    pre.gain.setTargetAtTime(Math.pow(10, (-boost * 0.6) / 20), now, 0.03);
    rewire();
    if (shifter) shifter.ratio = Math.pow(2, st.pitch / 12);
    const amount = st.reverb / 100;
    dry.gain.setTargetAtTime(1 - amount * 0.35, now, 0.05);
    wet.gain.setTargetAtTime(amount * 0.9, now, 0.05);
  }

  function set(patch) {
    st = { ...st, ...patch };
    st.speed = Math.round(clamp(st.speed, 0.5, 2) * 100) / 100;
    st.pitch = Math.round(clamp(st.pitch, -12, 12));
    st.reverb = Math.round(clamp(st.reverb, 0, 100));
    save();
    apply();
    emit();
  }

  const presetGains = (id) => {
    if (id === 'custom') return st.custom ? st.custom.slice() : null;
    const p = EQ_PRESETS.find(([pid]) => pid === id);
    return p ? p[2].slice() : null;
  };

  return {
    BANDS,
    EQ_PRESETS,
    SPEED_PRESETS,
    init(el) {
      audio = el;
      // Lets Web Audio read the music (the main process adds the matching
      // permission to SoundCloud's audio responses).
      audio.crossOrigin = 'anonymous';
      audio.addEventListener('play', () => {
        if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {});
      });
      apply();
    },
    state,
    onChange(fn) {
      listeners.push(fn);
    },
    setEqOn(on) {
      set({ eqOn: !!on });
    },
    usePreset(id) {
      const g = presetGains(id);
      if (g) set({ eqOn: true, eqPreset: id, gains: g });
    },
    setBand(i, db) {
      const gains = st.gains.slice();
      gains[i] = clamp(db, -12, 12);
      set({ eqOn: true, eqPreset: 'custom', gains, custom: gains.slice() });
    },
    resetEq() {
      set({ eqPreset: 'flat', gains: ZERO.slice() });
    },
    setSpeed(v) {
      set({ speed: v });
    },
    setPitch(v) {
      set({ pitch: v, link: false });
    },
    setLink(on) {
      set({ link: !!on, pitch: on ? 0 : Math.round(12 * Math.log2(st.speed)) });
    },
    setReverb(v) {
      set({ reverb: v });
    },
    useSpeedPreset(id) {
      const p = SPEED_PRESETS.find(([pid]) => pid === id);
      if (p) set({ ...p[2] });
    },
    resetSpeed() {
      set({ speed: 1, pitch: 0, link: true, reverb: 0 });
    },
    nudgeSpeed(delta) {
      set({ speed: Math.round((st.speed + delta) * 100) / 100 });
    },
    speedPresetId() {
      const p = SPEED_PRESETS.find(([, , v]) => v.speed === st.speed && v.link === st.link && v.reverb === st.reverb && (st.link || st.pitch === 0));
      return p ? p[0] : '';
    },
    // Pitch in semitones that you hear, whichever way it is made.
    heardPitch() {
      return st.link ? 12 * Math.log2(st.speed) : st.pitch;
    },
    eqLabel() {
      if (!st.eqOn) return 'Off';
      if (st.eqPreset === 'custom') return 'Custom';
      const p = EQ_PRESETS.find(([id]) => id === st.eqPreset);
      return p ? p[1] : 'On';
    },
    speedLabel() {
      const parts = [`${st.speed.toFixed(2)}×`];
      if (!st.link && st.pitch) parts.push(`${st.pitch > 0 ? '+' : ''}${st.pitch} st`);
      if (st.reverb) parts.push('reverb');
      return parts.join(' · ');
    },
    eqActive: () => st.eqOn && st.gains.some((g) => g !== 0),
    speedActive: () => st.speed !== 1 || (!st.link && st.pitch !== 0) || st.reverb > 0,
    rate: () => (audio ? audio.playbackRate : 1),
  };
})();
