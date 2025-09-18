import {
  distance,
  eyeAspectRatio,
  mouthAspectRatio,
  browMovement,
  isFaceFrontal,
  rollingAverage,
  makeEMA,
  hysteresisDetector,
  clamp,
} from './utils.js';

// -------- DOM --------
const video = document.getElementById('video');
const canvas = document.getElementById('overlay');
const ctx = canvas.getContext('2d');
const eyeCountEl = document.getElementById('eye-count');
const eyebrowCountEl = document.getElementById('eyebrow-count');
const mouthCountEl = document.getElementById('mouth-count');
const startBtn = document.getElementById('start-btn');
const stopBtn = document.getElementById('stop-btn');
const saveBtn = document.getElementById('save-btn');
const fpsLabel = document.getElementById('fps-label');
const resetBtn = document.getElementById('reset-counters'); // existe en el HTML nuevo

// Barras de progreso (opcionales en tu HTML)
const meterEyes  = document.querySelector('[data-meter="eyes"]');
const meterBrows = document.querySelector('[data-meter="brows"]');
const meterMouth = document.querySelector('[data-meter="mouth"]');

// -------- Estado --------
let camera = null;
let faceMesh = null;
let running = false;

let eyeCount = 0, eyebrowCount = 0, mouthCount = 0;

// Historial/suavizados
const smoothEAR   = rollingAverage(3);
const smoothMouth = rollingAverage(3);

// Cejas: calibración y suavizado
let browBaseline = null;
let calibrationFrames = 30;
let calibrationCount = 0;
const smoothBrow = rollingAverage(8);
const emaBaseline = makeEMA(0.05); // baseline adaptativa lenta

// Histéresis (evita dobles conteos)
const blinkState = hysteresisDetector({ low: 0.27, high: 0.25, initial: false }); // EAR: más bajo = cerrado
const mouthState = hysteresisDetector({ low: 0.32, high: 0.35, initial: false });
let browUp = false;

// FPS
let lastTime = 0, fpsEMA = makeEMA(0.25);

// -------- Util UI --------
function setText(el, val) { if (el) el.textContent = String(val); }
function setMeter(el, ratio01) {
  if (!el) return;
  const w = clamp(ratio01, 0, 1) * 100;
  el.style.width = `${w}%`;
}

function paintImageToCanvas(image) {
  canvas.width = video.videoWidth || image.width;
  canvas.height = video.videoHeight || image.height;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
}

// -------- Persistencia --------
const STORAGE_KEY = 'tracker_counts_v1';

function persistCounts() {
  try {
    const data = { eyeCount, eyebrowCount, mouthCount, ts: Date.now() };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch {}
}

function loadCounts() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const data = JSON.parse(raw);
    if (typeof data.eyeCount === 'number') eyeCount = data.eyeCount;
    if (typeof data.eyebrowCount === 'number') eyebrowCount = data.eyebrowCount;
    if (typeof data.mouthCount === 'number') mouthCount = data.mouthCount;
  } catch {}
}

