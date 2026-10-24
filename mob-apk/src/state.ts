// App state shared by the views, and the result-integrity rules (implementation.md §7):
// increasing request ids, only the latest result is shown, edits mark results STALE.
import { engine } from './engine';
import { sampleName } from './plain';
import type { PlanFile, Profile, Report, Trip } from './cloud';
import type { Json } from './ui';

export type Variant = { id: string; name: string; params: Json };

export const state = {
  networks: [] as Json[],
  scenarios: [] as Json[], // bundled sample datasets
  networkId: '',
  scenarioId: '', // name of the loaded dataset
  scenario: null as Json, // the editable scenario document, always built from a data CSV
  data: null as Json, // how the current dataset was loaded: {name, source, sections, kept, warnings, forecast, history}
  dataErrors: null as Json[] | null, // rows rejected by the last upload (the dataset was left unchanged)
  dataBusy: false,
  report: null as Json, // validate() result for the current inputs
  validating: false,
  rid: 0, // last request id issued (all compute calls)
  plan: null as null | { rid: number; resp: Json },
  planRid: 0,
  planBusy: false,
  planError: '',
  lab: {
    variants: [] as Variant[],
    selected: '',
    result: null as null | { rid: number; resp: Json; key: string },
    busy: false,
    error: '',
    sweep: null as null | { param: string; values: number[]; resp: Json; key: string },
    sweepBusy: false,
  },
  me: null as Profile | null, // signed-in user
  team: null as null | { name: string; joinCode: string },
  drivers: [] as Profile[], // admin: every driver in the team
  trips: [] as Trip[], // admin: all team trips; driver: their own
  reports: [] as Report[],
  files: [] as PlanFile[], // admin: plan files sent to drivers; driver: files sent to them
  bundledForecast: 'LightGBM quantile forecast, conformal-calibrated',
  engineInfo: '', // e.g. "Python 3.12.7 · SciPy HiGHS"
};

let fullRender = () => {};
export const onFullRender = (fn: () => void) => { fullRender = fn; };
export const rerender = () => fullRender();

const listeners = new Set<() => void>();
export const subscribe = (fn: () => void) => listeners.add(fn);
export const notify = () => listeners.forEach((fn) => fn());

export const nextRid = () => ++state.rid;
export const currentHash = (): string | null => (state.validating ? null : state.report?.scenario_hash ?? null);
export const isStale = (resp: Json) => !resp || !currentHash() || resp.scenario_hash !== currentHash();

let validateSeq = 0;
let timer = 0;
export function scheduleValidate(delay = 250) {
  state.validating = true;
  notify();
  clearTimeout(timer);
  timer = window.setTimeout(async () => {
    const my = ++validateSeq;
    try {
      const r = await engine.validate(state.scenario);
      if (my !== validateSeq) return;
      state.report = r;
    } catch (e: any) {
      if (my !== validateSeq) return;
      state.report = { valid: false, errors: [{ code: 'ENGINE', path: '$', message: e.message }], warnings: [], scenario_hash: null };
    }
    state.validating = false;
    notify();
  }, delay);
}

// ---------- datasets: everything enters through a data CSV ----------
const STORE = 'aria.dataset.v1';

/** Parse a data CSV. Sections the file lacks are kept from the current dataset (reported). */
export async function loadCsvText(text: string, name: string, source: 'csv' | 'sample') {
  state.dataBusy = true;
  state.dataErrors = null;
  rerender();
  try {
    const r = await engine.loadCsv(text, source === 'sample' ? null : state.scenario);
    if (!r.ok) {
      state.dataErrors = r.errors?.length ? r.errors : [{ section: '', line: null, message: 'The file could not be read.' }];
      if (r.error_count > (r.errors?.length ?? 0)) state.dataErrors!.push({ section: '', line: null, message: `…${r.error_count - r.errors.length} more problems` });
      return false;
    }
    const sc = r.scenario;
    if (source === 'csv' && !r.sections.settings && !state.scenario) sc.scenario_id = name.replace(/\.csv$/i, '');
    setDataset(sc, { name: source === 'sample' ? sampleName(sc.scenario_id) : sc.scenario_id || name, file: name, source, sections: r.sections, kept: r.kept, warnings: r.warnings, forecast: r.forecast, history: r.history ?? state.data?.history ?? null });
    return true;
  } catch (e: any) {
    state.dataErrors = [{ section: '', line: null, message: e.message }];
    return false;
  } finally {
    state.dataBusy = false;
    rerender();
  }
}

export async function loadSample(id: string) {
  const text = await engine.sampleCsv(id);
  return loadCsvText(text, `${id}.csv`, 'sample');
}

function setDataset(sc: Json, info: Json) {
  state.scenario = sc;
  state.scenarioId = info.name;
  state.networkId = sc.network_id ?? '';
  state.data = info;
  state.plan = null;
  state.planError = '';
  state.lab.result = null;
  state.lab.sweep = null;
  state.lab.error = '';
  persist();
  scheduleValidate(0);
}

/** Keep the dataset on this device as its CSV (merged sections and saved edits included). */
export async function persist() {
  if (!state.scenario) return;
  try {
    const csv = await engine.exportCsv(state.scenario);
    const { history, ...meta } = state.data ?? {};
    localStorage.setItem(STORE, JSON.stringify({ csv, meta, history }));
  } catch { /* storage full or blocked: the dataset still works for this session */ }
}

export async function restoreSaved(): Promise<boolean> {
  let saved: Json = null;
  try { saved = JSON.parse(localStorage.getItem(STORE) ?? 'null'); } catch { saved = null; }
  if (!saved?.csv) return false;
  const r = await engine.loadCsv(saved.csv, null);
  if (!r.ok) return false;
  setDataset(r.scenario, { ...saved.meta, history: saved.history ?? null, restored: true });
  return true;
}

export function forgetSaved() {
  try { localStorage.removeItem(STORE); } catch { /* nothing stored */ }
}

export const network = () => state.networks.find((n) => n.network_id === state.networkId) ?? {};

/** Which model produced a (town, product)'s demand. */
export function forecastLabel(town?: string, product?: string): string {
  const fc = state.data?.forecast;
  if (fc && (!town || fc.keys?.includes(`${town}|${product}`))) return fc.label;
  return state.data?.source === 'sample' ? state.bundledForecast : 'forecast given in your CSV';
}
