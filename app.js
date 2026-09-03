import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import VocalTract from './vocal-tract.js';
import IPA_DATA from './ipa-data.js';

// ============================================
// APP STATE
// ============================================
const state = {
  currentSound: null,
  previousSound: null,
  recentSounds: [],
  isPlaying: false,
  looping: false,
  speed: 1,
  labelsVisible: true,
  airflowVisible: false,
  compareMode: false,
  compareSlot: 1,
  compareSound1: null,
  compareSound2: null,
  infoPanelOpen: false,
  darkMode: true,
  currentView: 'side',
  muted: false,
};

// ============================================
// THREE.JS SETUP
// ============================================
const canvas = document.getElementById('three-canvas');
const viewport = document.getElementById('viewport');

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(viewport.clientWidth, viewport.clientHeight);
renderer.setClearColor(0x0B1221);
// Filmic colour pipeline — realistic light response and highlight roll-off for wet tissue
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
// Soft shadows add depth to the oral cavity
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();

// ---------------------------------------------------------------
// Procedural studio environment (PMREM) — gives every PBR material
// soft, realistic reflections so wet mucosa reads as wet, not plastic.
// Built from a canvas gradient so the app stays fully offline (no HDR file).
// ---------------------------------------------------------------
function buildStudioEnvironment(rendererRef) {
  const c = document.createElement('canvas');
  c.width = 16; c.height = 256;
  const ctx = c.getContext('2d');
  const g = ctx.createLinearGradient(0, 0, 0, 256);
  g.addColorStop(0.00, '#3a4252'); // cool soft "sky" overhead
  g.addColorStop(0.45, '#6b6f78');
  g.addColorStop(0.55, '#8a8580'); // warm horizon band → soft key reflection
  g.addColorStop(1.00, '#2b2620'); // darker "floor"
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 16, 256);
  const tex = new THREE.CanvasTexture(c);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  const pmrem = new THREE.PMREMGenerator(rendererRef);
  const envRT = pmrem.fromEquirectangular(tex);
  tex.dispose();
  pmrem.dispose();
  return envRT.texture;
}
scene.environment = buildStudioEnvironment(renderer);

// Camera
const camera = new THREE.PerspectiveCamera(45, viewport.clientWidth / viewport.clientHeight, 0.1, 100);
camera.position.set(0.3, 0.1, 5.5);
camera.lookAt(0.2, 0.1, 0);

// Lighting — 3-point studio rig tuned for the filmic pipeline.
// The environment map supplies soft fill, so ambient is kept low to preserve
// form-defining shadows (a flat high-ambient look is what reads as "low-end").
const ambientLight = new THREE.AmbientLight(0xffffff, 0.18);
scene.add(ambientLight);

// Key light — warm, slightly raised front-right, casts soft shadows
const dirLight = new THREE.DirectionalLight(0xfff1e0, 2.1);
dirLight.position.set(2.5, 3.5, 4.5);
dirLight.castShadow = true;
dirLight.shadow.mapSize.set(1024, 1024);
dirLight.shadow.camera.near = 0.5;
dirLight.shadow.camera.far = 20;
dirLight.shadow.camera.left = -3;
dirLight.shadow.camera.right = 3;
dirLight.shadow.camera.top = 3;
dirLight.shadow.camera.bottom = -3;
dirLight.shadow.bias = -0.0008;
// (No shadow.radius: it is ignored under PCFSoftShadowMap — softness there
// comes from the map size, and 1024 reads well for a scene this size.)
// Only recompute the shadow map while something is actually moving (see animate()).
// Saves a full shadow pass every idle frame — meaningful on mobile/laptop GPUs.
dirLight.shadow.autoUpdate = false;
dirLight.shadow.needsUpdate = true;
scene.add(dirLight);

// Any geometry change made outside the tween loop (sliders, drag handles,
// frame stepping, view/teeth toggles) must re-render the frozen shadow map,
// otherwise the previous pose's shadow is drawn under the new one.
function markShadowsDirty() {
  dirLight.shadow.needsUpdate = true;
}

// Fill light — cool, opposite side, no shadow, softens the dark side
const backLight = new THREE.DirectionalLight(0xc8d4e0, 0.55);
backLight.position.set(-3, -0.5, -3);
scene.add(backLight);

// WebGL context loss/restore — routine on mobile when the tab is backgrounded.
// The PMREM environment map and the frozen (autoUpdate=false) shadow map hold
// GPU-only data that is gone after a restore, so regenerate them or the scene
// comes back dark/plastic with garbage shadows and no recovery but a reload.
canvas.addEventListener('webglcontextlost', (e) => {
  e.preventDefault(); // required for 'webglcontextrestored' to fire
}, false);
canvas.addEventListener('webglcontextrestored', () => {
  scene.environment = buildStudioEnvironment(renderer);
  dirLight.shadow.needsUpdate = true;
}, false);

// Controls
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.target.set(0.2, 0.1, 0);
controls.update();

// Vocal Tract — defaults to full 3D; the cross-section toggle swaps to a flat diagram
const vocalTract = new VocalTract(scene);

// Rim light — from front/camera side, grazes edges for separation and wet highlights
const frontLight = new THREE.DirectionalLight(0xffffff, 0.7);
frontLight.position.set(5, 1, 0);
scene.add(frontLight);

// ============================================
// CAMERA VIEWS
// ============================================
const cameraViews = {
  side:  { pos: new THREE.Vector3(0.3, 0.1, 5.5),  target: new THREE.Vector3(0.2, 0.1, 0) },
  front: { pos: new THREE.Vector3(4.5, 0.2, 0),     target: new THREE.Vector3(0.2, 0.1, 0) },
  top:   { pos: new THREE.Vector3(0.2, 5.5, 0.5),   target: new THREE.Vector3(0.2, 0, 0) },
  free:  { pos: new THREE.Vector3(2.5, 1.8, 3.5),   target: new THREE.Vector3(0.2, 0.1, 0) },
};

let cameraAnimating = false;
let cameraStartPos = new THREE.Vector3();
let cameraEndPos = new THREE.Vector3();
let cameraStartTarget = new THREE.Vector3();
let cameraEndTarget = new THREE.Vector3();
let cameraT = 0;

function setCameraView(viewName) {
  const view = cameraViews[viewName];
  if (!view) return;
  state.currentView = viewName;
  document.querySelectorAll('.view-btn').forEach(b => b.classList.toggle('active', b.dataset.view === viewName));
  cameraStartPos.copy(camera.position);
  cameraEndPos.copy(view.pos);
  cameraStartTarget.copy(controls.target);
  cameraEndTarget.copy(view.target);
  cameraT = 0;
  cameraAnimating = true;
}

document.querySelectorAll('.view-btn').forEach(btn => {
  btn.addEventListener('click', () => setCameraView(btn.dataset.view));
});

// ============================================
// TWEEN SYSTEM
// ============================================
class TweenManager {
  constructor() { this.tweens = []; }

  tween(target, props, duration, onUpdate) {
    const start = {};
    const end = {};
    for (const [key, val] of Object.entries(props)) {
      if (typeof val === 'object' && target[key]) {
        start[key] = { ...target[key] };
        end[key] = { ...target[key], ...val };
      } else {
        start[key] = target[key];
        end[key] = val;
      }
    }
    this.tweens.push({ target, start, end, duration, elapsed: 0, onUpdate });
  }

  update(dt) {
    this.tweens = this.tweens.filter(tw => {
      tw.elapsed += dt;
      const t = Math.min(tw.elapsed / tw.duration, 1);
      const ease = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; // ease in-out cubic

      for (const [key, endVal] of Object.entries(tw.end)) {
        if (typeof endVal === 'object') {
          if (!tw.target[key]) tw.target[key] = {};
          for (const [k2, v2] of Object.entries(endVal)) {
            const s = tw.start[key][k2] ?? v2;
            tw.target[key][k2] = s + (v2 - s) * ease;
          }
        } else if (typeof endVal === 'number') {
          const s = tw.start[key] ?? endVal;
          tw.target[key] = s + (endVal - s) * ease;
        } else {
          if (t >= 1) tw.target[key] = endVal;
        }
      }
      if (tw.onUpdate) tw.onUpdate(tw.target, t);
      return t < 1;
    });
  }

  cancel() { this.tweens = []; }
  get active() { return this.tweens.length > 0; }
}

const tweenMgr = new TweenManager();

// ============================================
// SOUND SELECTION & ANIMATION
// ============================================
function selectSound(symbol) {
  const sound = IPA_DATA.sounds[symbol];
  if (!sound) return;

  state.previousSound = state.currentSound;
  state.currentSound = sound;

  // Update display
  document.getElementById('current-symbol').textContent = sound.symbol;
  document.getElementById('current-name').textContent = sound.name;

  // Update voicing indicator
  const vi = document.getElementById('voicing-indicator');
  vi.className = sound.voiced ? 'voicing-on' : 'voicing-off';
  vi.querySelector('.voicing-label').textContent = sound.voiced ? 'Voiced' : 'Voiceless';

  // Update active button
  document.querySelectorAll('.ipa-btn.active, .vowel-btn.active').forEach(b => b.classList.remove('active'));
  const btn = document.querySelector(`[data-symbol="${CSS.escape(symbol)}"]`);
  if (btn) btn.classList.add('active');

  // Add to recent
  addToRecent(symbol);

  // Update info panel
  updateInfoPanel(sound);

  // Update adjustment sliders
  updateSlidersFromSound(sound);

  // Handle comparison mode
  if (state.compareMode) {
    handleCompareSelect(sound);
    return;
  }

  // Animate
  animateToSound(sound);

  // Play audio for the sound
  playIPASound(sound.symbol);
}

// The complete lip pose for a sound. A sound with no lip data falls back to a
// neutral parted mouth (otherwise the closed lips of a preceding bilabial would
// stick on the next sound). Bilabials (openness:0) drive full closure;
// labiodentals drive the lower-lip-to-teeth gesture. Shared by the animated
// path and the step-forward button so both land on the same pose.
function lipTargetFor(sound) {
  const labiodental = sound.place === 'labiodental' ? 1 : 0;
  const lipDefault = { rounding: 0, openness: 0.3, protrusion: 0, spread: 0 };
  return { ...lipDefault, ...(sound.articulators.lips || {}), labiodental };
}

function animateToSound(sound) {
  tweenMgr.cancel();
  const art = sound.articulators;
  const duration = 0.5 / state.speed;

  // Animate tongue — always animate so tongue moves to correct position
  // for every sound (including bilabials/labiodentals that lack tongue data).
  {
    const params = {};
    const isVowel = sound.type === 'vowel';
    if (art.tongue_tip && !isVowel) params.tip = { x: art.tongue_tip.x, y: art.tongue_tip.y, contact: !!art.tongue_tip.contact };
    if (art.tongue_blade && !isVowel) params.blade = { x: art.tongue_blade.x, y: art.tongue_blade.y };
    params.body = art.tongue_body
      ? { height: art.tongue_body.height, frontness: art.tongue_body.frontness }
      : { height: 0.45, frontness: 0.50 };
    if (art.tongue_root) params.root = { advancement: art.tongue_root.advancement };

    // 1. Capture start tongue positions
    const startTongue = JSON.parse(JSON.stringify(vocalTract.currentTongue));

    // 2. Compute end positions by calling setTonguePosition once
    const targetIsConsonant = !isVowel;
    vocalTract.setTonguePosition(params, sound.place);
    const endTongue = JSON.parse(JSON.stringify(vocalTract.currentTongue));

    // 3. Restore start positions and rebuild
    const tongueKeys = ['tip', 'blade', 'front', 'body', 'root'];
    for (const k of tongueKeys) {
      vocalTract.currentTongue[k].x = startTongue[k].x;
      vocalTract.currentTongue[k].y = startTongue[k].y;
    }
    vocalTract._rebuildTongueMesh();

    // 4. Tween t from 0→1, lerping each control point
    const tweenTarget = { t: 0 };
    tweenMgr.tween(tweenTarget, { t: 1 }, duration, (tgt) => {
      const t = tgt.t;
      for (const k of tongueKeys) {
        vocalTract.currentTongue[k].x = startTongue[k].x + (endTongue[k].x - startTongue[k].x) * t;
        vocalTract.currentTongue[k].y = startTongue[k].y + (endTongue[k].y - startTongue[k].y) * t;
      }
      vocalTract._isConsonant = targetIsConsonant;
      vocalTract._rebuildTongueMesh();
    });
  }

  // Animate lips — ALWAYS, so the lips reset between sounds (see lipTargetFor).
  {
    const lipTarget = { ...vocalTract.currentLips };
    tweenMgr.tween(lipTarget, lipTargetFor(sound), duration, (tgt) => {
      vocalTract.setLipShape(tgt);
    });
  }

  // Animate velum
  if (art.velum) {
    const velTarget = { h: vocalTract.currentVelumHeight };
    tweenMgr.tween(velTarget, { h: art.velum.height ?? (art.velum.raised ? 1 : 0) }, duration, (tgt) => {
      vocalTract.setVelumHeight(tgt.h);
    });
  }

  // Animate jaw
  if (art.jaw) {
    const jawTarget = { o: vocalTract.currentJawOpen };
    tweenMgr.tween(jawTarget, { o: art.jaw.openness }, duration, (tgt) => {
      vocalTract.setJawOpenness(tgt.o);
    });
  }

  // Set voicing
  vocalTract.setVoicing(art.vocal_folds?.vibrating ?? false);

  // Update airflow if visible
  if (state.airflowVisible) {
    updateAirflow(sound);
  }

  state.isPlaying = true;
  updatePlayButton();
}

