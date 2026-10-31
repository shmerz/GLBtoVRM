// Try-it viewer: the avatar on an endless grid, driven like Hyperfy's local player (src/core/entities/PlayerLocal.js):
// WASD/arrows move relative to the camera, Shift runs, Space jumps, drag looks, wheel zooms (below 1 m: first person).
// Animations are Hyperfy's own emotes, retargeted and blended the same way (see emotes.js).
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';
import { loadEmotes } from './emotes.js';
import { AnimationEditor } from './animation-editor.js';

const WALK = 3, RUN = 6, GRAVITY = 20, JUMP_HEIGHT = 1.5, FAR = 120;
const MIN_ZOOM = 0, MAX_ZOOM = 8, LOOK_SPEED = 0.005, ZOOM_SPEED = 0.004;
const Modes = { IDLE: 0, WALK: 1, RUN: 2, JUMP: 3, FALL: 4 };
const SKY = new THREE.Color('#dfe5ec');
const UP = new THREE.Vector3(0, 1, 0), FORWARD = new THREE.Vector3(0, 0, -1), BACKWARD = new THREE.Vector3(0, 0, 1);
const v1 = new THREE.Vector3(), v2 = new THREE.Vector3(), q1 = new THREE.Quaternion(), e1 = new THREE.Euler();

