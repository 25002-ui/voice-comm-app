'use strict';

/* =========================================================
   音声コミュニケーションアプリ app.js
   ========================================================= */

const STATE = {
  IDLE: 'IDLE',
  PRESSING: 'PRESSING',
  REQUESTING_MIC_PERMISSION: 'REQUESTING_MIC_PERMISSION',
  RECORDING: 'RECORDING',
  PROCESSING: 'PROCESSING',
  PLAYING: 'PLAYING',
};

let appState = STATE.IDLE;
let activeButtonId = null;

const LONG_PRESS_MS = 500;
const MAX_RECORD_MS = 10000;
const MIN_RECORD_MS = 300;

let audioCtx = null;
let audioUnlocked = false;

let decodeCtx = null;
function getDecodeContext() {
  if (!decodeCtx) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    decodeCtx = new Ctx();
  }
  return decodeCtx;
}

function getAudioContext() {
  if (!audioCtx) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    audioCtx = new Ctx();
  }
  if (audioCtx.state === 'suspended') {
    audioCtx.resume().catch(() => {});
  }
  return audioCtx;
}

async function ensureAudioReady() {
  const ctx = getAudioContext();
  if (ctx.state !== 'running') {
    try {
      await ctx.resume();
    } catch (e) {
      // 無視
    }
  }
  if (!audioUnlocked) {
    try {
      const silentBuffer = ctx.createBuffer(1, 1, 22050);
      const silentSource = ctx.createBufferSource();
      silentSource.buffer = silentBuffer;
      silentSource.connect(ctx.destination);
      silentSource.start(0);
    } catch (e) {
      console.error('音声の初期化(アンロック)に失敗しました:', e);
    }
    if (ctx.state === 'running') {
      audioUnlocked = true;
    }
  }
  return ctx;
}

const topButtons = [
  { id: 'btn-sun', src: 'assets/audio/ohayo.mp3', gainDb: 13 },
  { id: 'btn-hand', src: 'assets/audio/otsukare.mp3', gainDb: 13 },
  { id: 'btn-finger', src: 'assets/audio/koremite.mp3', gainDb: 13 },
  { id: 'brand-switch', src: 'assets/audio/ryotaswitch.mp3', gainDb: 5 }, // 他より-8dB
];

const preloadedBuffers = {};
let feedbackBufferPromise = null;

function startPreload() {
  topButtons.forEach((b) => {
    preloadedBuffers[b.id] = loadAudioBuffer(b.src).catch((e) => {
      console.error('音源の読み込みに失敗しました:', b.src, e);
      return null;
    });
  });
  feedbackBufferPromise = loadAudioBuffer('assets/audio/FeedbackSound.mp3').catch((e) => {
    console.error('操作音の読み込みに失敗しました:', e);
    return null;
  });
}

const GAIN_DB_VOICE = 13;
const GAIN_DB_FEEDBACK = -6;

function dbToGain(db) {
  return Math.pow(10, db / 20);
}

async function loadAudioBuffer(url) {
  const ctx = getDecodeContext();
  const res = await fetch(url);
  const arr = await res.arrayBuffer();
  return await ctx.decodeAudioData(arr);
}

async function playBufferWithGain(buffer, gainDb, onEnded) {
  const ctx = await ensureAudioReady();
  const src = ctx.createBufferSource();
  src.buffer = buffer;

  const gainNode = ctx.createGain();
  gainNode.gain.value = dbToGain(gainDb);

  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.setValueAtTime(-3, ctx.currentTime);
  limiter.knee.setValueAtTime(6, ctx.currentTime);
  limiter.ratio.setValueAtTime(12, ctx.currentTime);
  limiter.attack.setValueAtTime(0.003, ctx.currentTime);
  limiter.release.setValueAtTime(0.15, ctx.currentTime);

  src.connect(gainNode);
  gainNode.connect(limiter);
  limiter.connect(ctx.destination);

  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    clearTimeout(safetyTimer);
    if (onEnded) onEnded();
  };

  src.onended = finish;

  const safetyMs = (buffer.duration + 0.5) * 1000;
  const safetyTimer = setTimeout(finish, safetyMs);

  try {
    src.start(0);
  } catch (err) {
    console.error('再生を開始できませんでした:', err);
    finish();
  }
  return src;
}

async function playFeedback() {
  if (!feedbackBufferPromise) return;
  const buffer = await feedbackBufferPromise;
  if (!buffer) return;
  playBufferWithGain(buffer, GAIN_DB_FEEDBACK, null);
}