// ============================================
// AIRFLOW VISUALIZATION
// Premium path-following particle system: one additively-blended THREE.Points
// draw call whose particles ride Catmull-Rom centerlines of the vocal tract
// (oral + nasal branches sharing the glottis→velum stem). Manner-aware:
// laminar blue stream (vowels/approximants), gold turbulent jet downstream of
// the constriction (fricatives/affricates), pressure-build → burst (plosives),
// teal nasal-branch flow (nasals). Voiced sounds pulse in sync with
// vocalTract.voicingTime (the same clock that drives the vocal-fold glow).
// Particles are recycled at the path end — they never escape past the
// lips/nostril (the old system let them fly to x=2.5, outside the head).
// ============================================
let airflowParticles = null;   // THREE.Points — the toggle flips .visible
let airflowGeom = null;
let airflowFlow = null;        // descriptor of the current sound's airflow

const AIRFLOW_IS_MOBILE = window.matchMedia('(max-width: 820px)').matches;
const AIRFLOW_MAX = AIRFLOW_IS_MOBILE ? 350 : 800;

// --- Tract centerlines (anchors match vocalTract.getArticulatorPositions) ---
// Shared lower stem: glottis → pharynx (behind tongue root) → velum junction
const AIRFLOW_STEM = [
  new THREE.Vector3(-0.38, -0.90, 0),
  new THREE.Vector3(-0.40, -0.55, 0),
  new THREE.Vector3(-0.52, -0.05, 0),
  new THREE.Vector3(-0.42, 0.40, 0),
  new THREE.Vector3(-0.24, 0.56, 0),
];
// Oral branch: velum → oropharynx → mid oral → alveolar → lips → just past lips
const airflowOralCurve = new THREE.CatmullRomCurve3([
  ...AIRFLOW_STEM,
  new THREE.Vector3(0.10, 0.50, 0),
  new THREE.Vector3(0.55, 0.46, 0),
  new THREE.Vector3(0.95, 0.44, 0),
  new THREE.Vector3(1.30, 0.42, 0),
  new THREE.Vector3(1.55, 0.42, 0),
], false, 'catmullrom', 0.5);
// Nasal branch: velum → up behind palate → nasal cavity → out the nostril
const airflowNasalCurve = new THREE.CatmullRomCurve3([
  ...AIRFLOW_STEM,
  new THREE.Vector3(-0.05, 0.80, 0),
  new THREE.Vector3(0.35, 0.98, 0),
  new THREE.Vector3(0.80, 1.04, 0),
  new THREE.Vector3(1.25, 1.12, 0),
  new THREE.Vector3(1.50, 1.20, 0),
], false, 'catmullrom', 0.5);
airflowOralCurve.arcLengthDivisions = 200;
airflowNasalCurve.arcLengthDivisions = 200;
airflowOralCurve.getLength();   // prime arc-length caches (avoids first-frame hitch)
airflowNasalCurve.getLength();

// Tube radius profile along t — widest mid-tract, narrower at glottis and exit
function airflowTubeRadius(t) {
  return 0.16 * (0.7 + 0.5 * Math.sin(t * Math.PI)); // ~0.11..0.19
}

// constriction_point → t along the oral curve (0 = glottis, 1 = past lips)
const AIRFLOW_CONSTRICT_T = {
  none: 1.0, glottal: 0.05, pharyngeal: 0.30, uvular: 0.42, velar: 0.50,
  palatal: 0.66, 'alveolo-palatal': 0.70, postalveolar: 0.74,
  alveolar: 0.80, alveolar_ridge: 0.80, alveolar_lateral: 0.80,
  dental: 0.88, labiodental: 0.90, bilabial: 0.96,
  'labial-velar': 0.96, 'labial-palatal': 0.96,
};

// Manner tuning tables (keys are ipa-data airflow.type values)
const AIRFLOW_SPEED = {
  vowel: 0.35, approximant: 0.4, fricative: 0.7, affricate: 0.7, nasal: 0.4,
  plosive_release: 1.2, trill: 0.5, tap: 0.6,
  ejective: 1.2, ejective_fricative: 1.0, click: 0.6, implosive: 0.5,
};
const AIRFLOW_EMIT = {
  vowel: 120, approximant: 120, fricative: 360, affricate: 320, nasal: 150,
  plosive_release: 60, trill: 160, tap: 120, burst: 1600,
  ejective: 60, ejective_fricative: 240, click: 90, implosive: 80,
};
const AIRFLOW_ALPHA = {
  vowel: 0.5, approximant: 0.5, fricative: 0.85, affricate: 0.85, nasal: 0.75,
  plosive_release: 0.9, trill: 0.75, tap: 0.7,
  ejective: 0.9, ejective_fricative: 0.85, click: 0.8, implosive: 0.7,
};
// Colors (raw shader values — additive over the navy background)
const AIRFLOW_COL_LAMINAR = [0.30, 0.62, 0.98]; // cool blue
const AIRFLOW_COL_TURB = [0.95, 0.62, 0.20];    // warm gold (app accent)
const AIRFLOW_COL_NASAL = [0.32, 0.85, 0.78];   // teal

// Typed-array pools — GPU attributes + sim state, zero per-frame allocation
const afPos = new Float32Array(AIRFLOW_MAX * 3);
const afCol = new Float32Array(AIRFLOW_MAX * 3);
const afSiz = new Float32Array(AIRFLOW_MAX);
const afAlp = new Float32Array(AIRFLOW_MAX);
const afT = new Float32Array(AIRFLOW_MAX);      // progress 0..1 along curve
const afSpeed = new Float32Array(AIRFLOW_MAX);  // along-path speed
const afLane = new Float32Array(AIRFLOW_MAX);   // lateral angle seed
const afLat = new Float32Array(AIRFLOW_MAX);    // lateral radius fraction 0..1
const afLife = new Float32Array(AIRFLOW_MAX);   // seconds alive (wobble phase)
const afBranch = new Uint8Array(AIRFLOW_MAX);   // 0 = oral, 1 = nasal
const afActive = new Uint8Array(AIRFLOW_MAX);
const afFree = new Int32Array(AIRFLOW_MAX);     // free-index stack (O(1) spawn)
let afFreeCount = 0;
let afEmitAcc = 0;                              // fractional emission carry

const _afPoint = new THREE.Vector3();           // preallocated temp — reused every frame

function makeAirflowGlowTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0.0, 'rgba(255,255,255,1)');
  g.addColorStop(0.3, 'rgba(255,255,255,0.6)');
  g.addColorStop(1.0, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function createAirflowSystem() {
  airflowGeom = new THREE.BufferGeometry();
  airflowGeom.setAttribute('position', new THREE.BufferAttribute(afPos, 3));
  airflowGeom.setAttribute('aColor', new THREE.BufferAttribute(afCol, 3));
  airflowGeom.setAttribute('aSize', new THREE.BufferAttribute(afSiz, 1));
  airflowGeom.setAttribute('aAlpha', new THREE.BufferAttribute(afAlp, 1));
  // Generous static bounds — never recomputed per frame
  airflowGeom.boundingSphere = new THREE.Sphere(new THREE.Vector3(0.4, 0.2, 0), 5);

  // Soft-glow point sprites with per-particle size/alpha (PointsMaterial can't)
  const material = new THREE.ShaderMaterial({
    uniforms: {
      uTex: { value: makeAirflowGlowTexture() },
      uPix: { value: Math.min(window.devicePixelRatio, 2) },
    },
    transparent: true,
    depthWrite: false,
    // depthTest off: the flow is a schematic overlay — it must stay readable
    // where the airway runs behind opaque tongue/palate/nasal geometry
    // (with depthTest the gold jet and nostril exit vanish inside the head).
    depthTest: false,
    blending: THREE.AdditiveBlending,
    vertexShader: `
      attribute vec3 aColor;
      attribute float aSize;
      attribute float aAlpha;
      uniform float uPix;
      varying vec3 vC;
      varying float vA;
      void main() {
        vC = aColor;
        vA = aAlpha;
        vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = aSize * uPix * (26.0 / max(-mvPosition.z, 0.1));
        gl_Position = projectionMatrix * mvPosition;
      }`,
    fragmentShader: `
      uniform sampler2D uTex;
      varying vec3 vC;
      varying float vA;
      void main() {
        float a = texture2D(uTex, gl_PointCoord).a;
        gl_FragColor = vec4(vC * vA, a * vA);
      }`,
  });

  airflowParticles = new THREE.Points(airflowGeom, material);
  airflowParticles.visible = false;
  airflowParticles.frustumCulled = false;
  airflowParticles.castShadow = false;
  airflowParticles.receiveShadow = false;
  airflowParticles.renderOrder = 20; // after the translucent skin shell (10)
  vocalTract.group.add(airflowParticles); // inherits any tract transform

  for (let i = 0; i < AIRFLOW_MAX; i++) afFree[i] = i;
  afFreeCount = AIRFLOW_MAX;
}
createAirflowSystem();

function updateAirflow(sound) {
  if (!airflowParticles || !sound) return;
  const af = sound.airflow;
  if (!af) { airflowFlow = null; return; }

  airflowParticles.visible = state.airflowVisible;

  // Pressure-build → burst envelope for stop-like manners
  const release = af.type === 'plosive_release' || af.type === 'affricate'
    || af.type === 'ejective' || af.type === 'ejective_fricative';

  // Clicks (velaric) and implosives (glottalic) use an INGRESSIVE airstream —
  // air is drawn INTO the tract, not pushed out. Particles flow lips→glottis.
  const ingressive = af.type === 'click' || af.type === 'implosive';

  airflowFlow = {
    symbol: sound.symbol,   // lets the toggle skip a re-seed for the same sound
    type: af.type,
    path: af.path,
    tC: AIRFLOW_CONSTRICT_T[af.constriction_point] ?? 1.0,
    release,
    ingressive,
    // Negative = pressure-building phase (in speed-scaled time, so the hold
    // tracks the 0.5/state.speed articulator tween); re-triggering a sound
    // re-arms the burst.
    burstClock: release ? -0.35 : 0,
    clock: 0,
  };

  // Pre-warm: seed the new stream along the whole path so a sound switch
  // shows a full stream immediately instead of a slow crawl from the glottis.
  // Release manners (plosives & co.) start empty — they must visibly build
  // pressure behind the closure first.
  if (!release) {
    const seedCount = AIRFLOW_IS_MOBILE ? 90 : 220;
    for (let n = 0; n < seedCount; n++) {
      const i = spawnAirflowParticle();
      if (i < 0) break;
      afT[i] = Math.random() * 0.95;
    }
  }
}

function spawnAirflowParticle() {
  if (afFreeCount === 0 || !airflowFlow) return -1;
  const i = afFree[--afFreeCount];
  afActive[i] = 1;
  afLife[i] = 0;
  afT[i] = airflowFlow.ingressive ? 1.0 : 0; // ingressive streams start at the lips
  afLane[i] = Math.random() * 6.283;
  afLat[i] = Math.sqrt(Math.random()); // uniform over the tube cross-section
  // Branch decision reads the LIVE velum: nasal sounds (full oral closure)
  // route everything through the nose; an oral sound with a lowered velum
  // (nasalised vowel) splits the stream part-nasal.
  if (airflowFlow.path === 'nasal') afBranch[i] = 1;
  else if (vocalTract.currentVelumHeight < 0.5) afBranch[i] = Math.random() < 0.4 ? 1 : 0;
  else afBranch[i] = 0;
  const base = AIRFLOW_SPEED[airflowFlow.type] ?? 0.5;
  afSpeed[i] = base * (0.8 + 0.4 * Math.random());
  return i;
}

function recycleAirflowParticle(i) {
  afActive[i] = 0;
  afAlp[i] = 0; // alpha 0 → additive blend contributes nothing
  afFree[afFreeCount++] = i;
}

function animateAirflow(dt) {
  if (!airflowParticles || !airflowParticles.visible) return;
  const flow = airflowFlow;
  if (!flow) return;

  flow.clock += dt;

  // Voiced pulse synced to the vocal folds (same clock as the fold glow,
  // vocalTract.voicingTime advances at 12 rad/s while voicing is active)
  const pulse = vocalTract.voicingActive
    ? Math.sin(vocalTract.voicingTime) * 0.5 + 0.5
    : 1.0;

  const isJet = flow.type === 'fricative' || flow.type === 'affricate'
    || flow.type === 'ejective_fricative';

  // --- Emission budget this frame ---
  let rate = (AIRFLOW_EMIT[flow.type] ?? 120) * (0.6 + 0.4 * pulse);
  if (flow.type === 'trill') rate *= Math.sin(flow.clock * 28) * 0.5 + 0.5; // flutter
  if (flow.release) {
    flow.burstClock += dt * state.speed;
    if (flow.burstClock < 0) rate *= 0.3;                  // build: air piles up behind closure
    else if (flow.burstClock < 0.12) rate = AIRFLOW_EMIT.burst; // release puff
    else rate *= 0.15;                                     // aspiration tail
  }
  afEmitAcc += rate * dt;
  while (afEmitAcc >= 1) { afEmitAcc -= 1; spawnAirflowParticle(); }

  const building = flow.release && flow.burstClock < 0;
  const bursting = flow.release && flow.burstClock >= 0 && flow.burstClock < 0.3;
  const flatten = crossSectionMode; // x-section: keep flow on the sagittal plane

  for (let i = 0; i < AIRFLOW_MAX; i++) {
    if (!afActive[i]) continue;
    afLife[i] += dt;

    const nasal = afBranch[i] === 1;
    const dC = afT[i] - flow.tC;

    // --- Advance along the path ---
    let s = afSpeed[i];
    if (bursting) s *= 1.8;                                   // burst shoots out fast
    if (isJet && !nasal && dC > -0.04 && dC < 0.16) s *= 1.7; // jet through the pinch
    if (building && !nasal && dC > -0.06) s *= 0.04;          // stall behind the closure
    if (flow.ingressive) {
      afT[i] -= s * dt * state.speed;                          // inward: lips → glottis
      if (afT[i] <= 0) { recycleAirflowParticle(i); continue; }
    } else {
      afT[i] += s * dt * state.speed;
      if (afT[i] >= 1.0) { recycleAirflowParticle(i); continue; } // recycle at path end — never past lips/nostril
    }

    const curve = nasal ? airflowNasalCurve : airflowOralCurve;
    curve.getPointAt(afT[i], _afPoint);

    // --- Lateral spread: tight laminar lane vs fanning turbulent plume ---
    let turb = 0.3;
    if (flow.type === 'vowel' || flow.type === 'approximant') turb = 0.16;
    if (isJet && !nasal && dC > 0) turb = 1.0 + 1.6 * dC;     // plume fans downstream
    if (building && !nasal && dC > -0.08 && dC < 0) turb = 0.9; // compressed pocket
    const r = airflowTubeRadius(afT[i]) * afLat[i] * turb;
    const wob = turb > 0.5 ? Math.sin(afLife[i] * 9 + afLane[i]) * r * 0.45 : 0;

    afPos[i * 3] = _afPoint.x + Math.cos(afLane[i] * 1.7 + afLife[i] * 2) * r * 0.25;
    afPos[i * 3 + 1] = _afPoint.y + Math.sin(afLane[i]) * r + wob;
    afPos[i * 3 + 2] = flatten ? 0.01 : _afPoint.z + Math.cos(afLane[i]) * r;

    // Jet factor: 0 upstream of the pinch → 1 fully in the turbulent plume
    // (the blend starts fractionally before the pinch so the pinch itself glows)
    const jetK = (isJet || bursting) && !nasal && dC > -0.03
      ? Math.min((dC + 0.03) * 7, 1) : 0;

    // --- Alpha: fade in over first 10% of path, out over last 15% ---
    // sqrt fade keeps the exit segment readable (lips sit at t≈0.94); the
    // turbulent jet additionally gets an alpha boost so it reads while it
    // exits past the lips.
    const fadeIn = Math.min(afT[i] / 0.1, 1);
    const fadeOut = afT[i] > 0.85 ? Math.sqrt((1 - afT[i]) / 0.15) : 1;
    const baseAlpha = AIRFLOW_ALPHA[flow.type] ?? 0.7;
    afAlp[i] = Math.min(
      fadeIn * fadeOut * baseAlpha * (0.65 + 0.35 * pulse) * (1 + 0.9 * jetK), 1.1);

    // --- Size 1.5–4, scaled by manner (bigger when turbulent/bursting) ---
    let size = turb > 0.6 ? 3.2 : 1.9;
    if (bursting && !nasal && dC > -0.06) size = 3.6;
    afSiz[i] = size * (0.85 + 0.3 * afLat[i]);

    // --- Color: teal nasal / cool→gold across a jet pinch / laminar blue ---
    let cR, cG, cB;
    if (nasal) {
      cR = AIRFLOW_COL_NASAL[0]; cG = AIRFLOW_COL_NASAL[1]; cB = AIRFLOW_COL_NASAL[2];
    } else if (jetK > 0) {
      cR = AIRFLOW_COL_LAMINAR[0] + (AIRFLOW_COL_TURB[0] - AIRFLOW_COL_LAMINAR[0]) * jetK;
      cG = AIRFLOW_COL_LAMINAR[1] + (AIRFLOW_COL_TURB[1] - AIRFLOW_COL_LAMINAR[1]) * jetK;
      cB = AIRFLOW_COL_LAMINAR[2] + (AIRFLOW_COL_TURB[2] - AIRFLOW_COL_LAMINAR[2]) * jetK;
    } else {
      cR = AIRFLOW_COL_LAMINAR[0]; cG = AIRFLOW_COL_LAMINAR[1]; cB = AIRFLOW_COL_LAMINAR[2];
    }
    afCol[i * 3] = cR; afCol[i * 3 + 1] = cG; afCol[i * 3 + 2] = cB;
  }

  airflowGeom.attributes.position.needsUpdate = true;
  airflowGeom.attributes.aColor.needsUpdate = true;
  airflowGeom.attributes.aSize.needsUpdate = true;
  airflowGeom.attributes.aAlpha.needsUpdate = true;
}

// ============================================
// BUILD IPA CONSONANT CHART
// ============================================
function buildConsonantChart() {
  const container = document.getElementById('consonant-chart');
  container.innerHTML = '';

  // Header row
  const headerRow = document.createElement('div');
  headerRow.className = 'chart-header-row';
  const emptyHeader = document.createElement('div');
  emptyHeader.className = 'chart-header-cell manner-label';
  headerRow.appendChild(emptyHeader);

  for (const place of IPA_DATA.places) {
    const cell = document.createElement('div');
    cell.className = 'chart-header-cell';
    cell.textContent = place.slice(0, 5);
    cell.title = place;
    headerRow.appendChild(cell);
  }
  container.appendChild(headerRow);

  // Data rows
  for (const manner of IPA_DATA.manners) {
    const row = document.createElement('div');
    row.className = 'chart-row';

    const label = document.createElement('div');
    label.className = 'chart-row-label';
    label.textContent = manner.replace('_', ' ');
    row.appendChild(label);

    for (const place of IPA_DATA.places) {
      const cell = document.createElement('div');
      cell.className = 'chart-cell';

      // Find voiceless and voiced sounds for this cell
      const voiceless = Object.values(IPA_DATA.sounds).find(s =>
        s.type === 'consonant' && s.place === place && s.manner === manner && !s.voiced
      );
      const voiced = Object.values(IPA_DATA.sounds).find(s =>
        s.type === 'consonant' && s.place === place && s.manner === manner && s.voiced
      );

      if (voiceless) {
        const btn = createIPAButton(voiceless.symbol);
        cell.appendChild(btn);
      } else {
        const empty = document.createElement('button');
        empty.className = 'ipa-btn empty';
        empty.disabled = true;
        cell.appendChild(empty);
      }

      if (voiced) {
        const btn = createIPAButton(voiced.symbol);
        cell.appendChild(btn);
      } else {
        const empty = document.createElement('button');
        empty.className = 'ipa-btn empty';
        empty.disabled = true;
        cell.appendChild(empty);
      }

      row.appendChild(cell);
    }
    container.appendChild(row);
  }
}

// ============================================
// BUILD VOWEL QUADRILATERAL
// ============================================
function buildVowelChart() {
  const container = document.getElementById('vowel-chart');
  container.innerHTML = '';

  const quad = document.createElement('div');
  quad.className = 'vowel-quadrilateral';

  // SVG trapezoid outline
  const svgNS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('viewBox', '0 0 100 100');
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;';

  // Trapezoid lines
  const lines = [
    [10, 5, 90, 5],   // close
    [15, 35, 85, 35],  // close-mid
    [20, 60, 80, 60],  // open-mid
    [30, 90, 80, 90],  // open
    [10, 5, 30, 90],   // front
    [50, 5, 50, 90],   // central
    [90, 5, 80, 90],   // back
  ];
  for (const [x1, y1, x2, y2] of lines) {
    const line = document.createElementNS(svgNS, 'line');
    line.setAttribute('x1', x1); line.setAttribute('y1', y1);
    line.setAttribute('x2', x2); line.setAttribute('y2', y2);
    line.setAttribute('stroke', 'var(--border)');
    line.setAttribute('stroke-width', '0.5');
    svg.appendChild(line);
  }

  // Labels
  const labels = [
    { text: 'Close', x: 2, y: 7 },
    { text: 'Close-mid', x: 2, y: 37 },
    { text: 'Open-mid', x: 2, y: 62 },
    { text: 'Open', x: 2, y: 92 },
    { text: 'Front', x: 10, y: 0 },
    { text: 'Central', x: 45, y: 0 },
    { text: 'Back', x: 85, y: 0 },
  ];
  for (const lab of labels) {
    const t = document.createElementNS(svgNS, 'text');
    t.setAttribute('x', lab.x); t.setAttribute('y', lab.y);
    t.setAttribute('fill', 'var(--text-muted)');
    t.setAttribute('font-size', '3.5');
    t.setAttribute('font-family', 'Inter, sans-serif');
    t.textContent = lab.text;
    svg.appendChild(t);
  }

  quad.appendChild(svg);

  // Vowel buttons
  for (const [symbol, pos] of Object.entries(IPA_DATA.vowelPositions)) {
    const sound = IPA_DATA.sounds[symbol];
    if (!sound) continue;

    const btn = document.createElement('button');
    btn.className = 'vowel-btn';
    btn.textContent = symbol;
    btn.dataset.symbol = symbol;
    btn.title = sound.name;
    btn.style.left = pos.x + '%';
    btn.style.top = pos.y + '%';
    btn.addEventListener('click', () => selectSound(symbol));
    quad.appendChild(btn);
  }

  container.appendChild(quad);
}

// ============================================
// BUILD OTHER SOUNDS TAB
// ============================================
function buildOtherChart() {
  const container = document.getElementById('other-chart');
  container.innerHTML = '';

  const sections = [
    { title: 'English R variants', symbols: ['ɹ', 'ɻ', 'ɹ̈'] },
    { title: 'Affricates', symbols: ['t͡ʃ', 'd͡ʒ', 't͡s', 'd͡z', 't͡ɕ', 'd͡ʑ'] },
    { title: 'Co-articulated', symbols: ['w', 'ɥ'] },
    { title: 'Clicks', symbols: ['ʘ', 'ǀ', 'ǃ', 'ǂ', 'ǁ'] },
    { title: 'Implosives', symbols: ['ɓ', 'ɗ', 'ʄ', 'ɠ', 'ʛ'] },
    { title: 'Ejectives', symbols: ['pʼ', 'tʼ', 'kʼ', 'sʼ'] },
  ];

  for (const section of sections) {
    const div = document.createElement('div');
    div.className = 'other-section';
    const h4 = document.createElement('h4');
    h4.textContent = section.title;
    div.appendChild(h4);

    const grid = document.createElement('div');
    grid.className = 'other-grid';
    for (const sym of section.symbols) {
      if (IPA_DATA.sounds[sym]) {
        grid.appendChild(createIPAButton(sym));
      }
    }
    div.appendChild(grid);
    container.appendChild(div);
  }
}

function createIPAButton(symbol) {
  const btn = document.createElement('button');
  btn.className = 'ipa-btn';
  btn.textContent = symbol;
  btn.dataset.symbol = symbol;
  btn.title = IPA_DATA.sounds[symbol]?.name || symbol;
  btn.addEventListener('click', () => selectSound(symbol));
  return btn;
}

// ============================================
// SEARCH
// ============================================
document.getElementById('ipa-search').addEventListener('input', (e) => {
  const query = e.target.value.toLowerCase().trim();
  document.querySelectorAll('.ipa-btn, .vowel-btn').forEach(btn => {
    if (!query) {
      btn.classList.remove('search-match', 'search-hidden');
      return;
    }
    const sym = btn.dataset.symbol;
    const sound = IPA_DATA.sounds[sym];
    if (!sound) {
      btn.classList.add('search-hidden');
      btn.classList.remove('search-match');
      return;
    }
    const searchable = `${sound.symbol} ${sound.name} ${sound.place} ${sound.manner}`.toLowerCase();
    if (searchable.includes(query)) {
      btn.classList.add('search-match');
      btn.classList.remove('search-hidden');
    } else {
      btn.classList.add('search-hidden');
      btn.classList.remove('search-match');
    }
  });
});

// ============================================
// TAB SWITCHING
// ============================================
document.querySelectorAll('.panel-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.panel-tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById(`tab-${tab.dataset.tab}`).classList.add('active');
  });
});

