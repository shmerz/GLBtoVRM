# GLBtoVRM

Turn a rigged humanoid **.glb** (Mixamo or Avaturn rig) into a **VRM 0.0** avatar, right in your browser, then walk around with it before downloading.

- **Private**: the conversion runs on your device (Python in WebAssembly via Pyodide). The file is never uploaded.
- **Ready for web metaverses**: normalized skeleton (bones carry translation only), straight T-pose, facing -Z, the layout Hyperfy expects.
- **Light**: the output stays under a size budget (10 MB by default).
- **Expressive**: ARKit blendshapes become VRM expressions (a/i/u/e/o, blink, joy, angry, sorrow, fun).

## Run it locally

You need Python 3 and an internet connection (Pyodide, three.js and three-vrm load from jsDelivr). From this folder, run:

```bash
python3 -m http.server 8000
```

Then open <http://localhost:8000/> and drop a `.glb` anywhere on the page, or click **+** to pick one. Opening `index.html` straight from disk (`file://`) does not work, because browsers block web workers and module imports there. The first conversion takes a little longer, because the browser downloads the Python runtime (about 15 MB) and caches it. Each conversion after that takes about 10 seconds.

Any static host works for deployment, for example GitHub Pages: there is no build step and no backend.

## Try-it window

After a conversion, a window opens with the avatar on an endless floor. The controls and animations are the ones a Hyperfy player uses:

| Input | Action |
| --- | --- |
| `W` `A` `S` `D` / arrows | move relative to the camera (8-direction walk) |
| `Shift` | run |
| `Space` | jump |
| drag | look around |
| mouse wheel | zoom; below 1 m it switches to first person |
| touch | joystick on the left half, look on the right, **Jump** button |

## Command line

The converter is a single script, `glb2vrm0.py`. The site runs this same script unchanged. It needs `numpy`, plus `Pillow` when textures are re-encoded or a material uses BLEND alpha.

```bash
pip install numpy pillow
python3 glb2vrm0.py avatar.glb avatar.vrm [normal.png] [--max-mb 10] [--author "Your name"]
```

The optional PNG becomes the normal map of the first material.

## What the input must be

- A binary glTF (`.glb`); convert FBX to GLB first, for example in Blender.
- One skin (armature), with every mesh skinned to it, exported in its bind (rest) pose.
- Mixamo-style bone names (`Hips`, `Spine1`, `LeftUpLeg`, `LeftHandIndex1`…); prefixes such as `mixamorig:` are fine.
- No Draco or meshopt mesh compression.

When the input breaks one of these rules, the page shows a one-line reason.

## What the converter does

1. Straightens the rest pose: legs vertical with feet flat, upper arm and forearm on the X axis. Avaturn rigs bend the forearm about 16° forward, which otherwise closes the arms on the body in animations.
2. Bakes every vertex, normal and morph target into that pose, and rebuilds the skeleton with translation only. It then turns the avatar 180° so it faces -Z, as VRM 0.x expects.
3. Writes the VRM extension:
   - humanoid mapping, including fingers and eyes;
   - firstPerson and lookAt settings;
   - expressions built from ARKit shapes;
   - glTF PBR materials. BLEND hair with an almost-binary alpha channel becomes MASK, to avoid three.js sorting artifacts.
4. Fits the size budget. Lossless compaction always runs. If the file is still too big, the converter takes the first of these steps that fits: textures at max 2048 px, then 1024, then 512, then 512 without morph normals, then 256 without morph normals.

The VRM metadata uses the author from the options, and a restrictive default license (redistribution prohibited, author-only use). Edit the metadata in a VRM tool if you need other terms.

## Files

| File | Role |
| --- | --- |
| `index.html`, `style.css` | page and styles |
| `app.js` | file picking and drag & drop, talks to the worker, download link |
| `worker.js` | loads Pyodide (numpy and Pillow) and runs `glb2vrm0.py` on the dropped file |
| `glb2vrm0.py` | the converter (also usable from the command line) |
| `viewer.js` | try-it scene: three.js 0.170 with @pixiv/three-vrm 3.4.2, player controller, camera, endless grid |
| `emotes.js`, `emotes/` | Hyperfy's locomotion clips and their retargeting onto the VRM |

## License

[GPL-3.0](LICENSE). Copyright (C) 2026 Marzio Camasso.

## Credits

- `emotes/*.glb` and the retargeting logic in `emotes.js` come from [Hyperfy](https://github.com/hyperfy-xyz/hyperfy) (GPL-3.0).
- Libraries loaded at runtime:
  - [three.js](https://threejs.org) (MIT);
  - [@pixiv/three-vrm](https://github.com/pixiv/three-vrm) (MIT);
  - [Pyodide](https://pyodide.org) (MPL-2.0), with NumPy (BSD) and Pillow (MIT-CMU).
