import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { Dispatch, RefObject, SetStateAction } from 'react';
import { loadArrivalOptions, runScan, type ScanState, type ScanTarget } from './LineScan.tsx';
import {
  byExpected,
  inTimeWindow,
  lineOptions,
  optionFor,
  stopDirections,
  type BusFile,
  type CrtmRow,
  type Departure,
  type LineOption,
} from './gtfs.ts';

// Automatic line scans of the "por hora" board (bus and light-rail stops): every line with
// departures in the next 60 min but no live bus of its own is scanned, one line at a time (each
// scan keeps the manual scan's limit of 3 CRTM requests in flight), a round after another.
// Separate from `useLineScan` (the escáner tab keeps working as it is).
const MAX_TARGETS = 6;
const ROUND_GAP_MS = 30_000;

export type AutoLine = { routeId: string; dest: string; line: string };
type AutoTarget = { key: string; line: string; t: ScanTarget };
type ByKey = Record<string, CrtmRow[]>;
type AutoRows = { stopId: string; byKey: ByKey };
export type AutoProgress = {
  line: string;
  i: number;
  n: number;
  checked: number;
  total: number;
};
type Single = (routeId: string) => boolean;

// A line on the board: route + destination (the route alone on arrivals, whose `dest` is the
// origin, and at a stop with one direction of it).
const lineKey = (d: Departure, arrivals: boolean, single: Single) =>
  arrivals || single(d.routeId) ? d.routeId : `${d.routeId}|${d.dest}`;

// The lines worth scanning, soonest first: no live row in the 60 min window, at least one other
// row there (timetable, "no confirmado" or an earlier estimate, which is re-checked).
export function autoLines(
  deps: Departure[],
  now: number,
  arrivals: boolean,
  single: Single,
  max = MAX_TARGETS,
): AutoLine[] {
  const win = deps.filter(d => inTimeWindow(d, now)).sort(byExpected);
  const liveKeys = new Set(win.filter(d => d.live).map(d => lineKey(d, arrivals, single)));
  const lines = new Map<string, AutoLine>();
  for (const d of win) {
    const key = lineKey(d, arrivals, single);
    if (d.live || liveKeys.has(key) || lines.has(key)) continue;
    lines.set(key, { routeId: d.routeId, dest: d.dest, line: d.line });
  }
  return [...lines.values()].slice(0, max);
}

// "estimando 461 · 2 de 5 líneas · 7 de 31 paradas" (the stops part once the line's pattern is
// known).
export function autoStatusText(p: AutoProgress): string {
  const stops = p.total > 0 ? ` · ${p.checked} de ${p.total} paradas` : '';
  return `estimando ${p.line} · ${p.i} de ${p.n} líneas${stops}`;
}

type Tally = { upto: number; total: number; flying: number };
// Folds a scan's progress patches into stops checked (`upto` minus those in flight) of `total`.
export const nextTally = (t: Tally, patch: Partial<ScanState>): Tally => ({
  upto: patch.upto ?? t.upto,
  total: patch.total ?? t.total,
  flying: patch.inFlight ? patch.inFlight.length : t.flying,
});

console.assert(
  (() => {
    const at = (m: number) => new Date(Date.UTC(2026, 10, 27, 20, m));
    const mk = (m: number, routeId: string, dest: string, live = false) =>
      ({ routeId, dest, line: routeId, live, expected: at(m), planned: at(m) }) as Departure;
    const now = at(0).getTime();
    const deps = [
      mk(50, 'C', 'X'),
      mk(5, 'A', 'X'),
      mk(9, 'A', 'X', true),
      mk(12, 'B', 'X'),
      mk(15, 'B', 'Y'),
      mk(20, 'B', 'X'),
      mk(70, 'D', 'X'),
      mk(25, 'E', 'X'),
    ];
    const lines = autoLines(deps, now, false, () => false);
    const arr = autoLines(deps, now, true, () => false);
    const one = autoLines(deps, now, false, id => id === 'B');
    const t = nextTally({ upto: 0, total: 0, flying: 0 }, { total: 9 });
    const t2 = nextTally(t, { upto: 6, inFlight: ['a', 'b', 'c'] });
    return (
      lines.map(l => `${l.routeId}${l.dest}`).join() === 'BX,BY,EX,CX' &&
      arr.map(l => l.routeId).join() === 'B,E,C' &&
      one.map(l => l.routeId).join() === 'B,E,C' &&
      autoLines(deps, now, false, () => false, 2).length === 2 &&
      t2.upto - t2.flying === 3 &&
      t2.total === 9 &&
      nextTally(t2, { inFlight: [] }).flying === 0 &&
      autoStatusText({ line: '461', i: 2, n: 5, checked: 7, total: 31 }) ===
        'estimando 461 · 2 de 5 líneas · 7 de 31 paradas' &&
      autoStatusText({ line: '461', i: 1, n: 1, checked: 0, total: 0 }) ===
        'estimando 461 · 1 de 1 líneas'
    );
  })(),
  'autoLines, nextTally, autoStatusText',
);

const targetKey = (t: ScanTarget) => `${t.arr ? 'a' : 'd'}|${t.routeId}|${t.head}`;

const optionOf = (opts: LineOption[], l: AutoLine, arrivals: boolean) =>
  arrivals
    ? (opts.find(x => x.routeId === l.routeId) ?? null)
    : optionFor(opts, l.routeId, l.dest);