// ============================================
// RECENT SOUNDS
// ============================================
function addToRecent(symbol) {
  state.recentSounds = state.recentSounds.filter(s => s !== symbol);
  state.recentSounds.unshift(symbol);
  if (state.recentSounds.length > 10) state.recentSounds.pop();

  const container = document.getElementById('recent-list');
  container.innerHTML = '';
  for (const sym of state.recentSounds) {
    const btn = document.createElement('button');
    btn.className = 'recent-btn';
    btn.textContent = sym;
    btn.addEventListener('click', () => selectSound(sym));
    container.appendChild(btn);
  }
}

// ============================================
// INFO PANEL
// ============================================
document.getElementById('info-toggle').addEventListener('click', () => {
  state.infoPanelOpen = !state.infoPanelOpen;
  document.getElementById('info-panel').classList.toggle('expanded', state.infoPanelOpen);
});

function updateInfoPanel(sound) {
  document.getElementById('info-symbol').textContent = sound.symbol;
  document.getElementById('info-name').textContent = sound.name;
  document.getElementById('info-place').textContent = sound.place;
  document.getElementById('info-manner').textContent = sound.manner;
  document.getElementById('info-voicing').textContent = sound.voiced ? 'Voiced' : 'Voiceless';

  // Examples
  const exDiv = document.getElementById('examples-content');
  exDiv.innerHTML = '';
  if (sound.examples) {
    const langNames = { en:'EN', fr:'FR', de:'DE', es:'ES', it:'IT', ja:'JA', zh:'ZH', ar:'AR', hi:'HI', ru:'RU', pt:'PT', ko:'KO', hu:'HU', cz:'CZ', pl:'PL', sv:'SV', no:'NO', fi:'FI', nl:'NL', ro:'RO', tr:'TR', he:'HE', sw:'SW', ha:'HA', zu:'ZU', xh:'XH', cy:'CY', sco:'SCO', gr:'GR', am:'AM', ka:'KA', ur:'UR', mr:'MR', ta:'TA' };
    for (const [lang, words] of Object.entries(sound.examples)) {
      if (words.length === 0) continue;
      const row = document.createElement('div');
      row.className = 'example-lang';
      const code = document.createElement('span');
      code.className = 'example-lang-code';
      code.textContent = langNames[lang] || lang.toUpperCase();
      const w = document.createElement('span');
      w.className = 'example-words';
      w.textContent = words.join(', ');
      row.appendChild(code);
      row.appendChild(w);
      exDiv.appendChild(row);
    }
  }

  // Coaching notes
  document.getElementById('coaching-content').textContent = sound.coaching_notes || '';

  // Similar sounds
  const simDiv = document.getElementById('similar-sounds');
  simDiv.innerHTML = '';
  if (sound.similar_sounds) {
    for (const sym of sound.similar_sounds) {
      const btn = document.createElement('button');
      btn.className = 'similar-btn';
      btn.textContent = sym;
      btn.addEventListener('click', () => selectSound(sym));
      simDiv.appendChild(btn);
    }
  }
}

// ============================================
// COMPARISON MODE
// ============================================
function resetCompareState() {
  state.compareSound1 = null;
  state.compareSound2 = null;
  state.compareSlot = 1;
  document.getElementById('compare-symbol-1').textContent = '—';
  document.getElementById('compare-symbol-2').textContent = '—';
  document.getElementById('comparison-diff').textContent = '';
  document.getElementById('compare-slot-1').classList.remove('filled');
  document.getElementById('compare-slot-2').classList.remove('filled');
}

document.getElementById('btn-compare').addEventListener('click', () => {
  state.compareMode = !state.compareMode;
  document.getElementById('btn-compare').classList.toggle('active', state.compareMode);
  document.getElementById('comparison-overlay').style.display = state.compareMode ? 'block' : 'none';
  if (!state.compareMode) resetCompareState();
});

document.getElementById('exit-compare').addEventListener('click', () => {
  state.compareMode = false;
  document.getElementById('btn-compare').classList.remove('active');
  document.getElementById('comparison-overlay').style.display = 'none';
  resetCompareState();
});

function handleCompareSelect(sound) {
  if (state.compareSlot === 1) {
    state.compareSound1 = sound;
    document.getElementById('compare-symbol-1').textContent = sound.symbol;
    document.getElementById('compare-slot-1').classList.add('filled');
    state.compareSlot = 2;
    animateToSound(sound);
  } else {
    state.compareSound2 = sound;
    document.getElementById('compare-symbol-2').textContent = sound.symbol;
    document.getElementById('compare-slot-2').classList.add('filled');
    state.compareSlot = 1;
    animateToSound(sound);
    generateComparisonDiff();
  }
}

function generateComparisonDiff() {
  const s1 = state.compareSound1;
  const s2 = state.compareSound2;
  if (!s1 || !s2) return;

  const diffs = [];
  if (s1.place !== s2.place) diffs.push(`Place: ${s1.place} \u2192 ${s2.place}`);
  if (s1.manner !== s2.manner) diffs.push(`Manner: ${s1.manner} \u2192 ${s2.manner}`);
  if (s1.voiced !== s2.voiced) diffs.push(`Voicing: ${s1.voiced ? 'voiced' : 'voiceless'} \u2192 ${s2.voiced ? 'voiced' : 'voiceless'}`);

  const a1 = s1.articulators, a2 = s2.articulators;
  if (a1.velum?.raised !== a2.velum?.raised) {
    diffs.push(`Velum: ${a1.velum?.raised ? 'raised' : 'lowered'} \u2192 ${a2.velum?.raised ? 'raised' : 'lowered'}`);
  }
  if (Math.abs((a1.lips?.rounding || 0) - (a2.lips?.rounding || 0)) > 0.2) {
    diffs.push(`Lips: ${a1.lips?.rounding > 0.3 ? 'rounded' : 'spread'} \u2192 ${a2.lips?.rounding > 0.3 ? 'rounded' : 'spread'}`);
  }

  document.getElementById('comparison-diff').textContent = diffs.join('\n') || 'Very similar articulations';
}

// ============================================
// PLAYBACK CONTROLS
// ============================================
const btnPlay = document.getElementById('btn-play');
const iconPlay = btnPlay.querySelector('.icon-play');
const iconPause = btnPlay.querySelector('.icon-pause');

function updatePlayButton() {
  iconPlay.style.display = state.isPlaying ? 'none' : 'block';
  iconPause.style.display = state.isPlaying ? 'block' : 'none';
}

btnPlay.addEventListener('click', () => {
  if (state.isPlaying) {
    state.isPlaying = false;
    tweenMgr.cancel();
  } else if (state.currentSound) {
    animateToSound(state.currentSound);
  }
  updatePlayButton();
});

document.getElementById('btn-loop').addEventListener('click', () => {
  state.looping = !state.looping;
  document.getElementById('btn-loop').classList.toggle('active', state.looping);
});

document.getElementById('speed-select').addEventListener('change', (e) => {
  state.speed = parseFloat(e.target.value);
});

document.getElementById('btn-prev').addEventListener('click', () => {
  // Step backward by resetting to neutral. Cancel any in-flight tween first,
  // otherwise its per-frame onUpdate overwrites the neutral pose next frame.
  tweenMgr.cancel();
  state.isPlaying = false;
  updatePlayButton();
  vocalTract.resetToNeutral();
  markShadowsDirty();
});

document.getElementById('btn-next').addEventListener('click', () => {
  // Step forward by jumping to target
  if (state.currentSound) {
    tweenMgr.cancel();
    const art = state.currentSound.articulators;
    {
      const isVowel = state.currentSound.type === 'vowel';
      vocalTract.setTonguePosition({
        tip: (art.tongue_tip && !isVowel) ? { x: art.tongue_tip.x, y: art.tongue_tip.y, contact: !!art.tongue_tip.contact } : undefined,
        blade: (art.tongue_blade && !isVowel) ? { x: art.tongue_blade.x, y: art.tongue_blade.y } : undefined,
        body: art.tongue_body || { height: 0.45, frontness: 0.50 },
        root: art.tongue_root,
      }, state.currentSound.place);
    }
    vocalTract.setLipShape(lipTargetFor(state.currentSound));
    if (art.velum) vocalTract.setVelumHeight(art.velum.height ?? (art.velum.raised ? 1 : 0));
    if (art.jaw) vocalTract.setJawOpenness(art.jaw.openness);
    vocalTract.setVoicing(art.vocal_folds?.vibrating ?? false);
    markShadowsDirty();
  }
});

// ============================================
// ANATOMICAL LABELS
// ============================================
let labelElements = {};
let labelsHiddenApplied = false;   // true once every label has been display:none'd
const _labelScreen = new THREE.Vector3(); // scratch for projection — no per-label clone

function createLabels() {
  const positions = vocalTract.getArticulatorPositions();
  for (const [name, pos] of Object.entries(positions)) {
    const el = document.createElement('div');
    el.className = 'articulator-label';
    el.textContent = name;
    viewport.appendChild(el);
    labelElements[name] = { el, pos3D: pos };
  }
}

function updateLabels() {
  if (!state.labelsVisible) {
    // Hide once, not every frame: repeated style writes are wasted work.
    if (!labelsHiddenApplied) {
      for (const lab of Object.values(labelElements)) lab.el.style.display = 'none';
      labelsHiddenApplied = true;
    }
    return;
  }
  labelsHiddenApplied = false;

  const positions = vocalTract.getArticulatorPositions();
  const vw = viewport.clientWidth;
  const vh = viewport.clientHeight;

  // Pass 1: project each label to screen space, collect the visible ones.
  const placed = [];
  for (const [name, data] of Object.entries(labelElements)) {
    const pos3D = positions[name] || data.pos3D;
    const screenPos = _labelScreen.copy(pos3D).project(camera);
    const x = (screenPos.x * 0.5 + 0.5) * vw;
    const y = (-screenPos.y * 0.5 + 0.5) * vh;

    if (screenPos.z < 1 && x > 0 && x < vw && y > 0 && y < vh) {
      data.el.style.display = 'block';
      // Cache intrinsic size once (text is static — avoids per-frame reflow).
      if (!data.w) {
        data.w = data.el.offsetWidth;
        data.h = data.el.offsetHeight;
      }
      placed.push({ el: data.el, x, y, anchorX: x, anchorY: y, w: data.w, h: data.h });
    } else {
      data.el.style.display = 'none';
    }
  }

  // Pass 2: declutter. Sort top-to-bottom, then push any label that overlaps
  // an already-placed one (whose x-range intersects) downward by a minimum gap.
  // Labels float free of full overlap while staying near their anchor point.
  placed.sort((a, b) => a.y - b.y);
  const GAP = 3;
  const X_PAD = 6;
  for (let i = 1; i < placed.length; i++) {
    const cur = placed[i];
    for (let j = 0; j < i; j++) {
      const prev = placed[j];
      const xOverlap = cur.x < prev.x + prev.w + X_PAD && prev.x < cur.x + cur.w + X_PAD;
      if (xOverlap) {
        const minY = prev.y + prev.h + GAP;
        if (cur.y < minY) cur.y = minY;
      }
    }
  }

  // Pass 3: commit positions; draw a faint connector when a label was nudged
  // away from its anchor so the link to the feature stays clear.
  for (const p of placed) {
    p.el.style.left = p.x + 'px';
    p.el.style.top = p.y + 'px';
    const dy = p.y - p.anchorY;
    if (dy > 6) {
      p.el.style.setProperty('--leader-h', dy + 'px');
      p.el.classList.add('has-leader');
    } else {
      p.el.classList.remove('has-leader');
    }
  }
}

document.getElementById('btn-labels').addEventListener('click', () => {
  state.labelsVisible = !state.labelsVisible;
  document.getElementById('btn-labels').classList.toggle('active', state.labelsVisible);
  updateLabels();
});

