// Contact IK: makes a seated animation fit any avatar. The emote only holds bone rotations, so on bodies with
// different proportions hands sink into or float above the thighs and feet hang or dig into the floor.
// After the animation is applied each frame, SeatContacts plants the feet flat on the floor (toes forward)
// and lays the palms on the thighs, measured on each avatar's own mesh. Pure three.js, no VRM library needed,
// so the same file runs in the GLBtoVRM viewer and in Hyperfy (createVRMFactory) on raw bones.
import * as THREE from 'three';

const v1 = new THREE.Vector3(), v2 = new THREE.Vector3(), v3 = new THREE.Vector3(), q1 = new THREE.Quaternion(), q2 = new THREE.Quaternion();
const UP = new THREE.Vector3(0, 1, 0);

// Analytic two-bone IK in world space: upper -> lower -> end reaches `target`. The elbow/knee stays in the plane
// it is already bent in (`hint`, a world direction, decides only for a perfectly straight limb) and the end joint
// keeps `endRotation` (its current world rotation if omitted). Bone lengths never change.
export function solveTwoBone(upper, lower, end, target, hint, endRotation) {
  upper.updateWorldMatrix(true, true);
  const a = upper.getWorldPosition(new THREE.Vector3()), b = lower.getWorldPosition(new THREE.Vector3()), c = end.getWorldPosition(new THREE.Vector3());
  const endQ = endRotation ? endRotation.clone() : end.getWorldQuaternion(new THREE.Quaternion());
  const lab = a.distanceTo(b), lbc = b.distanceTo(c);
  const dir = v1.subVectors(target, a);
  let dist = dir.length();
  if (dist < 1e-6 || lab < 1e-6 || lbc < 1e-6) return;
  dir.divideScalar(dist);
  dist = THREE.MathUtils.clamp(dist, Math.abs(lab - lbc) + 1e-4, (lab + lbc) * 0.9999);
  // bend direction: where the elbow/knee sticks out of the current upper-end line, made perpendicular to the target line
  const line = v3.subVectors(c, a).normalize();
  const bend = v2.subVectors(b, a);
  bend.addScaledVector(line, -bend.dot(line));
  if (bend.length() < lab * 1e-3) bend.copy(hint);
  bend.addScaledVector(dir, -bend.dot(dir));
  if (bend.length() < 1e-3) bend.set(0, 1, 0).addScaledVector(dir, -dir.y);
  bend.normalize();
  const cos = THREE.MathUtils.clamp((lab * lab + dist * dist - lbc * lbc) / (2 * lab * dist), -1, 1);
  const elbow = a.clone().addScaledVector(dir, lab * cos).addScaledVector(bend, lab * Math.sqrt(1 - cos * cos));
  const reach = a.clone().addScaledVector(dir, dist);
  turn(upper, b.clone().sub(a), elbow.clone().sub(a));
  turn(lower, end.getWorldPosition(new THREE.Vector3()).sub(elbow), reach.sub(elbow));
  setWorldRotation(end, endQ);
}

// rotate `node` in world space so that direction `from` points along `to`
function turn(node, from, to) {
  q1.setFromUnitVectors(from.normalize(), to.normalize()).multiply(node.getWorldQuaternion(q2));
  setWorldRotation(node, q1);
}
function setWorldRotation(node, q) {
  node.quaternion.copy(node.parent.getWorldQuaternion(q2).invert().multiply(q));
  node.updateMatrixWorld(true);
}

const SIDES = ['left', 'right'];
const FINGERS = ['Thumb', 'Index', 'Middle', 'Ring', 'Little'].flatMap((f) => ['Metacarpal', 'Proximal', 'Intermediate', 'Distal'].map((p) => f + p));
const BINS = 10; // thigh sampled every 10% of its length...
const SECTORS = 24; // ...and every 15° around it

// Where a hand rests, relative to its thigh, so it lands on the same spot of any body:
// t: along the thigh, 0 = hip, 1 = knee; angle: degrees around it from the top, positive towards the inner thigh;
// gap: metres from the palm to the skin; rot: hand rotation in thigh space (null = palm flat on the skin);
// on: false leaves that hand to the animation. feet: which feet are planted on the floor (false = as animated,
// e.g. a crossed leg).
export const DEFAULT_HAND = { on: true, t: 0.6, angle: 0, gap: 0, rot: null };
export const DEFAULT_SEAT = { hands: true, relax: 0.5, feet: { left: true, right: true }, left: { ...DEFAULT_HAND }, right: { ...DEFAULT_HAND } };

