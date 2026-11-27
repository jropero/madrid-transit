import {
  createContext,
  Fragment,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import AppBar, { type BarAction } from './AppBar.tsx';
import RefreshBar, { CRTM_REFRESH_MS, REFRESH_MS } from './RefreshBar.tsx';
import NextStops, { TrainPicker } from './NextStops.tsx';
import { usePivot, type PivotDrag } from './pivot.ts';
import AlertsTab from './AlertsTab.tsx';
import LineTab, {
  estimateText,
  loadArrivalOptions,
  useLineScan,
  useTick,
  type ScanState,
} from './LineScan.tsx';
import { useAutoEstimate } from './autoEstimate.ts';
import Settings from './Settings.tsx';
import StatusNote from './StatusNote.tsx';
import { useLdEnabled } from './ld.ts';
import { loadJson, saveJson } from './storage.ts';
import Trail from './Trail.tsx';
import { useStopNav, type Nav } from './nav.ts';
import { InfoButton, NoDepartures, StopInfo, useInfoToggle } from './StopInfo.tsx';
import { WeatherMark } from './Weather.tsx';
import Alerts, { AccessMark, AlertMark, useAlertBoard } from './Alerts.tsx';
import {
  fetchAlerts,
  fetchCrtm,
  fetchEmt,
  directCrtm,
  fetchTripUpdates,
  fetchTripUpdatesLd,
  isOffline,
  nearFailure,
  prefetchLive,
  warmOffline,
  isTimeout,
  errNoteOf,
  feedNoteOf,
  loadAllStops,
  loadStopDeps,
  loadTimetable,
  type Timetable,
} from './data.ts';
import {
  type BusFile,
  applyRealtime,
  dedupeLd,
  renfeArrivals,
  tileSize,
  compareLines,
  daysUntil,
  emtDepartures,
  emtFromCrtm,
  fmtDist,
  ddmm,
  hhmm,
  isBus,
  lineOptions,
  optionFor,
  liveStatusText,
  staleText,
  loadSaved,
  prefetchTargets,
  parseSort,
  timeRows,
  parseTimeFilter,
  dropShadowed,
  pairEstimates,
  mergeProjected,
  type TimeFilter,
  type SortMode,
  locate,
  madridDate,
  mergeCrtm,
  nearStops,
  parseAlerts,
  parseCrtm,
  arrivalRows,
  parseEmt,
  parseEmtIncidents,
  saveSaved,
  scheduled,
  searchStops,
  stopDirections,
  short,
  townsOf,
  upcoming,
  type Alert,
  type FeedNote,
  type CrtmRow,
  type EmtRow,
  type StopFile,
  type Departure,
  type RouteMap,
  type NearStop,
  type Saved,
  type Stop,
  type TripUpdates,
} from './gtfs.ts';

const VIEWS = ['departures', 'line', 'alerts', 'settings'] as const;
type View = (typeof VIEWS)[number];
const VIEW_LABEL: Record<View, string> = {
  departures: 'salidas',
  line: 'escáner',
  alerts: 'alertas',
  settings: 'ajustes',
};

// "Madrid-Atocha Cercanías" -> "Atocha Cercanías" for compact headers.

// A failed load of a local file: a friendly text offline, the raw error otherwise.
const loadFailure = (err: unknown, offlineText: string) =>
  isOffline(err) ? offlineText : String(err);

// Static timetable (stops, routes, calendar), loaded once.
function useTimetable() {
  const [tt, setTt] = useState<Timetable | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    loadTimetable().then(setTt, err =>
      setError(loadFailure(err, 'sin conexión · horario no disponible')),
    );
  }, []);
  return { tt, error };
}

// The selected stop's scheduled departures (a local file; none for EMT stops).
const isEmtId = (id: string) => id.startsWith('emt_');
// Metro stations (`par_4_<n>`) have live times only, through the CRTM widget (`4_<n>`).
const isMetroId = (id: string) => id.startsWith('par_4_');

function useStopDeps(id: string) {
  const [deps, setDeps] = useState<{ id: string; list: StopFile } | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    setError('');
    if (isEmtId(id) || isMetroId(id)) return; // EMT and Metro have no timetable file (live only)
    loadStopDeps(id).then(
      list => setDeps({ id, list }),
      err => setError(loadFailure(err, 'sin conexión · horario de esta parada no guardado')),
    );
  }, [id]);
  return { deps: deps?.id === id ? deps.list : null, error };
}

type Realtime = { trips: TripUpdates | null; alerts: Alert[]; offline: Date | null };

// Reload `ms` after the last load (manual or automatic) so the top-edge bar never drifts; in
// the background just re-arm the timer. Also reloads as soon as the network is back.
function usePolling(
  active: boolean,
  loadedAt: number | null,
  load: () => unknown,
  rearm: (at: number) => void,
  ms: number,
) {
  useEffect(() => {
    if (!active || loadedAt === null) return;
    const id = setTimeout(() => (document.hidden ? rearm(Date.now()) : void load()), ms);
    return () => clearTimeout(id);
  }, [loadedAt, active, load, rearm, ms]);

  useEffect(() => {
    if (!active) return;
    const on = () => void load();
    window.addEventListener('online', on);
    return () => window.removeEventListener('online', on);
  }, [active, load]);
}

// Renfe feed failure: a timeout falls back to the timetable.
const renfeFailure = (err: unknown) => {
  if (isTimeout(err))
    return liveStatusText({ kind: 'timeout', label: 'Renfe', timetable: true });
  return isOffline(err)
    ? 'sin conexión · sin datos en vivo'
    : `sin datos en vivo: ${String(err)}`;
};

// Status after a Renfe answer: offline copy, a too old copy (timetable only), or fresh.
const renfeStatus = (trips: Feed, offline: Date | null): Status => {
  if (offline) return `sin conexión · desde ${hhmm(offline)}`;
  if (trips.stale) return staleText('Renfe', trips.fetchedAt, true);
  return { label: 'Renfe', fetchedAt: Date.now(), timetable: true };
};

// Live feeds: failures keep the previous data.
function useRealtime(active: boolean, withLd: boolean) {
  const [rt, setRt] = useState<Realtime>({ trips: null, alerts: [], offline: null });
  const [status, setStatus] = useState<Status>('Cargando…');
  const [note, setNote] = useState<FeedNote | null>(null);
  const [loadedAt, setLoadedAt] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [trips, alerts, ld] = await Promise.all([
        fetchTripUpdates(),
        fetchAlerts(),
        withLd ? fetchTripUpdatesLd().catch(() => null) : null,
      ]);
      const offline = trips.offlineSince ?? alerts.offlineSince;
      const merged = { entity: [...(trips.data.entity ?? []), ...(ld?.data.entity ?? [])] };
      setRt({ trips: merged, alerts: parseAlerts(alerts.data), offline });
      setStatus(renfeStatus(trips, offline));
      setNote(feedNoteOf('Renfe', trips) ?? feedNoteOf('Renfe', alerts));
    } catch (err) {
      setStatus(renfeFailure(err));
      setNote(errNoteOf('Renfe', err));
    } finally {
      setLoading(false);
      setLoadedAt(Date.now());
    }
  }, [withLd]);

  useEffect(() => {
    void load();
  }, [load]);
  usePolling(active, loadedAt, load, setLoadedAt, REFRESH_MS);

  const statusText = (anyLive: boolean) => resolveStatus(status, Date.now(), anyLive);
  return { ...rt, statusText, note, setStatus, loadedAt, loading, load };
}

