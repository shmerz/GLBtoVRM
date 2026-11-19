import * as THREE from 'three';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { createEmoteFactory } from './emotes.js';
import { solveTwoBone, SeatContacts, DEFAULT_SEAT } from './contact-ik.js';

const $ = (id) => document.getElementById(id);
const axes = ['X', 'Y', 'Z'];
const clone = (value) => JSON.parse(JSON.stringify(value));
const finite = (n) => typeof n === 'number' && Number.isFinite(n);
// IK chains: end joint -> [upper, lower, end, bend hint]. The hint (avatar-relative) only decides the bend
// direction when the limb is perfectly straight, as in the rest pose: knees forward, elbows back.
const IK_CHAINS = {};
for (const s of ['left', 'right']) {
  IK_CHAINS[s + 'Hand'] = [s + 'UpperArm', s + 'LowerArm', s + 'Hand', 'back'];
  IK_CHAINS[s + 'Foot'] = [s + 'UpperLeg', s + 'LowerLeg', s + 'Foot', 'front'];
}
const tq = new THREE.Quaternion();
// Chair test: a seat like Hyperfy's (src/core/systems/Chairs.js places the pelvis 8 cm above the seat point)
const SEAT_HEIGHT = 0.45;
const DEG = Math.PI / 180;
// "copy pose to later keys" adds coordinated natural motion: breathing (spine, chest, shoulders, with the neck
// compensating so the gaze stays put) and a slow head/hips sway. Degrees per unit of the variation amount, as
// [X, Y, Z] on the breathing wave b and the sway wave s; both start at 0 so the edited key stays exact.
const VARIATION = {
  spine: [[0.3, 0, 0], [0, 0, 0]], chest: [[0.5, 0, 0], [0, 0, 0]], upperChest: [[0.5, 0, 0], [0, 0, 0]],
  neck: [[-0.4, 0, 0], [0, 0.3, 0]], head: [[-0.3, 0, 0], [0.2, 0.8, 0.1]],
  leftShoulder: [[0, 0, 0.4], [0, 0, 0]], rightShoulder: [[0, 0, -0.4], [0, 0, 0]], hips: [[0, 0, 0], [0, 0.2, 0]],
};
const sanitizeSeat = (seat) => {
  const hand = (h) => ({
    on: h?.on !== false,
    t: THREE.MathUtils.clamp(finite(h?.t) ? h.t : 0.6, 0.05, 0.95), angle: THREE.MathUtils.clamp(finite(h?.angle) ? h.angle : 0, -90, 90),
    gap: THREE.MathUtils.clamp(finite(h?.gap) ? h.gap : 0, -0.01, 0.1),
    rot: Array.isArray(h?.rot) && h.rot.length === 4 && h.rot.every(finite) && Math.hypot(...h.rot) > 1e-6 ? new THREE.Quaternion().fromArray(h.rot).normalize().toArray() : null,
  });
  return { hands: seat?.hands !== false, relax: THREE.MathUtils.clamp(finite(seat?.relax) ? seat.relax : 0.5, 0, 1),
    feet: { left: seat?.feet?.left !== false, right: seat?.feet?.right !== false }, left: hand(seat?.left), right: hand(seat?.right) };
};