function playFeedbackThenBuffer(buffer, onEnded, gainDb = GAIN_DB_VOICE) {
  playFeedback();
  playBufferWithGain(buffer, gainDb, onEnded);
}

/* ---------- UI ---------- */

const allButtons = Array.from(document.querySelectorAll('.btn'));
const captionEl = document.getElementById('caption');

function showCaption(text) {
  if (captionEl) captionEl.textContent = text || '';
}

function clearCaption() {
  if (captionEl) captionEl.textContent = '';
}

function setAppState(state, buttonId) {
  appState = state;
  activeButtonId = buttonId || null;
  updateButtonDisabled();
  updateThemeButtonsLocked();
}

function updateButtonDisabled() {
  const busy = appState !== STATE.IDLE;
  allButtons.forEach((btn) => {
    if (!busy) {
      btn.classList.remove('is-disabled');
      return;
    }
    if (btn.id === activeButtonId) {
      btn.classList.remove('is-disabled');
    } else {
      btn.classList.add('is-disabled');
    }
  });
}

function glowOn(btn) {
  btn.classList.add('is-glow');
  showCaption(btn.dataset.label);
}
function glowOff(btn) {
  btn.classList.remove('is-glow');
  clearCaption();
}

/* ---------- 上段ボタン(りょうたスイッチ含む) ---------- */

topButtons.forEach((info) => {
  const btn = document.getElementById(info.id);
  if (!btn) return;

  btn.addEventListener('pointerdown', async (e) => {
    e.preventDefault();
    if (appState !== STATE.IDLE) return;
    setAppState(STATE.PLAYING, info.id);
    glowOn(btn);

    const buffer = await preloadedBuffers[info.id];
    if (!buffer) {
      console.error('音源を再生できませんでした:', info.id);
      glowOff(btn);
      setAppState(STATE.IDLE);
      return;
    }

    playFeedbackThenBuffer(
      buffer,
      () => {
        glowOff(btn);
        setAppState(STATE.IDLE);
      },
      info.gainDb
    );
  });
});

/* ---------- 下段ボタン ---------- */

const recordedBuffers = {};
let micStream = null;
let micRequested = false;

const bottomIds = ['btn-1', 'btn-2', 'btn-3'];
const pressInfo = {};

bottomIds.forEach((id) => {
  const btn = document.getElementById(id);
  if (!btn) return;
  pressInfo[id] = { timerId: null, startTime: 0, longPressed: false, mediaRecorder: null, chunks: [] };

  btn.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    if (appState !== STATE.IDLE) return;
    try {
      btn.setPointerCapture(e.pointerId);
    } catch (err) {
      /* Pointer Capture未対応環境でも継続 */
    }

    const info = pressInfo[id];
    info.longPressed = false;
    info.startTime = performance.now();
    setAppState(STATE.PRESSING, id);
    btn.classList.add('is-pressed');

    info.timerId = setTimeout(() => {
      info.longPressed = true;
      startLongPress(id, btn);
    }, LONG_PRESS_MS);
  });

  const endHandler = (e) => {
    const info = pressInfo[id];
    btn.classList.remove('is-pressed');

    if (appState === STATE.PRESSING && !info.longPressed) {
      clearTimeout(info.timerId);
      setAppState(STATE.IDLE);
      const existing = recordedBuffers[id];
      if (existing) {
        setAppState(STATE.PLAYING, id);
        glowOn(btn);
        playFeedbackThenBuffer(existing, () => {
          glowOff(btn);
          setAppState(STATE.IDLE);
        });
      }
      return;
    }

    if (appState === STATE.RECORDING && activeButtonId === id) {
      stopRecording(id, btn);
    }
  };

  btn.addEventListener('pointerup', endHandler);
  btn.addEventListener('pointercancel', endHandler);
});

async function startLongPress(id, btn) {
  if (!micRequested) {
    setAppState(STATE.REQUESTING_MIC_PERMISSION, id);
    try {
      micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      micRequested = true;
    } catch (err) {
      console.error('マイクの利用が許可されませんでした:', err);
      micRequested = true;
      setAppState(STATE.IDLE);
      return;
    }
  }

  if (!micStream) {
    setAppState(STATE.IDLE);
    return;
  }

  try {
    const mimeType = pickMimeType();
    const recorder = new MediaRecorder(micStream, mimeType ? { mimeType } : undefined);
    const info = pressInfo[id];
    info.mediaRecorder = recorder;
    info.chunks = [];

    recorder.ondataavailable = (ev) => {
      if (ev.data && ev.data.size > 0) info.chunks.push(ev.data);
    };

    recorder.onstart = () => {
      setAppState(STATE.RECORDING, id);
      glowOn(btn);
      info.recordStartTime = performance.now();
      info.autoStopTimer = setTimeout(() => {
        if (appState === STATE.RECORDING && activeButtonId === id) {
          stopRecording(id, btn);
        }
      }, MAX_RECORD_MS);
    };

    recorder.onerror = (ev) => {
      console.error('録音でエラーが発生しました:', ev.error);
    };

    playFeedback();
    recorder.start();
  } catch (err) {
    console.error('録音を開始できませんでした:', err);
    setAppState(STATE.IDLE);
  }
}

