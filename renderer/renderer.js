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


/* =====================================================================
   0b. I18N — plate/label translations (IT default). The enamel gauge
   face engravings stay Italian on purpose: a vintage Italian instrument
   exported abroad still says "benzina" on the dial. Only the chrome
   plates and dynamic status strings translate.
   ===================================================================== */
/* One label per instrument: the italic enamel-face engravings (tach_face,
   fuel_face, rpm_face…) ARE the labels; the caption plates under the gauges
   were removed in the design-polish pass. token_sub is the TOKEN counter's
   single label — instrument name + unit in one breath, inside the housing. */
const I18N = {
  it: { riserva: 'RISERVA', motore: 'MOTORE', rotta: 'ROTTA',
        strada: 'la strada', cambio: 'CAMBIO', trasmissione: 'trasmissione', servizi: 'SERVIZI',
        quadro: 'quadro strumenti', viaggio: 'in viaggio…', sosta: 'in sosta', no_signal: 'nessun segnale', wipers: 'OTTIMIZZA CONTESTO',
        tach_face: 'velocità di generazione', fuel_face: 'contesto', token_sub: 'token · in + out',
        rpm_face: 'ragionamento', rpm_fcap: 'carico di generazione', rpm_unit: 'CARICO × 1000',
        safety_head: 'Sicurezze', safety_clear: 'Sicura su “clear” (FULL ottimizzazione contesto)',
        safety_clear_hint: 'Se attiva, il tergicristallo FULL azzera il contesto solo al doppio clic.' },
  en: { riserva: 'RESERVE', motore: 'ENGINE', rotta: 'ROUTE',
        strada: 'the road', cambio: 'GEARBOX', trasmissione: 'transmission', servizi: 'SERVICES',
        quadro: 'instrument panel', viaggio: 'en route…', sosta: 'idle', no_signal: 'no signal', wipers: 'OPTIMIZE CONTEXT',
        tach_face: 'generation speed', fuel_face: 'context', token_sub: 'tokens · in + out',
        rpm_face: 'reasoning', rpm_fcap: 'sustained gen. load', rpm_unit: 'LOAD × 1000',
        safety_head: 'Safety', safety_clear: 'Confirm on “clear” (FULL context optimize)',
        safety_clear_hint: 'When on, the FULL wiper only wipes the context on a double click.' },
  pt: { riserva: 'RESERVA', motore: 'MOTOR', rotta: 'ROTA',
        strada: 'a estrada', cambio: 'CÂMBIO', trasmissione: 'transmissão', servizi: 'SERVIÇOS',
        quadro: 'painel de instrumentos', viaggio: 'a caminho…', sosta: 'parado', no_signal: 'sem sinal', wipers: 'OTIMIZAR CONTEXTO',
        tach_face: 'velocidade de geração', fuel_face: 'contexto', token_sub: 'tokens · in + out',
        rpm_face: 'raciocínio', rpm_fcap: 'carga de geração', rpm_unit: 'CARGA × 1000',
        safety_head: 'Seguranças', safety_clear: 'Confirmar no “clear” (FULL otimizar contexto)',
        safety_clear_hint: 'Quando ativo, o limpador FULL só zera o contexto com duplo clique.' },
  es: { riserva: 'RESERVA', motore: 'MOTOR', rotta: 'RUTA',
        strada: 'la carretera', cambio: 'CAMBIO', trasmissione: 'transmisión', servizi: 'SERVICIOS',
        quadro: 'cuadro de instrumentos', viaggio: 'en marcha…', sosta: 'en reposo', no_signal: 'sin señal', wipers: 'OPTIMIZAR CONTEXTO',
        tach_face: 'velocidad de generación', fuel_face: 'contexto', token_sub: 'tokens · in + out',
        rpm_face: 'razonamiento', rpm_fcap: 'carga de generación', rpm_unit: 'CARGA × 1000',
        safety_head: 'Seguridades', safety_clear: 'Confirmar en “clear” (FULL optimizar contexto)',
        safety_clear_hint: 'Si está activo, el limpiador FULL borra el contexto solo con doble clic.' },
};
let LANG = 'it';
function t(key) { return (I18N[LANG] && I18N[LANG][key]) || I18N.it[key] || key; }
function applyI18n(lang) {
  LANG = I18N[lang] ? lang : 'it';
  document.querySelectorAll('[data-i18n]').forEach((el) => {
    el.textContent = t(el.dataset.i18n);
  });
  // enamel-face engravings (SVG text nodes created by buildGauge)
  const FACE_MAP = { 'gt-flabel': 'tach_face', 'gf-flabel': 'fuel_face',
                     'gr-flabel': 'rpm_face', 'gr-fcap': 'rpm_fcap', 'gr-funit': 'rpm_unit' };
  Object.keys(FACE_MAP).forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.textContent = t(FACE_MAP[id]);
  });
  const langSel = $('#cfg-language');
  if (langSel) langSel.value = LANG;
}