// Status of a CRTM/EMT pane: plain text, or a fresh answer whose age is worked out when shown.
type Fresh = { label: string; fetchedAt: number; timetable: boolean };
type Status = string | Fresh;

// `anyLive`: some displayed departure is live (else the answer had nothing for this stop).
const resolveStatus = (status: Status, now: number, anyLive: boolean) =>
  typeof status === 'string'
    ? status
    : liveStatusText({ kind: 'fresh', ...status, now, anyLive });

// While loading: "esperando datos en vivo…", counting per second after 2 s; otherwise the status
// ("(hace N s)" follows the clock). Ticks only while the pane is active.
const statusTick = (active: boolean, loading: boolean) => {
  if (!active) return 0;
  return loading ? 1000 : 10_000;
};

function useStatusText(
  status: Status,
  active: boolean,
  loadingSince: number | null,
  label: string,
) {
  const now = useNow(statusTick(active, loadingSince !== null));
  return (anyLive: boolean) => {
    if (loadingSince === null) return resolveStatus(status, now, anyLive);
    return liveStatusText({
      kind: 'waiting',
      label,
      waitedMs: Math.max(0, now - loadingSince),
    });
  };
}

type Feed = { offlineSince: Date | null; fetchedAt: number; stale?: boolean };

const freshStatus = (label: string, feed: Feed, timetable: boolean): Status =>
  feed.offlineSince
    ? `sin conexión · ${label} ${hhmm(feed.offlineSince)}`
    : { label, fetchedAt: feed.fetchedAt, timetable };

// "en vivo · CRTM 10:05" / "CRTM: últimos datos de las 10:05 · horario" (copy over 30 min old) / "sin conexión · CRTM 10:05" (copy from that time) / "solo horario"
// (Metro has no timetable: "sin datos en vivo").
function crtmStatus(rows: CrtmRow[], feed: Feed, timetable: boolean): Status {
  if (feed.stale) return staleText('CRTM', feed.fetchedAt, timetable);
  if (!rows.length) {
    const none = timetable ? 'solo horario' : 'sin datos en vivo';
    return feed.offlineSince ? `sin conexión · ${none}` : none;
  }
  return freshStatus('CRTM', feed, timetable);
}

const crtmFailure = (err: unknown, timetable: boolean): Status => {
  if (isTimeout(err)) return liveStatusText({ kind: 'timeout', label: 'CRTM', timetable });
  const none = timetable ? 'solo horario' : 'sin datos en vivo';
  return isOffline(err) ? `sin conexión · ${none}` : none;
};

// CRTM stop times for a bus or tram stop, every 60 s while `active`; failures and empty
// answers leave the timetable in charge.
function useCrtm(
  stopId: string,
  active: boolean,
  timetable: boolean,
  file: StopFile | null,
  arrivals: boolean,
) {
  // Keyed by stop and mode, so a stop's departures never show on its arrivals board.
  const gotKey = `${stopId}|${arrivals ? 'arr' : 'dep'}`;
  const [got, setGot] = useState<{ id: string; rows: CrtmRow[] } | null>(null);
  const [status, setStatus] = useState<Status>('Cargando…');
  const [note, setNote] = useState<FeedNote | null>(null);
  const [loadedAt, setLoadedAt] = useState<number | null>(null);
  const [loadingSince, setLoadingSince] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoadingSince(Date.now());
    try {
      const feed = await fetchCrtm(stopId, arrivals);
      const parsed = parseCrtm(feed.data, new Date());
      const rows = arrivals ? arrivalRows(parsed) : await directCrtm(parsed, file, stopId);
      setGot({ id: gotKey, rows });
      setStatus(crtmStatus(rows, feed, timetable));
      setNote(feedNoteOf('CRTM', feed));
    } catch (err) {
      setGot({ id: gotKey, rows: [] });
      setStatus(crtmFailure(err, timetable));
      setNote(errNoteOf('CRTM', err));
    } finally {
      setLoadingSince(null);
      setLoadedAt(Date.now());
    }
  }, [stopId, gotKey, arrivals, timetable, file]);

  useEffect(() => {
    if (active) void load();
  }, [active, load]);
  usePolling(active, loadedAt, load, setLoadedAt, CRTM_REFRESH_MS);

  return {
    rows: got?.id === gotKey ? got.rows : null,
    statusText: useStatusText(status, active, loadingSince, 'CRTM'),
    note,
    setStatus,
    loadedAt,
    loading: loadingSince !== null,
    load,
  };
}

type EmtLoad = { rows: EmtRow[]; status: Status; alerts: Alert[]; note: FeedNote | null };
// `stale`: the status text when this source only had a copy over 30 min old.
type EmtMiss = { timeout: boolean; note: FeedNote | null; stale?: string };
type EmtTry = EmtLoad | EmtMiss;

const tryFailure = (label: string, err: unknown): EmtMiss => ({
  timeout: isTimeout(err),
  note: errNoteOf(label, err),
});

const staleMiss = (label: string, feed: Feed, note: FeedNote | null): EmtMiss => ({
  timeout: false,
  note,
  stale: staleText(label, feed.fetchedAt, false),
});

async function tryEmt(stopId: string): Promise<EmtTry> {
  try {
    const feed = await fetchEmt(stopId);
    const rows = parseEmt(feed.data, new Date());
    const alerts = parseEmtIncidents(feed.data, new Date());
    const note = feedNoteOf('EMT', feed);
    if (feed.stale) return staleMiss('EMT', feed, note);
    if (!rows.length) return { timeout: false, note };
    return { rows, status: freshStatus('EMT', feed, false), alerts, note };
  } catch (err) {
    return tryFailure('EMT', err);
  }
}

// Fallback: CRTM's own stop times for the same stop number (`6_<n>`), thinner coverage.
async function tryCrtm(stopId: string): Promise<EmtTry> {
  try {
    const feed = await fetchCrtm(`6_${stopId.replace(/^emt_/, '')}`);
    const rows = emtFromCrtm(parseCrtm(feed.data, new Date()));
    const note = feedNoteOf('CRTM', feed);
    if (feed.stale) return staleMiss('CRTM', feed, note);
    if (!rows.length) return { timeout: false, note };
    return { rows, status: freshStatus('CRTM', feed, false), alerts: [], note };
  } catch (err) {
    return tryFailure('CRTM', err);
  }
}

const isLoad = (t: EmtTry): t is EmtLoad => 'rows' in t;

async function loadEmtRows(stopId: string): Promise<EmtLoad> {
  const emt = await tryEmt(stopId);
  if (isLoad(emt)) return emt;
  const crtm = await tryCrtm(stopId);
  if (isLoad(crtm)) return { ...crtm, note: emt.note ?? crtm.note };
  const misses: [string, EmtMiss][] = [
    ['EMT', emt],
    ['CRTM', crtm],
  ];
  const timedOut = misses.find(([, t]) => t.timeout);
  const status = timedOut
    ? liveStatusText({ kind: 'timeout', label: timedOut[0], timetable: false })
    : (emt.stale ?? crtm.stale ?? 'sin datos en vivo');
  return { rows: [], status, alerts: [], note: emt.note ?? crtm.note };
}