export class SeatContacts {
  // root: the avatar scene (vrm.scene); bone(name): raw node of a VRM humanoid bone or null;
  // meshes: the avatar's skinned meshes; vrm1: VRM 1 avatars face +Z instead of -Z.
  // Must be constructed while the avatar is still in its rest pose (before any animation).
  constructor({ root, bone, meshes, vrm1 = false }) {
    this.root = root;
    this.vrm1 = vrm1;
    root.updateMatrixWorld(true);
    const rootQ = root.getWorldQuaternion(new THREE.Quaternion()), rootInv = rootQ.clone().invert();
    const forward = new THREE.Vector3(0, 0, vrm1 ? 1 : -1).applyQuaternion(rootQ);
    const pos = (node) => node.getWorldPosition(new THREE.Vector3());
    const hips = bone('hips');
    this.sides = [];
    for (const s of SIDES) {
      const n = Object.fromEntries(['UpperLeg', 'LowerLeg', 'Foot', 'Toes', 'UpperArm', 'LowerArm', 'Hand', 'MiddleProximal']
        .map((p) => [p, bone(s + p) || null]));
      if (!n.UpperLeg || !n.LowerLeg || !n.Foot) continue;
      const fingers = FINGERS.map((f) => bone(s + f)).filter(Boolean);
      this.sides.push({ s, n, fingers, arms: !!(n.UpperArm && n.LowerArm && n.Hand) });
    }
    // vertices grouped by the bone that moves them most
    const buckets = new Map();
    for (const side of this.sides) {
      for (const key of ['UpperLeg', 'Foot', 'Toes', 'Hand']) if (side.n[key]) buckets.set(side.n[key], []);
      for (const f of side.fingers) buckets.set(f, []);
    }
    // thigh skin vertices: anything weighted at least 30% to the thigh, hip crease included, re-measured live
    const thighs = new Map(this.sides.map((side) => [side.n.UpperLeg, (side.skinVerts = [])]));
    for (const mesh of meshes) {
      const geo = mesh.geometry, idx = geo.attributes.skinIndex, wgt = geo.attributes.skinWeight;
      if (!idx || !wgt || !mesh.skeleton) continue;
      mesh.skeleton.update?.();
      for (let i = 0; i < geo.attributes.position.count; i++) {
        let best = 0, b = null;
        for (let k = 0; k < 4; k++) {
          const w = wgt.getComponent(i, k), bk = mesh.skeleton.bones[idx.getComponent(i, k)];
          if (w > best) { best = w; b = bk; }
          if (w >= 0.3 && thighs.has(bk)) thighs.get(bk).push([mesh, i]);
        }
        const list = buckets.get(b);
        if (list && best > 0.5) list.push(mesh.localToWorld(mesh.getVertexPosition(i, new THREE.Vector3())));
      }
    }
    for (const side of this.sides) { const all = side.skinVerts, step = Math.max(1, Math.ceil(all.length / 1500)); side.skinVerts = all.filter((_, i) => i % step === 0); }
    for (const side of this.sides) {
      const { n } = side;
      // thigh frame (rest pose, stored in thigh space): axis hip -> knee, "top" = the front once seated,
      // "inner" = towards the body's midline
      const A = pos(n.UpperLeg), K = pos(n.LowerLeg), L = A.distanceTo(K), d = K.clone().sub(A).divideScalar(L);
      const top = forward.clone().addScaledVector(d, -forward.dot(d)).normalize();
      const inner = (hips ? pos(hips) : A.clone().setX(0)).sub(A);
      inner.addScaledVector(d, -inner.dot(d)).addScaledVector(top, -inner.dot(top));
      if (inner.lengthSq() < 1e-8) inner.crossVectors(d, top);
      inner.normalize();
      // skin radius per (length section, sector around the axis): the outermost vertex there
      const grid = Array.from({ length: BINS }, () => new Array(SECTORS).fill(-Infinity));
      for (const p of buckets.get(n.UpperLeg)) {
        const o = p.clone().sub(A), t = o.dot(d) / L;
        if (t < 0 || t >= 1) continue;
        o.addScaledVector(d, -t * L);
        const a = Math.atan2(o.dot(inner), o.dot(top)), bin = Math.floor(t * BINS), sec = sectorOf(a);
        grid[bin][sec] = Math.max(grid[bin][sec], o.length());
      }
      side.radius = side.restRadius = fillGrid(grid, L * 0.17);
      const toLocal = new THREE.Matrix4().copy(n.UpperLeg.matrixWorld).invert(), rot = n.UpperLeg.getWorldQuaternion(new THREE.Quaternion()).invert();
      side.frame = { length: L, axis: d.clone().applyQuaternion(rot), top: top.clone().applyQuaternion(rot), inner: inner.clone().applyQuaternion(rot), origin: A.clone().applyMatrix4(toLocal) };
      // sole: how far the lowest foot/toe vertex lies below the ankle; plus the flat rest orientations
      const F = pos(n.Foot);
      let minY = Infinity;
      for (const key of ['Foot', 'Toes']) for (const p of buckets.get(n[key]) || []) minY = Math.min(minY, p.y);
      side.sole = Number.isFinite(minY) ? F.y - minY : Math.max(F.y - pos(root).y, 0.05);
      side.footRest = rootInv.clone().multiply(n.Foot.getWorldQuaternion(new THREE.Quaternion()));
      side.toesRest = n.Toes?.quaternion.clone();
      if (!side.arms) continue;
      // palm: centre of the palm surface (VRM rest is a T-pose, palms down), stored in hand space
      const H = pos(n.Hand);
      const hd = (n.MiddleProximal ? pos(n.MiddleProximal) : H.clone().sub(pos(n.LowerArm)).add(H)).sub(H).normalize();
      let along = 0, count = 0, depth = 0;
      for (const p of buckets.get(n.Hand)) {
        const o = p.clone().sub(H), a = o.dot(hd);
        if (a <= 0) continue;
        along += a; count++;
        depth = Math.min(depth, o.dot(UP));
      }
      along = count ? along / count : 0.045 * L / 0.45;
      side.palm = n.Hand.worldToLocal(H.clone().addScaledVector(hd, along).addScaledVector(UP, depth || -0.02));
      // up to 48 points of the palm-side skin (heel, edges), checked against the thigh with the finger joints
      const under = buckets.get(n.Hand).filter((p) => p.y - H.y < depth * 0.4);
      const step = Math.max(1, Math.floor(under.length / 48));
      side.palmPoints = under.filter((_, i) => i % step === 0).slice(0, 48).map((p) => n.Hand.worldToLocal(p.clone()));
      // palm normal (world down in the T-pose) in hand space, and the fingers' flat rest rotations
      side.palmNormal = UP.clone().negate().applyQuaternion(n.Hand.getWorldQuaternion(new THREE.Quaternion()).invert());
      side.fingerRest = side.fingers.map((f) => f.quaternion.clone());
      // finger skin: up to 12 vertices per finger bone (the ones farthest from the bone, i.e. pads and tips)
      side.fingerPoints = side.fingers.flatMap((f) => {
        const J = pos(f), list = buckets.get(f).slice().sort((p, q) => q.distanceTo(J) - p.distanceTo(J));
        const step = Math.max(1, Math.floor(list.length / 24));
        return list.filter((_, i) => i % step === 0).slice(0, 12).map((p) => [f, f.worldToLocal(p.clone())]);
      });
      side.reach = H.distanceTo(pos(n.LowerArm)) + pos(n.LowerArm).distanceTo(pos(n.UpperArm));
    }
  }

