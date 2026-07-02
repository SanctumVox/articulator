import * as THREE from 'three';

// ============================================
// 3D Vocal Tract Model
//
// Supports two view modes:
//   '3d'           — Full 3D anatomical model visible from all angles (default)
//   'crossSection' — Mid-sagittal clipping plane slices model in half
//
// In 3D mode, structures are built as volumetric geometry (swept profiles,
// half-pipes, tubes). In cross-section mode, the old extrusion + clip approach.
// ============================================

const DEPTH = 1.2;
const HALF  = DEPTH / 2;
const SKIN_DEPTH = 1.4;
const SKIN_HALF  = SKIN_DEPTH / 2;

// -------------------------------------------------------
// Helper: smooth CatmullRom curve from control points
// -------------------------------------------------------
function smoothCurveShape(points, closed = true) {
  const curve = new THREE.CatmullRomCurve3(
    points.map(p => new THREE.Vector3(p.x, p.y, 0)),
    closed, 'catmullrom', 0.5
  );
  const pts = curve.getPoints(80);
  const shape = new THREE.Shape();
  shape.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) shape.lineTo(pts[i].x, pts[i].y);
  if (closed) shape.closePath();
  return shape;
}

// -------------------------------------------------------
// Helper: extrude shape centered at z=0 (cross-section mode)
// -------------------------------------------------------
function makeExtruded(shape, material, depth = DEPTH) {
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth,
    bevelEnabled: true,
    bevelThickness: 0.02,
    bevelSize: 0.02,
    bevelSegments: 2
  });
  geo.translate(0, 0, -depth / 2);
  return new THREE.Mesh(geo, material);
}

// =====================================================
// CROSS-SECTION (flat "phonetics textbook" diagram) mode
// -----------------------------------------------------
// In crossSection mode the tract is drawn as a flat, painter-ordered
// sagittal diagram at z=0: unlit MeshBasicMaterial fills (flat textbook
// colour) with depthTest/Write OFF, so visibility is governed purely by
// renderOrder — no clipping planes, no stencil caps, no z-fighting. Every
// organ also carries a crisp dark outline (the textbook signature).
// =====================================================

// Flat, harmonious, anatomical palette tuned for the app's dark-navy bg.
const XS = {
  outline:    0x2b1a14,
  cavity:     0x241418,   // oral + nasal recess (drawn at 0.55 opacity)
  tongue:     0xe08a7e,
  palate:     0xe3aaa2,
  alveolar:   0xe9b4a8,
  velum:      0xd99a94,
  pharynx:    0xc98983,
  epiglottis: 0xd49a90,
  larynxWall: 0xc4938d,   // larynx + trachea walls
  bone:       0xe6dcc4,   // tracheal rings + jaw bone
  teeth:      0xf2ede2,
  lips:       0xd87d76,
  folds:      0xeec2b8,
};
const XS_CAVITY_OPACITY = 0.55;
const XS_FOLD_AMBER = new THREE.Color(0xffb24d);

// Painter render order (back -> front). Outlines draw at +0.05 over their fill.
const XS_ORDER = {
  skull:   0,
  cavity:  1,
  walls:   2,    // pharynx + trachea walls
  rings:   2.5,  // tracheal rings sit just over the walls
  palate:  3,    // palate / velum / alveolar ridge / nasal structures
  jaw:     4,
  tongue:  5,
  larynx:  6,    // epiglottis / larynx housing / vocal folds
  front:   7,    // teeth + lips
};

