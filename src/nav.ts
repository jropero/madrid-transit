import { useEffect, useRef, useState } from 'react';
import type { Saved } from './gtfs.ts';

// Stop navigation: a jump (line stop list, connection, search) pushes a history entry so system
// back walks the jumps; picking a saved stop only replaces the current entry.
// `trail` = the stops of the current exploration, from where the first jump started to `stop`.
export type Nav = { stop: Saved; trail?: Saved[]; openLine?: string };

const navOf = (st: unknown): Nav | null => {
  const s = st as Partial<Nav> | null;
  return s?.stop?.id ? (s as Nav) : null;
};
const entry = (n: Nav) => ({ view: 'departures', ...n });
const onPivotEntry = () => !!(history.state as { pivot?: boolean } | null)?.pivot;
const onGuardEntry = () => !!(history.state as { guard?: boolean } | null)?.guard;
const TOAST_MS = 2000;
const write = (n: Nav, push: boolean) => {
  if (onPivotEntry()) return;
  if (push) history.pushState(entry(n), '');
  else history.replaceState(entry(n), '');
};

export function useStopNav(initial: Saved) {
  const [nav, setNav] = useState<Nav>(() => navOf(history.state) ?? { stop: initial });

  const [toast, setToast] = useState(false);
  const navRef = useRef(nav);
  const toastTimer = useRef(0);
  useEffect(() => {
    navRef.current = nav;
  }, [nav]);

  // Fresh load: a guard entry at the bottom, the app entry above it (so the first back after a
  // jump lands on the stop). A reload keeps the restored entries.
  useEffect(() => {
    if (navOf(history.state) || onPivotEntry()) return;
    history.replaceState({ guard: true }, '');
    history.pushState(entry(navRef.current), '');
  }, []);

  useEffect(() => {
    const onPop = () => {
      if (onGuardEntry()) return exitGuard();
      const n = navOf(history.state);
      if (n) setNav(n);
    };
    // Back reached the guard: the first time warn and stay, a second one within 2 s leaves.
    const exitGuard = () => {
      if (toastTimer.current) {
        clearTimeout(toastTimer.current);
        toastTimer.current = 0;
        setToast(false);
        history.back();
        return;
      }
      history.pushState(entry(navRef.current), '');
      setToast(true);
      toastTimer.current = window.setTimeout(() => {
        toastTimer.current = 0;
        setToast(false);
      }, TOAST_MS);
    };
    window.addEventListener('popstate', onPop);
    return () => {
      window.removeEventListener('popstate', onPop);
      clearTimeout(toastTimer.current);
    };
  }, []);

  const select = (stop: Saved) => {
    const n = { stop };
    setNav(n);
    write(n, false);
  };

  const jump = (stop: Saved, openLine?: string) => {
    if (stop.id === nav.stop.id) return;
    const pivot = onPivotEntry();
    const n: Nav = pivot ? { stop } : { stop, trail: [...(nav.trail ?? [nav.stop]), stop] };
    if (!pivot) write({ ...nav, openLine }, false);
    setNav(n);
    write(n, true);
  };

  return { nav, select, jump, toast };
}