// ============================================
// AIRFLOW TOGGLE
// ============================================
document.getElementById('btn-airflow').addEventListener('click', () => {
  state.airflowVisible = !state.airflowVisible;
  document.getElementById('btn-airflow').classList.toggle('active', state.airflowVisible);
  if (airflowParticles) airflowParticles.visible = state.airflowVisible;
  // (Re)build the flow only if it is for a different sound than the one on
  // screen — particles freeze while hidden, so re-seeding the same sound on
  // every toggle would just stack a second stream on top of the first.
  if (state.airflowVisible && state.currentSound
      && (!airflowFlow || airflowFlow.symbol !== state.currentSound.symbol)) {
    updateAirflow(state.currentSound);
  }
});

// (Skin toggle removed — skin always visible)

// ============================================
// TEETH X-RAY TOGGLE — translucent teeth so you can see the articulation
// behind them; toggle off for full solid teeth.
// ============================================
document.getElementById('btn-teeth')?.addEventListener('click', () => {
  const on = vocalTract.toggleTeethXray();
  document.getElementById('btn-teeth')?.classList.toggle('active', on);
  markShadowsDirty(); // translucent teeth stop writing depth → shadow changes
});

// ============================================
// CROSS-SECTION TOGGLE
// ============================================
let crossSectionMode = false;
document.getElementById('btn-cross-section')?.addEventListener('click', () => {
  crossSectionMode = !crossSectionMode;
  vocalTract.setViewMode(crossSectionMode ? 'crossSection' : '3d');
  document.getElementById('btn-cross-section')?.classList.toggle('active', crossSectionMode);
  markShadowsDirty(); // whole scene was rebuilt
});

// ============================================
// PLAY SOUND BUTTON
// ============================================
document.getElementById('btn-play-sound').addEventListener('click', () => {
  playCurrentSound();
});

// ============================================
// MUTE TOGGLE
// ============================================
document.getElementById('btn-mute').addEventListener('click', () => {
  state.muted = !state.muted;
  const btnMute = document.getElementById('btn-mute');
  btnMute.querySelector('.icon-unmuted').style.display = state.muted ? 'none' : 'block';
  btnMute.querySelector('.icon-muted').style.display = state.muted ? 'block' : 'none';
  btnMute.classList.toggle('active', state.muted);
});

// ============================================
// ADJUST PANEL (Manual slider controls)
// ============================================
let adjustPanelOpen = false;

document.getElementById('btn-adjust').addEventListener('click', () => {
  adjustPanelOpen = !adjustPanelOpen;
  document.getElementById('btn-adjust').classList.toggle('active', adjustPanelOpen);
  document.getElementById('adjust-panel').classList.toggle('expanded', adjustPanelOpen);
});

// Reset button — restore sliders to current sound
document.getElementById('adjust-reset').addEventListener('click', () => {
  if (state.currentSound) {
    updateSlidersFromSound(state.currentSound);
  }
});

// Read sliders and apply tongue position
function applyTongueFromSliders() {
  const height = parseFloat(document.getElementById('sl-body-height').value);
  const frontness = parseFloat(document.getElementById('sl-body-front').value);
  const tipX = parseFloat(document.getElementById('sl-tip-x').value);
  const tipY = parseFloat(document.getElementById('sl-tip-y').value);
  const rootAdv = parseFloat(document.getElementById('sl-root-adv').value);

  const params = {
    body: { height, frontness },
    root: { advancement: rootAdv },
  };

  // Only pass tip if the user has moved the sliders from default vowel position.
  // For vowels, tip is auto-derived from body — explicit tip overrides that.
  const tipDefault = tipX === 0.5 && tipY === 0.35;
  if (!tipDefault) {
    params.tip = { x: tipX, y: tipY };
  }

  vocalTract.setTonguePosition(params);
}

// Apply lip sliders
function applyLipsFromSliders() {
  vocalTract.setLipShape({
    rounding: parseFloat(document.getElementById('sl-lip-round').value),
    openness: parseFloat(document.getElementById('sl-lip-open').value),
    protrusion: parseFloat(document.getElementById('sl-lip-prot').value),
    spread: parseFloat(document.getElementById('sl-lip-spread').value),
  });
}

// Slider input handlers — real-time updates
const sliderHandlers = {
  'sl-body-height': { val: 'sv-body-height', apply: applyTongueFromSliders },
  'sl-body-front':  { val: 'sv-body-front',  apply: applyTongueFromSliders },
  'sl-tip-x':       { val: 'sv-tip-x',       apply: applyTongueFromSliders },
  'sl-tip-y':       { val: 'sv-tip-y',        apply: applyTongueFromSliders },
  'sl-root-adv':    { val: 'sv-root-adv',     apply: applyTongueFromSliders },
  'sl-lip-round':   { val: 'sv-lip-round',    apply: applyLipsFromSliders },
  'sl-lip-open':    { val: 'sv-lip-open',     apply: applyLipsFromSliders },
  'sl-lip-prot':    { val: 'sv-lip-prot',     apply: applyLipsFromSliders },
  'sl-lip-spread':  { val: 'sv-lip-spread',   apply: applyLipsFromSliders },
  'sl-jaw':         { val: 'sv-jaw',          apply: () => vocalTract.setJawOpenness(parseFloat(document.getElementById('sl-jaw').value)) },
  'sl-velum':       { val: 'sv-velum',        apply: () => vocalTract.setVelumHeight(parseFloat(document.getElementById('sl-velum').value)) },
};

for (const [sliderId, handler] of Object.entries(sliderHandlers)) {
  document.getElementById(sliderId).addEventListener('input', () => {
    const val = parseFloat(document.getElementById(sliderId).value);
    document.getElementById(handler.val).textContent = val.toFixed(2);
    handler.apply();
    markShadowsDirty(); // every slider moves geometry outside the tween loop
  });
}

// Update sliders to reflect a sound's articulators
function updateSlidersFromSound(sound) {
  const art = sound.articulators;

  // Tongue body
  const bodyH = art.tongue_body?.height ?? 0.5;
  const bodyF = art.tongue_body?.frontness ?? 0.5;
  setSlider('sl-body-height', bodyH);
  setSlider('sl-body-front', bodyF);

  // Tongue tip — defaults if not specified (vowels)
  const isVowel = sound.type === 'vowel';
  setSlider('sl-tip-x', (!isVowel && art.tongue_tip) ? art.tongue_tip.x : 0.5);
  setSlider('sl-tip-y', (!isVowel && art.tongue_tip) ? art.tongue_tip.y : 0.35);

  // Tongue root
  setSlider('sl-root-adv', art.tongue_root?.advancement ?? 0.5);

  // Lips
  setSlider('sl-lip-round', art.lips?.rounding ?? 0.1);
  setSlider('sl-lip-open', art.lips?.openness ?? 0.3);
  setSlider('sl-lip-prot', art.lips?.protrusion ?? 0);
  setSlider('sl-lip-spread', art.lips?.spread ?? 0.5);

  // Jaw, Velum
  setSlider('sl-jaw', art.jaw?.openness ?? 0.2);
  setSlider('sl-velum', art.velum?.height ?? (art.velum?.raised ? 1 : 0));
}

function setSlider(id, value) {
  const el = document.getElementById(id);
  el.value = value;
  const valId = id.replace('sl-', 'sv-');
  document.getElementById(valId).textContent = parseFloat(value).toFixed(2);
}

// ============================================
// DARK/LIGHT MODE
// ============================================
document.getElementById('btn-theme').addEventListener('click', () => {
  state.darkMode = !state.darkMode;
  document.body.classList.toggle('dark-mode', state.darkMode);
  document.body.classList.toggle('light-mode', !state.darkMode);
  renderer.setClearColor(state.darkMode ? 0x0B1221 : 0xf5f0ea);
});

// ============================================
// ABOUT MODAL
// ============================================
document.getElementById('btn-about').addEventListener('click', () => {
  document.getElementById('about-modal').style.display = 'flex';
});

document.getElementById('about-close').addEventListener('click', () => {
  document.getElementById('about-modal').style.display = 'none';
});

document.getElementById('about-modal').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) {
    document.getElementById('about-modal').style.display = 'none';
  }
});

// ============================================
// DRAGGABLE ARTICULATOR HANDLES
// ============================================
const HANDLE_CONFIG = {
  body:  { color: 0xe8a040, radius: 0.055 },  // gold — tongue body
  tip:   { color: 0xe06060, radius: 0.055 },  // red — tongue tip
  root:  { color: 0x8060c0, radius: 0.050 },  // purple — tongue root
  lips:  { color: 0xc46868, radius: 0.060 },  // pink — lips
  jaw:   { color: 0x90a0b0, radius: 0.055 },  // gray — jaw
  velum: { color: 0xc490b0, radius: 0.050 },  // mauve — velum
};

const handleMeshes = {};
// Invisible hit-test spheres (larger) used for proximity hover detection
const handleHitMeshes = {};
for (const [key, cfg] of Object.entries(HANDLE_CONFIG)) {
  // Visible handle (shown only on hover/drag)
  const geo = new THREE.SphereGeometry(cfg.radius, 16, 16);
  const mat = new THREE.MeshBasicMaterial({ color: cfg.color, transparent: true, opacity: 0.85, depthTest: false });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.visible = false;  // hidden by default — shown on hover
  mesh.renderOrder = 999;
  mesh.userData.handleKey = key;
  mesh.userData.baseOpacity = 0.85;
  scene.add(mesh);
  handleMeshes[key] = mesh;

  // Invisible hit-target (3x larger for easy hover detection)
  const hitGeo = new THREE.SphereGeometry(cfg.radius * 3.0, 8, 8);
  const hitMat = new THREE.MeshBasicMaterial({ visible: false });
  const hitMesh = new THREE.Mesh(hitGeo, hitMat);
  hitMesh.userData.handleKey = key;
  hitMesh.raycast = THREE.Mesh.prototype.raycast; // ensure raycasting works even though invisible
  scene.add(hitMesh);
  handleHitMeshes[key] = hitMesh;
}

// Position all handles based on current articulator state
const _velumHandlePos = new THREE.Vector3();
function updateHandlePositions() {
  const t = vocalTract.currentTongue;
  if (!t) return;
  // Tongue handles — offset up slightly so they sit on top of the surface
  handleMeshes.body.position.set(t.body.x, t.body.y + 0.14, 0);
  handleMeshes.tip.position.set(t.tip.x, t.tip.y + 0.05, 0);
  handleMeshes.root.position.set(t.root.x, t.root.y, 0);
  // Lips — at lip center, accounting for jaw drop
  const prot = vocalTract.currentLips.protrusion;
  const jawDrop = vocalTract.currentJawOpen * 0.28;
  handleMeshes.lips.position.set(1.30 + prot * 0.12, 0.40 - jawDrop * 0.3, 0);
  // Jaw — at front-center of jaw
  handleMeshes.jaw.position.set(0.80, 0.05 - jawDrop, 0);
  // Velum — track rotation via localToWorld
  _velumHandlePos.set(-0.38, 0.51, 0);
  if (vocalTract.velumGroup) {
    vocalTract.velumGroup.localToWorld(_velumHandlePos);
    _velumHandlePos.z = 0;
  }
  handleMeshes.velum.position.copy(_velumHandlePos);
  // Sync hit-test spheres to same positions
  for (const key of Object.keys(handleMeshes)) {
    handleHitMeshes[key].position.copy(handleMeshes[key].position);
  }
}

// Raycasting for drag & hover interaction
const raycaster = new THREE.Raycaster();
const mouse = new THREE.Vector2();
let dragHandle = null;
let activeDragPlane = null;
let dragIntersection = new THREE.Vector3();
let hoveredHandle = null;

function clamp01(v) { return Math.max(0, Math.min(1, v)); }

function getPointerNDC(e) {
  const rect = canvas.getBoundingClientRect();
  mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
  mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
}

function getDragPlane(handlePos) {
  const camDir = new THREE.Vector3();
  camera.getWorldDirection(camDir);
  const plane = new THREE.Plane();
  plane.setFromNormalAndCoplanarPoint(camDir, handlePos);
  return plane;
}

function onHandlePointerDown(e) {
  getPointerNDC(e);
  raycaster.setFromCamera(mouse, camera);
  // Raycast against invisible hit spheres for larger click target
  const hits = raycaster.intersectObjects(Object.values(handleHitMeshes));
  if (hits.length > 0) {
    const key = hits[0].object.userData.handleKey;
    dragHandle = handleMeshes[key];
    dragHandle.visible = true;
    dragHandle.material.opacity = 1.0;
    dragHandle.scale.setScalar(1.4);
    canvas.style.cursor = 'grabbing';
    controls.enabled = false;
    activeDragPlane = getDragPlane(dragHandle.position);
    // Capture so the release reaches us even when the pointer leaves the
    // canvas mid-drag (OrbitControls captures too, but only while enabled).
    try { canvas.setPointerCapture(e.pointerId); } catch (_) { /* not all inputs support capture */ }
    e.preventDefault();
  }
}