export class AnimationEditor {
  constructor(viewer) {
    this.viewer = viewer;
    this.events = new AbortController();
    this.target = new THREE.Vector3(0, viewer.camHeight * 0.55, 0);
    this.zoomFactor = 1;
    this.bones = Object.entries(viewer.vrm.humanoid.rawHumanBones).map(([name, bone]) => [name, bone.node]).filter(([, node]) => node);
    // Poses are stored as normalized humanoid rotations (three-vrm's convention, VRM 0 facing -Z): identity is the
    // rest pose on every avatar, so one animation plays on any skeleton. The converter's output is already
    // normalized (raw == normalized); other VRMs get their rest rotations factored out here.
    viewer.vrm.scene.updateMatrixWorld(true);
    this.vrm1 = viewer.vrm.meta?.metaVersion !== '0';
    this.space = Object.fromEntries(this.bones.map(([name, node]) => {
      const parent = node.parent.getWorldQuaternion(new THREE.Quaternion());
      return [name, { parent, parentInv: parent.clone().invert(), rest: node.quaternion.clone(), restInv: node.quaternion.clone().invert() }];
    }));
    this.restRaw = Object.fromEntries(this.bones.map(([name, node]) => [name, node.quaternion.toArray()]));
    this.rest = Object.fromEntries(this.bones.map(([name]) => [name, [0, 0, 0, 1]]));
    // measured now, in the rest pose: thigh surface, palm and sole of this avatar
    const meshes = [];
    viewer.vrm.scene.traverse((o) => { if (o.isSkinnedMesh) meshes.push(o); });
    this.contacts = new SeatContacts({ root: viewer.vrm.scene, bone: (name) => this.node(name), meshes, vrm1: this.vrm1 });
    this.rootToHips = this.node('hips').getWorldPosition(new THREE.Vector3()).y - viewer.vrm.scene.getWorldPosition(new THREE.Vector3()).y;
    this.chair = chairMesh(this.vrm1);
    this.chair.visible = false;
    viewer.scene.add(this.chair);
    this.keys = [{ time: 0, pose: clone(this.rest) }, { time: 2, pose: clone(this.rest) }];
    // fk: the keyframe pose being edited (what Save pose stores). The avatar shows fk plus the seat contacts,
    // so the IK is visible while posing without ever being baked into the keyframes.
    this.fk = clone(this.rest);
    this.seat = sanitizeSeat(DEFAULT_SEAT);
    this.duration = 2;
    this.time = 0;
    this.playing = false;
    this.active = false;
    this.helper = new THREE.SkeletonHelper(viewer.vrm.scene);
    this.helper.visible = false;
    this.helper.material.depthTest = false;
    this.helper.renderOrder = 10;
    viewer.scene.add(this.helper);
    $('animBone').replaceChildren(...this.bones.map(([name]) => new Option(name.replace(/([A-Z])/g, ' $1'), name)));
    $('animName').value = 'My animation';
    $('animDuration').value = 2;
    $('animLoop').checked = true;
    $('animSkeleton').checked = true;
    $('editBtn').disabled = false;
    $('editBtn').textContent = 'Animation editor';
    const on = (id, event, fn) => $(id).addEventListener(event, fn, { signal: this.events.signal });
    on('editBtn', 'click', () => this.toggle());
    on('animFit', 'click', () => { this.zoomFactor = 1; this.fitAvatar(); });
    on('animFront', 'click', () => { viewer.cam.rotation.set(0, Math.PI, 0, 'YXZ'); this.zoomFactor = 1; this.fitAvatar(); });
    on('animSide', 'click', () => { viewer.cam.rotation.set(0, Math.PI / 2, 0, 'YXZ'); this.zoomFactor = 1; this.fitAvatar(); });
    on('animZoomIn', 'click', () => { this.zoomFactor = Math.max(0.35, this.zoomFactor * 0.85); this.fitDistance(); });
    on('animZoomOut', 'click', () => { this.zoomFactor = Math.min(3, this.zoomFactor / 0.85); this.fitDistance(); });
    // One drawer at a time keeps touch controls compact.
    for (const drawer of $('animationEditor').querySelectorAll('details')) drawer.addEventListener('toggle', () => {
      if (drawer.open) for (const other of $('animationEditor').querySelectorAll('details')) if (other !== drawer) other.open = false;
    }, { signal: this.events.signal });
    on('animBone', 'change', () => this.selectBone($('animBone').value));
    for (const axis of axes) on('anim' + axis, 'input', () => this.rotate());
    on('animReset', 'click', () => { this.checkpoint(); this.pause(); this.fk = clone(this.rest); this.render(); this.refreshRotation(); this.status('Rest pose applied. Save a keyframe to keep it.'); });
    on('animSkeleton', 'change', () => { this.helper.visible = this.active && $('animSkeleton').checked; });
    on('animIK', 'change', () => this.selectBone($('animBone').value));
    on('animChair', 'change', () => {
      this.placeAvatar(); this.render(); this.fitAvatar();
      this.status(this.chairOn() ? 'Chair test: feet go flat on the floor and hands onto the thighs of this avatar; switch avatar to compare.' : 'Chair test off.');
    });
    // seat contacts: the sliders set both hands; one undo step per slider drag
    const seatSlider = (id, apply) => {
      on(id, 'pointerdown', () => { this.seatEdit = false; });
      on(id, 'focus', () => { this.seatEdit = false; });
      on(id, 'input', () => {
        if (!this.seatEdit) { this.seatEdit = true; this.checkpoint(); }
        apply(Number($(id).value)); this.updateSeatUI(); this.render();
      });
    };
    seatSlider('seatAlong', (v) => { for (const s of this.seatSides()) this.seat[s].t = v / 100; });
    seatSlider('seatAround', (v) => { for (const s of this.seatSides()) this.seat[s].angle = v; });
    seatSlider('seatGap', (v) => { for (const s of this.seatSides()) this.seat[s].gap = v / 1000; });
    on('seatSide', 'change', () => this.updateSeatUI());
    // which limbs the contacts drive: each hand onto its thigh, each foot onto the floor
    for (const [id, set] of [['seatFootL', (v) => (this.seat.feet.left = v)], ['seatFootR', (v) => (this.seat.feet.right = v)],
      ['seatHandL', (v) => (this.seat.left.on = v)], ['seatHandR', (v) => (this.seat.right.on = v)]])
      on(id, 'change', () => {
        this.checkpoint(); set($(id).checked); this.render();
        this.status($(id).checked ? 'Contact on.' : 'Contact off: that limb follows the keyframes (pose it freely, e.g. a crossed leg).');
      });
    seatSlider('seatRelax', (v) => { this.seat.relax = v / 100; });
    on('seatCapture', 'click', () => this.captureHands());
    on('seatReset', 'click', () => { this.checkpoint(); this.seat = sanitizeSeat(DEFAULT_SEAT); this.updateSeatUI(); this.render(); this.status('Automatic hands: palms flat at 60% of the thigh.'); });
    on('animPlay', 'click', () => {
      this.playing = !this.playing;
      if (this.playing && this.time >= this.duration) this.time = 0;
      $('animPlay').textContent = this.playing ? 'Pause' : 'Play';
      if (this.playing) this.status('Playing saved keyframes.');
    });
    $('animDurationLabel').textContent = this.duration.toFixed(2);
    for (const id of ['animTime', 'animScrub']) on(id, 'input', () => {
      this.pause(); this.seek(Number($(id).value));
    });
    on('animDuration', 'change', () => {
      const n = Number($('animDuration').value);
      const last = this.keys.at(-1).time;
      if (!finite(n) || n < Math.max(0.1, last) || n > 120) {
        $('animDuration').value = this.duration;
        this.status(`Duration must be between ${Math.max(0.1, last)} and 120 s. Delete later keys to shorten it.`);
        return;
      }
      this.checkpoint(); this.pause(); this.duration = n; this.seek(Math.min(this.time, n));
    });
    on('animKey', 'click', () => {
      this.pause(); this.checkpoint();
      const before = this.sample(this.time), mode = $('animPropagate').value;
      const key = { time: this.time, pose: this.capture() };
      const index = this.keys.findIndex((k) => Math.abs(k.time - this.time) < 0.005);
      if (index < 0) this.keys.push(key); else this.keys[index] = key;
      this.keys.sort((a, b) => a.time - b.time);
      const later = mode ? this.propagate(mode, before, key) : 0;
      this.renderKeys();
      this.status(`Pose saved at ${this.time.toFixed(2)} s` + (later ? (mode === 'copy' ? `, copied to ${later} later keys.` : `, change applied to ${later} later keys.`) : '.'));
    });
    on('animDelete', 'click', () => {
      this.pause();
      if (this.keys.length <= 1) { this.status('Keep at least one keyframe.'); return; }
      const index = this.keys.findIndex((k) => Math.abs(k.time - this.time) < 0.005);
      if (index < 0) { this.status('Select a saved keyframe first.'); return; }
      this.checkpoint(); this.keys.splice(index, 1); this.renderKeys(); this.seek(this.time); this.status('Keyframe deleted.');
    });
    on('animKeys', 'click', (e) => {
      const button = e.target.closest('button[data-time]');
      if (button) { this.pause(); this.seek(Number(button.dataset.time)); }
    });
    on('animExport', 'click', () => this.exportGLB());
    on('animHyperfy', 'click', () => this.exportGLB(true));
    on('animSave', 'click', () => this.download(JSON.stringify(this.project(), null, 2), '.animation.json', 'application/json'));
    on('animLoad', 'click', () => $('animFile').click());
    on('animFile', 'change', async () => {
      const file = $('animFile').files[0];
      $('animFile').value = '';
      if (!file) return;
      try {
        const bytes = await file.arrayBuffer();
        const before = this.state();
        // binary glTF starts with the "glTF" magic
        if (bytes.byteLength >= 4 && new TextDecoder().decode(bytes.slice(0, 4)) === 'glTF') {
          if (file.size > 100e6) throw new Error('GLB exceeds 100 MB.');
          this.status('Importing animation…');
          const message = await this.importGLB(bytes, file.name);
          this.undoStack.push(before); this.redoStack.length = 0; this.updateHistory();
          this.status(message);
        } else {
          if (file.size > 5e6) throw new Error('Project exceeds 5 MB.');
          this.loadProject(JSON.parse(new TextDecoder().decode(bytes)));
          this.undoStack.push(before); this.redoStack.length = 0; this.updateHistory();
          this.status('Project loaded.');
        }
      } catch (error) { this.status('Could not open file: ' + error.message); }
    });
    // undo / redo: every edit pushes the state before it (keyframes, duration, current pose, time)
    this.undoStack = []; this.redoStack = [];
    on('animUndo', 'click', () => this.undo());
    on('animRedo', 'click', () => this.redo());
    addEventListener('keydown', (e) => {
      if (!this.active || !(e.metaKey || e.ctrlKey) || /INPUT|TEXTAREA/.test(e.target.tagName)) return;
      const key = e.key.toLowerCase();
      if (key === 'z' && !e.shiftKey) { e.preventDefault(); this.undo(); }
      else if ((key === 'z' && e.shiftKey) || key === 'y') { e.preventDefault(); this.redo(); }
    }, { signal: this.events.signal });
    // the fine-adjust fields fire on every keystroke: one checkpoint per focus
    for (const axis of axes) on('anim' + axis, 'focus', () => { this.fineEdit = false; });
    this.setupGizmo();
    this.renderKeys();
    this.updateHistory();
  }

