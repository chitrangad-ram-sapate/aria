// Motion for the glass dock and page changes: the sliding active pill, a short directional slide + fade between
// pages (the dock itself never moves), per-tab scroll memory, and "tap the active tab to go back to the top".
// Everything respects prefers-reduced-motion. The page scrolls on the window, so that is the scroll container.
const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
const EASE = 'cubic-bezier(0.22, 1, 0.36, 1)';
const DURATION = 320;
const SHIFT = 22;

const scrollMemory = new Map<string, number>();
let ghost: HTMLElement | null = null;
let ghostAnim: Animation | null = null;

/** Place the pill under the active tab of `nav` (hidden when the page has no tab, e.g. Account). */
export function moveIndicator(nav: HTMLElement, animate = true) {
  let pill = nav.querySelector<HTMLElement>('.dock-pill');
  if (!pill) {
    pill = document.createElement('span');
    pill.className = 'dock-pill';
    pill.setAttribute('aria-hidden', 'true');
    nav.prepend(pill);
  }
  const active = nav.querySelector<HTMLElement>('button.tab[aria-current="page"]');
  if (!active) { pill.style.opacity = '0'; return; }
  const inset = 4;
  const x = active.offsetLeft + inset, w = active.offsetWidth - inset * 2;
  if (!animate || reduced.matches || pill.style.opacity !== '1') {
    const t = pill.style.transition;
    pill.style.transition = 'none';
    pill.style.transform = `translateX(${x}px)`;
    pill.style.width = `${w}px`;
    void pill.offsetWidth; // apply without animating, then restore the transition
    pill.style.transition = t;
    pill.style.opacity = '1';
    return;
  }
  pill.style.transform = `translateX(${x}px)`;
  pill.style.width = `${w}px`;
}

/** Small spring on the icon of the tab just chosen. */
export function popIcon(nav: HTMLElement) {
  if (reduced.matches) return;
  const ico = nav.querySelector<HTMLElement>('button.tab[aria-current="page"] .ico');
  if (!ico) return;
  ico.classList.remove('pop');
  void ico.offsetWidth;
  ico.classList.add('pop');
}

/** Keep the pill right when the dock changes width (rotation, resizing). */
export function trackDock(nav: HTMLElement) {
  new ResizeObserver(() => moveIndicator(nav, false)).observe(nav);
  let ticking = false;
  window.addEventListener('scroll', () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => { nav.classList.toggle('scrolled', window.scrollY > 8); ticking = false; });
  }, { passive: true });
}

function clearGhost() {
  ghostAnim?.cancel();
  ghostAnim = null;
  ghost?.remove();
  ghost = null;
}

/**
 * Switch pages: remember where `from` was scrolled, lift its content into a fixed layer that slides out,
 * render `to` into `main`, restore its scroll position and slide it in. `dir` is +1 (rightwards in the dock) or -1.
 */
export function changePage(main: HTMLElement, from: string, to: string, dir: number, render: () => void) {
  if (from) scrollMemory.set(from, window.scrollY);
  clearGhost(); // a quick second tap finishes the previous change at once
  const animate = !reduced.matches && from !== '' && from !== to && main.childNodes.length > 0;
  if (animate) {
    const r = main.getBoundingClientRect();
    ghost = document.createElement('div');
    ghost.className = 'page-ghost';
    ghost.setAttribute('aria-hidden', 'true');
    const top = Math.max(0, r.top);
    Object.assign(ghost.style, { left: `${r.left}px`, width: `${r.width}px`, top: `${top}px`, bottom: '0px' });
    const inner = document.createElement('div');
    inner.className = 'ghost-inner';
    inner.style.top = `${r.top - top}px`;
    inner.style.padding = getComputedStyle(main).padding;
    inner.append(...Array.from(main.childNodes));
    ghost.append(inner);
    document.body.append(ghost);
    ghostAnim = ghost.animate([{ opacity: 1, transform: 'translateX(0)' }, { opacity: 0, transform: `translateX(${-dir * SHIFT}px)` }],
      { duration: DURATION * 0.8, easing: EASE, fill: 'forwards' });
    ghostAnim.onfinish = clearGhost;
  }
  render();
  window.scrollTo({ top: scrollMemory.get(to) ?? 0, behavior: 'instant' as ScrollBehavior });
  if (animate) {
    main.animate([{ opacity: 0, transform: `translateX(${dir * SHIFT}px)` }, { opacity: 1, transform: 'translateX(0)' }],
      { duration: DURATION, easing: EASE });
  }
}

/** Tapping the tab you are already on: glide back to the top, or a small nudge when already there. */
export function backToTop(main: HTMLElement) {
  if (window.scrollY > 2) {
    window.scrollTo({ top: 0, behavior: reduced.matches ? 'instant' as ScrollBehavior : 'smooth' });
    return;
  }
  if (reduced.matches) return;
  main.classList.remove('nudge');
  void main.offsetWidth;
  main.classList.add('nudge');
  main.addEventListener('animationend', () => main.classList.remove('nudge'), { once: true });
}

