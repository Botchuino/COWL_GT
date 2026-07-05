/* =====================================================================
   CLAUDE · GT  —  renderer logic (V3)
   Pure vanilla JS. Talks to the main process only through window.dash
   (see the IPC contract). Everything degrades gracefully if a field or
   the bridge itself is missing, so the page also renders in a plain
   browser for visual work.

   V3 telemetry: the renderer keeps a short history of state samples and
   computes tokens-per-second client-side (fast EMA ~3 samples for the
   TACHIMETRO, slow EMA ~20 s for the CONTAGIRI). BENZINA shows free
   context (needle falls toward E as contextPct rises) with a RISERVA
   jewel; the roller odometer totals tokensIn+tokensOut and the trip
   line shows lines of code added/removed. The route plate and activity
   strip read state.cwd / sessionId / targetApp / activity.
   ===================================================================== */
'use strict';

/* Wrapped in an IIFE: contextBridge defines window.dash as a NON-CONFIGURABLE
   global, so a top-level `const dash` is a SyntaxError in Electron (fine in a
   plain browser — which is why browser testing missed it). Function scope
   makes the shadowing legal. */
(() => {

/* ---- safe bridge: never throw if window.dash is absent ---- */
const noop = () => {};
const dash = window.dash || {
  getConfig: async () => null,
  saveConfig: async () => {},
  getState: async () => null,
  onState: noop,
  shift: async () => ({ ok: false, method: 'none', error: 'no bridge' }),
  boost: async () => ({ ok: false, error: 'no bridge' }),
  runButton: async () => ({ ok: false, error: 'no bridge' }),
  wipe: async () => ({ ok: false, error: 'no bridge' }),
  listTerminals: async () => [],
  setTerminal: async () => {},
  minimize: noop,
  toggleClose: noop,
  toggleAlwaysOnTop: async () => false,
};

const $ = (sel, root = document) => root.querySelector(sel);
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

let CONFIG = null;      // current config
let engagedGear = null; // gear.gear number currently engaged

/* =====================================================================
   1. GAUGE GEOMETRY + BUILDERS  (Veglia Borletti idiom)
   ===================================================================== */
const G = { cx: 110, cy: 110, START: -135, SWEEP: 270 };

const degForFrac = (f) => G.START + clamp01(f) * G.SWEEP;
function clamp01(v) { v = Number(v); if (!isFinite(v)) return 0; return v < 0 ? 0 : v > 1 ? 1 : v; }

function polar(cx, cy, r, deg) {
  const rad = deg * Math.PI / 180;
  return { x: cx + r * Math.sin(rad), y: cy - r * Math.cos(rad) };
}
function arcPath(cx, cy, r, d1, d2) {
  const a = polar(cx, cy, r, d1), b = polar(cx, cy, r, d2);
  const large = (d2 - d1) > 180 ? 1 : 0;
  return `M ${a.x.toFixed(2)} ${a.y.toFixed(2)} A ${r} ${r} 0 ${large} 1 ${b.x.toFixed(2)} ${b.y.toFixed(2)}`;
}

/* Build one gauge's SVG into el (a .gauge-svg holder).
   cfg: { id, majors, minorGroup, labelEvery, numFor, numSize,
          redFrom, redTo, faceLabel, faceLabelSize, faceCaption,
          unit, unitY, valY, valSize, initialText, maker }        */
function buildGauge(el, cfg) {
  const { cx, cy } = G;
  const rFace = 90, rTickOut = 84, rMajorIn = 68, rMinorIn = 76, rNum = 55;
  const gid = cfg.id;
  const numSize = cfg.numSize || 12;

  let ticks = '';
  const majors = cfg.majors;
  for (let i = 0; i <= majors; i++) {
    const f = i / majors;
    const deg = degForFrac(f);
    const o = polar(cx, cy, rTickOut, deg);
    const isMajor = (i % (cfg.minorGroup || 1) === 0);
    const inr = polar(cx, cy, isMajor ? rMajorIn : rMinorIn, deg);
    ticks += `<line x1="${o.x.toFixed(2)}" y1="${o.y.toFixed(2)}" x2="${inr.x.toFixed(2)}" y2="${inr.y.toFixed(2)}"
                stroke="var(--ink)" stroke-width="${isMajor ? 2.4 : 1}" stroke-linecap="round" opacity="${isMajor ? 0.9 : 0.5}"/>`;
    if (isMajor && i % cfg.labelEvery === 0) {
      const n = polar(cx, cy, rNum, deg);
      const val = cfg.numFor(i / majors);
      ticks += `<text x="${n.x.toFixed(2)}" y="${(n.y + numSize * 0.34).toFixed(2)}" text-anchor="middle"
                  font-family="var(--font-serif)" font-size="${numSize}" font-weight="700" fill="var(--ink)">${val}</text>`;
    }
  }

  // redline arc (redFrom..redTo, default up to full scale)
  const redTo = (cfg.redTo == null) ? 1 : cfg.redTo;
  const redPath = arcPath(cx, cy, rTickOut + 3, degForFrac(cfg.redFrom), degForFrac(redTo));

  el.innerHTML = `
  <svg viewBox="0 0 220 220" aria-hidden="true">
    <defs>
      <radialGradient id="${gid}-bezel" cx="38%" cy="30%" r="75%">
        <stop offset="0%"  stop-color="var(--chrome-hi)"/>
        <stop offset="35%" stop-color="var(--chrome-1)"/>
        <stop offset="70%" stop-color="var(--chrome-2)"/>
        <stop offset="100%" stop-color="var(--chrome-lo)"/>
      </radialGradient>
      <radialGradient id="${gid}-face" cx="50%" cy="38%" r="72%">
        <stop offset="0%"  stop-color="var(--enamel)"/>
        <stop offset="82%" stop-color="var(--enamel)"/>
        <stop offset="100%" stop-color="var(--enamel-edge)"/>
      </radialGradient>
      <linearGradient id="${gid}-needle" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="var(--needle-hi)"/>
        <stop offset="100%" stop-color="var(--needle)"/>
      </linearGradient>
      <linearGradient id="${gid}-glass" x1="0" y1="0" x2="0.35" y2="1">
        <stop offset="0%"  stop-color="rgba(255,255,255,0.34)"/>
        <stop offset="55%" stop-color="rgba(255,255,255,0.06)"/>
        <stop offset="100%" stop-color="rgba(255,255,255,0)"/>
      </linearGradient>
      <clipPath id="${gid}-clip"><circle cx="${cx}" cy="${cy}" r="${rFace}"/></clipPath>
    </defs>

    <!-- chrome bezel (anisotropic conic sheen is layered by CSS on .gauge::after) -->
    <circle cx="${cx}" cy="${cy}" r="106" fill="url(#${gid}-bezel)"/>
    <circle cx="${cx}" cy="${cy}" r="98" fill="none" stroke="rgba(0,0,0,0.35)" stroke-width="2"/>
    <!-- ivory enamel face -->
    <circle cx="${cx}" cy="${cy}" r="${rFace}" fill="url(#${gid}-face)"/>
    <circle cx="${cx}" cy="${cy}" r="${rFace}" fill="none" stroke="var(--enamel-shadow)" stroke-width="1.5"/>
    <!-- enamel aging: faint speckle patina clipped to the face -->
    <g clip-path="url(#${gid}-clip)">
      <rect x="${cx - rFace}" y="${cy - rFace}" width="${rFace * 2}" height="${rFace * 2}"
            filter="url(#patina)" opacity="0.55"/>
    </g>

    <!-- redline arc -->
    <path d="${redPath}" fill="none" stroke="var(--redline)" stroke-width="5" stroke-linecap="round"/>

    <!-- engraved tick work + numerals -->
    <g>${ticks}</g>

    <!-- italic face label (Bodoni italic) -->
    ${cfg.faceLabel ? `<text x="${cx}" y="${cfg.faceLabelY != null ? cfg.faceLabelY : cy - 34}" text-anchor="middle"
          font-family="var(--font-italic)" font-style="italic" font-size="${cfg.faceLabelSize || 12}"
          letter-spacing="0.6" fill="var(--ink-soft)">${cfg.faceLabel}</text>` : ''}

    <!-- maker's mark -->
    ${cfg.maker ? `<text x="${cx}" y="${cy - 16}" text-anchor="middle"
          font-family="var(--font-display)" font-size="6.5" letter-spacing="1.6"
          fill="var(--ink-soft)" opacity="0.85">${cfg.maker}</text>` : ''}

    <!-- optional small italic caption (e.g. "regime di generazione") -->
    ${cfg.faceCaption ? `<text x="${cx}" y="${cfg.faceCaptionY != null ? cfg.faceCaptionY : cy + 34}" text-anchor="middle"
          font-family="var(--font-italic)" font-style="italic" font-size="7.5"
          letter-spacing="0.3" fill="var(--ink-soft)">${cfg.faceCaption}</text>` : ''}

    <!-- unit + live value, seated in the lower gap between numerals -->
    ${cfg.unit ? `<text x="${cx}" y="${cfg.unitY != null ? cfg.unitY : cy + 42}" text-anchor="middle" font-family="var(--font-serif)"
          font-size="8.5" letter-spacing="1.5" fill="var(--ink-soft)">${cfg.unit}</text>` : ''}
    <text id="${gid}-val" x="${cx}" y="${cfg.valY != null ? cfg.valY : cy + 62}" text-anchor="middle" font-family="var(--font-display)"
          font-size="${cfg.valSize || 15}" font-weight="700" fill="var(--ink)">${cfg.initialText}</text>

    <!-- bezel screws at the cardinal corners of the face -->
    ${[45, 135, 225, 315].map((a) => {
      const s = polar(cx, cy, 101, a);
      return `<circle cx="${s.x.toFixed(1)}" cy="${s.y.toFixed(1)}" r="2.4" fill="var(--chrome-2)"
                stroke="rgba(0,0,0,0.5)" stroke-width="0.6"/>
              <line x1="${(s.x - 1.4).toFixed(1)}" y1="${(s.y + 1).toFixed(1)}"
                    x2="${(s.x + 1.4).toFixed(1)}" y2="${(s.y - 1).toFixed(1)}"
                    stroke="rgba(0,0,0,0.6)" stroke-width="0.6"/>`;
    }).join('')}

    <!-- oxblood needle with tail counterweight -->
    <g id="${gid}-needle-g" transform="rotate(${degForFrac(0)} ${cx} ${cy})">
      <polygon points="${cx - 3},${cy + 14} ${cx + 3},${cy + 14} ${cx + 1.1},${cy - 78} ${cx - 1.1},${cy - 78}"
               fill="url(#${gid}-needle)" stroke="rgba(0,0,0,0.25)" stroke-width="0.4"/>
      <circle cx="${cx}" cy="${cy + 16}" r="4.5" fill="var(--needle)" stroke="rgba(0,0,0,0.35)" stroke-width="0.6"/>
      <circle cx="${cx}" cy="${cy - 78}" r="1.6" fill="var(--needle-hi)"/>
    </g>

    <!-- centre hub with slotted screw -->
    <circle cx="${cx}" cy="${cy}" r="11" fill="url(#${gid}-bezel)" stroke="rgba(0,0,0,0.4)" stroke-width="1"/>
    <circle cx="${cx}" cy="${cy}" r="4.5" fill="var(--chrome-lo)"/>
    <line x1="${cx - 3}" y1="${cy + 2}" x2="${cx + 3}" y2="${cy - 2}"
          stroke="rgba(255,255,255,0.35)" stroke-width="1"/>

    <!-- domed glass: crescent highlight + faint radial sheen -->
    <g clip-path="url(#${gid}-clip)" pointer-events="none">
      <ellipse cx="${cx - 26}" cy="${cy - 44}" rx="62" ry="30" fill="url(#${gid}-glass)"
               transform="rotate(-18 ${cx - 26} ${cy - 44})" class="glass-crescent"/>
      <circle cx="${cx}" cy="${cy}" r="${rFace}" fill="none" stroke="rgba(255,255,255,0.12)" stroke-width="3" opacity="0.5"/>
    </g>
  </svg>`;

  return {
    needle: $(`#${gid}-needle-g`, el),
    valText: $(`#${gid}-val`, el),
    curDeg: degForFrac(0),
    animToken: 0,
  };
}

/* ---- needle animation (eased, self-cancelling on new targets) ---- */
function easeInOutCubic(t) { return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; }

function animateNeedle(gauge, toDeg, dur = 850) {
  return new Promise((resolve) => {
    const from = gauge.curDeg;
    const delta = toDeg - from;
    const token = ++gauge.animToken; // a newer call cancels this one
    if (reduceMotion || dur <= 0 || Math.abs(delta) < 0.01) {
      gauge.curDeg = toDeg;
      gauge.needle.setAttribute('transform', `rotate(${toDeg.toFixed(2)} ${G.cx} ${G.cy})`);
      return resolve();
    }
    const t0 = performance.now();
    (function step(now) {
      if (token !== gauge.animToken) return resolve(); // superseded
      const t = Math.min(1, (now - t0) / dur);
      const deg = from + delta * easeInOutCubic(t);
      gauge.curDeg = deg; // track the live position so a new target starts from here
      gauge.needle.setAttribute('transform', `rotate(${deg.toFixed(2)} ${G.cx} ${G.cy})`);
      if (t < 1) requestAnimationFrame(step);
      else { gauge.curDeg = toDeg; resolve(); }
    })(t0);
  });
}

/* point a gauge at a 0..1 fraction, skipping micro-moves */
function pointGauge(gauge, frac, dur) {
  const toDeg = degForFrac(frac);
  if (Math.abs(toDeg - gauge.curDeg) < 0.4) return;
  animateNeedle(gauge, toDeg, dur);
}

/* ---- gauge instances ---- */
const SPEND_MAX = 5;    // dollars, full-scale
const TACH_MAX = 200;   // tokens/sec, full-scale
const RPM_MAX = 8;      // ×1000 giri, full-scale

const gaugeTach = buildGauge($('#gauge-tach'), {
  id: 'gt', majors: 20, minorGroup: 2, labelEvery: 4, numSize: 14,
  redFrom: 0.75, faceLabel: 'tachimetro', maker: 'VELOCE · CLAUDE',
  valY: G.cy + 72, valSize: 10.5, initialText: '0 tok/s',
  numFor: (f) => Math.round(f * TACH_MAX),
});
const gaugeRpm = buildGauge($('#gauge-rpm'), {
  id: 'gr', majors: 16, minorGroup: 2, labelEvery: 2, numSize: 15,
  redFrom: 7 / 8, faceLabel: 'contagiri', maker: 'VELOCE · CLAUDE',
  faceCaption: 'regime di generazione', faceCaptionY: G.cy + 26,
  unit: 'GIRI × 1000', unitY: G.cy + 52, valY: G.cy + 72, valSize: 13,
  initialText: '0.0', numFor: (f) => Math.round(f * RPM_MAX),
});
const gaugeFuel = buildGauge($('#gauge-fuel'), {
  id: 'gf', majors: 8, minorGroup: 4, labelEvery: 4, numSize: 20,
  redFrom: 0, redTo: 0.15, faceLabel: 'benzina', faceLabelY: G.cy - 32, faceLabelSize: 15,
  valY: G.cy + 40, valSize: 20, initialText: '100%',
  numFor: (f) => (f === 0 ? 'E' : f === 1 ? 'F' : '½'),
});
/* TOKEN counter: same enamel face for visual coherence, but it's a counter,
   not a dial — the needle is hidden and the roller odometer (moved here from
   the tach) shows total tokens; session $ lives on the line beneath. */
const gaugeSpend = buildGauge($('#gauge-spend'), {
  id: 'gs', majors: 10, minorGroup: 2, labelEvery: 0, numSize: 17,
  faceLabel: 'token', faceLabelY: G.cy - 32, faceLabelSize: 15,
  valY: G.cy + 46, valSize: 11, initialText: 'in + out',
  numFor: () => '',
});
if (gaugeSpend.needle) gaugeSpend.needle.setAttribute('display', 'none');

/* =====================================================================
   1b. ROLLER ODOMETER (km percorsi = tokensIn + tokensOut)
   Little flip-digit wheels: each wheel is a strip 0..9 (+ a duplicate 0
   so 9→0 rolls forward) shifted by translateY in em units.
   ===================================================================== */
const ODO_DIGITS = 7;
const odoWheels = []; // [{el, strip, d}]

function buildOdometer() {
  const holder = $('#odo-wheels');
  if (!holder) return;
  holder.innerHTML = '';
  for (let i = 0; i < ODO_DIGITS; i++) {
    const wheel = document.createElement('span');
    wheel.className = 'odo-wheel';
    const strip = document.createElement('span');
    strip.className = 'odo-strip';
    for (let d = 0; d <= 10; d++) { // 0..9 then a duplicate 0 for roll-over
      const digit = document.createElement('span');
      digit.textContent = String(d % 10);
      strip.appendChild(digit);
    }
    wheel.appendChild(strip);
    holder.appendChild(wheel);
    odoWheels.push({ el: wheel, strip, d: 0 });
  }
}

function setWheel(w, d) {
  if (w.d === d) return;
  const from = w.d;
  w.d = d;
  if (reduceMotion) { w.strip.style.transform = `translateY(${-d}em)`; return; }
  if (from === 9 && d === 0) {
    // roll forward onto the duplicate 0, then snap back without animating
    w.strip.style.transform = 'translateY(-10em)';
    const snap = () => {
      w.strip.removeEventListener('transitionend', snap);
      w.strip.style.transition = 'none';
      w.strip.style.transform = 'translateY(0em)';
      void w.strip.offsetHeight; // reflow so the next change animates again
      w.strip.style.transition = '';
    };
    w.strip.addEventListener('transitionend', snap);
  } else {
    w.strip.style.transform = `translateY(${-d}em)`;
  }
}

function setOdometer(total) {
  if (!odoWheels.length) return;
  let n = Math.round(Number(total));
  if (!isFinite(n) || n < 0) n = 0;
  const max = Math.pow(10, ODO_DIGITS) - 1;
  if (n > max) n = max; // pegged, like a very well-travelled car
  const s = String(n).padStart(ODO_DIGITS, '0');
  for (let i = 0; i < ODO_DIGITS; i++) setWheel(odoWheels[i], s.charCodeAt(i) - 48);
}

/* =====================================================================
   2. TELEMETRY  —  tok/s from successive states
   tokPerSec = delta(tokensIn+tokensOut) / delta(updatedAt)
   fast EMA (~3 samples) drives the TACHIMETRO; slow EMA (~20 s) drives
   the CONTAGIRI. Idle >10 s pins the speedo back to zero.
   ===================================================================== */
const IDLE_MS = 10000;       // speedo reads 0 after this much silence
const RATE_CLAMP = 400;      // tok/s outlier ceiling before smoothing
const FAST_TAU = 2.2;        // s — ≈ EMA over ~3 statusline samples
const SLOW_TAU = 20;         // s — sustained-intensity window

const TELEM = {
  total: 0,        // tokensIn + tokensOut (odometer)
  lastTok: null,   // previous sample's total
  lastT: null,     // previous sample's updatedAt (ms)
  fast: 0,         // EMA tok/s, short window
  slow: 0,         // EMA tok/s, long window
  lastDeltaAt: 0,  // wall time of the last sample where tokens grew
  lastIngestAt: 0, // wall time of the last sample at all
};

function normTs(ts) {
  ts = Number(ts);
  if (!isFinite(ts) || ts <= 0) return 0;
  return ts < 1e12 ? ts * 1000 : ts; // tolerate seconds-precision writers
}

function ingestSample(state) {
  const tokIn = Number(state.tokensIn), tokOut = Number(state.tokensOut);
  const total = (isFinite(tokIn) && tokIn > 0 ? tokIn : 0) + (isFinite(tokOut) && tokOut > 0 ? tokOut : 0);
  const t = normTs(state.updatedAt) || Date.now();
  TELEM.lastIngestAt = Date.now();

  if (TELEM.lastT != null && t > TELEM.lastT) {
    const dt = Math.max(0.25, (t - TELEM.lastT) / 1000); // clamp tiny dt
    let d = total - TELEM.lastTok;
    if (d < 0) d = 0; // session reset / new chat: no negative speed
    let rate = d / dt;
    if (rate > RATE_CLAMP * 3) {
      // discontinuity (boot mid-session / session switch): re-sync the
      // baseline silently instead of registering an impossible burst
      rate = null;
    } else if (rate > RATE_CLAMP) {
      rate = RATE_CLAMP; // clamp genuine outlier bursts
    }
    if (rate != null) {
      const aFast = 1 - Math.exp(-dt / FAST_TAU);
      const aSlow = 1 - Math.exp(-dt / SLOW_TAU);
      TELEM.fast += aFast * (rate - TELEM.fast);
      TELEM.slow += aSlow * (rate - TELEM.slow);
      if (d > 0) TELEM.lastDeltaAt = Date.now();
    }
  }
  TELEM.lastTok = total;
  TELEM.lastT = t;
  TELEM.total = total;
}

/* 1 Hz ticker: eases both needles down between/after statusline writes */
function tickTelemetry() {
  const now = Date.now();
  const sinceDelta = TELEM.lastDeltaAt ? now - TELEM.lastDeltaAt : Infinity;
  const sinceSample = TELEM.lastIngestAt ? now - TELEM.lastIngestAt : Infinity;
  if (sinceSample > 2000) {
    // no fresh samples: decay toward zero on the same time constants
    if (sinceDelta > IDLE_MS) TELEM.fast = 0;
    else TELEM.fast *= Math.exp(-1 / FAST_TAU);
    TELEM.slow *= Math.exp(-1 / SLOW_TAU);
    if (TELEM.fast < 0.05) TELEM.fast = 0;
    if (TELEM.slow < 0.05) TELEM.slow = 0;
  }
  renderTelemetry();
}

function fmtRate(r) {
  if (!isFinite(r) || r <= 0) return '0';
  return r < 10 ? r.toFixed(1) : String(Math.round(r));
}

function renderTelemetry() {
  const fast = (TELEM.lastDeltaAt && (Date.now() - TELEM.lastDeltaAt) > IDLE_MS) ? 0 : TELEM.fast;
  pointGauge(gaugeTach, fast / TACH_MAX);
  if (gaugeTach.valText) gaugeTach.valText.textContent = fmtRate(fast) + ' tok/s';

  const rpm = clampNum(TELEM.slow / TACH_MAX * RPM_MAX, 0, RPM_MAX);
  pointGauge(gaugeRpm, rpm / RPM_MAX);
  if (gaugeRpm.valText) gaugeRpm.valText.textContent = rpm.toFixed(1);

  setOdometer(TELEM.total);
}

/* =====================================================================
   2b. LIVE STATE  ->  GAUGES / BADGE / TRIP / ROUTE / ACTIVITY / GEAR
   ===================================================================== */
function applyState(state) {
  state = state || {};

  // telemetry sample (tok/s, odometer)
  ingestSample(state);
  renderTelemetry();

  // BENZINA: F = empty context; the needle falls toward E as pct rises
  const pct = clampNum(state.contextPct, 0, 100);
  const free = 100 - pct;
  pointGauge(gaugeFuel, free / 100);
  if (gaugeFuel.valText) gaugeFuel.valText.textContent = `${Math.round(free)}%`;
  setRiserva(free);

  // TOKEN counter face is driven by the roller odometer (see updateOdometer);
  // session $ goes on the small line beneath the counter.
  const cost = Math.max(0, Number(state.costUsd) || 0);
  const spendLine = $('#spend-line .riserva-text');
  if (spendLine) spendLine.textContent = '≈ $' + cost.toFixed(cost >= 100 ? 0 : 2);

  // model crest
  const nameEl = $('#model-name'), subEl = $('#model-sub');
  if (state.modelName) { nameEl.textContent = state.modelName; subEl.textContent = shortId(state.modelId); }
  else { nameEl.textContent = '—'; subEl.textContent = 'no signal'; }

  // trip counter: lines of code
  const added = Math.max(0, Math.round(Number(state.linesAdded) || 0));
  const removed = Math.max(0, Math.round(Number(state.linesRemoved) || 0));
  const addEl = $('#trip-add'), delEl = $('#trip-del');
  if (addEl) addEl.textContent = '+' + fmtCount(added);
  if (delEl) delEl.textContent = '−' + fmtCount(removed);

  // route plate + activity strip
  applyRoute(state);
  applyActivity(state.activity);

  // engaged gear
  setEngaged(state.activeGear);
}

/* ---- RISERVA jewel: amber <20% context left, red <10%, off otherwise ---- */
function setRiserva(freePct) {
  const el = $('#riserva');
  if (!el) return;
  el.classList.remove('amber', 'red');
  if (!isFinite(freePct)) return;
  if (freePct < 10) el.classList.add('red');
  else if (freePct < 20) el.classList.add('amber');
}

/* ---- targhetta di rotta: cwd / session / injection target ---- */
function applyRoute(state) {
  const cwdEl = $('#route-cwd'), sesEl = $('#route-session'), tgtEl = $('#route-target');
  if (!cwdEl) return;

  const cwd = typeof state.cwd === 'string' ? state.cwd : '';
  if (cwd) {
    const seg = cwd.replace(/\/+$/, '').split('/').filter(Boolean).pop() || cwd;
    cwdEl.textContent = seg;
    cwdEl.title = cwd;
  } else {
    cwdEl.textContent = '—';
    cwdEl.title = '';
  }

  const sid = state.sessionId ? String(state.sessionId) : '';
  sesEl.textContent = sid ? sid.slice(0, 8) : '—';
  sesEl.title = sid ? `Session ${sid}` : 'Session id';

  const target = state.targetApp ? String(state.targetApp) : '';
  tgtEl.textContent = target || '—';
  tgtEl.title = target
    ? `Keystrokes are sent to ${target}`
    : 'Keystrokes are sent to this terminal';
}

/* ---- la strada: latest tool activity ---- */
const ACTIVITY_STALE_MS = 120000;
let activityKey = null;

function glyphForTool(tool) {
  const t = String(tool || '').toLowerCase();
  if (/^(edit|write|multiedit|notebookedit)/.test(t)) return '✎';  // ✎
  if (/^(read|grep|glob|ls|search|websearch|webfetch)/.test(t)) return '⌕'; // ⌕
  if (/^bash/.test(t)) return '⚙';                                 // ⚙
  if (/^(task|agent)/.test(t)) return '✈';                         // ✈
  return '◍';                                                      // ◍
}

function applyActivity(activity) {
  const strip = $('#activity-strip');
  if (!strip) return;
  const glyphEl = $('#activity-glyph'), detailEl = $('#activity-detail'), flagEl = $('#activity-flag');

  const at = activity ? normTs(activity.at) : 0;
  const fresh = activity && typeof activity === 'object' &&
                at > 0 && (Date.now() - at) <= ACTIVITY_STALE_MS;

  if (!fresh) {
    strip.classList.remove('fresh');
    glyphEl.textContent = '◍';
    detailEl.textContent = '—';
    detailEl.title = '';
    flagEl.textContent = 'in sosta';
    activityKey = null;
    return;
  }

  const tool = String(activity.tool || '');
  const detail = String(activity.detail || '');
  const key = tool + '\u0000' + detail + '\u0000' + at;
  strip.classList.add('fresh');
  glyphEl.textContent = glyphForTool(tool);
  detailEl.textContent = detail || tool || '—';
  detailEl.title = (tool && detail) ? `${tool} — ${detail}` : (tool || detail);
  flagEl.textContent = 'in viaggio…';

  if (key !== activityKey) {
    activityKey = key;
    if (!reduceMotion) {
      // slide the new event in, like the road moving under the wheels
      detailEl.classList.remove('roll');
      glyphEl.classList.remove('roll');
      void detailEl.offsetWidth;
      detailEl.classList.add('roll');
      glyphEl.classList.add('roll');
    }
  }
}

function setEngaged(activeGear) {
  const num = Number(activeGear);
  const has = isFinite(num) && num > 0;
  const target = has ? num : null;
  if (target === engagedGear) return; // no change -> avoid re-throwing the knob
  engagedGear = target;

  document.querySelectorAll('.gearpos').forEach((b) => {
    const on = has && Number(b.dataset.gear) === num;
    b.classList.toggle('engaged', on);
  });

  const slot = has ? slotByGear(num) : { x: 220, y: 105 }; // neutral = gate centre
  throwKnob(slot.x, slot.y);
  const label = has ? gearLabelByNum(num) : 'N';
  $('#gear-readout').textContent = label;
}

/* ---- small formatters/guards ---- */
function clampNum(v, lo, hi) { v = Number(v); if (!isFinite(v)) return lo; return Math.min(hi, Math.max(lo, v)); }
function shortId(id) { if (!id) return ''; const s = String(id); return s.length > 22 ? s.slice(0, 20) + '…' : s; }
function fmtCount(n) {
  if (!isFinite(n) || n < 0) return '0';
  if (n >= 100000) return Math.round(n / 1000) + 'k';
  return String(Math.round(n));
}

/* =====================================================================
   3. GEAR SELECTOR (H-GATE)
   ===================================================================== */
const gearSlots = new Map();       // gear.gear number -> {x,y}
const gearLabels = new Map();      // gear.gear number -> readout label
let knobPos = { x: 220, y: 105 };  // viewBox coords
const knobEl = $('#shiftknob');

const VB = { w: 440, h: 210, gateY: 105, upY: 45, downY: 165, col0: 55, colStep: 110 };
const pctX = (x) => (x / VB.w * 100) + '%';
const pctY = (y) => (y / VB.h * 100) + '%';

function slotByGear(num) { return gearSlots.get(num) || { x: 220, y: 105 }; }
function gearLabelByNum(num) { return gearLabels.get(num) || String(num); }

function buildGearbox(gears) {
  const plate = $('#gearplate');
  const gate = $('#gate-svg');
  gearSlots.clear(); gearLabels.clear();

  // remove old positions (keep the knob + gate)
  plate.querySelectorAll('.gearpos').forEach((n) => n.remove());

  const total = gears.length;
  const revIdx = total - 1; // last gear sits in the "reverse" (down) slot

  const positions = gears.map((g, i) => {
    let col = Math.floor(i / 2);
    let down = (i % 2 === 1);
    if (i === revIdx) { down = true; col = Math.floor(revIdx / 2); }
    return { x: VB.col0 + col * VB.colStep, y: down ? VB.downY : VB.upY, col };
  });

  // ---- engrave the gate channels ----
  const cols = [...new Set(positions.map((p) => p.col))].sort((a, b) => a - b);
  const minX = VB.col0, maxX = VB.col0 + Math.max(...positions.map((p) => p.col)) * VB.colStep;
  let channels = `<path d="M ${minX} ${VB.gateY} H ${maxX}" class="__gate"/>`;
  cols.forEach((c) => {
    const x = VB.col0 + c * VB.colStep;
    const hasUp = positions.some((p) => p.col === c && p.y === VB.upY);
    const hasDn = positions.some((p) => p.col === c && p.y === VB.downY);
    if (hasUp) channels += `<path d="M ${x} ${VB.gateY} V ${VB.upY}" class="__gate"/>`;
    if (hasDn) channels += `<path d="M ${x} ${VB.gateY} V ${VB.downY}" class="__gate"/>`;
  });
  // dark recessed stroke + lighter groove interior (engraved look)
  gate.innerHTML = `
    <g fill="none" stroke-linecap="round">
      <g stroke="rgba(0,0,0,0.55)" stroke-width="15">${channels}</g>
      <g stroke="rgba(0,0,0,0.35)" stroke-width="9">${channels}</g>
      <g stroke="rgba(255,255,255,0.35)" stroke-width="1.5">${channels}</g>
    </g>`;
  // the class attribute in the template strings above is inert; strip it to avoid confusion
  gate.querySelectorAll('.__gate').forEach((p) => p.removeAttribute('class'));

  // ---- clickable gear positions ----
  gears.forEach((g, i) => {
    const num = Number(g.gear != null ? g.gear : i + 1);
    const pos = positions[i];
    gearSlots.set(num, { x: pos.x, y: pos.y });
    gearLabels.set(num, String(num));

    const btn = document.createElement('button');
    btn.className = 'gearpos' + (i === revIdx ? ' reverse' : '');
    btn.dataset.gear = String(num);
    btn.style.left = pctX(pos.x);
    btn.style.top = pctY(pos.y);
    btn.setAttribute('aria-label', `Shift to gear ${num}: ${g.label || ''} ${g.sublabel || ''}`.trim());
    btn.innerHTML =
      `<span class="gp-num">${i === revIdx ? 'R' : num}</span>` +
      `<span class="gp-label">${escapeHtml(g.label || '')}</span>` +
      (g.sublabel ? `<span class="gp-sub">${escapeHtml(g.sublabel)}</span>` : '');
    btn.addEventListener('click', () => onShift(num, pos));
    plate.appendChild(btn);
  });

  // place knob at neutral initially
  setKnobImmediate(knobPos.x, knobPos.y);
}

function setKnobImmediate(x, y) {
  knobPos = { x, y };
  knobEl.style.left = pctX(x);
  knobEl.style.top = pctY(y);
}

function throwKnob(x, y) {
  if (knobPos.x === x && knobPos.y === y) return;
  const from = knobPos;
  if (reduceMotion) { setKnobImmediate(x, y); return; }
  const kf = [
    { left: pctX(from.x), top: pctY(from.y) },
    { left: pctX(from.x), top: pctY(VB.gateY) }, // pull down to the gate
    { left: pctX(x),      top: pctY(VB.gateY) }, // slide along the gate
    { left: pctX(x),      top: pctY(y) },        // push into the gear
  ];
  try {
    knobEl.animate(kf, { duration: 520, easing: 'cubic-bezier(.3,.7,.25,1)', fill: 'forwards' });
  } catch (_) { /* WAAPI unavailable */ }
  setKnobImmediate(x, y); // persist final resting style
}

async function onShift(num, pos) {
  throwKnob(pos.x, pos.y);
  $('#gear-readout').textContent = gearLabelByNum(num);
  document.querySelectorAll('.gearpos').forEach((b) =>
    b.classList.toggle('engaged', Number(b.dataset.gear) === num));
  try { await dash.shift(num); } catch (_) {}
}

/* =====================================================================
   4. OVERDRIVE + SKILL SWITCHES
   ===================================================================== */
function wireOverdrive(nos) {
  const btn = $('#overdrive');
  $('#od-label').textContent = (nos && nos.label) || 'OVERDRIVE';
  btn.setAttribute('aria-label', `Engage ${(nos && nos.label) || 'overdrive'}`);
  btn.addEventListener('click', async () => {
    btn.classList.add('pulled');
    setTimeout(() => btn.classList.remove('pulled'), 620);
    try { await dash.boost(); } catch (_) {}
  });
}

function buildSwitches(buttons) {
  const row = $('#switch-row');
  row.innerHTML = '';
  (buttons || []).forEach((b, index) => {
    const t = document.createElement('button');
    t.className = 'toggle';
    t.setAttribute('aria-label', `Activate ${b.label || 'switch ' + (index + 1)}`);
    t.innerHTML =
      `<span class="toggle-body"><span class="toggle-lever"></span></span>` +
      `<span class="toggle-plate">${escapeHtml(b.label || '')}</span>`;
    t.addEventListener('click', async () => {
      t.classList.add('on');
      setTimeout(() => t.classList.remove('on'), 600); // momentary, springs back
      try { await dash.runButton(index); } catch (_) {}
    });
    row.appendChild(t);
  });
}

/* =====================================================================
   4b. TERGICRISTALLI — rotary wiper knob (OFF · INT · FULL)
   Built from config.wipers. Modes with confirm:true are destructive and
   need a second click within ARM_MS (first click arms: red jewel blinks).
   After any action the knob springs back to OFF.
   ===================================================================== */
const WIPER_ARM_MS = 1500;   // confirm window for destructive modes
const WIPER_SPAN_DEG = 120;  // pointer travel from OFF to the last position

let wiperModes = [];
let wiperArmedIndex = null;  // mode index currently armed for confirm
let wiperArmTimer = 0;
let wiperResetTimer = 0;

function wiperAngleFor(posIndex, total) {
  const half = WIPER_SPAN_DEG / 2;
  return total <= 1 ? -half : -half + (posIndex / (total - 1)) * WIPER_SPAN_DEG;
}

function setWiperKnob(angleDeg) {
  const cap = $('#wiper-cap');
  if (cap) cap.style.setProperty('--wiper-angle', angleDeg.toFixed(1) + 'deg');
}

function wiperSelect(posIndex) {
  document.querySelectorAll('.wiper-pos').forEach((b) =>
    b.classList.toggle('selected', Number(b.dataset.pos) === posIndex));
}

function wiperDisarm() {
  clearTimeout(wiperArmTimer);
  wiperArmedIndex = null;
  const bay = document.querySelector('.wiper-bay');
  if (bay) bay.classList.remove('armed');
  document.querySelectorAll('.wiper-pos.armed').forEach((b) => b.classList.remove('armed'));
}

function wiperSpringToOff(delay) {
  clearTimeout(wiperResetTimer);
  wiperResetTimer = setTimeout(() => {
    const total = wiperModes.length + 1;
    setWiperKnob(wiperAngleFor(0, total));
    wiperSelect(0);
  }, delay);
}

function wiperSweepFx() {
  const el = $('#wiper-sweep');
  if (!el || reduceMotion) return;
  el.classList.remove('sweeping');
  void el.offsetWidth; // restart the animation
  el.classList.add('sweeping');
  setTimeout(() => el.classList.remove('sweeping'), 1250);
}

async function fireWiper(modeIndex) {
  wiperSweepFx();
  wiperSpringToOff(700);
  try {
    if (typeof dash.wipe === 'function') await dash.wipe(modeIndex);
  } catch (_) {}
}

function onWiperPos(posIndex) {
  const total = wiperModes.length + 1;
  clearTimeout(wiperResetTimer);
  setWiperKnob(wiperAngleFor(posIndex, total));
  wiperSelect(posIndex);

  if (posIndex === 0) { wiperDisarm(); return; } // back to OFF

  const modeIndex = posIndex - 1;
  const mode = wiperModes[modeIndex] || {};

  if (mode.confirm && wiperArmedIndex !== modeIndex) {
    // first click arms; a second within the window executes
    wiperDisarm();
    wiperArmedIndex = modeIndex;
    const bay = document.querySelector('.wiper-bay');
    if (bay) bay.classList.add('armed');
    const btn = document.querySelector(`.wiper-pos[data-pos="${posIndex}"]`);
    if (btn) btn.classList.add('armed');
    wiperArmTimer = setTimeout(() => { wiperDisarm(); wiperSpringToOff(0); }, WIPER_ARM_MS);
    return;
  }

  wiperDisarm();
  fireWiper(modeIndex);
}

function buildWipers(wipers) {
  const control = $('#wiper-control');
  if (!control) return;
  control.querySelectorAll('.wiper-pos').forEach((n) => n.remove());
  wiperDisarm();
  clearTimeout(wiperResetTimer);

  wiperModes = (wipers && Array.isArray(wipers.modes)) ? wipers.modes : [];
  const plate = $('#wiper-plate');
  if (plate) plate.textContent = (wipers && wipers.label) || 'TERGI';

  // positions: OFF + one per configured mode, fanned around the knob
  const names = ['OFF', ...wiperModes.map((m, i) => String(m.label || 'MODE ' + (i + 1)))];
  const total = names.length;
  const KNOB_CY = 68;             // knob centre y within the 104px control box
  const RX = 54, RY = 50;         // label orbit radii

  names.forEach((name, posIndex) => {
    const a = wiperAngleFor(posIndex, total) * Math.PI / 180;
    const btn = document.createElement('button');
    btn.className = 'wiper-pos';
    btn.dataset.pos = String(posIndex);
    btn.textContent = name;
    btn.style.left = `calc(50% + ${(Math.sin(a) * RX).toFixed(1)}px)`;
    btn.style.top = `${(KNOB_CY - Math.cos(a) * RY).toFixed(1)}px`;
    const mode = posIndex > 0 ? wiperModes[posIndex - 1] : null;
    btn.setAttribute('aria-label',
      posIndex === 0 ? 'Wipers off'
        : `Wiper ${name}${mode && mode.confirm ? ' (destructive: click twice to confirm)' : ''}`);
    btn.addEventListener('click', () => onWiperPos(posIndex));
    control.appendChild(btn);
  });

  setWiperKnob(wiperAngleFor(0, total));
  wiperSelect(0);
}

/* =====================================================================
   5. TITLE BAR CONTROLS + THEME
   ===================================================================== */
function currentTheme() {
  const t = document.documentElement.getAttribute('data-theme');
  if (t) return t;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'night' : 'day';
}
function wireTitlebar() {
  $('#btn-min').addEventListener('click', () => { try { dash.minimize(); } catch (_) {} });
  $('#btn-close').addEventListener('click', () => { try { dash.toggleClose(); } catch (_) {} });

  $('#btn-night').addEventListener('click', () => {
    const next = currentTheme() === 'night' ? 'day' : 'night';
    document.documentElement.setAttribute('data-theme', next);
  });

  const pin = $('#btn-pin');
  pin.addEventListener('click', async () => {
    let on = false;
    try { on = await dash.toggleAlwaysOnTop(); } catch (_) {}
    pin.setAttribute('aria-pressed', on ? 'true' : 'false');
  });

  $('#btn-config').addEventListener('click', openConfig);
}

/* =====================================================================
   6. CONFIG SLIDE-OVER
   ===================================================================== */
function openConfig() {
  populateConfigForm();
  $('#config-panel').classList.add('open');
  $('#config-panel').setAttribute('aria-hidden', 'false');
  $('#config-scrim').classList.add('open');
}
function closeConfig() {
  $('#config-panel').classList.remove('open');
  $('#config-panel').setAttribute('aria-hidden', 'true');
  $('#config-scrim').classList.remove('open');
}

async function populateConfigForm() {
  if (!CONFIG) return;
  // terminal dropdown
  const sel = $('#cfg-terminal');
  sel.innerHTML = '';
  let running = [];
  try { running = await dash.listTerminals(); } catch (_) {}
  const opts = new Set(['auto', ...(CONFIG.knownTerminals || []), ...(running || [])]);
  if (CONFIG.targetTerminal) opts.add(CONFIG.targetTerminal);
  [...opts].forEach((name) => {
    const o = document.createElement('option');
    o.value = name;
    o.textContent = name === 'auto' ? 'Auto-detect' :
      (running.includes(name) ? `${name}  ·  running` : name);
    if (name === (CONFIG.targetTerminal || 'auto')) o.selected = true;
    sel.appendChild(o);
  });

  // gears
  const gc = $('#cfg-gears'); gc.innerHTML = '';
  (CONFIG.gears || []).forEach((g, i) => {
    const row = document.createElement('div');
    row.className = 'cfg-row';
    row.innerHTML =
      `<span class="cfg-tag">${g.gear != null ? g.gear : i + 1}</span>` +
      `<input data-k="label" data-i="${i}" value="${escapeAttr(g.label || '')}" placeholder="label" aria-label="Gear ${i + 1} label"/>` +
      `<input data-k="modelArg" data-i="${i}" value="${escapeAttr(g.modelArg || '')}" placeholder="model arg" aria-label="Gear ${i + 1} model argument"/>`;
    gc.appendChild(row);
  });

  // skill switches
  const sc = $('#cfg-switches'); sc.innerHTML = '';
  (CONFIG.skillButtons || []).forEach((b, i) => {
    const row = document.createElement('div');
    row.className = 'cfg-row';
    row.innerHTML =
      `<span class="cfg-tag">${i + 1}</span>` +
      `<input data-sk="label" data-i="${i}" value="${escapeAttr(b.label || '')}" placeholder="label" aria-label="Switch ${i + 1} label"/>` +
      `<input data-sk="keystrokes" data-i="${i}" value="${escapeAttr(b.keystrokes || b.chord || '')}" placeholder="keystrokes / chord" aria-label="Switch ${i + 1} keystrokes"/>`;
    sc.appendChild(row);
  });
}

async function saveConfigForm() {
  if (!CONFIG) return;
  const next = JSON.parse(JSON.stringify(CONFIG)); // clone, preserve unknown keys

  next.targetTerminal = $('#cfg-terminal').value || 'auto';

  $('#cfg-gears').querySelectorAll('input').forEach((inp) => {
    const i = Number(inp.dataset.i);
    if (!next.gears[i]) return;
    next.gears[i][inp.dataset.k] = inp.value;
  });
  $('#cfg-switches').querySelectorAll('input').forEach((inp) => {
    const i = Number(inp.dataset.i);
    if (!next.skillButtons[i]) return;
    const k = inp.dataset.sk;
    // chord-type switches keep editing 'chord'; text-type edit 'keystrokes'
    if (k === 'keystrokes' && next.skillButtons[i].type === 'chord') next.skillButtons[i].chord = inp.value;
    else next.skillButtons[i][k] = inp.value;
  });

  const status = $('#config-status');
  try {
    await dash.saveConfig(next);
    try { await dash.setTerminal(next.targetTerminal); } catch (_) {}
    CONFIG = next;
    rebuildFromConfig();
    status.textContent = 'Stored.';
  } catch (e) {
    status.textContent = 'Save failed.';
  }
  status.classList.add('show');
  setTimeout(() => status.classList.remove('show'), 2000);
}

/* =====================================================================
   7. HELPERS
   ===================================================================== */
function escapeHtml(s) {
  return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}
function escapeAttr(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function rebuildFromConfig() {
  if (!CONFIG) return;
  buildGearbox(CONFIG.gears || []);
  buildSwitches(CONFIG.skillButtons || []);
  buildWipers(CONFIG.wipers);
  $('#od-label').textContent = (CONFIG.nos && CONFIG.nos.label) || 'OVERDRIVE';
  // re-apply engaged highlight after rebuild
  const eg = engagedGear; engagedGear = null; setEngaged(eg);
}

/* =====================================================================
   8. BOOT
   ===================================================================== */
async function boot() {
  wireTitlebar();
  buildOdometer();
  $('#config-close').addEventListener('click', closeConfig);
  $('#config-scrim').addEventListener('click', closeConfig);
  $('#config-save').addEventListener('click', saveConfigForm);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeConfig(); });

  // fallback config so the UI is never empty even before the bridge answers
  try { CONFIG = await dash.getConfig(); } catch (_) {}
  if (!CONFIG) CONFIG = FALLBACK_CONFIG;

  buildGearbox(CONFIG.gears || []);
  buildSwitches(CONFIG.skillButtons || []);
  buildWipers(CONFIG.wipers);
  wireOverdrive(CONFIG.nos);

  // ignition self-test: sweep every needle to full, then settle to real values
  await selfTest();

  let initial = null;
  try { initial = await dash.getState(); } catch (_) {}
  applyState(initial);

  // subscribe to live updates
  try { dash.onState((s) => applyState(s)); } catch (_) {}

  // 1 Hz telemetry ticker: decays tok/s + giri between statusline writes
  setInterval(tickTelemetry, 1000);
}

const ALL_GAUGES = [gaugeTach, gaugeRpm, gaugeFuel, gaugeSpend];
async function selfTest() {
  await Promise.all(ALL_GAUGES.map((g) => animateNeedle(g, degForFrac(1), 650)));
  await Promise.all(ALL_GAUGES.map((g) => animateNeedle(g, degForFrac(0), 700)));
}

/* Minimal fallback mirrors config.default.json shape; only used if the
   bridge/config is unavailable so the dashboard still renders. */
const FALLBACK_CONFIG = {
  targetTerminal: 'auto',
  knownTerminals: ['iTerm2', 'Terminal', 'Ghostty', 'WezTerm', 'kitty', 'Alacritty', 'Warp', 'Hyper', 'Code', 'Cursor'],
  gears: [
    { gear: 1, label: 'Haiku', sublabel: '4.5', modelArg: 'haiku' },
    { gear: 2, label: 'Sonnet', sublabel: '', modelArg: 'sonnet' },
    { gear: 3, label: 'Sonnet 5', sublabel: '', modelArg: 'claude-sonnet-5' },
    { gear: 4, label: 'Opus', sublabel: '', modelArg: 'opus' },
    { gear: 5, label: 'Opus 4.8', sublabel: '', modelArg: 'claude-opus-4-8' },
    { gear: 6, label: 'Opus 4.8', sublabel: '1M ctx', modelArg: 'opus[1m]' },
    { gear: 7, label: 'Fable 5', sublabel: 'reverse', modelArg: 'claude-fable-5' },
  ],
  nos: { label: 'OVERDRIVE', keystrokes: 'ultracode ', enter: false },
  wipers: {
    label: 'TERGI',
    modes: [
      { label: 'INT', keystrokes: '/compact', enter: true, confirm: false },
      { label: 'FULL', keystrokes: '/clear', enter: true, confirm: true },
    ],
  },
  skillButtons: [
    { label: 'DOCTOR', type: 'text', keystrokes: '/doctor', enter: true },
    { label: 'MCP', type: 'text', keystrokes: '/mcp', enter: true },
    { label: 'HELP', type: 'text', keystrokes: '/help', enter: true },
  ],
};

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();

})();