  state() { return { keys: clone(this.keys), duration: this.duration, pose: this.capture(), time: this.time, seat: clone(this.seat) }; }
  checkpoint() {
    this.undoStack.push(this.state());
    if (this.undoStack.length > 200) this.undoStack.shift();
    this.redoStack.length = 0;
    this.updateHistory();
  }
  setState(s) {
    this.pause();
    this.keys = clone(s.keys); this.duration = s.duration; $('animDuration').value = s.duration;
    if (s.seat) this.seat = clone(s.seat);
    this.updateSeatUI();
    this.renderKeys(); this.seek(s.time);
    this.fk = clone(s.pose); this.render(); this.refreshRotation(); // the pose may hold unsaved changes, so not just the sampled one
  }

  // Save pose with "later keys": 'delta' applies this edit (new vs. what the keys gave here) on top of every
  // later key, keeping their own motion; 'copy' replaces them with this pose plus the natural variation.
  propagate(mode, before, key) {
    const later = this.keys.filter((k) => k.time > key.time + 0.005);
    const amount = THREE.MathUtils.clamp(Number($('animVary').value) || 0, 0, 10);
    const q = new THREE.Quaternion(), d = new THREE.Quaternion(), e = new THREE.Euler();
    for (const k of later) for (const [name] of this.bones) {
      const now = q.fromArray(key.pose[name] || this.rest[name]);
      if (mode === 'delta') {
        d.copy(now).multiply(new THREE.Quaternion().fromArray(before[name] || this.rest[name]).invert());
        k.pose[name] = d.multiply(new THREE.Quaternion().fromArray(k.pose[name] || this.rest[name])).normalize().toArray();
      } else {
        const v = VARIATION[name], dt = k.time - key.time;
        if (v && amount) {
          const b = Math.sin(2 * Math.PI * dt / 4.2), s = Math.sin(2 * Math.PI * dt / 7.3);
          e.set(...[0, 1, 2].map((i) => (v[0][i] * b + v[1][i] * s) * amount * DEG));
          k.pose[name] = d.setFromEuler(e).multiply(now).normalize().toArray();
        } else k.pose[name] = now.toArray();
      }
    }
    return later.length;
  }

  // "Use current hand pose": where the keyframe pose puts each hand relative to its thigh becomes the rule
  captureHands() {
    if (!this.chairOn()) { this.status('Turn Chair test on first.'); return; }
    this.checkpoint();
    this.apply(this.fk);
    this.contacts.solve({ floorY: 0, seat: { ...this.seat, hands: false } }); // feet as set, hands as posed
    for (const s of this.seatSides()) { const m = this.contacts.measureHand(s); if (m) this.seat[s] = { ...m, on: true }; }
    this.seat.hands = true; this.seat.relax = 0; // the fingers are as posed
    this.seat = sanitizeSeat(this.seat);
    this.updateSeatUI(); this.render();
    this.status('Hand placement saved: every avatar puts its hands on this spot of its own thighs.');
  }

  // sides the hand sliders and "use current hand pose" act on
  seatSides() { const v = $('seatSide').value; return v === 'left' ? ['left'] : v === 'right' ? ['right'] : ['left', 'right']; }

