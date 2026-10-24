// Account: who is signed in, their details (name, phone, vehicle), the team, and sign out.
import { logOut, updateMyDetails } from '../cloud';
import { endTracking } from './deliver';
import { state } from '../state';
import { h, icon, kv, mount, toast } from '../ui';

export function render(root: HTMLElement) {
  const me = state.me;
  if (!me) return mount(root);
  const isDriver = me.role === 'driver';
  const form: HTMLFormElement = h('form', { class: 'card', onsubmit: async (e: Event) => {
    e.preventDefault();
    const d = new FormData(form);
    const patch: Record<string, string> = { name: String(d.get('name') ?? '').trim() };
    if (isDriver) { patch.phone = String(d.get('phone') ?? '').trim(); patch.vehicle = String(d.get('vehicle') ?? '').trim(); }
    if (!patch.name) return toast('Please enter your name');
    try { await updateMyDetails(me.uid, patch); toast('Saved'); } catch { toast('Could not save. Check the internet connection.'); }
  } },
    h('h2', {}, 'Your details'),
    h('label', {}, 'Name', h('input', { name: 'name', value: me.name, required: true, autocomplete: 'name' })),
    isDriver && h('label', {}, 'Phone number', h('input', { name: 'phone', type: 'tel', value: me.phone ?? '', autocomplete: 'tel' })),
    isDriver && h('label', {}, 'Vehicle number', h('input', { name: 'vehicle', value: me.vehicle ?? '' })),
    h('button', { type: 'submit', class: 'btn block' }, 'Save details'));
  mount(root,
    h('section', { class: 'card' },
      h('div', { class: 'row between' }, h('div', {}, h('p', { class: 'eyebrow' }, isDriver ? 'Driver' : 'Admin'), h('strong', {}, me.name)), icon('user')),
      kv([['Email', me.email], ['Team', state.team?.name ?? '-'], ...(isDriver ? [] : [['Team code', state.team?.joinCode ?? '-'] as [string, string]])]),
      h('p', { class: 'note' }, isDriver ? 'You see the trips your admin sends you.' : 'You have full control: data, plans, What if, results and your drivers.')),
    form,
    h('button', { class: 'btn block danger', onclick: async () => { await endTracking(); await logOut(); location.reload(); } }, icon('logout'), 'Sign out'));
}
