import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import AppBar from './AppBar.tsx';
import RefreshBar, { REFRESH_MS } from './RefreshBar.tsx';
import Settings from './Settings.tsx';
import Alerts, { AccessMark, AlertMark } from './Alerts.tsx';
import {
  fetchAlerts,
  fetchTripUpdates,
  isOffline,
  loadStopDeps,
  loadTimetable,
  type Timetable,
} from './data.ts';
import {
  applyRealtime,
  daysUntil,
  ddmm,
  hhmm,
  loadSaved,
  locate,
  madridDate,
  nearStops,
  parseAlerts,
  saveSaved,
  scheduled,
  searchStops,
  upcoming,
  type Alert,
  type StopFile,
  type Departure,
  type NearStop,
  type Saved,
  type Stop,
  type TripUpdates,
} from './gtfs.ts';

const VIEWS = ['departures', 'settings'] as const;
type View = (typeof VIEWS)[number];

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

// The selected stop's scheduled departures (a local file).
function useStopDeps(id: string) {
  const [deps, setDeps] = useState<{ id: string; list: StopFile } | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    setError('');
    loadStopDeps(id).then(
      list => setDeps({ id, list }),
      err => setError(String(err)),
    );
  }, [id]);
  return { deps: deps?.id === id ? deps.list : null, error };
}

type Realtime = { trips: TripUpdates | null; alerts: Alert[]; offline: Date | null };

// Live feeds: refresh 30s after the last load (manual or automatic) so the top-edge bar never
// drifts; in the background just re-arm the timer. Failures keep the previous data.
function useRealtime(active: boolean) {
  const [rt, setRt] = useState<Realtime>({ trips: null, alerts: [], offline: null });
  const [status, setStatus] = useState('Loading…');
  const [loadedAt, setLoadedAt] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [trips, alerts] = await Promise.all([fetchTripUpdates(), fetchAlerts()]);
      const offline = trips.offlineSince ?? alerts.offlineSince;
      setRt({ trips: trips.data, alerts: parseAlerts(alerts.data), offline });
      setStatus(offline ? `offline · from ${hhmm(offline)}` : `live data ${hhmm(new Date())}`);
    } catch (err) {
      setStatus(isOffline(err) ? 'offline · no live data' : `no live data: ${String(err)}`);
    } finally {
      setLoading(false);
      setLoadedAt(Date.now());
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!active || loadedAt === null) return;
    const id = setTimeout(
      () => (document.hidden ? setLoadedAt(Date.now()) : void load()),
      REFRESH_MS,
    );
    return () => clearTimeout(id);
  }, [loadedAt, active, load]);

  // Back online: refresh immediately instead of waiting for the next tick.
  useEffect(() => {
    if (!active) return;
    const on = () => void load();
    window.addEventListener('online', on);
    return () => window.removeEventListener('online', on);
  }, [active, load]);

  return { ...rt, status, setStatus, loadedAt, loading, load };
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
        <span className="tag bad">cancelled</span>
      ) : (
        <span className="left">{left === 0 ? 'now' : `${left} min`}</span>
      )}
    </span>
  );
}

const MAX_PER_GROUP = 4;

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
        <small>cercanías</small>
      </span>
      <span className="deps">
        <span className="dest">
          {short(destName)}
          <AlertMark on={hasAlert} />
        </span>
        {list.slice(0, MAX_PER_GROUP).map(d => (
          <DepartureRow key={d.tripId} d={d} now={now} />
        ))}
      </span>
    </section>
  );
}