  updateSeatUI() {
    const h = this.seat[this.seatSides()[0]];
    $('seatFootL').checked = this.seat.feet.left; $('seatFootR').checked = this.seat.feet.right;
    $('seatHandL').checked = this.seat.left.on; $('seatHandR').checked = this.seat.right.on;
    $('seatAlong').value = Math.round(h.t * 100); $('seatAlongOut').textContent = Math.round(h.t * 100) + '%';
    $('seatAround').value = Math.round(h.angle); $('seatAroundOut').textContent = Math.round(h.angle) + '°';
    $('seatGap').value = Math.round(h.gap * 1000); $('seatGapOut').textContent = Math.round(h.gap * 1000) + ' mm';
    $('seatRelax').value = Math.round(this.seat.relax * 100); $('seatRelaxOut').textContent = Math.round(this.seat.relax * 100) + '%';
  }
  undo() {
    if (!this.undoStack.length) { this.status('Nothing to undo.'); return; }
    this.redoStack.push(this.state()); this.setState(this.undoStack.pop()); this.updateHistory(); this.status('Undone.');
  }
  redo() {
    if (!this.redoStack.length) { this.status('Nothing to redo.'); return; }
    this.undoStack.push(this.state()); this.setState(this.redoStack.pop()); this.updateHistory(); this.status('Redone.');
  }
  updateHistory() { $('animUndo').disabled = !this.undoStack.length; $('animRedo').disabled = !this.redoStack.length; }

  fitAvatar() {
    const scene = this.viewer.vrm.scene;
    scene.updateMatrixWorld(true);
    const bounds = new THREE.Box3().setFromObject(scene, true);
    if (bounds.isEmpty()) return;
    bounds.getCenter(this.target);
    this.fitSize = bounds.getSize(new THREE.Vector3());
    this.fitDistance();
  }

  fitDistance() {
    if (!this.active || !this.fitSize) return;
    const v = this.viewer, fov = Math.tan(v.camera.fov * Math.PI / 360);
    // Width/depth swap smoothly when orbiting from the front to the side.
    const yaw = v.cam.rotation.y;
    const width = Math.abs(Math.cos(yaw)) * this.fitSize.x + Math.abs(Math.sin(yaw)) * this.fitSize.z;
    const depth = Math.abs(Math.sin(yaw)) * this.fitSize.x + Math.abs(Math.cos(yaw)) * this.fitSize.z;
    const portrait = innerWidth <= 700 && innerHeight >= innerWidth;
    const verticalMargin = portrait ? 1.1 * v.stage.clientHeight / Math.max(100, v.stage.clientHeight - 90) : 1.24;
    const distance = Math.max(this.fitSize.y / (2 * fov) * verticalMargin, width / (2 * fov * v.camera.aspect) * 1.24) + depth * 0.5;
    v.cam.zoom = Math.max(0.6, distance * this.zoomFactor);
  }

  setupGizmo() {
    const v = this.viewer;
    this.transform = new TransformControls(v.camera, v.renderer.domElement);
    this.transform.setMode('rotate');
    this.transform.setSpace('local');
    this.transform.setSize(0.7);
    this.transform.enabled = false;
    this.gizmo = this.transform.getHelper();
    v.scene.add(this.gizmo);
    this.transform.addEventListener('dragging-changed', ({ value }) => {
      v.drag = null;
      if (value) { this.pause(); this.checkpoint(); }
    });
    this.transform.addEventListener('objectChange', () => {
      if (this.transform.object === this.ikTarget) {
        this.solveIK(this.ikChain, this.ikTarget.position);
        this.syncFk(this.ikChainNames);
      } else this.syncFk([$('animBone').value]);
      this.render();
      this.refreshRotation();
      this.status('Pose changed. Save a keyframe to keep it.');
    });
    this.joints = new THREE.Group();
    this.joints.visible = false;
    this.jointGeometry = new THREE.SphereGeometry(0.018, 12, 8);
    this.jointMaterial = new THREE.MeshBasicMaterial({ color: '#3d5afe', depthTest: false, transparent: true, opacity: 0.85 });
    this.selectedMaterial = new THREE.MeshBasicMaterial({ color: '#ffad19', depthTest: false });
    this.ikMaterial = new THREE.MeshBasicMaterial({ color: '#1fb86a', depthTest: false, transparent: true, opacity: 0.9 });
    // the translate gizmo drags this point; solveIK makes the limb reach it
    this.ikTarget = new THREE.Object3D();
    this.ikTarget.name = 'IK target';
    v.scene.add(this.ikTarget);
    // only chains whose three bones all exist on this avatar
    this.ikChains = Object.fromEntries(Object.entries(IK_CHAINS)
      .map(([end, [a, b, c, hint]]) => [end, [this.node(a), this.node(b), this.node(c), hint]])
      .filter(([, chain]) => chain.slice(0, 3).every(Boolean)));
    this.markers = [];
    for (const [name, node] of this.bones) {
      if (/Thumb|Index|Middle|Ring|Little|Eye|Toes/.test(name)) continue;
      const marker = new THREE.Mesh(this.jointGeometry, this.jointMaterial);
      marker.userData = { boneName: name, node };
      marker.renderOrder = 20;
      this.joints.add(marker); this.markers.push(marker);
    }
    v.scene.add(this.joints);
    this.pickPoint = new THREE.Vector3();
    this.selectBone(this.bones.some(([name]) => name === 'leftUpperArm') ? 'leftUpperArm' : this.bones[0][0]);
  }

  node(name) { return this.bones.find(([key]) => key === name)?.[1]; }
  ikOn() { return $('animIK').checked; }
  chairOn() { return $('animChair').checked; }

  // standing on the grid, or seated like Hyperfy does: pelvis 8 cm above the seat, floor at y = 0
  placeAvatar() {
    const v = this.viewer, seated = this.active && this.chairOn();
    v.base.position.set(0, seated ? SEAT_HEIGHT + 0.08 - this.rootToHips : 0, 0);
    v.base.quaternion.identity();
    this.chair.visible = seated;
    v.scene.updateMatrixWorld(true);
  }

