// Assumptions: A1-A9, limitations, data sources and every parameter with its value, status and source.
import { engine } from '../engine';
import { state } from '../state';
import { Json, errorBox, h, mount, table } from '../ui';

let doc: Json = null;

const val = (v: any) => (v != null && typeof v === 'object' ? JSON.stringify(v) : String(v ?? '-'));

export async function render(root: HTMLElement) {
  if (!doc) {
    mount(root, h('p', { class: 'muted' }, 'Loading...'));
    try {
      doc = await engine.assumptions();
    } catch (e: any) {
      return mount(root, errorBox(e.message));
    }
  }
  mount(root,
    h('section', { class: 'card' }, h('p', { class: 'eyebrow' }, 'How ARIA decides'),
      h('p', { class: 'small' }, 'For every unit, ARIA asks: is the sale it protects worth more than the freight and the risk of it expiring? Below is everything it assumes, every number it uses and where each comes from.'),
      state.engineInfo && h('p', { class: 'note' }, `Runs on this phone: ${state.engineInfo}`)),
    h('section', { class: 'card' }, h('h2', {}, 'Assumptions'),
      h('ul', { class: 'list-cards' }, doc.assumptions.map((a: Json) => h('li', {},
        h('strong', {}, `${a.id} `), a.assumption,
        h('div', { class: 'muted small' }, `Validation: ${a.validation}. If wrong: ${a.impact}.`))))),
    h('section', { class: 'card' }, h('h2', {}, 'Limitations'),
      h('ul', { class: 'list-cards' }, doc.limitations.map((l: Json) => h('li', {}, l.limitation,
        h('div', { class: 'muted small' }, `Effect: ${l.effect}. Mitigation: ${l.mitigation}.`))))),
    h('section', { class: 'card' }, h('h2', {}, 'Forecasts'),
      h('p', {}, `Bundled scenarios: ${doc.bundled_forecast} (9 quantiles per town and product).`),
      h('p', { class: 'muted small' }, 'CSV imports on this device: scikit-learn gradient-boosted quantile regression with split-conformal calibration on the last 28 days, or empirical quantiles of the last 28 days when that is not possible; the method is labelled on every imported forecast.')),
    h('section', { class: 'card' }, h('h2', {}, 'Data sources'),
      h('ul', { class: 'list-cards' }, doc.data_sources.map((d: Json) => h('li', {}, h('strong', {}, d.name), ` (${d.ref})`,
        h('div', { class: 'muted small' }, d.use))))),
    h('section', { class: 'card' }, h('h2', {}, `Parameters (${doc.parameters.length})`),
      table(doc.parameters, [['name', 'Name', String], ['value', 'Value', val], ['status', 'Status', String], ['source', 'Source', String]])),
  );
}
