// App state shared by the views, and the result-integrity rules (implementation.md §7):
// increasing request ids, only the latest result is shown, edits mark results STALE.
import { engine } from './engine';
import type { Json } from './ui';

export const state = {
  networks: [] as Json[],
  scenarios: [] as Json[],
  networkId: '',
  scenarioId: '',
  scenario: null as Json, // the editable scenario document
  report: null as Json, // validate() result for the current inputs
  validating: false,
  rid: 0, // last request id issued (all compute calls)
  plan: null as null | { rid: number; resp: Json },
  planRid: 0,
  planBusy: false,
  planError: '',
  whatif: null as null | { rid: number; resp: Json; key: string },
  whatifRid: 0,
  whatifBusy: false,
  whatifError: '',
  bundledForecast: 'LightGBM quantile forecast, conformal-calibrated',
  importInfo: null as Json, // last on-device CSV import into the current scenario
  imported: null as Set<string> | null, // "town|product" pairs whose demand came from that import
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

export async function loadScenario(id: string) {
  state.scenarioId = id;
  state.scenario = await engine.getScenario(id);
  state.networkId = state.scenario.network_id ?? state.networkId;
  state.plan = null;
  state.whatif = null;
  state.planError = state.whatifError = '';
  state.importInfo = null;
  state.imported = null;
  fullRender();
  scheduleValidate(0);
}

export const network = () => state.networks.find((n) => n.network_id === state.networkId) ?? {};

/** Which model produced a (town, product)'s demand; with no pair, the bundled forecasts' model. */
export function forecastLabel(town?: string, product?: string): string {
  if (town && state.imported?.has(`${town}|${product}`)) return state.importInfo?.label ?? 'imported';
  return state.bundledForecast;
}
