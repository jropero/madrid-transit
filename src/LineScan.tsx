import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { loadEstimates, MANUAL_KEY, saveEstimates } from './estimateStore.ts';
import {
  directCrtm,
  fetchCrtm,
  loadRoute,
  loadStopDeps,
  loadStopNames,
  loadStopTowns,
} from './data.ts';
import {
  arrivalMatches,
  arrivalOptions,
  hhmm,
  isBus,
  freshRows,
  keepEstimate,
  mergeBuses,
  pruneKept,
  lineOptions,
  liveMatches,
  mergeProjected,
  parseCrtm,
  projectRows,
  addBuses,
  MAX_BUSES,
  scanOrder,
  scanWithin,
  short,
  stopDirections,
  tileSize,
  type BusFile,
  type CrtmRow,
  type FoundBus,
  type ScanStop,
  type KeptRows,
  type LineOption,
  type Pattern,
  type RouteInfo,
  type RouteMap,
  type Saved,
  type StopFile,
} from './gtfs.ts';

// The line scan (pivot "escáner"): walk back along a line from the selected stop to the nearest
// earlier stop with a live bus and project its time onto the selected stop. Started only from
// the tab (at a terminus also for arrivals: trips that end at the stop); at most BATCH CRTM requests in flight; after a hit it repeats every FOLLOW_MS (2 min).
const BATCH = 3;
const HORIZON_S = 60 * 60; // a bus further than this (timetable travel) cannot land in the 60 min window
const FOLLOW_MS = 120_000; // after a hit: the estimate stands, the next check in 2 min

export type ScanTarget = {
  stopId: string;
  routeId: string;
  head: string;
  pi: number;
  arr?: true; // an arrivals scan: trips that END at stopId
};
export type StopScan =
  | { k: 'idle' | 'checking' | 'none' | 'error' }
  | { k: 'live'; when: Date };
export type ScanState = {
  target: ScanTarget | null;
  scans: Record<string, StopScan>;
  hit: string | null; // stop id of the nearest earlier stop with a live bus
  rows: CrtmRow[]; // the hit's rows projected onto the selected stop
  running: boolean;
  finishedAt: number | null;
  failed: boolean; // the line's stop pattern could not be loaded
  total: number; // stops to check (every earlier stop of the pattern)
  upto: number; // stops checked or in flight in the current pass
  inFlight: string[]; // stops whose CRTM answer the current batch is waiting for
  batchAt: number | null; // when the current batch started
  away: number; // the hit is this many stops before the selected one
  nextAt: number | null; // when the next follow-up pass is due (after a hit)
  paused: boolean; // stopped by a tab switch: no pass running, no follow-up due
};

const EMPTY: ScanState = {
  target: null,
  scans: {},
  hit: null,
  rows: [],
  running: false,
  finishedAt: null,
  failed: false,
  total: 0,
  upto: 0,
  inFlight: [],
  batchAt: null,
  away: 0,
  nextAt: null,
  paused: false,
};

// The key of a scan target (also the auto-estimate's): board kind + route + headsign.
export const targetKey = (t: ScanTarget) => `${t.arr ? 'a' : 'd'}|${t.routeId}|${t.head}`;

type Probe = { id: string; scan: StopScan; rows: CrtmRow[] };

const singleHead = (file: StopFile, routeId: string) =>
  isBus(file) && stopDirections(file, routeId).length === 1;

// The live rows of the target at an upstream stop: departures of the line + direction, or
// (arrivals scan) the line's rows whose trip ends at the selected stop.
const hitsOf = (rows: CrtmRow[], t: ScanTarget, file: StopFile) =>
  t.arr
    ? arrivalMatches(rows, t.routeId, t.stopId)
    : liveMatches(rows, t.routeId, t.head, singleHead(file, t.routeId));

// One upstream stop: its live rows of the target line + direction, or why there are none.
async function probeStop(id: string, t: ScanTarget): Promise<Probe> {
  try {
    const [feed, file] = await Promise.all([fetchCrtm(id), loadStopDeps(id)]);
    if (feed.offlineSince) throw new Error('offline copy');
    const parsed = parseCrtm(feed.data, new Date());
    const rows = await directCrtm(parsed, file, id);
    const hits = hitsOf(rows, t, file);
    const scan: StopScan = hits.length ? { k: 'live', when: hits[0].when } : { k: 'none' };
    return { id, scan, rows: hits };
  } catch {
    return { id, scan: { k: 'error' }, rows: [] };
  }
}

const checking = (ids: string[]): Record<string, StopScan> =>
  Object.fromEntries(ids.map(id => [id, { k: 'checking' } as StopScan]));

type Emit = (patch: Partial<ScanState>) => void;

