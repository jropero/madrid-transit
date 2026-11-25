import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import AppBar from './AppBar.tsx';
import RefreshBar, { CRTM_REFRESH_MS, REFRESH_MS } from './RefreshBar.tsx';
import Settings from './Settings.tsx';
import Alerts, { AccessMark, AlertMark } from './Alerts.tsx';
import {
  fetchAlerts,
  fetchCrtm,
  fetchEmt,
  fetchTripUpdates,
  isOffline,
  loadAllStops,
  loadStopDeps,
  loadTimetable,
  type Timetable,
} from './data.ts';
import {
  applyRealtime,
  daysUntil,
  emtDepartures,
  ddmm,
  hhmm,
  isBus,
  loadSaved,
  locate,
  madridDate,
  mergeCrtm,
  nearStops,
  parseAlerts,
  parseCrtm,
  parseEmt,
  saveSaved,
  scheduled,
  searchStops,
  townsOf,
  upcoming,
  type Alert,
  type CrtmRow,
  type EmtRow,
  type StopFile,
  type Departure,
  type NearStop,
  type Saved,
  type Stop,
  type TripUpdates,
} from './gtfs.ts';

const VIEWS = ['departures', 'settings'] as const;
type View = (typeof VIEWS)[number];
const VIEW_LABEL: Record<View, string> = { departures: 'salidas', settings: 'ajustes' };

// "Madrid-Atocha Cercanías" -> "Atocha Cercanías" for compact headers.
const short = (name: string) => name.replace(/^Madrid-/, '');

// Static timetable (stops, routes, calendar), loaded once.
function useTimetable() {
  const [tt, setTt] = useState<Timetable | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    loadTimetable().then(setTt, err => setError(String(err)));
  }, []);
  return { tt, error };
}

// The selected stop's scheduled departures (a local file; none for EMT stops).
const isEmtId = (id: string) => id.startsWith('emt_');

function useStopDeps(id: string) {
  const [deps, setDeps] = useState<{ id: string; list: StopFile } | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    setError('');
    if (isEmtId(id)) return; // EMT stops have no timetable file (live only)
    loadStopDeps(id).then(
      list => setDeps({ id, list }),
      err => setError(String(err)),
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

// Live feeds: failures keep the previous data.
function useRealtime(active: boolean) {
  const [rt, setRt] = useState<Realtime>({ trips: null, alerts: [], offline: null });
  const [status, setStatus] = useState('Cargando…');
  const [loadedAt, setLoadedAt] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [trips, alerts] = await Promise.all([fetchTripUpdates(), fetchAlerts()]);
      const offline = trips.offlineSince ?? alerts.offlineSince;
      setRt({ trips: trips.data, alerts: parseAlerts(alerts.data), offline });
      setStatus(
        offline ? `sin conexión · desde ${hhmm(offline)}` : `datos en vivo ${hhmm(new Date())}`,
      );
    } catch (err) {
      setStatus(
        isOffline(err)
          ? 'sin conexión · sin datos en vivo'
          : `sin datos en vivo: ${String(err)}`,
      );
    } finally {
      setLoading(false);
      setLoadedAt(Date.now());
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);
  usePolling(active, loadedAt, load, setLoadedAt, REFRESH_MS);

  return { ...rt, status, setStatus, loadedAt, loading, load };
}

// "en vivo · CRTM 10:05" / "sin conexión · CRTM 10:05" (copy from that time) / "solo horario".
function crtmStatus(rows: CrtmRow[], offline: Date | null, at: Date) {
  if (!rows.length) return offline ? 'sin conexión · solo horario' : 'solo horario';
  return offline ? `sin conexión · CRTM ${hhmm(offline)}` : `en vivo · CRTM ${hhmm(at)}`;
}

// CRTM stop times for a bus or tram stop, every 60 s while `active`; failures and empty
// answers leave the timetable in charge.
function useCrtm(stopId: string, active: boolean) {
  const [got, setGot] = useState<{ id: string; rows: CrtmRow[] } | null>(null);
  const [status, setStatus] = useState('Cargando…');
  const [loadedAt, setLoadedAt] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const feed = await fetchCrtm(stopId);
      const rows = parseCrtm(feed.data, new Date());
      setGot({ id: stopId, rows });
      setStatus(crtmStatus(rows, feed.offlineSince, new Date()));
    } catch (err) {
      setGot({ id: stopId, rows: [] });
      setStatus(isOffline(err) ? 'sin conexión · solo horario' : 'solo horario');
    } finally {
      setLoading(false);
      setLoadedAt(Date.now());
    }
  }, [stopId]);

  useEffect(() => {
    if (active) void load();
  }, [active, load]);
  usePolling(active, loadedAt, load, setLoadedAt, CRTM_REFRESH_MS);

  return {
    rows: got?.id === stopId ? got.rows : null,
    status,
    setStatus,
    loadedAt,
    loading,
    load,
  };
}