export class Viewer {
  constructor(stage, jumpBtn) {
    this.stage = stage;
    this.emotes = loadEmotes();
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.toneMapping = THREE.NeutralToneMapping;
    this.renderer.domElement.tabIndex = 0;
    stage.prepend(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.background = SKY;
    this.scene.fog = new THREE.Fog(SKY, FAR * 0.35, FAR);
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.7;
    this.scene.add(new THREE.HemisphereLight('#ffffff', '#b9c2cc', 1.2));
    const sun = new THREE.DirectionalLight('#ffffff', 1.6);
    sun.position.set(3, 6, 4);
    this.scene.add(sun);

    this.camera = new THREE.PerspectiveCamera(70, 1, 0.05, FAR * 2);
    this.ground = endlessGrid();
    this.shadow = blobShadow();
    this.scene.add(this.ground, this.shadow);

    this.clock = new THREE.Clock();
    this.keys = new Set();
    this.stick = null; // touch joystick {id, x0, y0, x, y}
    this.drag = null;
    this.bindInput(jumpBtn);
    new ResizeObserver(() => this.resize()).observe(stage);
  }

  async open(buffer, animationId) {
    this.close();
    if (animationId !== this.animationId) this.savedAnimation = null;
    this.animationId = animationId;
    const loader = new GLTFLoader();
    loader.register((p) => new VRMLoaderPlugin(p));
    const [gltf, emotes] = await Promise.all([loader.parseAsync(buffer, ''), this.emotes]);
    const vrm = gltf.userData.vrm;
    if (!vrm) throw new Error('no VRM data in the file');
    VRMUtils.removeUnnecessaryVertices(gltf.scene);
    VRMUtils.combineSkeletons(gltf.scene);
    // like Hyperfy: no rotateVRM0 (the avatar faces -Z, the player's forward) and the raw bones are animated directly
    for (const n of vrm.scene.children.filter((n) => n.name === 'VRMHumanoidRig')) n.removeFromParent();
    vrm.scene.traverse((o) => { o.frustumCulled = false; });
    this.vrm = vrm;
    this.base = new THREE.Group(); // player position and facing
    this.base.add(vrm.scene);
    this.scene.add(this.base);
    vrm.scene.updateMatrixWorld(true);

    const raw = (b) => vrm.humanoid.getRawBoneNode(b);
    const rootToHips = raw('hips').getWorldPosition(v1).y;
    const height = new THREE.Box3().setFromObject(vrm.scene, true).max.y;
    this.camHeight = height * 0.9;
    this.neck = raw('neck');

    // locomotion poses: every clip plays, weights blend between them (Hyperfy's addPose / updateLocomotion)
    this.mixer = new THREE.AnimationMixer(vrm.scene);
    const opts = { rootToHips, version: vrm.meta?.metaVersion, getBoneName: (b) => raw(b)?.name };
    this.poses = {};
    for (const [key, { factory, speed }] of Object.entries(emotes)) {
      const action = this.mixer.clipAction(factory.toClip(opts));
      action.timeScale = speed;
      action.weight = 0;
      action.play();
      this.poses[key] = { action, weight: 0, target: 0, active: false };
    }

    this.editor = new AnimationEditor(this);
    if (this.savedAnimation) this.editor.loadProject(this.savedAnimation);

    this.player = { vel: new THREE.Vector3(), vy: 0, grounded: true, jumped: false, jumping: false, falling: false, fallTimer: 0, fallStartY: 0, blink: 2 };
    this.cam = { rotation: new THREE.Euler(-15 * THREE.MathUtils.DEG2RAD, 0, 0, 'YXZ'), zoom: 1.5, curZoom: 1.5, position: new THREE.Vector3(), quaternion: new THREE.Quaternion() };
    this.cam.quaternion.setFromEuler(this.cam.rotation);
    this.camera.quaternion.copy(this.cam.quaternion);
    this.firstPerson = false;
    this.clock.start();
    this.resize();
    this.renderer.setAnimationLoop(() => this.frame());
    this.renderer.domElement.focus();
  }

  close() {
    if (this.editor) this.savedAnimation = this.editor.project();
    this.editor?.dispose();
    this.editor = null;
    this.renderer.setAnimationLoop(null);
    this.keys.clear();
    if (this.vrm) {
      this.mixer.stopAllAction();
      this.scene.remove(this.base);
      VRMUtils.deepDispose(this.vrm.scene);
      this.vrm = null;
    }
  }

  resize() {
    const { clientWidth: w, clientHeight: h } = this.stage;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.editor?.fitDistance();
  }

  bindInput(jumpBtn) {
    const el = this.renderer.domElement;
    addEventListener('keydown', (e) => {
      if (!this.vrm || this.editor?.active || e.metaKey || e.ctrlKey || /INPUT|SELECT|TEXTAREA|BUTTON/.test(e.target.tagName)) return;
      this.keys.add(e.code);
      if (/^(Space|Arrow)/.test(e.code)) e.preventDefault();
    });
    addEventListener('keyup', (e) => this.keys.delete(e.code));
    addEventListener('blur', () => this.keys.clear());
    jumpBtn.addEventListener('pointerdown', (e) => { e.stopPropagation(); this.jumpQueued = true; });

    el.addEventListener('pointerdown', (e) => {
      el.focus();
      if (this.editor?.handlePointerDown(e)) return;
      el.setPointerCapture(e.pointerId);
      // touch: the left half of the stage is a joystick, the rest looks around
      if (!this.editor?.active && e.pointerType === 'touch' && e.offsetX < el.clientWidth * 0.45 && !this.stick)
        this.stick = { id: e.pointerId, x0: e.clientX, y0: e.clientY, x: 0, y: 0 };
      else if (!this.drag) this.drag = { id: e.pointerId, x: e.clientX, y: e.clientY };
    });
    el.addEventListener('pointermove', (e) => {
      if (this.editor?.transform?.dragging) return;
      if (this.stick?.id === e.pointerId) {
        const dx = e.clientX - this.stick.x0, dy = e.clientY - this.stick.y0, l = Math.hypot(dx, dy), k = Math.min(l, 50) / (l || 1);
        this.stick.x = (dx * k) / 50; this.stick.y = (dy * k) / 50;
      } else if (this.drag?.id === e.pointerId && this.cam) {
        const r = this.cam.rotation;
        r.y -= (e.clientX - this.drag.x) * LOOK_SPEED;
        r.x = THREE.MathUtils.clamp(r.x - (e.clientY - this.drag.y) * LOOK_SPEED, -89 * THREE.MathUtils.DEG2RAD, 89 * THREE.MathUtils.DEG2RAD);
        this.drag.x = e.clientX; this.drag.y = e.clientY;
      }
    });
    const up = (e) => { if (this.stick?.id === e.pointerId) this.stick = null; if (this.drag?.id === e.pointerId) this.drag = null; };
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    el.addEventListener('wheel', (e) => {
      e.preventDefault();
      if (this.cam) {
        if (this.editor?.active) {
          this.editor.zoomFactor = THREE.MathUtils.clamp(this.editor.zoomFactor * Math.exp(e.deltaY * 0.001), 0.35, 3);
          this.editor.fitDistance();
        } else this.cam.zoom = THREE.MathUtils.clamp(this.cam.zoom + e.deltaY * ZOOM_SPEED, MIN_ZOOM, MAX_ZOOM);
      }
    }, { passive: false });
    el.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  frame() {
    const delta = Math.min(this.clock.getDelta(), 1 / 20);
    if (this.editor?.active) {
      this.editor.update(delta);
      const cam = this.cam;
      cam.quaternion.setFromEuler(cam.rotation);
      this.camera.quaternion.copy(cam.quaternion);
      this.camera.position.copy(this.editor.target).addScaledVector(v1.copy(BACKWARD).applyQuaternion(cam.quaternion), cam.zoom);
      this.renderer.render(this.scene, this.camera);
      return;
    }
    const p = this.player, cam = this.cam, k = this.keys, base = this.base;
    cam.quaternion.setFromEuler(cam.rotation);

    // zoom into first person below 1 m, and back out to 1 m
    if (cam.zoom < 1 && !this.firstPerson) { cam.zoom = 0; this.firstPerson = true; }
    else if (cam.zoom > 0 && this.firstPerson) { cam.zoom = 1; this.firstPerson = false; }
    this.neck.scale.setScalar(this.firstPerson ? 0 : 1); // Hyperfy hides the head this way

    // move direction (un-rotated axis, -Z forward), then rotated to the camera's yaw
    const moveDir = new THREE.Vector3();
    let running;
    if (this.stick) {
      moveDir.set(this.stick.x, 0, this.stick.y);
      running = moveDir.length() > 0.9;
    } else {
      if (k.has('KeyW') || k.has('ArrowUp')) moveDir.z -= 1;
      if (k.has('KeyS') || k.has('ArrowDown')) moveDir.z += 1;
      if (k.has('KeyA') || k.has('ArrowLeft')) moveDir.x -= 1;
      if (k.has('KeyD') || k.has('ArrowRight')) moveDir.x += 1;
      running = k.has('ShiftLeft') || k.has('ShiftRight');
    }
    const moving = moveDir.length() > 0;
    running = moving && running;
    moveDir.normalize();
    const axis = moveDir.clone();
    moveDir.applyQuaternion(q1.setFromAxisAngle(UP, cam.rotation.y));

    // ground movement and jump (flat ground, so a kinematic version of Hyperfy's capsule physics)
    p.vel.lerp(v1.copy(moveDir).multiplyScalar(running ? RUN : WALK), 1 - Math.exp(-(p.grounded ? 10 : 3) * delta));
    base.position.addScaledVector(p.vel, delta);
    if (p.jumped && !p.grounded) { p.jumped = false; p.jumping = true; }
    if (p.grounded && !p.jumping && (k.has('Space') || this.jumpQueued)) {
      p.vy = Math.sqrt(2 * GRAVITY * JUMP_HEIGHT);
      p.grounded = false;
      p.jumped = true;
    }
    this.jumpQueued = false;
    if (!p.grounded) {
      p.vy -= GRAVITY * delta;
      base.position.y += p.vy * delta;
      if (base.position.y <= 0) { base.position.y = 0; p.vy = 0; p.grounded = true; }
    }
    p.fallTimer = !p.grounded && p.vy < 0 ? p.fallTimer + delta : 0;
    if (p.fallTimer > 0.1 && !p.falling) { p.jumping = false; p.falling = true; p.fallStartY = base.position.y; }
    if (p.grounded) { p.falling = false; p.jumping = false; p.jumped = false; }
    const fallDistance = p.falling ? p.fallStartY - base.position.y : 0;

    // when moving or in first person, keep turning to face the camera's direction
    if (moving || this.firstPerson) base.quaternion.slerp(q1.setFromEuler(e1.set(0, cam.rotation.y, 0)), 1 - Math.pow(0.00000001, delta));

    const mode = p.jumping ? Modes.JUMP : p.falling ? (fallDistance > 1.6 ? Modes.FALL : Modes.JUMP) : moving ? (running ? Modes.RUN : Modes.WALK) : Modes.IDLE;
    this.mixer.update(delta);
    this.updateLocomotion(mode, axis, delta);
    this.blink(delta);

    // camera: at the avatar's height, over the right shoulder, zoom distance behind
    cam.position.copy(base.position);
    cam.position.y += this.camHeight;
    if (!this.firstPerson) {
      const forward = v1.copy(FORWARD).applyQuaternion(cam.quaternion);
      cam.position.add(v2.crossVectors(forward, UP).normalize().multiplyScalar(0.3));
    }
    this.camera.quaternion.slerp(cam.quaternion, 1 - Math.exp(-20 * delta));
    cam.curZoom += (cam.zoom - cam.curZoom) * Math.min(6 * delta, 1);
    this.camera.position.copy(cam.position).addScaledVector(v1.copy(BACKWARD).applyQuaternion(this.camera.quaternion), cam.curZoom);
    if (this.camera.position.y < 0.1) this.camera.position.y = 0.1;

    // endless floor: the grid is in world space, the mesh just follows the player
    this.ground.position.set(Math.round(base.position.x), 0, Math.round(base.position.z));
    this.shadow.position.set(base.position.x, 0.002, base.position.z);
    const s = 1 / (1 + base.position.y * 0.6);
    this.shadow.scale.setScalar(s);
    this.shadow.material.opacity = 0.35 * s;

    this.renderer.render(this.scene, this.camera);
  }

  // Hyperfy's 8-direction blend between forward / right / back / left clips
  updateLocomotion(mode, axis, delta) {
    const poses = this.poses;
    for (const key in poses) poses[key].target = 0;
    if (mode === Modes.IDLE) poses.idle.target = 1;
    else if (mode === Modes.WALK || mode === Modes.RUN) {
      const pre = mode === Modes.RUN ? 'run' : 'walk';
      const deg = ((Math.atan2(axis.x, -axis.z) * 180) / Math.PI + 360) % 360;
      const ring = [pre, pre + 'Right', pre + 'Back', pre + 'Left'];
      if (axis.length() > 0.01) {
        const o = (deg + 22.5) % 360; // octants of 45 deg: even = pure direction, odd = blend of two
        const i = Math.floor(o / 45);
        if (i % 2 === 0) poses[ring[i / 2]].target = 1;
        else {
          const blend = (o - i * 45) / 45;
          poses[ring[(i - 1) / 2]].target = 1 - blend;
          poses[ring[((i + 1) / 2) % 4]].target = blend;
        }
      }
    } else if (mode === Modes.JUMP) poses.jump.target = 1;
    else if (mode === Modes.FALL) poses.fall.target = 1;
    for (const key in poses) {
      const pose = poses[key];
      pose.weight = THREE.MathUtils.lerp(pose.weight, pose.target, 1 - Math.exp(-16 * delta));
      pose.action.weight = pose.weight;
      if (!pose.active) { pose.action.reset().fadeIn(0.15).play(); pose.active = true; }
    }
  }

  blink(delta) {
    const p = this.player, em = this.vrm.expressionManager;
    if (!em) return;
    p.blink -= delta;
    const b = p.blink < 0.15 && p.blink > 0 ? Math.sin((p.blink / 0.15) * Math.PI) : 0;
    if (p.blink < 0) p.blink = 2 + Math.random() * 4;
    em.setValue('blink', b);
    em.update();
  }
}

function endlessGrid() {
  const mat = new THREE.ShaderMaterial({
    uniforms: { uBase: { value: new THREE.Color('#eef1f5') }, uLine: { value: new THREE.Color('#aab4c2') }, uSky: { value: SKY }, uFar: { value: FAR } },
    vertexShader: `varying vec3 vW; void main(){ vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
    fragmentShader: `
      uniform vec3 uBase, uLine, uSky; uniform float uFar; varying vec3 vW;
      float grid(vec2 p) { vec2 g = abs(fract(p - 0.5) - 0.5) / fwidth(p); return 1.0 - min(min(g.x, g.y), 1.0); }
      void main() {
        float d = length(vW.xz - cameraPosition.xz);
        float lines = max(grid(vW.xz) * 0.35, grid(vW.xz / 10.0) * 0.8) * (1.0 - smoothstep(uFar * 0.2, uFar * 0.6, d));
        vec3 col = mix(uBase, uLine, lines);
        gl_FragColor = vec4(mix(col, uSky, smoothstep(uFar * 0.35, uFar, d)), 1.0);
        #include <colorspace_fragment>
      }`,
  });
  const m = new THREE.Mesh(new THREE.PlaneGeometry(FAR * 2.2, FAR * 2.2), mat);
  m.rotation.x = -Math.PI / 2;
  return m;
}

function blobShadow() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d'), grd = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grd.addColorStop(0, 'rgba(0,0,0,1)'); grd.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grd; g.fillRect(0, 0, 128, 128);
  const m = new THREE.Mesh(new THREE.PlaneGeometry(1.1, 1.1), new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(c), transparent: true, depthWrite: false, opacity: 0.35 }));
  m.rotation.x = -Math.PI / 2;
  return m;
}