  side(name) { return this.sides.find((s) => s.s === name); }

  // The thigh's skin as it is now: seated, the hip crease flattens the front of the thigh (linear blend
  // skinning), so the rest-pose measurement would leave the hands hovering. Cells with no vertex keep the
  // rest value.
  measureSkin(side) {
    const { frame } = side, inv = new THREE.Matrix4().copy(side.n.UpperLeg.matrixWorld).invert(), p = new THREE.Vector3();
    const grid = Array.from({ length: BINS }, () => new Array(SECTORS).fill(-Infinity));
    for (const [mesh, i] of side.skinVerts) {
      mesh.getVertexPosition(i, p).applyMatrix4(mesh.matrixWorld).applyMatrix4(inv).sub(frame.origin);
      const t = p.dot(frame.axis) / frame.length;
      if (t < 0 || t >= 1) continue;
      p.addScaledVector(frame.axis, -t * frame.length);
      const bin = Math.floor(t * BINS), sec = sectorOf(Math.atan2(p.dot(frame.inner), p.dot(frame.top)));
      grid[bin][sec] = Math.max(grid[bin][sec], p.length());
    }
    side.radius = grid.map((row, i) => row.map((r, j) => (Number.isFinite(r) && r > side.restRadius[i][j] * 0.4 ? r : side.restRadius[i][j])));
  }

