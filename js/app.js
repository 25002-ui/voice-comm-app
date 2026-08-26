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

const topButtons = [
  { id: 'btn-sun', src: 'assets/audio/ohayo.mp3' },
  { id: 'btn-hand', src: 'assets/audio/otsukare.mp3' },
  { id: 'btn-finger', src: 'assets/audio/koremite.mp3' },
];

const preloadedBuffers = {};
let feedbackBuffer = null;

async function loadAudioBuffer(url) {
  const ctx = getAudioContext();
  const res = await fetch(url);
  const arr = await res.arrayBuffer();
  return await ctx.decodeAudioData(arr);
}

async function preloadAll() {
  for (const b of topButtons) {
    try {
      preloadedBuffers[b.id] = await loadAudioBuffer(b.src);
    } catch (e) {
      console.error('音源の読み込みに失敗しました:', b.src, e);
    }
  }
  try {
    feedbackBuffer = await loadAudioBuffer('assets/audio/FeedbackSound.mp3');
  } catch (e) {
    console.error('操作音の読み込みに失敗しました:', e);
  }
}

function playBuffer(buffer, onEnded) {
  const ctx = getAudioContext();
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.connect(ctx.destination);
  src.onended = () => {
    if (onEnded) onEnded();
  };
  src.start(0);
  return src;
}

function playFeedbackThenBuffer(buffer, onEnded) {
  const ctx = getAudioContext();
  if (feedbackBuffer) {
    const beep = ctx.createBufferSource();
    beep.buffer = feedbackBuffer;
    beep.connect(ctx.destination);
    beep.start(0);
  }
  playBuffer(buffer, onEnded);
}

/* ---------- UI ---------- */

const allButtons = Array.from(document.querySelectorAll('.btn'));

function setAppState(state, buttonId) {
  appState = state;
  activeButtonId = buttonId || null;
  updateButtonDisabled();
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
}
function glowOff(btn) {
  btn.classList.remove('is-glow');
}

/* ---------- 上段ボタン ---------- */

topButtons.forEach((info) => {
  const btn = document.getElementById(info.id);
  if (!btn) return;

  btn.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    if (appState !== STATE.IDLE) return;
    const buffer = preloadedBuffers[info.id];
    if (!buffer) {
      console.error('未読み込みの音源です:', info.id);
      return;
    }
    setAppState(STATE.PLAYING, info.id);
    glowOn(btn);
    playFeedbackThenBuffer(buffer, () => {
      glowOff(btn);
      setAppState(STATE.IDLE);
    });
  });
});

/* ---------- 下段ボタン ---------- */

const recordedBuffers = {}; // buttonId -> AudioBuffer (加工済み)
let micStream = null;
let micRequested = false;

const bottomIds = ['btn-1', 'btn-2', 'btn-3'];
const pressInfo = {}; // buttonId -> { timerId, startTime, longPressed, mediaRecorder, chunks }

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
      // 短押し
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
      // 未録音なら何もしない(音もエラーも出さない)
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
      micRequested = true; // 再度プロンプトを出さない
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

    if (feedbackBuffer) {
      const ctx = getAudioContext();
      const beep = ctx.createBufferSource();
      beep.buffer = feedbackBuffer;
      beep.connect(ctx.destination);
      beep.start(0);
    }
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
      // 短すぎる録音は破棄。既存の録音があれば維持。
      setAppState(STATE.IDLE);
      return;
    }
    setAppState(STATE.PROCESSING, id);
    try {
      const blob = new Blob(info.chunks, { type: info.mediaRecorder.mimeType || 'audio/webm' });
      const arrayBuffer = await blob.arrayBuffer();
      const ctx = getAudioContext();
      const decoded = await ctx.decodeAudioData(arrayBuffer);
      const effect = btn.dataset.effect;
      const processed = await applyEffect(decoded, effect);
      recordedBuffers[id] = processed; // 正常終了時のみ上書き
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

/* ---- 低い声・高い声: グラニュラー方式ピッチシフト(再生時間を維持) ---- */

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
  const ctx = getAudioContext();
  const channels = buffer.numberOfChannels;
  const out = ctx.createBuffer(channels, buffer.length, buffer.sampleRate);
  for (let ch = 0; ch < channels; ch++) {
    const shifted = pitchShiftChannel(buffer.getChannelData(ch), semitones);
    out.copyToChannel(shifted, ch);
  }
  return out;
}

/* ---- ロボット声: リングモジュレーション + ビットクラッシャー + トレモロ + フィルター ---- */

function makeBitcrusherCurve(levels) {
  const curve = new Float32Array(levels);
  for (let i = 0; i < levels; i++) {
    const x = (i / (levels - 1)) * 2 - 1;
    curve[i] = Math.round(x * 8) / 8;
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

  // ビットクラッシャー(WaveShaperによる簡易量子化)
  const bitcrusher = offline.createWaveShaper();
  bitcrusher.curve = makeBitcrusherCurve(32);
  bitcrusher.oversample = 'none';

  // リングモジュレーション
  const ringGain = offline.createGain();
  ringGain.gain.value = 0;
  const ringOsc = offline.createOscillator();
  ringOsc.type = 'sine';
  ringOsc.frequency.value = 45;
  ringOsc.connect(ringGain.gain);

  // トレモロ(振幅の断続感)
  const tremoloGain = offline.createGain();
  tremoloGain.gain.value = 0.6;
  const tremoloOsc = offline.createOscillator();
  tremoloOsc.type = 'square';
  tremoloOsc.frequency.value = 9;
  const tremoloDepth = offline.createGain();
  tremoloDepth.gain.value = 0.4;
  tremoloOsc.connect(tremoloDepth);
  tremoloDepth.connect(tremoloGain.gain);

  // 軽度のディストーション
  const distortion = offline.createWaveShaper();
  distortion.curve = makeDistortionCurve(15);
  distortion.oversample = '2x';

  // 帯域を軽く整えるフィルター
  const lowpass = offline.createBiquadFilter();
  lowpass.type = 'lowpass';
  lowpass.frequency.value = 4500;
  const highpass = offline.createBiquadFilter();
  highpass.type = 'highpass';
  highpass.frequency.value = 120;

  const outGain = offline.createGain();
  outGain.gain.value = 0.9;

  source.connect(bitcrusher);
  bitcrusher.connect(ringGain);
  ringGain.connect(tremoloGain);
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

function unlockAudioOnce() {
  getAudioContext();
  window.removeEventListener('pointerdown', unlockAudioOnce);
}
window.addEventListener('pointerdown', unlockAudioOnce, { once: true });

document.addEventListener(
  'touchmove',
  (e) => {
    e.preventDefault();
  },
  { passive: false }
);

document.addEventListener('contextmenu', (e) => e.preventDefault());

preloadAll();