type EmtLoad = { rows: EmtRow[]; status: string };

const liveStatus = (label: string, offline: Date | null) =>
  offline
    ? `sin conexión · ${label} ${hhmm(offline)}`
    : `en vivo · ${label} ${hhmm(new Date())}`;

async function tryEmt(stopId: string): Promise<EmtLoad | null> {
  try {
    const feed = await fetchEmt(stopId);
    const rows = parseEmt(feed.data, new Date());
    return rows.length ? { rows, status: liveStatus('EMT', feed.offlineSince) } : null;
  } catch {
    return null;
  }
}

// Fallback: CRTM's own stop times for the same stop number (`6_<n>`), thinner coverage.
async function tryCrtm(stopId: string): Promise<EmtLoad | null> {
  try {
    const feed = await fetchCrtm(`6_${stopId.replace(/^emt_/, '')}`);
    const rows = parseCrtm(feed.data, new Date());
    return rows.length ? { rows, status: liveStatus('CRTM', feed.offlineSince) } : null;
  } catch {
    return null;
  }
}

async function loadEmtRows(stopId: string): Promise<EmtLoad> {
  return (
    (await tryEmt(stopId)) ??
    (await tryCrtm(stopId)) ?? { rows: [], status: 'sin datos en vivo' }
  );
}

// EMT stop arrivals, every 30 s while `active` (rt.php caches 30 s).
function useEmt(stopId: string, active: boolean) {
  const [got, setGot] = useState<({ id: string } & EmtLoad) | null>(null);
  const [status, setStatus] = useState('Cargando…');
  const [loadedAt, setLoadedAt] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const res = await loadEmtRows(stopId);
    setGot({ id: stopId, ...res });
    setStatus(res.status);
    setLoading(false);
    setLoadedAt(Date.now());
  }, [stopId]);

  useEffect(() => {
    if (active) void load();
  }, [active, load]);
  usePolling(active, loadedAt, load, setLoadedAt, REFRESH_MS);

  return {
    rows: got?.id === stopId ? got.rows : null,
    status,
    setStatus,
    loadedAt,
    loading,
    load,
  };
}

const groupKey = (d: Departure) => `${d.line}|${d.dest}`;

// Lines by next departure; each group keeps its own departures in time order.
function groupDepartures(deps: Departure[]) {
  const groups = new Map<string, Departure[]>();
  for (const d of deps) {
    const list = groups.get(groupKey(d)) ?? [];
    list.push(d);
    groups.set(groupKey(d), list);
  }
  return [...groups.entries()];
}

function DepartureRow({ d, now }: { d: Departure; now: number }) {
  const delay = Math.round((d.expected.getTime() - d.planned.getTime()) / 60000);
  const left = Math.max(0, Math.floor((d.expected.getTime() - now) / 60000));
  return (
    <span className={d.cancelled ? 'dep cancelled' : 'dep'}>
      <span className="time">{hhmm(d.planned)}</span>
      {delay > 0 && !d.cancelled && <span className="late">+{delay}'</span>}
      {d.cancelled ? (
        <span className="tag bad">cancelado</span>
      ) : (
        <span className="left">{left === 0 ? 'ahora' : `${left} min`}</span>
      )}
    </span>
  );
}

const MAX_PER_GROUP = 4;

// Tile caption: timetable-only departures are 'tranvía' (light rail) or 'bus'.
const modeLabel = (d: Departure) => {
  if (d.emt) return 'emt';
  if (d.tram) return 'tranvía';
  return d.bus ? 'bus' : 'cercanías';
};

function LineGroup({
  list,
  destName,
  hasAlert,
  now,
}: {
  list: Departure[];
  destName: string;
  hasAlert: boolean;
  now: number;
}) {
  const head = list[0];
  const tile = { '--tile': head.color, '--tile-text': head.text } as React.CSSProperties;
  return (
    <section className="group">
      <span className="tile" style={tile}>
        <b>{head.line}</b>
        <small>{modeLabel(head)}</small>
      </span>
      <span className="deps">
        <span className="dest">
          {short(destName)}
          <AlertMark on={hasAlert} />
          {list.some(d => d.live) && <span className="live">en vivo</span>}
        </span>
        {list.slice(0, MAX_PER_GROUP).map(d => (
          <DepartureRow key={d.tripId} d={d} now={now} />
        ))}
      </span>
    </section>
  );
}

const STOP_MODE: Record<string, string> = { b: 'bus', t: 'tranvía', e: 'emt' };

// "Parla · tren · bold" / "Parla · bus · 16578 · Calle Río Tajo 7": trains and trams in bold.
function StopCaption({ s }: { s: Stop }) {
  const mode = STOP_MODE[s.k ?? ''] ?? 'tren';
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
    <nav className="stops" aria-label="Paradas guardadas">
      {row.map(s => (
        <button key={s.id} aria-current={s.id === selected.id} onClick={() => onSelect(s)}>
          {short(s.name)}
        </button>
      ))}
    </nav>
  );
}