// One batch: checks the stops in parallel (never more than BATCH requests in flight).
async function runBatch(
  ids: string[],
  t: ScanTarget,
  scans: Record<string, StopScan>,
  again: boolean,
  emit: Emit,
): Promise<Probe[]> {
  emit({ scans: { ...scans, ...(again ? {} : checking(ids)) } });
  const probes = await Promise.all(ids.map(id => probeStop(id, t)));
  for (const p of probes) scans[p.id] = p.scan;
  return probes;
}

// The buses found so far as the scan's result: all their rows, one `found` stamp per pass, and
// the nearest bus's stop (`hit`) with how many stops before the selected one it is.
function busesResult(buses: FoundBus[], order: ScanStop[], stamp: number): Partial<ScanState> {
  const rows = buses.flatMap(b => b.rows).map(r => ({ ...r, found: stamp }));
  const hit = buses[0]?.stopId ?? null;
  return { hit, rows, away: order.findIndex(o => o.id === hit) + 1 };
}

// One pass, nearest first in batches of BATCH: it keeps walking after a hit to find up to
// MAX_BUSES buses (by CRTM trip id), and stops at the first stop, or when the next stop is
// over an hour of timetable travel away. The first bus is emitted at once (not on follow-ups,
// which keep the old rows until the end). `alive` turns false once cancelled: late answers are
// dropped.
export async function runScan(
  t: ScanTarget,
  here: string,
  again: boolean,
  alive: () => boolean,
  emit: Emit,
): Promise<Partial<ScanState>> {
  const pattern: Pattern | undefined = await loadRoute(t.routeId).then(
    r => r.p[t.pi],
    () => undefined,
  );
  if (!pattern) return { failed: true, hit: null, rows: [] };
  const order = scanWithin(pattern, here, scanOrder(pattern, here), HORIZON_S);
  emit({ total: order.length, failed: false });
  const stamp = Date.now();
  const pass = { pattern, here, t, again, order, alive, emit, stamp };
  const scans: Record<string, StopScan> = {};
  let buses: FoundBus[] = [];
  for (let i = 0; i < order.length && buses.length < MAX_BUSES; i += BATCH) {
    const next = await scanBatch(pass, scans, i, buses);
    if (!next) return {};
    buses = next;
  }
  return { scans, total: order.length, ...busesResult(buses, order, stamp) };
}

type PassCtx = {
  pattern: Pattern;
  here: string;
  t: ScanTarget;
  again: boolean;
  order: ScanStop[];
  alive: () => boolean;
  emit: Emit;
  stamp: number; // one `found` value for the whole pass
};

// One batch of a pass: the stops i.., checked in parallel, their buses added nearest first.
// Null when cancelled meanwhile.
async function scanBatch(
  c: PassCtx,
  scans: Record<string, StopScan>,
  i: number,
  found: FoundBus[],
): Promise<FoundBus[] | null> {
  const ids = c.order.slice(i, i + BATCH).map(s => s.id);
  c.emit({ upto: i + ids.length, inFlight: ids, batchAt: Date.now() });
  const probes = await runBatch(ids, c.t, scans, c.again, c.emit);
  if (!c.alive()) return null;
  c.emit({ scans: { ...scans }, inFlight: [] });
  let buses = found;
  for (const p of probes) {
    const project = (rows: CrtmRow[]) => projectRows(rows, c.pattern, p.id, c.here, c.t);
    buses = addBuses(buses, p.id, p.rows, project);
  }
  // The first bus is shown at once (follow-ups keep their old rows until the pass ends).
  if (!c.again && !found.length && buses.length) c.emit(busesResult(buses, c.order, c.stamp));
  return buses;
}