/* ---- safe bridge: never throw if window.dash is absent ---- */
const noop = () => {};
const dash = window.dash || {
  getConfig: async () => null,
  saveConfig: async () => {},
  getState: async () => null,
  onState: noop,
  shift: async () => ({ ok: false, method: 'none', error: 'no bridge' }),
  boost: async () => ({ ok: false, error: 'no bridge' }),
  stop: async () => ({ ok: false, error: 'no bridge' }),
  runButton: async () => ({ ok: false, error: 'no bridge' }),
  wipe: async () => ({ ok: false, error: 'no bridge' }),
  listTerminals: async () => [],
  setTerminal: async () => {},
  // available:true so browser dev mode stays interactive — each action's
  // {ok:false,'no bridge'} result then exercises the CHECK-ENGINE telltale.
  probeInjection: async () => ({ available: true }),
  minimize: noop,
  toggleClose: noop,
  toggleAlwaysOnTop: async () => false,
  onUpdateAvailable: noop,
  checkUpdate: async () => ({ available: false }),
  applyUpdate: async () => ({ ok: false, error: 'no bridge' }),
};

const $ = (sel, root = document) => root.querySelector(sel);
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

let CONFIG = null;      // current config
let engagedGear = null; // gear.gear number currently engaged
let liveModelName = ''; // last model name from state (shown in the neutral readout)

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

    <!-- redline arc (only when a redFrom is configured) -->
    ${cfg.redFrom != null ? `<path d="${redPath}" fill="none" stroke="var(--redline)" stroke-width="5" stroke-linecap="round"/>` : ''}

    <!-- engraved tick work + numerals -->
    <g>${ticks}</g>

    <!-- italic face label (Bodoni italic) -->
    ${cfg.faceLabel ? `<text id="${gid}-flabel" x="${cx}" y="${cfg.faceLabelY != null ? cfg.faceLabelY : cy - 34}" text-anchor="middle"
          font-family="var(--font-italic)" font-style="italic" font-size="${cfg.faceLabelSize || 13}"
          letter-spacing="0.6" fill="var(--ink)" opacity="0.85">${cfg.faceLabel}</text>` : ''}

    <!-- maker's mark -->
    ${cfg.maker ? `<text x="${cx}" y="${cy - 16}" text-anchor="middle"
          font-family="var(--font-display)" font-size="6.5" letter-spacing="1.6"
          fill="var(--ink-soft)" opacity="0.85">${cfg.maker}</text>` : ''}

    <!-- optional small italic caption (e.g. "regime di generazione") -->
    ${cfg.faceCaption ? `<text id="${gid}-fcap" x="${cx}" y="${cfg.faceCaptionY != null ? cfg.faceCaptionY : cy + 34}" text-anchor="middle"
          font-family="var(--font-italic)" font-style="italic" font-size="9"
          letter-spacing="0.3" fill="var(--ink)" opacity="0.8">${cfg.faceCaption}</text>` : ''}

    <!-- unit + live value, seated in the lower gap between numerals -->
    ${cfg.unit ? `<text id="${gid}-funit" x="${cx}" y="${cfg.unitY != null ? cfg.unitY : cy + 42}" text-anchor="middle" font-family="var(--font-serif)"
          font-size="10" letter-spacing="1.4" fill="var(--ink)" opacity="0.8">${cfg.unit}</text>` : ''}
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
/* ease-out-back, tuned subtle (c1=0.7 ≈ 1.8% overshoot): the needle swings a
   couple of degrees past a big target and settles, like a damped movement */
