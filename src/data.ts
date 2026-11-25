// Loading of the local timetable (public/data) and the live Renfe GTFS-RT feeds (via rt.php).
import { loadJson, saveJson } from './storage.ts';
import type {
  AlertFeed,
  CrtmJson,
  DaysFile,
  StopFile,
  RouteMap,
  Stop,
  TripUpdates,
} from './gtfs.ts';

const base = import.meta.env.BASE_URL;

const getJson = async <T>(url: string): Promise<T> => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  return (await res.json()) as T;
};

// Memoised; a failed load is forgotten so the next refresh retries.
const memo = <T>(cache: Map<string, Promise<T>>, key: string, load: () => Promise<T>) => {
  let p = cache.get(key);
  if (!p) {
    p = load();
    p.catch(() => cache.delete(key));
    cache.set(key, p);
  }
  return p;
};

// Renfe stops (small, destination names and step-free flags) load with the rest; the full list
// including ~6.6k bus stops (stops.json) only loads for search and near me.
export type Timetable = { stops: Stop[]; routes: RouteMap; days: DaysFile };
const statics = new Map<string, Promise<Timetable>>();
export const loadTimetable = () =>
  memo(statics, 'all', async () => {
    const [stops, routes, days] = await Promise.all([
      getJson<Stop[]>(`${base}data/stops-renfe.json`),
      getJson<RouteMap>(`${base}data/routes.json`),
      getJson<DaysFile>(`${base}data/days.json`),
    ]);
    return { stops, routes, days };
  });

const allStopsMemo = new Map<string, Promise<Stop[]>>();
export const loadAllStops = () =>
  memo(allStopsMemo, 'all', () => getJson<Stop[]>(`${base}data/stops.json`));

const perStop = new Map<string, Promise<StopFile>>();
export const loadStopDeps = (id: string) =>
  memo(perStop, id, () => getJson<StopFile>(`${base}data/stop/${encodeURIComponent(id)}.json`));

// Keep only what the app reads: the raw trip_updates feed covers all of Spain (~190 KB).
const slimTrips = (f: TripUpdates): TripUpdates => ({
  entity: (f.entity ?? []).map(e => ({
    tripUpdate: {
      trip: {
        tripId: e.tripUpdate?.trip?.tripId,
        scheduleRelationship: e.tripUpdate?.trip?.scheduleRelationship,
      },
      delay: e.tripUpdate?.delay,
    },
  })),
});

export const isOffline = (err: unknown) => err instanceof TypeError;

type Feed<T> = { data: T; offlineSince: Date | null };

// Online: fetch and remember. No network: the last stored copy (offlineSince = when it was fetched).
async function fetchFeed<T>(
  name: string,
  query: string,
  slim: (raw: T) => T,
): Promise<Feed<T>> {
  const key = `madrid-transit:cache:rt:${name}`;
  try {
    const data = slim(await getJson<T>(`${base}rt.php?${query}`));
    saveJson(key, { at: Date.now(), data });
    return { data, offlineSince: null };
  } catch (err) {
    const c = loadJson<{ at: number; data: T } | null>(key, null);
    if (isOffline(err) && c) return { data: c.data, offlineSince: new Date(c.at) };
    throw err;
  }
}

export const fetchTripUpdates = () =>
  fetchFeed<TripUpdates>('trip_updates', 'f=trip_updates', slimTrips);
export const fetchAlerts = () => fetchFeed<AlertFeed>('alerts', 'f=alerts', f => f);

// CRTM stop times for a bus or light-rail stop (`par_8_16578` -> `8_16578`). rt.php caches for
// 60 s; the client memo does too, so re-renders and quick manual refreshes never refetch. The
// last copy per stop is kept for offline (evictable cache entries).
const CRTM_MEMO_MS = 60_000;
const crtmMemo = new Map<string, { at: number; p: Promise<Feed<CrtmJson>> }>();
export const fetchCrtm = (stopId: string) => {
  const code = stopId.replace(/^par_/, '');
  const hit = crtmMemo.get(code);
  if (hit && Date.now() - hit.at < CRTM_MEMO_MS) return hit.p;
  const p = fetchFeed<CrtmJson>(
    `crtm:${code}`,
    `f=crtm&stop=${encodeURIComponent(code)}`,
    f => f,
  );
  crtmMemo.set(code, { at: Date.now(), p });
  // Failures and offline copies are not memoised: the next refresh retries.
  p.then(
    f => f.offlineSince && crtmMemo.delete(code),
    () => crtmMemo.delete(code),
  );
  return p;
};