// Flat unlit fill at z=0. depthTest/Write off + transparent so every flat
// piece lives in the same (transparent) render queue and sorts purely by
// renderOrder — deterministic painter ordering with zero depth fighting.
function makeFlat(shape, color, renderOrder, opacity = 1) {
  const geo = new THREE.ShapeGeometry(shape);
  const mat = new THREE.MeshBasicMaterial({
    color, side: THREE.DoubleSide,
    transparent: true, opacity,
    depthTest: false, depthWrite: false,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.renderOrder = renderOrder;
  return mesh;
}

// Crisp dark contour for an organ — a LineLoop over the shape outline. Kept
// transparent so it shares the flat render queue and sorts just above its
// fill. (Hairline is 1px; at the 2x capture DPR this reads as a clean stroke.)
function makeShapeOutline(shape, color, renderOrder) {
  const pts = shape.getPoints(48);
  const geo = new THREE.BufferGeometry().setFromPoints(pts);
  const mat = new THREE.LineBasicMaterial({
    color, transparent: true, depthTest: false, depthWrite: false,
  });
  const line = new THREE.LineLoop(geo, mat);
  line.renderOrder = renderOrder;
  return line;
}

// -------------------------------------------------------
// Helper: build an arch / half-pipe BufferGeometry
// from a sagittal profile and a width function.
// Used for palate, velum, pharynx, nasal cavity, oral cavity.
//
//  sagittalPoints : [{x,y}, ...]   midline profile
//  widthFn(t)     : 0..1 → half-width at that fraction along the spine
//  options:
//    segments     — # spine samples (default 24)
//    arcSegments  — # radial samples in the half-pipe (default 10)
//    archHeight   — how tall the arch rises (default 0.08)
//    concave      — true = arch curves DOWNWARD (roof of mouth); false = upward
//    closed       — cap the ends (default false)
//    thickness    — if > 0, creates inner+outer shell for a thick wall
// -------------------------------------------------------
function buildArchFromProfile(sagittalPoints, widthFn, options = {}) {
  const {
    segments    = 24,
    arcSegments = 10,
    archHeight  = 0.08,
    concave     = true,
    thickness   = 0,
    capEnds     = false,   // close the t=0 / t=1 rims (thickness > 0 only)
  } = options;

  const spine = new THREE.CatmullRomCurve3(
    sagittalPoints.map(p => new THREE.Vector3(p.x, p.y, 0)),
    false, 'catmullrom', 0.5
  );
  const spinePoints = spine.getPoints(segments);

  const verts  = [];
  const idx    = [];
  const dir    = concave ? -1 : 1;

  // Single shell
  const buildShell = (ySign, startIdx) => {
    for (let i = 0; i <= segments; i++) {
      const t = i / segments;
      const w = widthFn(t);
      const p = spinePoints[i];
      for (let j = 0; j <= arcSegments; j++) {
        const a = (j / arcSegments) * Math.PI;
        const z = Math.cos(a) * w;
        const yOff = dir * ySign * Math.sin(a) * archHeight;
        verts.push(p.x, p.y + yOff, z);
      }
    }
    for (let i = 0; i < segments; i++) {
      for (let j = 0; j < arcSegments; j++) {
        const a = startIdx + i * (arcSegments + 1) + j;
        const b = a + arcSegments + 1;
        idx.push(a, b, a + 1);
        idx.push(a + 1, b, b + 1);
      }
    }
  };

  if (thickness > 0) {
    // Outer shell
    buildShell(1, 0);
    const outerCount = (segments + 1) * (arcSegments + 1);
    // Inner shell (slightly smaller)
    for (let i = 0; i <= segments; i++) {
      const t = i / segments;
      const w = widthFn(t) - thickness * 0.3;
      const p = spinePoints[i];
      for (let j = 0; j <= arcSegments; j++) {
        const a = (j / arcSegments) * Math.PI;
        const z = Math.cos(a) * Math.max(0.01, w);
        const yOff = dir * Math.sin(a) * Math.max(0.01, archHeight - thickness);
        verts.push(p.x, p.y + yOff, z);
      }
    }
    // Inner shell faces (flipped winding)
    for (let i = 0; i < segments; i++) {
      for (let j = 0; j < arcSegments; j++) {
        const a = outerCount + i * (arcSegments + 1) + j;
        const b = a + arcSegments + 1;
        idx.push(a, a + 1, b);
        idx.push(a + 1, b + 1, b);
      }
    }
    // Connect edges
    for (let i = 0; i <= segments; i++) {
      const oBase = i * (arcSegments + 1);
      const iBase = outerCount + i * (arcSegments + 1);
      // Left edge
      if (i < segments) {
        const oNext = (i + 1) * (arcSegments + 1);
        const iNext = outerCount + (i + 1) * (arcSegments + 1);
        idx.push(oBase, iBase, oNext);
        idx.push(oNext, iBase, iNext);
        // Right edge
        const oR = oBase + arcSegments;
        const iR = iBase + arcSegments;
        const oRn = oNext + arcSegments;
        const iRn = iNext + arcSegments;
        idx.push(oR, oRn, iR);
        idx.push(oRn, iRn, iR);
      }
    }
    // End caps: stitch outer ring to inner ring at both spine ends so the
    // shell terminates in a finished rolled edge instead of a frayed rim
    // (fixes the ragged pharynx bottom and the velum "bat wings").
    if (capEnds) {
      const ring = arcSegments + 1;
      for (const e of [0, segments]) {
        const oBase = e * ring;
        const iBase = outerCount + e * ring;
        for (let j = 0; j < arcSegments; j++) {
          const o0 = oBase + j, o1 = oBase + j + 1;
          const i0 = iBase + j, i1 = iBase + j + 1;
          if (e === 0) { idx.push(o0, i0, o1); idx.push(o1, i0, i1); }
          else         { idx.push(o0, o1, i0); idx.push(o1, i1, i0); }
        }
      }
    }
  } else {
    buildShell(1, 0);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}

// -------------------------------------------------------
// Helper: build a 3D tongue from its sagittal profile as a
// TWO-RAIL LOFT between the upper (dorsum) and lower (underside)
// midline contours.
//
// Why not a swept tube: sweeping an ellipse along the midline and
// placing its top vertices along a rotating perpendicular let the
// cross-sections splay apart and SELF-INTERSECT on highly arched
// vowels — the front folded through the body, reading as a detached
// blade with a dark "hole". A loft pins each ring's top vertex
// exactly to the upper contour and its bottom to the lower contour,
// so the dorsum IS the contour and the tongue stays one solid,
// connected "beanbag". The grid is closed and capped → watertight.
// -------------------------------------------------------
function buildTongue3DGeometry(upperContour, lowerContour) {
  // upperContour: [{x,y}, ...] root→tip (smooth upper surface)
  // lowerContour: [{x,y}, ...] root→tip (smooth under-surface)
  // Both are already smoothly interpolated via CatmullRom to the same count.
  // IMPORTANT: The contours must already be clamped to stay below the palate
  // with sufficient margin (archHeight + clearance). This function does NO
  // palate clamping — it only builds smooth geometry from the contours.

  // Two-rail loft: anchor each cross-section directly to the upper (dorsum) and
  // lower (underside) contours. The ring's TOP vertex sits exactly on the upper
  // contour and its BOTTOM on the lower contour; the sides bulge to ±halfW in z.
  // Because the top is pinned to the (clean, monotonic) upper contour — not
  // fanned out along a rotating perpendicular — the cross-sections cannot splay
  // and self-intersect the way the old swept tube did. The grid is closed and
  // capped at both ends, so the surface is watertight: no holes are possible.

  const SEGS = 60;   // stations root→tip
  const RAD  = 28;   // segments around each cross-section ring

  // Resample both contours to SEGS+1 smooth, evenly-spaced stations.
  const upCurve = new THREE.CatmullRomCurve3(
    upperContour.map(p => new THREE.Vector3(p.x, p.y, 0)), false, 'catmullrom', 0.5);
  const loCurve = new THREE.CatmullRomCurve3(
    lowerContour.map(p => new THREE.Vector3(p.x, p.y, 0)), false, 'catmullrom', 0.5);
  const up = upCurve.getPoints(SEGS);   // SEGS+1 points, root→tip
  const lo = loCurve.getPoints(SEGS);

  // Width profile: narrow at root + tip, widest through the body.
  function getHalfW(t) {
    const bodyT     = Math.sin(t * Math.PI);
    const tipTaper  = 1 - Math.pow(t, 1.8) * 0.35;
    const rootTaper = Math.min(1, t * 2.5);
    return 0.05 + 0.28 * bodyT * tipTaper * rootTaper;
  }

  const verts   = [];
  const uvs     = [];
  const indices = [];

  for (let i = 0; i <= SEGS; i++) {
    const t = i / SEGS;
    const U = up[i], L = lo[i];
    const hw = getHalfW(t);

    for (let j = 0; j <= RAD; j++) {
      const angle = (j / RAD) * Math.PI * 2;
      const s = Math.sin(angle);   // vertical: -1 at bottom(L) .. +1 at top(U)
      const c = Math.cos(angle);   // lateral
      const vmix = (s + 1) / 2;

      // Position interpolates from the lower contour (bottom) to the upper
      // contour (top); the sides bulge out to ±halfW at mid-height. The top
      // is pinned exactly to U and the bottom to L, so the dorsum IS the upper
      // contour — there is no separate flap to fold away.
      const vx = L.x + (U.x - L.x) * vmix;
      const vy = L.y + (U.y - L.y) * vmix;
      const dz = c * hw;

      verts.push(vx, vy, dz);
      // u runs root(0)→tip(1) along the length; v wraps around the cross-section.
      uvs.push(t, j / RAD);
    }
  }

  // Triangle strip indices connecting adjacent rings
  for (let i = 0; i < SEGS; i++) {
    for (let j = 0; j < RAD; j++) {
      const a = i * (RAD + 1) + j;
      const b = a + RAD + 1;
      indices.push(a, b, a + 1);
      indices.push(a + 1, b, b + 1);
    }
  }

  // Cap at root end (i=0) — fan from the root midpoint.
  const rootCenter = verts.length / 3;
  verts.push((up[0].x + lo[0].x) / 2, (up[0].y + lo[0].y) / 2, 0);
  uvs.push(0, 0.5);
  for (let j = 0; j < RAD; j++) {
    indices.push(rootCenter, j + 1, j);
  }

  // Cap at tip end (i=SEGS) — fan from a center pushed slightly FORWARD along the
  // apex tangent so the end closes as a rounded DOME (a blunt pad), not a flat disc
  // or a sharp point. The push is small and scaled to the apex width.
  const tipCenter = verts.length / 3;
  let atx = up[SEGS].x - up[SEGS - 1].x;
  let aty = up[SEGS].y - up[SEGS - 1].y;
  const aLen = Math.sqrt(atx * atx + aty * aty) || 1;
  atx /= aLen; aty /= aLen;
  const domeReach = 0.9 * getHalfW(1);        // how far the dome bulges past the last ring
  const tipMidX = (up[SEGS].x + lo[SEGS].x) / 2;
  const tipMidY = (up[SEGS].y + lo[SEGS].y) / 2;
  verts.push(tipMidX + atx * domeReach, tipMidY + aty * domeReach, 0);
  uvs.push(1, 0.5);
  const tipBase = SEGS * (RAD + 1);
  for (let j = 0; j < RAD; j++) {
    indices.push(tipCenter, tipBase + j, tipBase + j + 1);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

// -------------------------------------------------------
// Helper: resample a CatmullRom curve from control points
// to N evenly-spaced points. Used to match upper and lower
// tongue contours to the same count for smooth geometry.
// -------------------------------------------------------
function resampleContour(controlPoints, N) {
  const curve = new THREE.CatmullRomCurve3(
    controlPoints.map(p => new THREE.Vector3(p.x, p.y, 0)),
    false, 'catmullrom', 0.4
  );
  const pts = curve.getPoints(N - 1);
  return pts.map(p => ({ x: p.x, y: p.y }));
}

// -------------------------------------------------------
// Helper: build 3D lip as a half-torus tube
//   center : {x, y} — center of the mouth opening in the sagittal plane
//   halfW  : half-width of the mouth opening (z)
//   halfH  : half-height of the mouth opening (y)
//   radius : tube radius (lip thickness)
//   upper  : true for upper lip, false for lower
// -------------------------------------------------------
function buildLipTube(center, halfW, halfH, radius, upper, protrusion = 0) {
  const tubeSeg = 16;
  const radSeg  = 8;

  // Path: half ellipse in the yz plane (from one corner to the other)
  const pathPts = [];
  const startA = upper ? 0 : Math.PI;
  const endA   = upper ? Math.PI : Math.PI * 2;
  for (let i = 0; i <= tubeSeg; i++) {
    const a = startA + (endA - startA) * (i / tubeSeg);
    const z = Math.cos(a) * halfW;
    const y = center.y + Math.sin(a) * halfH;
    // protrusion tapers: strongest at center (i=tubeSeg/2), zero at corners
    const pFactor = Math.sin((i / tubeSeg) * Math.PI);
    const x = center.x + protrusion * pFactor;
    pathPts.push(new THREE.Vector3(x, y, z));
  }

  const path = new THREE.CatmullRomCurve3(pathPts, false, 'catmullrom', 0.5);
  const geo  = new THREE.TubeGeometry(path, tubeSeg, radius, radSeg, false);

  // A constant-radius tube reads as a circular HOSE. Real lips are a soft band,
  // much flatter front-to-back (x) than they are tall. X is perpendicular to the
  // ring plane, so flattening it about the lip centre squashes every cross-
  // section uniformly into a lip-like oval — no winding/seam risk. We also push
  // the vermilion edge forward slightly so the lip rolls outward, not pipe-round.
  const FLATTEN_X = 0.5;
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    pos.setX(i, center.x + (x - center.x) * FLATTEN_X);
  }
  pos.needsUpdate = true;
  geo.computeVertexNormals();
  return geo;
}


// =====================================================
// VocalTract class
// =====================================================
export default class VocalTract {
  constructor(scene, clippingPlanes = []) {
    this.scene = scene;
    this.clippingPlanes = clippingPlanes;
    this.viewMode = '3d';  // '3d' | 'crossSection'

    this.group = new THREE.Group();
    scene.add(this.group);

    this.meshes = {};
    this.skinVisible = false;
    this.teethXray = false;     // x-ray (translucent) teeth toggle; default solid
    this._teethMats = [];       // tooth materials, for the x-ray toggle
    this.voicingActive = false;
    this.voicingTime = 0;

    // Tongue state — positioned to fill the oral cavity naturally.
    // Teeth are at ~x=1.10, palate peaks at ~y=0.72
    // Tongue body neutral sits around x=0.15, y=0.18 (mid-low, central)
    this.neutralTongue = {
      tip:   { x: 0.80,  y: 0.22 },
      blade: { x: 0.58,  y: 0.18 },
      front: { x: 0.35,  y: 0.22 },
      body:  { x: 0.05,  y: 0.18 },
      root:  { x: -0.46, y: -0.23 }  // slightly more posterior (was -0.40, -0.20)
    };
    this.currentTongue = JSON.parse(JSON.stringify(this.neutralTongue));

    // Lip state
    this.neutralLips = { rounding: 0, openness: 0.3, protrusion: 0, spread: 0, labiodental: 0 };
    this.currentLips = { ...this.neutralLips };

    // Velum / jaw state
    this.neutralVelumHeight = 1.0;
    this.currentVelumHeight = 1.0;
    this.neutralJawOpen = 0.2;
    this.currentJawOpen = 0.2;

    // Skin group (never clipped)
    this.skinGroup = new THREE.Group();
    this.group.add(this.skinGroup);

    // 3D-specific mesh references for cleanup
    this._3dMeshes = [];

    this._buildAll();
  }

  // =====================
  // BUILD ALL
  // =====================
  _buildAll() {
    this._buildSkin();
    this._buildSkull();
    this._buildNasalCavity();
    this._buildHardPalate();
    this._buildAlveolarRidge();
    this._buildVelum();
    this._buildPharynx();
    this._buildEpiglottis();
    this._buildLarynx();
    this._buildOralCavity();
    this._buildTongue();
    this._buildJaw();
    this._buildUpperTeeth();
    this._buildLowerTeeth();
    this._buildUpperLip();
    this._buildLowerLip();
    this._buildTrachea();

    // NOTE: cross-section mode no longer clips. It is a genuinely flat,
    // painter-ordered diagram (see makeFlat / XS_ORDER), so no clipping
    // planes are applied to any material here. _applyClipping is retained
    // only for reference and is intentionally never called.

    // Hide skin by default (no toggle button — articulators must be visible)
    this.skinGroup.visible = this.skinVisible;

    // Opaque interior tissues cast & receive soft shadows for cavity depth.
    // Translucent shells (skin, skull) are skipped — they'd self-shadow oddly.
    this.group.traverse((o) => {
      if (o.isMesh && o.material && !o.material.transparent) {
        o.castShadow = true;
        o.receiveShadow = true;
      }
    });
  }

  // =====================
  // CLIPPING (cross-section mode only)
  // =====================
  _applyClipping() {
    this.group.traverse((child) => {
      if (child.isMesh && child.material) {
        let isSkin = false;
        this.skinGroup.traverse((sc) => { if (sc === child) isSkin = true; });
        if (!isSkin) {
          const mats = Array.isArray(child.material) ? child.material : [child.material];
          mats.forEach(m => {
            m.clippingPlanes = this.clippingPlanes;
            m.clipShadows = true;
            m.needsUpdate = true;
          });
        }
      }
    });
  }

  _removeClipping() {
    this.group.traverse((child) => {
      if (child.isMesh && child.material) {
        const mats = Array.isArray(child.material) ? child.material : [child.material];
        mats.forEach(m => {
          m.clippingPlanes = [];
          m.clipShadows = false;
          m.needsUpdate = true;
        });
      }
    });
  }

  // =====================
  // VIEW MODE TOGGLE
  // =====================
  setViewMode(mode) {
    if (mode === this.viewMode) return;
    this.viewMode = mode;

    // Clean up all meshes and rebuild
    this._disposeAll();
    this._buildAll();

    // Restore current articulator positions. Velum and jaw must be re-applied
    // too — _buildAll() rebuilds their groups at identity (velum raised, jaw
    // closed), but the rebuild-time tongue/lip compensations (jawDrop/jawComp)
    // already assume currentJawOpen, so without this the pose is inconsistent.
    this._rebuildTongueMesh();
    this.setLipShape(this.currentLips);
    this.setVelumHeight(this.currentVelumHeight);
    this.setJawOpenness(this.currentJawOpen);
  }

  _disposeAll() {
    // Dispose all geometries/materials. Lines (cross-section outlines) are NOT
    // isMesh, so they must be matched explicitly or the LineLoop outlines leak
    // and ghost between rebuilds.
    const toRemove = [];
    this.group.traverse((child) => {
      if (child.isMesh || child.isLine || child.isLineSegments) {
        child.geometry?.dispose();
        if (Array.isArray(child.material)) {
          child.material.forEach(m => m?.dispose());
        } else {
          child.material?.dispose();
        }
        toRemove.push(child);
      }
    });
    // Remove from parents
    toRemove.forEach(m => m.parent?.remove(m));

    // Reset mesh references
    this.meshes = {};
    this.tongueMesh = null;
    this.upperLipMesh = null;
    this.lowerLipMesh = null;
    this.vocalFold1 = null;
    this.vocalFold2 = null;

    // Reset cross-section outline refs + lazily-shared flat materials. The
    // shared XS materials were just disposed above (they were attached to the
    // flat fills/outlines), so null them to force clean recreation next build.
    this._xsTongueOutline = null;
    this._xsUpperLipOutline = null;
    this._xsLowerLipOutline = null;
    this._xsTongueFillMat = null;
    this._xsTongueLineMat = null;
    this._xsLipFillMat = null;
    this._xsLipLineMat = null;
    this._xsFoldBase = null;

    // Re-create groups
    this.group.remove(this.skinGroup);
    this.skinGroup = new THREE.Group();
    this.group.add(this.skinGroup);

    if (this.velumGroup) {
      this.group.remove(this.velumGroup);
      this.velumGroup = null;
    }
    if (this.jawGroup) {
      this.group.remove(this.jawGroup);
      this.jawGroup = null;
    }
    if (this.larynxGroup) {
      this.group.remove(this.larynxGroup);
      this.larynxGroup = null;
    }
  }

  // =====================
  // IS 3D MODE?
  // =====================
  get is3D() { return this.viewMode === '3d'; }

  // Cross-section helper: add a flat fill + crisp outline to a parent,
  // return the fill mesh (so this.meshes.* keeps pointing at the fill).
  _xsFlat(parent, shape, color, order, opacity = 1) {
    const fill = makeFlat(shape, color, order, opacity);
    parent.add(fill);
    parent.add(makeShapeOutline(shape, XS.outline, order + 0.05));
    return fill;
  }

  // ========================================
  // ========== SKIN ==========
  // ========================================
  _buildSkin() {
    // Recognisable sagittal profile (clockwise from chin): the nose, philtrum,
    // lips and chin live in the OUTLINE now — no more detached feature blobs.
    const skinPts = [
      { x: 1.82, y: 0.18 },                                            // chin (pogonion)
      { x: 1.55, y: -0.10 }, { x: 1.05, y: -0.55 }, { x: 0.50, y: -1.00 }, // submandible → throat
      { x: -0.10, y: -1.15 }, { x: -0.85, y: -1.05 }, { x: -1.42, y: -0.55 }, // neck base → nape
      { x: -1.74, y: 0.10 }, { x: -1.82, y: 0.85 }, { x: -1.66, y: 1.58 },   // occiput
      { x: -1.10, y: 2.12 }, { x: -0.30, y: 2.35 }, { x: 0.60, y: 2.25 },    // crown
      { x: 1.05, y: 1.95 }, { x: 1.32, y: 1.66 }, { x: 1.46, y: 1.50 },      // forehead → brow
      { x: 1.40, y: 1.40 },                                            // nasion dip
      { x: 1.58, y: 1.27 }, { x: 1.86, y: 1.10 }, { x: 1.62, y: 1.00 },      // nose bridge → tip → subnasale
      { x: 1.60, y: 0.92 }, { x: 1.72, y: 0.80 }, { x: 1.66, y: 0.70 },      // philtrum → upper lip → mouth
      { x: 1.74, y: 0.58 }, { x: 1.56, y: 0.44 },                       // lower lip → labiomental crease
    ];
    const shape = smoothCurveShape(skinPts, true);
    const mat = new THREE.MeshPhysicalMaterial({
      // Translucent skin shell: sheen gives a soft falloff at grazing angles
      // so the silhouette reads as skin, not gel. depthWrite false stops the
      // transparent shell z-fighting the interior organs.
      color: 0xd9b59a, transparent: true, opacity: 0.5,
      side: THREE.DoubleSide, depthWrite: false, roughness: 0.65,
      clearcoat: 0.15, clearcoatRoughness: 0.6,
      sheen: 0.5, sheenColor: new THREE.Color(0xffd9c2), sheenRoughness: 0.8,
    });
    const geo = new THREE.ExtrudeGeometry(shape, {
      depth: SKIN_DEPTH, bevelEnabled: true,
      bevelThickness: 0.25, bevelSize: 0.25, bevelSegments: 8,
    });
    geo.translate(0, 0, -SKIN_HALF);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.renderOrder = 10;
    this.skinGroup.add(mesh);
    this.meshes.skin = mesh;

    // (Nose and chin are part of the profile outline now — no feature blobs.)

    // Ears — flat discs tucked behind the jaw, subtle enough not to read as
    // machinery from the front view.
    const earGeo = new THREE.SphereGeometry(0.22, 10, 10);
    const earMat = new THREE.MeshPhysicalMaterial({
      color: 0xc8a88c, transparent: true, opacity: 0.35, roughness: 0.75,
      sheen: 0.4, sheenColor: new THREE.Color(0xffd9c2), depthWrite: false,
    });
    const earR = new THREE.Mesh(earGeo, earMat);
    earR.position.set(-0.35, 0.95, 0.80);
    earR.scale.set(0.30, 0.85, 0.62);
    this.skinGroup.add(earR);
    const earL = earR.clone();
    earL.position.z = -0.80;
    this.skinGroup.add(earL);
  }

  // ========================================
  // ========== SKULL ==========
  // ========================================
  _buildSkull() {
    const pts = [
      { x: 1.50, y: 0.55 }, { x: 1.55, y: 0.32 }, { x: 1.40, y: -0.02 },
      { x: 0.90, y: -0.48 }, { x: 0.30, y: -0.65 }, { x: -0.50, y: -0.62 },
      { x: -1.20, y: -0.30 }, { x: -1.45, y: 0.30 }, { x: -1.40, y: 1.20 },
      { x: -1.10, y: 1.85 }, { x: -0.30, y: 2.10 }, { x: 0.50, y: 2.00 },
      { x: 1.00, y: 1.70 }, { x: 1.20, y: 1.40 }, { x: 1.30, y: 1.18 },
      { x: 1.32, y: 1.02 }, { x: 1.48, y: 0.82 },
    ];
    const shape = smoothCurveShape(pts, true);
    const mat = new THREE.MeshStandardMaterial({
      color: 0xe8ddd0, transparent: true, opacity: 0.12,
      side: THREE.DoubleSide, depthWrite: false, roughness: 0.9
    });
    const mesh = makeExtruded(shape, mat, DEPTH * 0.8);
    mesh.renderOrder = -5;
    this.group.add(mesh);
    this.meshes.skull = mesh;
  }

  // ========================================
  // ========== NASAL CAVITY ==========
  // ========================================
  _buildNasalCavity() {
    if (this.is3D) {
      // In 3D mode, nasal cavity is a subtle dark passage above the palate
      const midline = [
        { x: 1.15, y: 0.98 }, { x: 0.80, y: 1.00 }, { x: 0.35, y: 0.96 },
        { x: -0.1, y: 0.88 }, { x: -0.45, y: 0.82 },
      ];
      const geo = buildArchFromProfile(midline,
        (t) => HALF * 0.5 * (0.6 + 0.4 * Math.sin(t * Math.PI)),
        { segments: 14, arcSegments: 6, archHeight: 0.10, concave: false }
      );
      // Recessed nasal passage: palette-consistent muted pink mucosa (was a
      // dead matte brown 0x5e2b2b that read as a wrong dark slab over the
      // palate). Kept semi-transparent + slightly deeper/less glossy so it
      // still reads as a passage set back behind the palate, not a foreground
      // surface.
      const mat = this._mucosaMaterial(0xc6857d, {
        roughness: 0.7, clearcoat: 0.2, clearcoatRoughness: 0.5,
        sheen: 0.25, transparent: true, opacity: 0.5,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.renderOrder = -2;
      this.group.add(mesh);
      this.meshes.nasalCavity = mesh;
    } else {
      const pts = [
        { x: 1.15, y: 1.08 }, { x: 0.80, y: 1.14 }, { x: 0.35, y: 1.10 },
        { x: -0.1, y: 1.02 }, { x: -0.45, y: 0.88 }, { x: -0.45, y: 0.76 },
        { x: -0.1, y: 0.74 }, { x: 0.35, y: 0.80 }, { x: 0.80, y: 0.85 },
        { x: 1.15, y: 0.90 },
      ];
      const shape = smoothCurveShape(pts, true);
      // Flat nasal recess — a quiet dark cavity, never a dominant black mass.
      this.meshes.nasalCavity = this._xsFlat(
        this.group, shape, XS.cavity, XS_ORDER.cavity, XS_CAVITY_OPACITY);
    }
  }

  // ========================================
  // ========== HARD PALATE ==========
  // ========================================
  _buildHardPalate() {
    if (this.is3D) {
      // Concave arch — roof of the mouth
      // Spans from behind alveolar ridge (~x=0.95) back to velum junction (~x=-0.08)
      const midline = [
        { x: 0.95, y: 0.64 }, { x: 0.70, y: 0.70 }, { x: 0.40, y: 0.68 },
        { x: 0.15, y: 0.65 }, { x: -0.08, y: 0.60 },
      ];
      const geo = buildArchFromProfile(midline,
        (t) => HALF * 0.62 * (0.6 + 0.4 * Math.sin(t * Math.PI)),
        { segments: 20, arcSegments: 10, archHeight: 0.12, concave: true, thickness: 0.04 }
      );
      const mat = this._mucosaMaterial(0xd9968f, { roughness: 0.6 });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.z = 0.01;
      this.group.add(mesh);
      this.meshes.hardPalate = mesh;
    } else {
      const pts = [
        { x: 0.95, y: 0.70 }, { x: 0.70, y: 0.76 }, { x: 0.40, y: 0.74 },
        { x: 0.15, y: 0.70 }, { x: -0.08, y: 0.63 }, { x: -0.08, y: 0.55 },
        { x: 0.15, y: 0.58 }, { x: 0.40, y: 0.60 }, { x: 0.70, y: 0.63 },
        { x: 0.95, y: 0.58 },
      ];
      const shape = smoothCurveShape(pts, true);
      this.meshes.hardPalate = this._xsFlat(
        this.group, shape, XS.palate, XS_ORDER.palate);
    }
  }

  // ========================================
  // ========== ALVEOLAR RIDGE ==========
  // ========================================
  _buildAlveolarRidge() {
    if (this.is3D) {
      // Small arch bump behind upper teeth — just behind x=1.10
      const midline = [
        { x: 1.08, y: 0.58 }, { x: 1.02, y: 0.68 }, { x: 0.95, y: 0.70 },
        { x: 0.88, y: 0.66 },
      ];
      const geo = buildArchFromProfile(midline,
        (t) => HALF * 0.55 * (0.5 + 0.5 * Math.sin(t * Math.PI)),
        { segments: 12, arcSegments: 8, archHeight: 0.06, concave: true, thickness: 0.03 }
      );
      const mat = this._mucosaMaterial(0xe0a89f, { roughness: 0.55 });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.z = 0.02;
      this.group.add(mesh);
      this.meshes.alveolarRidge = mesh;
    } else {
      const pts = [
        { x: 1.08, y: 0.58 }, { x: 1.02, y: 0.68 }, { x: 0.95, y: 0.70 },
        { x: 0.88, y: 0.66 }, { x: 0.95, y: 0.58 }, { x: 1.04, y: 0.52 },
      ];
      const shape = smoothCurveShape(pts, true);
      this.meshes.alveolarRidge = this._xsFlat(
        this.group, shape, XS.alveolar, XS_ORDER.palate);
    }
  }

  // ========================================
  // ========== VELUM (SOFT PALATE) ==========
  // ========================================
  _buildVelum() {
    this.velumGroup = new THREE.Group();

    if (this.is3D) {
      // Thick arch that continues from the hard palate, curving down
      const midline = [
        { x: -0.08, y: 0.60 }, { x: -0.22, y: 0.57 }, { x: -0.38, y: 0.51 },
        { x: -0.48, y: 0.43 }, { x: -0.53, y: 0.35 },
      ];
      const geo = buildArchFromProfile(midline,
        (t) => HALF * 0.55 * (1 - t * 0.4),
        { segments: 14, arcSegments: 8, archHeight: 0.08, concave: true, thickness: 0.05, capEnds: true }
      );
      const mat = this._mucosaMaterial(0xcf8a8a, { roughness: 0.5, clearcoat: 0.5, sheenColor: 0xe09a90 });
      const mesh = new THREE.Mesh(geo, mat);
      this.velumGroup.add(mesh);
      this.meshes.velum = mesh;

      // Uvula — small teardrop sphere
      const uvulaGeo = new THREE.SphereGeometry(0.05, 8, 8);
      const uvulaMat = this._mucosaMaterial(0xcf8a8a, { roughness: 0.5, clearcoat: 0.5, sheenColor: 0xe09a90, side: THREE.FrontSide });
      const uvula = new THREE.Mesh(uvulaGeo, uvulaMat);
      uvula.position.set(-0.53, 0.28, 0);
      uvula.scale.set(0.6, 1.4, 0.6);
      this.velumGroup.add(uvula);
      this.meshes.uvula = uvula;
    } else {
      const pts = [
        { x: -0.08, y: 0.65 }, { x: -0.22, y: 0.63 }, { x: -0.38, y: 0.58 },
        { x: -0.48, y: 0.50 }, { x: -0.54, y: 0.40 }, { x: -0.52, y: 0.30 },
        { x: -0.48, y: 0.36 }, { x: -0.42, y: 0.44 }, { x: -0.32, y: 0.47 },
        { x: -0.18, y: 0.50 }, { x: -0.08, y: 0.54 },
      ];
      const shape = smoothCurveShape(pts, true);
      // Flat soft-palate + uvula silhouette inside velumGroup so it still
      // rotates/translates with setVelumHeight.
      const mesh = this._xsFlat(this.velumGroup, shape, XS.velum, XS_ORDER.palate);
      this.meshes.velum = mesh;
      this.meshes.uvula = mesh;
    }

    this.group.add(this.velumGroup);
  }

  // ========================================
  // ========== PHARYNGEAL WALL ==========
  // ========================================
  _buildPharynx() {
    if (this.is3D) {
      // Posterior throat wall — a true half-tube rather than a flat ribbon:
      // tucks up behind the velum (nasopharynx), bulges gently mid-pharynx,
      // and funnels down to meet the larynx. capEnds rolls the rims closed.
      const midline = [
        { x: -0.60, y: 0.92 }, { x: -0.67, y: 0.70 }, { x: -0.72, y: 0.45 },
        { x: -0.78, y: 0.0 }, { x: -0.78, y: -0.45 }, { x: -0.72, y: -0.70 },
        { x: -0.66, y: -0.85 },
      ];
      const geo = buildArchFromProfile(midline,
        (t) => HALF * (0.55 + 0.22 * Math.sin(t * Math.PI)),
        { segments: 18, arcSegments: 12, archHeight: 0.34, concave: false, thickness: 0.05, capEnds: true }
      );
      const mat = this._mucosaMaterial(0xc07f7a, { roughness: 0.6, clearcoat: 0.3 });
      const mesh = new THREE.Mesh(geo, mat);
      this.group.add(mesh);
      this.meshes.pharynx = mesh;
    } else {
      const pts = [
        { x: -0.65, y: 0.85 }, { x: -0.72, y: 0.45 }, { x: -0.78, y: 0.0 },
        { x: -0.78, y: -0.45 }, { x: -0.72, y: -0.78 }, { x: -0.60, y: -0.78 },
        { x: -0.60, y: -0.45 }, { x: -0.60, y: 0.0 }, { x: -0.56, y: 0.45 },
        { x: -0.50, y: 0.85 },
      ];
      const shape = smoothCurveShape(pts, true);
      this.meshes.pharynx = this._xsFlat(
        this.group, shape, XS.pharynx, XS_ORDER.walls);
    }
  }

  // ========================================
  // ========== EPIGLOTTIS ==========
  // ========================================
  _buildEpiglottis() {
    if (this.is3D) {
      // Back-tilted leaf with its base at the larynx inlet and tip pointing
      // up toward the tongue root — anchored, not floating.
      const geo = new THREE.SphereGeometry(0.09, 12, 10);
      const mat = this._mucosaMaterial(0xcb8a82,{ roughness: 0.55, clearcoat: 0.35, side: THREE.FrontSide });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(-0.30, -0.55, 0);
      mesh.scale.set(1.15, 1.9, 0.32);
      mesh.rotation.z = -0.35;
      this.group.add(mesh);
      this.meshes.epiglottis = mesh;

      // Hyoid — slim U-shaped bone bridging tongue root and larynx. Gives
      // the suprahyoid region its expected anchor so nothing reads adrift.
      const hyoidGeo = new THREE.TorusGeometry(0.13, 0.018, 6, 16, Math.PI);
      const hyoid = new THREE.Mesh(hyoidGeo, this._enamelMaterial(0xddd2bb));
      hyoid.position.set(-0.24, -0.50, 0);
      hyoid.rotation.set(-Math.PI / 2, 0, Math.PI / 2); // horizontal U, opening backward
      this.group.add(hyoid);
      this.meshes.hyoid = hyoid;
    } else {
      const pts = [
        { x: -0.28, y: -0.42 }, { x: -0.18, y: -0.32 }, { x: -0.12, y: -0.48 },
        { x: -0.18, y: -0.58 }, { x: -0.28, y: -0.52 },
      ];
      const shape = smoothCurveShape(pts, true);
      this.meshes.epiglottis = this._xsFlat(
        this.group, shape, XS.epiglottis, XS_ORDER.larynx);
    }
  }

  // ========================================
  // ========== LARYNX / VOCAL FOLDS ==========
  // ========================================
  _buildLarynx() {
    this.larynxGroup = new THREE.Group();

    if (this.is3D) {
      const foldDepth = DEPTH * 0.6;
      // Rounded fold: a capsule laid along z then stretched in x reads as a
      // soft tissue cord from every angle, where the old box read as a slab.
      const foldGeo = new THREE.CapsuleGeometry(0.035, foldDepth * 0.85, 4, 10);
      foldGeo.rotateX(Math.PI / 2);   // capsule axis (y) → z, spanning the airway
      foldGeo.scale(4.0, 1.0, 1.0);   // stretch radially in x → 0.28 long fold
      this.vocalFoldMat = new THREE.MeshPhysicalMaterial({
        // Pearly fold mucosa — vocal folds are notably paler than the
        // surrounding larynx tissue. Activity is signalled by the warm
        // emissive pulse in update(), never by swapping the base colour.
        color: 0xe6b5ab, roughness: 0.4, clearcoat: 0.6, clearcoatRoughness: 0.2,
        sheen: 0.4, sheenColor: new THREE.Color(0xff9a8a),
        emissive: 0x000000, emissiveIntensity: 0
      });
      this.vocalFold1 = new THREE.Mesh(foldGeo, this.vocalFoldMat.clone());
      this.vocalFold1.position.set(-0.38, -0.73, 0);
      this.vocalFold1.rotation.z = 0.15;

      this.vocalFold2 = new THREE.Mesh(foldGeo.clone(), this.vocalFoldMat.clone());
      this.vocalFold2.position.set(-0.38, -0.82, 0);
      this.vocalFold2.rotation.z = -0.15;

      // Upright thyroid-cartilage sheath, in line with the trachea below —
      // previously this cylinder lay sideways and read as a detached box.
      const housingGeo = new THREE.CylinderGeometry(0.20, 0.18, 0.34, 16, 1, true);
      const housingMat = this._mucosaMaterial(0xc9b39c, { transparent: true, opacity: 0.34, roughness: 0.55, clearcoat: 0.3 });
      const housing = new THREE.Mesh(housingGeo, housingMat);
      housing.position.set(-0.35, -0.78, 0);
      this.larynxGroup.add(housing);

      this.larynxGroup.add(this.vocalFold1);
      this.larynxGroup.add(this.vocalFold2);
    } else {
      // Flat larynx housing silhouette.
      const housingPts = [
        { x: -0.12, y: -0.62 }, { x: -0.58, y: -0.62 }, { x: -0.65, y: -0.77 },
        { x: -0.58, y: -0.95 }, { x: -0.12, y: -0.95 }, { x: -0.08, y: -0.77 },
      ];
      const housingShape = new THREE.Shape();
      housingShape.moveTo(housingPts[0].x, housingPts[0].y);
      for (let i = 1; i < housingPts.length; i++) housingShape.lineTo(housingPts[i].x, housingPts[i].y);
      housingShape.closePath();
      this._xsFlat(this.larynxGroup, housingShape, XS.larynxWall, XS_ORDER.larynx);

      // Flat vocal folds — two small rounded cords. Origin-centred geometry +
      // mesh.position (matches the 3D fold semantics) so update()/setVoicing can
      // nudge position.y. Kept as references so the glottal pulse can tint
      // material.color (MeshBasicMaterial has no .emissive) toward amber.
      this._xsFoldBase = new THREE.Color(XS.folds);
      const foldShape = () => {
        const s = new THREE.Shape();
        s.absellipse(0, 0, 0.11, 0.028, 0, Math.PI * 2, false);
        return s;
      };
      this.vocalFold1 = makeFlat(foldShape(), XS.folds, XS_ORDER.larynx + 0.02);
      this.vocalFold1.position.set(-0.38, -0.73, 0);
      this.vocalFold2 = makeFlat(foldShape(), XS.folds, XS_ORDER.larynx + 0.02);
      this.vocalFold2.position.set(-0.38, -0.82, 0);
      const o1 = makeShapeOutline(foldShape(), XS.outline, XS_ORDER.larynx + 0.07);
      o1.position.set(-0.38, -0.73, 0);
      const o2 = makeShapeOutline(foldShape(), XS.outline, XS_ORDER.larynx + 0.07);
      o2.position.set(-0.38, -0.82, 0);
      this.larynxGroup.add(this.vocalFold1, this.vocalFold2, o1, o2);
    }

    this.group.add(this.larynxGroup);
    this.meshes.larynx = this.larynxGroup;
  }

  // ========================================
  // ========== TRACHEA ==========
  // ========================================
  _buildTrachea() {
    if (this.is3D) {
      // Cylinder tube
      const tracheaGeo = new THREE.CylinderGeometry(0.19, 0.19, 0.55, 16, 1, true);
      const tracheaMat = this._mucosaMaterial(0xb08884, { roughness: 0.6, clearcoat: 0.25 });
      const trachea = new THREE.Mesh(tracheaGeo, tracheaMat);
      trachea.position.set(-0.35, -1.22, 0);   // aligned under the larynx sheath
      this.group.add(trachea);

      // Tracheal cartilage rings — five, spanning the visible tube
      for (let i = 0; i < 5; i++) {
        const ringGeo = new THREE.TorusGeometry(0.19, 0.02, 6, 16);
        const ringMat = this._mucosaMaterial(0xc2b29a, { roughness: 0.4, clearcoat: 0.3, sheen: 0.15, sheenColor: 0xd8c8b0, side: THREE.FrontSide });
        const ring = new THREE.Mesh(ringGeo, ringMat);
        ring.position.set(-0.35, -1.02 - i * 0.115, 0);
        ring.rotation.x = Math.PI / 2;
        this.group.add(ring);
      }
    } else {
      // Flat trachea walls (left + right) at the wall layer.
      const lShape = new THREE.Shape();
      lShape.moveTo(-0.54, -0.95); lShape.lineTo(-0.48, -0.95);
      lShape.lineTo(-0.50, -1.5); lShape.lineTo(-0.56, -1.5);
      lShape.closePath();
      this._xsFlat(this.group, lShape, XS.larynxWall, XS_ORDER.walls);

      const rShape = new THREE.Shape();
      rShape.moveTo(-0.12, -0.95); rShape.lineTo(-0.18, -0.95);
      rShape.lineTo(-0.16, -1.5); rShape.lineTo(-0.10, -1.5);
      rShape.closePath();
      this._xsFlat(this.group, rShape, XS.larynxWall, XS_ORDER.walls);

      // Flat cartilage rings, sitting just over the walls.
      for (let i = 0; i < 3; i++) {
        const y = -1.05 - i * 0.15;
        const ringShape = new THREE.Shape();
        ringShape.moveTo(-0.52, y); ringShape.lineTo(-0.14, y);
        ringShape.lineTo(-0.14, y - 0.03); ringShape.lineTo(-0.52, y - 0.03);
        ringShape.closePath();
        this._xsFlat(this.group, ringShape, XS.bone, XS_ORDER.rings);
      }
    }
  }

  // ========================================
  // ========== ORAL CAVITY ==========
  // ========================================
  _buildOralCavity() {
    if (this.is3D) {
      // In 3D mode, skip the oral cavity entirely.
      this.meshes.oralCavity = null;
    } else {
      const pts = [
        { x: 1.10, y: 0.55 }, { x: 0.70, y: 0.62 }, { x: 0.35, y: 0.58 },
        { x: 0.05, y: 0.52 }, { x: -0.30, y: 0.42 }, { x: -0.48, y: 0.12 },
        { x: -0.48, y: -0.20 }, { x: -0.30, y: -0.20 }, { x: 0.05, y: -0.12 },
        { x: 0.35, y: -0.04 }, { x: 0.70, y: 0.00 }, { x: 1.10, y: 0.04 },
      ];
      const shape = smoothCurveShape(pts, true);
      // Flat oral recess — a quiet dark cavity forced to the very back of the
      // stack (no longer an occluding black slab).
      this.meshes.oralCavity = this._xsFlat(
        this.group, shape, XS.cavity, XS_ORDER.cavity, XS_CAVITY_OPACITY);
    }
  }

  // ========================================
  // PALATE CEILING — returns the Y position of the palate/velum
  // underside at any x coordinate. Used for tongue clamping.
  //
  // The roof of the mouth profile (from MRI data):
  //   x ≈ 1.08 → alveolar ridge at y ≈ 0.58
  //   x ≈ 0.95 → anterior palate at y ≈ 0.64
  //   x ≈ 0.70 → palate peak at y ≈ 0.70
  //   x ≈ 0.40 → mid-palate at y ≈ 0.68
  //   x ≈ 0.15 → posterior palate at y ≈ 0.65
  //   x ≈ -0.08 → palate-velum junction at y ≈ 0.60
  //   x ≈ -0.30 → velum at y ≈ 0.54
  //   x ≈ -0.53 → uvula at y ≈ 0.35
  // ========================================
  _getPalateY(x) {
    // Piecewise linear interpolation of the palate underside
    // Profile matched to actual velum mesh underside positions
    // (velum 2D inner curve: -0.18→0.50, -0.32→0.47, -0.42→0.44, -0.48→0.36)
    const profile = [
      { x:  1.10, y: 0.55 },
      { x:  1.02, y: 0.62 },
      { x:  0.95, y: 0.64 },
      { x:  0.70, y: 0.70 },
      { x:  0.40, y: 0.68 },
      { x:  0.15, y: 0.65 },
      { x: -0.08, y: 0.58 },   // palate-velum junction — lowered from 0.60
      { x: -0.18, y: 0.52 },   // added: matches velum underside
      { x: -0.30, y: 0.47 },   // lowered from 0.54 to match velum mesh
      { x: -0.42, y: 0.40 },   // added: matches velum underside
      { x: -0.53, y: 0.32 },   // lowered from 0.35
      { x: -0.70, y: 0.20 },   // pharynx region - no palate constraint
    ];
    // Clamp x to profile range
    if (x >= profile[0].x) return profile[0].y;
    if (x <= profile[profile.length - 1].x) return profile[profile.length - 1].y;
    // Find surrounding points and interpolate
    for (let i = 0; i < profile.length - 1; i++) {
      if (x <= profile[i].x && x >= profile[i + 1].x) {
        const t = (x - profile[i + 1].x) / (profile[i].x - profile[i + 1].x);
        return profile[i + 1].y + t * (profile[i].y - profile[i + 1].y);
      }
    }
    return 0.65; // fallback
  }

  // Offset from _getPalateY (palate midline) to actual 3D palate mesh bottom surface.
  // Hard palate archHeight=0.12 → bottom is 0.12 below midline.
  // Alveolar ridge at x≈1.0 → _getPalateY already near bottom (archHeight=0.06 but
  // profile values already lowered to match), so offset is minimal.
  _meshBottomOffset(x) {
    if (x >= 1.00) return 0.01;
    if (x >= 0.95) return 0.01 + (1.00 - x) / 0.05 * 0.11;  // smooth transition
    return 0.12;
  }

  // Depth of the palate's inner (tongue-facing) surface at z=0 relative to
  // _getPalateY midline.  Derived from the actual buildArchFromProfile params:
  //   hard palate:      archH 0.12, thickness 0.04 → inner 0.08
  //   alveolar ridge:   archH 0.06, thickness 0.03 → inner 0.03
  //   velum:            archH 0.08, thickness 0.05 → inner 0.03
  _innerArchDepth(x) {
    if (x >= 1.00) return 0.01;          // past alveolar ridge — nearly flat
    if (x >= 0.95) {                      // transition: alveolar → hard palate
      const t = (1.00 - x) / 0.05;       // 0 at x=1.0, 1 at x=0.95
      return 0.01 + t * 0.07;            // 0.01 → 0.08
    }
    if (x >= -0.08) return 0.08;         // hard palate
    if (x >= -0.25) {                     // junction: hard palate → velum
      const t = (x + 0.25) / 0.17;       // 0 at x=-0.25, 1 at x=-0.08
      return 0.03 + t * 0.05;            // 0.03 → 0.08
    }
    return 0.03;                          // velum
  }

  // Clamp a tongue contour so no point exceeds palate ceiling.
  // The gap accounts for the 3D palate arch depth at z=0 (inner surface)
  // plus PALATE_GAP (0.015) plus a safety margin (0.01), ensuring the 3D
  // tongue mesh never intersects the palate from ANY viewing angle.
  // This eliminates the need for per-vertex clamping in the geometry builder,
  // which was the root cause of visible fold/crease artifacts.
  _clampContourToPalate(contour, gap = 0.03) {
    // Vowels need a larger margin so close vowels (especially central ones
    // like /ɨ/, /ʉ/) show a visible dip below the palate instead of touching.
    // Consonants keep the tight margin for near-contact articulations.
    const margin = this._isConsonant ? 0.025 : 0.055;
    return contour.map(p => {
      const palateY = this._getPalateY(p.x);
      const archGap = this._innerArchDepth(p.x) + margin;
      const effectiveGap = Math.max(gap, archGap);
      const maxY = palateY - effectiveGap;
      return { x: p.x, y: Math.min(p.y, maxY) };
    });
  }

  // ========================================
  // ========== TONGUE ==========
  // ========================================
  // Shared wet-mucosa material — clearcoat "saliva" layer + soft-tissue sheen,
  // so all oral surfaces read as moist living tissue under the env map.
  _mucosaMaterial(color, opts = {}) {
    const m = new THREE.MeshPhysicalMaterial({
      color,
      roughness: opts.roughness ?? 0.55,
      clearcoat: opts.clearcoat ?? 0.4,
      clearcoatRoughness: opts.clearcoatRoughness ?? 0.4,
      sheen: opts.sheen ?? 0.35,
      sheenColor: new THREE.Color(opts.sheenColor ?? 0xff8d7d),
      sheenRoughness: 0.75,
      ior: opts.ior ?? 1.4,        // moist-tissue fresnel
      side: opts.side ?? THREE.DoubleSide,
    });
    if (opts.transparent) { m.transparent = true; m.opacity = opts.opacity ?? 1; }
    if (opts.depthWrite !== undefined) m.depthWrite = opts.depthWrite;
    return m;
  }

  // Tooth enamel — smooth, hard, faintly translucent off-white with a glossy coat.
  _enamelMaterial(color = 0xeae6dc) {
    return new THREE.MeshPhysicalMaterial({
      color,
      roughness: 0.25,
      clearcoat: 0.6,
      clearcoatRoughness: 0.15,
      side: THREE.DoubleSide,
    });
  }

  _makeTongueTextures() {
    if (this._tongueTex) return this._tongueTex;
    const W = 512, H = 256;
    // --- Colour map: root (deep red) → tip (warm pink), median sulcus groove ---
    const cc = document.createElement('canvas'); cc.width = W; cc.height = H;
    const cx = cc.getContext('2d');
    const grad = cx.createLinearGradient(0, 0, W, 0);
    grad.addColorStop(0.00, '#9e4843'); // root — deeper, more vascular
    grad.addColorStop(0.45, '#c06b64');
    grad.addColorStop(0.80, '#d98279'); // blade
    grad.addColorStop(1.00, '#e29a90'); // tip — palest
    cx.fillStyle = grad; cx.fillRect(0, 0, W, H);

    // Median sulcus — darker groove down the dorsum midline (v≈0.25). It must
    // FADE OUT before the apex: a real tongue tip is a smooth rounded pad with
    // no groove, so running it to the tip makes the apex look cleft/forked
    // ("a hole in the tip" head-on). Taper it in from the root and out by the
    // front third (u≈0.66), peaking mid-tongue.
    const sulcusY = H * 0.25;
    const sx0 = W * 0.08, sx1 = W * 0.66;
    for (let gx = sx0; gx < sx1; gx += 2) {
      const ht = (gx - sx0) / (sx1 - sx0);     // 0 root-end → 1 front-end
      const taper = Math.sin(ht * Math.PI);    // fade in and out along length
      const sg = cx.createLinearGradient(0, sulcusY - 7, 0, sulcusY + 7);
      sg.addColorStop(0, 'rgba(90,40,38,0)');
      sg.addColorStop(0.5, `rgba(90,40,38,${(0.5 * taper).toFixed(3)})`);
      sg.addColorStop(1, 'rgba(90,40,38,0)');
      cx.fillStyle = sg;
      cx.fillRect(gx, sulcusY - 7, 3, 14);
    }

    // Large-scale vascular mottling — a few soft radial blotches at very low
    // alpha so the surface doesn't read as a uniform gradient. Drawn before
    // the papillae so the fine grain sits on top.
    for (let n = 0; n < 14; n++) {
      const x = Math.random() * W, y = Math.random() * H;
      const r = 30 + Math.random() * 60;
      const warm = Math.random() > 0.5;
      const rg = cx.createRadialGradient(x, y, 0, x, y, r);
      rg.addColorStop(0, warm ? 'rgba(214,130,120,0.10)' : 'rgba(150,80,75,0.10)');
      rg.addColorStop(1, 'rgba(0,0,0,0)');
      cx.fillStyle = rg;
      cx.beginPath(); cx.arc(x, y, r, 0, Math.PI * 2); cx.fill();
    }

    // Papillae speckle — fine, low-contrast mottling, denser on the front
    // dorsum. Kept subtle: at viewing distance it should read as living
    // tissue texture, never as render noise.
    for (let n = 0; n < 6500; n++) {
      const u = Math.random();
      const x = u * W;
      const y = Math.random() * H;
      // concentrate near the dorsum band (v 0.1–0.4) and toward the front
      const dorsum = Math.exp(-Math.pow((y - H * 0.25) / (H * 0.16), 2));
      const front = 0.4 + 0.6 * u;
      if (Math.random() > dorsum * front) continue;
      const r = 0.4 + Math.random() * 0.8;
      const light = Math.random() > 0.5;
      cx.fillStyle = light ? 'rgba(226,168,158,0.20)' : 'rgba(140,72,66,0.20)';
      cx.beginPath(); cx.arc(x, y, r, 0, Math.PI * 2); cx.fill();
    }

    // --- Bump/roughness map: grayscale papillae relief on a mid-grey base ---
    const bc = document.createElement('canvas'); bc.width = W; bc.height = H;
    const bx = bc.getContext('2d');
    bx.fillStyle = '#8a8a8a'; bx.fillRect(0, 0, W, H);
    // groove reads as a recess (darker) in the bump map — same taper, stops
    // before the tip so the apex relief stays smooth.
    bx.fillStyle = 'rgba(40,40,40,0.45)';
    bx.fillRect(W * 0.10, sulcusY - 4, W * 0.56, 8);
    for (let n = 0; n < 7000; n++) {
      const u = Math.random();
      const x = u * W, y = Math.random() * H;
      const dorsum = Math.exp(-Math.pow((y - H * 0.25) / (H * 0.18), 2));
      if (Math.random() > dorsum * (0.4 + 0.6 * u)) continue;
      const r = 0.4 + Math.random() * 0.9;
      // Stay close to the mid-grey base (138): gentle relief, no specular
      // sparkle — this map doubles as the roughness map.
      const v = Math.random() > 0.5 ? 168 : 108;
      bx.fillStyle = `rgba(${v},${v},${v},0.35)`;
      bx.beginPath(); bx.arc(x, y, r, 0, Math.PI * 2); bx.fill();
    }

    const map = new THREE.CanvasTexture(cc);
    map.colorSpace = THREE.SRGBColorSpace;
    const bumpMap = new THREE.CanvasTexture(bc);
    map.anisotropy = bumpMap.anisotropy = 4;
    this._tongueTex = { map, bumpMap };
    return this._tongueTex;
  }

  _buildTongue() {
    // The speckled PBR tongue material is 3D-only. In cross-section mode the
    // tongue is a flat fill (see _rebuildTongueMesh), so skip building the
    // texture/material entirely — otherwise tongueMat would be orphaned and
    // leak on every mode switch.
    if (this.is3D) {
    const { map, bumpMap } = this._makeTongueTextures();
    this.tongueMat = new THREE.MeshPhysicalMaterial({
      color: 0xffffff,            // tint comes from the colour map
      map,
      bumpMap,
      bumpScale: 0.005,            // gentle papillae relief
      // NOTE: deliberately NO roughnessMap — reusing the bump canvas for
      // roughness made every papilla a specular spike (glittery noise).
      // A uniform wet roughness + strong clearcoat reads as saliva instead.
      roughness: 0.42,
      clearcoat: 0.8,              // saliva film
      clearcoatRoughness: 0.16,    // tight, wet highlight
      ior: 1.39,                   // mucous-film fresnel, subtler than default 1.5
      sheen: 0.45,                 // soft-tissue backscatter
      sheenColor: new THREE.Color(0xff8a7a),
      sheenRoughness: 0.7,
      // DoubleSide so the swept-tube end caps never read as a hollow opening even
      // if a cap winds inward — the tongue is an opaque closed mesh, so interior
      // faces are occluded and there is no visual cost.
      side: THREE.DoubleSide,
    });
    }
    this.tongueMesh = null;
    this._rebuildTongueMesh();
  }

  // Returns { upper: [{x,y},...], lower: [{x,y},...] } with matched point counts.
  // Both contours go from root to tip and are resampled to TONGUE_RESAMPLE points.
  _getTongueContours() {
    const t = this.currentTongue;
    const TONGUE_RESAMPLE = 32;

    // The tongue is a THICK muscular mass that fills most of the oral cavity.
    // MRI data shows the tongue sits on the floor of the mouth — the lower surface
    // rests against the mandible/genioglossus. Only the dorsum (upper surface) moves
    // significantly between vowels.

    // Floor of mouth: the INNER surface of the jaw where the tongue mucosa sits.
    // These are HIGHER than the outer jaw geometry points because the inner lining
    // (mylohyoid muscle, sublingual space) raises the effective floor.
    // Original jaw outer shell: (-0.48,-0.24), (-0.25,-0.12), (0.15,-0.04), (0.75,0.04), (1.15,0.10)
    // Inner surface sits ~0.10-0.15 above the outer shell at mid-mouth.
    const jawDrop = (this.currentJawOpen || 0.2) * 0.28;

    // Jaw inner top Y at a given x (piecewise linear — raised from outer shell)
    const jawInnerProfile = [
      { x: -0.48, y: -0.20 }, { x: -0.25, y: -0.02 }, { x: 0.15, y: 0.08 },
      { x: 0.75, y: 0.12 },  { x: 1.15, y: 0.14 },
    ];
    const jawTopY = (xPos) => {
      const jp = jawInnerProfile;
      if (xPos <= jp[0].x) return jp[0].y - jawDrop;
      if (xPos >= jp[jp.length - 1].x) return jp[jp.length - 1].y - jawDrop;
      for (let i = 0; i < jp.length - 1; i++) {
        if (xPos >= jp[i].x && xPos <= jp[i + 1].x) {
          const frac = (xPos - jp[i].x) / (jp[i + 1].x - jp[i].x);
          return (jp[i].y + frac * (jp[i + 1].y - jp[i].y)) - jawDrop;
        }
      }
      return -0.10 - jawDrop;
    };

    // Upper contour: pharyngeal anchor → root → body → front → blade → mid blade-tip → tip
    // tipRaise: 0 when the tip rests low, 1 when raised toward the alveolar ridge
    // (used by the lower-contour blade/tip lift below).
    const tipRaise = Math.max(0, Math.min(1, (t.tip.y + 0.05) / 0.45));
    const midRBx = (t.root.x + t.body.x) / 2;
    const midRBy = (t.root.y + t.body.y) / 2;
    const midBTx = (t.blade.x + t.tip.x) / 2;
    const midBTy = (t.blade.y + t.tip.y) / 2;
    const upperCtrl = [
      { x: -0.55,             y: -0.35 },                   // pharyngeal anchor (deep in throat)
      { x: t.root.x - 0.05,  y: t.root.y - 0.02 },         // root — curves into throat
      { x: t.root.x,          y: t.root.y + 0.08 },         // root dorsum
      { x: midRBx,            y: midRBy + 0.14 },            // mid root-body
      { x: t.body.x,          y: t.body.y + 0.14 },          // body dorsum — full height
      { x: t.front.x,         y: t.front.y + 0.11 },         // front
      { x: t.blade.x,         y: t.blade.y + 0.08 },         // blade
      { x: midBTx,            y: midBTy + 0.05 },            // mid blade-tip (smooth taper)
      { x: t.tip.x,           y: t.tip.y + 0.045 },          // tip (fuller top → rounded, not a flat sheet)
    ];

    // Lower contour. The tongue is a volume-preserving muscular hydrostat: when the
    // dorsum rises it THICKENS up from the floor (rooted, never floating); when the
    // dorsum lowers for open vowels it BULGES down into the (jaw-opened) floor space
    // and keeps its bulk — it does NOT flatten to a wafer. So the body underside
    // rests on the floor when the tongue is high, but holds a minimum thickness when
    // the tongue is low (dropping into the mouth floor, clamped at the jaw bone).
    // Only the blade and tip lift free for apical raising (/t/, /l/, /ɹ/, retroflex).
    const MAX_THICKNESS = 0.13;
    const MIN_BODY_THICKNESS = 0.17;   // tongue stays bulky even for open vowels
    const bladeUpper = t.blade.y + 0.08;
    const tipUpper = t.tip.y + 0.045;

    const floorY = (xPos) => jawTopY(xPos) + 0.01;
    // Hard limit: the jaw bone (outer shell) — the tongue can bulge into the mouth
    // floor but never below the jaw itself.
    const jawOuterProfile = [
      { x: -0.48, y: -0.34 }, { x: -0.25, y: -0.20 }, { x: 0.15, y: -0.10 },
      { x: 0.75, y: -0.04 },  { x: 1.15, y: 0.00 },
    ];
    const jawBottomY = (xPos) => {
      const jp = jawOuterProfile;
      if (xPos <= jp[0].x) return jp[0].y - jawDrop;
      if (xPos >= jp[jp.length - 1].x) return jp[jp.length - 1].y - jawDrop;
      for (let i = 0; i < jp.length - 1; i++) {
        if (xPos >= jp[i].x && xPos <= jp[i + 1].x) {
          const frac = (xPos - jp[i].x) / (jp[i + 1].x - jp[i].x);
          return (jp[i].y + frac * (jp[i + 1].y - jp[i].y)) - jawDrop;
        }
      }
      return -0.20 - jawDrop;
    };
    // Body underside: rest on the floor when high (rooted), else hold min thickness
    // by bulging down — clamped so it never sinks below the jaw bone.
    // MAX_BODY_THICKNESS caps how thick the tongue can get: a high dorsum lifts
    // the underside OFF the floor into a rounded bean (anatomically right for a
    // bunched tongue) instead of a dorsum-to-floor wall. A wall that tall
    // self-intersects when swept along the arched midline — that fold is what
    // read as a detached blade / dark hole on close vowels.
    const MAX_BODY_THICKNESS = 0.30;
    const bodyUnder = (xPos, upperY) =>
      Math.max(upperY - MAX_BODY_THICKNESS,
               jawBottomY(xPos) + 0.015,
               Math.min(floorY(xPos), upperY - MIN_BODY_THICKNESS));
    // Tip/blade lift: track the upper surface at fixed thickness so a raised tip
    // shows the gap beneath it.
    const liftY = (xPos, upperY) => Math.max(floorY(xPos), upperY - MAX_THICKNESS);

    const bodyUpper = t.body.y + 0.14;
    const frontUpper = t.front.y + 0.11;
    const midRBupper = midRBy + 0.14;
    const rootUpper = t.root.y + 0.08;
    // The blade/tip stay bulky (resting in the floor) when the tip is LOW — open
    // vowels keep a full front, not a thin spit — and only taper thin when the tip
    // actively RAISES (consonants), where the gap beneath the lifted tip appears.
    // (tipRaise is computed above, before the upper contour.)
    // A raised tip thins to a blade by default (alveolars). For RETROFLEX the
    // curled front must stay a fuller rounded tube — not a thin spit — so the
    // under-surface sits deeper below the upper, keeping thickness through the
    // curl (anatomically the retroflex apex is blunt, the curl maintains volume).
    const bladeTh = this._isRetroflex ? 0.155 : 0.09;
    const tipTh   = this._isRetroflex ? 0.145 : 0.085;
    const bladeUnder = bodyUnder(t.blade.x, bladeUpper) * (1 - tipRaise) + (bladeUpper - bladeTh) * tipRaise;
    const tipUnder   = bodyUnder(t.tip.x,   tipUpper)   * (1 - tipRaise) + (tipUpper - tipTh)  * tipRaise;
    const midBTUnder = (bladeUnder + tipUnder) / 2;
    // Front blends body-bulk (toward the body) with the blade so a raised tip lifts
    // cleanly without tearing the bulky body.
    const frontBody = bodyUnder(t.front.x, frontUpper);
    const frontLift = liftY(t.front.x, frontUpper);
    const frontLifted = Math.min(frontBody, frontLift) * 0.55 + Math.max(frontBody, frontLift) * 0.45;
    const frontLower = frontBody * (1 - tipRaise) + frontLifted * tipRaise;
    const lowerCtrl = [
      { x: -0.55,             y: -0.42 },                           // pharyngeal anchor (below upper)
      { x: t.root.x - 0.05,  y: t.root.y - 0.12 },                 // root underside (into throat)
      { x: t.root.x,          y: bodyUnder(t.root.x, rootUpper) },  // root — bulky, floor-anchored
      { x: midRBx,            y: bodyUnder(midRBx, midRBupper) },   // mid root-body — bulky
      { x: t.body.x,          y: bodyUnder(t.body.x, bodyUpper) },  // body — bulky, never wafer
      { x: t.front.x,         y: frontLower },                      // front — bulky unless tip raised
      { x: t.blade.x,         y: bladeUnder },                      // blade — bulky unless tip raised
      { x: midBTx,            y: midBTUnder },                      // mid blade-tip
      { x: t.tip.x,           y: tipUnder },                        // tip — bulky low, taper when raised
    ];

    // Resample both contours to the same point count via CatmullRom
    let upper = resampleContour(upperCtrl, TONGUE_RESAMPLE);
    let lower = resampleContour(lowerCtrl, TONGUE_RESAMPLE);

    // Clamp the upper contour so it never exceeds the palate ceiling.
    // Gap reduced from 0.045 to 0.035 since upper offsets are smaller now.
    upper = this._clampContourToPalate(upper, 0.035);

    // Also ensure lower contour doesn't exceed upper (would create inverted geometry)
    for (let i = 0; i < TONGUE_RESAMPLE; i++) {
      if (lower[i].y > upper[i].y - 0.02) {
        lower[i].y = upper[i].y - 0.02;
      }
    }

    return { upper, lower };
  }

  // Flat point list for cross-section mode (closed shape)
  _getTonguePoints() {
    const t = this.currentTongue;
    const jawDrop = (this.currentJawOpen || 0.2) * 0.28;

    // Jaw inner top Y at a given x (same raised values as _getTongueContours)
    const jawInnerProfile = [
      { x: -0.48, y: -0.20 }, { x: -0.25, y: -0.02 }, { x: 0.15, y: 0.08 },
      { x: 0.75, y: 0.12 },  { x: 1.15, y: 0.14 },
    ];
    const jawTopY = (xPos) => {
      const jp = jawInnerProfile;
      if (xPos <= jp[0].x) return jp[0].y - jawDrop;
      if (xPos >= jp[jp.length - 1].x) return jp[jp.length - 1].y - jawDrop;
      for (let i = 0; i < jp.length - 1; i++) {
        if (xPos >= jp[i].x && xPos <= jp[i + 1].x) {
          const frac = (xPos - jp[i].x) / (jp[i + 1].x - jp[i].x);
          return (jp[i].y + frac * (jp[i + 1].y - jp[i].y)) - jawDrop;
        }
      }
      return -0.10 - jawDrop;
    };

    const midRBx = (t.root.x + t.body.x) / 2;
    const midRBy = (t.root.y + t.body.y) / 2;
    const midBTx = (t.blade.x + t.tip.x) / 2;
    const midBTy = (t.blade.y + t.tip.y) / 2;
    const bladeUpper = t.blade.y + 0.08;
    const tipUpper = t.tip.y + 0.045;

    // Volume-preserving underside (matches _getTongueContours): rests on the floor
    // when the dorsum is high (rooted), holds a minimum thickness when low so open
    // vowels stay bulky instead of flattening to a wafer; blade/tip lift free.
    const MAX_THICKNESS = 0.13;
    const MIN_BODY_THICKNESS = 0.17;
    const floorY = (xPos) => jawTopY(xPos) + 0.01;
    const jawOuterProfile = [
      { x: -0.48, y: -0.34 }, { x: -0.25, y: -0.20 }, { x: 0.15, y: -0.10 },
      { x: 0.75, y: -0.04 },  { x: 1.15, y: 0.00 },
    ];
    const jawBottomY = (xPos) => {
      const jp = jawOuterProfile;
      if (xPos <= jp[0].x) return jp[0].y - jawDrop;
      if (xPos >= jp[jp.length - 1].x) return jp[jp.length - 1].y - jawDrop;
      for (let i = 0; i < jp.length - 1; i++) {
        if (xPos >= jp[i].x && xPos <= jp[i + 1].x) {
          const frac = (xPos - jp[i].x) / (jp[i + 1].x - jp[i].x);
          return (jp[i].y + frac * (jp[i + 1].y - jp[i].y)) - jawDrop;
        }
      }
      return -0.20 - jawDrop;
    };
    // MAX_BODY_THICKNESS caps how thick the tongue can get: a high dorsum lifts
    // the underside OFF the floor into a rounded bean (anatomically right for a
    // bunched tongue) instead of a dorsum-to-floor wall. A wall that tall
    // self-intersects when swept along the arched midline — that fold is what
    // read as a detached blade / dark hole on close vowels.
    const MAX_BODY_THICKNESS = 0.30;
    const bodyUnder = (xPos, upperY) =>
      Math.max(upperY - MAX_BODY_THICKNESS,
               jawBottomY(xPos) + 0.015,
               Math.min(floorY(xPos), upperY - MIN_BODY_THICKNESS));
    const liftY = (xPos, upperY) => Math.max(floorY(xPos), upperY - MAX_THICKNESS);

    const bodyUpper = t.body.y + 0.14;
    const frontUpper = t.front.y + 0.11;
    const midRBupper = midRBy + 0.14;
    const rootUpper = t.root.y + 0.08;
    const tipRaise = Math.max(0, Math.min(1, (t.tip.y + 0.05) / 0.45));
    // A raised tip thins to a blade by default (alveolars). For RETROFLEX the
    // curled front must stay a fuller rounded tube — not a thin spit — so the
    // under-surface sits deeper below the upper, keeping thickness through the
    // curl (anatomically the retroflex apex is blunt, the curl maintains volume).
    const bladeTh = this._isRetroflex ? 0.155 : 0.09;
    const tipTh   = this._isRetroflex ? 0.145 : 0.085;
    const bladeUnder = bodyUnder(t.blade.x, bladeUpper) * (1 - tipRaise) + (bladeUpper - bladeTh) * tipRaise;
    const tipUnder   = bodyUnder(t.tip.x,   tipUpper)   * (1 - tipRaise) + (tipUpper - tipTh)  * tipRaise;
    const midBTUnder = (bladeUnder + tipUnder) / 2;
    const frontBody = bodyUnder(t.front.x, frontUpper);
    const frontLift = liftY(t.front.x, frontUpper);
    const frontLifted = Math.min(frontBody, frontLift) * 0.55 + Math.max(frontBody, frontLift) * 0.45;
    const frontLower = frontBody * (1 - tipRaise) + frontLifted * tipRaise;

    const pts = [
      // Upper contour (pharyngeal anchor → root → tip)
      { x: -0.55,             y: -0.35 },
      { x: t.root.x - 0.05,  y: t.root.y - 0.02 },
      { x: t.root.x,          y: rootUpper },
      { x: midRBx,            y: midRBupper },
      { x: t.body.x,          y: bodyUpper },
      { x: t.front.x,         y: frontUpper },
      { x: t.blade.x,         y: bladeUpper },
      { x: midBTx,            y: midBTy + 0.05 },
      { x: t.tip.x,           y: tipUpper },
      // Lower contour (tip → root → pharyngeal anchor) — bulky body, free tip
      { x: t.tip.x,           y: tipUnder },
      { x: midBTx,            y: midBTUnder },
      { x: t.blade.x,         y: bladeUnder },
      { x: t.front.x,         y: frontLower },
      { x: t.body.x,          y: bodyUnder(t.body.x, bodyUpper) },
      { x: midRBx,            y: bodyUnder(midRBx, midRBupper) },
      { x: t.root.x,          y: bodyUnder(t.root.x, rootUpper) },
      { x: t.root.x - 0.05,  y: t.root.y - 0.12 },
      { x: -0.55,             y: -0.42 },
    ];
    // Clamp upper contour points (first 9: pharyngeal anchor through tip) to palate ceiling
    // For consonants, use mesh bottom offset to prevent clipping through 3D palate
    for (let i = 0; i < 9; i++) {
      const palateY = this._getPalateY(pts[i].x);
      const gap = this._isConsonant
        ? Math.max(0.035, this._meshBottomOffset(pts[i].x))
        : 0.035;
      pts[i].y = Math.min(pts[i].y, palateY - gap);
    }
    return pts;
  }

  _rebuildTongueMesh() {
    // Dispose the previous tongue geometry (3D mesh OR 2D flat fill) + its
    // outline. Materials are reused (this.tongueMat in 3D, the lazily-created
    // XS materials in 2D), so only geometries are disposed here.
    if (this.tongueMesh) {
      this.group.remove(this.tongueMesh);
      this.tongueMesh.geometry?.dispose();
    }
    if (this._xsTongueOutline) {
      this.group.remove(this._xsTongueOutline);
      this._xsTongueOutline.geometry.dispose();
      this._xsTongueOutline = null;
    }

    if (this.is3D) {
      // Full 3D tongue as a two-rail loft between the upper/lower contours.
      // The upper contour is already clamped by _clampContourToPalate with
      // an arch-depth-aware gap, so the 3D mesh naturally stays below the
      // palate at all z positions without any per-vertex clamping.
      const { upper, lower } = this._getTongueContours();
      const geo = buildTongue3DGeometry(upper, lower);
      // DoubleSide: the tongue is a closed solid, so interior faces are
      // occluded — but rendering both sides guarantees an inward-wound end cap
      // can never read as a hollow dark "hole" when viewed end-on.
      this.tongueMat.side = THREE.DoubleSide;
      this.tongueMat.clippingPlanes = [];
      this.tongueMesh = new THREE.Mesh(geo, this.tongueMat);
      this.tongueMesh.castShadow = true;
      this.tongueMesh.receiveShadow = true;
      this.group.add(this.tongueMesh);
      this.meshes.tongue = this.tongueMesh;
    } else {
      // Flat painter-ordered cross-section tongue: a clean pink fill + crisp
      // outline (NO speckled texture, NO clipping). Materials are lazily
      // created once and reused across the constant rebuilds.
      const pts = this._getTonguePoints();
      const shape = smoothCurveShape(pts, true);
      if (!this._xsTongueFillMat) {
        this._xsTongueFillMat = new THREE.MeshBasicMaterial({
          color: XS.tongue, side: THREE.DoubleSide,
          transparent: true, depthTest: false, depthWrite: false,
        });
      }
      if (!this._xsTongueLineMat) {
        this._xsTongueLineMat = new THREE.LineBasicMaterial({
          color: XS.outline, transparent: true, depthTest: false, depthWrite: false,
        });
      }
      const fill = new THREE.Mesh(new THREE.ShapeGeometry(shape), this._xsTongueFillMat);
      fill.renderOrder = XS_ORDER.tongue;
      const outline = new THREE.LineLoop(
        new THREE.BufferGeometry().setFromPoints(shape.getPoints(48)),
        this._xsTongueLineMat);
      outline.renderOrder = XS_ORDER.tongue + 0.05;
      this.group.add(fill);
      this.group.add(outline);
      this.tongueMesh = fill;
      this._xsTongueOutline = outline;
      this.meshes.tongue = fill;
    }
  }

  // ========================================
  // ========== JAW ==========
  // ========================================
  _buildJaw() {
    this.jawGroup = new THREE.Group();
    // Raised by +0.14 so the jaw/floor-of-mouth sits closer to palate,
    // giving a realistic oral cavity size for speech
    const pts = [
      { x: 1.45, y: 0.12 }, { x: 1.55, y: 0.02 }, { x: 1.35, y: -0.18 },
      { x: 0.75, y: -0.36 }, { x: 0.15, y: -0.41 }, { x: -0.25, y: -0.36 },
      { x: -0.48, y: -0.24 }, { x: -0.25, y: -0.12 }, { x: 0.15, y: -0.04 },
      { x: 0.75, y: 0.04 }, { x: 1.15, y: 0.10 },
    ];
    const shape = smoothCurveShape(pts, true);
    if (this.is3D) {
      const mat = new THREE.MeshStandardMaterial({
        color: 0xc8b8a8, transparent: true, opacity: 0.2,
        side: THREE.DoubleSide, depthWrite: false, roughness: 0.85
      });
      const mesh = makeExtruded(shape, mat, DEPTH * 0.6);
      mesh.renderOrder = -1;
      this.jawGroup.add(mesh);
    } else {
      // Flat mandible/jaw bone, inside jawGroup so it still drops with the jaw.
      this._xsFlat(this.jawGroup, shape, XS.bone, XS_ORDER.jaw);
    }
    this.group.add(this.jawGroup);
    this.meshes.jaw = this.jawGroup;
  }

  // ========================================
  // ========== UPPER TEETH ==========
  // ========================================
  // Rounded tooth crown: a beveled extruded rounded-rect so enamel reads soft,
  // not as a sharp slab. Built with width along local X, height along Y, and the
  // labio-lingual depth along Z; then rotated so depth points +X (out the front).
  _toothCrownGeo(w, h, d) {
    const r = Math.min(w, h) * 0.3;
    const hw = w / 2, hh = h / 2;
    const s = new THREE.Shape();
    s.moveTo(-hw + r, -hh);
    s.lineTo(hw - r, -hh); s.quadraticCurveTo(hw, -hh, hw, -hh + r);
    s.lineTo(hw, hh - r);  s.quadraticCurveTo(hw, hh, hw - r, hh);
    s.lineTo(-hw + r, hh); s.quadraticCurveTo(-hw, hh, -hw, hh - r);
    s.lineTo(-hw, -hh + r);s.quadraticCurveTo(-hw, -hh, -hw + r, -hh);
    const geo = new THREE.ExtrudeGeometry(s, {
      depth: d * 0.6, bevelEnabled: true,
      bevelThickness: d * 0.4, bevelSize: Math.min(w, h) * 0.16,
      bevelSegments: 3, steps: 1, curveSegments: 6,
    });
    geo.translate(0, 0, -d * 0.3);   // centre the depth
    geo.rotateY(Math.PI / 2);        // depth (Z) → +X (labial/forward)
    return geo;
  }

  // A dental arch of rounded crowns. Half-arch defined for z>0 and mirrored.
  // archCx is the lingual centre the crowns face outward from.
  _buildToothArch(parent, baseY, scale = 1) {
    const mat = this._enamelMaterial(0xf0e8e0);
    // Honour the current x-ray state on (re)build, and register the material so
    // the toggle can find it later.
    if (this.teethXray) { mat.transparent = true; mat.opacity = 0.13; mat.depthWrite = false; }
    this._teethMats.push(mat);
    const archCx = 0.45;
    // [x, z, width, height, depth] — incisor → lateral → canine → premolars → molar
    const half = [
      { x: 1.13, z: 0.045, w: 0.075, h: 0.20, d: 0.06 },  // central incisor
      { x: 1.12, z: 0.120, w: 0.060, h: 0.18, d: 0.06 },  // lateral incisor
      { x: 1.08, z: 0.180, w: 0.060, h: 0.21, d: 0.07 },  // canine (longer)
      { x: 1.01, z: 0.232, w: 0.072, h: 0.16, d: 0.09 },  // premolar 1
      { x: 0.92, z: 0.270, w: 0.078, h: 0.15, d: 0.10 },  // premolar 2
      { x: 0.80, z: 0.298, w: 0.095, h: 0.14, d: 0.12 },  // molar
    ];
    let anchor = null;
    for (const t of half) {
      for (const sgn of [1, -1]) {
        const z = t.z * sgn;
        const geo = this._toothCrownGeo(t.w * scale, t.h * scale, t.d * scale);
        const tooth = new THREE.Mesh(geo, mat);
        tooth.position.set(t.x, baseY, z);
        // Face outward along the arch: rotate so the labial face follows the curve.
        tooth.rotation.y = -Math.atan2(z, t.x - archCx);
        parent.add(tooth);
        if (!anchor) anchor = tooth;
      }
    }
    return anchor;
  }

  _buildUpperTeeth() {
    if (this.is3D) {
      this._teethMats = [];   // fresh list each full build (upper runs before lower)
      this.meshes.upperTeeth = this._buildToothArch(this.group, 0.42, 1.0);
    } else {
      const shape = new THREE.Shape();
      shape.moveTo(1.08, 0.55); shape.lineTo(1.14, 0.55);
      shape.lineTo(1.15, 0.32); shape.lineTo(1.08, 0.30);
      shape.lineTo(1.05, 0.50); shape.closePath();
      this.meshes.upperTeeth = this._xsFlat(
        this.group, shape, XS.teeth, XS_ORDER.front);
    }
  }

  // ========================================
  // ========== LOWER TEETH ==========
  // ========================================
  _buildLowerTeeth() {
    if (this.is3D) {
      // Lower arch: slightly smaller crowns. baseY 0.20 puts the biting edge
      // (~0.29) at the tongue line with a natural inter-incisal rest gap below
      // the upper row — higher values floated the teeth above the tongue. In the
      // jaw group so it drops with jaw opening.
      this.meshes.lowerTeeth = this._buildToothArch(this.jawGroup, 0.20, 0.9);
    } else {
      // Raised by +0.14 to match 3D adjustment
      const shape = new THREE.Shape();
      shape.moveTo(1.04, 0.12); shape.lineTo(1.10, 0.12);
      shape.lineTo(1.12, 0.28); shape.lineTo(1.05, 0.30);
      shape.lineTo(1.02, 0.16); shape.closePath();
      this.meshes.lowerTeeth = this._xsFlat(
        this.jawGroup, shape, XS.teeth, XS_ORDER.front);
    }
  }

  // ========================================
  // ========== UPPER LIP ==========
  // ========================================
  // Cross-section lip builder (used by _buildUpperLip / _buildLowerLip and the
  // 2D branch of setLipShape). Flat fill + crisp outline, painter-ordered at
  // the front layer. Disposes the previous fill/outline geometries and reuses
  // the lazily-created shared XS lip materials, so repeated calls stay cheap.
  _xsBuildLip(parent, shape, isUpper) {
    if (!this._xsLipFillMat) {
      this._xsLipFillMat = new THREE.MeshBasicMaterial({
        color: XS.lips, side: THREE.DoubleSide,
        transparent: true, depthTest: false, depthWrite: false,
      });
    }
    if (!this._xsLipLineMat) {
      this._xsLipLineMat = new THREE.LineBasicMaterial({
        color: XS.outline, transparent: true, depthTest: false, depthWrite: false,
      });
    }
    const fillKey = isUpper ? 'upperLipMesh' : 'lowerLipMesh';
    const outKey  = isUpper ? '_xsUpperLipOutline' : '_xsLowerLipOutline';
    if (this[fillKey]) { this[fillKey].parent?.remove(this[fillKey]); this[fillKey].geometry.dispose(); }
    if (this[outKey])  { this[outKey].parent?.remove(this[outKey]); this[outKey].geometry.dispose(); }

    const fill = new THREE.Mesh(new THREE.ShapeGeometry(shape), this._xsLipFillMat);
    fill.renderOrder = XS_ORDER.front;
    const outline = new THREE.LineLoop(
      new THREE.BufferGeometry().setFromPoints(shape.getPoints(48)),
      this._xsLipLineMat);
    outline.renderOrder = XS_ORDER.front + 0.05;
    parent.add(fill);
    parent.add(outline);
    this[fillKey] = fill;
    this[outKey]  = outline;
    this.meshes[isUpper ? 'upperLip' : 'lowerLip'] = fill;
    return fill;
  }

  _buildUpperLip() {
    if (this.is3D) {
      this._rebuildLips3D();
    } else {
      const lipShape = new THREE.Shape();
      lipShape.moveTo(1.16, 0.56);
      lipShape.quadraticCurveTo(1.28, 0.66, 1.40, 0.60);
      lipShape.quadraticCurveTo(1.48, 0.53, 1.44, 0.44);
      lipShape.quadraticCurveTo(1.36, 0.38, 1.24, 0.40);
      lipShape.quadraticCurveTo(1.16, 0.44, 1.16, 0.56);
      this._xsBuildLip(this.group, lipShape, true);
    }
  }

  // ========================================
  // ========== LOWER LIP ==========
  // ========================================
  _buildLowerLip() {
    if (this.is3D) {
      // handled by _rebuildLips3D which builds both
      return;
    }
    const lipShape = new THREE.Shape();
    lipShape.moveTo(1.16, 0.26);
    lipShape.quadraticCurveTo(1.28, 0.16, 1.40, 0.20);
    lipShape.quadraticCurveTo(1.48, 0.26, 1.44, 0.34);
    lipShape.quadraticCurveTo(1.36, 0.38, 1.24, 0.36);
    lipShape.quadraticCurveTo(1.16, 0.32, 1.16, 0.26);
    this._xsBuildLip(this.jawGroup, lipShape, false);
  }

  // ========================================
  // ========== 3D LIPS (tube rings) ==========
  // ========================================
  _rebuildLips3D() {
    const { rounding, openness, protrusion, spread } = this.currentLips;
    const labiodental = this.currentLips.labiodental || 0;

    // Remove old lip meshes
    if (this.upperLipMesh) {
      this.upperLipMesh.parent?.remove(this.upperLipMesh);
      this.upperLipMesh.geometry.dispose();
    }
    if (this.lowerLipMesh) {
      this.lowerLipMesh.parent?.remove(this.lowerLipMesh);
      this.lowerLipMesh.geometry.dispose();
    }

    const lipMat = this._mucosaMaterial(0xc25f5f, { roughness: 0.45, clearcoat: 0.5, sheenColor: 0xd86060 });

    // Mouth center and size — now positioned right in front of teeth
    const cx = 1.30 + protrusion * 0.12;
    const cy = 0.40;
    const halfW = HALF * 0.45 * (1 - rounding * 0.3) * (1 + spread * 0.2);
    const radius = 0.055 + rounding * 0.035;   // fuller lip band (flattened in x below)

    // LIP CLOSURE for bilabials (/p/, /b/, /m/): those phonemes set openness:0,
    // so the lips must MEET. Two things have to happen — collapse the vertical
    // half-height toward 0, and lift the lower lip (which rides in jawGroup and
    // therefore drops with the jaw) back up to the seam by compensating the jaw
    // drop. `closed` ramps 0→1 as openness falls below ~0.08. Open sounds
    // (closed≈0) keep the previous behaviour exactly.
    const closed = Math.max(0, Math.min(1, 1 - openness / 0.08));
    const jawComp = (this.currentJawOpen || 0.2) * 0.28; // how far jawGroup is dropped
    const halfHopen = 0.09 + openness * 0.08;
    const halfH = halfHopen * (1 - closed) + 0.015 * closed;
    const upperCy = cy + 0.02 * closed;                  // upper lip settles onto the seam
    const lowerCyWorld = cy - 0.02 * closed;             // lower lip meets just below
    const lowerCyLocal = lowerCyWorld + jawComp * closed; // undo the jaw drop when closing

    // Upper lip
    const upperGeo = buildLipTube(
      { x: cx, y: upperCy }, halfW, halfH, radius, true, protrusion * 0.1
    );
    this.upperLipMesh = new THREE.Mesh(upperGeo, lipMat);
    this.upperLipMesh.renderOrder = 2;
    this.group.add(this.upperLipMesh);
    this.meshes.upperLip = this.upperLipMesh;

    // Lower lip. For labiodentals (/f/, /v/), draw it up and back so its top edge
    // tucks against the upper incisors instead of sitting in a neutral parted mouth.
    const lowerGeo = buildLipTube(
      { x: cx - labiodental * 0.05, y: lowerCyLocal + labiodental * 0.12 },
      halfW, halfH * (1 - labiodental * 0.25), radius * 1.1, false, protrusion * 0.1
    );
    this.lowerLipMesh = new THREE.Mesh(lowerGeo, lipMat.clone());
    this.lowerLipMesh.renderOrder = 2;
    this.jawGroup.add(this.lowerLipMesh);
    this.meshes.lowerLip = this.lowerLipMesh;
  }

  // =============================================
  // PUBLIC API
  // =============================================

  setSkinVisible(visible) {
    this.skinVisible = visible;
    this.skinGroup.visible = visible;
  }

  toggleSkin() {
    this.setSkinVisible(!this.skinVisible);
    return this.skinVisible;
  }

  // Teeth x-ray: when on, the enamel goes translucent so you can see the tongue
  // and articulation behind it; off = full solid teeth.
  setTeethXray(on) {
    this.teethXray = on;
    for (const m of this._teethMats) {
      m.transparent = on;
      m.opacity = on ? 0.13 : 1.0;   // a faint ghost of teeth, not a solid wall
      m.depthWrite = !on;
      m.needsUpdate = true;
    }
  }

  toggleTeethXray() {
    this.setTeethXray(!this.teethXray);
    return this.teethXray;
  }

  setTonguePosition(params, place = null) {
    if (!params) return;

    // Safety net: if tip/blade specified without body, default to neutral body
    // to prevent stale control point positions from previous sounds.
    if ((params.tip || params.blade) && !params.body) {
      params = { ...params, body: { height: 0.45, frontness: 0.50 } };
    }

    const t = this.currentTongue;
    const n = this.neutralTongue;

    // --- Coordinate ranges (based on MRI articulatory data) ---
    // Oral cavity: pharynx at x≈-0.50, teeth at x≈1.10
    // Palate: y≈0.60-0.72 at its peak (hard palate peak at x≈0.70)
    // Floor of mouth: y≈-0.20
    //
    // VOWELS (no explicit tip): body height maps directly to tongue height
    //   height 0.80 → close vowels (/i/,/u/): dorsum at 80-90% of palate
    //   height 0.50 → mid vowels: ~50% of palate
    //   height 0.20 → open vowels (/a/,/ɑ/): tongue flat and low
    //
    // CONSONANTS (explicit tip): body stays relatively neutral (40-55% per MRI)
    //   The tip does the articulatory work, body follows passively.

    const hasTip = !!params.tip;
    const hasBlade = !!params.blade;
    // Retroflex / sub-apical posture: the tip is retracted to the post-alveolar
    // zone (param x≈0.73) AND raised/curled, over a low-mid body. This uniquely
    // flags ʈ ɖ ɳ ɽ ʂ ʐ ɻ ɭ — laminal ʃ/ʒ keep tip.x≈0.80 (excluded) and
    // alveolar /t/ keeps tip.x≈0.6 (excluded), and bunched /ɹ̈/ keeps the tip low
    // (excluded). Read by _getTongueContours to fatten the curl, and below to let
    // the apex curl up rather than ramp forward.
    this._isRetroflex = !!(params.tip && params.body &&
      params.tip.x >= 0.68 && params.tip.x <= 0.78 &&
      (params.tip.contact || (params.tip.y ?? 0) >= 0.9) &&
      (params.body.height ?? 0.5) <= 0.46 &&
      (!params.blade || params.blade.x <= 0.64));
    // Extract height early — used for body, root, blade/tip auto-derivation
    const h = params.body?.height ?? 0.5;

    // Determine if the tip is the active articulator (raised high) or passive (low/rest).
    // If tip y > 0.55, the tip is doing the work (alveolars, dentals, postalveolars)
    //   → body should be damped to neutral (40-55% per MRI data).
    // If tip y <= 0.55, the body/dorsum is the active articulator (velars, palatals)
    //   → body should map to full range (can be high).
    // Threshold at 0.55 keeps palatals (tip.y≈0.40) on the full-range path
    // while damping alveolars/dentals (tip.y≈0.95+).
    const tipIsActive = hasTip && (params.tip.y ?? 0.35) > 0.55;

    if (params.body) {
      const f = params.body.frontness ?? 0.5;

      // Body X position: frontness 0→1 maps x from -0.35 (back/pharyngeal) to 0.50 (front/palatal)
      t.body.x = -0.35 + f * 0.85;

      if (tipIsActive) {
        // CONSONANT where TIP is the active articulator (alveolars, dentals, postalveolars).
        // MRI shows body stays neutral at 40-55% height.
        // Dampen body height but keep it moderate — too-low body creates an
        // unnatural steep slope to the tip that looks like a fold/kink in 3D.
        const dampedH = h * 0.75;
        t.body.y = -0.02 + dampedH * 0.55;
      } else {
        // VOWEL or consonant where BODY/DORSUM is the active articulator (velars, palatals).
        // S-curve mapping for EXAGGERATED contrast: open vowels much lower (flat),
        // close vowels higher (dramatic arch). This makes tongue positions obvious
        // for learners — the visual difference between /a/ and /i/ is unmistakable.
        //   h=0.20 (/a/) → body.y≈-0.17 (very low, tongue lies flat)
        //   h=0.50 (/ə/) → body.y≈0.14  (moderate, clearly neutral)
        //   h=0.75 (/i/) → body.y≈0.40  (high arch, dramatic)
        //   h=0.92 (/ŋ/) → body.y≈0.51  (near-contact, clamped by palate)
        const hCurve = h <= 0.5
          ? 0.5 * Math.pow(2 * h, 1.6)
          : 1.0 - 0.5 * Math.pow(2 * (1 - h), 1.6);
        t.body.y = -0.25 + hCurve * 0.78;
        // Tongue body has muscle bulk (~13mm thick) — it doesn't flatten as
        // much as the S-curve suggests for open vowels. Lift proportionally.
        if (h < 0.5) {
          t.body.y += (0.5 - h) * 0.18;
        }
      }

      // Front follows body, positioned between body and blade
      if (tipIsActive) {
        // For consonants where tip does the work, front smoothly bridges body to tip
        t.front.x = t.body.x + 0.22 + f * 0.12;
        t.front.y = t.body.y + 0.05; // front starts rising above body toward blade
      } else {
        // For vowels and body-active consonants, front follows the dorsum arch.
        // Forward reach scales strongly with FRONTNESS so back/central vowels
        // keep the front pulled back into a compact mound (a beanbag), instead
        // of a thin blade reaching to the teeth. Front vowels still reach forward.
        t.front.x = t.body.x + 0.13 + f * 0.22;
        // Close vowels: front dips below body (arch peaks at body).
        // Open vowels: front starts dipping toward the blade valley.
        // Mid vowels: slight rise above body.
        if (h > 0.6) {
          t.front.y = t.body.y - 0.04;
        } else if (h < 0.5) {
          const frontDip = (0.5 - h) * 0.08;
          t.front.y = t.body.y - frontDip;
        } else {
          t.front.y = t.body.y + 0.03;
        }
      }

      // Auto-adjust blade when not explicitly set
      if (!hasBlade) {
        if (tipIsActive) {
          // For consonants with active tip, blade smoothly interpolates between front and tip
          t.blade.x = t.front.x + 0.15 + f * 0.08;
          // Blade y will be set after tip is resolved (see below)
        } else {
          // For vowels and body-active consonants, blade follows body/front contour.
          // Reach scales with frontness so back/central vowels stay compact.
          t.blade.x = Math.min(t.front.x + 0.10 + f * 0.12, 0.92);
          // Open vowels: blade is the thinnest part of the tongue — it dips into
          // a valley when the jaw opens wide. The dip scales with openness.
          // Close/mid vowels: blade follows the dorsum arch smoothly.
          if (h < 0.5) {
            const bladeDip = (0.5 - h) * 0.22;
            t.blade.y = t.front.y - bladeDip;
          } else {
            // Close/mid vowels: the blade is a smooth continuation of the
            // dorsum, riding just below the front — NOT pulled down to a
            // neutral "rest" height (which made a thin flat shelf). The tip is
            // passive here, so the front of the tongue stays a rounded mound.
            t.blade.y = t.front.y - 0.03;
          }
        }
      }

      // Auto-adjust tip when not explicitly set
      if (!hasTip) {
        const baseX = hasBlade ? t.blade.x : t.front.x + 0.18 + f * 0.08;
        // Passive tip (vowels): keep the tip SHORT so the tongue front is a
        // rounded continuation of the dorsum, not a long flat spatula jutting
        // toward the teeth. (Apical consonants extend via the explicit-tip path.)
        const tipExtend = 0.04 + h * 0.09;
        t.tip.x = baseX + tipExtend;
        // Clamp tip so it doesn't extend past behind lower teeth
        t.tip.x = Math.min(t.tip.x, 1.02);
        // Open vowels: tip recovers partially from the blade dip — it rests
        // against the lower teeth/gum ridge, sitting above the blade valley.
        // Close/mid vowels: tip follows blade along the arch.
        if (h < 0.5) {
          const tipRecovery = (0.5 - h) * 0.15;
          t.tip.y = t.blade.y + tipRecovery;
        } else {
          // Close/mid vowels: tip sits just below the blade — a gentle rounded
          // taper of the front, NOT a drooping flap pulled down to a rest
          // height (which read as a folded-down tip on fronted vowels).
          t.tip.y = t.blade.y - 0.025;
        }
      }
    }

    if (params.tip) {
      // Explicit tip placement (consonants)
      // x: 0→1 maps from x=-0.10 to x=1.15 (from mid-mouth to teeth)
      // Upper teeth at x≈1.10-1.15, alveolar ridge at x≈0.88-1.08
      t.tip.x = -0.10 + params.tip.x * 1.25;

      // Y positioning is PALATE-RELATIVE for high tip values:
      // The palate at each x position is the ceiling. The y parameter controls
      // how high the tip reaches toward (or onto) that ceiling.
      //   y >= 0.5: tip approaches/contacts palate (palate-relative positioning)
      //     y=0.5 → halfway between floor and palate
      //     y=0.7 → very close to palate (narrow gap for fricatives)
      //     y=1.0 → at palate (contact)
      //   y < 0.5: tip stays low (absolute positioning, for rest/low tip)
      const palateY = this._getPalateY(t.tip.x);
      const mbo = this._meshBottomOffset(t.tip.x);
      const py = params.tip.y ?? 0.35;

      if (params.tip.contact) {
        // Contact consonants (/t/,/d/,/n/,/r/,/ɾ/,/l/,/ɬ/,/ɮ/):
        // Tip snaps to palate MESH bottom surface (not midline).
        // Subtract mesh offset and contour offset so the visible tip
        // (control point + 0.03 contour offset) just touches the palate bottom.
        t.tip.y = palateY - mbo - 0.03;
      } else {
        // Non-contact tip placement (fricatives, approximants, rest position):
        // y is a 0-1 PALATE-RELATIVE parameter, ceiling = palate mesh bottom.
        // Subtract contour offset so that at py=1.0 the visible contour
        // (control + 0.03) just reaches the palate mesh bottom.
        const ceiling = palateY - mbo - 0.03;
        const floor = -0.15;
        t.tip.y = floor + py * (ceiling - floor);
      }
    }

    if (params.blade) {
      t.blade.x = -0.15 + params.blade.x * 1.05;
      // Blade y is palate-relative; ceiling = palate mesh bottom minus contour offset
      const bladePalateY = this._getPalateY(t.blade.x);
      const bladeMbo = this._meshBottomOffset(t.blade.x);
      const bladeCeiling = bladePalateY - bladeMbo - 0.08; // 0.08 = blade contour offset
      const bladeFloor = -0.15;
      t.blade.y = bladeFloor + params.blade.y * (bladeCeiling - bladeFloor);
    }

    // After tip is set, smooth the blade for consonants if blade wasn't explicit
    if (tipIsActive && !hasBlade && params.body) {
      // Blade position: between front and tip, with y interpolated smoothly
      // This creates a gentle scoop up from body to tip, not a sharp hook
      t.blade.x = (t.front.x + t.tip.x) / 2;
      // Smooth y interpolation: weighted blend — blade rises gradually
      t.blade.y = t.front.y * 0.35 + t.tip.y * 0.65;
    }
    // For velars/palatals with explicit low tip, auto-derive blade from body contour
    if (hasTip && !tipIsActive && !hasBlade && params.body) {
      t.blade.x = t.front.x + 0.18 + (params.body.frontness ?? 0.5) * 0.08;
      t.blade.y = t.body.y * 0.45 + n.blade.y * 0.55;
      t.tip.x = t.blade.x + 0.18 + (params.body.frontness ?? 0.5) * 0.06;
      // For body-active consonants, tip stays low
      t.tip.y = params.tip.y !== undefined ? t.tip.y : t.body.y * 0.3 + n.tip.y * 0.7;
    }

    // ---- Smooth front for tip-active consonants ----
    // When the tip is the active articulator (alveolars, dentals, clicks, affricates),
    // the body is dampened low but blade/tip are high near the palate.
    // If front stays at body level, the CatmullRom spline overshoots between
    // front and blade, creating a visible downward swoop/kink.
    // Fix: raise front to smoothly ramp from body toward blade/tip.
    if (tipIsActive && params.body) {
      // Retroflex: lift the (explicit, low) blade onto the body→tip arc first, so
      // the dorsum rises in one smooth sweep into the curl with no neck/dip
      // between the body and the raised apex.
      if (this._isRetroflex) {
        const tipDx = t.tip.x - t.body.x;
        if (tipDx > 0.01) {
          const bladeFrac = Math.min(1, (t.blade.x - t.body.x) / tipDx);
          t.blade.y = Math.max(t.blade.y, t.body.y + bladeFrac * (t.tip.y - t.body.y));
        }
      }
      // For explicit blade: ramp body→blade. For auto blade: ramp body→tip.
      const rampTarget = hasBlade ? t.blade.y : t.tip.y;
      const rampTargetX = hasBlade ? t.blade.x : t.tip.x;
      const dx = rampTargetX - t.body.x;
      if (dx > 0.01) {
        const frontFrac = Math.min(1.0, (t.front.x - t.body.x) / dx);
        const smoothFrontY = t.body.y + frontFrac * (rampTarget - t.body.y);
        t.front.y = Math.max(t.front.y, smoothFrontY);
      }
      // Also smooth auto-derived blade along body→tip ramp
      if (!hasBlade) {
        const tipDx = t.tip.x - t.body.x;
        if (tipDx > 0.01) {
          const bladeFrac = (t.blade.x - t.body.x) / tipDx;
          const smoothBladeY = t.body.y + bladeFrac * (t.tip.y - t.body.y);
          t.blade.y = Math.max(t.blade.y, smoothBladeY);
        }
      }
    }

    if (params.root) {
      const adv = params.root.advancement ?? 0.5;
      // Backness of the tongue body (0 = fully back, 1 = fully front), derived
      // from where the body was placed. Back vowels retract the root further.
      const bodyFrontness = Math.max(0, Math.min(1, (t.body.x + 0.35) / 0.85));
      // Back, low vowels (/ɑ/, /ɒ/) pull the root back toward the pharyngeal
      // wall, narrowing the lower pharynx — the constriction you *feel* for "ah".
      const backRetract = Math.max(0, 0.55 - h) * (1 - bodyFrontness) * 0.07;
      t.root.x = -0.58 + adv * 0.25 - backRetract;
      // Root Y: for FRONT/CENTRAL low vowels, lift the root so the profile reads
      // flat (avoids a false "raised back"). For BACK low vowels, keep the root
      // low so the natural back hump and retraction of /ɑ/ are preserved — the
      // flattening was erasing exactly the gesture that makes /ɑ/ feel backed.
      const rootLift = Math.max(0, 0.55 - h) * 0.28 * (0.3 + 0.7 * bodyFrontness);
      t.root.y = (-0.30 + adv * 0.15) + rootLift;
    }

    // Uvular (q ɢ ɴ ʀ χ ʁ): the back of the tongue must visibly bunch UP and BACK
    // to meet the uvula (which hangs at x≈-0.53, y≈0.28). The default body-active
    // mapping leaves the dorsum peak too far forward (x≈-0.22) with the back
    // sloping down to a low root, so there is a big gap under the uvula. We detect
    // this from the threaded place (params alone can't tell uvular /q/ from the
    // back vowel /o/, which share body height/frontness), then pull the dorsum
    // peak back under the uvula and lift the root so the dorsum bunches up to
    // approach/contact the uvula tip. The palate clamp below still prevents the
    // dorsum from clipping up through the velum.
    if (place === 'uvular') {
      t.body.x = -0.46;                         // dorsum peak back, nearly under the uvula
      t.body.y = Math.max(t.body.y, 0.18);      // dorsum top (≈ +0.14) reaches ~0.32, the uvula tip ~0.28
      t.root.x = -0.56;                         // root at the pharyngeal wall, behind the hump
      // Lift the back/root so the midpoint (midRB, ≈ under the uvula at x≈-0.51)
      // rides up too — otherwise the dorsum dips between body and root right
      // beneath the uvula and the contact never closes.
      t.root.y = Math.max(t.root.y, 0.06);
    }

    // Final palate clamping: ensure no control point exceeds the palate ceiling.
    // Consonants must account for the 3D palate mesh thickness (the mesh bottom
    // surface is _meshBottomOffset below _getPalateY). Vowels use simpler gaps.
    const isConsonant = !!(params.tip || params.blade);
    // Body-active consonants (implosives/ejectives at palatal/velar/uvular places)
    // have no tip/blade but still need mesh-aware clamping to prevent clipping.
    const bodyContact = params.body && params.body.height >= 0.88;
    this._isConsonant = isConsonant || bodyContact;

    const clampY = (pt, gap = 0.025) => {
      const palateY = this._getPalateY(pt.x);
      pt.y = Math.min(pt.y, palateY - gap);
    };

    if (isConsonant) {
      // Consonant clamping: gap = contour_offset + meshBottomOffset [+ visual_gap]
      // This ensures the upper contour (control_point + offset) stays at or below
      // the actual 3D palate mesh bottom surface.
      const bodyMbo = this._meshBottomOffset(t.body.x);
      const frontMbo = this._meshBottomOffset(t.front.x);
      const bladeMbo = this._meshBottomOffset(t.blade.x);
      clampY(t.body, bodyContact ? (0.14 + bodyMbo) : (0.14 + bodyMbo + 0.025));
      clampY(t.front, bodyContact ? (0.11 + frontMbo) : (0.11 + frontMbo + 0.025));
      clampY(t.blade, 0.08 + bladeMbo + 0.025);
    } else if (bodyContact) {
      // Body-active consonant without tip (e.g., palatal/velar implosives/ejectives):
      // use mesh-aware gaps to prevent clipping through 3D palate mesh
      const bodyMbo = this._meshBottomOffset(t.body.x);
      const frontMbo = this._meshBottomOffset(t.front.x);
      clampY(t.body, 0.14 + bodyMbo);
      clampY(t.front, 0.11 + frontMbo);
      clampY(t.blade, 0.105);
    } else {
      // Vowel clamping: contour_offset + 0.055 margin ensures visible gap
      // below palate, especially for central close vowels (/ɨ/, /ʉ/) where
      // the palate is lower than at front (/i/) or back (/u/) positions.
      clampY(t.body, 0.195);
      clampY(t.front, 0.165);
      clampY(t.blade, 0.135);
    }

    // Tip clamping depends on consonant type:
    if (params.tip && params.tip.contact) {
      // Contact consonants: tip already placed at palate mesh bottom — safety clamp only
      const palateY = this._getPalateY(t.tip.x);
      const tipMbo = this._meshBottomOffset(t.tip.x);
      t.tip.y = Math.min(t.tip.y, palateY - tipMbo - 0.03);
    } else if (params.tip) {
      // Non-contact consonants: account for mesh thickness
      const tipMbo = this._meshBottomOffset(t.tip.x);
      clampY(t.tip, 0.03 + tipMbo + 0.01);
    } else {
      // Vowels: standard gap
      clampY(t.tip);
    }

    // Guarantee monotonic front-to-back ordering of the control points.
    // Anatomically root→body→front→blade→tip always advance toward the teeth;
    // if a pose (or a mid-tween interpolation, or contradictory manual sliders)
    // pushes a rear point ahead of a forward one, the swept spine doubles back
    // on itself and the mesh self-intersects — the "glitch". Enforcing a minimum
    // forward step eliminates that failure mode without affecting valid poses.
    const MIN_DX = 0.06;
    t.body.x  = Math.max(t.body.x,  t.root.x  + MIN_DX);
    t.front.x = Math.max(t.front.x, t.body.x  + MIN_DX);
    t.blade.x = Math.max(t.blade.x, t.front.x + MIN_DX);
    if (this._isRetroflex) {
      // Retroflex: shape a fat DIAGONAL up-curl (candy-cane hook) — the apex
      // rises up-and-slightly-forward of the blade, not a long flat forward ramp
      // (which read as an alveolar /t/) and not a near-vertical spine (which the
      // two-rail loft renders as a thin front-to-back fin, since the loft carries
      // thickness in the upper↔lower gap). A modest forward step gives the curl
      // real front-to-back depth so it stays a rounded tube. tip.x stays AHEAD of
      // blade.x so the loft's stations remain x-monotonic and cannot fold.
      t.tip.x = Math.min(Math.max(t.tip.x, t.blade.x + 0.07), t.blade.x + 0.12);
    } else {
      t.tip.x = Math.max(t.tip.x, t.blade.x + MIN_DX);
    }

    this._rebuildTongueMesh();
  }

  setLipShape(params) {
    if (!params) return;
    this.currentLips = { ...this.currentLips, ...params };

    if (this.is3D) {
      this._rebuildLips3D();
      return;
    }

    // Cross-section mode: flat painter-ordered lips (no extrusion, no clipping).
    const { rounding, openness, protrusion, spread } = this.currentLips;

    const prot = protrusion * 0.12;
    const rnd = rounding * 0.06;
    const spr = spread * 0.04;
    const open = openness * 0.12;

    const upperShape = new THREE.Shape();
    upperShape.moveTo(1.16 - spr, 0.56 + open * 0.3);
    upperShape.quadraticCurveTo(1.28 + prot, 0.66 + rnd + open * 0.2, 1.40 + prot, 0.60 + rnd);
    upperShape.quadraticCurveTo(1.48 + prot, 0.53, 1.44 + prot, 0.44 + open * 0.15);
    upperShape.quadraticCurveTo(1.36 + prot, 0.38 + open * 0.1, 1.24 + prot, 0.40 + open * 0.05);
    upperShape.quadraticCurveTo(1.16 - spr, 0.44 + open * 0.05, 1.16 - spr, 0.56 + open * 0.3);
    this._xsBuildLip(this.group, upperShape, true);

    // Labiodental: raise the lower lip and tuck it back so its top edge meets the
    // upper incisors (the /f/, /v/ gesture) rather than sitting in a parted mouth.
    const lab = this.currentLips.labiodental || 0;
    const ly = lab * 0.16;   // vertical raise toward the upper teeth
    const lx = -lab * 0.05;  // tuck back behind the teeth edge
    const lowerShape = new THREE.Shape();
    lowerShape.moveTo(1.16 - spr + lx, 0.26 - open * 0.3 + ly);
    lowerShape.quadraticCurveTo(1.28 + prot + lx, 0.16 - rnd - open * 0.2 + ly, 1.40 + prot + lx, 0.20 - rnd + ly);
    lowerShape.quadraticCurveTo(1.48 + prot + lx, 0.26 + ly, 1.44 + prot + lx, 0.34 - open * 0.1 + ly);
    lowerShape.quadraticCurveTo(1.36 + prot + lx, 0.38 - open * 0.1 + ly, 1.24 + prot + lx, 0.36 - open * 0.05 + ly);
    lowerShape.quadraticCurveTo(1.16 - spr + lx, 0.32 + ly, 1.16 - spr + lx, 0.26 - open * 0.3 + ly);
    this._xsBuildLip(this.jawGroup, lowerShape, false);
  }

  setVelumHeight(height) {
    this.currentVelumHeight = height;
    const angle = (1 - height) * 0.5;
    this.velumGroup.rotation.z = -angle;
    this.velumGroup.position.x = Math.sin(angle) * 0.1;
    this.velumGroup.position.y = -(1 - Math.cos(angle)) * 0.1;
  }

  setJawOpenness(openness) {
    this.currentJawOpen = openness;
    // Jaw drop multiplier 0.28 gives realistic range:
    //   openness=0.1 (/i/) → drop=0.028 (barely open)
    //   openness=0.25 (/ə/) → drop=0.07 (moderate)
    //   openness=0.6 (/a/) → drop=0.168 (clearly open)
    const drop = openness * 0.28;
    this.jawGroup.position.y = -drop;
    this.jawGroup.rotation.z = -openness * 0.04;
  }

  setVoicing(voiced) {
    this.voicingActive = voiced;
    if (!voiced && this.vocalFold1 && this.vocalFold2) {
      // Reset the activity signal. 3D folds clear the emissive glow; 2D flat
      // folds (no .emissive) restore their pearly base colour.
      const reset = (mat) => {
        if (mat.emissive) {
          mat.emissive.setHex(0x000000);
          mat.emissiveIntensity = 0;
        } else if (this._xsFoldBase) {
          mat.color.copy(this._xsFoldBase);
        }
      };
      reset(this.vocalFold1.material);
      reset(this.vocalFold2.material);
      this.vocalFold1.position.y = -0.73;
      this.vocalFold2.position.y = -0.82;
    }
  }

  resetToNeutral() {
    this.currentTongue = JSON.parse(JSON.stringify(this.neutralTongue));
    this._rebuildTongueMesh();
    this.setLipShape(this.neutralLips);
    this.setVelumHeight(this.neutralVelumHeight);
    this.setJawOpenness(this.neutralJawOpen);
    this.setVoicing(false);
  }

  getMeshes() { return { ...this.meshes }; }

  update(deltaTime) {
    if (this.voicingActive && this.vocalFold1 && this.vocalFold2) {
      this.voicingTime += deltaTime * 12;
      const pulse = Math.sin(this.voicingTime) * 0.5 + 0.5;
      const vibration = Math.sin(this.voicingTime * 2) * 0.015;
      // 3D folds (MeshPhysicalMaterial): pulse a warm amber emissive glow.
      // 2D flat folds (MeshBasicMaterial, no .emissive): tint the base colour
      // toward amber on the pulse instead. Both visibly part/close via the
      // vibration offset.
      const tint = (mat) => {
        if (mat.emissive) {
          mat.emissive.setHex(0xffb24d);
          mat.emissiveIntensity = pulse * 0.35;
        } else if (this._xsFoldBase) {
          mat.color.copy(this._xsFoldBase).lerp(XS_FOLD_AMBER, pulse * 0.6);
        }
      };
      tint(this.vocalFold1.material);
      tint(this.vocalFold2.material);
      this.vocalFold1.position.y = -0.73 + vibration;
      this.vocalFold2.position.y = -0.82 - vibration;
    }
  }

  getArticulatorPositions() {
    return {
      'Lips': new THREE.Vector3(1.35, 0.42, 0),
      'Upper Teeth': new THREE.Vector3(1.12, 0.42, 0),
      'Lower Teeth': new THREE.Vector3(1.10, 0.08, 0),
      'Alveolar Ridge': new THREE.Vector3(1.00, 0.70, 0),
      'Hard Palate': new THREE.Vector3(0.50, 0.72, 0),
      'Soft Palate (Velum)': new THREE.Vector3(-0.28, 0.58, 0),
      'Uvula': new THREE.Vector3(-0.52, 0.30, 0),
      'Tongue Tip': new THREE.Vector3(this.currentTongue.tip.x, this.currentTongue.tip.y + 0.10, 0),
      'Tongue Blade': new THREE.Vector3(this.currentTongue.blade.x, this.currentTongue.blade.y + 0.14, 0),
      'Tongue Body': new THREE.Vector3(this.currentTongue.body.x, this.currentTongue.body.y + 0.20, 0),
      'Tongue Root': new THREE.Vector3(this.currentTongue.root.x, this.currentTongue.root.y, 0),
      'Pharyngeal Wall': new THREE.Vector3(-0.72, 0.1, 0),
      'Epiglottis': new THREE.Vector3(-0.18, -0.38, 0),
      'Larynx': new THREE.Vector3(-0.38, -0.90, 0),
      'Nasal Cavity': new THREE.Vector3(0.50, 1.02, 0),
    };
  }
}
