// Refreshes engine/ (the Python engine the app runs, its bundled data and its pure tests) from the
// full ARIA source tree one level up (../aria, ../data, ../tests). Does nothing when that tree is absent,
// so this project builds on its own from engine/.
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(APP, '..');
const ENGINE = join(APP, 'engine');

// Only the modules the on-device bridge and the tests import (no forecasting, replay or data build code).
const MODULES = [
  '__init__.py', 'hashing.py', 'metrics.py', 'schemas.py', 'svcr.py', 'validate.py',
  'engine/__init__.py', 'engine/baseline_a.py', 'engine/baselines.py', 'engine/diff.py', 'engine/eligibility.py',
  'engine/network_model.py', 'engine/optimizer.py', 'engine/pipeline.py', 'engine/reasons.py', 'engine/shocks.py', 'engine/values.py',
  'forecast/__init__.py', 'forecast/segments.py',
  'verify/__init__.py', 'verify/verifier.py',
];
const TESTS = ['__init__.py', 'fixtures.py', 'test_optimizer.py', 'test_reasons.py', 'test_shocks.py', 'test_svcr.py',
  'test_verifier_mutations.py', 'test_metrics.py', 'test_validate.py'];

if (!existsSync(join(SRC, 'aria', 'schemas.py')) || !existsSync(join(SRC, 'data'))) {
  console.log('sync-engine: no ../aria and ../data next to this project; keeping engine/ as is');
  process.exit(0);
}

const copy = (from, to) => { mkdirSync(dirname(to), { recursive: true }); cpSync(from, to); };
const fresh = (dir) => { rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true }); };
const pick = (dir, re) => (existsSync(dir) ? readdirSync(dir).filter((n) => re.test(n)).sort() : []);

fresh(join(ENGINE, 'aria'));
for (const m of MODULES) copy(join(SRC, 'aria', m), join(ENGINE, 'aria', m));

fresh(join(ENGINE, 'data'));
copy(join(SRC, 'data', 'params.yaml'), join(ENGINE, 'data', 'params.yaml'));
for (const n of pick(join(SRC, 'data', 'scenarios'), /\.json$/)) copy(join(SRC, 'data', 'scenarios', n), join(ENGINE, 'data', 'scenarios', n));
for (const n of pick(join(SRC, 'data', 'networks'), /\.yaml$/)) copy(join(SRC, 'data', 'networks', n), join(ENGINE, 'data', 'networks', n));
for (const n of pick(join(SRC, 'data', 'built'), /^replay_.*\.json$/)) copy(join(SRC, 'data', 'built', n), join(ENGINE, 'data', 'built', n));

fresh(join(ENGINE, 'tests'));
for (const t of TESTS) if (existsSync(join(SRC, 'tests', t))) copy(join(SRC, 'tests', t), join(ENGINE, 'tests', t));

console.log(`sync-engine: ${MODULES.length} modules, data and ${TESTS.length} test files copied into engine/`);