  // what the avatar shows: the keyframe pose, plus the seat contacts with Chair test on
  render() {
    this.apply(this.fk);
    if (this.active && this.chairOn()) this.contacts.solve({ floorY: 0, seat: this.seat });
    this.viewer.vrm.scene.updateMatrixWorld(true);
  }
  // copy edited bones from the displayed avatar into the keyframe pose
  syncFk(names) { for (const name of names) { const node = this.node(name); if (node) this.fk[name] = this.toNorm(name, node.quaternion).toArray(); } }

  selectBone(name) {
    const node = this.node(name);
    if (!node) return;
    $('animBone').value = name;
    $('selectedJointLabel').textContent = name.replace(/([A-Z])/g, ' $1').replace(/^./, (s) => s.toUpperCase());
    this.ikChain = this.ikOn() ? this.ikChains[name] : null;
    this.ikChainNames = this.ikChain ? IK_CHAINS[name].slice(0, 3) : null;
    if (this.ikChain) {
      this.transform.setMode('translate'); this.transform.setSpace('world');
      node.getWorldPosition(this.ikTarget.position);
      if (this.active) this.transform.attach(this.ikTarget);
    } else {
      this.transform.setMode('rotate'); this.transform.setSpace('local');
      if (this.active) this.transform.attach(node);
    }
    for (const marker of this.markers) {
      const bone = marker.userData.boneName;
      marker.material = bone === name ? this.selectedMaterial : this.ikOn() && this.ikChains[bone] ? this.ikMaterial : this.jointMaterial;
      marker.scale.setScalar(bone === name ? 1.4 : 1);
    }
    this.refreshRotation();
    this.status(this.ikChain
      ? `IK: drag the arrows to move the ${/Hand/.test(name) ? 'hand, the arm' : 'foot, the leg'} follows. Turn IK off to rotate it.`
      : 'Drag a colored ring to rotate this joint. Drag the background to turn the camera.');
  }

  // Manual IK (dragging a hand or foot): same solver as the runtime contacts, see contact-ik.js.
  solveIK([upper, lower, end, hint], target) {
    const forward = new THREE.Vector3(0, 0, this.vrm1 ? 1 : -1).applyQuaternion(this.viewer.vrm.scene.getWorldQuaternion(tq));
    solveTwoBone(upper, lower, end, target, hint === 'front' ? forward : forward.negate());
  }


  // Called before the camera starts dragging, including on touch devices.
  handlePointerDown(event) {
    if (!this.active || this.playing || event.button !== 0) return false;
    const v = this.viewer;
    v.scene.updateMatrixWorld(true);
    const rect = v.renderer.domElement.getBoundingClientRect();
    const point = { x: (event.clientX - rect.left) / rect.width * 2 - 1, y: -(event.clientY - rect.top) / rect.height * 2 + 1, button: event.button };
    // Joints win over the rotation rings: a joint under a ring stays selectable, and the
    // rings remain draggable anywhere else along them. The selected joint itself is skipped
    // so a press on its center still grabs the gizmo.
    let nearest = null, distance = event.pointerType === 'touch' ? 24 : 14;
    for (const marker of this.markers) {
      if (marker.userData.boneName === $('animBone').value) continue;
      marker.userData.node.getWorldPosition(this.pickPoint).project(v.camera);
      if (Math.abs(this.pickPoint.z) > 1) continue;
      const x = rect.left + (this.pickPoint.x + 1) * rect.width / 2;
      const y = rect.top + (1 - this.pickPoint.y) * rect.height / 2;
      const d = Math.hypot(event.clientX - x, event.clientY - y);
      if (d < distance) { nearest = marker; distance = d; }
    }
    if (nearest) {
      // the viewer's listener runs before TransformControls' own: stop it here, or it would grab
      // the ring under the pointer and rotate the newly selected joint
      event.stopImmediatePropagation();
      this.pause(); this.selectBone(nearest.userData.boneName);
      return true;
    }
    this.transform.pointerHover(point);
    return !!this.transform.axis;
  }

  syncGizmo() {
    this.viewer.vrm.scene.updateMatrixWorld(true);
    for (const marker of this.markers) marker.userData.node.getWorldPosition(marker.position);
    // keep the IK handle on the hand/foot while scrubbing or playing (not while it is being dragged)
    if (this.ikChain && !this.transform.dragging) this.ikChain[2].getWorldPosition(this.ikTarget.position);
    this.transform.enabled = this.active && !this.playing;
    this.transform.visible = this.active && !this.playing;
  }

  project() { return clone({ format: 'glbtovrm-animation', version: 1, name: $('animName').value, duration: this.duration, loop: $('animLoop').checked, keys: this.keys, seat: this.seat }); }

  // VRM 1 faces +Z: turn its rotations 180° around Y into the VRM 0 frame (and back; the flip is its own inverse)
  frame(q) { if (this.vrm1) { q.x = -q.x; q.z = -q.z; } return q; }
  toNorm(name, raw) { const s = this.space[name]; return this.frame(raw.clone().premultiply(s.parent).multiply(s.restInv).multiply(s.parentInv)); }
  fromNorm(name, norm) { const s = this.space[name]; return this.frame(norm.clone()).premultiply(s.parentInv).multiply(s.parent).multiply(s.rest); }
  capture() { return clone(this.fk); }
  apply(pose) { for (const [name, node] of this.bones) node.quaternion.copy(this.fromNorm(name, new THREE.Quaternion().fromArray(pose[name] || this.rest[name]))); }

