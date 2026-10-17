// Runs glb2vrm0.py unchanged inside Pyodide (CPython + numpy + Pillow compiled to WebAssembly).
// Nothing is uploaded: the GLB is written to Pyodide's in-memory filesystem and the VRM is read back from it.
importScripts('https://cdn.jsdelivr.net/pyodide/v0.27.2/full/pyodide.js');

const ready = (async () => {
  const py = await loadPyodide();
  await py.loadPackage(['numpy', 'pillow']);
  const src = await (await fetch(new URL('glb2vrm0.py', self.location))).text();
  py.FS.mkdirTree('/work');
  py.FS.writeFile('/work/glb2vrm0.py', src);
  return py;
})();
ready.then(() => postMessage({ type: 'ready' }), (e) => postMessage({ type: 'error', message: 'Engine failed to load: ' + e.message }));

onmessage = async ({ data: { id, name, bytes, maxMb, author } }) => {
  const log = [];
  try {
    const py = await ready;
    py.setStdout({ batched: (s) => { log.push(s); postMessage({ type: 'log', id, line: s }); } });
    const stem = name.replace(/\.[^.]*$/, '').replace(/[^\w\- ]+/g, '_').trim() || 'avatar';
    const out = `/work/${stem}.vrm`;
    py.FS.writeFile('/work/in.glb', new Uint8Array(bytes));
    py.globals.set('argv', py.toPy(['glb2vrm0.py', '/work/in.glb', out, '--max-mb', String(maxMb), '--author', author || 'Unknown']));
    py.runPython(`
import sys, runpy, traceback
sys.argv = list(argv)
err = None
try: runpy.run_path('/work/glb2vrm0.py', run_name='__main__')
except BaseException as e:
    err = f"{type(e).__name__}: {e}" if str(e) else type(e).__name__
    if not isinstance(e, AssertionError): traceback.print_exc(file=sys.stdout)
`);
    const err = py.globals.get('err');
    if (err) throw new Error(err.startsWith('AssertionError: ') ? err.slice(16) : `Unsupported or broken GLB (${err})`);
    const vrm = py.FS.readFile(out);
    py.FS.unlink(out); py.FS.unlink('/work/in.glb');
    const summary = log.filter((l) => l.startsWith(out)).pop() || '';
    const step = (summary.match(/\(([^)]*)\)/) || [])[1] || '';
    postMessage({ type: 'done', id, name: `${stem}.vrm`, vrm, step, overBudget: summary.includes('WARNING'), log }, [vrm.buffer]);
  } catch (e) {
    postMessage({ type: 'fail', id, message: e.message, log });
  }
};
