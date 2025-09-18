// ---------- Utilidades numéricas y geométricas ----------

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export function distance(a, b) {
  const dx = a.x - b.x, dy = a.y - b.y;
  return Math.hypot(dx, dy);
}

// Eye Aspect Ratio clásico con puntos MediaPipe
export function earFromLandmarks(landmarks, left = true) {
  // Izq: [33,160,158,133,153,144]  Der: [362,385,387,263,373,380]
  const p = left ? [33,160,158,133,153,144] : [362,385,387,263,373,380];
  const A = distance(landmarks[p[1]], landmarks[p[5]]);
  const B = distance(landmarks[p[2]], landmarks[p[4]]);
  const C = distance(landmarks[p[0]], landmarks[p[3]]);
  return (A + B) / (2 * (C || 1e-6));
}

// media entre ambos ojos
export function eyeAspectRatio(landmarks) {
  return (earFromLandmarks(landmarks, true) + earFromLandmarks(landmarks, false)) / 2;
}

// Apertura de boca normalizada por el ancho entre comisuras (78–308)
export function mouthAspectRatio(landmarks) {
  const vertical = distance(landmarks[13], landmarks[14]);
  const width = distance(landmarks[78], landmarks[308]) || 1e-6;
  return vertical / width;
}

// Movimiento de cejas normalizado por distancia interocular (positivo = ceja arriba)
export function browMovement(landmarks) {
  const leftBrow = [70, 63, 105], rightBrow = [300, 293, 334];
  const leftEye = [159, 145], rightEye = [386, 374];
  const avgY = (idxs) => idxs.reduce((s, i) => s + landmarks[i].y, 0) / idxs.length;

  const lB = avgY(leftBrow), rB = avgY(rightBrow);
  const lE = avgY(leftEye),  rE = avgY(rightEye);

  let browHeight = ((lE - lB) + (rE - rB)) / 2;
  const eyeDist = distance(landmarks[leftEye[0]], landmarks[rightEye[0]]) || 1e-6;
  return browHeight / eyeDist;
}

// ¿Rostro frontal? (nariz centrada entre ojos)
export function isFaceFrontal(landmarks, tol = 0.02) {
  const leftEye = landmarks[33], rightEye = landmarks[263], noseTip = landmarks[1];
  return Math.abs(noseTip.x - (leftEye.x + rightEye.x) / 2) < tol;
}

// ---------- Suavizados e histéresis ----------

// Promedio móvil simple con longitud N
export function rollingAverage(len = 3) {
  const buf = [];
  return (x) => {
    buf.push(x);
    if (buf.length > len) buf.shift();
    return buf.reduce((a, b) => a + b, 0) / buf.length;
  };
}

// EMA (suavizado exponencial)
export function makeEMA(alpha = 0.4) {
  let s = null;
  return (x) => {
    s = s == null ? x : alpha * x + (1 - alpha) * s;
    return s;
  };
}

// Detector con histéresis: entra cuando > high, sale cuando < low
export function hysteresisDetector({ low, high, initial = false } = {}) {
  let state = initial;
  return (value) => {
    if (!state && value > high) state = true;
    else if (state && value < low) state = false;
    return state;
  };
}
