// Sign in, or create an account: an admin creates a team; a driver joins one with the team's 6-letter code.
import { errorText, lookupCode, resetPassword, signIn, signUpAdmin, signUpDriver } from '../cloud';
import { h, icon, mount } from '../ui';

type Mode = 'signin' | 'admin' | 'driver' | 'reset';
let mode: Mode = 'signin';
let root: HTMLElement;
let busy = false;
let error = '';
let info = '';
const vals: Record<string, string> = {}; // typed values survive a redraw (an error message must not clear the form)

const field = (labelText: string, attrs: Record<string, any>) => h('label', {}, labelText,
  h('input', { required: true, value: vals[attrs.name] ?? '', oninput: (e: Event) => { vals[attrs.name] = (e.target as HTMLInputElement).value; }, ...attrs }));
const val = (form: HTMLFormElement, name: string) => String(new FormData(form).get(name) ?? '').trim();

export function render(r: HTMLElement) {
  root = r;
  draw();
}

function go(m: Mode) {
  mode = m;
  error = info = '';
  draw();
}

async function run(form: HTMLFormElement, fn: () => Promise<unknown>) {
  if (busy) return;
  if (!form.reportValidity()) return;
  busy = true;
  error = '';
  draw();
  try {
    await fn();
  } catch (e: any) {
    error = errorText(e);
  } finally {
    busy = false;
    draw();
  }
}

function draw() {
  const back = h('button', { type: 'button', class: 'btn ghost block', onclick: () => go('signin') }, 'Back to sign in');
  const submit = (text: string) => h('button', { type: 'submit', class: 'btn primary block', disabled: busy }, busy ? 'Please wait...' : text);
  const msg = [error && h('div', { class: 'alert bad', role: 'alert' }, error), info && h('div', { class: 'alert ok', role: 'status' }, info)];
  let body: HTMLElement;
  if (mode === 'signin') {
    const form: HTMLFormElement = h('form', { class: 'card login-card', onsubmit: (e: Event) => { e.preventDefault(); run(form, () => signIn(val(form, 'email'), val(form, 'password'))); } },
      h('h2', {}, 'Sign in'),
      field('Email', { type: 'email', name: 'email', autocomplete: 'email' }),
      field('Password', { type: 'password', name: 'password', autocomplete: 'current-password', minLength: 6 }),
      msg, submit('Sign in'),
      h('button', { type: 'button', class: 'btn ghost block', onclick: () => go('reset') }, 'Forgot password?'));
    body = h('div', {}, form,
      h('section', { class: 'card' }, h('p', { class: 'eyebrow' }, 'New here?'),
        h('button', { class: 'btn block', onclick: () => go('admin') }, icon('users'), 'I manage a team: create one'),
        h('button', { class: 'btn block', onclick: () => go('driver') }, icon('truck'), 'I am a driver: join my team')));
  } else if (mode === 'admin') {
    const form: HTMLFormElement = h('form', { class: 'card login-card', onsubmit: (e: Event) => { e.preventDefault(); run(form, () => signUpAdmin(val(form, 'name'), val(form, 'email'), val(form, 'password'), val(form, 'team'))); } },
      h('h2', {}, 'Create your team'),
      h('p', { class: 'small muted' }, 'You will be the admin: you load the data, plan the night and send each driver their trip. Drivers join with a code you get after this.'),
      field('Your name', { name: 'name', autocomplete: 'name' }),
      field('Company or team name', { name: 'team', autocomplete: 'organization' }),
      field('Email', { type: 'email', name: 'email', autocomplete: 'email' }),
      field('Password (at least 6 characters)', { type: 'password', name: 'password', autocomplete: 'new-password', minLength: 6 }),
      msg, submit('Create team'), back);
    body = form;
  } else if (mode === 'driver') {
    const team = h('p', { class: 'small', 'aria-live': 'polite' });
    const check = async (input: HTMLInputElement) => {
      input.value = input.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
      vals.code = input.value;
      if (input.value.length < 6) return (team.textContent = '');
      try {
        const t = await lookupCode(input.value);
        team.textContent = t ? `Team found: ${t.team || 'your team'}` : 'No team with this code. Check it with your admin.';
        team.className = t ? 'small ok-text' : 'small bad-text';
      } catch { team.textContent = ''; }
    };
    const form: HTMLFormElement = h('form', { class: 'card login-card', onsubmit: (e: Event) => { e.preventDefault(); run(form, () => signUpDriver(val(form, 'name'), val(form, 'email'), val(form, 'password'), val(form, 'code'), val(form, 'phone'), val(form, 'vehicle'))); } },
      h('h2', {}, 'Join your team'),
      h('p', { class: 'small muted' }, 'Ask your admin for the 6-letter team code. You will see the trips they send you.'),
      h('label', {}, 'Team code', h('input', { name: 'code', required: true, value: vals.code ?? '', autocapitalize: 'characters', inputMode: 'text', class: 'code-input', maxLength: 6, minLength: 6,
        oninput: (e: Event) => check(e.target as HTMLInputElement) })),
      team,
      field('Your name', { name: 'name', autocomplete: 'name' }),
      field('Phone number', { type: 'tel', name: 'phone', autocomplete: 'tel' }),
      field('Vehicle number', { name: 'vehicle', placeholder: 'e.g. MH09 AB 1234' }),
      field('Email', { type: 'email', name: 'email', autocomplete: 'email' }),
      field('Password (at least 6 characters)', { type: 'password', name: 'password', autocomplete: 'new-password', minLength: 6 }),
      msg, submit('Join team'), back);
    body = form;
  } else {
    const form: HTMLFormElement = h('form', { class: 'card login-card', onsubmit: (e: Event) => { e.preventDefault(); run(form, async () => { await resetPassword(val(form, 'email')); info = 'Check your email for a link to set a new password.'; }); } },
      h('h2', {}, 'Reset password'),
      field('Email', { type: 'email', name: 'email', autocomplete: 'email' }),
      msg, submit('Send reset link'), back);
    body = form;
  }
  mount(root, h('div', { class: 'brand' }, h('img', { class: 'logo', src: `${import.meta.env.BASE_URL}logo.png`, alt: 'ARIA' }), h('p', { class: 'muted' }, "Plan tonight's deliveries")), body);
}