// EMT stop arrivals, every 30 s while `active` (rt.php caches 30 s).
function useEmt(stopId: string, active: boolean) {
  const [got, setGot] = useState<({ id: string } & EmtLoad) | null>(null);
  const [status, setStatus] = useState<Status>('Cargando…');
  const [loadedAt, setLoadedAt] = useState<number | null>(null);
  const [loadingSince, setLoadingSince] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoadingSince(Date.now());
    const res = await loadEmtRows(stopId);
    setGot({ id: stopId, ...res });
    setStatus(res.status);
    setLoadingSince(null);
    setLoadedAt(Date.now());
  }, [stopId]);

  useEffect(() => {
    if (active) void load();
  }, [active, load]);
  usePolling(active, loadedAt, load, setLoadedAt, REFRESH_MS);

  return {
    rows: got?.id === stopId ? got.rows : null,
    alerts: got?.id === stopId ? got.alerts : [],
    statusText: useStatusText(status, active, loadingSince, 'EMT'),
    note: got?.id === stopId ? got.note : null,
    setStatus,
    loadedAt,
    loading: loadingSince !== null,
    load,
  };
}

// What a group is named after: the destination, or the origin on the arrivals board.
// Arrivals of one coupled train carry several origins (`origins`), shown joined with " · ".
const originsOf = (d: Departure) => d.origins ?? [d.origin ?? d.dest];
const endOf = (d: Departure, arrivals: boolean) => (arrivals ? originsOf(d).join('|') : d.dest);
const endName = (d: Departure, arrivals: boolean, nameOf: (stop: string) => string) =>
  arrivals
    ? originsOf(d)
        .map(o => short(nameOf(o)))
        .join(' · ')
    : nameOf(d.dest);
const groupKey = (d: Departure, arrivals: boolean) =>
  `${arrivals ? 'arr:' : ''}${d.line}|${endOf(d, arrivals)}`;

// Lines in fixed natural order (line, then destination or origin) so groups don't jump on
// refresh; each group keeps its own departures in time order. The name is the displayed one.
function groupDepartures(
  deps: Departure[],
  nameOf: (stop: string) => string,
  arrivals = false,
) {
  const groups = new Map<string, Departure[]>();
  for (const d of deps) {
    const key = groupKey(d, arrivals);
    const list = groups.get(key) ?? [];
    list.push(d);
    groups.set(key, list);
  }
  return [...groups.entries()].sort(([, a], [, b]) =>
    compareLines(
      { line: a[0].line, dest: endName(a[0], arrivals, nameOf) },
      { line: b[0].line, dest: endName(b[0], arrivals, nameOf) },
    ),
  );
}

// Row state classes: cancelled, live, unconfirmed (CRTM timetable time), estimated (line scan).
const depClass = (d: Departure) =>
  [
    'dep',
    d.cancelled && 'cancelled',
    d.live && 'is-live',
    d.unconfirmed && 'unconfirmed',
    d.estimated && 'estimated',
  ]
    .filter(Boolean)
    .join(' ');