// -------- Lógica de resultados --------
function onResults(results) {
  if (!running) return;

  paintImageToCanvas(results.image);

  if (!results.multiFaceLandmarks || results.multiFaceLandmarks.length === 0) {
    // Limpiar UI cuando no hay cara
    setMeter(meterEyes, 0);
    setMeter(meterBrows, 0.5);
    setMeter(meterMouth, 0);
    return;
  }

  const lm = results.multiFaceLandmarks[0];

  // Dibujo de malla (colores distintos para “propio look”)
  drawConnectors(ctx, lm, FACEMESH_TESSELATION,      { color: '#FFFFFF12', lineWidth: 1 });
  drawConnectors(ctx, lm, FACEMESH_LEFT_EYE,         { color: '#ff6060',   lineWidth: 2 });
  drawConnectors(ctx, lm, FACEMESH_RIGHT_EYE,        { color: '#ff6060',   lineWidth: 2 });
  drawConnectors(ctx, lm, FACEMESH_LIPS,             { color: '#00d5ff',   lineWidth: 2 });
  drawConnectors(ctx, lm, FACEMESH_LEFT_EYEBROW,     { color: '#5b8cff',   lineWidth: 2 });
  drawConnectors(ctx, lm, FACEMESH_RIGHT_EYEBROW,    { color: '#5b8cff',   lineWidth: 2 });

  // ---------- OJOS (parpadeo) ----------
  const ear = smoothEAR(eyeAspectRatio(lm));
  // Para barras, invertimos: abierto ~ alto, cerrado ~ bajo
  setMeter(meterEyes, clamp((ear - 0.15) / (0.35 - 0.15), 0, 1));

  const eyesClosed = ear < 0.25;
  const eyesOpen   = ear > 0.27;
  const isClosed = blinkState(eyesClosed ? 0.24 : eyesOpen ? 0.28 : ear); // alimentamos con valor proxy
  // Conteo en flanco de bajada -> subida (cerrado -> abierto). Usamos transición manual:
  // Detectamos cuando pasa de true (cerrado) a false (abierto)
  // Para lograrlo, guardamos estado anterior dentro del closure del detector (ya lo hace).
  // Pero queremos contar en el momento del cierre: más natural => al detectar transición a cerrado:
  // Haremos conteo en el instante en que 'isClosed' se vuelve true y antes era false:
  // Implementación: el detector no expone prev; replicamos con una variable:
  if (!onResults._prevBlink && isClosed) {
    eyeCount++;
    setText(eyeCountEl, eyeCount);
    postGestureEstado('parpadeo', 'cerrado');
  }
  if (onResults._prevBlink && !isClosed) {
    postGestureEstado('parpadeo', 'abierto');
  }
  onResults._prevBlink = isClosed;

  // ---------- BOCA ----------
  const mouth = smoothMouth(mouthAspectRatio(lm));
  setMeter(meterMouth, clamp((mouth - 0.15) / (0.55 - 0.15), 0, 1));

  const mouthOpened = mouth > 0.35;
  const mouthClosed = mouth < 0.32;
  const openNow = mouthState(mouthOpened ? 0.36 : mouthClosed ? 0.31 : mouth);

  if (!onResults._prevMouth && openNow) {
    mouthCount++;
    setText(mouthCountEl, mouthCount);
    postGestureEstado('boca', 'abierta');
  }
  if (onResults._prevMouth && !openNow) {
    postGestureEstado('boca', 'cerrada');
  }
  onResults._prevMouth = openNow;

  // ---------- CEJAS ----------
  const brow = smoothBrow(browMovement(lm));

  // Calibración inicial a frames: baseline promedio
  if (calibrationCount < calibrationFrames) {
    browBaseline = browBaseline == null ? brow : (browBaseline * calibrationCount + brow) / (calibrationCount + 1);
    calibrationCount++;
  } else {
    // Baseline adaptativa lenta (EMA) para drift
    browBaseline = emaBaseline(browBaseline == null ? brow : browBaseline);
  }

  let browDelta = 0;
  if (browBaseline != null) {
    browDelta = brow - browBaseline;
  }
  // mapping de barra: centro 0.5, arriba >0 positivo
  setMeter(meterBrows, clamp(0.5 + browDelta * 12, 0, 1)); // factor visual

  if (isFaceFrontal(lm) && calibrationCount >= calibrationFrames) {
    const TH = 0.01; // umbral cejas arriba
    if (!browUp && browDelta > TH) {
      browUp = true;
      eyebrowCount++;
      setText(eyebrowCountEl, eyebrowCount);
      postGestureEstado('cejas', 'arriba');
    } else if (browUp && browDelta <= TH * 0.7) {
      // histéresis suave para bajar
      browUp = false;
      postGestureEstado('cejas', 'abajo');
    }
  }

  // ---------- FPS ----------
  const now = performance.now();
  if (lastTime) {
    const fps = 1000 / (now - lastTime);
    const f = fpsEMA(fps);
    if (fpsLabel) fpsLabel.textContent = Math.round(f);
  }
  lastTime = now;

  // Persistimos de vez en cuando (barato)
  if ((eyeCount + eyebrowCount + mouthCount) % 3 === 0) persistCounts();
}

// -------- API --------
async function postGestureEstado(tipo, estado) {
  try {
    let url = 'http://localhost:5000/api/';
    if (tipo === 'parpadeo') url += 'parpadeo';
    else if (tipo === 'cejas') url += 'cejas';
    else if (tipo === 'boca') url += 'boca';
    else return;

    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ estado })
    });
  } catch (e) {
    console.error('Error al enviar a API:', e);
  }
}

// -------- Control cámara / MediaPipe --------
function initFaceMesh() {
  faceMesh = new FaceMesh({
    locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/${file}`
  });
  faceMesh.setOptions({
    maxNumFaces: 1,
    refineLandmarks: true,
    minDetectionConfidence: 0.5,
    minTrackingConfidence: 0.5
  });
  faceMesh.onResults(onResults);
}

function startCamera() {
  if (!faceMesh) initFaceMesh();
  camera = new Camera(video, {
    onFrame: async () => {
      try {
        await faceMesh.send({ image: video });
      } catch (e) {
        // evita spam si la cámara se detiene durante un frame
      }
    },
    width: 640, height: 480
  });
  camera.start();
  running = true;
  lastTime = 0;
}

function stopCamera(clear = true) {
  running = false;
  if (camera) {
    try { camera.stop(); } catch {}
  }
  if (clear) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }
}

// -------- Botonera --------
startBtn?.addEventListener('click', () => {
  // Reinicia calibración de cejas al iniciar sesión
  calibrationCount = 0;
  browBaseline = null;
  startCamera();
});

stopBtn?.addEventListener('click', () => {
  stopCamera(true);
});

saveBtn?.addEventListener('click', () => {
  const data = { eyeCount, eyebrowCount, mouthCount, ts: Date.now() };
  const jsonStr = JSON.stringify(data, null, 2);
  const blob = new Blob([jsonStr], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `conteo_gestos_${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  a.click();
  URL.revokeObjectURL(url);

  // Respaldar también en localStorage
  persistCounts();

  // Reset visual y contadores
  resetCounts();
});

// Reset (si existe el botón en tu HTML)
resetBtn?.addEventListener('click', resetCounts);

function resetCounts() {
  eyeCount = eyebrowCount = mouthCount = 0;
  setText(eyeCountEl, 0);
  setText(eyebrowCountEl, 0);
  setText(mouthCountEl, 0);
  setMeter(meterEyes, 0);
  setMeter(meterBrows, 0.5);
  setMeter(meterMouth, 0);
  persistCounts();
}

// Pausar cuando se oculta la pestaña (ahorra CPU y evita falsos eventos)
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    stopCamera(false);
  } else {
    if (!running) startCamera();
  }
});

// -------- Boot --------
loadCounts();
setText(eyeCountEl, eyeCount);
setText(eyebrowCountEl, eyebrowCount);
setText(mouthCountEl, mouthCount);
setMeter(meterEyes, 0);
setMeter(meterBrows, 0.5);
setMeter(meterMouth, 0);