// Scan state of the selected stop. Reset when the stop changes; `start` begins a scan,
// `stop` cancels it (late answers are ignored through the generation counter) and forgets
// the target and the estimate.
export function useLineScan(stopId: string) {
  const [state, setState] = useState<ScanState>(EMPTY);
  const gen = useRef(0);
  const busy = useRef(false);
  const latest = useRef(state);
  useEffect(() => {
    latest.current = state;
  }, [state]);
  // Estimates of earlier targets, per stop: kept until a newer scan of the line finds a bus, a
  // live row pairs with them (the board), their time is past or "detener".
  const [kept, setKept] = useState<Record<string, KeptRows>>(() => loadEstimates(MANUAL_KEY));
  // Saved with the current scan stashed too, so a reload keeps its estimates.
  const { target: curTarget, rows: curRows } = state;
  useEffect(() => {
    const now = { ...EMPTY, target: curTarget, rows: curRows };
    saveEstimates(MANUAL_KEY, stashScan(kept, now));
  }, [kept, curTarget, curRows]);
  const keptRef = useRef(kept);
  useEffect(() => {
    keptRef.current = kept;
  }, [kept]);

  // The target being replaced (new scan, stop change) leaves its rows under its own stop.
  useEffect(() => {
    const prev = latest.current;
    setKept(k => stashScan(k, prev));
    gen.current++;
    busy.current = false;
    setState(EMPTY);
  }, [stopId]);

  // Drops past rows from memory once the earliest one is over.
  useEffect(() => {
    const whens = Object.values(kept).flatMap(m =>
      Object.values(m).flatMap(rows => rows.map(r => r.when.getTime())),
    );
    if (!whens.length) return;
    const wait = Math.max(0, Math.min(...whens) + 60_000 - Date.now()) + 50;
    const id = window.setTimeout(() => setKept(k => pruneAll(k, Date.now())), wait);
    return () => window.clearTimeout(id);
  }, [kept]);

  const pass = useCallback(
    async (t: ScanTarget, again: boolean) => {
      const g = gen.current;
      const alive = () => gen.current === g;
      busy.current = true;
      const emit: Emit = patch => alive() && setState(s => ({ ...s, ...patch }));
      const done = await runScan(t, stopId, again, alive, emit);
      if (!alive()) return;
      busy.current = false;
      const at = Date.now();
      const nextAt = done.hit ? at + FOLLOW_MS : null;
      const own = keptRef.current[t.stopId]?.[targetKey(t)] ?? [];
      setState(s => settle(s, done, at, nextAt, own));
      if (done.rows?.length) setKept(k => dropKept(k, t.stopId, targetKey(t)));
    },
    [stopId],
  );

  const start = useCallback(
    (t: ScanTarget) => {
      gen.current++;
      const prev = latest.current;
      setKept(k => stashScan(k, prev));
      setState({ ...EMPTY, target: t, running: true });
      void pass(t, false);
    },
    [pass],
  );

  const stop = useCallback(() => {
    gen.current++;
    busy.current = false;
    const t = latest.current.target;
    if (t) setKept(k => dropKept(k, t.stopId, targetKey(t)));
    setState(EMPTY);
  }, []);

  // A follow-up pass now (the "comprobar ahora" button and the follow timer).
  const target = state.target;
  const refresh = useCallback(() => {
    if (!target || busy.current) return;
    setState(s => ({ ...s, running: true, nextAt: null, paused: false }));
    void pass(target, true);
  }, [target, pass]);

  // Leaving the tab (App calls this on every pivot change): a search still looking for a bus
  // stops; after a hit the estimate stays as it is and no more follow-up passes run.
  const pause = useCallback(() => {
    gen.current++;
    busy.current = false;
    setState(pausedState);
  }, []);

  // After a hit, the next pass is due FOLLOW_MS after the last one ended; while the page is
  // hidden it waits and runs as soon as the page is visible again.
  const nextAt = state.nextAt;
  useEffect(() => {
    if (nextAt === null) return;
    const due = () => document.visibilityState === 'visible' && refresh();
    const id = window.setTimeout(due, Math.max(0, nextAt - Date.now()));
    const onVisible = () => Date.now() >= nextAt && due();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearTimeout(id);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [nextAt, refresh]);

  // The current scan's rows first, then the kept ones of this stop's other lines.
  const rows = useMemo(() => boardRows(state, kept[stopId] ?? NO_KEPT), [state, kept, stopId]);

  return { state, rows, start, stop, refresh, pause };
}

const NO_KEPT: KeptRows = {};

// The ScanState after a pass: a pass that found no bus keeps the rows already estimated.
// A pass that found buses adds them to the rows kept (`own`: this target's stashed ones) and to
// those already shown; a bus it missed keeps its estimate.
function settle(
  s: ScanState,
  done: Partial<ScanState>,
  at: number,
  nextAt: number | null,
  own: CrtmRow[],
) {
  const rows = done.rows?.length ? mergeBuses(mergeBuses(own, s.rows), done.rows) : s.rows;
  return { ...s, ...done, rows, running: false, finishedAt: at, inFlight: [], nextAt };
}

const keptKey = (s: ScanState) => (s.target ? targetKey(s.target) : null);

// The scan's rows go under their key at the scan's own stop (none: nothing changes).
function stashScan(all: Record<string, KeptRows>, s: ScanState): Record<string, KeptRows> {
  if (!s.target) return all;
  const stop = s.target.stopId;
  return { ...all, [stop]: keepEstimate(all[stop] ?? {}, keptKey(s), s.rows, Date.now()) };
}

function dropKept(all: Record<string, KeptRows>, stop: string, key: string) {
  const { [key]: _gone, ...rest } = all[stop] ?? {};
  return { ...all, [stop]: rest };
}

const pruneAll = (all: Record<string, KeptRows>, now: number) =>
  Object.fromEntries(
    Object.entries(all)
      .map(([stop, m]) => [stop, pruneKept(m, now)] as const)
      .filter(([, m]) => Object.keys(m).length > 0),
  );

// The current scan's rows merged with its target's kept ones (a bus the scan does not show keeps
// its estimate), then the stop's other kept ones, without the ones whose time is past.
function boardRows(s: ScanState, mine: KeptRows): CrtmRow[] {
  const key = keptKey(s);
  const own = key ? (mine[key] ?? []) : [];
  const others = Object.entries(mine)
    .filter(([k]) => k !== key)
    .flatMap(([, rows]) => rows);
  return freshRows(mergeProjected(mergeBuses(own, s.rows), others), Date.now());
}

export type LineScanApi = ReturnType<typeof useLineScan>;

// The state after a tab switch: unchanged when nothing runs or is due (no target, or a pass
// without a bus already ended), else stopped where it was.
function pausedState(s: ScanState): ScanState {
  if (!s.target || (!s.running && s.nextAt === null)) return s;
  const finishedAt = s.finishedAt ?? Date.now();
  // A batch cut short is not checked: its stops go back to unchecked.
  const scans = Object.fromEntries(
    Object.entries(s.scans).filter(([id]) => !s.inFlight.includes(id)),
  );
  const upto = s.upto - s.inFlight.length;
  return {
    ...s,
    running: false,
    inFlight: [],
    batchAt: null,
    nextAt: null,
    paused: true,
    finishedAt,
    scans,
    upto,
  };
}
console.assert(
  (() => {
    const t = { stopId: 'a', routeId: 'r', head: 'h', pi: 0 };
    const running = pausedState({
      ...EMPTY,
      target: t,
      running: true,
      upto: 3,
      inFlight: ['x'],
      scans: { x: { k: 'checking' }, y: { k: 'none' } },
    });
    const following = pausedState({ ...EMPTY, target: t, hit: 'b', finishedAt: 5, nextAt: 9 });
    const done = { ...EMPTY, target: t, finishedAt: 5 };
    return (
      running.paused &&
      !running.running &&
      !running.inFlight.length &&
      running.upto === 2 &&
      !('x' in running.scans) &&
      'y' in running.scans &&
      following.paused &&
      following.nextAt === null &&
      following.hit === 'b' &&
      pausedState(done) === done &&
      pausedState(EMPTY) === EMPTY
    );
  })(),
  'pausedState',
);

// What the scan is doing, as up to three lines: `phase` (announced), `detail` and `next`
// (countdowns: not announced). `bar` is the share of stops checked during a pass, else null.
export type ScanInfo = { phase: string; detail: string; next: string; bar: number | null };
const SLOW_MS = 3000;

const secs = (ms: number) => `${Math.max(0, Math.round(ms / 1000))} s`;
const stopsText = (n: number) => `${n} ${n === 1 ? 'parada' : 'paradas'}`;

// The stops of the batch in flight, plus how long CRTM has kept us waiting once it is slow.
function waitingText(s: ScanState, now: number, nameOf: (id: string) => string): string {
  if (!s.inFlight.length) return '';
  const names = `comprobando ${s.inFlight.map(nameOf).join(', ')}`;
  const waited = s.batchAt === null ? 0 : now - s.batchAt;
  return waited > SLOW_MS ? `${names} · esperando al CRTM ${secs(waited)}` : names;
}

const barOf = (s: ScanState) =>
  s.running && s.total > 0 ? (s.upto - s.inFlight.length) / s.total : null;

function hitInfo(s: ScanState, now: number, hidden: boolean, nameOf: (id: string) => string) {
  const phase =
    `bus en vivo en ${nameOf(s.hit ?? '')} (${stopsText(s.away)} antes): ` +
    `llega aquí hacia las ${hhmm(s.rows[0].when)} (estimado)`;
  if (s.running)
    return { phase, detail: `actualizando… ${s.upto} de ${s.total} paradas`, next: '' };
  const ago = s.finishedAt === null ? '' : `comprobado hace ${secs(now - s.finishedAt)}`;
  return { phase, detail: ago, next: followText(s, now, hidden) };
}

function followText(s: ScanState, now: number, hidden: boolean): string {
  if (s.paused) return 'seguimiento detenido al cambiar de pestaña · pulsa comprobar ahora';
  if (hidden) return 'en pausa mientras la app está en segundo plano';
  return `siguiente comprobación en ${secs((s.nextAt ?? now) - now)}`;
}

const STOPPED = 'búsqueda detenida al cambiar de pestaña';

function idleInfo(s: ScanState): string {
  if (s.paused) return STOPPED;
  if (s.finishedAt === null) return 'comprobando…';
  if (s.total === 0) return 'esta es la primera parada de la línea: no hay paradas anteriores';
  return `sin buses en vivo en las ${stopsText(s.total)} anteriores`;
}

export function scanInfo(
  s: ScanState,
  now: number,
  hidden: boolean,
  nameOf: (id: string) => string,
): ScanInfo {
  const bar = barOf(s);
  if (!s.target)
    return { phase: 'elige una línea y pulsa escanear', detail: '', next: '', bar };
  if (s.failed)
    return { phase: 'no se pudo cargar el recorrido de la línea', detail: '', next: '', bar };
  if (s.hit && s.rows.length) {
    const info = hitInfo(s, now, hidden, nameOf);
    return { ...info, detail: waitingText(s, now, nameOf) || info.detail, bar };
  }
  if (s.running) {
    const phase = `buscando un bus en vivo · ${s.upto - s.inFlight.length} de ${s.total} paradas`;
    return { phase, detail: waitingText(s, now, nameOf), next: '', bar };
  }
  return { phase: idleInfo(s), detail: idleDetail(s), next: '', bar };
}
function idleDetail(s: ScanState): string {
  if (s.paused) return `${s.upto - s.inFlight.length} de ${s.total} paradas comprobadas`;
  return s.finishedAt === null ? '' : `comprobado a las ${hhmm(new Date(s.finishedAt))}`;
}

// The one-line progress under salidas' "estima tiempo" (no stop names: it stays short).
export function estimateText(s: ScanState, now: number): string {
  if (!s.target) return '';
  if (s.failed) return 'no se pudo cargar el recorrido de la línea';
  if (s.hit && s.rows.length)
    return `bus en vivo ${stopsText(s.away)} antes: llega hacia las ${hhmm(s.rows[0].when)}`;
  return s.running ? searchingText(s, now) : idleInfo(s);
}

function searchingText(s: ScanState, now: number): string {
  const base = `buscando un bus en vivo · ${s.upto - s.inFlight.length} de ${s.total} paradas`;
  const waited = s.inFlight.length && s.batchAt !== null ? now - s.batchAt : 0;
  return waited > SLOW_MS ? `${base} · esperando al CRTM ${secs(waited)}` : base;
}
console.assert(
  (() => {
    const t = { stopId: 'a', routeId: 'r', head: 'h', pi: 0 };
    const run = {
      ...EMPTY,
      target: t,
      running: true,
      total: 9,
      upto: 6,
      inFlight: ['x', 'y', 'z'],
    };
    const row = { when: new Date('2026-11-26T14:34:00Z') } as CrtmRow;
    return (
      estimateText(EMPTY, 0) === '' &&
      estimateText({ ...run, batchAt: 0 }, 1000) ===
        'buscando un bus en vivo · 3 de 9 paradas' &&
      estimateText({ ...run, batchAt: 0 }, 8000).endsWith(' · esperando al CRTM 8 s') &&
      estimateText(
        { ...EMPTY, target: t, hit: 'b', rows: [row], away: 4, finishedAt: 1 },
        0,
      ) === 'bus en vivo 4 paradas antes: llega hacia las 15:34' &&
      estimateText({ ...EMPTY, target: t, total: 9, finishedAt: 1 }, 0) ===
        'sin buses en vivo en las 9 paradas anteriores'
    );
  })(),
  'estimateText',
);

console.assert(
  (() => {
    const base = { ...EMPTY, target: { stopId: 'a', routeId: 'r', head: 'h', pi: 0 } };
    const row = { when: new Date('2026-11-26T14:34:00Z') } as CrtmRow;
    const nameOf = (id: string) => id.toUpperCase();
    const run = { ...base, running: true, total: 7, upto: 6, inFlight: ['x', 'y', 'z'] };
    const slow = scanInfo({ ...run, batchAt: 0 }, 12_000, false, nameOf);
    const hit = { ...base, hit: 'b', rows: [row], away: 6, finishedAt: 0, nextAt: 30_000 };
    const followed = scanInfo(hit, 12_000, false, nameOf);
    return (
      scanInfo(EMPTY, 0, false, nameOf).phase === 'elige una línea y pulsa escanear' &&
      slow.phase === 'buscando un bus en vivo · 3 de 7 paradas' &&
      slow.detail === 'comprobando X, Y, Z · esperando al CRTM 12 s' &&
      slow.bar === 3 / 7 &&
      scanInfo({ ...run, batchAt: 0 }, 1000, false, nameOf).detail === 'comprobando X, Y, Z' &&
      followed.phase ===
        'bus en vivo en B (6 paradas antes): llega aquí hacia las 15:34 (estimado)' &&
      followed.detail === 'comprobado hace 12 s' &&
      followed.next === 'siguiente comprobación en 18 s' &&
      followed.bar === null &&
      scanInfo(hit, 12_000, true, nameOf).next.startsWith('en pausa') &&
      scanInfo({ ...hit, away: 1 }, 0, false, nameOf).phase.includes('(1 parada antes)') &&
      scanInfo({ ...base, total: 7, finishedAt: 1 }, 0, false, nameOf).phase ===
        'sin buses en vivo en las 7 paradas anteriores' &&
      scanInfo({ ...base, total: 0, finishedAt: 1 }, 0, false, nameOf).phase.startsWith(
        'esta es la primera',
      )
    );
  })(),
  'scanInfo',
);

const optionKey = (o: Pick<LineOption, 'routeId' | 'head' | 'arr'>) =>
  `${o.arr ? 'a' : 'd'}|${o.routeId}|${o.head}`;

// The arrivals options of a terminus: per route the longest pattern ending at the stop.
export async function loadArrivalOptions(file: BusFile, stopId: string): Promise<LineOption[]> {
  const [pats, towns, names] = await Promise.all([
    Promise.all(
      file.r.map(r =>
        loadRoute(r).then(
          x => [r, x.p] as const,
          () => [r, []] as const,
        ),
      ),
    ),
    loadStopTowns().catch(() => new Map<string, string>()),
    loadStopNames().catch(() => new Map<string, string>()),
  ]);
  const townOf = (id: string) => towns.get(id) || names.get(id) || id;
  return arrivalOptions(stopId, file.r, Object.fromEntries(pats), townOf);
}
const tileStyle = (r: RouteInfo) =>
  ({ '--tile': r.color, '--tile-text': r.text }) as React.CSSProperties;

export function LineTile({ route }: { route: RouteInfo | undefined }) {
  if (!route) return null;
  return (
    <span className={`tile mini${tileSize(route.line)}`} style={tileStyle(route)}>
      <b>{route.line}</b>
    </span>
  );
}

// The line / direction choice of the stop: one aria-pressed button per pair.
function LinePicker(p: {
  options: LineOption[];
  routes: RouteMap | null;
  picked: LineOption | undefined;
  locked: boolean;
  onPick: (o: LineOption) => void;
}) {
  return (
    <div className="board-mode line-picks" role="group" aria-label="Línea y sentido">
      {p.options.map(o => (
        <button
          key={optionKey(o)}
          className="btn tilt"
          aria-pressed={!!p.picked && optionKey(o) === optionKey(p.picked)}
          disabled={p.locked}
          onClick={() => p.onPick(o)}
        >
          <LineTile route={p.routes?.[o.routeId]} />
          <span>{short(o.head).toLowerCase()}</span>
        </button>
      ))}
    </div>
  );
}

type OwnLive = 'checking' | 'yes' | 'no' | 'error';
const OWN_TEXT: Record<OwnLive, string> = {
  checking: 'comprobando esta parada…',
  yes: 'esta parada tiene tiempos en vivo para esta línea',
  no: 'sin tiempos en vivo en esta parada',
  error: 'no se pudo comprobar esta parada',
};

// The selected stop's own live rows for the picked option (arrivals: the line's live rows).
async function ownHits(parsed: CrtmRow[], file: BusFile, stopId: string, o: LineOption) {
  if (o.arr) return parsed.filter(r => r.routeId === o.routeId && !r.scheduled);
  const rows = await directCrtm(parsed, file, stopId);
  return liveMatches(rows, o.routeId, o.head, singleHead(file, o.routeId));
}

// Does the selected stop itself have live times for the picked line? `fetchCrtm` is memoised
// (the salidas pane asks the same), so this costs no extra request.
function useOwnLive(
  stopId: string,
  file: BusFile | null,
  o: LineOption | undefined,
  at: number,
) {
  const [res, setRes] = useState<{ key: string; v: OwnLive } | null>(null);
  const key = `${stopId}|${o ? optionKey(o) : ''}`;
  useEffect(() => {
    if (!file || !o) return;
    let current = true;
    const set = (v: OwnLive) => current && setRes({ key, v });
    fetchCrtm(stopId, !!o.arr)
      .then(async feed => {
        const hits = await ownHits(parseCrtm(feed.data, new Date()), file, stopId, o);
        set(hits.length ? 'yes' : 'no');
      })
      .catch(() => set('error'));
    return () => {
      current = false;
    };
  }, [stopId, file, o, key, at]);
  if (!o) return null;
  return res?.key === key ? res.v : 'checking';
}

const chipText = (s: StopScan | undefined) => {
  if (!s || s.k === 'idle') return 'sin comprobar';
  if (s.k === 'live') return `en vivo ${hhmm(s.when)}`;
  return { checking: 'comprobando…', none: 'sin datos', error: 'error' }[s.k];
};

type Names = { names: Map<string, string>; towns: Map<string, string> };

function StopRow(p: {
  id: string;
  here: boolean;
  hit: boolean;
  scan: StopScan | undefined;
  est: Date | null;
  data: Names | null;
}) {
  const name = p.data?.names.get(p.id) ?? p.id;
  const town = p.data?.towns.get(p.id);
  const cls = [p.here && 'here', p.hit && 'hit'].filter(Boolean).join(' ');
  return (
    <li className={cls || undefined} aria-current={p.here || undefined}>
      <span className="stop-name">
        {name}
        {town && <span className="stop-town"> {town}</span>}
      </span>
      {p.here && <span className="scan-chip">esta parada</span>}
      {p.here && p.est && <span className="scan-chip est">estimado {hhmm(p.est)}</span>}
      {!p.here && (
        <span className={`scan-chip ${p.scan?.k ?? 'idle'}`}>{chipText(p.scan)}</span>
      )}
    </li>
  );
}

// How many of the earlier stops (nearest first) the list shows: every stop up to the farthest
// one checked or in flight. Batches go nearest first, so that is a prefix of `order`.
export function revealed(order: string[], scans: Record<string, unknown>, inFlight: string[]) {
  let n = 0;
  order.forEach((id, i) => {
    if (id in scans || inFlight.includes(id)) n = i + 1;
  });
  return n;
}
console.assert(
  revealed(['a', 'b', 'c', 'd'], {}, []) === 0 &&
    revealed(['a', 'b', 'c', 'd'], { a: 1 }, ['b', 'c']) === 3 &&
    revealed(['a', 'b', 'c', 'd'], { a: 1, b: 1, c: 1, d: 1 }, []) === 4,
  'revealed',
);

const earlier = (n: number) => `${n} ${n === 1 ? 'parada anterior' : 'paradas anteriores'}`;
const notCheckedText = (n: number, started: boolean) =>
  `${earlier(n)}${started ? ' sin comprobar' : ': se muestran al escanearlas'}`;

// This stop first, then the earlier stops in scan order (nearest first, going down), each
// appearing once its check starts; the stops after this one are not shown.
function PatternStops(p: { pattern: Pattern; stopId: string; state: ScanState; data: Names }) {
  const { state } = p;
  const order = scanOrder(p.pattern, p.stopId).map(s => s.id);
  const n = revealed(order, state.scans, state.inFlight);
  const rest = order.length - n;
  return (
    <ol
      className="line-stops"
      aria-label="Esta parada y las anteriores, la más cercana primero"
    >
      <StopRow
        id={p.stopId}
        here
        hit={false}
        scan={undefined}
        est={state.rows[0]?.when ?? null}
        data={p.data}
      />
      {order.slice(0, n).map(id => (
        <StopRow
          key={id}
          id={id}
          here={false}
          hit={id === state.hit}
          scan={state.inFlight.includes(id) ? { k: 'checking' } : state.scans[id]}
          est={null}
          data={p.data}
        />
      ))}
      {rest > 0 && <li className="more">{notCheckedText(rest, !!state.target)}</li>}
    </ol>
  );
}

// Pattern and stop names of the picked line.
function usePatternData(routeId: string | undefined, pi: number | undefined) {
  const [got, setGot] = useState<{ routeId: string; pi: number; pattern: Pattern } | null>(
    null,
  );
  const [data, setData] = useState<Names | null>(null);
  useEffect(() => {
    if (!routeId || pi === undefined) return;
    let current = true;
    Promise.all([loadRoute(routeId), loadStopNames(), loadStopTowns()]).then(
      ([route, names, towns]) => {
        if (!current) return;
        setData({ names, towns });
        setGot({ routeId, pi, pattern: route.p[pi] ?? [] });
      },
      () => current && setGot(null),
    );
    return () => {
      current = false;
    };
  }, [routeId, pi]);
  const same = !!got && got.routeId === routeId && got.pi === pi;
  const pattern = same ? got.pattern : null;
  return { pattern, data };
}

const SCOPE_NOTE = 'el escaneo de línea solo funciona en paradas de autobús y de metro ligero';

// Why this stop can't be scanned (empty when it can).
function scopeNote(id: string, file: StopFile | null, error: string): string {
  if (id.startsWith('emt_') || id.startsWith('par_4_')) return SCOPE_NOTE;
  if (error) return error;
  if (!file) return 'cargando…';
  return isBus(file) ? '' : SCOPE_NOTE;
}

function ScanControls(p: {
  state: ScanState;
  picked: LineOption | undefined;
  stopId: string;
  scan: LineScanApi;
}) {
  const { state, picked, scan } = p;
  if (state.target)
    return (
      <>
        <button className="btn tilt" onClick={scan.stop}>
          detener
        </button>
        <AgainButton state={state} scan={scan} />
      </>
    );
  return (
    <button
      className="btn tilt"
      disabled={!picked}
      onClick={() => picked && scan.start({ stopId: p.stopId, ...picked })}
    >
      escanear
    </button>
  );
}

// After a hit: check now instead of waiting; after a pass without a bus: scan again.
function AgainButton({ state, scan }: { state: ScanState; scan: LineScanApi }) {
  const t = state.target;
  if (!t || state.running || state.failed || state.finishedAt === null) return null;
  if (state.hit)
    return (
      <button className="btn tilt" onClick={scan.refresh}>
        comprobar ahora
      </button>
    );
  if (state.total === 0) return null;
  return (
    <button className="btn tilt" onClick={() => scan.start(t)}>
      volver a escanear
    </button>
  );
}

// A clock for the countdowns: ticks every second while `on`.
export function useTick(on: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [on]);
  return now;
}