// The timetable file ends at `days.to`: warn a week ahead so it gets rebuilt in time.
function expiryNote(tt: Timetable | null, now: Date, bus: boolean) {
  if (!tt || bus) return '';
  const today = madridDate(now);
  if (today > tt.days.to) return `horario terminado el ${ddmm(tt.days.to)} — actualiza la app`;
  return daysUntil(tt.days.to, now) < 7
    ? `horario termina el ${ddmm(tt.days.to)} — actualiza la app`
    : '';
}

function statusLine(parts: string[]) {
  return parts.filter(Boolean).join(' · ');
}

type Sources = {
  list: StopFile | null;
  trips: TripUpdates | null;
  crtm: CrtmRow[] | null;
  emt: EmtRow[] | null;
};

function departuresAt(tt: Timetable, src: Sources, at: Date): Departure[] {
  if (src.emt) return emtDepartures(src.emt, tt.routes);
  if (!src.list) return [];
  const planned = scheduled(src.list, tt.days, tt.routes, at);
  // Buses and trams: CRTM times where it has them, else the timetable. Renfe: GTFS-RT.
  return isBus(src.list)
    ? mergeCrtm(planned, src.crtm, tt.routes, at)
    : applyRealtime(planned, src.trips);
}

function useDepartureList(tt: Timetable | null, src: Sources) {
  const now = useNow();
  const { list, trips, crtm, emt } = src;
  const deps = useMemo(
    () =>
      tt ? upcoming(departuresAt(tt, { list, trips, crtm, emt }, new Date(now)), now) : [],
    [tt, list, trips, crtm, emt, now],
  );
  return { deps, now };
}

const pickFeed = <A, B, C>(isEmt: boolean, bus: boolean, f: { renfe: A; crtm: B; emt: C }) => {
  if (isEmt) return f.emt;
  return bus ? f.crtm : f.renfe;
};

// Only Renfe stops have alerts.
const alertsOf = (renfeStop: boolean, alerts: Alert[]) => (renfeStop ? alerts : []);
const refreshMs = (bus: boolean, isEmt: boolean) =>
  bus && !isEmt ? CRTM_REFRESH_MS : REFRESH_MS;

// Timetable file loaded (Renfe, bus) or EMT answer in (EMT stops have no file).
const hasStopData = (list: StopFile | null, emtRows: EmtRow[] | null) => !!list || !!emtRows;

