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
        fetch('/songs.json').then((r) => r.json()),
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

    const sel = document.getElementById('song-select');
    for (const s of this.songs) {
      const o = document.createElement('option');
      o.value = s.id;
      o.textContent = `${s.title} \u2014 ${s.artist}`;
      sel.appendChild(o);
    }
    sel.addEventListener('change', () => {
      const song = this.songs.find((s) => s.id === sel.value);
      if (song) this.selectSong(song);
    });

    document.getElementById('play-btn').addEventListener('click', () => this.togglePlay());
    document.getElementById('auto-btn').addEventListener('click', () => this.toggleAuto());
    document.getElementById('pattern-select').addEventListener('change', (e) => {
      this.autoPlayer.setPattern(e.target.value);
    });
    document.getElementById('strum-width').addEventListener('input', (e) => {
      this.strumHalfWidth = parseFloat(e.target.value);
      this.resize();
    });

    if (this.songs.length) this.selectSong(this.songs[0]);
    this.loop();
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

  selectSong(song) {
    this.currentSong = song;
    if (this.playing) this.togglePlay();
    this.setChord(song.progression[0].chord);
    this.updateProgressionDisplay(-1);
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

    // Map camera Y to the string Y range (vertical strum across horizontal strings).
    // Map camera X (mirrored) to the body X range.
    const rawY = L.stringYs[0] + hand.y * (L.stringYs[5] - L.stringYs[0]);
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

    // Only trigger on DOWN-strums (hand moving downward = Y increasing).
    const isDownStrum = delta > 0.5;

    if (isDownStrum) {
      const speed = Math.abs(delta);
      const vel = Math.min(1, Math.max(0.25, speed / 10));
      const now = performance.now();
      const COOLDOWN = 80;

      for (let s = 0; s < 6; s++) {
        const sy = L.stringYs[s];
        const recentlyPlayed = (now - (this.stringStates[s] || 0)) < COOLDOWN;
        if (prev < sy && curr >= sy && !this.mutedStrings[s] && !recentlyPlayed) {
          this.audio.playString(this.currentBuffers, s, vel);
          this.stringStates[s] = now;

          // Fast strum: schedule all remaining strings with tiny delays
          // so a quick sweep sounds like a real chord strum.
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

    c.drawImage(this.guitarImg, L.imgX, L.imgY, L.imgW, L.imgH);
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

const app = new App();
