import { useEffect, useRef, useState } from 'react';
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react';
import { flushSync } from 'react-dom';

// Endless Windows Phone-style pivot: three panes (previous, active, next) sit side by side
// and a pointer drag moves them together through the `--drag` CSS variable on `.panes`.

const LOCK_PX = 10;
const LOCK_RATIO = 1.2;
const DISTANCE_SHARE = 0.25;
const FLICK_SPEED = 0.4; // px/ms
const WHEEL_PX = 60;
const WHEEL_PAUSE_MS = 500;
const SETTLE_MS = 250;

export type Dir = -1 | 0 | 1;

export const wrap = (i: number, n: number) => ((i % n) + n) % n;

// Where pane `i` sits when `active` is shown: -1 left, 0 centre, 1 right, null hidden.
// With two panes the neighbour is both previous and next: it sits on the right.
export function slotOf(i: number, active: number, n: number): -1 | 0 | 1 | null {
  if (i === active) return 0;
  if (i === wrap(active + 1, n)) return 1;
  return i === wrap(active - 1, n) ? -1 : null;
}

// Which neighbour a released drag goes to: 1 = next (dragged left), -1 = previous.
export function releaseTarget(dx: number, width: number, velocity: number): Dir {
  const fast = Math.abs(velocity) > FLICK_SPEED;
  const far = Math.abs(dx) > width * DISTANCE_SHARE;
  if (!fast && !far) return 0;
  const along = fast ? velocity : dx;
  return along < 0 ? 1 : -1;
}

console.assert(wrap(-1, 4) === 3 && wrap(4, 4) === 0 && wrap(2, 4) === 2, 'wrap');
console.assert(
  slotOf(0, 0, 4) === 0 &&
    slotOf(1, 0, 4) === 1 &&
    slotOf(3, 0, 4) === -1 &&
    slotOf(2, 0, 4) === null &&
    slotOf(0, 3, 4) === 1 &&
    slotOf(1, 0, 2) === 1 &&
    slotOf(0, 0, 1) === 0,
  'slotOf',
);
console.assert(
  releaseTarget(-101, 400, 0) === 1 &&
    releaseTarget(100, 400, 0) === 0 &&
    releaseTarget(30, 400, 0.5) === -1 &&
    releaseTarget(-30, 400, -0.5) === 1 &&
    releaseTarget(-30, 400, -0.1) === 0 &&
    releaseTarget(101, 400, 0) === -1,
  'releaseTarget',
);

type Gesture = {
  id: number;
  x: number;
  y: number;
  lastX: number;
  lastT: number;
  vel: number;
  dx: number;
  horizontal: boolean;
};

type Core = {
  g: Gesture | null;
  end: (() => void) | null; // finishes the running animation at once
  acc: number; // accumulated horizontal wheel
  until: number; // wheel input ignored until this time
};

const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
// The drag offset and state classes live on the panes' parent (the app), so the header row
// can follow the finger too (`.views-row` reads `--drag`).
const hostOf = (el: HTMLElement) => el.parentElement ?? el;
const setDrag = (el: HTMLElement, px: number) =>
  hostOf(el).style.setProperty('--drag', `${px}px`);
const isPaneMove = (e: TransitionEvent) =>
  e.propertyName === 'transform' && e.target instanceof Element && e.target.matches('.pane');
const noSwipe = (t: EventTarget) =>
  t instanceof Element && !!t.closest('input, textarea, select, [data-no-swipe]');

// The click a mouse drag would fire on release is swallowed once.
function swallowNextClick(el: HTMLElement) {
  const stop = (e: Event) => e.stopPropagation();
  el.addEventListener('click', stop, { capture: true, once: true });
  setTimeout(() => el.removeEventListener('click', stop, { capture: true }), 0);
}

// A drag that starts vertical is dropped (null); one that turns clearly horizontal locks.
function classify(g: Gesture, dx: number, dy: number): 'wait' | 'lock' | 'drop' {
  if (Math.abs(dx) > LOCK_PX && Math.abs(dx) > Math.abs(dy) * LOCK_RATIO) return 'lock';
  return Math.abs(dy) > LOCK_PX && !g.horizontal ? 'drop' : 'wait';
}

// Pointer handlers for every element a pivot swipe can start on (header and panes).
export type PivotDrag = {
  onPointerDown: (e: ReactPointerEvent<HTMLElement>) => void;
  onPointerMove: (e: ReactPointerEvent<HTMLElement>) => void;
  onPointerUp: (e: ReactPointerEvent<HTMLElement>) => void;
  onPointerCancel: (e: ReactPointerEvent<HTMLElement>) => void;
};