  // editor state carried across an avatar switch (see Viewer.open)
  snapshot() {
    return { project: this.project(), active: this.active, time: this.time, playing: this.playing, bone: $('animBone').value,
      cam: this.active ? this.viewer.cam.rotation.toArray() : null, zoomFactor: this.zoomFactor,
      undo: this.undoStack, redo: this.redoStack };
  }
  restore(state) {
    const missing = this.loadProject(state.project);
    // history poses are normalized too, so they stay valid on the new avatar
    this.undoStack = state.undo || []; this.redoStack = state.redo || []; this.updateHistory();
    if (state.active) {
      this.toggle();
      if (state.cam) { this.viewer.cam.rotation.fromArray(state.cam); this.zoomFactor = state.zoomFactor; this.fitAvatar(); }
    }
    if (this.bones.some(([name]) => name === state.bone)) this.selectBone(state.bone);
    this.seek(state.time);
    if (state.playing && this.active) { this.playing = true; $('animPlay').textContent = 'Pause'; }
    const note = missing.length ? `This avatar has no ${missing.join(', ')}: those tracks are skipped.` : '';
    this.status(note || 'Same animation, new avatar. Check hands, feet and contacts.');
    return note;
  }
  pause() { this.playing = false; $('animPlay').textContent = 'Play'; }
  status(message) { $('animStatus').textContent = message; }

  toggle() {
    this.active = !this.active;
    this.pause();
    const v = this.viewer;
    v.keys.clear(); v.stick = null; v.drag = null; v.jumpQueued = false;
    $('animationEditor').hidden = !this.active;
    $('editorTimeline').hidden = !this.active;
    $('studioOverlay').hidden = !this.active;
    v.stage.closest('.window').classList.toggle('is-editing', this.active);
    v.camera.fov = this.active ? 40 : 70;
    v.camera.updateProjectionMatrix();
    v.stage.querySelector('.help').hidden = this.active;
    $('vJump').hidden = this.active;
    $('editBtn').textContent = this.active ? 'Back to walking' : 'Animation editor';
    this.helper.visible = this.active && $('animSkeleton').checked;
    this.joints.visible = this.active;
    this.transform.enabled = this.active;
    if (this.active) {
      v.mixer.stopAllAction();
      this.placeAvatar();
      this.updateSeatUI();
      v.neck.scale.setScalar(1); v.firstPerson = false;
      v.shadow.position.set(0, 0.002, 0); v.shadow.scale.setScalar(1); v.shadow.material.opacity = 0.35;
      v.cam.rotation.set(0, Math.PI, 0, 'YXZ'); this.zoomFactor = 1;
      v.vrm.expressionManager?.resetValues(); v.vrm.expressionManager?.update();
      this.seek(this.time);
      this.selectBone($('animBone').value);
      this.status('Click a blue joint, drag a colored ring, then save the pose keyframe.');
    } else {
      this.transform.detach();
      this.apply(this.rest);
      this.placeAvatar();
      for (const pose of Object.values(v.poses)) { pose.weight = 0; pose.active = false; pose.action.reset().play(); pose.action.weight = 0; }
      v.player.vel.set(0, 0, 0); v.player.vy = 0; v.player.grounded = true;
      v.player.jumped = v.player.jumping = v.player.falling = false;
    }
    v.resize();
    if (this.active) this.fitAvatar();
  }

  refreshRotation() {
    const node = this.bones.find(([name]) => name === $('animBone').value)?.[1];
    if (!node) return;
    const euler = new THREE.Euler().setFromQuaternion(new THREE.Quaternion().fromArray(this.fk[$('animBone').value] || [0, 0, 0, 1]), 'XYZ');
    axes.forEach((axis) => { $('anim' + axis).value = (euler[axis.toLowerCase()] * 180 / Math.PI).toFixed(1); });
  }

  rotate() {
    const values = axes.map((axis) => Number($('anim' + axis).value));
    if (values.some((v) => !finite(v) || Math.abs(v) > 180)) return;
    this.pause();
    if (!this.fineEdit) { this.fineEdit = true; this.checkpoint(); }
    const name = $('animBone').value;
    this.fk[name] = new THREE.Quaternion().setFromEuler(new THREE.Euler(...values.map((v) => v * Math.PI / 180), 'XYZ')).toArray();
    this.render();
    this.status('Pose changed. Save a keyframe to keep these changes.');
  }

  sample(time) {
    let a = this.keys[0], b = this.keys.at(-1);
    if (time <= a.time) return a.pose;
    if (time >= b.time) return b.pose;
    for (let i = 1; i < this.keys.length; i++) if (this.keys[i].time >= time) { a = this.keys[i - 1]; b = this.keys[i]; break; }
    const t = (time - a.time) / (b.time - a.time);
    return Object.fromEntries(this.bones.map(([name]) => [name, new THREE.Quaternion().fromArray(a.pose[name] || this.rest[name]).slerp(new THREE.Quaternion().fromArray(b.pose[name] || this.rest[name]), t).toArray()]));
  }

  seek(time) {
    this.time = Math.round(THREE.MathUtils.clamp(finite(time) ? time : 0, 0, this.duration) * 1000) / 1000;
    this.fk = clone(this.sample(this.time));
    this.render();
    $('animDurationLabel').textContent = this.duration.toFixed(2);
    for (const id of ['animTime', 'animScrub']) { $(id).max = this.duration; $(id).value = this.time; }
    this.refreshRotation();
    for (const button of $('animKeys').children) button.setAttribute('aria-pressed', String(Math.abs(Number(button.dataset.time) - this.time) < 0.005));
  }

  update(delta) {
    this.syncGizmo();
    if (!this.playing) return;
    let next = this.time + delta;
    if (next >= this.duration) {
      if ($('animLoop').checked) next %= this.duration;
      else { next = this.duration; this.pause(); }
    }
    this.seek(next);
  }

  renderKeys() {
    $('animKeys').replaceChildren(...this.keys.map((key) => {
      const button = document.createElement('button');
      button.type = 'button'; button.className = 'btn small'; button.dataset.time = key.time;
      button.textContent = `${key.time.toFixed(2)} s`; button.setAttribute('aria-pressed', String(Math.abs(key.time - this.time) < 0.005));
      return button;
    }));
  }