function onHandlePointerMove(e) {
  // Hover detection (when not dragging)
  if (!dragHandle) {
    getPointerNDC(e);
    raycaster.setFromCamera(mouse, camera);
    // Raycast against invisible hit spheres for proximity hover
    const hits = raycaster.intersectObjects(Object.values(handleHitMeshes));
    const hitKey = hits.length > 0 ? hits[0].object.userData.handleKey : null;
    const newHover = hitKey ? handleMeshes[hitKey] : null;
    if (newHover !== hoveredHandle) {
      if (hoveredHandle) {
        hoveredHandle.visible = false;  // hide when mouse leaves
        hoveredHandle.scale.setScalar(1.0);
      }
      if (newHover) {
        newHover.visible = true;  // show on hover
        newHover.material.opacity = 1.0;
        newHover.scale.setScalar(1.15);
        canvas.style.cursor = 'grab';
      } else {
        canvas.style.cursor = '';
      }
      hoveredHandle = newHover;
    }
    return;
  }

  // Drag logic
  getPointerNDC(e);
  raycaster.setFromCamera(mouse, camera);
  if (!raycaster.ray.intersectPlane(activeDragPlane, dragIntersection)) return;
  markShadowsDirty(); // the handle is about to move geometry

  const key = dragHandle.userData.handleKey;

  if (key === 'body') {
    const f = clamp01((dragIntersection.x + 0.35) / 0.85);
    const h = clamp01((dragIntersection.y + 0.25) / 0.78);
    setSlider('sl-body-height', h);
    setSlider('sl-body-front', f);
    applyTongueFromSliders();
  } else if (key === 'tip') {
    const px = clamp01((dragIntersection.x + 0.10) / 1.25);
    const py = clamp01((dragIntersection.y + 0.15) / 0.66);
    setSlider('sl-tip-x', px);
    setSlider('sl-tip-y', py);
    applyTongueFromSliders();
  } else if (key === 'root') {
    const adv = clamp01((dragIntersection.x + 0.58) / 0.25);
    setSlider('sl-root-adv', adv);
    applyTongueFromSliders();
  } else if (key === 'lips') {
    const prot = clamp01((dragIntersection.x - 1.30) / 0.12);
    const open = clamp01((0.50 - dragIntersection.y) / 0.30);
    setSlider('sl-lip-prot', prot);
    setSlider('sl-lip-open', open);
    applyLipsFromSliders();
  } else if (key === 'jaw') {
    const openness = clamp01((0.05 - dragIntersection.y) / 0.28);
    setSlider('sl-jaw', openness);
    vocalTract.setJawOpenness(openness);
  } else if (key === 'velum') {
    const height = clamp01((dragIntersection.y - 0.20) / 0.35);
    setSlider('sl-velum', height);
    vocalTract.setVelumHeight(height);
  }

  e.preventDefault();
}

function onHandlePointerUp(e) {
  if (dragHandle) {
    dragHandle.scale.setScalar(1.0);
    dragHandle.visible = false;  // hide after releasing
    canvas.style.cursor = '';
    hoveredHandle = null;
    dragHandle = null;
    activeDragPlane = null;
    controls.enabled = true;
    if (e && canvas.hasPointerCapture?.(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
  }
}

// Pointer events cover mouse, pen and touch (OrbitControls sets touch-action:
// none on the canvas), so no separate touch listeners — registering both used
// to run every down/move handler twice on touch screens. pointercancel (the
// browser taking over a gesture, a lost stylus) ends the drag like a release.
canvas.addEventListener('pointerdown', onHandlePointerDown);
canvas.addEventListener('pointermove', onHandlePointerMove);
canvas.addEventListener('pointerup', onHandlePointerUp);
canvas.addEventListener('pointercancel', onHandlePointerUp);

// ============================================
// RESIZE HANDLER
// ============================================
// Seeded from the real viewport so the initial onResize() call below does not
// read as an orientation change and re-tween the camera.
let lastAspect = viewport.clientWidth / viewport.clientHeight;
function onResize() {
  const w = viewport.clientWidth;
  const h = viewport.clientHeight;
  const newAspect = w / h;
  const aspectChanged = Math.abs(newAspect - lastAspect) > 0.3;
  lastAspect = newAspect;

  camera.aspect = newAspect;

  // Widen FOV on portrait/narrow screens to fit the 3D model
  if (newAspect < 1 && w < 500) {
    // Phone portrait: aggressive FOV widening
    camera.fov = Math.min(45 / newAspect * 0.65, 75);
  } else if (newAspect < 1) {
    // Tablet portrait: gentle FOV widening
    camera.fov = Math.min(45 / newAspect * 0.5, 55);
  } else if (w < 768) {
    camera.fov = 50;
  } else {
    camera.fov = 45;
  }

  camera.updateProjectionMatrix();
  // Re-read devicePixelRatio: it changes when the window moves between a 1x and
  // a 2x (Retina) display, otherwise the canvas renders at the stale DPR (blurry
  // or wastefully supersampled) and airflow point sizes scale for the wrong DPR.
  const dpr = Math.min(window.devicePixelRatio, 2);
  renderer.setPixelRatio(dpr);
  renderer.setSize(w, h);
  if (airflowParticles) airflowParticles.material.uniforms.uPix.value = dpr;

  // Re-apply camera view if aspect ratio changed significantly (e.g. orientation change)
  if (aspectChanged && state.currentView) {
    setCameraView(state.currentView);
  }
}
window.addEventListener('resize', onResize);
window.addEventListener('orientationchange', () => {
  setTimeout(onResize, 150);
});

// ============================================
// MOBILE VIEW TOGGLE
// ============================================
const mobileToggle = document.getElementById('mobile-view-toggle');
let currentMobileView = '3d';

function switchMobileView(view) {
  if (!mobileToggle) return;
  const toggleBtns = mobileToggle.querySelectorAll('.mobile-toggle-btn');
  toggleBtns.forEach(b => b.classList.remove('active'));
  const targetBtn = mobileToggle.querySelector(`[data-mobile-view="${view}"]`);
  if (targetBtn) targetBtn.classList.add('active');

  if (view === '3d') {
    viewport.classList.remove('mobile-hidden');
    document.getElementById('ipa-panel').classList.remove('mobile-visible');
    setTimeout(onResize, 50);
  } else {
    viewport.classList.add('mobile-hidden');
    document.getElementById('ipa-panel').classList.add('mobile-visible');
  }
  currentMobileView = view;
}
window.switchMobileView = switchMobileView;

if (mobileToggle) {
  const toggleBtns = mobileToggle.querySelectorAll('.mobile-toggle-btn');
  toggleBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      switchMobileView(btn.dataset.mobileView);
    });
  });

  // Swipe gesture support for switching views
  let touchStartX = 0;
  let touchStartY = 0;
  let touchStartTime = 0;
  const mainContent = document.getElementById('main-content');

  mainContent.addEventListener('touchstart', (e) => {
    touchStartX = e.touches[0].clientX;
    touchStartY = e.touches[0].clientY;
    touchStartTime = Date.now();
  }, { passive: true });

  mainContent.addEventListener('touchend', (e) => {
    const touchEndX = e.changedTouches[0].clientX;
    const touchEndY = e.changedTouches[0].clientY;
    const dx = touchEndX - touchStartX;
    const dy = touchEndY - touchStartY;
    const dt = Date.now() - touchStartTime;

    // Only register as swipe if: horizontal distance > 80px, more horizontal than vertical, under 400ms
    if (Math.abs(dx) > 80 && Math.abs(dx) > Math.abs(dy) * 1.5 && dt < 400) {
      if (dx < 0 && currentMobileView === '3d') {
        // Swipe left: show charts
        switchMobileView('chart');
      } else if (dx > 0 && currentMobileView === 'chart') {
        // Swipe right: show 3D
        switchMobileView('3d');
      }
    }
  }, { passive: true });
}

// ============================================
// ANIMATION LOOP
// ============================================
const clock = new THREE.Clock();
let loopCooldown = 0;

function animate() {
  requestAnimationFrame(animate);
  const dt = clock.getDelta();

  // Camera animation
  if (cameraAnimating) {
    cameraT += dt * 2;
    const t = Math.min(cameraT, 1);
    const ease = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    camera.position.lerpVectors(cameraStartPos, cameraEndPos, ease);
    controls.target.lerpVectors(cameraStartTarget, cameraEndTarget, ease);
    if (t >= 1) cameraAnimating = false;
  }

  controls.update();
  tweenMgr.update(dt);
  vocalTract.update(dt);
  animateAirflow(dt);
  updateLabels();
  updateHandlePositions();

  // Refresh shadows only while the scene is in motion (camera move, articulation
  // tween, or voicing). When idle, the last shadow map is reused — no wasted pass.
  if (cameraAnimating || tweenMgr.active || vocalTract.voicingActive) {
    dirLight.shadow.needsUpdate = true;
  }

  // Loop handling
  if (state.looping && state.currentSound && !tweenMgr.active) {
    loopCooldown += dt;
    if (loopCooldown > 1.5 / state.speed) {
      loopCooldown = 0;
      vocalTract.resetToNeutral();
      setTimeout(() => {
        if (state.looping && state.currentSound) {
          animateToSound(state.currentSound);
        }
      }, 500 / state.speed);
    }
  } else {
    loopCooldown = 0;
  }

  // Update playing state
  if (state.isPlaying && !tweenMgr.active && !state.looping) {
    state.isPlaying = false;
    updatePlayButton();
  }

  renderer.render(scene, camera);
}

// ============================================
// AUDIO PLAYBACK
// ============================================
// IPA audio from University of British Columbia / Wiktionary commons
// Maps IPA symbols to filenames on Wikimedia Commons
const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
const audioCache = {};

// Wikimedia Commons IPA audio file naming convention
const LOCAL_AUDIO_DIR = 'sounds/';
const WIKI_AUDIO_BASE = 'https://upload.wikimedia.org/wikipedia/commons/';

