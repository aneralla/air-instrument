const BASE_FREQS = [82.41, 110.00, 146.83, 196.00, 246.94, 329.63];
const STRING_NAMES = ['E', 'A', 'D', 'G', 'B', 'e'];
const FINGER_COLORS = ['', '#FF5252', '#448AFF', '#69F0AE', '#FFD740'];
const PARSE_KEYS = ['C#', 'Eb', 'F#', 'Ab', 'Bb', 'C', 'D', 'E', 'F', 'G', 'A', 'B'];
const SMOOTHING = 0.45;
const CHORD_DB_URL =
  'https://cdn.jsdelivr.net/npm/@tombatossals/chords-db@0.5.1/lib/guitar.json';

// Calibration for horizontal guitar.png (player perspective, 2000x684)
// Neck on left, body on right. Low E at top, High e at bottom.
const CAL = {
  fretMidXs: [0.175, 0.215, 0.250, 0.284, 0.315],
  stringTopY: 0.42,
  stringBotY: 0.56,
  bodyCenterX: 0.69,
};

// ── Color presets ───────────────────────────────────────────

// Swatch color = exact color applied via canvas 'color' composite mode.
const COLOR_PRESETS = {
  original:  { label: 'Original',    color: null,      swatch: '#2a9e8f' },
  cherry:    { label: 'Cherry Red',  color: '#cc2222', swatch: '#cc2222' },
  sunburst:  { label: 'Sunburst',    color: '#cc8800', swatch: '#cc8800' },
  ocean:     { label: 'Ocean Blue',  color: '#2255cc', swatch: '#2255cc' },
  blackout:  { label: 'Blackout',    color: '#333333', swatch: '#222222' },
};

function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0;
  const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
    else if (max === g) h = ((b - r) / d + 2) / 6;
    else h = ((r - g) / d + 4) / 6;
  }
  return [h * 360, s, l];
}

function hslToRgb(h, s, l) {
  h /= 360;
  if (s === 0) {
    const v = Math.round(l * 255);
    return [v, v, v];
  }
  const hue2rgb = (p, q, t) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [
    Math.round(hue2rgb(p, q, h + 1 / 3) * 255),
    Math.round(hue2rgb(p, q, h) * 255),
    Math.round(hue2rgb(p, q, h - 1 / 3) * 255),
  ];
}

// ── Chord parser ────────────────────────────────────────────

function parseChordName(name) {
  for (const key of PARSE_KEYS) {
    if (name.startsWith(key)) {
      let suffix = name.slice(key.length);
      if (suffix === '') suffix = 'major';
      else if (suffix === 'm') suffix = 'minor';
      return { key, suffix };
    }
  }
  return null;
}

function lookupChord(db, name) {
  const parsed = parseChordName(name);
  if (!parsed || !db.chords[parsed.key]) return null;
  const entry = db.chords[parsed.key].find((c) => c.suffix === parsed.suffix);
  if (!entry || !entry.positions || !entry.positions.length) return null;
  return entry.positions[0];
}

function actualFret(pos, stringIdx) {
  const f = pos.frets[stringIdx];
  if (f <= 0) return f;
  return f + pos.baseFret - 1;
}

// ── Karplus-Strong audio ────────────────────────────────────

class GuitarAudio {
  constructor() {
    this.ctx = null;
    this.out = null;
    this.cache = {};
  }

  init() {
    this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    const comp = this.ctx.createDynamicsCompressor();
    comp.threshold.value = -10;
    comp.ratio.value = 4;
    comp.connect(this.ctx.destination);
    this.out = comp;
  }

  start() {
    if (!this.ctx) this.init();
    if (this.ctx.state === 'suspended') this.ctx.resume();
  }

  getBuffers(chordName, pos) {
    if (this.cache[chordName]) return this.cache[chordName];
    if (!this.ctx) this.init();
    const bufs = [];
    for (let s = 0; s < 6; s++) {
      const af = actualFret(pos, s);
      if (af < 0) {
        bufs.push(null);
      } else {
        const freq = BASE_FREQS[s] * Math.pow(2, af / 12);
        bufs.push(this.pluck(freq));
      }
    }
    this.cache[chordName] = bufs;
    return bufs;
  }

  pluck(freq, dur = 2.5) {
    const sr = this.ctx.sampleRate;
    const len = Math.floor(sr * dur);
    const buf = this.ctx.createBuffer(1, len, sr);
    const d = buf.getChannelData(0);
    const period = Math.round(sr / freq);
    for (let i = 0; i < period; i++) d[i] = Math.random() * 2 - 1;
    for (let i = period; i < len; i++) {
      d[i] = (d[i - period] + d[i - period + 1]) * 0.5 * 0.996;
    }
    return buf;
  }

  playString(buffers, stringIdx, vel = 0.7, delayMs = 0) {
    if (!this.ctx || !buffers[stringIdx]) return;
    const src = this.ctx.createBufferSource();
    src.buffer = buffers[stringIdx];
    const g = this.ctx.createGain();
    g.gain.value = Math.min(1, Math.max(0.15, vel)) * 0.55;
    src.connect(g);
    g.connect(this.out);
    src.start(this.ctx.currentTime + delayMs / 1000);
  }
}

// ── Hand tracker ────────────────────────────────────────────

class HandTracker {
  constructor(video) {
    this.video = video;
    this.landmarker = null;
  }