function usePageHidden() {
  const [hidden, setHidden] = useState(() => document.visibilityState === 'hidden');
  useEffect(() => {
    const on = () => setHidden(document.visibilityState === 'hidden');
    document.addEventListener('visibilitychange', on);
    return () => document.removeEventListener('visibilitychange', on);
  }, []);
  return hidden;
}

// What the scan is doing: phase (announced), progress bar, the stops in flight or the last
// check, and the countdown to the next one.
function ScanPanel({ state, nameOf }: { state: ScanState; nameOf: (id: string) => string }) {
  const now = useTick(!!state.target);
  const hidden = usePageHidden();
  const info = scanInfo(state, now, hidden, nameOf);
  return (
    <div className="scan-panel">
      <p className="scan-phase" role="status" aria-live="polite">
        {info.phase}
      </p>
      {info.bar !== null && (
        <span
          className="scan-bar"
          role="progressbar"
          aria-label="paradas comprobadas"
          aria-valuemin={0}
          aria-valuemax={state.total}
          aria-valuenow={state.upto - state.inFlight.length}
        >
          <i style={{ width: `${Math.round(info.bar * 100)}%` }} />
        </span>
      )}
      {info.detail && <p className="status">{info.detail}</p>}
      {info.next && <p className="status">{info.next}</p>}
    </div>
  );
}

