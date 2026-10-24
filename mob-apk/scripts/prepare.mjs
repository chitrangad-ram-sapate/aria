// Copies the Pyodide runtime + the wheels the engine needs into public/pyodide/v<version>/ and zips
// engine/ (aria package, bundled data, bridge.py) into public/aria-bundle.zip. Everything is served
// locally so the app works offline (D-025). Wheels are downloaded once and cached in .cache/.
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync } from 'fflate';

const MOBILE = join(dirname(fileURLToPath(import.meta.url)), '..');
const ENGINE = join(MOBILE, 'engine');
const PYODIDE = join(MOBILE, 'node_modules', 'pyodide');
const lock = JSON.parse(readFileSync(join(PYODIDE, 'pyodide-lock.json'), 'utf8'));
const version = lock.info.version;
const OUT = join(MOBILE, 'public', 'pyodide', `v${version}`);
const CACHE = join(MOBILE, '.cache', `pyodide-${version}`);
const WANT = ['numpy', 'scipy', 'pydantic', 'pyyaml', 'scikit-learn']; // scikit-learn is loaded only for CSV import

mkdirSync(OUT, { recursive: true });
mkdirSync(CACHE, { recursive: true });
for (const f of ['pyodide.mjs', 'pyodide.asm.js', 'pyodide.asm.wasm', 'python_stdlib.zip', 'pyodide-lock.json']) {
  cpSync(join(PYODIDE, f), join(OUT, f));
}

const norm = (n) => n.toLowerCase().replace(/_/g, '-');
const byName = Object.fromEntries(Object.keys(lock.packages).map((k) => [norm(k), k]));
const needed = new Set();
const visit = (n) => {
  const k = byName[norm(n)];
  if (!k) throw new Error(`package ${n} not in pyodide-lock.json`);
  if (needed.has(k)) return;
  needed.add(k);
  lock.packages[k].depends.forEach(visit);
};
WANT.forEach(visit);

for (const k of needed) {
  const { file_name, sha256 } = lock.packages[k];
  const cached = join(CACHE, file_name);
  if (!existsSync(cached)) {
    const url = `https://cdn.jsdelivr.net/pyodide/v${version}/full/${file_name}`;
    console.log(`download ${url}`);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    writeFileSync(cached, Buffer.from(await res.arrayBuffer()));
  }
  const buf = readFileSync(cached);
  if (createHash('sha256').update(buf).digest('hex') !== sha256) throw new Error(`sha256 mismatch for ${file_name}`);
  cpSync(cached, join(OUT, file_name));
}

// engine/aria/**/*.py (no __pycache__), bundled data and the bridge, at their paths under engine/.
const files = {};
const add = (abs) => { files[relative(ENGINE, abs).replace(/\\/g, '/')] = [readFileSync(abs), { mtime: new Date(2026, 0, 1) }]; };
const walk = (dir, keep) => {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir).sort()) {
    const abs = join(dir, name);
    if (statSync(abs).isDirectory()) { if (name !== '__pycache__') walk(abs, keep); }
    else if (keep(name)) add(abs);
  }
};
walk(join(ENGINE, 'aria'), (n) => n.endsWith('.py'));
walk(join(ENGINE, 'data', 'scenarios'), (n) => n.endsWith('.json'));
walk(join(ENGINE, 'data', 'networks'), (n) => n.endsWith('.yaml'));
walk(join(ENGINE, 'data', 'built'), (n) => /^replay_.*\.json$/.test(n));
add(join(ENGINE, 'data', 'params.yaml'));
for (const n of readdirSync(ENGINE).sort()) if (/\.(py|yaml)$/.test(n)) add(join(ENGINE, n)); // bridge, device forecast, assumptions
const zip = zipSync(files, { level: 9 });
writeFileSync(join(MOBILE, 'public', 'aria-bundle.zip'), zip);
writeFileSync(join(MOBILE, 'src', 'pyodide-version.ts'), `export const PYODIDE_VERSION = '${version}';\n`);
console.log(`pyodide ${version}: ${needed.size} packages; aria-bundle.zip ${Object.keys(files).length} files, ${(zip.length / 1024).toFixed(0)} KiB`);