export function usePivot<V extends string>(
  views: readonly V[],
  onChange: (v: V) => void,
  fromPop: () => V,
) {
  const ref = useRef<HTMLDivElement>(null);
  const core = useRef<Core>({ g: null, end: null, acc: 0, until: 0 });
  const viewRef = useRef<V>(views[0]);
  const [view, setView] = useState<V>(views[0]);
  const [turning, setTurning] = useState<V | null>(views[0]);
  const n = views.length;

  const neighbour = (dir: 1 | -1) => views[wrap(views.indexOf(viewRef.current) + dir, n)];

  const commit = (next: V) => {
    viewRef.current = next;
    onChange(next);
    flushSync(() => setView(next));
  };

  // Slide to a neighbour (dir 1 / -1) or back to the centre (0), then switch the view.
  const settle = (dir: Dir) => {
    const el = ref.current;
    if (!el) return;
    core.current.end?.();
    const finish = () => {
      core.current.end = null;
      el.removeEventListener('transitionend', onEnd);
      clearTimeout(timer);
      hostOf(el).classList.remove('settling');
      setDrag(el, 0);
      if (dir) commit(neighbour(dir));
      void el.offsetWidth; // apply the new slots without a transition
    };
    // transitionend bubbles up from the panes (the ones that move).
    const onEnd = (e: TransitionEvent) => isPaneMove(e) && finish();
    const timer = setTimeout(finish, SETTLE_MS + 60);
    core.current.end = finish;
    if (reducedMotion()) return finish();
    el.addEventListener('transitionend', onEnd);
    hostOf(el).classList.add('settling');
    setDrag(el, -dir * el.clientWidth);
  };

  const goTo = (v: V) => {
    core.current.end?.();
    if (v === viewRef.current) return;
    const dir = [1, -1].find(d => neighbour(d as 1 | -1) === v) as 1 | -1 | undefined;
    if (dir) return settle(dir);
    commit(v);
    setTurning(v);
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLElement>) => {
    const c = core.current;
    if (c.end || e.button > 0 || noSwipe(e.target)) return;
    c.g = {
      id: e.pointerId,
      x: e.clientX,
      y: e.clientY,
      lastX: e.clientX,
      lastT: e.timeStamp,
      vel: 0,
      dx: 0,
      horizontal: false,
    };
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLElement>) => {
    const g = core.current.g;
    const el = ref.current;
    if (!g || !el || g.id !== e.pointerId) return;
    const dx = e.clientX - g.x;
    const verdict = classify(g, dx, e.clientY - g.y);
    if (verdict === 'drop') core.current.g = null;
    if (verdict === 'lock' && !g.horizontal) lock(el, g, e.pointerId);
    if (!g.horizontal) return;
    const dt = Math.max(1, e.timeStamp - g.lastT);
    g.vel = (e.clientX - g.lastX) / dt;
    g.lastX = e.clientX;
    g.lastT = e.timeStamp;
    g.dx = Math.max(-el.clientWidth, Math.min(el.clientWidth, dx));
    setDrag(el, g.dx);
  };

  // A horizontal drag from the header or the panes: the panes take the pointer (so a drag that
  // began on a header button never clicks it) and nothing gets text-selected on the way.
  const lock = (el: HTMLElement, g: Gesture, pointerId: number) => {
    g.horizontal = true;
    el.setPointerCapture(pointerId);
    hostOf(el).classList.add('dragging');
    getSelection()?.removeAllRanges();
  };
  const unlock = (el: HTMLElement | null) => el && hostOf(el).classList.remove('dragging');

  const onPointerUp = (e: ReactPointerEvent<HTMLElement>) => {
    const g = core.current.g;
    const el = ref.current;
    if (!g || !el || g.id !== e.pointerId) return;
    core.current.g = null;
    unlock(el);
    if (!g.horizontal) return;
    if (e.pointerType === 'mouse') swallowNextClick(el);
    settle(releaseTarget(g.dx, el.clientWidth, g.vel));
  };

  const onPointerCancel = (e: ReactPointerEvent<HTMLElement>) => {
    const g = core.current.g;
    if (!g || g.id !== e.pointerId) return;
    core.current.g = null;
    unlock(ref.current);
    if (g.horizontal) settle(0);
  };

  // Horizontal trackpad scrolling: one step per gesture, then a pause.
  const onWheel = (e: WheelEvent) => {
    if (Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return;
    e.preventDefault();
    const c = core.current;
    if (e.timeStamp < c.until) return;
    c.acc += e.deltaX;
    if (Math.abs(c.acc) <= WHEEL_PX) return;
    const dir = c.acc > 0 ? 1 : -1;
    c.acc = 0;
    c.until = e.timeStamp + WHEEL_PAUSE_MS;
    settle(dir);
  };

  // The listeners are added once and call the latest handlers through a ref: re-adding them on
  // every render dropped the back button whenever another popstate listener (nav.ts) made the
  // app render during the same event (a listener added mid-dispatch is not called).
  const latest = useRef({ goTo, onWheel, fromPop });
  useEffect(() => {
    latest.current = { goTo, onWheel, fromPop };
  });
  useEffect(() => {
    const el = ref.current;
    const wheel = (e: WheelEvent) => latest.current.onWheel(e);
    // System back (Android gesture, iOS swipe-back, browser button) follows the history entry.
    const onPop = () => latest.current.goTo(latest.current.fromPop());
    el?.addEventListener('wheel', wheel, { passive: false });
    window.addEventListener('popstate', onPop);
    return () => {
      el?.removeEventListener('wheel', wheel);
      window.removeEventListener('popstate', onPop);
    };
  }, []);

  const paneStyle = (v: V): CSSProperties => {
    const slot = slotOf(views.indexOf(v), views.indexOf(view), n);
    return {
      transform: `translateX(calc(${slot ?? 0} * 100% + var(--drag, 0px)))`,
      visibility: slot === null ? 'hidden' : undefined,
    };
  };

  // Props for the inner element of a pane: plays the turnstile entrance after a jump.
  const paneIn = (v: V) => ({
    className: v === turning ? 'pane-in turn' : 'pane-in',
    onAnimationEnd: (e: React.AnimationEvent) => {
      if (e.target === e.currentTarget) setTurning(null);
    },
  });

  return {
    ref,
    view,
    goTo,
    paneStyle,
    paneIn,
    drag: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel } satisfies PivotDrag,
  };
}
