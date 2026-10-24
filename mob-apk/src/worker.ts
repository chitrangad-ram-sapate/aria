// Runs the Python engine in Pyodide, off the UI thread (D-025). All engine logic stays in Python;
// this file only loads the runtime and forwards calls to mobile/py/bridge.py.
import type { PyodideInterface } from 'pyodide';
import { PYODIDE_VERSION } from './pyodide-version';

type Req = { id: number; fn: string; args: unknown[] };

const ROOT = new URL(import.meta.env.BASE_URL, self.location.href);
const APP_DIR = '/home/pyodide/app';
let py: PyodideInterface;
let bridge: any;
let ready: Promise<unknown> | null = null;

const progress = (pct: number, stage: string) => self.postMessage({ type: 'progress', pct, stage });

async function boot() {
  const indexURL = new URL(`pyodide/v${PYODIDE_VERSION}/`, ROOT).href;
  progress(5, 'Loading Python runtime');
  const { loadPyodide } = await import(/* @vite-ignore */ indexURL + 'pyodide.mjs');
  py = await loadPyodide({ indexURL, env: { ARIA_SOLVER: 'scipy', HOME: '/home/pyodide' } });
  progress(35, 'Loading numpy, scipy, pydantic');
  const pkgs = ['numpy', 'scipy', 'pydantic', 'pyyaml'];
  let done = 0;
  await py.loadPackage(pkgs, {
    messageCallback: (m: string) => {
      if (m.startsWith('Loaded')) done += 1;
      progress(35 + Math.min(45, done * 6), 'Loading numpy, scipy, pydantic');
    },
  });
  progress(82, 'Unpacking engine');
  const zip = await fetch(new URL('aria-bundle.zip', ROOT)).then((r) => {
    if (!r.ok) throw new Error(`aria-bundle.zip: HTTP ${r.status}`);
    return r.arrayBuffer();
  });
  py.FS.mkdirTree(APP_DIR);
  py.unpackArchive(zip, 'zip', { extractDir: APP_DIR });
  progress(90, 'Starting engine');
  py.runPython(`import os, sys\nos.environ["ARIA_SOLVER"] = "scipy"\nsys.path.insert(0, "${APP_DIR}")`);
  bridge = py.pyimport('bridge');
  const backend = py.runPython('from aria.engine import optimizer; optimizer.backend()');
  progress(100, 'Ready');
  return { backend, python: py.runPython('import sys; sys.version.split()[0]'), pyodide: PYODIDE_VERSION };
}

const json = (s: string) => JSON.parse(s);

async function run(fn: string, args: any[]): Promise<unknown> {
  if (fn === 'boot') return (ready ??= boot());
  if (!ready) throw new Error('engine not started');
  await ready;
  switch (fn) {
    case 'listNetworks': return json(bridge.list_networks());
    case 'listScenarios': return json(bridge.list_scenarios());
    case 'getScenario': return json(bridge.get_scenario(args[0]));
    case 'validate': return json(bridge.validate(JSON.stringify(args[0])));
    case 'plan': return json(bridge.plan(JSON.stringify(args[0])));
    case 'whatif': return json(bridge.whatif(JSON.stringify(args[0]), JSON.stringify(args[1])));
    case 'explain': return json(bridge.explain(args[0], args[1], args[2]));
    case 'replay': return json(bridge.replay(args[0], args[1] ?? null));
    case 'assumptions': return json(bridge.assumptions());
    case 'importCsv': {
      let useMl = true;
      try { await py.loadPackage(['scikit-learn']); } catch { useMl = false; } // lazy: only when importing
      return json(bridge.import_csv(args[0], JSON.stringify(args[1]), useMl));
    }
    case 'exportSvcr': {
      const out = bridge.export_svcr(args[0]);
      const bytes: Uint8Array = out.toJs();
      out.destroy();
      return bytes;
    }
    case 'openSvcr': {
      const data = py.toPy(args[0] as Uint8Array);
      try { return json(bridge.open_svcr(data)); } finally { data.destroy?.(); }
    }
    default: throw new Error(`unknown call ${fn}`);
  }
}

self.onmessage = async (e: MessageEvent<Req>) => {
  const { id, fn, args } = e.data;
  try {
    self.postMessage({ type: 'result', id, ok: true, result: await run(fn, args) });
  } catch (err: any) {
    // Python tracebacks end with the exception line; that is the message worth showing.
    const lines = String(err?.message ?? err).trim().split('\n');
    self.postMessage({ type: 'result', id, ok: false, error: lines[lines.length - 1] });
  }
};