function easeOutBack(t) { const c1 = 0.7, u = t - 1; return 1 + (c1 + 1) * u * u * u + c1 * u * u; }
const NEEDLE_OVERSHOOT_MIN = 25;               // deg of throw before overshoot kicks in
const DEG_PIN_LO = G.START - 3;                // physical stop pins: the needle may
const DEG_PIN_HI = G.START + G.SWEEP + 3;      // kiss them, never swing through

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
    // big throws settle with a physical overshoot; small corrections stay
    // critically damped so the needle never jitters around idle
    const ease = Math.abs(delta) >= NEEDLE_OVERSHOOT_MIN ? easeOutBack : easeInOutCubic;
    const t0 = performance.now();
    (function step(now) {
      if (token !== gauge.animToken) return resolve(); // superseded
      const t = Math.min(1, (now - t0) / dur);
      let deg = from + delta * ease(t);
      if (deg < DEG_PIN_LO) deg = DEG_PIN_LO; else if (deg > DEG_PIN_HI) deg = DEG_PIN_HI;
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
  /* the face engraving is this instrument's only label now: larger, and
     seated a touch lower so it clears the ½ numeral (≈10px effective) */
  redFrom: 0, redTo: 0.15, faceLabel: 'benzina', faceLabelY: G.cy - 28, faceLabelSize: 18,
  valY: G.cy + 40, valSize: 20, initialText: '100%',
  numFor: (f) => (f === 0 ? 'E' : f === 1 ? 'F' : '½'),
});
/* TOKENS: a true rectangular roller counter (see .counter-housing in the
   HTML) — no dial, no needle. The odometer wheels are driven by
   updateOdometer from tokensIn+tokensOut. */

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

  // TOKENS roller counter is driven by updateOdometer (tokensIn+tokensOut);
  // the $ readout was retired — tokens ARE the mileage.

  // live model name — the MOTORE crest was retired (it duplicated the shifter);
  // the gear readout now carries the model, and falls back to it in neutral.
  liveModelName = state.modelName ? String(state.modelName) : '';

  // trip counter: lines of code
  const added = Math.max(0, Math.round(Number(state.linesAdded) || 0));
  const removed = Math.max(0, Math.round(Number(state.linesRemoved) || 0));
  const addEl = $('#trip-add'), delEl = $('#trip-del');
  if (addEl) addEl.textContent = '+' + fmtCount(added);
  if (delEl) delEl.textContent = '−' + fmtCount(removed);

  // route plate + activity strip + trip computer (opt-in OTel telemetry)
  applyRoute(state);
  applyActivity(state.activity);
  applyTrip(state.otel);

  // engaged gear
  setEngaged(state.activeGear);
  // keep the neutral readout's model name fresh even when the gear doesn't change
  if (engagedGear == null) renderNeutralReadout();
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

  if (DISPLAY_ONLY) return; // vetrina: the target slot carries the mode label
  const target = state.targetApp ? String(state.targetApp) : '';
  tgtEl.textContent = target || '—';
  tgtEl.title = target
    ? `Keystrokes are sent to ${target}`
    : 'Keystrokes are sent to this terminal';
}

/* ---- computer di viaggio: opt-in per-turn telemetry (state.otel) ---- */
const COMPACTION_FRESH_MS = 120000; // show the wiper's effect for 2 minutes

function fmtDurMs(ms) {
  ms = Number(ms);
  if (!isFinite(ms) || ms <= 0) return '—';
  return ms < 10000 ? (ms / 1000).toFixed(1) + 's' : Math.round(ms / 1000) + 's';
}

function fmtCost(usd) {
  usd = Number(usd);
  if (!isFinite(usd) || usd <= 0) return '—';
  return '$' + (usd < 0.1 ? usd.toFixed(3) : usd.toFixed(2));
}

function applyTrip(otel) {
  const bar = $('#tripbar');
  if (!bar) return;
  const turn = otel && otel.turn;
  const comp = otel && otel.compaction;
  if (!turn && !comp) { bar.hidden = true; return; }
  bar.hidden = false;

  $('#tc-time').textContent = turn ? fmtDurMs(turn.durationMs) : '—';
  $('#tc-cost').textContent = turn ? fmtCost(turn.costUsd) : '—';
  const effort = turn ? [turn.effort, turn.speed === 'fast' ? 'fast' : ''].filter(Boolean).join('·') : '';
  $('#tc-effort').textContent = effort || '—';
  $('#tc-cache').textContent = (turn && turn.cacheHitPct != null)
    ? 'cache ' + turn.cacheHitPct + '%' : 'cache —';

  const compEl = $('#tc-compact');
  if (compEl) {
    const fresh = comp && comp.success && (Date.now() - normTs(comp.at)) < COMPACTION_FRESH_MS;
    compEl.hidden = !fresh;
    if (fresh) compEl.textContent = 'tergi −' + fmtCount(comp.savedTokens);
  }
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
    flagEl.textContent = t('sosta');
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
  flagEl.textContent = t('viaggio');

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
  clearTimeout(stopSpringback); // a real gear change supersedes an R spring-back

  document.querySelectorAll('.gearpos').forEach((b) => {
    const on = has && Number(b.dataset.gear) === num;
    b.classList.toggle('engaged', on);
  });

  const slot = has ? slotByGear(num) : gateNeutral; // neutral = gate centre
  throwKnob(slot.x, slot.y);
  if (has) renderReadout(num);
  else renderNeutralReadout();
}