// The option list of the tab: departures (`lineOptions`) or, at a terminus switched to
// llegadas, the arrivals options (loaded per stop). A running scan fixes the mode.
function useScanOptions(stopId: string, file: BusFile | null, state: ScanState) {
  const [arr, setArr] = useState(false);
  const [loaded, setLoaded] = useState<{ stopId: string; list: LineOption[] } | null>(null);
  useEffect(() => setArr(false), [stopId]);
  const terminus = !!file?.t;
  useEffect(() => {
    if (!file || !terminus) return;
    let current = true;
    loadArrivalOptions(file, stopId).then(
      list => current && setLoaded({ stopId, list }),
      () => current && setLoaded({ stopId, list: [] }),
    );
    return () => {
      current = false;
    };
  }, [file, terminus, stopId]);
  const arrivals = terminus && (state.target ? !!state.target.arr : arr);
  const departures = useMemo(() => (file ? lineOptions(file) : []), [file]);
  const arrivalList = loaded?.stopId === stopId ? loaded.list : [];
  return {
    options: arrivals ? arrivalList : departures,
    terminus,
    arrivals,
    setArrivals: setArr,
  };
}

const SCAN_MODES = [
  { arrivals: false, label: 'salidas' },
  { arrivals: true, label: 'llegadas' },
];

