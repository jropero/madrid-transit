import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  directCrtm,
  fetchCrtm,
  loadRoute,
  loadStopDeps,
  loadStopNames,
  loadStopTowns,
} from './data.ts';
import {
  SCAN_MAX,
  hhmm,
  isBus,
  lineOptions,
  liveMatches,
  parseCrtm,
  projectRows,
  scanOrder,
  short,
  stopDirections,
  tileSize,
  type BusFile,
  type CrtmRow,
  type LineOption,
  type Pattern,
  type RouteInfo,
  type RouteMap,
  type Saved,
  type StopFile,
} from './gtfs.ts';

// The line scan (pivot "línea"): walk back along a line from the selected stop to the nearest
// earlier stop with a live bus and project its time onto the selected stop. Started only from
// the tab; at most BATCH CRTM requests in flight; after a hit it repeats every FOLLOW_MS.
const BATCH = 3;
const FOLLOW_MS = 30_000;

export type ScanTarget = { stopId: string; routeId: string; head: string; pi: number };
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
  total: number; // stops to check (at most SCAN_MAX)
  upto: number; // stops checked or in flight in the current pass
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
};

type Probe = { id: string; scan: StopScan; rows: CrtmRow[] };

const singleHead = (file: StopFile, routeId: string) =>
  isBus(file) && stopDirections(file, routeId).length === 1;

