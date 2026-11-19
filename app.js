// Upload UI: pick or drop a .glb, convert it in the worker, then open the try-it viewer.
const $ = (id) => document.getElementById(id);
const worker = new Worker('worker.js');
let job = 0, ready = false, result = null, viewer = null;
// avatars of this session: switch between them in the viewer to check one animation on different bodies
const avatars = [];
let fromViewer = false; // the running conversion was started from the viewer's avatar switcher

const show = (state) => document.querySelectorAll('.state').forEach((el) => (el.hidden = el.dataset.state !== state));
const mb = (n) => (n / 1e6).toFixed(2) + ' MB';

worker.onmessage = ({ data: m }) => {
  if (m.type === 'ready') { ready = true; $('busyTitle').textContent = 'Converting…'; $('engineTxt').textContent = 'Converter ready · runs locally'; $('engineDot').parentElement.className = 'engine ready'; return; }
  if (m.type === 'error') { $('engineTxt').textContent = m.message; $('engineDot').parentElement.className = 'engine down'; return; }
  if (m.id !== job) return;
  if (m.type === 'log') { $('busyLog').textContent = m.line; if (fromViewer) $('vLoading').textContent = 'Converting… ' + m.line; }
  else if (m.type === 'fail') {
    if (fromViewer) { fromViewer = false; viewerBusy(false); $('vLoading').textContent = 'Conversion failed: ' + m.message; setTimeout(() => ($('vLoading').hidden = true), 4000); return; }
    $('failMsg').textContent = m.message; show('fail');
  } else if (m.type === 'done') done(m);
};

function convert(file, inViewer = false) {
  if (!file) return;
  if (!/\.glb$/i.test(file.name)) { $('failMsg').textContent = `"${file.name}" is not a .glb file.`; show('fail'); return; }
  job++;
  fromViewer = inViewer;
  if (inViewer) { viewerBusy(true); $('vLoading').hidden = false; $('vLoading').textContent = ready ? 'Converting…' : 'Loading converter…'; }
  $('busyFile').textContent = `${file.name} · ${mb(file.size)}`;
  $('busyLog').textContent = '';
  $('busyTitle').textContent = ready ? 'Converting…' : 'Loading converter…';
  show('busy');
  import('./viewer.js'); // warm the 3D libraries while Python works
  file.arrayBuffer().then((bytes) => {
    const maxMb = Math.max(1, parseFloat($('maxMb').value) || 10);
    worker.postMessage({ id: job, name: file.name, bytes, maxMb, author: $('author').value.trim() }, [bytes]);
  });
}

function done(m) {
  const keep = fromViewer;
  fromViewer = false;
  const entry = addAvatar(m.name, m.vrm.buffer);
  $('doneFile').textContent = m.name;
  $('doneInfo').textContent = `${mb(entry.size)} · ${m.step}${m.overBudget ? ' · over the size budget' : ''}`;
  for (const a of [$('dlBtn')]) { a.href = entry.url; a.download = m.name; }
  show('done');
  openViewer(entry, keep);
}

function addAvatar(name, buffer) {
  const blob = new Blob([buffer], { type: 'model/gltf-binary' });
  // same name twice (e.g. a re-conversion): the new file replaces the old entry
  const old = avatars.findIndex((a) => a.name === name);
  if (old >= 0) { URL.revokeObjectURL(avatars[old].url); avatars.splice(old, 1); }
  const entry = { name, size: blob.size, url: URL.createObjectURL(blob), buffer };
  avatars.push(entry);
  return entry;
}

function renderPicker() {
  const opts = avatars.map((a, i) => new Option(a.name, i, false, a === result));
  $('avatarPick').replaceChildren(...opts, new Option('+ Add avatar (.vrm / .glb)…', 'add'));
}

// .vrm opens as is (e.g. another converted avatar); .glb goes through the converter first
async function addFromFile(file) {
  if (!file) return;
  if (/\.glb$/i.test(file.name)) return convert(file, true);
  if (!/\.vrm$/i.test(file.name)) { $('vLoading').hidden = false; $('vLoading').textContent = `"${file.name}" is not a .vrm or .glb file.`; setTimeout(() => ($('vLoading').hidden = true), 3000); return; }
  openViewer(addAvatar(file.name, await file.arrayBuffer()), true);
}

const viewerBusy = (busy) => { $('avatarPick').disabled = busy; };

// keep: switching avatar inside the viewer, so the animation (and editor state) carries over
async function openViewer(entry = result, keep = false) {
  if (!entry) return;
  result = entry;
  renderPicker();
  $('vDl').href = entry.url; $('vDl').download = entry.name;
  $('vTitle').textContent = result.name;
  $('vSize').textContent = mb(result.size);
  $('viewer').hidden = false;
  $('vLoading').hidden = false;
  $('vLoading').textContent = 'Loading avatar…';
  try {
    const { Viewer } = await import('./viewer.js');
    viewer ??= new Viewer($('stage'), $('vJump'));
    viewerBusy(true);
    const note = await viewer.open(result.buffer.slice(0), { keep });
    $('vLoading').hidden = !note;
    if (note) { $('vLoading').textContent = note; setTimeout(() => ($('vLoading').hidden = true), 3500); }
  } catch (e) {
    console.error(e);
    $('vLoading').textContent = 'Could not load the avatar: ' + e.message;
  } finally { viewerBusy(false); }
}
// local debugging only: the viewer from the browser console
if (/^(localhost|127\.0\.0\.1)$/.test(location.hostname)) Object.defineProperty(globalThis, 'glbtovrm', { get: () => ({ viewer, avatars }) });
function closeViewer() { $('viewer').hidden = true; viewer?.close(); }

$('pick').onclick = () => $('file').click();
$('file').onchange = (e) => { convert(e.target.files[0]); e.target.value = ''; };
$('tryBtn').onclick = () => openViewer();
$('avatarPick').onchange = (e) => {
  const v = e.target.value;
  if (v === 'add') { e.target.value = String(avatars.indexOf(result)); $('avatarFile').click(); return; }
  if (avatars[v] && avatars[v] !== result) openViewer(avatars[v], true);
};
$('avatarFile').onchange = (e) => { addFromFile(e.target.files[0]); e.target.value = ''; };
$('againBtn').onclick = $('retryBtn').onclick = () => { show('idle'); $('file').click(); };
$('vClose').onclick = closeViewer;
addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('viewer').hidden) closeViewer(); });

// drop anywhere on the page (WeTransfer style); a counter keeps the overlay stable over child elements
let depth = 0;
const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
addEventListener('dragenter', (e) => { if (!hasFiles(e)) return;
  $('dropzone').firstElementChild.textContent = $('viewer').hidden ? 'Drop your .glb' : 'Drop a .vrm or .glb to switch avatar'; e.preventDefault(); depth++; $('dropzone').hidden = false; });
addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; $('dropzone').hidden = true; } });
addEventListener('drop', (e) => {
  e.preventDefault(); depth = 0; $('dropzone').hidden = true;
  if (!$('viewer').hidden) { if (!$('avatarPick').disabled) addFromFile(e.dataTransfer.files[0]); }
  else if (!$('card').querySelector('[data-state=busy]:not([hidden])')) convert(e.dataTransfer.files[0]);
});
