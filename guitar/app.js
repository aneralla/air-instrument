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

const TONE_PRESETS = {
  warm:   { lpFreq: 2800, shelfFreq: 3000, shelfGain: -4, reverbMix: 0.25, label: 'Warm' },
  clean:  { lpFreq: 5000, shelfFreq: 3500, shelfGain: 0,  reverbMix: 0.15, label: 'Clean' },
  bright: { lpFreq: 8000, shelfFreq: 3000, shelfGain: 6,  reverbMix: 0.10, label: 'Bright' },
};
const TONE_NAMES = Object.keys(TONE_PRESETS);

class GuitarAudio {
  constructor() {
    this.ctx = null;
    this.out = null;
    this.cache = {};
    this.toneName = 'clean';
  }

  init() {
    this.ctx = new (window.AudioContext || window.webkitAudioContext)();

    const comp = this.ctx.createDynamicsCompressor();
    comp.threshold.value = -10;
    comp.ratio.value = 4;
    comp.connect(this.ctx.destination);

    this.lowpass = this.ctx.createBiquadFilter();
    this.lowpass.type = 'lowpass';

    this.shelf = this.ctx.createBiquadFilter();
    this.shelf.type = 'highshelf';

    this.reverbGain = this.ctx.createGain();
    this.dryGain = this.ctx.createGain();

    const reverbLen = this.ctx.sampleRate * 1.8;
    const reverbBuf = this.ctx.createBuffer(2, reverbLen, this.ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = reverbBuf.getChannelData(ch);
      for (let i = 0; i < reverbLen; i++) {
        d[i] = (Math.random() * 2 - 1) * Math.exp(-i / (this.ctx.sampleRate * 0.6));
      }
    }
    this.convolver = this.ctx.createConvolver();
    this.convolver.buffer = reverbBuf;

    this.lowpass.connect(this.shelf);
    this.shelf.connect(this.dryGain);
    this.shelf.connect(this.convolver);
    this.convolver.connect(this.reverbGain);
    this.dryGain.connect(comp);
    this.reverbGain.connect(comp);

    this.out = this.lowpass;
    this.applyTone(this.toneName);
  }