// One upstream stop: its live rows of the target line + direction, or why there are none.
async function probeStop(id: string, t: ScanTarget): Promise<Probe> {
  try {
    const [feed, file] = await Promise.all([fetchCrtm(id), loadStopDeps(id)]);
    if (feed.offlineSince) throw new Error('offline copy');
    const parsed = parseCrtm(feed.data, new Date());
    const rows = await directCrtm(parsed, file, id);
    const hits = liveMatches(rows, t.routeId, t.head, singleHead(file, t.routeId));
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

// One pass, nearest first in batches; the first batch with a live bus ends it, and the nearest
// stop of that batch wins. `alive` turns false once cancelled: late answers are dropped.
async function runScan(
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
  const order = scanOrder(pattern, here);
  emit({ total: order.length, failed: false });
  const scans: Record<string, StopScan> = {};
  for (let i = 0; i < order.length; i += BATCH) {
    const ids = order.slice(i, i + BATCH).map(s => s.id);
    emit({ upto: i + ids.length });
    const probes = await runBatch(ids, t, scans, again, emit);
    if (!alive()) return {};
    emit({ scans: { ...scans } });
    const hit = probes.find(p => p.rows.length > 0);
    if (hit) {
      const rows = projectRows(hit.rows, pattern, hit.id, here, t);
      return { scans, hit: hit.id, rows, total: order.length };
    }
  }
  return { scans, hit: null, rows: [], total: order.length };
}

// Scan state of the selected stop. Reset when the stop changes; `start` begins a scan,
// `stop` cancels it (late answers are ignored through the generation counter) and forgets
// the target and the estimate.
export function useLineScan(stopId: string) {
  const [state, setState] = useState<ScanState>(EMPTY);
  const gen = useRef(0);
  const busy = useRef(false);

  useEffect(() => {
    gen.current++;
    busy.current = false;
    setState(EMPTY);
  }, [stopId]);

  const pass = useCallback(
    async (t: ScanTarget, again: boolean) => {
      const g = gen.current;
      const alive = () => gen.current === g;
      busy.current = true;
      const emit: Emit = patch => alive() && setState(s => ({ ...s, ...patch }));
      const done = await runScan(t, stopId, again, alive, emit);
      if (!alive()) return;
      busy.current = false;
      setState(s => ({ ...s, ...done, running: false, finishedAt: Date.now() }));
    },
    [stopId],
  );

  const start = useCallback(
    (t: ScanTarget) => {
      gen.current++;
      setState({ ...EMPTY, target: t, running: true });
      void pass(t, false);
    },
    [pass],
  );

  const stop = useCallback(() => {
    gen.current++;
    busy.current = false;
    setState(EMPTY);
  }, []);

  // After a hit, repeat while the page is visible so the estimate follows the bus.
  const target = state.target;
  const following = state.hit !== null;
  useEffect(() => {
    if (!target || !following) return;
    const id = setInterval(() => {
      if (document.visibilityState !== 'visible' || busy.current) return;
      setState(s => ({ ...s, running: true }));
      void pass(target, true);
    }, FOLLOW_MS);
    return () => clearInterval(id);
  }, [target, following, pass]);

  return { state, start, stop };
}

export type LineScanApi = ReturnType<typeof useLineScan>;

// "bus en vivo en <parada>: llega aquí hacia las HH:MM (estimado)"; messages of the other states.
export function scanStatus(s: ScanState, nameOf: (id: string) => string): string {
  if (!s.target) return 'elige una línea y pulsa escanear';
  if (s.failed) return 'no se pudo cargar el recorrido de la línea';
  if (s.hit && s.rows.length) {
    return `bus en vivo en ${nameOf(s.hit)}: llega aquí hacia las ${hhmm(s.rows[0].when)} (estimado)`;
  }
  return s.running ? `comprobando ${s.upto} de ${s.total} paradas…` : noHitText(s);
}

const noHitText = (s: ScanState) => {
  if (s.finishedAt === null) return 'comprobando…';
  if (s.total === 0) return 'esta es la primera parada de la línea: no hay paradas anteriores';
  return `sin buses en vivo en las ${s.total} paradas anteriores`;
};
console.assert(
  (() => {
    const base = { ...EMPTY, target: { stopId: 'a', routeId: 'r', head: 'h', pi: 0 } };
    const row = { when: new Date('2026-11-26T14:34:00Z') } as CrtmRow;
    const nameOf = (id: string) => id.toUpperCase();
    return (
      scanStatus(EMPTY, nameOf) === 'elige una línea y pulsa escanear' &&
      scanStatus({ ...base, running: true, total: 7, upto: 3 }, nameOf) ===
        'comprobando 3 de 7 paradas…' &&
      scanStatus({ ...base, hit: 'b', rows: [row], finishedAt: 1 }, nameOf) ===
        'bus en vivo en B: llega aquí hacia las 15:34 (estimado)' &&
      scanStatus({ ...base, total: 7, finishedAt: 1 }, nameOf) ===
        'sin buses en vivo en las 7 paradas anteriores' &&
      scanStatus({ ...base, total: 0, finishedAt: 1 }, nameOf).startsWith('esta es la primera')
    );
  })(),
  'scanStatus',
);

const optionKey = (o: LineOption) => `${o.routeId}|${o.head}`;
const tileStyle = (r: RouteInfo) =>
  ({ '--tile': r.color, '--tile-text': r.text }) as React.CSSProperties;

function LineTile({ route }: { route: RouteInfo | undefined }) {
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
    fetchCrtm(stopId)
      .then(async feed => {
        const rows = await directCrtm(parseCrtm(feed.data, new Date()), file, stopId);
        const hits = liveMatches(rows, o.routeId, o.head, singleHead(file, o.routeId));
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
  after: boolean;
  scan: StopScan | undefined;
  est: Date | null;
  data: Names | null;
}) {
  const name = p.data?.names.get(p.id) ?? p.id;
  const town = p.data?.towns.get(p.id);
  const cls = `${p.here ? 'here' : ''}${p.after ? ' passed' : ''}`.trim();
  return (
    <li className={cls || undefined} aria-current={p.here || undefined}>
      <span className="stop-name">
        {name}
        {town && <span className="stop-town"> {town}</span>}
      </span>
      {p.here && <span className="scan-chip">esta parada</span>}
      {p.here && p.est && <span className="scan-chip est">estimado {hhmm(p.est)}</span>}
      {!p.here && !p.after && (
        <span className={`scan-chip ${p.scan?.k ?? 'idle'}`}>{chipText(p.scan)}</span>
      )}
    </li>
  );
}

// The chosen pattern's stops in order, with each one's scan state.
function PatternStops(p: { pattern: Pattern; stopId: string; state: ScanState; data: Names }) {
  const hereAt = p.pattern.findIndex(([id]) => id === p.stopId);
  return (
    <ol className="line-stops" aria-label="Paradas de la línea">
      {p.pattern.map(([id], i) => (
        <StopRow
          key={`${id}-${i}`}
          id={id}
          here={i === hereAt}
          after={hereAt >= 0 && i > hereAt}
          scan={p.state.scans[id]}
          est={i === hereAt ? (p.state.rows[0]?.when ?? null) : null}
          data={p.data}
        />
      ))}
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
      <button className="btn tilt" onClick={scan.stop}>
        detener
      </button>
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

// Pivot "línea": scans the selected stop's line from the tab (see the header comment).
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
  const options = useMemo(() => (busFile ? lineOptions(busFile) : []), [busFile]);
  const [pickedKey, setPickedKey] = useState('');
  useEffect(() => setPickedKey(''), [stop.id]);
  const wanted = state.target ? `${state.target.routeId}|${state.target.head}` : pickedKey;
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
          <p className="status" role="status" aria-live="polite">
            {scanStatus(state, nameOf)}
          </p>
          {own && <p className="status">{OWN_TEXT[own]}</p>}
          <p className="status">máximo {SCAN_MAX} paradas anteriores, la más cercana primero</p>
          {pattern && data && (
            <PatternStops pattern={pattern} stopId={stop.id} state={state} data={data} />
          )}
        </>
      )}
    </>
  );
}