/* Neutral (no gear matches the live model): show N, plus the raw model name if
   we have one — so the model stays visible now the MOTORE crest is gone. */
function renderNeutralReadout() {
  const el = $('#gear-readout');
  if (!el) return;
  if (liveModelName) {
    el.innerHTML = `<b class="gr-glyph">N</b><span class="gr-sep">·</span>` +
      `<i class="gr-name">${escapeHtml(liveModelName)}</i>`;
  } else {
    el.textContent = 'N';
  }
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
const gearLabels = new Map();      // gear.gear number -> { glyph, name } for the readout
const knobEl = $('#shiftknob');

/* Open-gate geometry. VB.w is recomputed per gear count so a short gearbox
   gets a narrow plate instead of acres of empty nickel; the plate's CSS
   aspect-ratio is kept in sync so % positioning stays exact and the drilled
   holes stay round. margin 98 + step 88 give the classic ~2.3:1 plate at
   seven gears (4 columns). */
const VB = { w: 460, h: 200, gateY: 100, upY: 52, downY: 148, margin: 98, colStep: 88 };
let gateNeutral = { x: VB.w / 2, y: VB.gateY }; // derived from geometry in buildGearbox
let gateStop = { x: VB.w / 2, y: VB.downY };    // the R slot, ditto
let stopSpringback = null;                       // pending R spring-back timer
let knobPos = { x: gateNeutral.x, y: gateNeutral.y };
const pctX = (x) => (x / VB.w * 100) + '%';
const pctY = (y) => (y / VB.h * 100) + '%';

function slotByGear(num) { return gearSlots.get(num) || gateNeutral; }

function buildGearbox(gears) {
  const plate = $('#gearplate');
  const gate = $('#gate-svg');
  gearSlots.clear(); gearLabels.clear();

  // remove old positions (keep the knob + gate)
  plate.querySelectorAll('.gearpos').forEach((n) => n.remove());

  const total = gears.length;

  /* Every gear keeps its numeral (1..N, pairs per column). R is NOT a gear:
     it is the STOP position — it rides the free down slot of the last column
     when the gear count is odd, or gets a dog-leg column of its own. */
  const layout = gears.map((g, i) => ({ col: Math.floor(i / 2), down: i % 2 === 1 }));
  const gearCols = total ? Math.floor((total - 1) / 2) + 1 : 0;
  const rCol = (total % 2 === 1) ? Math.max(0, gearCols - 1) : gearCols;
  const colsCount = Math.max(gearCols, rCol + 1, 1);

  // size the plate to the gate it carries
  VB.w = VB.margin * 2 + (colsCount - 1) * VB.colStep;
  gate.setAttribute('viewBox', `0 0 ${VB.w} ${VB.h}`);
  plate.style.aspectRatio = `${VB.w} / ${VB.h}`;
  gateNeutral = { x: VB.w / 2, y: VB.gateY };

  const positions = layout.map((l) => ({
    x: VB.margin + l.col * VB.colStep,
    y: l.down ? VB.downY : VB.upY,
    col: l.col, down: l.down
  }));

  // ---- machine the gate: through-cut channels + drilled stop-holes ----
  let minX = VB.margin, maxX = VB.margin + (colsCount - 1) * VB.colStep;
  if (minX === maxX) { minX -= 20; maxX += 20; } // single column: stub cross-bar so it still reads as a gate
  let channels = `<path d="M ${minX} ${VB.gateY} H ${maxX}"/>`;
  const termini = [{ x: minX, y: VB.gateY }, { x: maxX, y: VB.gateY }];
  for (let c = 0; c < colsCount; c++) {
    const x = VB.margin + c * VB.colStep;
    if (positions.some((p) => p.col === c && !p.down)) {
      channels += `<path d="M ${x} ${VB.gateY} V ${VB.upY}"/>`;
      termini.push({ x, y: VB.upY });
    }
    if (positions.some((p) => p.col === c && p.down) || c === rCol) {
      channels += `<path d="M ${x} ${VB.gateY} V ${VB.downY}"/>`;
      termini.push({ x, y: VB.downY });
    }
  }
  /* Three passes per channel — lower-lip highlight, the through-hole void
     (vertical gradient so the cut reads as depth, not paint), then a top-edge
     shadow — plus a drilled stop-hole slightly proud of every slot end. */
  const holes = termini.map((t) =>
    `<circle cx="${t.x}" cy="${t.y + 1.4}" r="7.5" fill="rgba(255,255,255,0.4)"/>` +
    `<circle cx="${t.x}" cy="${t.y}" r="7" fill="url(#slotVoid)"/>`
  ).join('');
  gate.innerHTML = `
    <defs>
      <linearGradient id="slotVoid" x1="0" y1="0" x2="0" y2="${VB.h}" gradientUnits="userSpaceOnUse">
        <stop offset="0" stop-color="#14161a"/><stop offset="1" stop-color="#040506"/>
      </linearGradient>
    </defs>
    <g fill="none" stroke-linecap="round">
      <g stroke="rgba(255,255,255,0.45)" stroke-width="15" transform="translate(0,1.4)">${channels}</g>
      <g stroke="url(#slotVoid)" stroke-width="13">${channels}</g>
      <g stroke="rgba(0,0,0,0.45)" stroke-width="11" transform="translate(0,-0.8)">${channels}</g>
    </g>
    ${holes}`;

  // ---- clickable positions: engraved numerals outboard of the slot ends ----
  gears.forEach((g, i) => {
    const num = Number(g.gear != null ? g.gear : i + 1);
    const pos = positions[i];
    gearSlots.set(num, { x: pos.x, y: pos.y });
    gearLabels.set(num, { glyph: String(num), name: g.label || '' });

    const btn = document.createElement('button');
    btn.className = 'gearpos ' + (pos.down ? 'down' : 'up');
    btn.dataset.gear = String(num);
    btn.style.left = pctX(pos.x);
    /* anchored between numeral and slot mouth so one hit area covers both */
    btn.style.top = pctY(pos.down ? VB.downY + 13 : VB.upY - 13);
    btn.setAttribute('aria-label', `Shift to gear ${num}: ${g.label || ''} ${g.sublabel || ''}`.trim());
    btn.innerHTML = `<span class="gp-num">${num}</span>`;
    btn.addEventListener('click', () => onShift(num, pos));
    plate.appendChild(btn);
  });

  // ---- R: the STOP position (momentary — sends Escape, then springs back) ----
  gateStop = { x: VB.margin + rCol * VB.colStep, y: VB.downY };
  const rBtn = document.createElement('button');
  rBtn.className = 'gearpos down reverse';
  rBtn.style.left = pctX(gateStop.x);
  rBtn.style.top = pctY(VB.downY + 13);
  rBtn.setAttribute('aria-label', 'Retro / stop: interrupt the current run (Escape)');
  rBtn.innerHTML = '<span class="gp-num">R</span>';
  rBtn.addEventListener('click', onStop);
  plate.appendChild(rBtn);

  // re-seat the knob (viewBox may have changed width)
  setKnobImmediate(knobPos.x, knobPos.y);
}

/* R engaged: throw to the stop slot, send Escape, then spring back to the
   engaged gear — you don't stay in reverse while rolling. */
async function onStop() {
  if (DISPLAY_ONLY) return;
  clearTimeout(stopSpringback);
  throwKnob(gateStop.x, gateStop.y);
  $('#gear-readout').innerHTML =
    '<b class="gr-glyph">R</b><span class="gr-sep">·</span><i class="gr-name">stop</i>';
  stopSpringback = setTimeout(() => {
    if (engagedGear != null) {
      const s = slotByGear(engagedGear);
      throwKnob(s.x, s.y);
      renderReadout(engagedGear);
    } else {
      throwKnob(gateNeutral.x, gateNeutral.y);
      renderNeutralReadout();
    }
  }, 900);
  await reportInjection(dash.stop());
}

/* The single current-gear label: gear glyph + model name in the header plaque. */
function renderReadout(num) {
  const el = $('#gear-readout');
  const g = gearLabels.get(num);
  if (!g) { el.textContent = String(num); return; }
  el.innerHTML = `<b class="gr-glyph">${g.glyph}</b>` +
    (g.name ? `<span class="gr-sep">·</span><i class="gr-name">${escapeHtml(g.name)}</i>` : '');
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
  /* mechanical H-gate throw: ease-in as the knob leaves the slot, a loose
     run along the gate, then a firm ease-out as it seats in the new gear.
     The shadow deepens mid-run — the lever lifts as it clears the gate. */
  const shadow0 = 'drop-shadow(0 4px 5px rgba(0,0,0,0.55))';
  const shadow1 = 'drop-shadow(0 7px 8px rgba(0,0,0,0.5))';
  const kf = [
    { left: pctX(from.x), top: pctY(from.y), filter: shadow0, easing: 'cubic-bezier(.55,.06,.68,.35)' },
    { left: pctX(from.x), top: pctY(VB.gateY), filter: shadow1, offset: 0.26, easing: 'cubic-bezier(.33,.6,.35,1)' },
    { left: pctX(x),      top: pctY(VB.gateY), filter: shadow1, offset: 0.72, easing: 'cubic-bezier(.18,.9,.24,1)' },
    { left: pctX(x),      top: pctY(y), filter: shadow0 },
  ];
  try {
    const anim = knobEl.animate(kf, { duration: 420, fill: 'forwards' });
    const liftBall = knobEl.querySelector('.knob-ball');
    if (liftBall && liftBall.animate) {
      liftBall.animate([
        { transform: 'translateX(-50%) scale(1)' },
        { transform: 'translateX(-50%) scale(1.05)', offset: 0.5 },
        { transform: 'translateX(-50%) scale(1)' },
      ], { duration: 420, easing: 'ease-in-out' });
    }
    anim.onfinish = () => {
      // seat "clunk": the ball ticks ~1.5px into the gate and settles
      const ball = knobEl.querySelector('.knob-ball');
      if (ball && ball.animate) {
        ball.animate([
          { transform: 'translateX(-50%) translateY(0)' },
          { transform: 'translateX(-50%) translateY(1.5px) scale(0.985)', offset: 0.4 },
          { transform: 'translateX(-50%) translateY(0)' },
        ], { duration: 130, easing: 'ease-out' });
      }
    };
  } catch (_) { /* WAAPI unavailable */ }
  setKnobImmediate(x, y); // persist final resting style
}

async function onShift(num, pos) {
  if (DISPLAY_ONLY) return;
  clearTimeout(stopSpringback);
  throwKnob(pos.x, pos.y);
  renderReadout(num);
  document.querySelectorAll('.gearpos').forEach((b) =>
    b.classList.toggle('engaged', Number(b.dataset.gear) === num));
  await reportInjection(dash.shift(num));
}

/* =====================================================================
   3b. CHECK-ENGINE TELLTALE + injection result reporting
   Backends resolve { ok:false, error } instead of throwing, so a swallowed
   result used to mean a SILENT dead button (missing Accessibility grant,
   no target window, dead backend). Every action now reports through here:
   a failure lights the amber engine lamp in the titlebar with the error in
   its tooltip; the next success — or a click — clears it.
   ===================================================================== */
let engineOffTimer = 0;

function lightEngine(message) {
  const btn = $('#btn-engine');
  if (!btn) return;
  btn.hidden = false;
  btn.classList.add('lit');
  const msg = String(message || 'comando non consegnato');
  btn.title = 'Spia motore — ultimo comando non consegnato: ' + msg;
  btn.setAttribute('aria-label', btn.title);
  clearTimeout(engineOffTimer);
  engineOffTimer = setTimeout(clearEngine, 30000); // self-clears like a real telltale
}

function clearEngine() {
  const btn = $('#btn-engine');
  if (!btn) return;
  clearTimeout(engineOffTimer);
  btn.classList.remove('lit');
  btn.hidden = true;
}

let injectSeq = 0; // only the most recently issued command may touch the lamp

async function reportInjection(promise) {
  const seq = ++injectSeq;
  let r = null;
  try { r = await promise; } catch (err) {
    if (seq === injectSeq) lightEngine(err && err.message ? err.message : String(err));
    return null;
  }
  if (seq !== injectSeq) return r; // a newer command owns the lamp now
  if (r && r.ok === false) lightEngine(r.error);
  else if (r && r.ok) clearEngine();
  return r;
}

/* =====================================================================
   3c. MODALITÀ VETRINA — display-only when the injection backend reports
   unavailable (unsupported platform, missing xdotool, WSL sans interop).
   Gauges keep running off the statusline tap; controls go inert.
   ===================================================================== */
let DISPLAY_ONLY = null; // probe result when unavailable, else null

function enterDisplayOnly(info) {
  DISPLAY_ONLY = info || {};
  document.body.classList.add('vetrina');
  const reason = (DISPLAY_ONLY && DISPLAY_ONLY.reason) ||
    'keystroke injection unavailable on this platform';
  const console_ = document.querySelector('.console');
  if (console_) {
    console_.title = 'Modalità vetrina — comandi disattivati: ' + reason;
    console_.setAttribute('aria-disabled', 'true');
    // inert removes every descendant from focus/keyboard activation too —
    // pointer-events alone would still let Tab+Enter fire injections.
    if ('inert' in console_) console_.inert = true;
  }
  disableConsoleControls();
  const tgt = $('#route-target');
  if (tgt) { tgt.textContent = 'vetrina'; tgt.title = 'Display-only: ' + reason; }
}

// Really disable the console's controls (out of tab order, no Enter/Space).
// Re-applied after any rebuild, since rebuilds create fresh buttons.
function disableConsoleControls() {
  document.querySelectorAll('.console button').forEach((b) => { b.disabled = true; });
}

/* =====================================================================
   4. OVERDRIVE + SKILL SWITCHES
   ===================================================================== */
function wireOverdrive(nos) {
  const btn = $('#overdrive');
  const odPlate = $('#overdrive-plate');
  if (odPlate) odPlate.textContent = (nos && nos.label) || 'OVERDRIVE';
  btn.setAttribute('aria-label', `Engage ${(nos && nos.label) || 'overdrive'}`);
  btn.addEventListener('click', async () => {
    btn.classList.add('pulled');
    setTimeout(() => btn.classList.remove('pulled'), 620);
    await reportInjection(dash.boost());
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
      t.classList.remove('sprung');
      t.classList.add('on'); // fast flick down (see .toggle.on in CSS)
      setTimeout(() => {
        t.classList.remove('on'); // momentary: springs back…
        if (!reduceMotion) {
          t.classList.add('sprung'); // …with a tiny rotational wobble
          setTimeout(() => t.classList.remove('sprung'), 380);
        }
      }, 420);
      await reportInjection(dash.runButton(index));
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
  if (DISPLAY_ONLY) return;
  wiperSweepFx();
  wiperSpringToOff(700);
  if (typeof dash.wipe === 'function') await reportInjection(dash.wipe(modeIndex));
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
  if (plate) {
    // Known default labels follow the language switch; a custom label is
    // the user's own engraving and stays exactly as written.
    const DEFAULT_WIPER_LABELS = ['TERGI', 'OTTIMIZZA CONTESTO', 'OPTIMIZE CONTEXT', 'OTIMIZAR CONTEXTO', 'OPTIMIZAR CONTEXTO'];
    const lbl = wipers && wipers.label;
    plate.textContent = (!lbl || DEFAULT_WIPER_LABELS.includes(String(lbl).toUpperCase())) ? t('wipers') : lbl;
  }

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

/* The destructive "FULL" wiper — the one that fires /clear and wipes the whole
   context. Matched by its keystrokes so a renamed label still resolves; falls
   back to a FULL-labelled mode, then the last mode. Returns -1 if none. */
function clearWiperModeIndex() {
  const modes = (CONFIG && CONFIG.wipers && Array.isArray(CONFIG.wipers.modes)) ? CONFIG.wipers.modes : [];
  if (!modes.length) return -1;
  let i = modes.findIndex((m) => String(m && m.keystrokes || '').trim().toLowerCase() === '/clear');
  if (i < 0) i = modes.findIndex((m) => String(m && m.label || '').trim().toUpperCase() === 'FULL');
  return i < 0 ? modes.length - 1 : i;
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

  // safety: the FULL/clear wiper's double-click guard
  const clearChk = $('#cfg-clear-confirm');
  if (clearChk) {
    const ci = clearWiperModeIndex();
    clearChk.checked = ci >= 0 && !!CONFIG.wipers.modes[ci].confirm;
    clearChk.disabled = ci < 0;
  }
}

async function saveConfigForm() {
  if (!CONFIG) return;
  const next = JSON.parse(JSON.stringify(CONFIG)); // clone, preserve unknown keys

  next.targetTerminal = $('#cfg-terminal').value || 'auto';
  next.language = ($('#cfg-language') && $('#cfg-language').value) || next.language || 'it';

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

  // safety toggle for the FULL/clear wiper — resolve against `next` so a
  // freshly-edited modes array (should it ever change here) stays consistent
  const clearChk = $('#cfg-clear-confirm');
  const nextModes = next.wipers && Array.isArray(next.wipers.modes) ? next.wipers.modes : [];
  if (clearChk && nextModes.length) {
    let ci = nextModes.findIndex((m) => String(m && m.keystrokes || '').trim().toLowerCase() === '/clear');
    if (ci < 0) ci = nextModes.findIndex((m) => String(m && m.label || '').trim().toUpperCase() === 'FULL');
    if (ci < 0) ci = nextModes.length - 1;
    nextModes[ci].confirm = clearChk.checked;
  }

  const status = $('#config-status');
  try {
    await dash.saveConfig(next);
    try { await dash.setTerminal(next.targetTerminal); } catch (_) {}
    CONFIG = next;
    applyI18n(next.language);
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
  const odPlate = $('#overdrive-plate');
  if (odPlate) odPlate.textContent = (CONFIG.nos && CONFIG.nos.label) || 'OVERDRIVE';
  // re-apply engaged highlight after rebuild
  const eg = engagedGear; engagedGear = null; setEngaged(eg);
  // rebuilds create fresh buttons — keep vetrina genuinely inert
  if (DISPLAY_ONLY) disableConsoleControls();
}

/* =====================================================================
   7b. SELF-UPDATE TELLTALE  ("richiamo in officina")
   The main process checks GitHub daily (the renderer's CSP forbids network).
   When a newer version exists, it lights this amber lamp in the titlebar.
   First click arms (confirm), second click downloads + relaunches.
   ===================================================================== */
let updateInfo = null;
let updateBusy = false;
let recallArmTimer = 0;

function showRecall(info) {
  if (info) updateInfo = info;
  const btn = $('#btn-update');
  if (!btn) return;
  btn.hidden = false;
  btn.classList.remove('working', 'failed', 'armed');
  btn.classList.add('lit');
  const to = updateInfo && updateInfo.remote ? updateInfo.remote : '';
  const from = updateInfo && updateInfo.local ? updateInfo.local : '';
  btn.title = to
    ? `Aggiornamento disponibile: v${from} → v${to} — clic per installare`
    : 'Aggiornamento disponibile';
  btn.setAttribute('aria-label', btn.title);
}

async function onRecallClick() {
  const btn = $('#btn-update');
  if (!btn || updateBusy) return;

  // first click arms; second click within the window commits (like the wiper)
  if (!btn.classList.contains('armed')) {
    btn.classList.add('armed');
    btn.title = 'Clic di nuovo per scaricare e riavviare';
    clearTimeout(recallArmTimer);
    recallArmTimer = setTimeout(() => { btn.classList.remove('armed'); showRecall(); }, 3000);
    return;
  }

  clearTimeout(recallArmTimer);
  updateBusy = true;
  btn.classList.remove('armed');
  btn.classList.add('working');
  btn.title = 'Scarico l’aggiornamento…';
  try {
    const r = await dash.applyUpdate();
    // On success the app relaunches into the new version and we never reach
    // here; a returned {ok:false} means it failed before the relaunch.
    if (r && r.ok === false) {
      updateBusy = false;
      btn.classList.remove('working');
      btn.classList.add('failed');
      btn.title = 'Aggiornamento fallito: ' + (r.error || 'errore') + ' — clic per riprovare';
      setTimeout(() => { btn.classList.remove('failed'); showRecall(); }, 4500);
    }
  } catch (_e) {
    updateBusy = false;
    btn.classList.remove('working');
    showRecall();
  }
}

function wireUpdate() {
  const btn = $('#btn-update');
  if (btn) btn.addEventListener('click', onRecallClick);
  try {
    if (typeof dash.onUpdateAvailable === 'function') {
      dash.onUpdateAvailable((info) => { if (info && info.available) showRecall(info); });
    }
  } catch (_) {}
}

/* =====================================================================
   8. BOOT
   ===================================================================== */
async function boot() {
  wireTitlebar();
  wireUpdate();
  const engineBtn = $('#btn-engine');
  if (engineBtn) engineBtn.addEventListener('click', clearEngine); // acknowledge
  buildOdometer();
  $('#config-close').addEventListener('click', closeConfig);
  $('#config-scrim').addEventListener('click', closeConfig);
  $('#config-save').addEventListener('click', saveConfigForm);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeConfig(); });

  // fallback config so the UI is never empty even before the bridge answers
  try { CONFIG = await dash.getConfig(); } catch (_) {}
  if (!CONFIG) CONFIG = FALLBACK_CONFIG;
  applyI18n(CONFIG.language || 'it');

  buildGearbox(CONFIG.gears || []);
  buildSwitches(CONFIG.skillButtons || []);
  buildWipers(CONFIG.wipers);
  wireOverdrive(CONFIG.nos);

  // vetrina check: if the injection backend can't work here (missing xdotool,
  // unsupported platform, WSL without interop), dim the controls up front
  // instead of letting every click die silently.
  try {
    if (typeof dash.probeInjection === 'function') {
      const probe = await dash.probeInjection();
      if (probe && probe.available === false) enterDisplayOnly(probe);
    }
  } catch (_) { /* probe is best-effort */ }

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

const ALL_GAUGES = [gaugeTach, gaugeRpm, gaugeFuel];
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
    { gear: 7, label: 'Fable 5', sublabel: '', modelArg: 'claude-fable-5' },
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