  // skin radius at (t, angle in radians), interpolated over the measured grid
  skin(side, t, a, conservative = false) {
    const x = THREE.MathUtils.clamp(t * BINS - 0.5, 0, BINS - 1), i = Math.floor(x), fi = x - i, i2 = Math.min(i + 1, BINS - 1);
    const y = (((a + Math.PI) / (2 * Math.PI)) * SECTORS + SECTORS * 10 - 0.5) % SECTORS, j = Math.floor(y), fj = y - j, j2 = (j + 1) % SECTORS;
    const r = side.radius;
    // collision checks take the highest of the surrounding cells: interpolating flattens the skin's bumps
    if (conservative) {
      const own = r[THREE.MathUtils.clamp(Math.floor(t * BINS), 0, BINS - 1)][sectorOf(a)];
      return Math.max(own, (r[i][j] * (1 - fj) + r[i][j2] * fj) * (1 - fi) + (r[i2][j] * (1 - fj) + r[i2][j2] * fj) * fi);
    }
    return (r[i][j] * (1 - fj) + r[i][j2] * fj) * (1 - fi) + (r[i2][j] * (1 - fj) + r[i2][j2] * fj) * fi;
  }

  // world point on (or `extra` metres outside) the skin at (t, angle in radians), and the outward normal
  surface(side, t, a, extra = 0) {
    const { frame } = side, m = side.n.UpperLeg.matrixWorld;
    const radial = frame.top.clone().multiplyScalar(Math.cos(a)).addScaledVector(frame.inner, Math.sin(a));
    const local = frame.origin.clone().addScaledVector(frame.axis, t * frame.length).addScaledVector(radial, this.skin(side, t, a) + extra);
    return { point: local.applyMatrix4(m), normal: radial.transformDirection(m) };
  }

  // the reverse: thigh coordinates {t, angle (rad), r (distance from the axis)} of a world point
  thighCoords(side, point) {
    const { frame } = side, local = side.n.UpperLeg.worldToLocal(point.clone()).sub(frame.origin);
    const t = local.dot(frame.axis) / frame.length;
    local.addScaledVector(frame.axis, -local.dot(frame.axis));
    return { t, angle: Math.atan2(local.dot(frame.inner), local.dot(frame.top)), r: local.length() };
  }

  // Where this hand currently rests relative to its thigh (for the editor's "use current hand pose")
  measureHand(name) {
    const side = this.side(name);
    if (!side?.arms) return null;
    this.root.updateMatrixWorld(true);
    this.measureSkin(side);
    const c = this.thighCoords(side, side.n.Hand.localToWorld(side.palm.clone()));
    const t = THREE.MathUtils.clamp(c.t, 0.05, 0.95);
    const rot = side.n.UpperLeg.getWorldQuaternion(new THREE.Quaternion()).invert().multiply(side.n.Hand.getWorldQuaternion(new THREE.Quaternion()));
    return { t, angle: THREE.MathUtils.radToDeg(c.angle), gap: Math.max(-0.01, c.r - this.skin(side, t, c.angle)), rot: rot.toArray() };
  }

  // deepest point of this hand's skin (palm centre, palm side, finger pads and tips) inside the thigh skin
  fingerPenetration(side) {
    const points = [[side.n.Hand.localToWorld(side.palm.clone()), 0]];
    for (const p of side.palmPoints) points.push([side.n.Hand.localToWorld(p.clone()), 0]);
    for (const [f, p] of side.fingerPoints) points.push([f.localToWorld(p.clone()), 0]);
    let depth = 0;
    for (const [p, pad] of points) {
      const c = this.thighCoords(side, p);
      if (c.t < 0 || c.t > 1) continue;
      depth = Math.max(depth, this.skin(side, c.t, c.angle, true) + pad - c.r);
    }
    return depth;
  }

