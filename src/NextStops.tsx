import { useCallback, useEffect, useState } from 'react';
import {
  fetchPositions,
  fetchTripUpdates,
  fetchTripUpdatesLd,
  isOffline,
  loadRoute,
  loadStopNames,
} from './data.ts';
import {
  expectedTimes,
  findPosition,
  hhmm,
  isOuigo,
  nextStops,
  pickPattern,
  plannedTimes,
  stopDelays,
  trainProgress,
  tripEntry,
  type Departure,
  type Pattern,
  type Progress,
  type TripTime,
  type VehiclePosition,
} from './gtfs.ts';
import { useLdEnabled } from './ld.ts';

type Loaded = { pattern: Pattern | null; names: Map<string, string> };

// The vehicle's pattern: exact for timetable rows, else matched on the destination.
function choose(
  pi: number | undefined,
  dest: string,
  stopId: string,
  patterns: Pattern[],
  names: Map<string, string>,
) {
  if (pi !== undefined) return patterns[pi] ?? null;
  const name = names.get(dest) ?? dest;
  return patterns[pickPattern(patterns, stopId, name, id => names.get(id))] ?? null;
}

// Remaining stops of the next departure of a line, with estimated times (base: the departure's
// live or planned time at this stop plus the pattern's offsets). Buses, light rail, Metro, EMT.
function PlainStops({
  dep,
  stopId,
  id,
  onSelect,
}: {
  dep: Departure;
  stopId: string;
  id: string;
  onSelect: (s: { id: string; name: string }, el: HTMLElement) => void;
}) {
  const [loaded, setLoaded] = useState<Loaded | 'error' | 'offline' | null>(null);
  const { routeId, pi, dest } = dep;
  useEffect(() => {
    let current = true;
    Promise.all([loadRoute(routeId), loadStopNames()]).then(
      ([route, names]) =>
        current && setLoaded({ pattern: choose(pi, dest, stopId, route.p, names), names }),
      err => current && setLoaded(isOffline(err) ? 'offline' : 'error'),
    );
    return () => {
      current = false;
    };
  }, [routeId, pi, dest, stopId]);

  if (!loaded)
    return (
      <p className="status next" id={id}>
        cargando…
      </p>
    );
  const rows =
    typeof loaded === 'string' || !loaded.pattern
      ? []
      : nextStops(loaded.pattern, stopId, dep.expected);
  if (!rows.length)
    return (
      <p className="status next" id={id}>
        {loaded === 'offline' ? 'sin conexión · paradas no guardadas' : 'sin paradas'}
      </p>
    );
  return (
    <ol className="next" id={id}>
      {rows.map((r, i) => {
        const name = (loaded as Loaded).names.get(r.id) ?? r.id;
        return (
          <li key={`${r.id}-${i}`}>
            <span className="at">{hhmm(r.at)}</span>
            {r.id === stopId ? (
              <span>{name}</span>
            ) : (
              <button
                className="stop-link tilt"
                aria-label={`Ver salidas de ${name}`}
                onClick={e => onSelect({ id: r.id, name }, e.currentTarget)}
              >
                <span>{name}</span>
              </button>
            )}
          </li>
        );
      })}
    </ol>
  );
}

type StopProps = {
  dep: Departure;
  stopId: string;
  id: string;
  onSelect: (s: { id: string; name: string }, el: HTMLElement) => void;
};

// Renfe trains can be followed live; everything else keeps the plain remaining-stops list.
export default function NextStops(props: StopProps) {
  const { dep } = props;
  return dep.bus || dep.emt || dep.metro ? (
    <PlainStops {...props} />
  ) : (
    <FollowTrain {...props} />
  );
}

const FOLLOW_REFRESH_MS = 30_000;

type Live = {
  tripId: string;
  pos: VehiclePosition | null;
  at: number | null; // when the position was recorded (ms)
  entry: ReturnType<typeof tripEntry>;
  offline: boolean;
};

// When the position was recorded (ms), else when the feed was fetched.
function positionTime(v: VehiclePosition | null, fetchedAt: number | undefined) {
  const secs = Number(v?.timestamp);
  if (secs > 0) return secs * 1000;
  return fetchedAt ?? null;
}

