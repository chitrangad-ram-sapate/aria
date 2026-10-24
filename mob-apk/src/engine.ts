// Main-thread client for the engine worker. Calls are queued by the worker and answered in order.
import type { Json } from './ui';

const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
let seq = 0;
let onProgress: (pct: number, stage: string) => void = () => {};

worker.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'progress') return onProgress(m.pct, m.stage);
  const p = pending.get(m.id);
  if (!p) return;
  pending.delete(m.id);
  m.ok ? p.resolve(m.result) : p.reject(new Error(m.error));
};
worker.onerror = (e) => {
  for (const p of pending.values()) p.reject(new Error(e.message || 'engine worker crashed'));
  pending.clear();
};

function call<T = Json>(fn: string, ...args: unknown[]): Promise<T> {
  const id = ++seq;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    worker.postMessage({ id, fn, args });
  });
}

export const engine = {
  boot: (progress: typeof onProgress) => { onProgress = progress; return call<{ backend: string; python: string; pyodide: string }>('boot'); },
  listNetworks: () => call<Json[]>('listNetworks'),
  listScenarios: () => call<Json[]>('listScenarios'),
  getScenario: (id: string) => call('getScenario', id),
  validate: (scenario: Json) => call('validate', scenario),
  plan: (scenario: Json) => call('plan', scenario),
  explain: (planId: string, town: string, product: string) => call('explain', planId, town, product),
  exportSvcr: (planId: string) => call<Uint8Array>('exportSvcr', planId),
  openSvcr: (bytes: Uint8Array) => call('openSvcr', bytes),
  replay: (network: string, freightPoint?: string) => call('replay', network, freightPoint),
  loadCsv: (text: string, base: Json | null) => call('loadCsv', text, base),
  sampleCsv: (scenarioId: string) => call<string>('sampleCsv', scenarioId),
  exportCsv: (scenario: Json) => call<string>('exportCsv', scenario),
  csvFormat: () => call<Json[]>('csvFormat'),
  vehicleOptions: (scenario: Json, godown: string, town: string) => call<string[]>('vehicleOptions', scenario, godown, town),
  compare: (scenario: Json, variants: Json[]) => call('compare', scenario, variants),
};