// salidas / llegadas of the scan at a bus terminus (same look as the board's switch).
function ModeSwitch(p: {
  show: boolean;
  arrivals: boolean;
  locked: boolean;
  onMode: (arrivals: boolean) => void;
}) {
  if (!p.show) return null;
  return (
    <div className="board-mode" role="group" aria-label="Escanear salidas o llegadas">
      {SCAN_MODES.map(m => (
        <button
          key={m.label}
          className="btn tilt"
          aria-pressed={p.arrivals === m.arrivals}
          disabled={p.locked}
          onClick={() => p.onMode(m.arrivals)}
        >
          {m.label}
        </button>
      ))}
    </div>
  );
}

// Pivot "escáner": scans the selected stop's line from the tab (see the header comment).
export default function LineTab(p: {
  stop: Saved;
  file: StopFile | null;
  fileError: string;
  routes: RouteMap | null;
  scan: LineScanApi;
}) {
  const { stop, file, scan } = p;
  const { state } = scan;
  const note = scopeNote(stop.id, file, p.fileError);
  const busFile = note === '' && isBus(file) ? file : null;
  const { options, terminus, arrivals, setArrivals } = useScanOptions(stop.id, busFile, state);
  const [pickedKey, setPickedKey] = useState('');
  useEffect(() => setPickedKey(''), [stop.id]);
  const wanted = state.target ? optionKey(state.target) : pickedKey;
  const picked = options.find(o => optionKey(o) === wanted) ?? options[0];
  const own = useOwnLive(stop.id, busFile, picked, state.finishedAt ?? 0);
  const { pattern, data } = usePatternData(picked?.routeId, picked?.pi);
  const nameOf = (id: string) => data?.names.get(id) ?? id;
  return (
    <>
      <h2 className="title">{short(stop.name)}</h2>
      <h3 className="section-sub">línea</h3>
      {note && <p className="status">{note}</p>}
      {busFile && (
        <>
          <ModeSwitch
            show={terminus}
            arrivals={arrivals}
            locked={!!state.target}
            onMode={a => {
              setArrivals(a);
              setPickedKey('');
            }}
          />
          <LinePicker
            options={options}
            routes={p.routes}
            picked={picked}
            locked={!!state.target}
            onPick={o => setPickedKey(optionKey(o))}
          />
          <div className="board-mode">
            <ScanControls state={state} picked={picked} stopId={stop.id} scan={scan} />
          </div>
          <ScanPanel state={state} nameOf={nameOf} />
          {own && <p className="status">{OWN_TEXT[own]}</p>}
          {pattern && data && (
            <PatternStops pattern={pattern} stopId={stop.id} state={state} data={data} />
          )}
        </>
      )}
    </>
  );
}