// Map IPA symbols to known Wikimedia Commons audio paths
// These are curated paths to actual hosted OGG files
const IPA_AUDIO_MAP = {
  // Plosives
  'p': '5/51/Voiceless_bilabial_plosive.ogg',
  'b': '2/2c/Voiced_bilabial_plosive.ogg',
  't': '0/02/Voiceless_alveolar_plosive.ogg',
  'd': '0/01/Voiced_alveolar_plosive.ogg',
  'ʈ': 'b/b0/Voiceless_retroflex_plosive.ogg',
  'ɖ': '2/27/Voiced_retroflex_stop.oga',
  'c': '5/5d/Voiceless_palatal_plosive.ogg',
  'ɟ': '1/1d/Voiced_palatal_plosive.ogg',
  'k': 'e/e3/Voiceless_velar_plosive.ogg',
  'ɡ': 'b/b4/Voiced_velar_plosive.ogg',
  'q': '1/19/Voiceless_uvular_plosive.ogg',
  'ɢ': 'b/b6/Voiced_uvular_stop.oga',
  'ʔ': '4/4d/Glottal_stop.ogg',

  // Nasals
  'm': 'a/a9/Bilabial_nasal.ogg',
  'ɱ': '1/18/Labiodental_nasal.ogg',
  'n': '2/29/Alveolar_nasal.ogg',
  'ɳ': 'a/af/Retroflex_nasal.ogg',
  'ɲ': '4/46/Palatal_nasal.ogg',
  'ŋ': '3/39/Velar_nasal.ogg',
  'ɴ': '3/3e/Uvular_nasal.ogg',

  // Trills
  'ʙ': 'e/e7/Bilabial_trill.ogg',
  'r': 'c/ce/Alveolar_trill.ogg',
  'ʀ': 'c/cb/Uvular_trill.ogg',

  // Taps
  'ⱱ': '2/2c/Labiodental_flap.ogg',
  'ɾ': 'a/a0/Alveolar_tap.ogg',
  'ɽ': '8/87/Retroflex_flap.ogg',

  // Fricatives
  'ɸ': '4/41/Voiceless_bilabial_fricative.ogg',
  'β': '3/37/Voiced_bilabial_fricative.ogg',
  'f': '3/33/Voiceless_labiodental_fricative.ogg',
  'v': '8/85/Voiced_labiodental_fricative.ogg',
  'θ': '8/80/Voiceless_dental_fricative.ogg',
  'ð': '6/6a/Voiced_dental_fricative.ogg',
  's': 'a/ac/Voiceless_alveolar_sibilant.ogg',
  'z': 'c/c0/Voiced_alveolar_sibilant.ogg',
  'ʃ': 'c/cc/Voiceless_palato-alveolar_sibilant.ogg',
  'ʒ': '3/30/Voiced_palato-alveolar_sibilant.ogg',
  'ʂ': 'b/b1/Voiceless_retroflex_sibilant.ogg',
  'ʐ': '7/7f/Voiced_retroflex_sibilant.ogg',
  'ç': 'a/ab/Voiceless_palatal_fricative.ogg',
  'ʝ': 'a/ac/Voiced_palatal_fricative.ogg',
  'x': '0/0f/Voiceless_velar_fricative.ogg',
  'ɣ': '4/47/Voiced_velar_fricative.ogg',
  'χ': 'c/c8/Voiceless_uvular_fricative.ogg',
  'ʁ': 'a/af/Voiced_uvular_fricative.ogg',
  'ħ': 'b/b2/Voiceless_pharyngeal_fricative.ogg',
  'ʕ': 'c/cd/Voiced_pharyngeal_fricative.ogg',
  'h': 'd/da/Voiceless_glottal_fricative.ogg',
  'ɦ': 'e/e2/Voiced_glottal_fricative.ogg',

  // Lateral fricatives
  'ɬ': 'e/ea/Voiceless_alveolar_lateral_fricative.ogg',
  'ɮ': '6/6f/Voiced_alveolar_lateral_fricative.ogg',

  // Approximants
  'ʋ': 'e/ee/Labiodental_approximant.ogg',
  'ɹ': '1/1f/Alveolar_approximant.ogg',
  'ɻ': 'd/d2/Retroflex_approximant.ogg',
  'j': 'e/e8/Palatal_approximant.ogg',
  'ɰ': '5/5c/Voiced_velar_approximant.ogg',

  // Lateral approximants
  'l': 'b/bc/Alveolar_lateral_approximant.ogg',
  'ɭ': 'd/d1/Retroflex_lateral_approximant.ogg',
  'ʎ': 'd/d9/Palatal_lateral_approximant.ogg',
  'ʟ': 'd/d3/Velar_lateral_approximant.ogg',

  // Co-articulated
  'w': 'f/f2/Voiced_labio-velar_approximant.ogg',
  // Bare filename = bundled-only (Commons has no plain ogg for ɥ; local file is
  // LL-Q150 (fra)-WikiLucas00-IPA ɥ.wav renamed to match our convention)
  'ɥ': 'Voiced_labial-palatal_approximant.wav',

  // Vowels
  'i': '9/91/Close_front_unrounded_vowel.ogg',
  'y': 'e/ea/Close_front_rounded_vowel.ogg',
  'ɨ': '5/53/Close_central_unrounded_vowel.ogg',
  'ʉ': '6/66/Close_central_rounded_vowel.ogg',
  'ɯ': 'e/e8/Close_back_unrounded_vowel.ogg',
  'u': '5/5d/Close_back_rounded_vowel.ogg',
  'ɪ': '4/4c/Near-close_near-front_unrounded_vowel.ogg',
  'ʏ': 'e/e3/Near-close_near-front_rounded_vowel.ogg',
  'ʊ': 'd/d5/Near-close_near-back_rounded_vowel.ogg',
  'e': '6/6c/Close-mid_front_unrounded_vowel.ogg',
  'ø': '5/53/Close-mid_front_rounded_vowel.ogg',
  'ɘ': '6/60/Close-mid_central_unrounded_vowel.ogg',
  'ɵ': 'b/b5/Close-mid_central_rounded_vowel.ogg',
  'ɤ': '2/26/Close-mid_back_unrounded_vowel.ogg',
  'o': '8/84/Close-mid_back_rounded_vowel.ogg',
  'ə': 'd/d9/Mid-central_vowel.ogg',
  'ɛ': '7/71/Open-mid_front_unrounded_vowel.ogg',
  'œ': '0/00/Open-mid_front_rounded_vowel.ogg',
  'ɜ': '0/01/Open-mid_central_unrounded_vowel.ogg',
  'ɞ': 'd/d9/Open-mid_central_rounded_vowel.ogg',
  'ʌ': '9/92/Open-mid_back_unrounded_vowel.ogg',
  'ɔ': '0/02/Open-mid_back_rounded_vowel.ogg',
  'æ': 'c/c9/Near-open_front_unrounded_vowel.ogg',
  'ɐ': '2/22/Near-open_central_unrounded_vowel.ogg',
  'a': '0/0e/PR-open_front_unrounded_vowel.ogg',
  'ɶ': 'c/c1/Open_front_rounded_vowel.ogg',
  'ɑ': 'e/e5/Open_back_unrounded_vowel.ogg',
  'ɒ': '3/31/PR-open_back_rounded_vowel.ogg',
};

async function playIPASound(symbol) {
  // Mute check
  if (state.muted) return false;

  // Resume AudioContext if suspended (browser autoplay policy)
  if (audioCtx.state === 'suspended') {
    await audioCtx.resume();
  }

  const relPath = IPA_AUDIO_MAP[symbol];
  if (!relPath) {
    // No audio available for this symbol
    return false;
  }

  // Extract filename from Wikimedia path (e.g. '5/51/Voiceless_bilabial_plosive.ogg' → 'Voiceless_bilabial_plosive.ogg')
  const filename = relPath.split('/').pop();
  const localUrl = LOCAL_AUDIO_DIR + filename;
  const wikiUrl = WIKI_AUDIO_BASE + relPath;

  try {
    let buffer = audioCache[symbol];
    if (!buffer) {
      // Try local bundled audio first, fall back to Wikimedia.
      // Decode inside the try so a missing, empty, or corrupt local file
      // (e.g. iCloud-truncated 0-byte copies) also triggers the fallback.
      try {
        const response = await fetch(localUrl);
        if (!response.ok) throw new Error('local not found');
        const arrayBuffer = await response.arrayBuffer();
        if (arrayBuffer.byteLength === 0) throw new Error('local file empty');
        buffer = await audioCtx.decodeAudioData(arrayBuffer);
      } catch (_) {
        if (!relPath.includes('/')) return false; // bundled-only, no Commons copy
        const response = await fetch(wikiUrl);
        if (!response.ok) return false;
        const arrayBuffer = await response.arrayBuffer();
        buffer = await audioCtx.decodeAudioData(arrayBuffer);
      }
      audioCache[symbol] = buffer;
    }

    const source = audioCtx.createBufferSource();
    source.buffer = buffer;
    source.connect(audioCtx.destination);
    source.start(0);
    return true;
  } catch (e) {
    console.warn('Audio playback failed for', symbol, e);
    return false;
  }
}

// Add audio playback to sound selection
function playCurrentSound() {
  if (state.currentSound) {
    playIPASound(state.currentSound.symbol);
  }
}

// ============================================
// ACCENTS & DIALECTS (hidden feature — triple-click logo to reveal)
// ============================================

let activeAccentId = null;

function getDifficultyInfo(level) {
  const labels = ['Reference', 'Easy', 'Moderate', 'Challenging', 'Advanced', 'Expert'];
  const colors = ['#7a8290', '#64b478', '#b89d65', '#d4a04a', '#d47840', '#e06060'];
  return { label: labels[level] || 'Unknown', color: colors[level] || '#7a8290', dots: level };
}

function buildAccentGrid() {
  const container = document.getElementById('accent-grid');
  if (!container || typeof ACCENT_DATA === 'undefined') return;
  container.innerHTML = '';

  for (const [id, accent] of Object.entries(ACCENT_DATA.accents)) {
    const card = document.createElement('div');
    card.className = 'accent-card';
    card.dataset.accentId = id;

    // Header row with name and difficulty
    const headerRow = document.createElement('div');
    headerRow.className = 'accent-card-header';

    const name = document.createElement('h3');
    name.className = 'accent-card-name';
    name.textContent = accent.name;
    headerRow.appendChild(name);

    if (accent.difficulty > 0) {
      const diff = getDifficultyInfo(accent.difficulty);
      const badge = document.createElement('span');
      badge.className = 'accent-card-difficulty';
      badge.style.color = diff.color;
      badge.textContent = '\u25CF'.repeat(diff.dots) + '\u25CB'.repeat(5 - diff.dots);
      badge.title = diff.label;
      headerRow.appendChild(badge);
    } else {
      const refBadge = document.createElement('span');
      refBadge.className = 'accent-card-ref-badge';
      refBadge.textContent = 'REF';
      headerRow.appendChild(refBadge);
    }
    card.appendChild(headerRow);

    const region = document.createElement('p');
    region.className = 'accent-card-region';
    region.textContent = accent.region;
    card.appendChild(region);

    // Short description preview
    const desc = document.createElement('p');
    desc.className = 'accent-card-desc';
    desc.textContent = accent.description.length > 120 ? accent.description.substring(0, 120) + '...' : accent.description;
    card.appendChild(desc);

    const tags = document.createElement('div');
    tags.className = 'accent-card-tags';
    accent.keyFeatures.slice(0, 3).forEach(f => {
      const tag = document.createElement('span');
      tag.className = 'accent-tag';
      tag.textContent = f.label;
      tags.appendChild(tag);
    });
    card.appendChild(tags);

    // Stats row
    const stats = document.createElement('div');
    stats.className = 'accent-card-stats';
    const lexCount = accent.lexicalSets ? Object.keys(accent.lexicalSets).length : 0;
    const exerciseCount = accent.exercises ? accent.exercises.length : 0;
    stats.innerHTML = `<span>${lexCount} lexical sets</span><span>${exerciseCount} exercise${exerciseCount !== 1 ? 's' : ''}</span>`;
    card.appendChild(stats);

    card.addEventListener('click', () => showAccentDetail(id));
    container.appendChild(card);
  }
}