function DepartureRow({ d, now }: { d: Departure; now: number }) {
  const delay = Math.round((d.expected.getTime() - d.planned.getTime()) / 60000);
  const left = Math.max(0, Math.floor((d.expected.getTime() - now) / 60000));
  return (
    <span className={depClass(d)}>
      {d.live && <span className="dot" aria-hidden="true" />}
      <span className="when">
        <span className="time">{hhmm(d.planned)}</span>
        {d.unconfirmed && <span className="tag unconfirmed">no confirmado</span>}
        {d.estimated && <span className="tag estimated">estimado</span>}
        {d.alsoEst && <span className="tag estimated">est. {hhmm(d.alsoEst)}</span>}
      </span>
      {d.live && <span className="sr-only"> en vivo</span>}
      {delay > 0 && !d.cancelled && <span className="late">+{delay}'</span>}
      {d.cancelled ? (
        <span className="tag bad">cancelado</span>
      ) : (
        <>
          <span className="left">{left === 0 ? 'ahora' : `${left} min`}</span>
          {d.distM !== undefined && left <= 5 && (
            <span className="dist">{fmtDist(d.distM)}</span>
          )}
        </>
      )}
    </span>
  );
}

const MAX_PER_GROUP = 4;

// Tile caption: timetable-only departures are 'tranvía' (light rail) or 'bus'.
const modeLabel = (d: Departure) => {
  if (d.emt) return 'emt';
  if (d.metro) return 'metro';
  if (d.tram) return 'tranvía';
  if (d.urban) return 'urbano';
  if (d.ld) return d.mode ?? 'tren';
  return d.bus ? 'bus' : 'cercanías';
};

// "estima tiempo" on a bus / light-rail line without live times: runs the escáner scan for
// that line + direction from salidas itself (provided by App; null where not possible). `key`
// is the line group that started the current scan.
type Estimator = {
  start: (d: Departure, key: string, arrivals: boolean) => void;
  key: string | null;
  state: ScanState;
};
const EstimateCtx = createContext<Estimator | null>(null);

// The group's share of the estimator: whether the running scan is this group's, and a start
// that collapses the group once that scan finds a bus (only the first time, not on repeats).
function useEstimate(lineKey: string, collapse: () => void) {
  const est = useContext(EstimateCtx);
  const mine = !!est?.state.target && est.key === lineKey;
  const found = mine && !!est?.state.hit && !!est.state.rows.length;
  const waiting = useRef(false);
  useEffect(() => {
    if (!found || !waiting.current) return;
    waiting.current = false;
    collapse();
  }, [found, collapse]);
  const start = (d: Departure, arrivals: boolean) => {
    waiting.current = true;
    est?.start(d, lineKey, arrivals);
  };
  return { est, mine, start };
}

function EstimateButton(p: {
  list: Departure[];
  from: boolean; // arrivals board: the scan is an arrivals scan
  est: ReturnType<typeof useEstimate>;
}) {
  const head = p.list[0];
  const { est, mine, start } = p.est;
  const running = mine && !!est?.state.running;
  const now = useTick(running);
  const covered = p.list.some(d => d.live || d.estimated);
  if (!est || !head.bus || (covered && !mine)) return null;
  const line = mine ? estimateText(est.state, now) : '';
  return (
    <div className="estimate">
      <div className="board-mode">
        <button className="btn tilt" disabled={running} onClick={() => start(head, p.from)}>
          {running ? 'estimando…' : 'estima tiempo'}
        </button>
      </div>
      <p className="status" role="status" aria-live="polite">
        {line}
      </p>
    </div>
  );
}

// What a group's button shows. Por línea: a 72 px tile, the destination and up to four
// departures. Compact (por hora): a small tile with the line number, the destination (one line)
// and the one departure, all on a single row.
function GroupFace(p: {
  list: Departure[];
  compact: boolean;
  name: string;
  from: boolean;
  hasAlert: boolean;
  now: number;
}) {
  const { list, compact, from, now } = p;
  const head = list[0];
  const tile = { '--tile': head.color, '--tile-text': head.text } as React.CSSProperties;
  const name = (
    <>
      {from && 'desde '}
      {short(p.name)}
      <AlertMark on={p.hasAlert} />
    </>
  );
  if (compact) {
    return (
      <>
        <span className={`tile row${tileSize(head.line)}`} style={tile}>
          <b>{head.line}</b>
        </span>
        <span className="dest">{name}</span>
        <DepartureRow d={head} now={now} />
      </>
    );
  }
  return (
    <>
      <span className={`tile${tileSize(head.line)}`} style={tile}>
        <b>{head.line}</b>
        <small>{modeLabel(head)}</small>
      </span>
      <span className="deps">
        <span className="dest">
          {name}
          {list.some(d => d.live) && <span className="live">en vivo</span>}
        </span>
        {list.slice(0, MAX_PER_GROUP).map(d => (
          <DepartureRow key={d.tripId} d={d} now={now} />
        ))}
      </span>
    </>
  );
}

// A line and its next departures; tapping it lists the remaining stops of the next one.
function LineGroup({
  list,
  lineKey,
  defaultOpen,
  destName,
  from,
  stopId,
  hasAlert,
  now,
  compact = false,
  onSelect,
}: {
  list: Departure[];
  compact?: boolean; // por hora: one single-departure row
  lineKey: string;
  defaultOpen: boolean;
  destName: string;
  from: boolean; // arrivals board: the name is the origin
  stopId: string;
  hasAlert: boolean;
  now: number;
  onSelect: (s: Saved, el: HTMLElement, lineKey: string) => void;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const collapse = useCallback(() => setOpen(false), []);
  const est = useEstimate(lineKey, collapse);
  const [picked, setPicked] = useState<string | null>(null);
  const head = list[0];
  const followed = list.find(d => d.tripId === picked) ?? head;
  const train = !head.bus && !head.emt && !head.metro;
  const panel = `next-${head.routeId}-${head.tripId}`;
  return (
    <section className={compact ? 'line compact' : 'line'}>
      <button
        className={compact ? 'group compact tilt' : 'group tilt'}
        aria-expanded={open}
        aria-controls={open ? panel : undefined}
        onClick={() => setOpen(!open)}
      >
        <GroupFace
          list={list}
          compact={compact}
          name={destName}
          from={from}
          hasAlert={hasAlert}
          now={now}
        />
      </button>
      {open && (
        <>
          {train && list.length > 1 && (
            <TrainPicker
              list={list.slice(0, MAX_PER_GROUP)}
              selected={followed.tripId}
              onPick={setPicked}
            />
          )}
          <EstimateButton list={list} from={from} est={est} />
          <NextStops
            key={followed.tripId}
            dep={followed}
            stopId={stopId}
            id={panel}
            onSelect={(s, el) => onSelect(s, el, lineKey)}
          />
        </>
      )}
    </section>
  );
}

const STOP_MODE: Record<string, string> = { b: 'bus', t: 'tranvía', m: 'metro', e: 'emt' };

// "Parla · urbano · 16118 · Calle …" (town buses only) / "Parla · tren · bold" / "Parla · bus · 16578 · Calle Río Tajo 7": trains, metro and trams in bold.
function StopCaption({ s }: { s: Stop }) {
  const mode = s.u ? 'urbano' : (STOP_MODE[s.k ?? ''] ?? 'tren');
  const rest = [s.code, s.desc].filter(Boolean);
  return (
    <>
      {s.town ? `${s.town} · ` : ''}
      {s.k === 'b' || s.k === 'e' ? mode : <b>{mode}</b>}
      {rest.length ? ` · ${rest.join(' · ')}` : ''}
    </>
  );
}

function SearchPanel({
  town,
  onTown,
  towns,
  query,
  onQuery,
  onSubmit,
  results,
  isSaved,
  onShow,
  onSave,
}: {
  town: string;
  onTown: (t: string) => void;
  towns: string[];
  query: string;
  onQuery: (q: string) => void;
  onSubmit: (e: React.FormEvent) => void | Promise<void>;
  results: (Stop & { dist?: number })[];
  isSaved: (s: Stop) => boolean;
  onShow: (s: Stop) => void;
  onSave: (s: Stop) => void;
}) {
  return (
    <>
      <form onSubmit={onSubmit} className="search two">
        <input
          type="text"
          aria-label="Municipio"
          placeholder="municipio"
          list="towns"
          value={town}
          onChange={e => onTown(e.target.value)}
        />
        <datalist id="towns">
          {towns.map(t => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </datalist>
        <input
          type="text"
          aria-label="Parada, código o calle"
          placeholder="parada, código o calle"
          value={query}
          onChange={e => onQuery(e.target.value)}
        />
        <button type="submit" className="btn">
          ir
        </button>
      </form>
      {results.length > 0 && (
        <ul className="results">
          {results.map(s => (
            <li key={s.id} className="tilt">
              <span>
                {s.name}
                {s.dist !== undefined && <span className="dist"> {s.dist} m</span>}
                <small className="sub">
                  <StopCaption s={s} />
                </small>
              </span>
              <button className="btn" onClick={() => onShow(s)}>
                ver
              </button>
              <button className="btn" disabled={isSaved(s)} onClick={() => onSave(s)}>
                guardar
              </button>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

// "Guardar parada" for a stop opened from a line list, a connection or search; saved stops
// have none (the menu offers "eliminar parada").
const saveAction = (saved: boolean, onClick: () => void): BarAction[] =>
  saved ? [] : [{ icon: 'star', label: 'Guardar parada', text: 'guardar', onClick }];

// While exploring (two or more stops in the trail) the app bar leads with "volver".
const backAction = (trail: Saved[]): BarAction[] =>
  trail.length < 2
    ? []
    : [{ icon: 'back', label: 'Volver', text: 'volver', onClick: () => history.back() }];

function StopsRow({
  stops,
  selected,
  onSelect,
}: {
  stops: Saved[];
  selected: Saved;
  onSelect: (s: Saved) => void;
}) {
  const row = stops.some(s => s.id === selected.id) ? stops : [...stops, selected];
  // Nothing to switch to: the title below already names the stop.
  if (row.length < 2) return null;
  return (
    <nav className="stops" aria-label="Paradas guardadas" data-no-swipe>
      {row.map(s => (
        <button
          key={s.id}
          className={stops.some(x => x.id === s.id) ? undefined : 'unsaved'}
          aria-current={s.id === selected.id}
          onClick={() => onSelect(s)}
        >
          {short(s.name)}
        </button>
      ))}
    </nav>
  );
}

// The timetable file ends at `days.to`: warn a week ahead so it gets rebuilt in time.
// Bus and light rail stops carry the town in the title (street names repeat across towns), so
// the subtitle keeps only the rest.
function stopHeading(id: string, info: Stop | undefined) {
  const titleTown = /^par_(8|9|10)_/.test(id) ? (info?.town ?? '') : '';
  const subtitle = [titleTown ? '' : info?.town, stopCodeLabel(info, id)]
    .filter(Boolean)
    .join(' · ');
  return { titleTown, subtitle };
}

function expiryNote(tt: Timetable | null, now: Date, bus: boolean) {
  if (!tt || bus) return '';
  const today = madridDate(now);
  if (today > tt.days.to) return `horario terminado el ${ddmm(tt.days.to)} — actualiza la app`;
  return daysUntil(tt.days.to, now) < 7
    ? `horario termina el ${ddmm(tt.days.to)} — actualiza la app`
    : '';
}

const OFFLINE_PREFIX = 'sin conexión · ';

// Parts after one that already starts with the offline prefix drop it.
function statusLine(parts: string[]) {
  const shown = parts.filter(Boolean);
  const first = shown.findIndex(p => p.startsWith(OFFLINE_PREFIX));
  return shown
    .map((p, i) =>
      i > first && first >= 0 && p.startsWith(OFFLINE_PREFIX)
        ? p.slice(OFFLINE_PREFIX.length)
        : p,
    )
    .join(' · ');
}
console.assert(
  statusLine(['sin conexión · a', '', 'sin conexión · b']) === 'sin conexión · a · b' &&
    statusLine(['Error: HTTP 404', 'sin conexión · desde 18:49']) ===
      'Error: HTTP 404 · sin conexión · desde 18:49' &&
    statusLine(['a', '', 'b']) === 'a · b',
  'statusLine',
);

type Sources = {
  list: StopFile | null;
  trips: TripUpdates | null;
  crtm: CrtmRow[] | null;
  emt: EmtRow[] | null;
  metro: boolean;
  ld: boolean;
  arrivals: string | null; // arrivals board (Renfe station or bus/tram terminus): the stop id
  projected: CrtmRow[]; // line scan: live rows of an earlier stop projected onto this stop
};

// The arrivals board: Renfe from the timetable plus GTFS-RT, bus and tram termini from CRTM
// arrival rows only (the timetable has no arrivals for them).
function arrivalsAt(tt: Timetable, src: Sources, list: StopFile, at: Date): Departure[] {
  if (isBus(list)) return busBoard([], src, list, tt.routes, at);
  const arr = renfeArrivals(list, tt.days, tt.routes, at, src.ld, src.arrivals ?? '');
  return dedupeLd(applyRealtime(arr, src.trips), true);
}

// Bus and light-rail board: the timetable merged with CRTM's rows and the scan's projected rows
// (`projected` already holds only this board's kind: departure or arrival estimates), then each
// estimate paired with the stop's own live row of its line (see `pairEstimates`). On the
// arrivals board a route is compared with its origin (`dest`), never as a single direction.
function busBoard(
  planned: Departure[],
  src: Sources,
  list: BusFile,
  routes: RouteMap,
  at: Date,
): Departure[] {
  const single = (id: string) => src.arrivals === null && stopDirections(list, id).length === 1;
  const rows = src.crtm && [...src.crtm, ...src.projected];
  return dropShadowed(pairEstimates(mergeCrtm(planned, rows, routes, at), single));
}

function departuresAt(tt: Timetable, src: Sources, at: Date): Departure[] {
  if (src.emt) return emtDepartures(src.emt, tt.routes);
  // Metro: live times only, no timetable.
  if (src.metro) return mergeCrtm([], src.crtm, tt.routes, at);
  if (!src.list) return [];
  if (src.arrivals !== null) return arrivalsAt(tt, src, src.list, at);
  const planned = scheduled(src.list, tt.days, tt.routes, at, src.ld);
  // Buses and trams: CRTM times where it has them, else the timetable. Renfe: GTFS-RT.
  return isBus(src.list)
    ? busBoard(planned, src, src.list, tt.routes, at)
    : dedupeLd(applyRealtime(planned, src.trips));
}

function useDepartureList(tt: Timetable | null, src: Sources) {
  const now = useNow();
  const { list, trips, crtm, emt, metro, ld, arrivals, projected } = src;
  const deps = useMemo(
    () =>
      tt
        ? upcoming(
            departuresAt(
              tt,
              { list, trips, crtm, emt, metro, ld, arrivals, projected },
              new Date(now),
            ),
            now,
          )
        : [],
    [tt, list, trips, crtm, emt, metro, ld, arrivals, projected, now],
  );
  return { deps, now };
}

// Which live feed drives the pane: EMT, CRTM (buses, light rail, Metro) or Renfe.
const pickFeed = <A, B, C>(
  kind: { emt: boolean; crtm: boolean },
  f: { renfe: A; crtm: B; emt: C },
) => {
  if (kind.emt) return f.emt;
  return kind.crtm ? f.crtm : f.renfe;
};

// Renfe stops have route alerts, EMT stops their own incidents; the rest none.
const alertsOf = (renfeStop: boolean, alerts: Alert[], emt: Alert[]) =>
  renfeStop ? alerts : emt;
const refreshMs = (crtm: boolean) => (crtm ? CRTM_REFRESH_MS : REFRESH_MS);

// Timetable file loaded (Renfe, bus) or the live answer in (EMT and Metro stops have no file).
const hasStopData = (list: StopFile | null, live: CrtmRow[] | EmtRow[] | null) =>
  !!list || !!live;
// A bus arrivals board has no timetable: it waits for CRTM's arrival rows.
const boardHasData = (
  f: { list: StopFile | null; metro: boolean; busArrivals: boolean },
  crtm: CrtmRow[] | null,
  emt: EmtRow[] | null,
) => (f.busArrivals ? !!crtm : hasStopData(f.list, liveRows(f.metro, crtm, emt)));

// The selected stop from the Renfe list, else from the full list (loaded lazily, memoised):
// gives bus, tram, Metro and EMT stops their town and step-free mark.
function useStopInfo(id: string, local: Map<string, Stop>, ready: boolean) {
  const [full, setFull] = useState<Stop | null>(null);
  const known = local.get(id);
  useEffect(() => {
    if (!ready || known) return;
    let current = true;
    loadAllStops().then(
      all => current && setFull(all.find(s => s.id === id) ?? null),
      () => undefined,
    );
    return () => {
      current = false;
    };
  }, [id, known, ready]);
  return known ?? (full?.id === id ? full : undefined);
}

// "parada 16118" (bus, tram, Metro, EMT) or "estación 18000" (Renfe); empty when unknown.
function stopCodeLabel(info: Stop | undefined, id: string): string {
  if (info?.code) return `parada ${info.code}`;
  return info?.k === 'r' && /^\d+$/.test(id) ? `estación ${id}` : '';
}

const INFO_PANEL = 'stop-info';

type GroupList = [string, Departure[]][];

// Line groups (Cercanías and every other mode first, then media/larga distancia under its own heading).
function BoardGroups(p: {
  groups: GroupList;
  ldGroups: GroupList;
  arrivals: boolean;
  stopId: string;
  openLine?: string;
  destName: (id: string) => string;
  board: ReturnType<typeof useAlertBoard>;
  now: number;
  onSelect: (s: Saved, el: HTMLElement, lineKey: string) => void;
}) {
  return [...p.groups, ...p.ldGroups].map(([key, list], i) => (
    <Fragment key={`${p.stopId}|${key}`}>
      {p.ldGroups.length > 0 && i === p.groups.length && (
        <h3 className="section-sub">media y larga distancia</h3>
      )}
      <LineGroup
        list={list}
        lineKey={key}
        defaultOpen={!p.arrivals && p.openLine === key}
        stopId={p.stopId}
        destName={endName(list[0], p.arrivals, p.destName)}
        from={p.arrivals}
        hasAlert={p.board.marks(list[0].routeId, list[0].line)}
        now={p.now}
        onSelect={p.onSelect}
      />
    </Fragment>
  ));
}

// "Por hora": one compact row per departure (already windowed, filtered and ordered). Each row
// is a LineGroup with a single departure, so tap-to-expand stops and train following keep
// working; the key is unique per trip and call (a row never takes over another's open state).
function TimeRows(p: {
  rows: Departure[];
  arrivals: boolean;
  stopId: string;
  destName: (id: string) => string;
  board: ReturnType<typeof useAlertBoard>;
  now: number;
  onSelect: (s: Saved, el: HTMLElement, lineKey: string) => void;
}) {
  return p.rows.map(d => {
    const key = `time:${d.routeId}|${d.tripId}|${d.planned.getTime()}`;
    return (
      <LineGroup
        key={`${p.stopId}|${key}`}
        list={[d]}
        lineKey={key}
        defaultOpen={false}
        compact
        stopId={p.stopId}
        destName={endName(d, p.arrivals, p.destName)}
        from={p.arrivals}
        hasAlert={p.board.marks(d.routeId, d.line)}
        now={p.now}
        onSelect={p.onSelect}
      />
    );
  });
}

const TIME_FILTER_KEY = 'madrid-transit:time-filter';
const TIME_FILTERS: { id: TimeFilter; label: string }[] = [
  { id: 'confirmed', label: 'confirmados' },
  { id: 'all', label: 'todos' },
];

// The confirmados / todos choice of por hora, kept across stops and reloads.
function useTimeFilter() {
  const [filter, setFilter] = useState<TimeFilter>(() =>
    parseTimeFilter(loadJson<unknown>(TIME_FILTER_KEY, null)),
  );
  const choose = (f: TimeFilter) => {
    setFilter(f);
    saveJson(TIME_FILTER_KEY, f);
  };
  return [filter, choose] as const;
}

// Confirmados (live or estimated) / todos, only in por hora.
function TimeFilterSwitch(p: {
  show: boolean;
  filter: TimeFilter;
  onFilter: (f: TimeFilter) => void;
}) {
  if (!p.show) return null;
  return (
    <div className="board-mode" role="group" aria-label="Filtro de la lista">
      {TIME_FILTERS.map(f => (
        <button
          key={f.id}
          className="btn tilt"
          aria-pressed={p.filter === f.id}
          onClick={() => p.onFilter(f.id)}
        >
          {f.label}
        </button>
      ))}
    </div>
  );
}

// "ninguna salida confirmada en los próximos 60 min" when por hora has no rows.
const timeEmptyText = (arrivals: boolean, filter: TimeFilter) => {
  const what = arrivals ? 'llegada' : 'salida';
  return `ninguna ${what}${filter === 'confirmed' ? ' confirmada' : ''} en los próximos 60 min`;
};
console.assert(
  timeEmptyText(false, 'confirmed') === 'ninguna salida confirmada en los próximos 60 min' &&
    timeEmptyText(true, 'confirmed') === 'ninguna llegada confirmada en los próximos 60 min' &&
    timeEmptyText(false, 'all') === 'ninguna salida en los próximos 60 min',
  'timeEmptyText',
);

// The por hora board: the auto-estimate status line, the rows, or why there are none.
function TimeBoard(
  p: { rows: Departure[]; hasDeps: boolean; filter: TimeFilter; status: string } & Parameters<
    typeof TimeRows
  >[0],
) {
  const { hasDeps, filter, status, ...rest } = p;
  return (
    <>
      <p className="status auto-status" role="status" aria-live="polite">
        {status}
      </p>
      <TimeRows {...rest} />
      {hasDeps && p.rows.length === 0 && (
        <p className="status">{timeEmptyText(p.arrivals, filter)}</p>
      )}
    </>
  );
}

// The salidas/llegadas choice, kept while browsing; the switch only exists on Renfe stations and
// on bus/tram termini (`t: 1`).
function useBoardMode(showSwitch: boolean, stopId: string) {
  const [mode, setMode] = useState<BoardMode>('salidas');
  const arrivals = showSwitch && mode === 'llegadas';
  // The stop id when the arrivals board is on, else null (what `Sources.arrivals` wants).
  return { mode, setMode, showSwitch, arrivals, arrivalsAt: arrivals ? stopId : null };
}

// Nothing in the next 2 hours: arrivals say so, departures also list the lines that serve the stop.
function EmptyBoard(p: {
  arrivals: boolean;
  stopId: string;
  routes?: RouteMap; // absent: the board is not empty (or not loaded)
  now: number;
}) {
  if (!p.routes) return null;
  if (p.arrivals) return <p className="status">sin llegadas en las próximas 2 horas</p>;
  return (
    <NoDepartures
      stopId={p.stopId}
      routes={p.routes}
      now={p.now}
      fallback="sin salidas en las próximas 2 horas"
    />
  );
}

const liveRows = (metro: boolean, crtm: CrtmRow[] | null, emt: EmtRow[] | null) =>
  metro ? crtm : emt;
const isEmpty = (tt: Timetable | null, hasData: boolean, groups: GroupList) =>
  !!tt && hasData && groups.length === 0;

const emptyRoutes = (empty: boolean, tt: Timetable | null) => (empty ? tt?.routes : undefined);

// Renfe stations and bus/tram termini (`t: 1`) get the salidas/llegadas switch.
const hasBoardSwitch = (renfeStop: boolean, list: StopFile | null) =>
  !!list && (renfeStop || (isBus(list) && list.t === 1));

type BoardMode = 'salidas' | 'llegadas';
const BOARD_MODES: BoardMode[] = ['salidas', 'llegadas'];

// Switch between a stop's departures and arrivals.
function BoardSwitch(p: { show: boolean; mode: BoardMode; onMode: (m: BoardMode) => void }) {
  const { mode, onMode } = p;
  if (!p.show) return null;
  return (
    <div className="board-mode" role="group" aria-label="Panel de salidas o llegadas">
      {BOARD_MODES.map(m => (
        <button
          key={m}
          className="btn tilt"
          aria-pressed={mode === m}
          onClick={() => onMode(m)}
        >
          {m}
        </button>
      ))}
    </div>
  );
}

const SORT_KEY = 'madrid-transit:sort';
const SORT_MODES: { id: SortMode; label: string }[] = [
  { id: 'line', label: 'por línea' },
  { id: 'time', label: 'por hora' },
];

// The por línea / por hora choice, kept across stops and reloads.
function useSortMode() {
  const [sort, setSort] = useState<SortMode>(() =>
    parseSort(loadJson<unknown>(SORT_KEY, null)),
  );
  const choose = (m: SortMode) => {
    setSort(m);
    saveJson(SORT_KEY, m);
  };
  return [sort, choose] as const;
}

// Switch between grouping departures by line and one list by time.
function SortSwitch(p: { show: boolean; sort: SortMode; onSort: (m: SortMode) => void }) {
  if (!p.show) return null;
  return (
    <div className="board-mode" role="group" aria-label="Orden de la lista">
      {SORT_MODES.map(m => (
        <button
          key={m.id}
          className="btn tilt"
          aria-pressed={p.sort === m.id}
          onClick={() => p.onSort(m.id)}
        >
          {m.label}
        </button>
      ))}
    </div>
  );
}

// The estimates feeding this board: the escáner's, plus por hora's own automatic ones (bus and
// light-rail stops, only while por hora is showing). Only this board's kind: arrival ones on
// llegadas, departure ones on salidas. `status` is the automatic scan's progress line.
function useBoardEstimates(p: {
  stopId: string;
  file: StopFile | null;
  depsRef: React.RefObject<Departure[]>;
  arrivals: boolean;
  timeMode: boolean;
  active: boolean;
  ready: boolean;
  projected: CrtmRow[];
}) {
  const { arrivals, timeMode, projected } = p;
  const auto = useAutoEstimate({
    stopId: p.stopId,
    file: isBus(p.file) ? p.file : null,
    depsRef: p.depsRef,
    arrivals,
    active: p.active && timeMode,
    ready: p.ready,
  });
  const own = timeMode ? auto.rows : NONE;
  const estimates = useMemo(
    () => mergeProjected(projected, own).filter(r => !!r.arr === arrivals),
    [projected, own, arrivals],
  );
  return { estimates, status: auto.status };
}
const NONE: CrtmRow[] = [];

// Departures pane: owns search and the live refresh (30 s Renfe, 60 s CRTM; only while `active`).
function Departures({
  stops,
  nav,
  active,
  onSelect,
  onJump,
  onStops,
  projected,
}: {
  stops: Saved[];
  nav: Nav;
  projected: CrtmRow[];
  active: boolean;
  onSelect: (s: Saved) => void;
  onJump: (s: Saved, openLine?: string) => void;
  onStops: (next: Saved[]) => void;
}) {
  const { stop: selected, trail = [], openLine } = nav;
  const [query, setQuery] = useState('');
  const [townQuery, setTownQuery] = useState('');
  const [towns, setTowns] = useState<string[]>([]);
  const [results, setResults] = useState<(Stop & { dist?: number })[]>([]);
  const [showSearch, setShowSearch] = useState(false);

  // Town suggestions for the first search box, loaded with the stop list when search opens.
  useEffect(() => {
    if (!showSearch || towns.length) return;
    loadAllStops()
      .then(all => setTowns(townsOf(all)))
      .catch(() => undefined);
  }, [showSearch, towns.length]);
  const { tt, error } = useTimetable();
  const { deps: stopDeps, error: depsError } = useStopDeps(selected.id);
  const ld = useLdEnabled();
  const bus = isBus(stopDeps);
  const isEmt = isEmtId(selected.id);
  const isMetro = isMetroId(selected.id);
  const useCrtmFeed = bus || isMetro;
  const renfeStop = !useCrtmFeed && !isEmt;
  const renfe = useRealtime(active && !useCrtmFeed && !isEmt, ld);
  const { mode, setMode, showSwitch, arrivals, arrivalsAt } = useBoardMode(
    hasBoardSwitch(renfeStop, stopDeps),
    selected.id,
  );
  const busArrivals = arrivals && bus;
  const crtm = useCrtm(selected.id, active && useCrtmFeed, !isMetro, stopDeps, busArrivals);
  const emt = useEmt(selected.id, active && isEmt);
  const rt = pickFeed({ emt: isEmt, crtm: useCrtmFeed }, { renfe, crtm, emt });
  const [sort, setSort] = useSortMode();
  const [timeFilter, setTimeFilter] = useTimeFilter();
  const timeMode = sort === 'time';
  const depsRef = useRef<Departure[]>([]);
  const auto = useBoardEstimates({
    stopId: selected.id,
    file: stopDeps,
    depsRef,
    arrivals: busArrivals,
    timeMode,
    active,
    ready: crtm.rows !== null,
    projected,
  });
  const { deps, now } = useDepartureList(tt, {
    list: stopDeps,
    trips: renfe.trips,
    crtm: crtm.rows,
    emt: emt.rows,
    metro: isMetro,
    ld,
    arrivals: arrivalsAt,
    projected: auto.estimates,
  });
  useEffect(() => {
    depsRef.current = deps;
  }, [deps]);
  const timed = useMemo(() => timeRows(deps, now, timeFilter), [deps, now, timeFilter]);
  const statusText = rt.statusText(deps.some(d => d.live));
  const alerts = alertsOf(renfeStop, renfe.alerts, emt.alerts);

  const stopById = useMemo(() => new Map(tt?.stops.map(s => [s.id, s])), [tt]);
  const info = useStopInfo(selected.id, stopById, !!tt);
  const [infoOpen, toggleInfo] = useInfoToggle(selected.id);
  const wa = info?.wa ?? false;
  const { titleTown, subtitle } = stopHeading(selected.id, info);
  const routeIds = useMemo(() => new Set(deps.map(d => d.routeId)), [deps]);
  const lines = useMemo(() => new Set(deps.map(d => d.line.toLowerCase())), [deps]);
  const board = useAlertBoard(alerts, routeIds, lines);
  const destName = (id: string) => stopById.get(id)?.name ?? id;
  // Cercanías and every other mode first, media/larga distancia in its own section after them.
  const allGroups = groupDepartures(deps, destName, arrivals);
  const groups = allGroups.filter(([, l]) => !l[0].ld);
  const ldGroups = allGroups.filter(([, l]) => l[0].ld);
  // From a line's stop list: select the stop (not saved) and return the pane to the top.
  const showStop = (s: Saved, el: HTMLElement, lineKey: string) => {
    onJump({ id: s.id, name: s.name }, lineKey);
    el.closest('.pane')?.scrollTo({ top: 0 });
  };
  const isSaved = (s: { id: string }) => stops.some(x => x.id === s.id);

  async function nearMe() {
    rt.setStatus('localizando…');
    try {
      const [here, all] = await Promise.all([locate(), loadAllStops()]);
      const found = nearStops(all, here);
      setResults(found as NearStop[]);
      setShowSearch(true);
      rt.setStatus(
        found.length ? `paradas cercanas: ${found.length}` : 'ninguna parada a menos de 3 km',
      );
    } catch (err) {
      rt.setStatus(nearFailure(err));
    }
  }

  async function search(e: React.FormEvent) {
    e.preventDefault();
    try {
      const found = searchStops(await loadAllStops(), query, townQuery);
      setResults(found);
      if (!found.length) rt.setStatus('ninguna parada coincide con la búsqueda');
    } catch (err) {
      rt.setStatus(isOffline(err) ? 'sin conexión · lista de paradas no cargada' : String(err));
    }
  }

  const empty = isEmpty(
    tt,
    boardHasData({ list: stopDeps, metro: isMetro, busArrivals }, crtm.rows, emt.rows),
    allGroups,
  );
  return (
    <>
      {active && (
        <RefreshBar at={rt.loadedAt} loading={rt.loading} ms={refreshMs(useCrtmFeed)} />
      )}
      {active && (
        <AppBar
          actions={[
            ...backAction(trail),
            { icon: 'refresh', label: 'Actualizar', onClick: rt.load },
            {
              icon: 'search',
              label: 'Buscar',
              expanded: showSearch,
              onClick: () => setShowSearch(!showSearch),
            },
            { icon: 'nearMe', label: 'Cerca de mí', onClick: nearMe },
            ...saveAction(isSaved(selected), () => onStops([...stops, selected])),
          ]}
          menu={[
            {
              label: 'eliminar parada',
              disabled: !isSaved(selected) || stops.length <= 1,
              onClick: () => {
                const next = stops.filter(s => s.id !== selected.id);
                onStops(next);
                onSelect(next[0]);
              },
            },
          ]}
        />
      )}
      <StopsRow stops={stops} selected={selected} onSelect={onSelect} />
      <Trail trail={trail} />
      <div className="title-row">
        <h2 className="title">
          {short(selected.name)}
          {titleTown && <span className="title-town"> {titleTown}</span>} <AccessMark on={wa} />
          <InfoButton open={infoOpen} panelId={INFO_PANEL} onToggle={toggleInfo} />
        </h2>
        <WeatherMark lat={info?.lat} lon={info?.lon} />
      </div>
      {subtitle && <small className="sub">{subtitle}</small>}
      {infoOpen && tt && (
        <StopInfo
          id={INFO_PANEL}
          stop={info}
          routes={tt.routes}
          deps={deps}
          now={now}
          onSelect={s => onJump(s)}
        />
      )}

      {showSearch && (
        <SearchPanel
          town={townQuery}
          onTown={setTownQuery}
          towns={towns}
          query={query}
          onQuery={setQuery}
          onSubmit={search}
          results={results}
          isSaved={isSaved}
          onShow={s => {
            onJump({ id: s.id, name: s.name });
            setResults([]);
            setShowSearch(false);
          }}
          onSave={s => onStops([...stops, { id: s.id, name: s.name }])}
        />
      )}

      <Alerts board={board} />

      <div className="board-controls">
        <BoardSwitch show={showSwitch} mode={mode} onMode={setMode} />
        <SortSwitch show={deps.length > 0} sort={sort} onSort={setSort} />
        <TimeFilterSwitch
          show={timeMode && deps.length > 0}
          filter={timeFilter}
          onFilter={setTimeFilter}
        />
      </div>

      {timeMode ? (
        <TimeBoard
          rows={timed}
          hasDeps={deps.length > 0}
          filter={timeFilter}
          status={auto.status}
          arrivals={arrivals}
          stopId={selected.id}
          destName={destName}
          board={board}
          now={now}
          onSelect={showStop}
        />
      ) : (
        <BoardGroups
          groups={groups}
          ldGroups={ldGroups}
          arrivals={arrivals}
          stopId={selected.id}
          openLine={openLine}
          destName={destName}
          board={board}
          now={now}
          onSelect={showStop}
        />
      )}
      <EmptyBoard
        arrivals={arrivals}
        stopId={selected.id}
        routes={emptyRoutes(empty, tt)}
        now={now}
      />

      <p className="status">
        {statusLine([error, depsError, statusText, expiryNote(tt, new Date(now), !renfeStop)])}
      </p>
      {rt.note && <StatusNote key={selected.id} note={rt.note} />}
    </>
  );
}

// Wall clock for countdowns, ticking independently of the 30s data refresh.
function useNow(tickMs = 10_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (tickMs <= 0) return;
    const id = setInterval(() => setNow(Date.now()), tickMs);
    return () => clearInterval(id);
  }, [tickMs]);
  return now;
}

type PivotState = { pivot: true; view: View };

const pivotState = (): PivotState | null => {
  const st = history.state as Partial<PivotState> | null;
  return st?.pivot ? (st as PivotState) : null;
};

// Keep at most one history entry for the pivot: leaving departures pushes it, moving between
// the other views replaces it, and returning to departures pops it.
function syncHistory(next: View) {
  const entry = pivotState();
  if (next === 'departures') {
    if (entry) history.back();
  } else if (entry) {
    history.replaceState({ pivot: true, view: next }, '');
  } else {
    history.pushState({ pivot: true, view: next }, '');
  }
}

const usePivotViews = () =>
  usePivot<View>(VIEWS, syncHistory, () => pivotState()?.view ?? 'departures');

// Big lowercase headers, looping like a Windows Phone pivot: the active one comes first,
// the rest follow in order and wrap around.
function PivotHeader({
  view,
  onSelect,
  drag,
}: {
  view: View;
  onSelect: (v: View) => void;
  drag: PivotDrag; // the header swipes the panes too
}) {
  const row = useRef<HTMLDivElement>(null);
  const refocus = useRef(false);
  const i = VIEWS.indexOf(view);
  const order = [...VIEWS.slice(i), ...VIEWS.slice(0, i)];

  // The row is rebuilt when the view changes; hand keyboard focus to the new first header.
  useEffect(() => {
    if (!refocus.current) return;
    refocus.current = false;
    row.current?.querySelector('button')?.focus();
  }, [view]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    const step = { ArrowLeft: -1, ArrowRight: 1 }[e.key];
    if (!step) return;
    e.preventDefault();
    refocus.current = true;
    onSelect(VIEWS[(i + step + VIEWS.length) % VIEWS.length]);
  };

  return (
    <nav className="views" aria-label="Vistas" {...drag}>
      <div className="views-row" key={view} ref={row}>
        {order.map(v => (
          <button
            key={v}
            aria-current={view === v}
            onClick={() => onSelect(v)}
            onKeyDown={onKeyDown}
          >
            {VIEW_LABEL[v]}
          </button>
        ))}
      </div>
    </nav>
  );
}

// Preload the timetable files of the saved stops while online, away from the first paint.
function useWarmOffline(ids: string[]) {
  const key = ids.join(',');
  useEffect(() => {
    const run = () => {
      if (navigator.onLine) void warmOffline(key ? key.split(',') : []);
    };
    const idle = () => ('requestIdleCallback' in window ? requestIdleCallback(run) : run());
    const timer = window.setTimeout(idle, 2500);
    const onOnline = () => window.setTimeout(idle, 2500);
    window.addEventListener('online', onOnline);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('online', onOnline);
    };
  }, [key]);
}

// Fetch the live times of the saved stops shortly after start (after the stop on screen has
// started its own load) and whenever the app comes back to the foreground or online. The 30 s
// memo in `fetchCrtm` / `fetchEmt` makes repeats within that time free.
const PREFETCH_DELAY_MS = 1500;
function usePrefetchLive(stops: Saved[]) {
  const key = JSON.stringify(prefetchTargets(stops));
  useEffect(() => {
    const pending = new Set<number>();
    const run = () => {
      pending.forEach(id => window.clearTimeout(id));
      pending.clear();
      const id = window.setTimeout(() => {
        pending.delete(id);
        if (navigator.onLine && document.visibilityState === 'visible') {
          prefetchLive(JSON.parse(key) as ReturnType<typeof prefetchTargets>);
        }
      }, PREFETCH_DELAY_MS);
      pending.add(id);
    };
    const onVisible = () => document.visibilityState === 'visible' && run();
    run();
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('online', run);
    return () => {
      pending.forEach(id => window.clearTimeout(id));
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', run);
    };
  }, [key]);
}

// The scan option for a group's "estima tiempo": departures by route + headsign, arrivals the
// route's own arrival option (no headsign: its destination is the origin).
async function pickOption(file: BusFile, stopId: string, d: Departure, arrivals: boolean) {
  if (!arrivals) return optionFor(lineOptions(file), d.routeId, d.dest);
  const opts = await loadArrivalOptions(file, stopId);
  return opts.find(o => o.routeId === d.routeId) ?? null;
}

export default function App() {
  const [stops, setStops] = useState<Saved[]>(loadSaved);
  const { nav, select, jump, toast } = useStopNav(stops[0]);
  useWarmOffline(stops.map(s => s.id));
  usePrefetchLive(stops);
  const { ref, view, goTo, paneStyle, paneIn, drag } = usePivotViews();
  const { tt } = useTimetable();
  const { deps: stopFile, error: fileError } = useStopDeps(nav.stop.id);
  const scan = useLineScan(nav.stop.id);
  // Switching tabs stops a running scan and its follow-ups (an estimate already found stays).
  const pauseScan = scan.pause;
  useEffect(() => pauseScan(), [view, pauseScan]);

  function updateStops(next: Saved[]) {
    setStops(next);
    saveSaved(next);
  }

  // "estima tiempo" in a line group: scan that line + direction from this stop, on escáner.
  const stopId = nav.stop.id;
  const [estKey, setEstKey] = useState<string | null>(null);
  const estimate: Estimator | null = isBus(stopFile)
    ? {
        start: (d, key, arrivals) => {
          setEstKey(key);
          void pickOption(stopFile, stopId, d, arrivals).then(
            o => o && scan.start({ stopId, ...o }),
          );
        },
        key: estKey,
        state: scan.state,
      }
    : null;

  const pane = (v: View, children: React.ReactNode) => (
    <section
      className="pane"
      aria-label={VIEW_LABEL[v]}
      inert={view !== v}
      style={paneStyle(v)}
    >
      <div {...paneIn(v)}>{children}</div>
    </section>
  );

  return (
    <main className="app">
      <p className="brand">Madrid Transit</p>
      <PivotHeader view={view} onSelect={goTo} drag={drag} />
      <div className="panes" ref={ref} {...drag}>
        {pane(
          'departures',
          <EstimateCtx value={estimate}>
            <Departures
              stops={stops}
              nav={nav}
              active={view === 'departures'}
              onSelect={select}
              onJump={jump}
              onStops={updateStops}
              projected={scan.state.rows}
            />
          </EstimateCtx>,
        )}
        {pane(
          'line',
          <LineTab
            stop={nav.stop}
            file={stopFile}
            fileError={fileError}
            routes={tt?.routes ?? null}
            scan={scan}
          />,
        )}
        {pane(
          'alerts',
          <AlertsTab stop={nav.stop} active={view === 'alerts'} routes={tt?.routes ?? null} />,
        )}
        {pane('settings', <Settings stops={stops} onStops={updateStops} />)}
      </div>
      <p className="toast" role="status" aria-live="polite">
        {toast && <span>Vuelve atrás otra vez para salir</span>}
      </p>
    </main>
  );
}
