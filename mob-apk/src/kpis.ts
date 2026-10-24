// Names, units and formatting for the plan KPIs the engine returns (analysis.KPI_KEYS). Shared by What-if and Results.
import { pctText } from './charts';
import { num, rupees } from './ui';

export type Kpi = { key: string; label: string; fmt: (v: number) => string; diff: (v: number) => string; lowerIsBetter: boolean; unit: string };

const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
const signed = (f: (v: number) => string) => (v: number) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${f(Math.abs(v))}`;

export const KPIS: Kpi[] = [
  { key: 'units_shipped', label: 'Units shipped', fmt: num, diff: signed(num), lowerIsBetter: false, unit: 'units' },
  { key: 'expected_fill_rate', label: 'Demand met (fill rate)', fmt: pct, diff: signed((v) => `${(v * 100).toFixed(1)} pts`), lowerIsBetter: false, unit: '%' },
  { key: 'expected_lost_margin_paise', label: 'Lost sales value', fmt: rupees, diff: signed(rupees), lowerIsBetter: true, unit: '₹' },
  { key: 'expected_lost_units', label: 'Expected lost sales', fmt: num, diff: signed(num), lowerIsBetter: true, unit: 'units' },
  { key: 'freight_paise', label: 'Freight cost', fmt: rupees, diff: signed(rupees), lowerIsBetter: true, unit: '₹' },
  { key: 'shortfall_units', label: 'Shortage units', fmt: num, diff: signed(num), lowerIsBetter: true, unit: 'units' },
  { key: 'at_risk_units_left', label: 'Stock left to expire', fmt: num, diff: signed(num), lowerIsBetter: true, unit: 'units' },
  { key: 'at_risk_writeoff_paise', label: 'Expected write-off', fmt: rupees, diff: signed(rupees), lowerIsBetter: true, unit: '₹' },
  { key: 'capacity_utilisation', label: 'Depot capacity used', fmt: pct, diff: signed((v) => `${(v * 100).toFixed(1)} pts`), lowerIsBetter: false, unit: '%' },
];
export const kpi = (key: string) => KPIS.find((k) => k.key === key)!;

/** Change chip for an engine diff {abs, pct, better}: green when better, amber when worse. */
export function chip(d: { abs: number; pct: number | null; better: boolean | null } | undefined, k: Kpi) {
  if (!d) return null;
  if (d.better == null) return { text: 'no change', kind: '' as const };
  const text = d.pct == null ? k.diff(d.abs) : `${pctText(d.pct)} (${k.diff(d.abs)})`;
  return { text, kind: (d.better ? 'ok' : 'warn') as 'ok' | 'warn' };
}