  loadProject(data) {
    if (data.format !== 'glbtovrm-animation' || data.version !== 1 || !finite(data.duration) || data.duration < 0.1 || data.duration > 120 || !Array.isArray(data.keys) || !data.keys.length || data.keys.length > 2000) throw new Error('Invalid animation project.');
    // Bones the project lacks (e.g. made on an avatar without upperChest or eyes) stay at rest;
    // bones this avatar lacks are dropped and reported, so the caller can warn.
    const bones = new Set(this.bones.map(([name]) => name)), missing = new Set();
    const keys = data.keys.map((key) => {
      if (!finite(key.time) || key.time < 0 || key.time > data.duration || !key.pose || typeof key.pose !== 'object') throw new Error('Invalid keyframe.');
      const pose = {};
      for (const [name, q] of Object.entries(key.pose)) {
        if (!Array.isArray(q) || q.length !== 4 || !q.every(finite) || Math.hypot(...q) < 1e-6) throw new Error('Project contains an invalid rotation.');
        if (bones.has(name)) pose[name] = new THREE.Quaternion().fromArray(q).normalize().toArray();
        else if (!/Eye$/.test(name) && !new THREE.Quaternion().fromArray(q).normalize().equals(new THREE.Quaternion())) missing.add(name);
      }
      for (const name of bones) pose[name] ??= [...this.rest[name]];
      return { time: key.time, pose };
    }).sort((a, b) => a.time - b.time);
    if (keys.some((k, i) => i && k.time - keys[i - 1].time < 0.005)) throw new Error('Keyframe times must be distinct.');
    this.pause(); this.keys = keys; this.duration = data.duration;
    this.seat = sanitizeSeat(data.seat ?? DEFAULT_SEAT); this.updateSeatUI();
    $('animName').value = typeof data.name === 'string' ? data.name.slice(0, 80) : 'My animation';
    $('animDuration').value = this.duration; $('animLoop').checked = !!data.loop;
    this.renderKeys(); this.seek(0);
    return [...missing].map((name) => name.replace(/([A-Z])/g, ' $1').toLowerCase());
  }

  // Turns an animation GLB into editable keyframes. Accepted: this editor's own exports
  // (raw-bone or Hyperfy flavour) and Mixamo-rigged clips such as Hyperfy emotes.
  async importGLB(bytes, fileName) {
    const glb = await new GLTFLoader().parseAsync(bytes, '');
    const clip = glb.animations[0];
    if (!clip) throw new Error('the GLB contains no animation.');
    const info = glb.scene.userData || {};
    const byNode = new Map(this.bones.map(([name, node]) => [node.name, name]));
    const human = new Set(this.bones.map(([name]) => name));
    const tracks = new Map(); // humanoid bone -> [quaternion track, flip X/Z]
    // convert: 'raw' = raw-bone rotations of this avatar, 'flip' = Hyperfy export (X/Z negated), 'frame' = normalized in this avatar's frame
    const add = (bone, track, convert = 'raw') => { if (bone && human.has(bone)) tracks.set(bone, [track, convert]); };
    const quaternions = (c) => c.tracks.filter((t) => t.name.endsWith('.quaternion')).map((t) => [t.name.slice(0, -'.quaternion'.length), t]);
    if (info.animationEditor === 'GLBtoVRM' && info.coordinateSystem === 'VRM 0 raw bones') {
      for (const [node, track] of quaternions(clip)) add(byNode.get(node), track);
    } else if (info.animationEditor === 'GLBtoVRM') {
      // undo the Hyperfy export: thumb renaming and X/Z quaternion flip
      const importName = (n) => n.replace(/Thumb(Proximal|Intermediate)$/, (_, p) => p === 'Proximal' ? 'ThumbMetacarpal' : 'ThumbProximal');
      for (const [node, track] of quaternions(clip)) add(importName(node), track, 'flip');
    } else {
      // Mixamo rig: retarget to this avatar exactly as the walk/run emotes are
      const raw = (b) => this.viewer.vrm.humanoid.getRawBoneNode(b);
      const retargeted = createEmoteFactory(glb).toClip({ rootToHips: 1, version: this.viewer.vrm.meta?.metaVersion, getBoneName: (b) => raw(b)?.name });
      for (const [node, track] of quaternions(retargeted)) add(byNode.get(node), track, 'frame');
    }
    if (tracks.size < 5) throw new Error('no humanoid bones recognized. Use a Mixamo-rigged animation or a GLB exported by this editor.');
    const duration = Math.min(120, Math.round(clip.duration * 1000) / 1000);
    if (!(duration >= 0.1)) throw new Error('the animation is shorter than 0.1 s.');
    // Keep the clip's own key times when sparse; dense mocap is resampled to at most 30 keys per second.
    const steps = Math.min(1999, Math.max(1, Math.round(duration * 30)));
    const native = [...new Set([...tracks.values()].flatMap(([t]) => [...t.times].map((x) => Math.round(x * 1000) / 1000)))].filter((x) => x >= 0 && x <= duration);
    let times = native.length <= steps + 1 ? [...new Set([0, ...native, duration])] : Array.from({ length: steps + 1 }, (_, i) => Math.round(i * duration / steps * 1000) / 1000);
    times = times.sort((a, b) => a - b).filter((t, i, all) => i === 0 || t - all[i - 1] >= 0.005);
    const interpolants = [...tracks].map(([bone, [track, convert]]) => [bone, track.createInterpolant(), convert]);
    const keys = times.map((time) => {
      const pose = clone(this.rest);
      for (const [bone, interpolant, convert] of interpolants) {
        const q = new THREE.Quaternion().fromArray(interpolant.evaluate(time)).normalize();
        if (convert === 'flip') { q.x = -q.x; q.z = -q.z; }
        pose[bone] = (convert === 'raw' ? this.toNorm(bone, q) : convert === 'frame' ? this.frame(q) : q).toArray();
      }
      return { time, pose };
    });
    const name = (clip.name && clip.name !== 'Take 001' && !/^mixamo\.com$/i.test(clip.name) ? clip.name : fileName.replace(/(\.hyperfy)?\.glb$/i, '')).slice(0, 80);
    this.loadProject({ format: 'glbtovrm-animation', version: 1, name, duration, loop: info.loop ?? true, keys, seat: info.seatContacts });
    const notes = [];
    if (glb.animations.length > 1) notes.push(`only the first of ${glb.animations.length} clips was imported`);
    if (clip.duration > 120) notes.push('trimmed to 120 s');
    if (clip.tracks.some((t) => t.name.endsWith('.position'))) notes.push('hips movement is not editable yet (rotations only)');
    return `Imported ${tracks.size} bones, ${keys.length} keyframes.` + (notes.length ? ' Note: ' + notes.join('; ') + '.' : '');
  }