function stopRecording(id, btn) {
  const info = pressInfo[id];
  if (info.autoStopTimer) {
    clearTimeout(info.autoStopTimer);
    info.autoStopTimer = null;
  }
  glowOff(btn);

  const duration = performance.now() - (info.recordStartTime || performance.now());

  if (!info.mediaRecorder || info.mediaRecorder.state === 'inactive') {
    setAppState(STATE.IDLE);
    return;
  }

  info.mediaRecorder.onstop = async () => {
    if (duration < MIN_RECORD_MS) {
      setAppState(STATE.IDLE);
      return;
    }
    setAppState(STATE.PROCESSING, id);
    try {
      const blob = new Blob(info.chunks, { type: info.mediaRecorder.mimeType || 'audio/webm' });
      const arrayBuffer = await blob.arrayBuffer();
      const ctx = getDecodeContext();
      const decoded = await ctx.decodeAudioData(arrayBuffer);
      const effect = btn.dataset.effect;
      const processed = await applyEffect(decoded, effect);
      recordedBuffers[id] = processed;
    } catch (err) {
      console.error('音声の加工に失敗しました。以前の録音を維持します:', err);
    } finally {
      setAppState(STATE.IDLE);
    }
  };

  try {
    info.mediaRecorder.stop();
  } catch (err) {
    console.error('録音の停止に失敗しました:', err);
    setAppState(STATE.IDLE);
  }
}

function pickMimeType() {
  const candidates = [
    'audio/mp4',
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/ogg;codecs=opus',
  ];
  if (typeof MediaRecorder === 'undefined' || !MediaRecorder.isTypeSupported) return null;
  for (const c of candidates) {
    if (MediaRecorder.isTypeSupported(c)) return c;
  }
  return null;
}

/* =========================================================
   音声エフェクト
   ========================================================= */

async function applyEffect(buffer, effect) {
  if (effect === 'low') return pitchShiftBuffer(buffer, -5);
  if (effect === 'high') return pitchShiftBuffer(buffer, 6);
  if (effect === 'robot') return robotVoiceBuffer(buffer);
  return buffer;
}

function hannWindow(size) {
  const w = new Float32Array(size);
  for (let i = 0; i < size; i++) {
    w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (size - 1));
  }
  return w;
}

function pitchShiftChannel(inputData, semitones) {
  const factor = Math.pow(2, semitones / 12);
  const grainSize = 2048;
  const hop = Math.floor(grainSize / 4);
  const window = hannWindow(grainSize);
  const output = new Float32Array(inputData.length);
  const weight = new Float32Array(inputData.length);

  for (let i = 0; i + 1 < inputData.length; i += hop) {
    for (let j = 0; j < grainSize; j++) {
      const outIdx = i + j;
      if (outIdx >= output.length) break;
      const srcPos = i + j * factor;
      const idx = Math.floor(srcPos);
      const frac = srcPos - idx;
      const s0 = idx >= 0 && idx < inputData.length ? inputData[idx] : 0;
      const s1 = idx + 1 >= 0 && idx + 1 < inputData.length ? inputData[idx + 1] : 0;
      const sample = s0 + (s1 - s0) * frac;
      const w = window[j];
      output[outIdx] += sample * w;
      weight[outIdx] += w;
    }
  }

  for (let i = 0; i < output.length; i++) {
    if (weight[i] > 0.0001) output[i] = output[i] / weight[i];
  }
  return output;
}

function pitchShiftBuffer(buffer, semitones) {
  const ctx = getDecodeContext();
  const channels = buffer.numberOfChannels;
  const out = ctx.createBuffer(channels, buffer.length, buffer.sampleRate);
  for (let ch = 0; ch < channels; ch++) {
    const shifted = pitchShiftChannel(buffer.getChannelData(ch), semitones);
    out.copyToChannel(shifted, ch);
  }
  return out;
}