  // floorY: world height of the floor under the chair. weight: 0..1 blend with the animation (fade in/out).
  // seat: hand placement, see DEFAULT_SEAT (missing fields fall back to it). feet: plant the feet.
  solve({ floorY, weight = 1, feet = true, seat = DEFAULT_SEAT }) {
    if (weight <= 0 || !this.sides.length) return;
    const root = this.root;
    root.updateMatrixWorld(true);
    const rootQ = root.getWorldQuaternion(new THREE.Quaternion());
    const forward = new THREE.Vector3(0, 0, this.vrm1 ? 1 : -1).applyQuaternion(rootQ);
    const back = forward.clone().negate();
    const touched = [];
    const keep = (...nodes) => { for (const node of nodes) if (node) touched.push([node, node.quaternion.clone()]); };
    // feet first: moving the legs moves the thighs the hands rest on
    if (feet) for (const { s, n, sole, footRest, toesRest } of this.sides) {
      if (seat.feet?.[s] === false) continue;
      keep(n.UpperLeg, n.LowerLeg, n.Foot, n.Toes);
      const target = n.Foot.getWorldPosition(new THREE.Vector3());
      target.y = floorY + sole;
      solveTwoBone(n.UpperLeg, n.LowerLeg, n.Foot, target, forward, rootQ.clone().multiply(footRest));
      if (n.Toes && toesRest) { n.Toes.quaternion.copy(toesRest); n.Toes.updateMatrixWorld(true); }
    }
    if (seat.hands ?? true) for (const side of this.sides) {
      if (!side.arms) continue;
      root.updateMatrixWorld(true);
      this.measureSkin(side);
      const { n } = side, hand = { ...DEFAULT_HAND, ...(seat[side.s] || {}) }, relax = seat.relax ?? DEFAULT_SEAT.relax;
      if (hand.on === false) continue;
      keep(n.UpperArm, n.LowerArm, n.Hand, ...side.fingers);
      const shoulder = n.UpperArm.getWorldPosition(new THREE.Vector3());
      const angle = THREE.MathUtils.degToRad(hand.angle);
      // hand orientation: authored relative to the thigh, or the animation's hand turned the least amount
      // that lays the palm flat on the skin (so the fingers keep pointing where the animation points them)
      const thighQ = n.UpperLeg.getWorldQuaternion(new THREE.Quaternion());
      let handQ;
      if (hand.rot) handQ = thighQ.clone().multiply(new THREE.Quaternion().fromArray(hand.rot));
      else {
        handQ = n.Hand.getWorldQuaternion(new THREE.Quaternion());
        const normal = side.palmNormal.clone().applyQuaternion(handQ);
        handQ.premultiply(new THREE.Quaternion().setFromUnitVectors(normal, this.surface(side, hand.t, angle).normal.negate()));
      }
      setWorldRotation(n.Hand, handQ);
      // fingers resting on the leg instead of digging into it
      side.fingers.forEach((f, i) => f.quaternion.slerp(side.fingerRest[i], relax));
      n.Hand.updateMatrixWorld(true);
      // the wrist sits at (skin point + gap - palm offset); if the arm is too short, slide towards the hip
      const palmOffset = n.Hand.localToWorld(side.palm.clone()).sub(n.Hand.getWorldPosition(v1));
      let wrist, normal;
      for (let t = hand.t; ; t -= 0.05) {
        ({ point: wrist, normal } = this.surface(side, Math.max(t, 0.05), angle, hand.gap));
        wrist.sub(palmOffset);
        if (t <= 0.05 || wrist.distanceTo(shoulder) <= side.reach * 0.995) break;
      }
      solveTwoBone(n.UpperArm, n.LowerArm, n.Hand, wrist, back, handQ);
      // curled fingers may still dig in: lift the hand off the skin (rigidly, along the contact normal)
      for (let i = 0; i < 3; i++) {
        const depth = this.fingerPenetration(side);
        if (depth < 0.002) break;
        wrist.addScaledVector(normal, depth + 0.002);
        solveTwoBone(n.UpperArm, n.LowerArm, n.Hand, wrist, back, handQ);
      }
    }
    if (weight < 1) for (const [node, fk] of touched) node.quaternion.copy(fk.slerp(node.quaternion, weight));
    if (weight < 1) root.updateMatrixWorld(true);
  }
}

const sectorOf = (a) => ((Math.floor(((a + Math.PI) / (2 * Math.PI)) * SECTORS) % SECTORS) + SECTORS) % SECTORS;

// Sections/sectors with no or too few vertices (mesh splits, other bones weighted there) read far too thin:
// rebuild them from their neighbours, first around the thigh, then along it.
function fillGrid(grid, fallback) {
  const all = grid.flat().filter(Number.isFinite).sort((x, y) => x - y), median = all[all.length >> 1] ?? fallback;
  const ok = (x) => Number.isFinite(x) && x > median * 0.6;
  const fill = (row, n, wrap) => row.map((x, i) => {
    if (ok(x)) return x;
    for (let k = 1; k < n; k++) {
      const lo = wrap ? (i - k + n) % n : i - k, hi = wrap ? (i + k) % n : i + k;
      const a = lo >= 0 && ok(row[lo]) ? row[lo] : null, b = hi < n && ok(row[hi]) ? row[hi] : null;
      if (a !== null || b !== null) return a !== null && b !== null ? (a + b) / 2 : (a ?? b);
    }
    return NaN;
  });
  const rows = grid.map((row) => fill(row, SECTORS, true));
  for (let j = 0; j < SECTORS; j++) {
    const col = fill(rows.map((row) => row[j]), BINS, false);
    rows.forEach((row, i) => (row[j] = Number.isFinite(col[i]) ? col[i] : median));
  }
  return rows;
}