  async init() {
    const v = await import(
      'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18/vision_bundle.mjs'
    );
    const fs = await v.FilesetResolver.forVisionTasks(
      'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18/wasm'
    );
    this.landmarker = await v.HandLandmarker.createFromOptions(fs, {
      baseOptions: {
        modelAssetPath:
          'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/latest/hand_landmarker.task',
        delegate: 'GPU',
      },
      runningMode: 'VIDEO',
      numHands: 1,
    });
  }

  async startCamera() {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: 640, height: 480, facingMode: 'user' },
    });
    this.video.srcObject = stream;
    await new Promise((r) => { this.video.onloadeddata = r; });
  }

  detect() {
    if (!this.landmarker || !this.video.videoWidth) return null;
    const res = this.landmarker.detectForVideo(this.video, performance.now());
    if (!res.landmarks || !res.landmarks.length) return null;
    const tip = res.landmarks[0][8];
    return { x: tip.x, y: tip.y };
  }
}

// ── Layout ──────────────────────────────────────────────────

function computeLayout(W, H, imgNatW, imgNatH, strumHalfWidth = 0.07) {
  const pad = 8;
  const scaleW = (W - pad * 2) / imgNatW;
  const scaleH = (H - pad * 2) / imgNatH;
  const scale = Math.min(scaleW, scaleH);
  const imgW = imgNatW * scale;
  const imgH = imgNatH * scale;
  const imgX = (W - imgW) / 2;
  const imgY = (H - imgH) / 2;

  // 6 string Y positions on the image (evenly spaced, low E top to high e bottom)
  const strTop = imgY + imgH * CAL.stringTopY;
  const strBot = imgY + imgH * CAL.stringBotY;
  const stringYs = Array.from({ length: 6 }, (_, i) => strTop + (i / 5) * (strBot - strTop));

  // Strum zone on the body (centered, width controlled by slider)
  const bodyLeft = imgX + imgW * (CAL.bodyCenterX - strumHalfWidth);
  const bodyRight = imgX + imgW * (CAL.bodyCenterX + strumHalfWidth);

  // Fret X positions and neck string Ys (for drawing chord dots)
  const fretXs = CAL.fretMidXs.map((f) => imgX + imgW * f);

  // Chord diagram position (top-left area, near the neck, below top bar)
  const diagW = Math.min(140, imgW * 0.12);
  const diagH = diagW * 1.3;
  const diagX = imgX + imgW * 0.02;
  const diagY = Math.max(8, imgY - diagH - 16);

  return {
    imgX, imgY, imgW, imgH, scale,
    stringYs, bodyLeft, bodyRight,
    fretXs,
    diagX, diagY, diagW, diagH,
  };
}

// ── Chord diagram (compact vertical) ────────────────────────