function makeBitcrusherCurve(levels) {
  const curve = new Float32Array(256);
  const step = 2 / levels;
  for (let i = 0; i < 256; i++) {
    const x = (i / 255) * 2 - 1;
    curve[i] = Math.round(x / step) * step;
  }
  return curve;
}

function makeDistortionCurve(amount) {
  const n = 256;
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = ((3 + amount) * x * 20 * (Math.PI / 180)) / (Math.PI + amount * Math.abs(x));
  }
  return curve;
}

async function robotVoiceBuffer(buffer) {
  const OfflineCtx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  const offline = new OfflineCtx(buffer.numberOfChannels, buffer.length, buffer.sampleRate);

  const source = offline.createBufferSource();
  source.buffer = buffer;

  const bitcrusher = offline.createWaveShaper();
  bitcrusher.curve = makeBitcrusherCurve(56);
  bitcrusher.oversample = 'none';

  const ringBaseGain = offline.createGain();
  ringBaseGain.gain.value = 0.55;
  const ringDepth = offline.createGain();
  ringDepth.gain.value = 0.45;
  const ringOsc = offline.createOscillator();
  ringOsc.type = 'sine';
  ringOsc.frequency.value = 30;
  ringOsc.connect(ringDepth);
  ringDepth.connect(ringBaseGain.gain);

  const tremoloGain = offline.createGain();
  tremoloGain.gain.value = 0.78;
  const tremoloOsc = offline.createOscillator();
  tremoloOsc.type = 'square';
  tremoloOsc.frequency.value = 9;
  const tremoloDepth = offline.createGain();
  tremoloDepth.gain.value = 0.22;
  tremoloOsc.connect(tremoloDepth);
  tremoloDepth.connect(tremoloGain.gain);

  const distortion = offline.createWaveShaper();
  distortion.curve = makeDistortionCurve(6);
  distortion.oversample = '2x';

  const lowpass = offline.createBiquadFilter();
  lowpass.type = 'lowpass';
  lowpass.frequency.value = 5500;
  const highpass = offline.createBiquadFilter();
  highpass.type = 'highpass';
  highpass.frequency.value = 100;

  const outGain = offline.createGain();
  outGain.gain.value = 0.95;

  source.connect(bitcrusher);
  bitcrusher.connect(ringBaseGain);
  ringBaseGain.connect(tremoloGain);
  tremoloGain.connect(distortion);
  distortion.connect(highpass);
  highpass.connect(lowpass);
  lowpass.connect(outGain);
  outGain.connect(offline.destination);

  source.start(0);
  ringOsc.start(0);
  tremoloOsc.start(0);

  const rendered = await offline.startRendering();
  return rendered;
}

/* =========================================================
   初期化
   ========================================================= */

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && audioCtx && audioCtx.state === 'suspended') {
    audioCtx.resume().catch(() => {});
    audioUnlocked = false;
  }
});

document.addEventListener(
  'touchmove',
  (e) => {
    e.preventDefault();
  },
  { passive: false }
);

document.addEventListener('contextmenu', (e) => e.preventDefault());

/* =========================================================
   テーマ切替(ORIGINAL / CRYSTAL / SCRATCH)
   ========================================================= */

const THEME_STORAGE_KEY = 'ryotaSwitchTheme';
const VALID_THEMES = ['original', 'crystal', 'scratch'];
const themeButtons = Array.from(document.querySelectorAll('.theme-icon-btn'));

function updateThemeButtonsLocked() {
  const busy = appState !== STATE.IDLE;
  themeButtons.forEach((btn) => {
    btn.classList.toggle('is-locked', busy);
  });
}

function getStoredTheme() {
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (VALID_THEMES.includes(stored)) return stored;
  } catch (e) {
    // localStorageが使えない環境(プライベートブラウジング等)では無視し、ORIGINALから始める
  }
  return 'original';
}

function setTheme(theme) {
  if (!VALID_THEMES.includes(theme)) return;
  document.body.dataset.theme = theme;
  themeButtons.forEach((btn) => {
    const target = btn.dataset.themeTarget;
    if (target) {
      btn.setAttribute('aria-pressed', target === theme ? 'true' : 'false');
    }
  });
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch (e) {
    // 保存できなくても致命的ではないので無視
  }
}

document.querySelectorAll('[data-theme-target]').forEach((btn) => {
  btn.addEventListener('click', () => {
    if (appState !== STATE.IDLE) return;
    if (btn.disabled) return;
    setTheme(btn.dataset.themeTarget);
  });
});

setTheme(getStoredTheme());

startPreload();