function SearchPanel({
  query,
  onQuery,
  onSubmit,
  results,
  isSaved,
  onShow,
  onSave,
}: {
  query: string;
  onQuery: (q: string) => void;
  onSubmit: (e: React.FormEvent) => void;
  results: (Stop & { dist?: number })[];
  isSaved: (s: Stop) => boolean;
  onShow: (s: Stop) => void;
  onSave: (s: Stop) => void;
}) {
  return (
    <>
      <form onSubmit={onSubmit} className="search">
        <input
          type="text"
          aria-label="Stop name"
          placeholder="stop name"
          value={query}
          onChange={e => onQuery(e.target.value)}
        />
        <button type="submit" className="btn">
          go
        </button>
      </form>
      {results.length > 0 && (
        <ul className="results">
          {results.map(s => (
            <li key={s.id} className="tilt">
              <span>
                {s.name}
                {s.dist !== undefined && <span className="dist"> {s.dist} m</span>}
              </span>
              <button className="btn" onClick={() => onShow(s)}>
                show
              </button>
              <button className="btn" disabled={isSaved(s)} onClick={() => onSave(s)}>
                save
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
    <nav className="stops" aria-label="Saved stops">
      {row.map(s => (
        <button key={s.id} aria-current={s.id === selected.id} onClick={() => onSelect(s)}>
          {short(s.name)}
        </button>
      ))}
    </nav>
  );
}

// The timetable file ends at `days.to`: warn a week ahead so it gets rebuilt in time.
function expiryNote(tt: Timetable | null, now: Date) {
  if (!tt) return '';
  const today = madridDate(now);
  if (today > tt.days.to) return `timetable ended ${ddmm(tt.days.to)} — redeploy`;
  return daysUntil(tt.days.to, now) < 7 ? `timetable ends ${ddmm(tt.days.to)} — redeploy` : '';
}

function statusLine(parts: string[]) {
  return parts.filter(Boolean).join(' · ');
}

function useDepartureList(
  tt: Timetable | null,
  list: StopFile | null,
  trips: TripUpdates | null,
) {
  const now = useNow();
  const deps = useMemo(() => {
    if (!tt || !list) return [];
    const at = new Date(now);
    return upcoming(applyRealtime(scheduled(list, tt.days, tt.routes, at), trips), now);
  }, [tt, list, trips, now]);
  return { deps, now };
}

// Departures pane: owns search and the 30s live refresh (only while `active`).
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
  const [results, setResults] = useState<(Stop & { dist?: number })[]>([]);
  const [showSearch, setShowSearch] = useState(false);
  const { tt, error } = useTimetable();
  const { deps: stopDeps, error: depsError } = useStopDeps(selected.id);
  const rt = useRealtime(active);
  const { deps, now } = useDepartureList(tt, stopDeps, rt.trips);

  const stopById = useMemo(() => new Map(tt?.stops.map(s => [s.id, s])), [tt]);
  const wa = stopById.get(selected.id)?.wa ?? false;
  const routeIds = useMemo(() => new Set(deps.map(d => d.routeId)), [deps]);
  const groups = groupDepartures(deps);
  const isSaved = (s: { id: string }) => stops.some(x => x.id === s.id);

  async function nearMe() {
    rt.setStatus('locating…');
    try {
      const found = nearStops(tt?.stops ?? [], await locate());
      setResults(found as NearStop[]);
      setShowSearch(true);
      rt.setStatus(found.length ? `${found.length} stops nearby` : 'no stops within 3 km');
    } catch (err) {
      rt.setStatus(err instanceof Error ? err.message : String(err));
    }
  }

  function search(e: React.FormEvent) {
    e.preventDefault();
    const found = searchStops(tt?.stops ?? [], query);
    setResults(found);
    if (!found.length) rt.setStatus(`no stop matches "${query.trim()}"`);
  }

  const empty = tt && stopDeps && groups.length === 0;
  return (
    <>
      {active && <RefreshBar at={rt.loadedAt} loading={rt.loading} />}
      {active && (
        <AppBar
          actions={[
            { icon: 'refresh', label: 'Refresh', onClick: rt.load },
            {
              icon: 'search',
              label: 'Search',
              expanded: showSearch,
              onClick: () => setShowSearch(!showSearch),
            },
            { icon: 'nearMe', label: 'Near me', onClick: nearMe },
          ]}
          menu={[
            {
              label: 'remove stop',
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

      {showSearch && (
        <SearchPanel
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

      <Alerts alerts={rt.alerts} routeIds={routeIds} />

      {groups.map(([key, list]) => (
        <LineGroup
          key={key}
          list={list}
          destName={stopById.get(list[0].dest)?.name ?? list[0].dest}
          hasAlert={rt.alerts.some(a => a.routeIds.includes(list[0].routeId))}
          now={now}
        />
      ))}
      {empty && <p className="status">no departures in the next 2 hours</p>}

      <p className="status">
        {statusLine([error, depsError, rt.status, expiryNote(tt, new Date(now))])}
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
    <nav className="views" aria-label="Views">
      <div className="views-row" key={view} ref={row}>
        {order.map(v => (
          <button
            key={v}
            aria-current={view === v}
            onClick={() => onSelect(v)}
            onKeyDown={onKeyDown}
          >
            {v}
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
    <section className="pane" aria-label={v} inert={view !== v}>
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