// Departures pane: owns search and the live refresh (30 s Renfe, 60 s CRTM; only while `active`).
function Departures({
  stops,
  selected,
  active,
  onSelect,
  onStops,
}: {
  stops: Saved[];
  selected: Saved;
  active: boolean;
  onSelect: (s: Saved) => void;
  onStops: (next: Saved[]) => void;
}) {
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
  const bus = isBus(stopDeps);
  const isEmt = isEmtId(selected.id);
  const renfe = useRealtime(active && !bus && !isEmt);
  const crtm = useCrtm(selected.id, active && bus);
  const emt = useEmt(selected.id, active && isEmt);
  const rt = pickFeed(isEmt, bus, { renfe, crtm, emt });
  const { deps, now } = useDepartureList(tt, {
    list: stopDeps,
    trips: renfe.trips,
    crtm: crtm.rows,
    emt: emt.rows,
  });
  const renfeStop = !bus && !isEmt;
  const alerts = alertsOf(renfeStop, renfe.alerts);

  const stopById = useMemo(() => new Map(tt?.stops.map(s => [s.id, s])), [tt]);
  const wa = stopById.get(selected.id)?.wa ?? false;
  const town = stopById.get(selected.id)?.town;
  const routeIds = useMemo(() => new Set(deps.map(d => d.routeId)), [deps]);
  const groups = groupDepartures(deps);
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
      rt.setStatus(err instanceof Error ? err.message : String(err));
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

  const empty = tt && hasStopData(stopDeps, emt.rows) && groups.length === 0;
  return (
    <>
      {active && (
        <RefreshBar at={rt.loadedAt} loading={rt.loading} ms={refreshMs(bus, isEmt)} />
      )}
      {active && (
        <AppBar
          actions={[
            { icon: 'refresh', label: 'Actualizar', onClick: rt.load },
            {
              icon: 'search',
              label: 'Buscar',
              expanded: showSearch,
              onClick: () => setShowSearch(!showSearch),
            },
            { icon: 'nearMe', label: 'Cerca de mí', onClick: nearMe },
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
      <h2 className="title">
        {short(selected.name)} <AccessMark on={wa} />
      </h2>
      {town && <small className="sub">{town}</small>}

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
            onSelect({ id: s.id, name: s.name });
            setResults([]);
            setShowSearch(false);
          }}
          onSave={s => onStops([...stops, { id: s.id, name: s.name }])}
        />
      )}

      <Alerts alerts={alerts} routeIds={routeIds} />

      {groups.map(([key, list]) => (
        <LineGroup
          key={key}
          list={list}
          destName={stopById.get(list[0].dest)?.name ?? list[0].dest}
          hasAlert={alerts.some(a => a.routeIds.includes(list[0].routeId))}
          now={now}
        />
      ))}
      {empty && <p className="status">sin salidas en las próximas 2 horas</p>}

      <p className="status">
        {statusLine([error, depsError, rt.status, expiryNote(tt, new Date(now), !renfeStop)])}
      </p>
    </>
  );
}

const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// Wall clock for countdowns, ticking independently of the 30s data refresh.
function useNow(tickMs = 10_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
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

// Swipe pivot state: native scroll-snap drives `view`; header taps scroll to the pane.
function usePivot() {
  const scroller = useRef<HTMLDivElement>(null);
  const frame = useRef(0);
  const viewRef = useRef<View>('departures');
  const [view, setView] = useState<View>('departures');
  const [turn, setTurn] = useState<View | null>(null);

  const onScroll = () => {
    if (frame.current) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      const el = scroller.current;
      const next = el && VIEWS[Math.round(el.scrollLeft / el.clientWidth)];
      if (!next || next === viewRef.current) return;
      viewRef.current = next;
      syncHistory(next);
      setView(next);
      setTurn(next);
    });
  };

  const goTo = (v: View) => {
    const el = scroller.current;
    el?.scrollTo({
      left: VIEWS.indexOf(v) * el.clientWidth,
      behavior: reducedMotion() ? 'auto' : 'smooth',
    });
  };

  // System back (Android gesture, iOS swipe-back, browser button) returns to departures.
  useEffect(() => {
    const onPop = () => goTo(pivotState()?.view ?? 'departures');
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  return { scroller, view, turn, onScroll, goTo };
}

// Big lowercase headers, looping like a Windows Phone pivot: the active one comes first,
// the rest follow in order and wrap around.
function PivotHeader({ view, onSelect }: { view: View; onSelect: (v: View) => void }) {
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
    <nav className="views" aria-label="Vistas">
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

export default function App() {
  const [stops, setStops] = useState<Saved[]>(loadSaved);
  const [selected, setSelected] = useState<Saved>(stops[0]);
  const { scroller, view, turn, onScroll, goTo } = usePivot();

  function updateStops(next: Saved[]) {
    setStops(next);
    saveSaved(next);
  }

  const pane = (v: View, children: React.ReactNode) => (
    <section className="pane" aria-label={VIEW_LABEL[v]} inert={view !== v}>
      <div className={turn === v ? 'pane-in turn' : 'pane-in'}>{children}</div>
    </section>
  );

  return (
    <main className="app">
      <p className="brand">Madrid Transit</p>
      <PivotHeader view={view} onSelect={goTo} />
      <div className="panes" ref={scroller} onScroll={onScroll}>
        {pane(
          'departures',
          <Departures
            stops={stops}
            selected={selected}
            active={view === 'departures'}
            onSelect={setSelected}
            onStops={updateStops}
          />,
        )}
        {pane('settings', <Settings />)}
      </div>
    </main>
  );
}
