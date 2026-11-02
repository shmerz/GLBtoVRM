import * as THREE from 'three';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { createEmoteFactory } from './emotes.js';

const $ = (id) => document.getElementById(id);
const axes = ['X', 'Y', 'Z'];
const clone = (value) => JSON.parse(JSON.stringify(value));
const finite = (n) => typeof n === 'number' && Number.isFinite(n);

export class AnimationEditor {
  constructor(viewer) {
    this.viewer = viewer;
    this.events = new AbortController();
    this.target = new THREE.Vector3(0, viewer.camHeight * 0.55, 0);
    this.zoomFactor = 1;
    this.bones = Object.entries(viewer.vrm.humanoid.rawHumanBones).map(([name, bone]) => [name, bone.node]).filter(([, node]) => node);
    this.rest = this.capture();
    this.keys = [{ time: 0, pose: clone(this.rest) }, { time: 2, pose: clone(this.rest) }];
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
    on('animReset', 'click', () => { this.pause(); this.apply(this.rest); this.refreshRotation(); this.status('Rest pose applied. Save a keyframe to keep it.'); });
    on('animSkeleton', 'change', () => { this.helper.visible = this.active && $('animSkeleton').checked; });
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
      this.pause(); this.duration = n; this.seek(Math.min(this.time, n));
    });
    on('animKey', 'click', () => {
      this.pause();
      const key = { time: this.time, pose: this.capture() };
      const index = this.keys.findIndex((k) => Math.abs(k.time - this.time) < 0.005);
      if (index < 0) this.keys.push(key); else this.keys[index] = key;
      this.keys.sort((a, b) => a.time - b.time);
      this.renderKeys(); this.status(`Pose saved at ${this.time.toFixed(2)} s.`);
    });
    on('animDelete', 'click', () => {
      this.pause();
      if (this.keys.length <= 1) { this.status('Keep at least one keyframe.'); return; }
      const index = this.keys.findIndex((k) => Math.abs(k.time - this.time) < 0.005);
      if (index < 0) { this.status('Select a saved keyframe first.'); return; }
      this.keys.splice(index, 1); this.renderKeys(); this.seek(this.time); this.status('Keyframe deleted.');
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
        // binary glTF starts with the "glTF" magic
        if (bytes.byteLength >= 4 && new TextDecoder().decode(bytes.slice(0, 4)) === 'glTF') {
          if (file.size > 100e6) throw new Error('GLB exceeds 100 MB.');
          this.status('Importing animation…');
          this.status(await this.importGLB(bytes, file.name));
        } else {
          if (file.size > 5e6) throw new Error('Project exceeds 5 MB.');
          this.loadProject(JSON.parse(new TextDecoder().decode(bytes)));
          this.status('Project loaded.');
        }
      } catch (error) { this.status('Could not open file: ' + error.message); }
    });
    this.setupGizmo();
    this.renderKeys();
  }

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
      if (value) this.pause();
    });
    this.transform.addEventListener('objectChange', () => {
      this.refreshRotation();
      this.status('Pose changed. Save a keyframe to keep it.');
    });
    this.joints = new THREE.Group();
    this.joints.visible = false;
    this.jointGeometry = new THREE.SphereGeometry(0.018, 12, 8);
    this.jointMaterial = new THREE.MeshBasicMaterial({ color: '#3d5afe', depthTest: false, transparent: true, opacity: 0.85 });
    this.selectedMaterial = new THREE.MeshBasicMaterial({ color: '#ffad19', depthTest: false });
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

  selectBone(name) {
    const node = this.bones.find(([key]) => key === name)?.[1];
    if (!node) return;
    $('animBone').value = name;
    $('selectedJointLabel').textContent = name.replace(/([A-Z])/g, ' $1').replace(/^./, (s) => s.toUpperCase());
    if (this.active) this.transform.attach(node);
    for (const marker of this.markers) {
      marker.material = marker.userData.boneName === name ? this.selectedMaterial : this.jointMaterial;
      marker.scale.setScalar(marker.userData.boneName === name ? 1.4 : 1);
    }
    this.refreshRotation();
    this.status('Drag a colored ring to rotate this joint. Drag the background to turn the camera.');
  }

  // Called before the camera starts dragging, including on touch devices.
  handlePointerDown(event) {
    if (!this.active || this.playing || event.button !== 0) return false;
    const v = this.viewer;
    v.scene.updateMatrixWorld(true);
    const rect = v.renderer.domElement.getBoundingClientRect();
    const point = { x: (event.clientX - rect.left) / rect.width * 2 - 1, y: -(event.clientY - rect.top) / rect.height * 2 + 1, button: event.button };
    this.transform.pointerHover(point);
    if (this.transform.axis) return true;
    // Use a generous screen-space hit area even when the avatar is zoomed out.
    let nearest = null, distance = event.pointerType === 'touch' ? 24 : 14;
    for (const marker of this.markers) {
      marker.userData.node.getWorldPosition(this.pickPoint).project(v.camera);
      if (Math.abs(this.pickPoint.z) > 1) continue;
      const x = rect.left + (this.pickPoint.x + 1) * rect.width / 2;
      const y = rect.top + (1 - this.pickPoint.y) * rect.height / 2;
      const d = Math.hypot(event.clientX - x, event.clientY - y);
      if (d < distance) { nearest = marker; distance = d; }
    }
    if (nearest) { this.pause(); this.selectBone(nearest.userData.boneName); return true; }
    return false;
  }

  syncGizmo() {
    this.viewer.vrm.scene.updateMatrixWorld(true);
    for (const marker of this.markers) marker.userData.node.getWorldPosition(marker.position);
    this.transform.enabled = this.active && !this.playing;
    this.transform.visible = this.active && !this.playing;
  }

  project() { return clone({ format: 'glbtovrm-animation', version: 1, name: $('animName').value, duration: this.duration, loop: $('animLoop').checked, keys: this.keys }); }

  capture() { return Object.fromEntries(this.bones.map(([name, node]) => [name, node.quaternion.toArray()])); }
  apply(pose) { for (const [name, node] of this.bones) node.quaternion.fromArray(pose[name] || this.rest[name]); }
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
      v.base.position.set(0, 0, 0); v.base.quaternion.identity();
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
    const euler = new THREE.Euler().setFromQuaternion(node.quaternion, 'XYZ');
    axes.forEach((axis) => { $('anim' + axis).value = (euler[axis.toLowerCase()] * 180 / Math.PI).toFixed(1); });
  }

  rotate() {
    const values = axes.map((axis) => Number($('anim' + axis).value));
    if (values.some((v) => !finite(v) || Math.abs(v) > 180)) return;
    this.pause();
    const node = this.bones.find(([name]) => name === $('animBone').value)?.[1];
    node.quaternion.setFromEuler(new THREE.Euler(...values.map((v) => v * Math.PI / 180), 'XYZ'));
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
    this.apply(this.sample(this.time));
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
    const keys = data.keys.map((key) => {
      if (!finite(key.time) || key.time < 0 || key.time > data.duration || !key.pose || typeof key.pose !== 'object') throw new Error('Invalid keyframe.');
      const pose = {};
      for (const [name] of this.bones) {
        const q = key.pose[name];
        if (!Array.isArray(q) || q.length !== 4 || !q.every(finite) || Math.hypot(...q) < 1e-6) throw new Error('Project is missing a bone or contains an invalid rotation.');
        pose[name] = new THREE.Quaternion().fromArray(q).normalize().toArray();
      }
      return { time: key.time, pose };
    }).sort((a, b) => a.time - b.time);
    if (keys.some((k, i) => i && k.time - keys[i - 1].time < 0.005)) throw new Error('Keyframe times must be distinct.');
    this.pause(); this.keys = keys; this.duration = data.duration;
    $('animName').value = typeof data.name === 'string' ? data.name.slice(0, 80) : 'My animation';
    $('animDuration').value = this.duration; $('animLoop').checked = !!data.loop;
    this.renderKeys(); this.seek(0);
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
    const add = (bone, track, flip = false) => { if (bone && human.has(bone)) tracks.set(bone, [track, flip]); };
    const quaternions = (c) => c.tracks.filter((t) => t.name.endsWith('.quaternion')).map((t) => [t.name.slice(0, -'.quaternion'.length), t]);
    if (info.animationEditor === 'GLBtoVRM' && info.coordinateSystem === 'VRM 0 raw bones') {
      for (const [node, track] of quaternions(clip)) add(byNode.get(node), track);
    } else if (info.animationEditor === 'GLBtoVRM') {
      // undo the Hyperfy export: thumb renaming and X/Z quaternion flip
      const importName = (n) => n.replace(/Thumb(Proximal|Intermediate)$/, (_, p) => p === 'Proximal' ? 'ThumbMetacarpal' : 'ThumbProximal');
      for (const [node, track] of quaternions(clip)) add(importName(node), track, true);
    } else {
      // Mixamo rig: retarget to this avatar exactly as the walk/run emotes are
      const raw = (b) => this.viewer.vrm.humanoid.getRawBoneNode(b);
      const retargeted = createEmoteFactory(glb).toClip({ rootToHips: 1, version: this.viewer.vrm.meta?.metaVersion, getBoneName: (b) => raw(b)?.name });
      for (const [node, track] of quaternions(retargeted)) add(byNode.get(node), track);
    }
    if (tracks.size < 5) throw new Error('no humanoid bones recognized. Use a Mixamo-rigged animation or a GLB exported by this editor.');
    const duration = Math.min(120, Math.round(clip.duration * 1000) / 1000);
    if (!(duration >= 0.1)) throw new Error('the animation is shorter than 0.1 s.');
    // Keep the clip's own key times when sparse; dense mocap is resampled to at most 30 keys per second.
    const steps = Math.min(1999, Math.max(1, Math.round(duration * 30)));
    const native = [...new Set([...tracks.values()].flatMap(([t]) => [...t.times].map((x) => Math.round(x * 1000) / 1000)))].filter((x) => x >= 0 && x <= duration);
    let times = native.length <= steps + 1 ? [...new Set([0, ...native, duration])] : Array.from({ length: steps + 1 }, (_, i) => Math.round(i * duration / steps * 1000) / 1000);
    times = times.sort((a, b) => a - b).filter((t, i, all) => i === 0 || t - all[i - 1] >= 0.005);
    const interpolants = [...tracks].map(([bone, [track, flip]]) => [bone, track.createInterpolant(), flip]);
    const keys = times.map((time) => {
      const pose = clone(this.rest);
      for (const [bone, interpolant, flip] of interpolants) {
        const q = [...interpolant.evaluate(time)];
        pose[bone] = flip ? q.map((v, i) => i % 2 === 0 ? -v : v) : q;
      }
      return { time, pose };
    });
    const name = (clip.name && clip.name !== 'Take 001' && !/^mixamo\.com$/i.test(clip.name) ? clip.name : fileName.replace(/(\.hyperfy)?\.glb$/i, '')).slice(0, 80);
    this.loadProject({ format: 'glbtovrm-animation', version: 1, name, duration, loop: info.loop ?? true, keys });
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
        const node = copy(source); node.quaternion.fromArray(this.rest[name]);
        tracks.push(new THREE.QuaternionKeyframeTrack(`${node.uuid}.quaternion`, times, times.flatMap((time) => this.sample(time)[name].map((v, i) => hyperfy && i % 2 === 0 ? -v : v))));
      }
      if (hyperfy) for (const [source, node] of nodes) {
        if (humanNames.has(source)) node.name = exportName(humanNames.get(source));
        node.position.x *= -1; node.position.z *= -1;
        node.quaternion.x *= -1; node.quaternion.z *= -1;
      }
      scene.userData = { animationEditor: 'GLBtoVRM', coordinateSystem: hyperfy ? 'Hyperfy normalized humanoid' : 'VRM 0 raw bones', loop: $('animLoop').checked };
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
    this.joints.removeFromParent(); this.jointGeometry.dispose(); this.jointMaterial.dispose(); this.selectedMaterial.dispose();
    this.pause(); this.events.abort(); this.helper.removeFromParent(); this.helper.dispose();
    $('animationEditor').hidden = true; $('editBtn').disabled = true;
    $('editorTimeline').hidden = true; $('studioOverlay').hidden = true;
    this.viewer.stage.closest('.window').classList.remove('is-editing');
    this.viewer.camera.fov = 70; this.viewer.camera.updateProjectionMatrix();
    this.viewer.stage.querySelector('.help').hidden = false; $('vJump').hidden = false;
  }
}