  async exportGLB(hyperfy = false) {
    this.pause(); $('animExport').disabled = $('animHyperfy').disabled = true;
    try {
      // Copy the full bone ancestry (including non-humanoid twist bones), without avatar meshes/textures.
      const scene = new THREE.Scene(), nodes = new Map();
      const copy = (source) => {
        if (source === this.viewer.vrm.scene) return scene;
        if (nodes.has(source)) return nodes.get(source);
        const node = new THREE.Object3D();
        node.name = source.name; node.position.copy(source.position); node.quaternion.copy(source.quaternion); node.scale.copy(source.scale);
        nodes.set(source, node); copy(source.parent).add(node);
        return node;
      };
      const humanNames = new Map(this.bones.map(([name, source]) => [source, name]));
      const exportName = (name) => name.replace(/ThumbProximal$/, 'ThumbIntermediate').replace(/ThumbMetacarpal$/, 'ThumbProximal');
      const tracks = [];
      const times = [...new Set([0, ...this.keys.map((k) => k.time), this.duration])].sort((a, b) => a - b);
      for (const [name, source] of this.bones) {
        // Hyperfy maps normalized humanoid names and flips X/Z quaternion components for VRM 0.
        // Eye bones are absent from its emote map, so omit their tracks.
        if (hyperfy && /Eye$/.test(name)) continue;
        const node = copy(source); node.quaternion.fromArray(this.restRaw[name]);
        tracks.push(new THREE.QuaternionKeyframeTrack(`${node.uuid}.quaternion`, times, times.flatMap((time) => this.fromNorm(name, new THREE.Quaternion().fromArray(this.sample(time)[name])).toArray().map((v, i) => hyperfy && i % 2 === 0 ? -v : v))));
      }
      if (hyperfy) for (const [source, node] of nodes) {
        if (humanNames.has(source)) node.name = exportName(humanNames.get(source));
        node.position.x *= -1; node.position.z *= -1;
        node.quaternion.x *= -1; node.quaternion.z *= -1;
      }
      // seatContacts: hand placement for the runtime contact IK (contact-ik.js), read by the player
      scene.userData = { animationEditor: 'GLBtoVRM', coordinateSystem: hyperfy ? 'Hyperfy normalized humanoid' : 'VRM 0 raw bones', loop: $('animLoop').checked, seatContacts: this.seat };
      const clip = new THREE.AnimationClip($('animName').value.trim() || 'Animation', this.duration, tracks);
      const bytes = await new GLTFExporter().parseAsync(scene, { binary: true, animations: [clip], onlyVisible: false });
      this.download(bytes, hyperfy ? '.hyperfy.glb' : '.glb', 'model/gltf-binary');
      this.status(hyperfy ? 'Hyperfy emote downloaded.' : 'Animation GLB downloaded (skeleton + animation, without avatar mesh).');
    } catch (error) { this.status('Export failed: ' + error.message); }
    finally { $('animExport').disabled = $('animHyperfy').disabled = false; }
  }

  download(data, extension, type) {
    const url = URL.createObjectURL(new Blob([data], { type }));
    const link = document.createElement('a'); link.href = url;
    link.download = ($('animName').value.trim().replace(/[^\p{L}\p{N}_ -]/gu, '').slice(0, 80) || 'animation') + extension;
    link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  dispose() {
    this.transform.detach(); this.transform.dispose(); this.gizmo.removeFromParent();
    this.joints.removeFromParent(); this.jointGeometry.dispose(); this.jointMaterial.dispose(); this.selectedMaterial.dispose(); this.ikMaterial.dispose();
    this.ikTarget.removeFromParent();
    this.chair.removeFromParent(); this.chair.traverse((o) => { o.geometry?.dispose(); o.material?.dispose(); });
    this.pause(); this.events.abort(); this.helper.removeFromParent(); this.helper.dispose();
    $('animationEditor').hidden = true; $('editBtn').disabled = true;
    $('editorTimeline').hidden = true; $('studioOverlay').hidden = true;
    this.viewer.stage.closest('.window').classList.remove('is-editing');
    this.viewer.camera.fov = 70; this.viewer.camera.updateProjectionMatrix();
    this.viewer.stage.querySelector('.help').hidden = false; $('vJump').hidden = false;
  }
}

// a plain chair: seat top at SEAT_HEIGHT under the pelvis, backrest behind the avatar (VRM 0 faces -Z)
function chairMesh(vrm1) {
  const group = new THREE.Group(), material = new THREE.MeshStandardMaterial({ color: '#b9c2cf', roughness: 0.8 });
  const box = (w, h, d, x, y, z) => { const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material); m.position.set(x, y, z); group.add(m); };
  box(0.5, 0.05, 0.46, 0, SEAT_HEIGHT - 0.025, -0.08); // seat
  box(0.5, 0.5, 0.05, 0, SEAT_HEIGHT + 0.25, 0.17); // backrest
  for (const x of [-0.22, 0.22]) for (const z of [-0.28, 0.12]) box(0.04, SEAT_HEIGHT - 0.05, 0.04, x, (SEAT_HEIGHT - 0.05) / 2, z);
  if (vrm1) group.rotation.y = Math.PI;
  return group;
}