  applyTone(name) {
    const p = TONE_PRESETS[name] || TONE_PRESETS.clean;
    this.toneName = name;
    if (!this.ctx) return;
    this.lowpass.frequency.value = p.lpFreq;
    this.shelf.frequency.value = p.shelfFreq;
    this.shelf.gain.value = p.shelfGain;
    this.dryGain.gain.value = 1 - p.reverbMix;
    this.reverbGain.gain.value = p.reverbMix;
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

  playClick(accent = false) {
    if (!this.ctx) return;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = accent ? 1200 : 800;
    g.gain.setValueAtTime(accent ? 0.18 : 0.12, this.ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + 0.04);
    osc.connect(g);
    g.connect(this.ctx.destination);
    osc.start(this.ctx.currentTime);
    osc.stop(this.ctx.currentTime + 0.04);
  }

  playChuck(isDown = true) {
    if (!this.ctx) return;
    const bufLen = Math.floor(this.ctx.sampleRate * 0.035);
    const buf = this.ctx.createBuffer(1, bufLen, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < bufLen; i++) {
      d[i] = (Math.random() * 2 - 1) * Math.exp(-i / (this.ctx.sampleRate * 0.006));
    }
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = isDown ? 800 : 1200;
    filter.Q.value = 2;
    const g = this.ctx.createGain();
    g.gain.value = isDown ? 0.10 : 0.07;
    src.connect(filter);
    filter.connect(g);
    g.connect(this.ctx.destination);
    src.start(this.ctx.currentTime);
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
  const patX = diagX;
  const patY = diagY + diagH + 8;
  const patW = Math.max(diagW, 160);
  const tlY = patY + 44;

  const bodyMidX = (bodyLeft + bodyRight) / 2;

  return {
    imgX, imgY, imgW, imgH, scale,
    stringYs, bodyLeft, bodyRight, bodyMidX,
    fretXs,
    patX, patY, patW, tlY,
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

function drawGhostDots(ctx, pos, layout) {
  if (!pos) return;
  const { fretXs, stringYs } = layout;
  const dotR = Math.max(5, layout.imgH * 0.022);

  ctx.save();
  ctx.globalAlpha = 0.25;
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 2;

  for (let s = 0; s < 6; s++) {
    const f = pos.frets[s];
    if (f <= 0 || f > fretXs.length) continue;
    const fx = fretXs[f - 1];
    const fy = stringYs[s];

    ctx.beginPath();
    ctx.arc(fx, fy, dotR + 2, 0, Math.PI * 2);
    ctx.stroke();
  }

  ctx.restore();
}

// ── Strum overlay (body area) ───────────────────────────────

function drawStrumPattern(ctx, patternName, beatInChord, x, y, w) {
  const pat = STRUM_PATTERNS[patternName];
  if (!pat) return;
  const slots = pat.slots;
  const n = slots.length;
  const slotW = w / n;
  const fontSize = Math.max(10, Math.min(14, slotW * 0.7));
  const arrowSize = fontSize * 1.1;

  ctx.save();
  ctx.font = `600 ${Math.round(fontSize * 0.65)}px Inter, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';

  for (let i = 0; i < n; i++) {
    const cx = x + i * slotW + slotW / 2;
    const beatVal = i * 0.5;
    const isActive = beatInChord >= 0 && beatInChord >= beatVal && beatInChord < beatVal + 0.5;
    const slot = slots[i];

    if (i % 2 === 0) {
      ctx.fillStyle = isActive ? 'rgba(0,212,255,0.7)' : 'rgba(255,255,255,0.25)';
      ctx.fillText(`${i / 2 + 1}`, cx, y);
    } else {
      ctx.fillStyle = isActive ? 'rgba(0,212,255,0.5)' : 'rgba(255,255,255,0.15)';
      ctx.fillText('&', cx, y);
    }

    const ay = y + fontSize + 4;
    if (slot === 'D') {
      ctx.fillStyle = isActive ? '#00d4ff' : 'rgba(255,255,255,0.55)';
      ctx.beginPath();
      ctx.moveTo(cx, ay);
      ctx.lineTo(cx - arrowSize * 0.35, ay);
      ctx.lineTo(cx, ay + arrowSize * 0.7);
      ctx.lineTo(cx + arrowSize * 0.35, ay);
      ctx.closePath();
      ctx.fill();
    } else if (slot === 'U') {
      ctx.fillStyle = isActive ? '#00ff88' : 'rgba(255,255,255,0.45)';
      ctx.beginPath();
      ctx.moveTo(cx, ay + arrowSize * 0.7);
      ctx.lineTo(cx - arrowSize * 0.35, ay + arrowSize * 0.7);
      ctx.lineTo(cx, ay);
      ctx.lineTo(cx + arrowSize * 0.35, ay + arrowSize * 0.7);
      ctx.closePath();
      ctx.fill();
    } else {
      ctx.fillStyle = isActive ? 'rgba(0,212,255,0.3)' : 'rgba(255,255,255,0.1)';
      ctx.fillRect(cx - 1, ay + arrowSize * 0.25, 2, arrowSize * 0.2);
    }
  }

  ctx.font = `500 ${Math.round(fontSize * 0.55)}px Inter, sans-serif`;
  ctx.fillStyle = 'rgba(255,255,255,0.35)';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText(pat.label, x, y + fontSize + arrowSize + 8);

  ctx.restore();
}

function drawBeatTimeline(ctx, patternName, beatInChord, totalBeats, x, y, w) {
  if (beatInChord < 0 || totalBeats <= 0) return;
  const pat = STRUM_PATTERNS[patternName];
  if (!pat) return;

  const h = 14;
  const frac = beatInChord / totalBeats;

  ctx.save();

  ctx.fillStyle = 'rgba(255,255,255,0.04)';
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = 'rgba(255,255,255,0.08)';
  ctx.strokeRect(x, y, w, h);

  for (let b = 0; b <= totalBeats; b++) {
    const bx = x + (b / totalBeats) * w;
    ctx.fillStyle = 'rgba(255,255,255,0.12)';
    ctx.fillRect(bx, y, 1, h);
  }

  for (const s of pat.strums) {
    if (s.beat >= totalBeats) continue;
    const sx = x + (s.beat / totalBeats) * w;
    const isHit = beatInChord >= s.beat && beatInChord < s.beat + 0.3;
    const markerH = h * 0.6;
    const markerW = 5;
    const my = y + (h - markerH) / 2;

    if (isHit) {
      ctx.fillStyle = s.dir === 'down' ? 'rgba(0,212,255,0.9)' : 'rgba(0,255,136,0.9)';
      ctx.shadowColor = s.dir === 'down' ? '#00d4ff' : '#00ff88';
      ctx.shadowBlur = 8;
    } else {
      ctx.fillStyle = s.dir === 'down' ? 'rgba(0,212,255,0.4)' : 'rgba(0,255,136,0.4)';
      ctx.shadowBlur = 0;
    }

    if (s.dir === 'down') {
      ctx.beginPath();
      ctx.moveTo(sx, my);
      ctx.lineTo(sx - markerW / 2, my);
      ctx.lineTo(sx, my + markerH);
      ctx.lineTo(sx + markerW / 2, my);
      ctx.closePath();
      ctx.fill();
    } else {
      ctx.beginPath();
      ctx.moveTo(sx, my + markerH);
      ctx.lineTo(sx - markerW / 2, my + markerH);
      ctx.lineTo(sx, my);
      ctx.lineTo(sx + markerW / 2, my + markerH);
      ctx.closePath();
      ctx.fill();
    }
    ctx.shadowBlur = 0;
  }

  const px = x + frac * w;
  ctx.fillStyle = '#fff';
  ctx.fillRect(px - 1, y - 2, 2, h + 4);

  ctx.restore();
}

const STRING_LABELS = ['E', 'A', 'D', 'G', 'B', 'e'];

function drawStrumOverlay(ctx, layout, stringStates, mutedStrings, cursor) {
  const { stringYs, bodyLeft, bodyRight, bodyMidX } = layout;
  const now = performance.now();
  const zoneTop = stringYs[0] - 10;
  const zoneBot = stringYs[5] + 10;
  const zoneH = zoneBot - zoneTop;
  const inRight = cursor && cursor.x >= bodyMidX;

  // ── Zone backgrounds ──
  ctx.save();
  // Down-only zone (left)
  ctx.fillStyle = (cursor && !inRight) ? 'rgba(0, 212, 255, 0.08)' : 'rgba(0, 212, 255, 0.03)';
  ctx.fillRect(bodyLeft, zoneTop, bodyMidX - bodyLeft, zoneH);
  // Down+Up zone (right)
  ctx.fillStyle = (cursor && inRight) ? 'rgba(0, 255, 136, 0.08)' : 'rgba(0, 255, 136, 0.03)';
  ctx.fillRect(bodyMidX, zoneTop, bodyRight - bodyMidX, zoneH);

  // Divider
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.moveTo(bodyMidX, zoneTop);
  ctx.lineTo(bodyMidX, zoneBot);
  ctx.stroke();
  ctx.setLineDash([]);

  // Zone labels
  ctx.font = '11px Inter, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  const labelY = zoneBot + 6;
  ctx.fillStyle = (cursor && !inRight) ? 'rgba(0, 212, 255, 0.6)' : 'rgba(0, 212, 255, 0.3)';
  ctx.fillText('\u25BC Down', (bodyLeft + bodyMidX) / 2, labelY);
  ctx.fillStyle = (cursor && inRight) ? 'rgba(0, 255, 136, 0.6)' : 'rgba(0, 255, 136, 0.3)';
  ctx.fillText('\u25BC\u25B2 Down + Up', (bodyMidX + bodyRight) / 2, labelY);
  ctx.restore();

  // ── String vibrations ──
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

      if (age < 120) {
        ctx.save();
        ctx.globalAlpha = (1 - age / 120) * 0.7;
        ctx.fillStyle = '#ffd264';
        ctx.font = 'bold 10px Inter, sans-serif';
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';
        ctx.fillText(STRING_LABELS[s], bodyLeft - 6, y);
        ctx.restore();
      }
    }

    if (muted) {
      ctx.save();
      ctx.globalAlpha = 0.25;
      ctx.fillStyle = '#f44336';
      ctx.font = 'bold 10px Inter, sans-serif';
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      ctx.fillText('x', bodyLeft - 6, y);
      ctx.restore();
    }
  }

  // ── Cursor ──
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

  // ── Ghost hints when no hand detected ──
  if (!cursor) {
    const rangeY = stringYs[5] - stringYs[0];
    const t = (Math.sin(now * 0.0025) + 1) / 2;

    // Ghost in down-only zone (just sweeps down)
    const leftX = (bodyLeft + bodyMidX) / 2;
    const leftY = stringYs[0] + t * rangeY;
    ctx.fillStyle = 'rgba(0, 212, 255, 0.12)';
    ctx.beginPath();
    ctx.arc(leftX, leftY, 10, 0, Math.PI * 2);
    ctx.fill();

    // Ghost in down+up zone (sweeps down then up)
    const rightX = (bodyMidX + bodyRight) / 2;
    const tBoth = (Math.sin(now * 0.003) + 1) / 2;
    const rightY = stringYs[0] + tBoth * rangeY;
    ctx.fillStyle = 'rgba(0, 255, 136, 0.12)';
    ctx.beginPath();
    ctx.arc(rightX, rightY, 10, 0, Math.PI * 2);
    ctx.fill();
  }
}

// ── Strum direction guide (large arrows on guitar body) ─────

function drawStrumGuide(ctx, layout, patternName, beatInChord, totalBeats) {
  const pat = STRUM_PATTERNS[patternName];
  if (!pat || beatInChord < 0) return;
  const { stringYs, bodyLeft, bodyRight } = layout;
  const zoneTop = stringYs[0] - 10;
  const zoneBot = stringYs[5] + 10;
  const zoneMid = (zoneTop + zoneBot) / 2;
  const zoneH = zoneBot - zoneTop;
  const cx = (bodyLeft + bodyRight) / 2;

  const patternBeats = pat.slots.length / 2;
  const moduloBeat = beatInChord % patternBeats;

  for (const s of pat.strums) {
    if (s.beat >= patternBeats) continue;
    const diff = moduloBeat - s.beat;
    // Handle wrap-around: if moduloBeat is near 0 and strum is near end
    const wrapDiff = diff < -patternBeats / 2 ? diff + patternBeats : diff;
    if (wrapDiff >= -0.15 && wrapDiff < 0.5) {
      const t = wrapDiff < 0 ? 0 : wrapDiff / 0.5;
      const alpha = wrapDiff < 0 ? 0.4 : Math.max(0, 0.85 - t);
      const scale = 1 - t * 0.3;
      const isDown = s.dir === 'down';

      const arrowH = zoneH * 0.35 * scale;
      const arrowW = arrowH * 0.5;

      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.fillStyle = isDown ? '#00d4ff' : '#00ff88';
      ctx.shadowColor = isDown ? '#00d4ff' : '#00ff88';
      ctx.shadowBlur = 12 * alpha;

      ctx.beginPath();
      if (isDown) {
        ctx.moveTo(cx, zoneMid + arrowH / 2);
        ctx.lineTo(cx - arrowW, zoneMid - arrowH / 2);
        ctx.lineTo(cx + arrowW, zoneMid - arrowH / 2);
      } else {
        ctx.moveTo(cx, zoneMid - arrowH / 2);
        ctx.lineTo(cx - arrowW, zoneMid + arrowH / 2);
        ctx.lineTo(cx + arrowW, zoneMid + arrowH / 2);
      }
      ctx.closePath();
      ctx.fill();

      // Direction label
      ctx.shadowBlur = 0;
      ctx.font = `bold ${Math.round(14 * scale)}px Inter, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const labelY = isDown ? zoneMid - arrowH / 2 - 12 : zoneMid + arrowH / 2 + 12;
      ctx.fillText(isDown ? 'DOWN' : 'UP', cx, labelY);

      ctx.restore();
    }
  }
}

// ── Progression timer ───────────────────────────────────────

class ProgressionTimer {
  constructor() {
    this.song = null;
    this.bpm = 100;
    this.startTime = 0;
    this.running = false;
    this.finished = false;
    this.segments = [];
    this.segIdx = 0;
    this.beatInChord = 0;
    this.sectionIdx = 0;
    this.sectionRepeat = 0;
    this.looping = false;
    this.loopCount = 0;
    this.loopMode = false;
    this.onFinish = null;
  }

  get idx() { return this.segIdx; }

  start(song, bpmOverride) {
    this.song = song;
    let baseBpm = bpmOverride || song.bpm || 120;
    // Compound meters (x/8): BPM refers to dotted-quarter notes.
    // Convert to eighth-note BPM since beat counts are in eighth notes.
    const ts = song.timeSignature || [4, 4];
    if (ts[1] === 8) baseBpm = baseBpm * 3;
    this.bpm = baseBpm;
    this.startTime = performance.now();
    this.running = true;
    this.finished = false;
    this.segIdx = 0;
    this.beatInChord = 0;
    this.sectionIdx = 0;
    this.sectionRepeat = 0;
    this.loopCount = 0;
    this.segments = [];

    const sections = song.sections;
    if (sections && sections.length) {
      this.looping = false;
      for (let si = 0; si < sections.length; si++) {
        const sec = sections[si];
        const prog = sec.progression || song.progression;
        for (let r = 0; r < (sec.repeats || 1); r++) {
          for (let ci = 0; ci < prog.length; ci++) {
            this.segments.push({
              chord: prog[ci].chord,
              beats: prog[ci].beats,
              sectionIdx: si,
              sectionRepeat: r,
              chordIdxInSection: ci,
            });
          }
        }
      }
    } else {
      this.looping = true;
      const prog = song.progression || [];
      for (let ci = 0; ci < prog.length; ci++) {
        this.segments.push({
          chord: prog[ci].chord,
          beats: prog[ci].beats,
          sectionIdx: -1,
          sectionRepeat: 0,
          chordIdxInSection: ci,
        });
      }
    }
  }

  stop() { this.running = false; }

  update() {
    if (!this.running || !this.segments.length) return;
    const elapsed = (performance.now() - this.startTime) / 1000;
    const beatDur = 60 / this.bpm;
    const totalBeat = elapsed / beatDur;
    const totalSegBeats = this.segments.reduce((s, seg) => s + seg.beats, 0);

    let beatPos;
    if (this.looping || this.loopMode) {
      beatPos = totalBeat % totalSegBeats;
      const newLoop = Math.floor(totalBeat / totalSegBeats);
      if (newLoop !== this.loopCount) this.loopCount = newLoop;
    } else {
      if (totalBeat >= totalSegBeats) {
        this.finished = true;
        this.running = false;
        if (this.onFinish) this.onFinish();
        return;
      }
      beatPos = totalBeat;
    }

    let accum = 0;
    for (let i = 0; i < this.segments.length; i++) {
      if (beatPos < accum + this.segments[i].beats) {
        this.segIdx = i;
        this.beatInChord = beatPos - accum;
        const seg = this.segments[i];
        this.sectionIdx = seg.sectionIdx;
        this.sectionRepeat = seg.sectionRepeat;
        return;
      }
      accum += this.segments[i].beats;
    }
  }

  currentChord() { return this.segments[this.segIdx]; }
  currentBeat() { return Math.floor(this.beatInChord); }
  currentBeatsTotal() { return this.segments[this.segIdx]?.beats || 4; }

  currentChordIdxInSection() {
    return this.segments[this.segIdx]?.chordIdxInSection ?? 0;
  }

  currentSectionProgression() {
    if (!this.song) return [];
    if (this.song.sections && this.song.sections[this.sectionIdx]) {
      return this.song.sections[this.sectionIdx].progression || this.song.progression;
    }
    return this.song.progression || [];
  }

  currentSectionName() {
    if (!this.song || !this.song.sections) return null;
    const sec = this.song.sections[this.sectionIdx];
    return sec ? sec.name : null;
  }

  currentSectionLabel() {
    if (!this.song || !this.song.sections) return null;
    const sec = this.song.sections[this.sectionIdx];
    if (!sec) return null;
    if ((sec.repeats || 1) <= 1) return sec.name;
    return `${sec.name} (${this.sectionRepeat + 1}/${sec.repeats})`;
  }

  currentLyrics() {
    if (!this.song || !this.song.sections) return null;
    const sec = this.song.sections[this.sectionIdx];
    return sec ? sec.lyrics || null : null;
  }

  progress() {
    if (!this.running || !this.segments.length) return 0;
    const elapsed = (performance.now() - this.startTime) / 1000;
    const beatDur = 60 / this.bpm;
    const totalSegBeats = this.segments.reduce((s, seg) => s + seg.beats, 0);
    const totalBeat = elapsed / beatDur;
    return (totalBeat % totalSegBeats) / totalSegBeats;
  }
}

// ── Song difficulty ─────────────────────────────────────────

const BARRE_CHORDS = new Set(['F', 'Fm', 'Bb', 'Bm', 'B', 'F#m', 'C#m', 'Ab', 'Eb']);

function songDifficulty(song) {
  if (!song.progression || !song.progression.length) {
    return { level: 0, label: '?', color: '#888' };
  }
  const chords = new Set(song.progression.map((c) => c.chord));
  const count = chords.size;
  const hasBarre = [...chords].some((c) => BARRE_CHORDS.has(c));
  const bpm = song.bpm || 120;

  let score = 0;
  score += Math.min(count, 8);
  if (hasBarre) score += 3;
  if (bpm > 140) score += 2;
  else if (bpm > 110) score += 1;

  if (score <= 4) return { level: 1, label: 'Easy', color: '#4caf50' };
  if (score <= 7) return { level: 2, label: 'Medium', color: '#ff9800' };
  return { level: 3, label: 'Hard', color: '#f44336' };
}

// ── Strum patterns ──────────────────────────────────────────

const STRUM_PATTERNS = {
  simple: {
    label: 'Simple',
    slots: ['D', '-', 'D', '-', 'D', '-', 'D', '-'],
    strums: [
      { beat: 0, dir: 'down' },
      { beat: 1, dir: 'down' },
      { beat: 2, dir: 'down' },
      { beat: 3, dir: 'down' },
    ],
  },
  ballad: {
    label: 'Ballad',
    slots: ['D', '-', 'D', 'U', '-', 'U', '-', '-'],
    strums: [
      { beat: 0, dir: 'down' },
      { beat: 1, dir: 'down' },
      { beat: 1.5, dir: 'up' },
      { beat: 2.5, dir: 'up' },
    ],
  },
  pop: {
    label: 'Pop',
    slots: ['D', '-', 'D', 'U', '-', 'U', 'D', 'U'],
    strums: [
      { beat: 0,   dir: 'down' },
      { beat: 1,   dir: 'down' },
      { beat: 1.5, dir: 'up'   },
      { beat: 2.5, dir: 'up'   },
      { beat: 3,   dir: 'down' },
      { beat: 3.5, dir: 'up'   },
    ],
  },
  rock: {
    label: 'Rock',
    slots: ['D', '-', 'D', 'U', '-', 'U', 'D', '-'],
    strums: [
      { beat: 0,   dir: 'down' },
      { beat: 1,   dir: 'down' },
      { beat: 1.5, dir: 'up'   },
      { beat: 2.5, dir: 'up'   },
      { beat: 3,   dir: 'down' },
    ],
  },
  'brown-eyed-girl': {
    label: 'Brown Eyed Girl',
    slots: ['D', '-', 'D', 'U', 'D', 'U', 'D', 'U'],
    strums: [
      { beat: 0,   dir: 'down' },
      { beat: 1,   dir: 'down' },
      { beat: 1.5, dir: 'up'   },
      { beat: 2,   dir: 'down' },
      { beat: 2.5, dir: 'up'   },
      { beat: 3,   dir: 'down' },
      { beat: 3.5, dir: 'up'   },
    ],
  },
  reggae: {
    label: 'Reggae',
    slots: ['-', 'U', '-', 'U', '-', 'U', '-', 'U'],
    strums: [
      { beat: 0.5, dir: 'up' },
      { beat: 1.5, dir: 'up' },
      { beat: 2.5, dir: 'up' },
      { beat: 3.5, dir: 'up' },
    ],
  },
  'let-it-be': {
    label: 'Let It Be',
    slots: ['D', '-', 'D', 'U', '-', 'U', 'D', 'U'],
    strums: [
      { beat: 0,   dir: 'down' },
      { beat: 1,   dir: 'down' },
      { beat: 1.5, dir: 'up'   },
      { beat: 2.5, dir: 'up'   },
      { beat: 3,   dir: 'down' },
      { beat: 3.5, dir: 'up'   },
    ],
  },
  'knockin': {
    label: "Knockin'",
    slots: ['D', '-', 'D', 'U', '-', 'U', 'D', 'U'],
    strums: [
      { beat: 0,   dir: 'down' },
      { beat: 1,   dir: 'down' },
      { beat: 1.5, dir: 'up'   },
      { beat: 2.5, dir: 'up'   },
      { beat: 3,   dir: 'down' },
      { beat: 3.5, dir: 'up'   },
    ],
  },
  'horse': {
    label: 'Horse',
    slots: ['D', '-', 'D', '-', 'D', 'U', 'D', 'U'],
    strums: [
      { beat: 0,   dir: 'down' },
      { beat: 1,   dir: 'down' },
      { beat: 2,   dir: 'down' },
      { beat: 2.5, dir: 'up'   },
      { beat: 3,   dir: 'down' },
      { beat: 3.5, dir: 'up'   },
    ],
  },
  'stand-by-me': {
    label: 'Stand By Me',
    slots: ['D', '-', 'D', 'U', '-', 'U', 'D', 'U'],
    strums: [
      { beat: 0,   dir: 'down' },
      { beat: 1,   dir: 'down' },
      { beat: 1.5, dir: 'up'   },
      { beat: 2.5, dir: 'up'   },
      { beat: 3,   dir: 'down' },
      { beat: 3.5, dir: 'up'   },
    ],
  },
  'riptide': {
    label: 'Riptide',
    slots: ['D', '-', 'D', 'U', 'D', 'U', 'D', 'U'],
    strums: [
      { beat: 0,   dir: 'down' },
      { beat: 1,   dir: 'down' },
      { beat: 1.5, dir: 'up'   },
      { beat: 2,   dir: 'down' },
      { beat: 2.5, dir: 'up'   },
      { beat: 3,   dir: 'down' },
      { beat: 3.5, dir: 'up'   },
    ],
  },
  'country-roads': {
    label: 'Country Roads',
    slots: ['D', 'U', 'D', 'U', 'D', 'U', 'D', 'U'],
    strums: [
      { beat: 0,   dir: 'down' },
      { beat: 0.5, dir: 'up'   },
      { beat: 1,   dir: 'down' },
      { beat: 1.5, dir: 'up'   },
      { beat: 2,   dir: 'down' },
      { beat: 2.5, dir: 'up'   },
      { beat: 3,   dir: 'down' },
      { beat: 3.5, dir: 'up'   },
    ],
  },
  'sweet-home': {
    label: 'Sweet Home',
    slots: ['D', '-', 'D', 'U', '-', 'U', 'D', 'U'],
    strums: [
      { beat: 0,   dir: 'down' },
      { beat: 1,   dir: 'down' },
      { beat: 1.5, dir: 'up'   },
      { beat: 2.5, dir: 'up'   },
      { beat: 3,   dir: 'down' },
      { beat: 3.5, dir: 'up'   },
    ],
  },
  'hallelujah': {
    label: 'Hallelujah',
    // 6/8: 6 eighth-note beats per chord (12 half-beat slots)
    slots: ['D', '-', 'U', '-', 'U', '-', 'D', '-', 'U', '-', 'U', '-'],
    strums: [
      { beat: 0,   dir: 'down' },
      { beat: 1,   dir: 'up'   },
      { beat: 2,   dir: 'up'   },
      { beat: 3,   dir: 'down' },
      { beat: 4,   dir: 'up'   },
      { beat: 5,   dir: 'up'   },
    ],
  },
  'wish-you-were-here': {
    label: 'Wish',
    slots: ['D', '-', 'D', 'U', '-', 'U', 'D', 'U'],
    strums: [
      { beat: 0,   dir: 'down' },
      { beat: 1,   dir: 'down' },
      { beat: 1.5, dir: 'up'   },
      { beat: 2.5, dir: 'up'   },
      { beat: 3,   dir: 'down' },
      { beat: 3.5, dir: 'up'   },
    ],
  },
  'hotel-california': {
    label: 'Hotel California',
    slots: ['D', '-', 'D', 'U', '-', 'U', 'D', 'U'],
    strums: [
      { beat: 0,   dir: 'down' },
      { beat: 1,   dir: 'down' },
      { beat: 1.5, dir: 'up'   },
      { beat: 2.5, dir: 'up'   },
      { beat: 3,   dir: 'down' },
      { beat: 3.5, dir: 'up'   },
    ],
  },
  'bad-moon': {
    label: 'Bad Moon Rising',
    slots: ['D', 'D', 'U', '-', 'D', '-', 'D', 'U'],
    strums: [
      { beat: 0,   dir: 'down' },
      { beat: 0.5, dir: 'down' },
      { beat: 1,   dir: 'up'   },
      { beat: 2,   dir: 'down' },
      { beat: 3,   dir: 'down' },
      { beat: 3.5, dir: 'up'   },
    ],
  },
  'twist-and-shout': {
    label: 'Twist & Shout',
    slots: ['D', '-', 'D', 'U', 'D', 'U', 'D', 'U'],
    strums: [
      { beat: 0,   dir: 'down' },
      { beat: 1,   dir: 'down' },
      { beat: 1.5, dir: 'up'   },
      { beat: 2,   dir: 'down' },
      { beat: 2.5, dir: 'up'   },
      { beat: 3,   dir: 'down' },
      { beat: 3.5, dir: 'up'   },
    ],
  },
  'waltz': {
    label: 'Waltz',
    slots: ['D', '-', 'D', '-', 'D', '-'],
    strums: [
      { beat: 0, dir: 'down' },
      { beat: 1, dir: 'down' },
      { beat: 2, dir: 'down' },
    ],
  },
  'fingerpick': {
    label: 'Fingerpick',
    slots: ['D', '-', 'U', '-', 'U', '-', 'U', '-'],
    strums: [
      { beat: 0,   dir: 'down' },
      { beat: 1,   dir: 'up'   },
      { beat: 2,   dir: 'up'   },
      { beat: 3,   dir: 'up'   },
    ],
  },
};

const GENERIC_PATTERNS = ['simple', 'ballad', 'pop', 'rock', 'reggae'];
const PATTERN_NAMES = Object.keys(STRUM_PATTERNS);

function inferPattern(bpm) {
  if (bpm < 70) return 'ballad';
  if (bpm <= 130) return 'pop';
  return 'rock';
}

function generateBeatLabels(numSlots) {
  const labels = [];
  for (let i = 0; i < numSlots; i++) {
    labels.push(i % 2 === 0 ? String(i / 2 + 1) : '&');
  }
  return labels;
}

// ── AutoPlayer ──────────────────────────────────────────────

class AutoPlayer {
  constructor(onStrum) {
    this.onStrum = onStrum;
    this.patternName = 'pop';
    this.active = false;
    this.lastBeat = -1;
    this.lastChordIdx = -1;
  }

  setPattern(name) {
    this.patternName = STRUM_PATTERNS[name] ? name : 'simple';
  }

  getPattern() {
    return STRUM_PATTERNS[this.patternName] || STRUM_PATTERNS.simple;
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

    for (const s of this.getPattern().strums) {
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
    this.chordFlashTime = 0;

    this.handState = { x: 0, y: 0, prevY: 0, active: false };
    this.stringStates = new Array(6).fill(0);

    this.autoPlayer = new AutoPlayer((dir) => {
      if (this.currentSong && this.currentSong.fingerpick) {
        this.triggerFingerPick(dir === 'down');
      } else {
        this.triggerAutoStrum(dir);
      }
    });
    this.autoStrum = { active: false, startTime: 0, duration: 60, direction: 'down' };
    this.autoMode = false;
    this.strumHalfWidth = 0.11;
    this.speedMultiplier = 1.0;

    this.strumCamTop = 0.0;
    this.strumCamBottom = 1.0;
    this.calibrating = false;
    this.calibrateStep = 0;

    this.guitarColor = localStorage.getItem('air-guitar-color') || 'original';
    this.coloredGuitar = null;
    this.activePatternName = 'pop';

    this.metronomeOn = true;
    this.lastMetronomeBeat = -1;
    this._lastGuideSlot = -1;

    this.score = 0;
    this.streak = 0;
    this.bestStreak = 0;
    this.timingPopup = null;
    this.calibrated = false;
    this.hasPlayedOnce = false;
    this.scoreTooltipShown = false;
    this.cameraAvailable = false;

    this.countingIn = false;
    this.countInStart = 0;
    this.countInBeats = 4;
    this.countInBpm = 100;
    this.countInCurrent = 0;
    this.lastCountInBeat = -1;
    this.loopMode = false;

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
      ]);
      this.chordDB = dbRes;
      this.songs = songsRes;
      this.guitarImg = img;

      // Camera is deferred — not requested until user clicks Play or Calibrate
      this.cameraAvailable = false;
      this.cameraInitialized = false;
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

    // Current song button: shows welcome overlay with search
    document.getElementById('current-song-btn').addEventListener('click', () => {
      if (this.playing) this.togglePlay();
      this.showWelcome();
      // Auto-open the search
      const searchWrap = document.getElementById('welcome-search-wrap');
      if (searchWrap) {
        searchWrap.classList.remove('hidden');
        setTimeout(() => document.getElementById('welcome-search').focus(), 100);
      }
    });

    document.getElementById('play-btn').addEventListener('click', () => this.togglePlay());
    document.getElementById('auto-btn').addEventListener('click', () => this.toggleAuto());
    document.getElementById('pattern-label').addEventListener('click', () => this.cyclePattern());
    document.getElementById('speed-down').addEventListener('click', () => this.adjustSpeed(-0.25));
    document.getElementById('speed-up').addEventListener('click', () => this.adjustSpeed(0.25));
    const calBtn = document.getElementById('calibrate-btn');
    calBtn.addEventListener('click', () => this.startCalibration());
    document.getElementById('tone-btn').addEventListener('click', () => this.cycleTone());
    document.getElementById('metronome-btn').addEventListener('click', () => {
      this.metronomeOn = !this.metronomeOn;
      document.getElementById('metronome-btn').classList.toggle('active', this.metronomeOn);
    });
    document.getElementById('loop-btn').addEventListener('click', () => {
      this.loopMode = !this.loopMode;
      document.getElementById('loop-btn').classList.toggle('active', this.loopMode);
      if (this.timer.running) {
        this.timer.loopMode = this.loopMode;
      }
    });

    const calCanvas = document.getElementById('calibrate-canvas');
    calCanvas.addEventListener('click', (e) => this.handleCalibrationClick(e));

    document.querySelectorAll('.color-swatch').forEach((s) => {
      s.addEventListener('click', () => {
        this.setGuitarColor(s.dataset.color);
      });
    });

    this.setGuitarColor(this.guitarColor);

    this.loadCustomSongs();
    this.setupCustomSongModal();
    this.initStepGuide();

    // Settings panel toggle
    document.getElementById('settings-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      document.getElementById('settings-panel').classList.toggle('hidden');
    });
    document.addEventListener('click', (e) => {
      if (!e.target.closest('#settings-group')) {
        document.getElementById('settings-panel').classList.add('hidden');
      }
    });

    // Auto-load a beginner-friendly default song
    const defaultSong = this.songs.find(s => s.id === 'let-it-be');
    if (defaultSong) {
      this.selectSong(defaultSong);
      document.getElementById('current-song-label').textContent = defaultSong.title;
    }

    // Welcome overlay buttons
    document.getElementById('welcome-play').addEventListener('click', async () => {
      this.playPreviewStrum();
      const hasCam = await this.ensureCamera();
      if (hasCam && !this.calibrated) {
        // Camera ready — calibrate strum zone, then auto-start playback
        this.playAfterCalibration = true;
        this.startCalibration();
      } else {
        // No camera — use keyboard/click mode with defaults
        if (!this.calibrated) this.useDefaultCalibration();
        await this.togglePlay();
      }
    });
    document.getElementById('welcome-demo').addEventListener('click', async () => {
      this.playPreviewStrum();
      await this.toggleAuto();
    });
    document.getElementById('welcome-more-options').addEventListener('click', () => {
      const adv = document.getElementById('welcome-advanced');
      const btn = document.getElementById('welcome-more-options');
      if (adv.classList.contains('hidden')) {
        adv.classList.remove('hidden');
        btn.textContent = 'Fewer options';
      } else {
        adv.classList.add('hidden');
        btn.textContent = 'More options';
      }
    });
    document.getElementById('welcome-calibrate')?.addEventListener('click', () => {
      this.startCalibration();
    });
    document.getElementById('welcome-pattern-btn')?.addEventListener('click', () => {
      this.cyclePattern();
      this.renderWelcomePattern();
    });
    document.getElementById('welcome-speed-down')?.addEventListener('click', () => this.adjustSpeed(-0.25));
    document.getElementById('welcome-speed-up')?.addEventListener('click', () => this.adjustSpeed(0.25));

    this.renderWelcomePattern();
    this.setupWelcomeSearch();

    // Skip calibration buttons (welcome overlay + calibrate overlay)
    document.getElementById('welcome-skip-cal')?.addEventListener('click', () => {
      this.useDefaultCalibration();
    });
    document.getElementById('calibrate-skip').addEventListener('click', () => {
      this.useDefaultCalibration();
      this.finishCalibration();
    });
    document.getElementById('calibrate-reset').addEventListener('click', () => {
      this.resetCalibration();
    });

    // Keyboard strum: spacebar = down strum, shift+space = up strum
    document.addEventListener('keydown', (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
      if (e.code === 'Space' && !e.repeat) {
        e.preventDefault();
        if (!this.playing || !this.currentBuffers) return;
        const dir = e.shiftKey ? 'up' : 'down';
        this.triggerAutoStrum(dir);
        this.judgeStrum();
      }
    });

    // Click-to-strum on guitar canvas
    this.canvas.addEventListener('click', (e) => {
      if (!this.playing || !this.currentBuffers || !this.layout) return;
      const rect = this.canvas.getBoundingClientRect();
      const clickX = (e.clientX - rect.left);
      const L = this.layout;
      if (clickX >= L.bodyLeft && clickX <= L.bodyRight) {
        this.triggerAutoStrum('down');
        this.judgeStrum();
      }
    });

    // Camera PIP: hidden by default (deferred until user action)
    document.getElementById('camera-pip').style.display = 'none';

    const helpBtn = document.getElementById('help-btn');

    // Bottom bar idle label
    this.updateIdleLabel();

    this.loop();

    // Help button shows the welcome overlay
    helpBtn.addEventListener('click', () => {
      if (this.playing) this.togglePlay();
      this.showWelcome();
    });
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

  initStepGuide() {
    // Welcome overlay handles first-time users;
    // calibration check in togglePlay gates the rest.
    this.stepsCompleted = new Set();
    this.guideDone = true;
    document.getElementById('top-bar').classList.add('steps-done');
  }

  enforceStepState() {
    const calBtn = document.getElementById('calibrate-btn');
    const searchInput = document.getElementById('song-search');
    const customBtn = document.getElementById('custom-song-btn');
    const playBtn = document.getElementById('play-btn');
    const autoBtn = document.getElementById('auto-btn');

    const has = (n) => this.stepsCompleted.has(n);

    calBtn.disabled = !has(1);
    calBtn.classList.toggle('bar-btn-disabled', !has(1));
    if (has(1) && !has(2)) {
      calBtn.classList.add('needs-attention');
    }

    searchInput.disabled = !has(2);
    customBtn.disabled = !has(2);
    searchInput.classList.toggle('input-disabled', !has(2));

    playBtn.disabled = !has(3);
    autoBtn.disabled = !has(3);
    playBtn.classList.toggle('play-disabled', !has(3));
    autoBtn.classList.toggle('play-disabled', !has(3));
  }

  completeStep(n) {
    if (this.guideDone) return;
    this.stepsCompleted.add(n);
    const label = document.querySelector(`.step-label[data-step="${n}"]`);
    if (label) label.classList.add('step-done');

    const nextStep = { 1: 2, 2: 3, 3: 5 }[n];
    if (nextStep) {
      const next = document.querySelector(`.step-label[data-step="${nextStep}"]`);
      if (next && !next.classList.contains('step-done')) {
        next.classList.add('step-active');
      }
    }

    this.enforceStepState();

    if ([1, 2, 3, 5].every((s) => this.stepsCompleted.has(s))) {
      this.guideDone = true;
      localStorage.setItem(this.guideKey, 'true');
      setTimeout(() => {
        document.getElementById('top-bar').classList.add('steps-done');
      }, 800);
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

    const overrides = JSON.parse(localStorage.getItem('air-guitar-pattern-overrides') || '{}');
    const patName = overrides[song.id] || song.pattern || (song.fingerpick ? 'fingerpick' : inferPattern(song.bpm || 120));
    this.setActivePattern(patName);

    const ts = song.timeSignature || [4, 4];
    this.setupBeatDots(ts[0]);

    this.setChord(song.progression[0].chord);
    this.updateProgressionDisplay();
    this.completeStep(3);
    this.updateWelcome();
  }

  setActivePattern(name) {
    const resolved = STRUM_PATTERNS[name] ? name : 'pop';
    this.autoPlayer.setPattern(resolved);
    this.activePatternName = resolved;
    const label = document.getElementById('pattern-label');
    if (label) label.textContent = 'Pattern: ' + STRUM_PATTERNS[resolved].label;
    this.renderWelcomePattern();
  }

  cyclePattern() {
    const pool = GENERIC_PATTERNS.includes(this.activePatternName) ? GENERIC_PATTERNS : [this.activePatternName, ...GENERIC_PATTERNS];
    const idx = pool.indexOf(this.activePatternName);
    const next = pool[(idx + 1) % pool.length];
    this.setActivePattern(next);
    if (this.currentSong) {
      const overrides = JSON.parse(localStorage.getItem('air-guitar-pattern-overrides') || '{}');
      overrides[this.currentSong.id] = next;
      localStorage.setItem('air-guitar-pattern-overrides', JSON.stringify(overrides));
    }
  }

  cycleTone() {
    const idx = TONE_NAMES.indexOf(this.audio.toneName);
    const next = TONE_NAMES[(idx + 1) % TONE_NAMES.length];
    this.audio.applyTone(next);
    document.getElementById('tone-btn').textContent = 'Tone: ' + TONE_PRESETS[next].label;
  }

  judgeStrum() {
    if (!this.playing || this.autoMode) return;
    const beat = this.timer.beatInChord;
    const pat = STRUM_PATTERNS[this.activePatternName];
    if (!pat) return;

    let minDist = Infinity;
    for (const s of pat.strums) {
      minDist = Math.min(minDist, Math.abs(beat - s.beat));
    }

    let label, pts, color;
    if (minDist < 0.25) { label = 'Perfect'; pts = 100; color = '#00ff88'; }
    else if (minDist < 0.5) { label = 'Great'; pts = 50; color = '#00d4ff'; }
    else if (minDist < 1.0) { label = 'Good'; pts = 20; color = '#ff9800'; }
    else { label = 'Miss'; pts = 0; color = '#f44336'; }

    if (pts > 0) {
      this.streak++;
      if (this.streak > this.bestStreak) this.bestStreak = this.streak;
      const mult = 1 + Math.floor(this.streak / 10) * 0.5;
      this.score += Math.round(pts * mult);
    } else {
      this.streak = 0;
    }

    this.timingPopup = { label, color, time: performance.now() };
    this.updateScoreDisplay();
  }

  updateScoreDisplay() {
    const el = document.getElementById('score-display');
    if (!el) return;
    el.classList.remove('hidden');
    document.getElementById('score-value').textContent = this.score.toLocaleString();
    const streakEl = document.getElementById('streak-value');
    streakEl.textContent = this.streak > 1 ? `${this.streak}x streak` : '';

    // Show tooltip on first score appearance
    if (!this.scoreTooltipShown) {
      this.scoreTooltipShown = true;
      const tooltip = document.getElementById('score-tooltip');
      if (tooltip) {
        tooltip.classList.remove('hidden');
        setTimeout(() => tooltip.classList.add('hidden'), 4500);
      }
    }
  }

  resetScore() {
    this.score = 0;
    this.streak = 0;
    this.bestStreak = 0;
    this.timingPopup = null;
    const el = document.getElementById('score-display');
    if (el) el.classList.add('hidden');
  }

  async fetchSongsterrChords(song) {
    try {
      const url = `/api/chords?songsterrId=${song.songsterrId}`;
      const res = await fetch(url);
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
      document.getElementById('current-song-label').textContent = song.title;
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

  updateWelcome() {
    const overlay = document.getElementById('welcome-overlay');
    if (!overlay) return;

    // Update song info
    if (this.currentSong) {
      const titleEl = document.querySelector('.welcome-song-title');
      const artistEl = document.querySelector('.welcome-song-artist');
      if (titleEl) titleEl.textContent = this.currentSong.title;
      if (artistEl) artistEl.textContent = this.currentSong.artist;

      const bpmEl = document.getElementById('welcome-bpm');
      const keyEl = document.getElementById('welcome-key');
      const capoEl = document.getElementById('welcome-capo');
      const ytEl = document.getElementById('welcome-youtube');

      if (bpmEl) bpmEl.textContent = `${this.currentSong.bpm || 120} BPM`;
      if (keyEl) keyEl.textContent = `Key: ${this.currentSong.key || '?'}`;
      if (capoEl) {
        if (this.currentSong.capo) {
          capoEl.textContent = `Capo ${this.currentSong.capo}`;
          capoEl.classList.remove('hidden');
        } else {
          capoEl.classList.add('hidden');
        }
      }
      if (ytEl) {
        if (this.currentSong.youtubeId) {
          ytEl.href = `https://www.youtube.com/watch?v=${this.currentSong.youtubeId}`;
          ytEl.classList.remove('hidden');
        } else {
          ytEl.classList.add('hidden');
        }
      }

      // Update difficulty badge
      const diffEl = document.getElementById('welcome-difficulty');
      if (diffEl) {
        const diff = songDifficulty(this.currentSong);
        const labels = { 1: 'Perfect for beginners', 2: 'Intermediate', 3: 'Advanced' };
        diffEl.textContent = labels[diff.level] || diff.label;
        diffEl.style.background = diff.level === 1 ? 'rgba(0, 255, 136, 0.12)' :
          diff.level === 2 ? 'rgba(255, 152, 0, 0.12)' : 'rgba(244, 67, 54, 0.12)';
        diffEl.style.color = diff.level === 1 ? 'var(--green)' :
          diff.level === 2 ? '#ff9800' : 'var(--red)';
        diffEl.style.borderColor = diff.level === 1 ? 'rgba(0, 255, 136, 0.25)' :
          diff.level === 2 ? 'rgba(255, 152, 0, 0.25)' : 'rgba(244, 67, 54, 0.25)';
      }
    }

    // Update calibration step visual
    const step1 = overlay.querySelector('.welcome-step:first-child');
    if (step1) {
      if (!this.cameraAvailable) {
        // No camera: mark as done automatically, hide calibrate links
        step1.classList.add('done');
        step1.querySelector('.welcome-step-num').textContent = '';
        const calLink = document.getElementById('welcome-calibrate');
        const skipLink = document.getElementById('welcome-skip-cal');
        if (calLink) calLink.style.display = 'none';
        if (skipLink) skipLink.style.display = 'none';
        const stepText = step1.querySelector('.welcome-step-text');
        if (stepText) stepText.innerHTML = 'No camera needed<br><span class="welcome-kb-hint">Use <kbd>Space</kbd> or click to strum</span>';
      } else {
        step1.classList.toggle('done', this.calibrated);
        if (this.calibrated) {
          step1.querySelector('.welcome-step-num').textContent = '';
        }
      }
    }
  }

  renderWelcomePattern() {
    const pat = STRUM_PATTERNS[this.activePatternName];
    if (!pat) return;
    const nameEl = document.getElementById('welcome-pattern-name');
    const slotsEl = document.getElementById('welcome-pattern-slots');
    if (nameEl) nameEl.textContent = pat.label;
    if (!slotsEl) return;

    slotsEl.innerHTML = '';
    const beatLabels = generateBeatLabels(pat.slots.length);
    pat.slots.forEach((slot, i) => {
      const div = document.createElement('span');
      div.className = 'pattern-slot';
      const beat = document.createElement('span');
      beat.className = 'pattern-slot-beat';
      beat.textContent = beatLabels[i] || '';
      const arrow = document.createElement('span');
      arrow.className = 'pattern-slot-arrow';
      if (slot === 'D') {
        arrow.classList.add('down');
        arrow.textContent = '\u25BC';
      } else if (slot === 'U') {
        arrow.classList.add('up');
        arrow.textContent = '\u25B2';
      } else {
        arrow.classList.add('rest');
        arrow.textContent = '\u2013';
      }
      div.appendChild(beat);
      div.appendChild(arrow);
      slotsEl.appendChild(div);
    });
  }

  setupWelcomeSearch() {
    const changeBtn = document.getElementById('welcome-change-song');
    const searchWrap = document.getElementById('welcome-search-wrap');
    const searchInput = document.getElementById('welcome-search');
    const results = document.getElementById('welcome-search-results');
    let searchTimeout = null;

    changeBtn.addEventListener('click', () => {
      searchWrap.classList.toggle('hidden');
      if (!searchWrap.classList.contains('hidden')) {
        searchInput.value = '';
        searchInput.focus();
        this.showWelcomeResults(this.songs.slice(0, 8), results);
      }
    });

    searchInput.addEventListener('input', () => {
      const q = searchInput.value.trim();
      if (!q) {
        this.showWelcomeResults(this.songs.slice(0, 8), results);
        return;
      }
      const lower = q.toLowerCase();
      const local = this.songs.filter(
        s => s.title.toLowerCase().includes(lower) || s.artist.toLowerCase().includes(lower)
      );
      this.showWelcomeResults(local, results);

      clearTimeout(searchTimeout);
      searchTimeout = setTimeout(async () => {
        if (local.length >= 3) return;

        const hint = document.createElement('div');
        hint.className = 'welcome-search-result searching';
        hint.textContent = 'Searching online...';
        results.appendChild(hint);

        try {
          const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
          if (!res.ok) { hint.remove(); return; }
          const data = await res.json();
          const remote = data.songs || [];
          if (remote.length) {
            const merged = [...local];
            const localIds = new Set(local.map(s => s.id));
            for (const r of remote) {
              if (!localIds.has(r.id)) merged.push(r);
            }
            this.showWelcomeResults(merged, results);
          } else {
            hint.remove();
          }
        } catch {
          hint.remove();
        }
      }, 400);
    });

    searchInput.addEventListener('focus', () => {
      const q = searchInput.value.trim();
      if (!q) this.showWelcomeResults(this.songs.slice(0, 8), results);
    });
  }

  showWelcomeResults(items, container) {
    container.innerHTML = '';
    for (const item of items) {
      const div = document.createElement('div');
      div.className = 'welcome-search-result';
      const diff = songDifficulty(item);
      div.innerHTML = `<span>${item.title}</span><span class="song-meta"><span class="diff-badge" style="background:${diff.color}">${diff.label}</span><span class="song-artist">${item.artist}</span><button class="demo-pattern-btn" title="Demo this song's pattern">&#9654; Pattern</button></span>`;
      // Click song name to select
      div.addEventListener('click', (e) => {
        if (e.target.closest('.demo-pattern-btn')) return;
        this.selectSong(item);
        document.getElementById('current-song-label').textContent = item.title;
        document.getElementById('welcome-search-wrap').classList.add('hidden');
      });
      // Click "Pattern" button to demo
      div.querySelector('.demo-pattern-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        this.demoSongPattern(item);
      });
      container.appendChild(div);
    }
  }

  showWelcome() {
    const overlay = document.getElementById('welcome-overlay');
    if (overlay) {
      overlay.classList.remove('hidden');
      this.updateWelcome();
      this.renderWelcomePattern();
    }
  }

  hideWelcome() {
    const overlay = document.getElementById('welcome-overlay');
    if (overlay) overlay.classList.add('hidden');
  }

  playPreviewStrum() {
    if (!this.currentBuffers || !this.audio) return;
    try {
      this.audio.start();
      for (let s = 0; s < 6; s++) {
        this.audio.playString(this.currentBuffers, s, 0.5, s * 15);
      }
    } catch { /* ignore — audio context may need user gesture */ }
  }

  adjustSpeed(delta) {
    this.speedMultiplier = Math.round(Math.max(0.25, Math.min(2, this.speedMultiplier + delta)) * 100) / 100;
    const text = this.speedMultiplier + 'x';
    const label = document.getElementById('speed-label');
    const welcomeLabel = document.getElementById('welcome-speed-label');
    if (label) label.textContent = text;
    if (welcomeLabel) welcomeLabel.textContent = text;
    // Apply to running timer immediately
    if (this.currentSong) {
      this.timer.bpm = (this.currentSong.bpm || 120) * this.speedMultiplier;
    }
  }

  setupBeatDots(count) {
    const container = document.getElementById('beat-dots');
    container.innerHTML = '';
    for (let i = 0; i < count; i++) {
      const dot = document.createElement('span');
      dot.className = 'dot';
      container.appendChild(dot);
    }
  }

  triggerFingerPick(bass = true) {
    if (!this.currentBuffers || !this.layout) return;
    const vel = 0.45;
    const now = performance.now();
    if (bass) {
      for (let s = 0; s < 6; s++) {
        if (!this.mutedStrings[s]) {
          this.audio.playString(this.currentBuffers, s, vel);
          this.stringStates[s] = now;
          break;
        }
      }
    } else {
      for (let s = 3; s < 6; s++) {
        if (!this.mutedStrings[s]) {
          const delay = (s - 3) * 25;
          this.audio.playString(this.currentBuffers, s, vel * 0.8, delay);
          this.stringStates[s] = now + delay;
        }
      }
    }
    this.autoStrum = { active: true, startTime: now, duration: 40, direction: bass ? 'down' : 'up' };
  }

  startCountIn() {
    const ts = this.currentSong.timeSignature || [4, 4];
    this.countInBeats = ts[0];
    let bpm = (this.currentSong.bpm || 120) * this.speedMultiplier;
    if (ts[1] === 8) bpm = bpm * 3;
    this.countInBpm = bpm;
    this.countInStart = performance.now();
    this.countingIn = true;
    this.countInCurrent = 0;
    this.lastCountInBeat = -1;
    this.audio.start();
  }

  finishCountIn() {
    this.countingIn = false;
    // BPM conversion for compound meters happens inside timer.start()
    const bpm = (this.currentSong.bpm || 120) * this.speedMultiplier;
    this.timer.start(this.currentSong, bpm);
    this.timer.onFinish = () => this.onSongFinished();
    this.timer.loopMode = this.loopMode;
    this.lastTimerIdx = -1;
  }

  updateLyrics() {
    const overlay = document.getElementById('lyrics-overlay');
    const content = document.getElementById('lyrics-content');
    if (!overlay || !content) return;

    if (!this.playing || this.countingIn) {
      overlay.classList.add('hidden');
      return;
    }

    const lyrics = this.timer.currentLyrics();
    if (!lyrics || !lyrics.length) {
      overlay.classList.add('hidden');
      return;
    }

    overlay.classList.remove('hidden');
    const chordIdx = this.timer.currentChordIdxInSection();
    const prog = this.timer.currentSectionProgression();
    const totalChords = prog.length;

    content.innerHTML = '';
    lyrics.forEach((line, i) => {
      const div = document.createElement('div');
      div.className = 'lyric-line';
      const lineChordStart = Math.floor(i * totalChords / lyrics.length);
      const lineChordEnd = Math.floor((i + 1) * totalChords / lyrics.length);
      if (chordIdx >= lineChordStart && chordIdx < lineChordEnd) {
        div.classList.add('active');
      } else if (chordIdx >= lineChordEnd) {
        div.classList.add('past');
      }
      div.innerHTML = line.replace(/\[([^\]]+)\]/g, '<span class="lyric-chord">$1</span>');
      content.appendChild(div);
    });
  }

  async ensureCamera() {
    if (this.cameraInitialized) return this.cameraAvailable;
    this.cameraInitialized = true;
    try {
      await this.tracker.init();
      await this.tracker.startCamera();
      this.cameraAvailable = true;
    } catch (err) {
      console.warn('Camera unavailable, using keyboard/mouse fallback:', err.message);
      this.cameraAvailable = false;
    }
    if (!this.cameraAvailable) {
      document.getElementById('camera-pip').style.display = 'none';
    }
    return this.cameraAvailable;
  }

  useDefaultCalibration() {
    // Set sensible default strum area (middle third of camera frame)
    this.strumCamTop = 0.3;
    this.strumCamBottom = 0.7;
    this.calibrated = true;
    this.updateWelcome();
    this.showCameraPip();
  }

  resetCalibration() {
    const canvas = document.getElementById('calibrate-canvas');
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, rect.width, rect.height);
    this.calibrateStep = 0;
    document.getElementById('calibrate-hint').textContent = 'Click the TOP of your strum area';
    document.getElementById('calibrate-reset').style.display = 'none';
  }

  updateIdleLabel() {
    const labelEl = document.getElementById('section-label');
    if (!this.playing && this.currentSong && labelEl) {
      labelEl.innerHTML = '<span class="progression-label">Chord Progression</span>';
    }
  }

  revealAdvancedControls() {
    if (this.hasPlayedOnce) return;
    this.hasPlayedOnce = true;
    document.querySelectorAll('.bar-advanced').forEach(el => el.classList.remove('hidden'));
  }

  showCameraPip() {
    const pip = document.getElementById('camera-pip');
    if (this.cameraAvailable && this.calibrated) {
      pip.style.display = '';
      pip.classList.remove('pip-hidden');
      pip.classList.add('pip-visible');
    }
  }

  async togglePlay() {
    const btn = document.getElementById('play-btn');
    if (this.playing) {
      this.playing = false;
      this.countingIn = false;
      this.timer.stop();
      this.lastMetronomeBeat = -1;
      btn.textContent = 'Play';
      btn.classList.remove('active');
      if (this.autoMode) this.toggleAuto();
      document.getElementById('lyrics-overlay').classList.add('hidden');
      this.showWelcome();
      this.updateIdleLabel();
    } else {
      if (!this.currentSong) return;
      if (!this.calibrated) {
        // Lazily request camera on first play
        const hasCam = await this.ensureCamera();
        if (hasCam) {
          this.startCalibration();
        } else {
          this.useDefaultCalibration();
        }
        return;
      }
      this.playing = true;
      this.audio.start();
      this.resetScore();
      this.lastMetronomeBeat = -1;
      this.startCountIn();
      btn.textContent = 'Stop';
      btn.classList.add('active');
      this.completeStep(5);
      this.hideWelcome();
      this.revealAdvancedControls();
      this.showCameraPip();
    }
  }

  async onSongFinished() {
    if (this.autoMode) await this.toggleAuto();
    if (this.playing) await this.togglePlay();
    const el = document.getElementById('section-label');
    if (el) el.textContent = 'Finished!';
  }

  async toggleAuto() {
    const btn = document.getElementById('auto-btn');
    if (this.autoMode) {
      this.autoMode = false;
      this.autoPlayer.stop();
      btn.textContent = 'Demo';
      btn.classList.remove('active');
      // Also stop the song — no sound source without demo or manual strum
      if (this.playing) await this.togglePlay();
      return;
    } else {
      if (!this.currentSong) return;
      // Demo doesn't need camera — use defaults if not calibrated
      if (!this.calibrated) {
        this.useDefaultCalibration();
      }
      this.autoMode = true;
      this.autoPlayer.start();
      btn.textContent = 'Demo Off';
      btn.classList.add('active');
      if (!this.playing) await this.togglePlay();
    }
  }

  async demoSongPattern(song) {
    // Select the song, persist its pattern, close UI, and start demo
    await this.selectSong(song);
    document.getElementById('current-song-label').textContent = song.title;
    document.getElementById('welcome-search-wrap').classList.add('hidden');

    // Persist the pattern choice
    const patName = this.activePatternName;
    const overrides = JSON.parse(localStorage.getItem('air-guitar-pattern-overrides') || '{}');
    overrides[song.id] = patName;
    localStorage.setItem('air-guitar-pattern-overrides', JSON.stringify(overrides));

    // Enter demo mode: hide welcome, start auto playback
    this.hideWelcome();
    if (!this.autoMode) {
      if (!this.calibrated) this.useDefaultCalibration();
      this.autoMode = true;
      this.autoPlayer.start();
      const btn = document.getElementById('auto-btn');
      btn.textContent = 'Demo Off';
      btn.classList.add('active');
    }
    if (!this.playing) await this.togglePlay();
  }

  promptCalibration() {
    const btn = document.getElementById('calibrate-btn');
    btn.classList.add('needs-attention');
    btn.style.transform = 'scale(1.15)';
    setTimeout(() => { btn.style.transform = ''; }, 400);
  }

  async startCalibration() {
    const hasCam = await this.ensureCamera();
    if (!hasCam) {
      this.useDefaultCalibration();
      return;
    }

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
      document.getElementById('calibrate-reset').style.display = '';
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
      this.calibrated = true;
      setTimeout(() => this.finishCalibration(), 600);
    }
  }