// Position and trip update of one train; refreshed every 30 s while mounted and visible.
function useLive(tripId: string, ld: boolean): Live | null {
  const [live, setLive] = useState<Live | null>(null);
  const load = useCallback(async () => {
    const [pos, trips] = await Promise.allSettled([
      fetchPositions(ld),
      ld ? fetchTripUpdatesLd() : fetchTripUpdates(),
    ]);
    const p = pos.status === 'fulfilled' ? pos.value : null;
    const t = trips.status === 'fulfilled' ? trips.value : null;
    const vehicle = findPosition(p?.data ?? null, tripId);
    setLive({
      tripId,
      pos: vehicle,
      at: positionTime(vehicle, p?.fetchedAt),
      entry: tripEntry(t?.data ?? null, tripId),
      offline: [pos, trips].some(r => r.status === 'rejected' && isOffline(r.reason)),
    });
  }, [tripId, ld]);

  useEffect(() => {
    void load();
    const tick = () => document.hidden || void load();
    const show = () => document.hidden || void load();
    const id = setInterval(tick, FOLLOW_REFRESH_MS);
    document.addEventListener('visibilitychange', show);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', show);
    };
  }, [load]);
  return live?.tripId === tripId ? live : null;
}

function liveStatus(live: Live | null): string | null {
  if (!live) return null;
  const at = live.at ? ` · ${hhmm(new Date(live.at))}` : '';
  if (live.offline) return live.pos ? `sin conexión${at}` : 'sin conexión';
  return live.pos ? `en vivo${at}` : 'sin posición en vivo';
}

// Position marker text: at, arriving at, or between the previous stop and the next.
function positionText(p: Progress, ids: string[], nameOf: (id: string) => string) {
  const name = nameOf(ids[p.index]);
  if (p.state === 'at') return `en ${name}`;
  if (p.state === 'arriving' || p.index === 0) return `llegando a ${name}`;
  return `entre ${nameOf(ids[p.index - 1])} y ${name}`;
}

// First row shown: the earlier stops fold away, but never the train or the previous stop.
function firstShown(here: number, progress: Progress | null) {
  if (!progress) return here;
  const train = progress.state === 'between' ? progress.index - 1 : progress.index;
  return Math.max(0, Math.min(here, train));
}

const foldLabel = (n: number) => (n === 1 ? '1 parada anterior' : `${n} paradas anteriores`);

const delayMin = (t: TripTime) =>
  t.expected ? Math.round((t.expected.getTime() - t.planned.getTime()) / 60000) : 0;