// The scan target of each line: departures by route + headsign, arrivals the route's own
// arrival option; lines that map to the same option are scanned once.
async function resolveTargets(
  file: BusFile,
  stopId: string,
  lines: AutoLine[],
  arrivals: boolean,
): Promise<AutoTarget[]> {
  const opts = arrivals ? await loadArrivalOptions(file, stopId) : lineOptions(file);
  const out = new Map<string, AutoTarget>();
  for (const l of lines) {
    const o = optionOf(opts, l, arrivals);
    if (!o) continue;
    const t: ScanTarget = { stopId, ...o };
    const key = targetKey(t);
    if (!out.has(key)) out.set(key, { key, line: l.line, t });
  }
  return [...out.values()];
}

type Loop = {
  stopId: string;
  file: BusFile;
  arrivals: boolean;
  depsRef: RefObject<Departure[]>;
  setRows: Dispatch<SetStateAction<AutoRows>>;
  setProgress: (p: AutoProgress | null) => void;
};

// Applies `f` to this stop's rows (a state from another stop starts empty).
const updateRows = (stopId: string, f: (b: ByKey) => ByKey) => (s: AutoRows) => ({
  stopId,
  byKey: f(s.stopId === stopId ? s.byKey : {}),
});

// A round starts by forgetting this board's rows of lines that are no longer targets (a live bus
// now covers them, or their runs are gone).
function pruneRows(c: Loop, targets: AutoTarget[]) {
  const prefix = c.arrivals ? 'a|' : 'd|';
  const keep = new Set(targets.map(t => t.key));
  c.setRows(
    updateRows(c.stopId, b =>
      Object.fromEntries(
        Object.entries(b).filter(([k]) => !k.startsWith(prefix) || keep.has(k)),
      ),
    ),
  );
}

// One line: scans it and replaces its rows with the result (none when the bus is not found).
// False when cancelled meanwhile.
async function scanTarget(
  c: Loop,
  tg: AutoTarget,
  at: { i: number; n: number },
  alive: () => boolean,
): Promise<boolean> {
  const show = (checked: number, total: number) =>
    alive() && c.setProgress({ line: tg.line, i: at.i, n: at.n, checked, total });
  let tally: Tally = { upto: 0, total: 0, flying: 0 };
  show(0, 0);
  const emit = (patch: Partial<ScanState>) => {
    tally = nextTally(tally, patch);
    show(tally.upto - tally.flying, tally.total);
  };
  const done = await runScan(tg.t, c.stopId, true, alive, emit);
  if (!alive()) return false;
  const rows = done.rows ?? [];
  c.setRows(updateRows(c.stopId, b => ({ ...b, [tg.key]: rows })));
  return true;
}

async function round(c: Loop, alive: () => boolean) {
  const single: Single = id => !c.arrivals && stopDirections(c.file, id).length === 1;
  const lines = autoLines(c.depsRef.current, Date.now(), c.arrivals, single);
  const targets = await resolveTargets(c.file, c.stopId, lines, c.arrivals);
  if (!alive()) return;
  pruneRows(c, targets);
  for (const [i, tg] of targets.entries()) {
    if (!(await scanTarget(c, tg, { i: i + 1, n: targets.length }, alive))) return;
  }
}

const sleep = (ms: number) => new Promise<void>(resolve => window.setTimeout(resolve, ms));

// Rounds until cancelled: each starts ROUND_GAP_MS after the previous one ended.
async function rounds(c: Loop, alive: () => boolean) {
  while (alive()) {
    // The deps ref is refreshed by an effect of the render that started this: let it run first.
    await Promise.resolve();
    await round(c, alive);
    if (!alive()) return;
    c.setProgress(null);
    await sleep(ROUND_GAP_MS);
  }
}

const onVisibility = (cb: () => void) => {
  document.addEventListener('visibilitychange', cb);
  return () => document.removeEventListener('visibilitychange', cb);
};
const pageVisible = () => document.visibilityState === 'visible';
const usePageVisible = () => useSyncExternalStore(onVisibility, pageVisible, () => true);

const NO_ROWS: AutoRows = { stopId: '', byKey: {} };

// Automatic estimates for the "por hora" board of a bus / light-rail stop. `file` null = not a
// bus stop (nothing runs). `depsRef` holds the board's latest departures (read at the start of
// each round: the targets depend on rows these estimates feed). It runs only while `active`
// (departures pane in view, por hora) and the page is visible and `ready` (the stop's CRTM times
// are in, so a line without a live row really has none). Leaving any of those cancels the pass
// in flight (late answers are dropped: each effect run has its own `alive` flag) and keeps the rows found; coming back
// starts a new round. A stop change forgets everything. `rows` holds both board kinds (`arr`).
export function useAutoEstimate(p: {
  stopId: string;
  file: BusFile | null;
  depsRef: RefObject<Departure[]>;
  arrivals: boolean;
  active: boolean;
  ready: boolean;
}) {
  const { stopId, file, depsRef, arrivals } = p;
  const [got, setGot] = useState<AutoRows>(NO_ROWS);
  const [progress, setProgress] = useState<AutoProgress | null>(null);
  const visible = usePageVisible();
  const on = p.active && p.ready && visible && file !== null;

  useEffect(() => {
    setGot(NO_ROWS);
    setProgress(null);
  }, [stopId]);

  useEffect(() => {
    if (!on || !file) return;
    let live = true;
    const alive = () => live;
    void rounds({ stopId, file, arrivals, depsRef, setRows: setGot, setProgress }, alive);
    return () => {
      live = false;
      setProgress(null);
    };
  }, [on, file, stopId, arrivals, depsRef]);

  const rows = useMemo(
    () => (got.stopId === stopId ? Object.values(got.byKey).flat() : []),
    [got, stopId],
  );
  return { rows, status: progress ? autoStatusText(progress) : '' };
}