  finishCalibration() {
    document.getElementById('calibrate-overlay').classList.add('hidden');
    document.getElementById('calibrate-reset').style.display = 'none';
    const btn = document.getElementById('calibrate-btn');
    btn.classList.remove('active', 'needs-attention');
    this.calibrating = false;
    this.calibrateStep = 0;
    if (this.calibrated) {
      this.completeStep(2);
      this.updateWelcome();
      this.showCameraPip();
      // Auto-start playback if triggered from "Start Playing"
      if (this.playAfterCalibration) {
        this.playAfterCalibration = false;
        this.togglePlay();
      }
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

  updateProgressionDisplay() {
    const el = document.getElementById('progression');
    el.innerHTML = '';
    if (!this.currentSong) return;

    const labelEl = document.getElementById('section-label');
    if (labelEl) {
      if (this.timer.running) {
        const sectionLabel = this.timer.currentSectionLabel();
        labelEl.textContent = sectionLabel || '';
      } else if (!this.playing) {
        labelEl.innerHTML = '<span class="progression-label">Chord Progression</span>';
      }
    }

    const prog = this.timer.running
      ? this.timer.currentSectionProgression()
      : (this.currentSong.progression || []);
    const activeInSection = this.timer.running ? this.timer.currentChordIdxInSection() : -1;

    prog.forEach((c, i) => {
      const pill = document.createElement('span');
      pill.className = 'chord-pill';
      if (i === activeInSection) pill.classList.add('active');
      else if (i < activeInSection) pill.classList.add('past');
      else if (i === activeInSection + 1) pill.classList.add('next');
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

    if (!this.currentBuffers || !this.playing) return { x: this.handState.x, y: this.handState.y };

    const prev = this.handState.prevY;
    const curr = this.handState.y;
    const delta = curr - prev;
    const speed = Math.abs(delta);

    const isDownStrum = delta > 0.5;
    const inBothZone = this.handState.x >= (L.bodyLeft + L.bodyRight) / 2;
    const isUpStrum = inBothZone && delta < -0.5;

    if (isDownStrum || isUpStrum) {
      const vel = Math.min(1, Math.max(0.25, speed / 10));
      const now = performance.now();
      const COOLDOWN = 80;

      if (now - (this._lastJudgeTime || 0) > 200) {
        this._lastJudgeTime = now;
        this.judgeStrum();
      }

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

    if (this.countingIn) {
      const elapsed = (performance.now() - this.countInStart) / 1000;
      const beatDur = 60 / this.countInBpm;
      const currentBeat = Math.floor(elapsed / beatDur);
      if (currentBeat !== this.lastCountInBeat && currentBeat < this.countInBeats) {
        this.lastCountInBeat = currentBeat;
        this.countInCurrent = currentBeat + 1;
        this.audio.playClick(currentBeat === 0);
      }
      if (elapsed >= this.countInBeats * beatDur) {
        this.finishCountIn();
      }
    }

    if (this.playing && !this.countingIn) {
      this.timer.update();
      const idx = this.timer.idx;
      if (idx !== this.lastTimerIdx) {
        this.lastTimerIdx = idx;
        this._lastGuideSlot = -1;
        const ch = this.timer.currentChord();
        if (ch) {
          this.setChord(ch.chord);
          this.chordFlashTime = performance.now();
        }
        this.updateProgressionDisplay();
        this.updateLyrics();
      }
      this.updateBeatDots(this.timer.currentBeat(), this.timer.currentBeatsTotal());

      if (this.metronomeOn) {
        const pat = STRUM_PATTERNS[this.activePatternName];
        if (pat) {
          const patternBeats = pat.slots.length / 2;
          const moduloBeat = this.timer.beatInChord % patternBeats;
          const currentSlot = Math.floor(moduloBeat * 2);
          if (currentSlot !== this._lastGuideSlot) {
            this._lastGuideSlot = currentSlot;
            const slot = pat.slots[currentSlot % pat.slots.length];
            if (slot === 'D') this.audio.playChuck(true);
            else if (slot === 'U') this.audio.playChuck(false);
          }
        }
      }

      if (this.autoMode) {
        this.autoPlayer.check(this.timer.beatInChord, this.timer.idx);
      }
    }

    const c = this.ctx;
    c.clearRect(0, 0, this.W, this.H);

    if (!this.layout || !this.guitarImg) return;
    const L = this.layout;

    c.drawImage(this.coloredGuitar || this.guitarImg, L.imgX, L.imgY, L.imgW, L.imgH);

    // Count-in display
    if (this.countingIn && this.countInCurrent > 0) {
      c.save();
      c.font = 'bold 120px Inter, sans-serif';
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      c.fillStyle = 'rgba(0, 212, 255, 0.8)';
      c.shadowColor = 'rgba(0, 212, 255, 0.5)';
      c.shadowBlur = 30;
      c.fillText(this.countInCurrent, this.W / 2, this.H / 2);
      c.restore();
    }

    if (this.playing && !this.countingIn && this.currentSong) {
      const totalBeatsInChord = this.timer.currentBeatsTotal();
      const beatsLeft = totalBeatsInChord - this.timer.beatInChord;
      if (beatsLeft <= 1) {
        const nextIdx = (this.timer.idx + 1) % this.timer.segments.length;
        const nextChordName = this.timer.segments[nextIdx].chord;
        const nextPos = lookupChord(this.chordDB, nextChordName);
        if (nextPos && nextChordName !== this.currentChordName) {
          drawGhostDots(c, nextPos, L);
        }
      }
    }

    drawNeckDots(c, this.currentPos, L);

    if (this.chordFlashTime && performance.now() - this.chordFlashTime < 200) {
      const t = (performance.now() - this.chordFlashTime) / 200;
      c.save();
      c.globalAlpha = 0.3 * (1 - t);
      c.fillStyle = '#00d4ff';
      const dotR = Math.max(5, L.imgH * 0.022);
      if (this.currentPos) {
        for (let s = 0; s < 6; s++) {
          const f = this.currentPos.frets[s];
          if (f <= 0 || f > L.fretXs.length) continue;
          c.beginPath();
          c.arc(L.fretXs[f - 1], L.stringYs[s], dotR + 4 + t * 6, 0, Math.PI * 2);
          c.fill();
        }
      }
      c.restore();
    }

    if (L.diagW > 50) {
      drawChordDiagram(
        c, this.currentPos, this.currentChordName,
        L.diagX + L.diagW / 2, L.diagY + L.diagH / 2,
        L.diagW, L.diagH
      );
    }

    const beat = this.playing ? this.timer.beatInChord : -1;
    drawStrumPattern(c, this.activePatternName, beat, L.patX, L.patY, L.patW);

    if (this.playing && !this.countingIn) {
      const totalBeats = this.timer.currentBeatsTotal();
      drawBeatTimeline(c, this.activePatternName, beat, totalBeats, L.patX, L.tlY, L.patW);
      drawStrumGuide(c, L, this.activePatternName, beat, totalBeats);
    }

    let cursor = null;

    if (this.autoStrum.active) {
      const elapsed = performance.now() - this.autoStrum.startTime;
      const t = Math.min(1, elapsed / this.autoStrum.duration);
      // Auto-strum cursor plays in the Down+Up zone (right half)
      const autoX = (L.bodyMidX + L.bodyRight) / 2;
      let cursorY;
      if (this.autoStrum.direction === 'down') {
        cursorY = L.stringYs[0] + t * (L.stringYs[5] - L.stringYs[0]);
      } else {
        cursorY = L.stringYs[5] - t * (L.stringYs[5] - L.stringYs[0]);
      }
      cursor = { x: autoX, y: cursorY };
      if (t >= 1) this.autoStrum.active = false;
    }

    if (!this.autoMode && this.cameraAvailable) {
      const hand = this.tracker.detect();
      if (hand) {
        cursor = this.processStrum(hand);
      } else {
        this.handState.active = false;
      }
    }

    if (this.timingPopup) {
      const age = performance.now() - this.timingPopup.time;
      if (age < 600) {
        const t = age / 600;
        c.save();
        c.globalAlpha = 1 - t;
        c.font = `bold ${Math.round(28 + t * 8)}px Inter, sans-serif`;
        c.textAlign = 'center';
        c.textBaseline = 'middle';
        c.fillStyle = this.timingPopup.color;
        c.shadowColor = this.timingPopup.color;
        c.shadowBlur = 12;
        const popX = (L.bodyLeft + L.bodyRight) / 2;
        const popY = L.stringYs[2] - 30 - t * 20;
        c.fillText(this.timingPopup.label, popX, popY);
        if (this.streak > 1) {
          c.font = `600 ${Math.round(16 + t * 4)}px Inter, sans-serif`;
          c.fillText(`${this.streak}x`, popX, popY + 30);
        }
        c.restore();
      } else {
        this.timingPopup = null;
      }
    }

    drawStrumOverlay(c, L, this.stringStates, this.mutedStrings, cursor);
  }
}

// ── Onboarding removed — welcome overlay handles everything ─

const app = new App();