function TripRow({
  t,
  name,
  here,
  passed,
  onSelect,
}: {
  t: TripTime;
  name: string;
  here: boolean;
  passed: boolean;
  onSelect: (s: { id: string; name: string }, el: HTMLElement) => void;
}) {
  const late = delayMin(t);
  return (
    <li className={`${here ? 'here' : ''}${passed ? ' passed' : ''}`}>
      <span className="at">{hhmm(t.expected ?? t.planned)}</span>
      {here ? (
        <span>{name}</span>
      ) : (
        <button
          className="stop-link tilt"
          aria-label={`Ver salidas de ${name}`}
          onClick={e => onSelect({ id: t.id, name }, e.currentTarget)}
        >
          <span>{name}</span>
        </button>
      )}
      {late > 0 && <span className="late">+{late}'</span>}
    </li>
  );
}

function TripList({
  times,
  nameOf,
  here,
  progress,
  onSelect,
}: {
  times: TripTime[];
  nameOf: (id: string) => string;
  here: number;
  progress: Progress | null;
  onSelect: (s: { id: string; name: string }, el: HTMLElement) => void;
}) {
  const [all, setAll] = useState(false);
  const first = firstShown(here, progress);
  const from = all ? 0 : first;
  const ids = times.map(t => t.id);
  return (
    <ol className="next">
      {first > 0 && (
        <li className="fold">
          <button className="stop-link tilt" aria-expanded={all} onClick={() => setAll(!all)}>
            <span>{all ? 'ocultar paradas anteriores' : foldLabel(first)}</span>
          </button>
        </li>
      )}
      {times.slice(from).flatMap((t, k) => {
        const i = from + k;
        const row = (
          <TripRow
            key={`${t.id}-${i}`}
            t={t}
            name={nameOf(t.id)}
            here={i === here}
            passed={!!progress && i < progress.index}
            onSelect={onSelect}
          />
        );
        if (progress?.index !== i) return [row];
        return [
          <li key={`pos-${i}`} className="pos" aria-current="true">
            {positionText(progress, ids, nameOf)}
          </li>,
          row,
        ];
      })}
    </ol>
  );
}

// Whole trip of one Renfe departure: planned and expected times per stop, the train's position
// when it is in the positions feed, earlier stops folded away.
function usePattern(dep: Departure, stopId: string) {
  const [loaded, setLoaded] = useState<Loaded | 'error' | 'offline' | null>(null);
  const { routeId, pi, dest } = dep;
  useEffect(() => {
    let current = true;
    Promise.all([loadRoute(routeId), loadStopNames()]).then(
      ([route, names]) =>
        current && setLoaded({ pattern: choose(pi, dest, stopId, route.p, names), names }),
      err => current && setLoaded(isOffline(err) ? 'offline' : 'error'),
    );
    return () => {
      current = false;
    };
  }, [routeId, pi, dest, stopId]);
  return loaded;
}

const Message = ({ id, text }: { id: string; text: string }) => (
  <p className="status next" id={id}>
    {text}
  </p>
);

// Pattern, planned times and names to show, or the message to show instead.
function followView(loaded: ReturnType<typeof usePattern>, dep: Departure, stopId: string) {
  if (!loaded) return 'cargando…';
  if (typeof loaded === 'string')
    return loaded === 'offline' ? 'sin conexión · paradas no guardadas' : 'sin paradas';
  const planned = loaded.pattern ? plannedTimes(loaded.pattern, stopId, dep.planned) : [];
  if (!loaded.pattern || !planned.length) return 'sin paradas';
  return { pattern: loaded.pattern, planned, names: loaded.names };
}

function FollowTrain({ dep, stopId, id, onSelect }: StopProps) {
  const loaded = usePattern(dep, stopId);
  const ldOn = useLdEnabled();
  const ouigo = isOuigo(dep.routeId);
  const live = useLive(dep.tripId, !!dep.ld && ldOn && !ouigo);
  const view = followView(loaded, dep, stopId);
  if (typeof view === 'string') return <Message id={id} text={view} />;
  const { pattern, planned, names } = view;
  const delays = stopDelays(live?.entry?.stops, new Map(planned.map(t => [t.id, t.at])));
  const status = ouigo ? 'Ouigo: solo horario' : liveStatus(live);
  return (
    <div id={id}>
      {status && <p className="status next">{status}</p>}
      <TripList
        times={expectedTimes(planned, delays, tripDelay(dep, live))}
        nameOf={sid => names.get(sid) ?? sid}
        here={pattern.findIndex(x => x[0] === stopId)}
        progress={trainProgress(pattern, live?.pos ?? null)}
        onSelect={onSelect}
      />
    </div>
  );
}

// Trip-level delay (seconds): the fresh trip update, else the board's live delay, else unknown.
function tripDelay(dep: Departure, live: Live | null): number | null {
  const fresh = live?.entry?.delay;
  if (fresh !== undefined && fresh !== null) return fresh;
  return dep.live ? Math.round((dep.expected.getTime() - dep.planned.getTime()) / 1000) : null;
}

// Pick which departure of a group to follow.
export function TrainPicker({
  list,
  selected,
  onPick,
}: {
  list: Departure[];
  selected: string;
  onPick: (tripId: string) => void;
}) {
  return (
    <div className="picks" role="group" aria-label="Elegir tren">
      {list.map(d => (
        <button
          key={d.tripId}
          className={`pick tilt${d.cancelled ? ' cancelled' : ''}`}
          aria-pressed={d.tripId === selected}
          onClick={() => onPick(d.tripId)}
        >
          {hhmm(d.planned)}
        </button>
      ))}
    </div>
  );
}