function showAccentDetail(accentId) {
  const accent = ACCENT_DATA.accents[accentId];
  if (!accent) return;
  activeAccentId = accentId;

  document.getElementById('accent-grid').style.display = 'none';
  const detailEl = document.getElementById('accent-detail');
  detailEl.style.display = 'block';
  // Scroll to top of detail view
  const backBtn = document.getElementById('accent-back');
  if (backBtn) backBtn.scrollIntoView({ behavior: 'instant' });

  document.getElementById('accent-name').textContent = accent.name;
  document.getElementById('accent-region').textContent = accent.region;
  document.getElementById('accent-description').textContent = accent.description;

  // Difficulty badge
  const diffBadge = document.getElementById('accent-difficulty');
  if (accent.difficulty > 0) {
    const diff = getDifficultyInfo(accent.difficulty);
    diffBadge.textContent = diff.label;
    diffBadge.style.background = diff.color + '22';
    diffBadge.style.color = diff.color;
    diffBadge.style.borderColor = diff.color + '44';
    diffBadge.style.display = '';
  } else {
    diffBadge.textContent = 'Reference';
    diffBadge.style.background = 'rgba(122,130,144,0.15)';
    diffBadge.style.color = '#7a8290';
    diffBadge.style.borderColor = 'rgba(122,130,144,0.3)';
    diffBadge.style.display = '';
  }

  // Key features
  const featEl = document.getElementById('accent-features');
  featEl.innerHTML = '';
  accent.keyFeatures.forEach(f => {
    const div = document.createElement('div');
    div.className = 'accent-feature';
    div.innerHTML = `<span class="accent-feature-label">${f.label}</span><span class="accent-feature-desc">${f.description}</span>`;
    featEl.appendChild(div);
  });

  // === Lexical Sets (Wells) ===
  const lexEl = document.getElementById('accent-lexical-sets');
  lexEl.innerHTML = '';
  if (accent.lexicalSets) {
    const lexGroups = [
      { title: 'Short Vowels', sets: ['KIT', 'DRESS', 'TRAP', 'LOT', 'STRUT', 'FOOT'] },
      { title: 'Long Vowels', sets: ['BATH', 'CLOTH', 'NURSE', 'FLEECE', 'PALM', 'THOUGHT', 'GOOSE'] },
      { title: 'Diphthongs', sets: ['FACE', 'GOAT', 'PRICE', 'CHOICE', 'MOUTH'] },
      { title: 'Centering / R-coloured', sets: ['NEAR', 'SQUARE', 'START', 'NORTH', 'FORCE', 'CURE'] },
      { title: 'Weak Vowels', sets: ['happY', 'lettER', 'commA'] },
    ];

    lexGroups.forEach(group => {
      const groupDiv = document.createElement('div');
      groupDiv.className = 'lex-group';

      const groupTitle = document.createElement('div');
      groupTitle.className = 'lex-group-title';
      groupTitle.textContent = group.title;
      groupDiv.appendChild(groupTitle);

      const table = document.createElement('div');
      table.className = 'lex-table';

      group.sets.forEach(setKey => {
        const set = accent.lexicalSets[setKey];
        if (!set) return;
        const row = document.createElement('div');
        row.className = 'lex-row';

        const keyEl = document.createElement('span');
        keyEl.className = 'lex-key';
        keyEl.textContent = setKey;
        row.appendChild(keyEl);

        const ipaBtn = document.createElement('button');
        ipaBtn.className = 'lex-ipa';
        ipaBtn.textContent = set.ipa;
        ipaBtn.title = 'Click to hear this sound';
        ipaBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          // Try to select the primary IPA symbol in the articulator
          const primaryIpa = set.ipa.replace(/[ːˑ̟̠̞̝̥̃̈̊ʰʲʷ~]/g, '').charAt(0);
          const mapped = {'ɝ': 'ɜ', 'ɚ': 'ə'}[primaryIpa] || primaryIpa;
          if (mapped) selectSound(mapped);
        });
        row.appendChild(ipaBtn);

        const exEl = document.createElement('span');
        exEl.className = 'lex-example';
        exEl.textContent = set.example;
        row.appendChild(exEl);

        const noteEl = document.createElement('span');
        noteEl.className = 'lex-notes';
        noteEl.textContent = set.notes;
        row.appendChild(noteEl);

        table.appendChild(row);
      });

      groupDiv.appendChild(table);
      lexEl.appendChild(groupDiv);
    });
  }

  // === Consonant Features ===
  const consEl = document.getElementById('accent-consonants');
  consEl.innerHTML = '';
  if (accent.consonantFeatures && accent.consonantFeatures.length > 0) {
    accent.consonantFeatures.forEach(cf => {
      const card = document.createElement('div');
      card.className = 'cons-feature-card';
      card.innerHTML = `<span class="cons-feature-label">${cf.label}</span><p class="cons-feature-desc">${cf.description}</p>`;
      consEl.appendChild(card);
    });
  } else {
    consEl.innerHTML = '<p class="accent-empty">No specific consonant features documented.</p>';
  }

  // === Mergers & Splits ===
  const mergersEl = document.getElementById('accent-mergers');
  mergersEl.innerHTML = '';
  if (accent.mergers && accent.mergers.length > 0) {
    accent.mergers.forEach(m => {
      const card = document.createElement('div');
      card.className = 'merger-card';
      card.innerHTML = `<span class="merger-label">${m.label}</span><p class="merger-desc">${m.description}</p>`;
      mergersEl.appendChild(card);
    });
  } else {
    mergersEl.innerHTML = '<p class="accent-empty">No significant mergers or splits documented.</p>';
  }

  // === Example Sentences ===
  const sentencesEl = document.getElementById('accent-sentences');
  sentencesEl.innerHTML = '';
  if (accent.exampleSentences && accent.exampleSentences.length > 0) {
    accent.exampleSentences.forEach(s => {
      const card = document.createElement('div');
      card.className = 'sentence-card';
      card.innerHTML = `
        <p class="sentence-text">${s.text}</p>
        <p class="sentence-ipa">${s.ipa}</p>
        <p class="sentence-notes">${s.notes}</p>
      `;
      sentencesEl.appendChild(card);
    });
  } else {
    sentencesEl.innerHTML = '<p class="accent-empty">No example sentences for reference accent.</p>';
  }

  // === Minimal Pairs ===
  const pairsEl = document.getElementById('accent-minimal-pairs');
  pairsEl.innerHTML = '';
  if (accent.minimalPairs && accent.minimalPairs.length > 0) {
    accent.minimalPairs.forEach(p => {
      const card = document.createElement('div');
      card.className = 'pair-card';
      card.innerHTML = `
        <div class="pair-row">
          <div class="pair-item pair-accent">
            <span class="pair-word">${p.word1}</span>
            <span class="pair-pron">${p.pron1}</span>
          </div>
          <span class="pair-vs">vs</span>
          <div class="pair-item pair-ref">
            <span class="pair-word">${p.word2}</span>
            <span class="pair-pron">${p.pron2}</span>
          </div>
        </div>
        <p class="pair-note">${p.note}</p>
      `;
      pairsEl.appendChild(card);
    });
  } else {
    pairsEl.innerHTML = '<p class="accent-empty">This is the reference accent — compare other accents against this one.</p>';
  }

  // === Prosody & Intonation ===
  const prosodyEl = document.getElementById('accent-prosody');
  prosodyEl.innerHTML = '';
  if (accent.prosody) {
    const prosodyCard = document.createElement('div');
    prosodyCard.className = 'prosody-card';

    const prosodyItems = [
      { icon: '\uD83C\uDFB5', label: 'Rhythm', text: accent.prosody.rhythm },
      { icon: '\uD83D\uDCC8', label: 'Intonation', text: accent.prosody.intonation },
      { icon: '\u23F1', label: 'Tempo', text: accent.prosody.tempo },
    ];

    prosodyItems.forEach(item => {
      const row = document.createElement('div');
      row.className = 'prosody-item';
      row.innerHTML = `<span class="prosody-icon">${item.icon}</span><div class="prosody-content"><span class="prosody-label">${item.label}</span><span class="prosody-text">${item.text}</span></div>`;
      prosodyCard.appendChild(row);
    });

    if (accent.prosody.features && accent.prosody.features.length > 0) {
      const featList = document.createElement('div');
      featList.className = 'prosody-features';
      accent.prosody.features.forEach(f => {
        const li = document.createElement('div');
        li.className = 'prosody-feature-item';
        li.textContent = f;
        featList.appendChild(li);
      });
      prosodyCard.appendChild(featList);
    }

    prosodyEl.appendChild(prosodyCard);
  }

  // === Structured Exercises ===
  const exercisesEl = document.getElementById('accent-exercises');
  exercisesEl.innerHTML = '';
  if (accent.exercises && accent.exercises.length > 0) {
    accent.exercises.forEach((ex, idx) => {
      const card = document.createElement('div');
      card.className = 'exercise-card';

      const typeColors = { vowel: '#d4a04a', consonant: '#64b478', prosody: '#6a9fd4', articulation: '#b89d65', integration: '#c47fd4' };
      const typeColor = typeColors[ex.type] || '#b89d65';

      card.innerHTML = `
        <div class="exercise-header">
          <span class="exercise-number">${idx + 1}</span>
          <div class="exercise-title-row">
            <span class="exercise-title">${ex.title}</span>
            <span class="exercise-type" style="color:${typeColor};border-color:${typeColor}44;background:${typeColor}15">${ex.type}</span>
          </div>
        </div>
        <p class="exercise-instructions">${ex.instructions}</p>
        <div class="exercise-drills">
          ${ex.drills.map(d => `<div class="exercise-drill">${d}</div>`).join('')}
        </div>
      `;
      exercisesEl.appendChild(card);
    });
  }

  // === Coaching notes ===
  document.getElementById('accent-coaching').textContent = accent.coachingNotes;

  // === Famous Speakers ===
  const speakersEl = document.getElementById('accent-speakers');
  speakersEl.innerHTML = '';
  if (accent.famousSpeakers && accent.famousSpeakers.length > 0) {
    accent.famousSpeakers.forEach(sp => {
      const card = document.createElement('div');
      card.className = 'speaker-card';
      card.innerHTML = `<span class="speaker-name">${sp.name}</span><span class="speaker-note">${sp.note}</span>`;
      speakersEl.appendChild(card);
    });
  }

  // === Regional Variations ===
  const variationsEl = document.getElementById('accent-variations');
  variationsEl.innerHTML = '';
  if (accent.regionalVariations && accent.regionalVariations.length > 0) {
    accent.regionalVariations.forEach(v => {
      const card = document.createElement('div');
      card.className = 'variation-card';
      card.innerHTML = `<span class="variation-name">${v.name}</span><p class="variation-desc">${v.description}</p>`;
      variationsEl.appendChild(card);
    });
  } else {
    variationsEl.innerHTML = '<p class="accent-empty">This is the standard reference — see other accents for regional variations.</p>';
  }

  // === Historical Context ===
  const historyEl = document.getElementById('accent-history');
  historyEl.textContent = accent.history || '';

  // === Practice words ===
  const practiceEl = document.getElementById('accent-practice');
  practiceEl.innerHTML = '';
  accent.practiceWords.forEach(w => {
    const span = document.createElement('span');
    span.className = 'accent-practice-word';
    span.textContent = w;
    practiceEl.appendChild(span);
  });

  // === Common mistakes ===
  const mistakesEl = document.getElementById('accent-mistakes');
  mistakesEl.innerHTML = '';
  accent.commonMistakes.forEach(m => {
    const div = document.createElement('div');
    div.className = 'accent-mistake';
    div.textContent = m;
    mistakesEl.appendChild(div);
  });

  // Highlight sounds on charts
  highlightAccentSounds(accentId);
}

function animateShift(fromSymbol, toSymbol) {
  selectSound(fromSymbol);
  setTimeout(() => {
    selectSound(toSymbol);
  }, 1500);
}

// R-coloured vowels (ɝ NURSE, ɚ lettER) have no standalone chart cell — map them
// to the base vowel that does, matching the lex-table click handler's convention.
const RHOTIC_VOWEL_MAP = { 'ɝ': 'ɜ', 'ɚ': 'ə' };

function highlightChartSymbol(sym) {
  const mapped = RHOTIC_VOWEL_MAP[sym] || sym;
  const btn = document.querySelector(`[data-symbol="${CSS.escape(mapped)}"]`);
  if (btn) btn.classList.add('accent-highlight');
}

function highlightAccentSounds(accentId) {
  clearAccentHighlights();
  const accent = ACCENT_DATA.accents[accentId];
  if (!accent) return;

  // Highlight distinctive sounds
  if (accent.distinctiveSounds) {
    accent.distinctiveSounds.forEach(sym => highlightChartSymbol(sym));
  }

  // Highlight sounds from lexical sets
  if (accent.lexicalSets) {
    Object.values(accent.lexicalSets).forEach(set => {
      if (set.ipa) {
        // Extract clean IPA symbols (strip diacritics and length marks for matching)
        const cleanIpa = set.ipa.replace(/[ːˑ̟̠̞̝̥̃̈̊ʰʲʷ~]/g, '');
        // Map whole-symbol rhotic vowels first (ɝ/ɚ are single chars), then per-char.
        if (RHOTIC_VOWEL_MAP[cleanIpa]) {
          highlightChartSymbol(cleanIpa);
        } else {
          for (const ch of cleanIpa) highlightChartSymbol(ch);
        }
      }
    });
  }
}

function clearAccentHighlights() {
  document.querySelectorAll('.accent-highlight, .accent-shifted-from, .accent-shifted-to').forEach(el => {
    el.classList.remove('accent-highlight', 'accent-shifted-from', 'accent-shifted-to');
  });
}

// Back button
document.getElementById('accent-back')?.addEventListener('click', () => {
  document.getElementById('accent-detail').style.display = 'none';
  document.getElementById('accent-grid').style.display = '';
  activeAccentId = null;
  clearAccentHighlights();
});


// ============================================
// INIT
// ============================================
buildConsonantChart();
buildVowelChart();
buildOtherChart();
buildAccentGrid();
createLabels();
// Apply the viewport-dependent camera framing (portrait FOV widening, DPR)
// once at startup — previously it only ran on a resize or orientation change,
// so phones in portrait opened on the cropped desktop framing.
onResize();
animate();

// Dismiss splash screen after 2.5 seconds, then show tutorial if first visit
setTimeout(() => {
  const splash = document.getElementById('splash-screen');
  if (splash) {
    splash.classList.add('fade-out');
    setTimeout(() => {
      splash.remove();
      // Show tutorial on first visit
      if (!localStorage.getItem('sv_tutorial_seen')) {
        showTutorial();
      }
    }, 600);
  }
}, 2500);

// ─────────────────────────────────────────
// TUTORIAL
// ─────────────────────────────────────────
let tutorialAbort = null;
function showTutorial() {
  const overlay = document.getElementById('tutorial-overlay');
  if (!overlay) return;
  overlay.style.display = 'flex';

  const steps = overlay.querySelectorAll('.tutorial-step');
  const dots = overlay.querySelectorAll('.tutorial-dot');
  const nextBtn = document.getElementById('tutorial-next');
  const skipBtn = document.getElementById('tutorial-skip');

  // Remove any listeners left over from a previous open (Help-button replay),
  // so handlers don't stack and fire N times per click on a stale currentStep.
  if (tutorialAbort) tutorialAbort.abort();
  tutorialAbort = new AbortController();
  const { signal } = tutorialAbort;

  let currentStep = 0;

  function goToStep(n) {
    steps.forEach(s => s.classList.remove('active'));
    dots.forEach(d => d.classList.remove('active'));
    steps[n].classList.add('active');
    dots[n].classList.add('active');
    currentStep = n;
    // Update button text on last step
    nextBtn.textContent = (n === steps.length - 1) ? 'Get Started' : 'Next →';
  }

  function closeTutorial() {
    overlay.style.display = 'none';
    localStorage.setItem('sv_tutorial_seen', '1');
    if (tutorialAbort) { tutorialAbort.abort(); tutorialAbort = null; }
  }

  nextBtn.addEventListener('click', () => {
    if (currentStep < steps.length - 1) {
      goToStep(currentStep + 1);
    } else {
      closeTutorial();
    }
  }, { signal });

  skipBtn.addEventListener('click', closeTutorial, { signal });

  // Always start from the first step, even on replay via the Help button.
  goToStep(0);
}
window.showTutorial = showTutorial;
