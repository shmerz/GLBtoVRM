// Hyperfy emotes and their retargeting onto a VRM, ported from Hyperfy
// (src/core/extras/createEmoteFactory.js, src/core/extras/playerEmotes.js; GPL-3.0-only, https://github.com/hyperfy-xyz/hyperfy).
// The clips in ./emotes/ come from the same project. Retargeting matches Hyperfy so avatars move as they will there.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

// key -> [file, playback speed] (the "?s=" values of Hyperfy's Emotes table)
export const EMOTES = {
  idle: ['mp-idle.glb', 1],
  walk: ['mp-walk.glb', 1.5], walkLeft: ['mp-walk-left.glb', 1.5], walkRight: ['mp-walk-right.glb', 1.5], walkBack: ['mp-walk-back.glb', 1.5],
  run: ['mp-jog.glb', 1.4], runLeft: ['mp-jog-left.glb', 1.4], runRight: ['mp-jog-right.glb', 1.4], runBack: ['mp-jog-back.glb', 1.4],
  jump: ['emote-jump.glb', 1],
  fall: ['emote-fall.glb', 1],
};

// Mixamo bone (as sanitized by GLTFLoader: "mixamorig:Hips" -> "mixamorigHips") -> VRM humanoid bone
const BONES = {
  Hips: 'hips', Spine: 'spine', Spine1: 'chest', Spine2: 'upperChest', Neck: 'neck', Head: 'head',
};
for (const [S, s] of [['Left', 'left'], ['Right', 'right']]) {
  Object.assign(BONES, {
    [S + 'Shoulder']: s + 'Shoulder', [S + 'Arm']: s + 'UpperArm', [S + 'ForeArm']: s + 'LowerArm', [S + 'Hand']: s + 'Hand',
    [S + 'UpLeg']: s + 'UpperLeg', [S + 'Leg']: s + 'LowerLeg', [S + 'Foot']: s + 'Foot', [S + 'ToeBase']: s + 'Toes',
  });
  for (const [F, f] of [['Thumb', 'Thumb'], ['Index', 'Index'], ['Middle', 'Middle'], ['Ring', 'Ring'], ['Pinky', 'Little']])
    ['Proximal', 'Intermediate', 'Distal'].forEach((p, i) => (BONES[`${S}Hand${F}${i + 1}`] = s + f + p));
  // Unity FBX variations, as in Hyperfy's table
  for (const p of ['UpperLeg', 'LowerLeg', 'UpperArm', 'LowerArm']) BONES[S + p] = s + p;
}
Object.assign(BONES, { Chest: 'chest', UpperChest: 'upperChest' });
// VRM humanoid names map to themselves (clips authored on a normalized VRM rig, e.g. Hyperfy's emote-sit)
for (const name of Object.values(BONES)) BONES[name] = name;
// also accepts numbered rig prefixes ("mixamorig1Hips", as in Avaturn exports)
const vrmBoneOf = (name) => BONES[name.replace(/^mixamorig\d*/, '')];

const q1 = new THREE.Quaternion(), restInv = new THREE.Quaternion(), parentRest = new THREE.Quaternion();

export function createEmoteFactory(glb) {
  const clip = glb.animations[0];
  const scale = glb.scene.children[0].scale.x; // armature
  const yOffset = -0.05 / scale; // Hyperfy: avatars otherwise float ~5 cm above the ground
  // keep the quaternions plus the root/hips position, drop scale and the other positions
  clip.tracks = clip.tracks.filter((track) => {
    if (!glb.scene.getObjectByName(track.name.split('.')[0])?.parent) return false; // user-supplied GLBs may animate missing nodes
    if (!(track instanceof THREE.VectorKeyframeTrack)) return true;
    const [name, type] = track.name.split('.');
    return type === 'position' && (name === 'Root' || vrmBoneOf(name) === 'hips');
  });
  // bring the rotations into normalized-bone space (see three-vrm PR #1032)
  for (const track of clip.tracks) {
    const node = glb.scene.getObjectByName(track.name.split('.')[0]);
    node.getWorldQuaternion(restInv).invert();
    node.parent.getWorldQuaternion(parentRest);
    if (track instanceof THREE.QuaternionKeyframeTrack) {
      for (let i = 0; i < track.values.length; i += 4) {
        q1.fromArray(track.values, i).premultiply(parentRest).multiply(restInv).toArray(track.values, i);
      }
    } else {
      track.values = track.values.map((v, i) => (i % 3 === 1 ? v + yOffset : v));
    }
  }
  clip.optimize();

  return {
    toClip({ rootToHips, version, getBoneName }) {
      const scaler = rootToHips * scale; // feet-to-hips height scales the motion to the avatar
      const tracks = [];
      for (const track of clip.tracks) {
        const [bone, prop] = track.name.split('.');
        const vrmBone = vrmBoneOf(bone);
        const node = vrmBone && getBoneName(vrmBone);
        if (node === undefined || node === null) continue;
        if (track instanceof THREE.QuaternionKeyframeTrack)
          tracks.push(new THREE.QuaternionKeyframeTrack(`${node}.${prop}`, track.times, track.values.map((v, i) => (version === '0' && i % 2 === 0 ? -v : v))));
        else
          tracks.push(new THREE.VectorKeyframeTrack(`${node}.${prop}`, track.times, track.values.map((v, i) => (version === '0' && i % 3 !== 1 ? -v : v) * scaler)));
      }
      return new THREE.AnimationClip(clip.name, clip.duration, tracks);
    },
  };
}

let loaded;
export function loadEmotes() {
  const loader = new GLTFLoader();
  loaded ??= Promise.all(Object.entries(EMOTES).map(async ([key, [file, speed]]) => {
    const glb = await loader.loadAsync(new URL(`./emotes/${file}`, import.meta.url).href);
    return [key, { factory: createEmoteFactory(glb), speed }];
  })).then(Object.fromEntries);
  return loaded;
}
