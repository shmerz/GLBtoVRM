// Upload UI: pick or drop a .glb, convert it in the worker, then open the try-it viewer.
const $ = (id) => document.getElementById(id);
const worker = new Worker('worker.js');
let job = 0, ready = false, result = null, viewer = null;

const show = (state) => document.querySelectorAll('.state').forEach((el) => (el.hidden = el.dataset.state !== state));
const mb = (n) => (n / 1e6).toFixed(2) + ' MB';

worker.onmessage = ({ data: m }) => {
  if (m.type === 'ready') { ready = true; $('busyTitle').textContent = 'Converting…'; $('engineTxt').textContent = 'Converter ready · runs locally'; $('engineDot').parentElement.className = 'engine ready'; return; }
  if (m.type === 'error') { $('engineTxt').textContent = m.message; $('engineDot').parentElement.className = 'engine down'; return; }
  if (m.id !== job) return;
  if (m.type === 'log') $('busyLog').textContent = m.line;
  else if (m.type === 'fail') { $('failMsg').textContent = m.message; show('fail'); }
  else if (m.type === 'done') done(m);
};

function convert(file) {
  if (!file) return;
  if (!/\.glb$/i.test(file.name)) { $('failMsg').textContent = `"${file.name}" is not a .glb file.`; show('fail'); return; }
  job++;
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
  if (result) URL.revokeObjectURL(result.url);
  const blob = new Blob([m.vrm], { type: 'model/gltf-binary' });
  result = { name: m.name, size: blob.size, url: URL.createObjectURL(blob), buffer: m.vrm.buffer };
  $('doneFile').textContent = m.name;
  $('doneInfo').textContent = `${mb(blob.size)} · ${m.step}${m.overBudget ? ' · over the size budget' : ''}`;
  for (const a of [$('dlBtn'), $('vDl')]) { a.href = result.url; a.download = m.name; }
  show('done');
  openViewer();
}

async function openViewer() {
  if (!result) return;
  $('vTitle').textContent = result.name;
  $('vSize').textContent = mb(result.size);
  $('viewer').hidden = false;
  $('vLoading').hidden = false;
  $('vLoading').textContent = 'Loading avatar…';
  try {
    const { Viewer } = await import('./viewer.js');
    viewer ??= new Viewer($('stage'), $('vJump'));
    await viewer.open(result.buffer.slice(0));
    $('vLoading').hidden = true;
  } catch (e) {
    console.error(e);
    $('vLoading').textContent = 'Could not load the avatar: ' + e.message;
  }
}
function closeViewer() { $('viewer').hidden = true; viewer?.close(); }

$('pick').onclick = () => $('file').click();
$('file').onchange = (e) => { convert(e.target.files[0]); e.target.value = ''; };
$('tryBtn').onclick = openViewer;
$('againBtn').onclick = $('retryBtn').onclick = () => { show('idle'); $('file').click(); };
$('vClose').onclick = closeViewer;
addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('viewer').hidden) closeViewer(); });

// drop anywhere on the page (WeTransfer style); a counter keeps the overlay stable over child elements
let depth = 0;
const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
addEventListener('dragenter', (e) => { if (!hasFiles(e) || !$('viewer').hidden) return; e.preventDefault(); depth++; $('dropzone').hidden = false; });
addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; $('dropzone').hidden = true; } });
addEventListener('drop', (e) => {
  e.preventDefault(); depth = 0; $('dropzone').hidden = true;
  if ($('viewer').hidden && !$('card').querySelector('[data-state=busy]:not([hidden])')) convert(e.dataTransfer.files[0]);
});
