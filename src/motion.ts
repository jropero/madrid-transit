// Metro "tilt": a pressed .tilt element leans away from the pointer (CSS reads --rx / --ry / --s).
const MAX_DEG = 8;
const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

export function registerTilt() {
  let el: HTMLElement | null = null;

  const reset = () => {
    el?.style.removeProperty('--rx');
    el?.style.removeProperty('--ry');
    el?.style.removeProperty('--s');
    el = null;
  };

  document.addEventListener('pointerdown', e => {
    reset();
    const t = (e.target as Element | null)?.closest<HTMLElement>('.tilt');
    if (!t || reduced() || t.matches(':disabled')) return;
    const r = t.getBoundingClientRect();
    const dx = ((e.clientX - r.left) / r.width - 0.5) * 2;
    const dy = ((e.clientY - r.top) / r.height - 0.5) * 2;
    t.style.setProperty('--ry', `${(dx * MAX_DEG).toFixed(1)}deg`);
    t.style.setProperty('--rx', `${(-dy * MAX_DEG).toFixed(1)}deg`);
    t.style.setProperty('--s', '0.97');
    el = t;
  });
  document.addEventListener('pointerup', reset);
  document.addEventListener('pointercancel', reset);
  // pointerleave does not bubble: capture it so leaving the pressed element resets it.
  document.addEventListener('pointerleave', e => e.target === el && reset(), true);
}