function drawChordDiagram(ctx, pos, chordName, cx, cy, w, h) {
  if (!pos) return;
  const strings = 6;
  const maxFret = Math.max(4, ...pos.frets.filter((f) => f > 0));
  const sg = w / (strings - 1);
  const fg = h / maxFret;
  const x0 = cx - w / 2;
  const y0 = cy - h / 2;
  const dot = sg * 0.32;

  // Background
  ctx.fillStyle = 'rgba(10, 10, 20, 0.75)';
  ctx.beginPath();
  ctx.roundRect(x0 - 16, y0 - 32, w + 32, h + 52, 8);
  ctx.fill();

  ctx.fillStyle = '#fff';
  ctx.font = `bold ${Math.round(w * 0.2)}px Inter, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';
  ctx.fillText(chordName, cx, y0 - 12);

  if (pos.baseFret === 1) {
    ctx.fillStyle = '#c0c0c0';
    ctx.fillRect(x0 - 1, y0 - 2, w + 2, 3);
  } else {
    ctx.fillStyle = '#888';
    ctx.font = `${Math.round(sg * 0.5)}px Inter, sans-serif`;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillText(`${pos.baseFret}fr`, x0 - 6, y0 + fg * 0.5);
  }

  for (let f = 0; f <= maxFret; f++) {
    ctx.strokeStyle = f === 0 ? 'rgba(255,255,255,0.3)' : 'rgba(255,255,255,0.1)';
    ctx.lineWidth = f === 0 ? 1.2 : 0.8;
    ctx.beginPath();
    ctx.moveTo(x0, y0 + f * fg);
    ctx.lineTo(x0 + w, y0 + f * fg);
    ctx.stroke();
  }

  for (let s = 0; s < strings; s++) {
    ctx.strokeStyle = 'rgba(255,255,255,0.18)';
    ctx.lineWidth = 1.3 - s * 0.1;
    ctx.beginPath();
    ctx.moveTo(x0 + s * sg, y0);
    ctx.lineTo(x0 + s * sg, y0 + h);
    ctx.stroke();
  }

  for (let s = 0; s < strings; s++) {
    const sx = x0 + s * sg;
    const my = y0 - 6;
    if (pos.frets[s] === 0) {
      ctx.strokeStyle = 'rgba(255,255,255,0.5)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(sx, my, 3.5, 0, Math.PI * 2);
      ctx.stroke();
    } else if (pos.frets[s] === -1) {
      ctx.fillStyle = 'rgba(255,80,80,0.5)';
      ctx.font = `bold ${Math.round(sg * 0.55)}px Inter, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('\u00d7', sx, my);
    }
  }

  for (let s = 0; s < strings; s++) {
    const f = pos.frets[s];
    if (f <= 0) continue;
    const sx = x0 + s * sg;
    const fy = y0 + (f - 0.5) * fg;
    const finger = pos.fingers[s];
    ctx.fillStyle = FINGER_COLORS[finger] || '#888';
    ctx.beginPath();
    ctx.arc(sx, fy, dot, 0, Math.PI * 2);
    ctx.fill();
    if (finger > 0) {
      ctx.fillStyle = '#000';
      ctx.font = `bold ${Math.round(dot * 0.9)}px Inter, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(finger, sx, fy);
    }
  }
}

// ── Neck finger dots (on the guitar image) ──────────────────

function drawNeckDots(ctx, pos, layout) {
  if (!pos) return;
  const { fretXs, stringYs } = layout;
  const dotR = Math.max(5, layout.imgH * 0.022);

  for (let s = 0; s < 6; s++) {
    const f = pos.frets[s];
    if (f <= 0 || f > fretXs.length) continue;
    const fx = fretXs[f - 1];
    const fy = stringYs[s];
    const finger = pos.fingers[s];

    ctx.globalAlpha = 0.85;
    ctx.fillStyle = FINGER_COLORS[finger] || '#888';
    ctx.beginPath();
    ctx.arc(fx, fy, dotR, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
  }
}

// ── Strum overlay (body area) ───────────────────────────────

function drawStrumOverlay(ctx, layout, stringStates, mutedStrings, cursor) {
  const { stringYs, bodyLeft, bodyRight } = layout;
  const now = performance.now();

  for (let s = 0; s < 6; s++) {
    const y = stringYs[s];
    const age = now - (stringStates[s] || 0);
    const vibrating = age < 500;
    const muted = mutedStrings[s];

    if (vibrating && !muted) {
      const decay = Math.max(0, 1 - age / 500);
      const amp = 4 * decay;
      ctx.strokeStyle = `rgba(255, 210, 100, ${0.5 + 0.3 * decay})`;
      ctx.lineWidth = 2.5 - s * 0.2;
      ctx.beginPath();
      ctx.moveTo(bodyLeft, y);
      for (let x = bodyLeft; x <= bodyRight; x += 3) {
        ctx.lineTo(x, y + Math.sin(x * 0.06 + now * 0.015) * amp);
      }
      ctx.stroke();
    }
  }

  if (cursor) {
    const glow = ctx.createRadialGradient(cursor.x, cursor.y, 0, cursor.x, cursor.y, 20);
    glow.addColorStop(0, 'rgba(255,255,255,0.35)');
    glow.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(cursor.x, cursor.y, 20, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.beginPath();
    ctx.arc(cursor.x, cursor.y, 4, 0, Math.PI * 2);
    ctx.fill();
  }

  if (!cursor) {
    const midX = (bodyLeft + bodyRight) / 2;
    const botY = stringYs[5] + 22;
    ctx.fillStyle = 'rgba(255,255,255,0.12)';
    ctx.font = '12px Inter, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('Strum \u2191\u2193', midX, botY);
  }
}

// ── Progression timer ───────────────────────────────────────

class ProgressionTimer {
  constructor() {
    this.progression = [];
    this.bpm = 100;
    this.startTime = 0;
    this.running = false;
    this.idx = 0;
    this.beatInChord = 0;
  }

  start(progression, bpm) {
    this.progression = progression;
    this.bpm = bpm;
    this.startTime = performance.now();
    this.running = true;
    this.idx = 0;
    this.beatInChord = 0;
  }

  stop() { this.running = false; }

  update() {
    if (!this.running || !this.progression.length) return;
    const elapsed = (performance.now() - this.startTime) / 1000;
    const beatDur = 60 / this.bpm;
    const totalBeat = elapsed / beatDur;
    const totalBeats = this.progression.reduce((s, c) => s + c.beats, 0);
    const looped = totalBeat % totalBeats;

    let accum = 0;
    for (let i = 0; i < this.progression.length; i++) {
      if (looped < accum + this.progression[i].beats) {
        this.idx = i;
        this.beatInChord = looped - accum;
        return;
      }
      accum += this.progression[i].beats;
    }
  }

  currentChord() { return this.progression[this.idx]; }
  currentBeat() { return Math.floor(this.beatInChord); }
  currentBeatsTotal() { return this.progression[this.idx]?.beats || 4; }
}

// ── Strum patterns ──────────────────────────────────────────

const STRUM_PATTERNS = {
  simple: [
    { beat: 0, dir: 'down' },
    { beat: 1, dir: 'down' },
    { beat: 2, dir: 'down' },
    { beat: 3, dir: 'down' },
  ],
  realistic: [
    { beat: 0,   dir: 'down' },
    { beat: 1,   dir: 'down' },
    { beat: 1.5, dir: 'up'   },
    { beat: 2.5, dir: 'up'   },
    { beat: 3,   dir: 'down' },
    { beat: 3.5, dir: 'up'   },
  ],
};

// ── AutoPlayer ──────────────────────────────────────────────

class AutoPlayer {
  constructor(onStrum) {
    this.onStrum = onStrum;
    this.pattern = STRUM_PATTERNS.realistic;
    this.active = false;
    this.lastBeat = -1;
    this.lastChordIdx = -1;
  }

  setPattern(name) {
    this.pattern = STRUM_PATTERNS[name] || STRUM_PATTERNS.simple;
  }

  start() {
    this.active = true;
    this.lastBeat = -1;
    this.lastChordIdx = -1;
  }

  stop() {
    this.active = false;
  }

  check(beatInChord, chordIdx) {
    if (!this.active) return;

    if (chordIdx !== this.lastChordIdx) {
      this.lastBeat = -1;
      this.lastChordIdx = chordIdx;
    }

    for (const s of this.pattern) {
      if (beatInChord >= s.beat && this.lastBeat < s.beat) {
        this.onStrum(s.dir);
      }
    }
    this.lastBeat = beatInChord;
  }
}

// ── App ─────────────────────────────────────────────────────

class App {
  constructor() {
    this.audio = new GuitarAudio();
    this.tracker = null;
    this.chordDB = null;
    this.songs = [];
    this.guitarImg = null;

    this.canvas = null;
    this.ctx = null;
    this.W = 0;
    this.H = 0;
    this.layout = null;

    this.currentSong = null;
    this.currentChordName = null;
    this.currentPos = null;
    this.currentBuffers = null;
    this.mutedStrings = [false, false, false, false, false, false];

    this.timer = new ProgressionTimer();
    this.lastTimerIdx = -1;
    this.playing = false;

    this.handState = { x: 0, y: 0, prevY: 0, active: false };
    this.stringStates = new Array(6).fill(0);

    this.autoPlayer = new AutoPlayer((dir) => this.triggerAutoStrum(dir));
    this.autoStrum = { active: false, startTime: 0, duration: 60, direction: 'down' };
    this.autoMode = false;
    this.strumHalfWidth = 0.07;

    this.strumCamTop = 0.0;
    this.strumCamBottom = 1.0;
    this.calibrating = false;
    this.calibrateStep = 0;
    this.upStrumEnabled = false;

    this.guitarColor = localStorage.getItem('air-guitar-color') || 'original';
    this.coloredGuitar = null;

    this.init();
  }

  async init() {
    const video = document.getElementById('camera');
    this.tracker = new HandTracker(video);

    const imgPromise = new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = 'guitar.png';
    });

    try {
      const [dbRes, songsRes, img] = await Promise.all([
        fetch(CHORD_DB_URL).then((r) => r.json()),
        fetch('songs.json').then((r) => r.json()),
        imgPromise,
        this.tracker.init(),
      ]);
      this.chordDB = dbRes;
      this.songs = songsRes;
      this.guitarImg = img;
      await this.tracker.startCamera();
    } catch (err) {
      document.getElementById('loading').innerHTML =
        `<p class="error-message">Could not load</p>` +
        `<p class="error-detail">${err.message}</p>`;
      return;
    }

    document.getElementById('loading').classList.add('hidden');
    document.getElementById('main').classList.remove('hidden');

    this.canvas = document.getElementById('guitar-canvas');
    this.ctx = this.canvas.getContext('2d');
    this.resize();
    window.addEventListener('resize', () => this.resize());

    this.setupSongSearch();

    document.getElementById('play-btn').addEventListener('click', () => this.togglePlay());
    document.getElementById('auto-btn').addEventListener('click', () => this.toggleAuto());
    document.getElementById('pattern-select').addEventListener('change', (e) => {
      this.autoPlayer.setPattern(e.target.value);
    });
    document.getElementById('calibrate-btn').addEventListener('click', () => this.startCalibration());
    document.getElementById('upstrum-btn').addEventListener('click', () => {
      this.upStrumEnabled = !this.upStrumEnabled;
      const btn = document.getElementById('upstrum-btn');
      btn.classList.toggle('active', this.upStrumEnabled);
      btn.textContent = this.upStrumEnabled ? 'Up Strum On' : 'Up Strum';
    });

    const calCanvas = document.getElementById('calibrate-canvas');
    calCanvas.addEventListener('click', (e) => this.handleCalibrationClick(e));

    document.querySelectorAll('.color-swatch').forEach((s) => {
      s.addEventListener('click', () => this.setGuitarColor(s.dataset.color));
    });
    document.getElementById('customize-btn').addEventListener('click', () => {
      document.getElementById('customize-panel').classList.toggle('hidden');
    });
    this.setGuitarColor(this.guitarColor);

    this.loadCustomSongs();
    this.setupCustomSongModal();

    if (this.songs.length) this.selectSong(this.songs[0]);
    this.loop();

    this.onboarding = new Onboarding(this);
    if (this.onboarding.shouldShow()) {
      this.onboarding.start();
    }
  }

  resize() {
    const dpr = window.devicePixelRatio || 1;
    const rect = this.canvas.parentElement.getBoundingClientRect();
    this.W = rect.width;
    this.H = rect.height;
    this.canvas.width = this.W * dpr;
    this.canvas.height = this.H * dpr;
    this.canvas.style.width = this.W + 'px';
    this.canvas.style.height = this.H + 'px';
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    if (this.guitarImg) {
      this.layout = computeLayout(this.W, this.H, this.guitarImg.naturalWidth, this.guitarImg.naturalHeight, this.strumHalfWidth);
    }
  }

  async selectSong(song) {
    this.currentSong = song;
    if (this.playing) this.togglePlay();

    if (!song.progression || !song.progression.length) {
      if (song.songsterrId) {
        await this.fetchSongsterrChords(song);
      }
      if (!song.progression || !song.progression.length) {
        song.progression = [{ chord: 'C', beats: 4 }, { chord: 'G', beats: 4 },
          { chord: 'Am', beats: 4 }, { chord: 'F', beats: 4 }];
      }
    }

    this.setChord(song.progression[0].chord);
    this.updateProgressionDisplay(-1);
  }

  async fetchSongsterrChords(song) {
    try {
      const res = await fetch(`/api/chords?songsterrId=${song.songsterrId}`);
      if (!res.ok) return;
      const data = await res.json();
      if (Array.isArray(data.chords) && data.chords.length) {
        song.progression = data.chords.slice(0, 32).map((c) => ({
          chord: c.name || c, beats: 4,
        }));
      }
    } catch { /* fallback handled by caller */ }
  }

  setChord(name) {
    const pos = lookupChord(this.chordDB, name);
    if (!pos) return;
    this.currentChordName = name;
    this.currentPos = pos;
    this.mutedStrings = pos.frets.map((f) => f === -1);
    this.audio.start();
    this.currentBuffers = this.audio.getBuffers(name, pos);
    document.getElementById('chord-name').textContent = name;
  }

  setupSongSearch() {
    const input = document.getElementById('song-search');
    const dropdown = document.getElementById('song-dropdown');
    let searchTimeout = null;

    const showDropdown = (items) => {
      dropdown.innerHTML = '';
      if (!items.length) {
        dropdown.classList.add('hidden');
        return;
      }
      for (const item of items) {
        const div = document.createElement('div');
        div.className = 'song-option';
        div.innerHTML = `<span>${item.title}</span><span class="song-artist">${item.artist}</span>`;
        div.addEventListener('click', () => {
          input.value = `${item.title} — ${item.artist}`;
          dropdown.classList.add('hidden');
          this.selectSong(item);
        });
        dropdown.appendChild(div);
      }
      dropdown.classList.remove('hidden');
    };

    const searchLocal = (q) => {
      const lower = q.toLowerCase();
      return this.songs.filter(
        (s) => s.title.toLowerCase().includes(lower) || s.artist.toLowerCase().includes(lower)
      );
    };

    const searchAPI = async (q) => {
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
        if (!res.ok) return [];
        const data = await res.json();
        return data.songs || [];
      } catch {
        return [];
      }
    };

    input.addEventListener('input', () => {
      const q = input.value.trim();
      if (!q) {
        showDropdown(this.songs.slice(0, 10));
        return;
      }
      const local = searchLocal(q);
      showDropdown(local);

      clearTimeout(searchTimeout);
      searchTimeout = setTimeout(async () => {
        if (local.length >= 3) return;
        const hint = document.createElement('div');
        hint.className = 'song-option searching';
        hint.textContent = 'Searching online...';
        dropdown.appendChild(hint);
        dropdown.classList.remove('hidden');

        const remote = await searchAPI(q);
        if (remote.length) {
          const merged = [...local];
          const localIds = new Set(local.map((s) => s.id));
          for (const r of remote) {
            if (!localIds.has(r.id)) merged.push(r);
          }
          showDropdown(merged);
        } else {
          hint.remove();
          if (!dropdown.children.length) dropdown.classList.add('hidden');
        }
      }, 400);
    });

    input.addEventListener('focus', () => {
      const q = input.value.trim();
      showDropdown(q ? searchLocal(q) : this.songs.slice(0, 10));
    });

    document.addEventListener('click', (e) => {
      if (!e.target.closest('.song-search-wrap')) {
        dropdown.classList.add('hidden');
      }
    });

    if (this.songs.length) {
      input.value = `${this.songs[0].title} — ${this.songs[0].artist}`;
    }
  }

  loadCustomSongs() {
    try {
      const saved = JSON.parse(localStorage.getItem('air-guitar-custom-songs') || '[]');
      for (const s of saved) {
        if (!this.songs.find((x) => x.id === s.id)) {
          this.songs.push(s);
        }
      }
    } catch { /* ignore corrupt data */ }
  }

  saveCustomSongs() {
    const custom = this.songs.filter((s) => s.id.startsWith('custom-'));
    localStorage.setItem('air-guitar-custom-songs', JSON.stringify(custom));
  }

  setupCustomSongModal() {
    const modal = document.getElementById('custom-song-modal');
    const backdrop = modal.querySelector('.modal-backdrop');

    const open = () => modal.classList.remove('hidden');
    const close = () => modal.classList.add('hidden');

    document.getElementById('custom-song-btn').addEventListener('click', open);
    document.getElementById('cs-cancel').addEventListener('click', close);
    backdrop.addEventListener('click', close);

    document.getElementById('cs-save').addEventListener('click', () => {
      const title = document.getElementById('cs-title').value.trim() || 'Untitled';
      const bpm = parseInt(document.getElementById('cs-bpm').value) || 120;
      const chordsRaw = document.getElementById('cs-chords').value.trim();
      if (!chordsRaw) return;

      const chords = chordsRaw.split(/[,\s]+/).filter(Boolean);
      if (!chords.length) return;

      const song = {
        id: `custom-${Date.now()}`,
        title,
        artist: 'Custom',
        bpm,
        progression: chords.map((c) => ({ chord: c, beats: 4 })),
      };

      this.songs.push(song);
      this.saveCustomSongs();
      this.selectSong(song);
      document.getElementById('song-search').value = `${song.title} — Custom`;
      close();

      document.getElementById('cs-title').value = '';
      document.getElementById('cs-chords').value = '';
    });
  }

  setGuitarColor(key) {
    const preset = COLOR_PRESETS[key];
    if (!preset) return;
    this.guitarColor = key;
    localStorage.setItem('air-guitar-color', key);

    if (preset.color && this.guitarImg) {
      const w = this.guitarImg.naturalWidth;
      const h = this.guitarImg.naturalHeight;
      const off = document.createElement('canvas');
      off.width = w;
      off.height = h;
      const oc = off.getContext('2d');
      oc.drawImage(this.guitarImg, 0, 0);
      const imgData = oc.getImageData(0, 0, w, h);
      const px = imgData.data;
      const cr = parseInt(preset.color.slice(1, 3), 16);
      const cg = parseInt(preset.color.slice(3, 5), 16);
      const cb = parseInt(preset.color.slice(5, 7), 16);
      const [tH, tS] = rgbToHsl(cr, cg, cb);
      for (let i = 0; i < px.length; i += 4) {
        if (px[i + 3] < 10) continue;
        const [ph, ps, pl] = rgbToHsl(px[i], px[i + 1], px[i + 2]);
        if (ph >= 130 && ph <= 210 && ps > 0.12 && pl > 0.08 && pl < 0.88) {
          const [nr, ng, nb] = hslToRgb(tH, tS, pl);
          px[i] = nr;
          px[i + 1] = ng;
          px[i + 2] = nb;
        }
      }
      oc.putImageData(imgData, 0, 0);
      this.coloredGuitar = off;
    } else {
      this.coloredGuitar = null;
    }

    document.querySelectorAll('.color-swatch').forEach((s) => {
      s.classList.toggle('active', s.dataset.color === key);
    });
  }

  togglePlay() {
    const btn = document.getElementById('play-btn');
    if (this.playing) {
      this.playing = false;
      this.timer.stop();
      btn.textContent = 'Play';
      btn.classList.remove('active');
      if (this.autoMode) this.toggleAuto();
    } else {
      this.playing = true;
      this.audio.start();
      this.timer.start(this.currentSong.progression, this.currentSong.bpm);
      this.lastTimerIdx = -1;
      btn.textContent = 'Stop';
      btn.classList.add('active');
    }
  }

  toggleAuto() {
    const btn = document.getElementById('auto-btn');
    if (this.autoMode) {
      this.autoMode = false;
      this.autoPlayer.stop();
      btn.textContent = 'Auto';
      btn.classList.remove('active');
    } else {
      this.autoMode = true;
      this.autoPlayer.start();
      btn.textContent = 'Auto Off';
      btn.classList.add('active');
      if (!this.playing) this.togglePlay();
    }
  }

  startCalibration() {
    const overlay = document.getElementById('calibrate-overlay');
    const calVideo = document.getElementById('calibrate-video');
    const calCanvas = document.getElementById('calibrate-canvas');
    const btn = document.getElementById('calibrate-btn');

    calVideo.srcObject = this.tracker.video.srcObject;
    overlay.classList.remove('hidden');
    btn.classList.add('active');

    const rect = overlay.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    calCanvas.width = rect.width * dpr;
    calCanvas.height = rect.height * dpr;
    calCanvas.style.width = rect.width + 'px';
    calCanvas.style.height = rect.height + 'px';
    const ctx = calCanvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, rect.width, rect.height);

    this.calibrating = true;
    this.calibrateStep = 0;
    document.getElementById('calibrate-hint').textContent = 'Click the TOP of your strum area';
  }

  handleCalibrationClick(e) {
    if (!this.calibrating) return;

    const canvas = document.getElementById('calibrate-canvas');
    const rect = canvas.getBoundingClientRect();
    const clickY = (e.clientY - rect.top) / rect.height;

    const dpr = window.devicePixelRatio || 1;
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const pxY = e.clientY - rect.top;

    if (this.calibrateStep === 0) {
      this.strumCamTop = clickY;
      ctx.strokeStyle = 'rgba(0, 212, 255, 0.8)';
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 4]);
      ctx.beginPath();
      ctx.moveTo(0, pxY);
      ctx.lineTo(rect.width, pxY);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = 'rgba(0, 212, 255, 0.9)';
      ctx.font = '12px Inter, sans-serif';
      ctx.textBaseline = 'bottom';
      ctx.fillText('Top', 8, pxY - 4);
      this.calibrateStep = 1;
      document.getElementById('calibrate-hint').textContent = 'Click the BOTTOM of your strum area';
    } else {
      this.strumCamBottom = Math.max(clickY, this.strumCamTop + 0.05);

      ctx.strokeStyle = 'rgba(0, 255, 136, 0.8)';
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 4]);
      ctx.beginPath();
      ctx.moveTo(0, pxY);
      ctx.lineTo(rect.width, pxY);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = 'rgba(0, 255, 136, 0.9)';
      ctx.font = '12px Inter, sans-serif';
      ctx.textBaseline = 'top';
      ctx.fillText('Bottom', 8, pxY + 4);

      document.getElementById('calibrate-hint').textContent = 'Calibrated! Closing...';
      setTimeout(() => this.finishCalibration(), 600);
    }
  }

  finishCalibration() {
    document.getElementById('calibrate-overlay').classList.add('hidden');
    document.getElementById('calibrate-btn').classList.remove('active');
    this.calibrating = false;
    this.calibrateStep = 0;
  }

  triggerAutoStrum(direction) {
    if (!this.currentBuffers || !this.layout) return;
    const L = this.layout;
    const vel = 0.65;
    const msPerString = 5;

    if (direction === 'down') {
      for (let s = 0; s < 6; s++) {
        if (!this.mutedStrings[s]) {
          this.audio.playString(this.currentBuffers, s, vel, s * msPerString);
          this.stringStates[s] = performance.now() + s * msPerString;
        }
      }
    } else {
      for (let s = 5; s >= 0; s--) {
        if (!this.mutedStrings[s]) {
          const delay = (5 - s) * msPerString;
          this.audio.playString(this.currentBuffers, s, vel * 0.85, delay);
          this.stringStates[s] = performance.now() + delay;
        }
      }
    }

    this.autoStrum = {
      active: true,
      startTime: performance.now(),
      duration: 60,
      direction,
    };
  }

  updateProgressionDisplay(activeIdx) {
    const el = document.getElementById('progression');
    el.innerHTML = '';
    if (!this.currentSong) return;
    this.currentSong.progression.forEach((c, i) => {
      const pill = document.createElement('span');
      pill.className = 'chord-pill';
      if (i === activeIdx) pill.classList.add('active');
      else if (i < activeIdx) pill.classList.add('past');
      else if (i === activeIdx + 1) pill.classList.add('next');
      pill.textContent = c.chord;
      pill.style.cursor = 'pointer';
      pill.addEventListener('click', () => this.setChord(c.chord));
      el.appendChild(pill);
    });
  }

  updateBeatDots(beat, total) {
    const dots = document.querySelectorAll('#beat-dots .dot');
    dots.forEach((d, i) => {
      d.classList.toggle('on', i < Math.min(beat + 1, total));
    });
  }

  processStrum(hand) {
    if (!this.layout) return null;
    const L = this.layout;

    // Normalize hand.y through calibrated bounds, then map to string Y range.
    const normalizedY = (hand.y - this.strumCamTop) / (this.strumCamBottom - this.strumCamTop);
    const clampedNY = Math.max(-0.1, Math.min(1.1, normalizedY));
    const rawY = L.stringYs[0] + clampedNY * (L.stringYs[5] - L.stringYs[0]);
    const rawX = L.bodyLeft + (1 - hand.x) * (L.bodyRight - L.bodyLeft);
    const clampedX = Math.max(L.bodyLeft, Math.min(L.bodyRight, rawX));

    if (!this.handState.active) {
      this.handState = { x: clampedX, y: rawY, prevY: rawY, active: true, strumDir: 0 };
      return { x: clampedX, y: rawY };
    }

    this.handState.prevY = this.handState.y;
    this.handState.y = this.handState.y * SMOOTHING + rawY * (1 - SMOOTHING);
    this.handState.x = this.handState.x * SMOOTHING + clampedX * (1 - SMOOTHING);

    if (!this.currentBuffers) return { x: this.handState.x, y: this.handState.y };

    const prev = this.handState.prevY;
    const curr = this.handState.y;
    const delta = curr - prev;
    const speed = Math.abs(delta);

    const isDownStrum = delta > 0.5;
    const isUpStrum = this.upStrumEnabled && delta < -0.5;

    if (isDownStrum || isUpStrum) {
      const vel = Math.min(1, Math.max(0.25, speed / 10));
      const now = performance.now();
      const COOLDOWN = 80;

      if (isDownStrum) {
        for (let s = 0; s < 6; s++) {
          const sy = L.stringYs[s];
          const recentlyPlayed = (now - (this.stringStates[s] || 0)) < COOLDOWN;
          if (prev < sy && curr >= sy && !this.mutedStrings[s] && !recentlyPlayed) {
            this.audio.playString(this.currentBuffers, s, vel);
            this.stringStates[s] = now;
            if (speed > 1.5) {
              const msPerString = Math.max(3, Math.min(18, 40 / speed));
              for (let r = s + 1; r < 6; r++) {
                if (!this.mutedStrings[r]) {
                  const delay = (r - s) * msPerString;
                  this.audio.playString(this.currentBuffers, r, vel * 0.97, delay);
                  this.stringStates[r] = now + delay;
                }
              }
              break;
            }
          }
        }
      } else {
        for (let s = 5; s >= 0; s--) {
          const sy = L.stringYs[s];
          const recentlyPlayed = (now - (this.stringStates[s] || 0)) < COOLDOWN;
          if (prev > sy && curr <= sy && !this.mutedStrings[s] && !recentlyPlayed) {
            this.audio.playString(this.currentBuffers, s, vel * 0.85);
            this.stringStates[s] = now;
            if (speed > 1.5) {
              const msPerString = Math.max(3, Math.min(18, 40 / speed));
              for (let r = s - 1; r >= 0; r--) {
                if (!this.mutedStrings[r]) {
                  const delay = (s - r) * msPerString;
                  this.audio.playString(this.currentBuffers, r, vel * 0.82, delay);
                  this.stringStates[r] = now + delay;
                }
              }
              break;
            }
          }
        }
      }
    }

    return { x: this.handState.x, y: this.handState.y };
  }

  loop() {
    requestAnimationFrame(() => this.loop());

    if (this.playing) {
      this.timer.update();
      const idx = this.timer.idx;
      if (idx !== this.lastTimerIdx) {
        this.lastTimerIdx = idx;
        const ch = this.timer.currentChord();
        if (ch) this.setChord(ch.chord);
        this.updateProgressionDisplay(idx);
      }
      this.updateBeatDots(this.timer.currentBeat(), this.timer.currentBeatsTotal());

      if (this.autoMode) {
        this.autoPlayer.check(this.timer.beatInChord, this.timer.idx);
      }
    }

    const c = this.ctx;
    c.clearRect(0, 0, this.W, this.H);

    if (!this.layout || !this.guitarImg) return;
    const L = this.layout;

    c.drawImage(this.coloredGuitar || this.guitarImg, L.imgX, L.imgY, L.imgW, L.imgH);
    drawNeckDots(c, this.currentPos, L);

    if (L.diagW > 50) {
      drawChordDiagram(
        c, this.currentPos, this.currentChordName,
        L.diagX + L.diagW / 2, L.diagY + L.diagH / 2,
        L.diagW, L.diagH
      );
    }

    let cursor = null;

    if (this.autoStrum.active) {
      const elapsed = performance.now() - this.autoStrum.startTime;
      const t = Math.min(1, elapsed / this.autoStrum.duration);
      const midX = (L.bodyLeft + L.bodyRight) / 2;
      let cursorY;
      if (this.autoStrum.direction === 'down') {
        cursorY = L.stringYs[0] + t * (L.stringYs[5] - L.stringYs[0]);
      } else {
        cursorY = L.stringYs[5] - t * (L.stringYs[5] - L.stringYs[0]);
      }
      cursor = { x: midX, y: cursorY };
      if (t >= 1) this.autoStrum.active = false;
    }

    if (!this.autoMode) {
      const hand = this.tracker.detect();
      if (hand) {
        cursor = this.processStrum(hand);
      } else {
        this.handState.active = false;
      }
    }

    drawStrumOverlay(c, L, this.stringStates, this.mutedStrings, cursor);
  }
}

// ── Onboarding ──────────────────────────────────────────────

class Onboarding {
  constructor(app) {
    this.app = app;
    this.step = 0;
    this.totalSteps = 5;
    this.overlay = document.getElementById('onboarding');
    this.cards = this.overlay.querySelectorAll('.ob-card');
    this.dotsContainer = document.getElementById('ob-dots');
    this.calStep = 0;

    this.buildDots();
    this.bindButtons();
    this.bindCalibration();
  }

  shouldShow() {
    return !localStorage.getItem('air-guitar-onboarded');
  }

  start() {
    this.step = 0;
    this.overlay.classList.remove('hidden');
    this.showStep(0);
  }

  buildDots() {
    this.dotsContainer.innerHTML = '';
    for (let i = 0; i < this.totalSteps; i++) {
      const dot = document.createElement('span');
      dot.className = 'ob-dot';
      this.dotsContainer.appendChild(dot);
    }
  }

  updateDots() {
    const dots = this.dotsContainer.querySelectorAll('.ob-dot');
    dots.forEach((d, i) => {
      d.classList.toggle('active', i === this.step);
      d.classList.toggle('done', i < this.step);
    });
  }

  showStep(idx) {
    this.step = idx;
    this.cards.forEach((c) => c.classList.remove('active'));
    const card = this.cards[idx];
    if (card) {
      card.classList.add('active');
      card.style.animation = 'none';
      card.offsetHeight;
      card.style.animation = '';
    }
    this.updateDots();

    if (idx === 1) this.setupCameraPreview();
    if (idx === 2) this.setupCalibration();
  }

  bindButtons() {
    this.overlay.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-action]');
      if (!btn) return;
      const action = btn.dataset.action;
      if (action === 'next') this.next();
      else if (action === 'skip') this.finish();
      else if (action === 'done') this.finish();
    });
  }

  next() {
    if (this.step < this.totalSteps - 1) {
      this.showStep(this.step + 1);
    } else {
      this.finish();
    }
  }

  finish() {
    this.overlay.classList.add('hidden');
    localStorage.setItem('air-guitar-onboarded', '1');
  }

  setupCameraPreview() {
    const video = document.getElementById('ob-camera-preview');
    if (this.app.tracker && this.app.tracker.video.srcObject) {
      video.srcObject = this.app.tracker.video.srcObject;
    }
  }

  setupCalibration() {
    const video = document.getElementById('ob-cal-video');
    const canvas = document.getElementById('ob-cal-canvas');
    const hint = document.getElementById('ob-cal-hint');

    if (this.app.tracker && this.app.tracker.video.srcObject) {
      video.srcObject = this.app.tracker.video.srcObject;
    }

    const rect = canvas.parentElement.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    canvas.style.width = rect.width + 'px';
    canvas.style.height = rect.height + 'px';
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, rect.width, rect.height);

    this.calStep = 0;
    hint.textContent = 'Click the TOP of your strum area';

    const nextBtn = this.cards[2].querySelector('[data-action="next"]');
    nextBtn.disabled = true;
  }

  bindCalibration() {
    const canvas = document.getElementById('ob-cal-canvas');
    canvas.addEventListener('click', (e) => {
      if (this.step !== 2) return;

      const rect = canvas.getBoundingClientRect();
      const clickY = (e.clientY - rect.top) / rect.height;
      const pxY = e.clientY - rect.top;
      const hint = document.getElementById('ob-cal-hint');

      const dpr = window.devicePixelRatio || 1;
      const ctx = canvas.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      if (this.calStep === 0) {
        this.app.strumCamTop = clickY;
        ctx.strokeStyle = 'rgba(0, 212, 255, 0.8)';
        ctx.lineWidth = 2;
        ctx.setLineDash([6, 4]);
        ctx.beginPath();
        ctx.moveTo(0, pxY);
        ctx.lineTo(rect.width, pxY);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = 'rgba(0, 212, 255, 0.9)';
        ctx.font = '12px Inter, sans-serif';
        ctx.textBaseline = 'bottom';
        ctx.fillText('Top', 8, pxY - 4);
        this.calStep = 1;
        hint.textContent = 'Click the BOTTOM of your strum area';
      } else if (this.calStep === 1) {
        this.app.strumCamBottom = Math.max(clickY, this.app.strumCamTop + 0.05);
        ctx.strokeStyle = 'rgba(0, 255, 136, 0.8)';
        ctx.lineWidth = 2;
        ctx.setLineDash([6, 4]);
        ctx.beginPath();
        ctx.moveTo(0, pxY);
        ctx.lineTo(rect.width, pxY);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = 'rgba(0, 255, 136, 0.9)';
        ctx.font = '12px Inter, sans-serif';
        ctx.textBaseline = 'top';
        ctx.fillText('Bottom', 8, pxY + 4);
        this.calStep = 2;
        hint.textContent = 'Calibrated!';

        const nextBtn = this.cards[2].querySelector('[data-action="next"]');
        nextBtn.disabled = false;
      }
    });
  }
}

const app = new App();
