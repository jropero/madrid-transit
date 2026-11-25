// Loading of the local timetable (public/data) and the live Renfe GTFS-RT feeds (via rt.php).
import { loadJson, saveJson } from './storage.ts';
import {
  assignDirections,
  isBus,
  stopDirections,
  type AlertFeed,
  type CrtmJson,
  type CrtmRow,
  type DaysFile,
  type RouteFile,
  type EmtJson,
  type StopFile,
  type RouteMap,
  type Stop,
  type StopTimeUpdate,
  type TripUpdates,
  isLiveStale,
  type FeedNote,
  type UpstreamError,
  type VehiclePositions,
  type VehicleStatus,
} from './gtfs.ts';

const base = import.meta.env.BASE_URL;

const getJson = async <T>(url: string): Promise<T> => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  return (await res.json()) as T;
};

// Live feeds give up after 12 s (CRTM answers in 0.4-8 s, erratically). The abort reason is a
// `TimeoutError`, which `isOffline` (TypeError only) does not mistake for a lost connection.
const LIVE_TIMEOUT_MS = 12_000;
export const isTimeout = (err: unknown) =>
  err instanceof DOMException && err.name === 'TimeoutError';

// `X-Data-Age` (rt.php): seconds since the cached upstream answer was fetched; absent = fresh.
const dataAgeMs = (res: Response) => {
  const secs = Number(res.headers.get('X-Data-Age'));
  return Number.isFinite(secs) && secs > 0 ? secs * 1000 : 0;
};

// A live feed failed: HTTP status (0 = none) and kind (timeout | network | http | invalid | html).
// `url` / `body` (first 2048 chars of the failing response) / `at` feed the status note details.
const BODY_MAX = 2048;
export class FeedError extends Error {
  readonly upstream: UpstreamError;
  readonly url: string;
  readonly body: string | undefined;
  readonly at = Date.now();
  constructor(upstream: UpstreamError, message: string, url: string, body?: string) {
    super(message);
    this.upstream = upstream;
    this.url = url;
    this.body = body?.slice(0, BODY_MAX);
  }
}

// `X-Upstream-Error: <code> <kind>` (rt.php): why its own upstream call failed.
const upstreamHeader = (res: Response): UpstreamError | undefined => {
  const m = /^(\d{1,3}) (timeout|network|http|invalid|html)$/.exec(
    res.headers.get('X-Upstream-Error') ?? '',
  );
  return m ? { code: Number(m[1]), kind: m[2] } : undefined;
};
console.assert(
  upstreamHeader(new Response('', { headers: { 'X-Upstream-Error': '200 html' } }))?.kind ===
    'html' && upstreamHeader(new Response(''))?.code === undefined,
  'upstreamHeader',
);

// The body of a successful response: JSON, or a FeedError of kind html / invalid (dev has no
// rt.php to check the upstream for us).
const readJson = async <T>(res: Response, url: string): Promise<T> => {
  const text = await res.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    const kind = text.trimStart().startsWith('<') ? 'html' : 'invalid';
    throw new FeedError(
      { code: res.status, kind },
      `invalid response (${kind}): ${url}`,
      url,
      text,
    );
  }
};

// What went wrong with a failed live fetch, for the second status line (offline: nothing).
export const upstreamOf = (err: unknown): UpstreamError | null => {
  if (err instanceof FeedError) return err.upstream;
  return isTimeout(err) ? { code: 0, kind: 'timeout' } : null;
};

// The status note of a failed live fetch (null when offline or not a feed failure).
export const errNoteOf = (label: string, err: unknown): FeedNote | null => {
  const e = upstreamOf(err);
  if (!e) return null;
  const f = err instanceof FeedError ? err : null;
  return { label, err: e, url: f?.url, body: f?.body, at: f?.at };
};

// The note of a feed that answered from an old copy because rt.php's upstream call failed.
export const feedNoteOf = (label: string, feed: Feed<unknown>): FeedNote | null =>
  feed.upstream ? { label, err: feed.upstream, url: feed.url } : null;

// What rt.php remembers about the last failure of a feed (`&why=1`); null when it has nothing
// (or the answer is not that shape, e.g. dev, which has no rt.php).
export type Why = { code: number; kind: string; at: number; body: string };
export async function fetchWhy(url: string): Promise<Why | null> {
  const res = await fetch(`${url}&why=1`);
  if (!res.ok) return null;
  const w = (await res.json()) as Partial<Why> | null;
  const ok =
    typeof w?.code === 'number' &&
    typeof w.kind === 'string' &&
    typeof w.at === 'number' &&
    typeof w.body === 'string';
  return ok ? (w as Why) : null;
}

const getLive = async <T>(
  url: string,
): Promise<{ data: T; fetchedAt: number; upstream?: UpstreamError }> => {
  const ctl = new AbortController();
  const timer = setTimeout(
    () => ctl.abort(new DOMException('no response', 'TimeoutError')),
    LIVE_TIMEOUT_MS,
  );
  try {
    const res = await fetch(url, { signal: ctl.signal });
    const upstream = upstreamHeader(res);
    if (!res.ok) {
      const e = upstream ?? { code: res.status, kind: 'http' };
      const body = await res.text().catch(() => '');
      throw new FeedError(e, `HTTP ${res.status}: ${url}`, url, body);
    }
    const fetchedAt = Date.now() - dataAgeMs(res);
    return { data: await readJson<T>(res, url), fetchedAt, upstream };
  } finally {
    clearTimeout(timer);
  }
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

// Stop id -> name over the full list (names of the next stops of a line).
const namesMemo = new Map<string, Promise<Map<string, string>>>();
export const loadStopNames = () =>
  memo(
    namesMemo,
    'all',
    async () => new Map((await loadAllStops()).map(s => [s.id, s.name] as const)),
  );

// Stop patterns of one route, loaded the first time its line is opened (the service worker
// keeps a copy for offline).
const routeMemo = new Map<string, Promise<RouteFile>>();
export const loadRoute = (routeId: string) =>
  memo(routeMemo, routeId, () =>
    getJson<RouteFile>(`${base}data/route/${encodeURIComponent(routeId)}.json`),
  );

const perStop = new Map<string, Promise<StopFile>>();
export const loadStopDeps = (id: string) =>
  memo(perStop, id, () => getJson<StopFile>(`${base}data/stop/${encodeURIComponent(id)}.json`));

const slimTimes = (t: StopTimeUpdate['arrival']) =>
  t ? { delay: t.delay, time: t.time } : undefined;
const slimStop = (u: StopTimeUpdate): StopTimeUpdate => ({
  stopId: u.stopId,
  arrival: slimTimes(u.arrival),
  departure: slimTimes(u.departure),
});

// Keep only what the app reads: the raw trip_updates feed covers all of Spain (~190 KB).
const slimTrips = (f: TripUpdates): TripUpdates => ({
  entity: (f.entity ?? []).map(e => ({
    tripUpdate: {
      trip: {
        tripId: e.tripUpdate?.trip?.tripId,
        scheduleRelationship: e.tripUpdate?.trip?.scheduleRelationship,
      },
      delay: e.tripUpdate?.delay,
      stopTimeUpdate: e.tripUpdate?.stopTimeUpdate?.map(slimStop),
    },
  })),
});

export const isOffline = (err: unknown) => err instanceof TypeError;

// fetchedAt: when the answer was fetched upstream (now minus X-Data-Age; the copy time offline).
// upstream: set when rt.php served an old copy because its own upstream call failed.
// stale: the copy is older than LIVE_MAX_AGE_MS, so `data` is the feed's empty value.
export type Feed<T> = {
  data: T;
  offlineSince: Date | null;
  fetchedAt: number;
  upstream?: UpstreamError;
  url?: string;
  stale?: boolean;
};

// Times, delays and positions of a too old copy are dropped (`empty` = a feed with no data);
// feeds without `empty` (alerts) are kept whatever their age.
const cutoff = <T>(feed: Feed<T>, empty: T | undefined): Feed<T> =>
  empty !== undefined && isLiveStale(feed.fetchedAt, Date.now())
    ? { ...feed, data: empty, offlineSince: null, stale: true }
    : feed;

// Online: fetch and remember. No network: the last stored copy (offlineSince = when it was fetched).
async function fetchFeed<T, R = T>(
  name: string,
  query: string,
  slim: (raw: R) => T,
  empty?: T,
): Promise<Feed<T>> {
  const key = `madrid-transit:cache:rt:${name}`;
  const url = `${base}rt.php?${query}`;
  try {
    const live = await getLive<R>(url);
    const data = slim(live.data);
    saveJson(key, { at: live.fetchedAt, data });
    return cutoff(
      { data, offlineSince: null, fetchedAt: live.fetchedAt, upstream: live.upstream, url },
      empty,
    );
  } catch (err) {
    const c = loadJson<{ at: number; data: T } | null>(key, null);
    if (isOffline(err) && c)
      return cutoff(
        { data: c.data, offlineSince: new Date(c.at), fetchedAt: c.at, url },
        empty,
      );
    throw err;
  }
}

const NO_TRIPS: TripUpdates = { entity: [] };
export const fetchTripUpdates = () =>
  fetchFeed<TripUpdates>('trip_updates', 'f=trip_updates', slimTrips, NO_TRIPS);
export const fetchTripUpdatesLd = () =>
  fetchFeed<TripUpdates>('trip_updates_LD', 'f=trip_updates_LD', slimTrips, NO_TRIPS);
// Train positions (follow view only), cut down to trip, stop, status and time.
type RawPositions = {
  entity?: {
    vehicle?: {
      trip?: { tripId?: string };
      stopId?: string;
      currentStatus?: VehicleStatus;
      timestamp?: string | number;
    };
  }[];
};
const slimPositions = (f: RawPositions): VehiclePositions => ({
  entity: (f.entity ?? []).map(e => ({
    vehicle: {
      tripId: e.vehicle?.trip?.tripId,
      stopId: e.vehicle?.stopId,
      status: e.vehicle?.currentStatus,
      timestamp: e.vehicle?.timestamp,
    },
  })),
});

const POSITIONS_MEMO_MS = 15_000;
const positionsMemo = new Map<boolean, { at: number; p: Promise<Feed<VehiclePositions>> }>();
export const fetchPositions = (ld: boolean) => {
  const hit = positionsMemo.get(ld);
  if (hit && Date.now() - hit.at < POSITIONS_MEMO_MS) return hit.p;
  const name = ld ? 'vehicle_positions_LD' : 'vehicle_positions';
  const p = fetchFeed<VehiclePositions, RawPositions>(name, `f=${name}`, slimPositions, {
    entity: [],
  });
  positionsMemo.set(ld, { at: Date.now(), p });
  // Failures and offline copies are not memoised: the next refresh retries.
  p.then(
    f => (f.offlineSince || f.stale) && positionsMemo.delete(ld),
    () => positionsMemo.delete(ld),
  );
  return p;
};

export const fetchAlerts = () => fetchFeed<AlertFeed>('alerts', 'f=alerts', f => f);

// CRTM stop times for a bus or light-rail stop (`par_8_16578` -> `8_16578`). rt.php caches for
// 60 s; the client memo does too, so re-renders and quick manual refreshes never refetch. The
// last copy per stop is kept for offline (evictable cache entries).
const CRTM_MEMO_MS = 30_000;
const crtmMemo = new Map<string, { at: number; p: Promise<Feed<CrtmJson>> }>();
export const fetchCrtm = (stopId: string) => {
  const code = stopId.replace(/^par_/, '');
  const hit = crtmMemo.get(code);
  if (hit && Date.now() - hit.at < CRTM_MEMO_MS) return hit.p;
  const p = fetchFeed<CrtmJson>(
    `crtm:${code}`,
    `f=crtm&stop=${encodeURIComponent(code)}`,
    f => f,
    {},
  );
  crtmMemo.set(code, { at: Date.now(), p });
  // Failures and offline copies are not memoised: the next refresh retries.
  p.then(
    f => (f.offlineSince || f.stale) && crtmMemo.delete(code),
    () => crtmMemo.delete(code),
  );
  return p;
};

// Live rows of a bus stop with the destination replaced by the timetable headsign of their
// direction. Only routes with several directions at the stop need their route file (patterns)
// and the stop names; on any failure the rows keep CRTM's text.
export async function directCrtm(
  rows: CrtmRow[],
  file: StopFile | null,
  stopId: string,
): Promise<CrtmRow[]> {
  if (!isBus(file)) return rows;
  const ids = [...new Set(rows.map(r => r.routeId))];
  const multi = ids.filter(id => stopDirections(file, id).length > 1);
  try {
    const [names, files] = await Promise.all([
      multi.length ? loadStopNames() : new Map<string, string>(),
      Promise.all(multi.map(loadRoute)),
    ]);
    const patterns = Object.fromEntries(multi.map((id, i) => [id, files[i].p]));
    return assignDirections(rows, file, stopId, patterns, id => names.get(id));
  } catch {
    return rows;
  }
}

// EMT arrivals (`emt_72` -> stop 72) through rt.php, which caches 30 s; same memo here. The last
// copy per stop is kept for offline (evictable cache entries).
const EMT_MEMO_MS = 30_000;
const emtMemo = new Map<string, { at: number; p: Promise<Feed<EmtJson>> }>();
export const fetchEmt = (stopId: string) => {
  const n = stopId.replace(/^emt_/, '');
  const hit = emtMemo.get(n);
  if (hit && Date.now() - hit.at < EMT_MEMO_MS) return hit.p;
  const p = fetchFeed<EmtJson>(`emt:${n}`, `f=emt&stop=${encodeURIComponent(n)}`, f => f, {});
  emtMemo.set(n, { at: Date.now(), p });
  p.then(
    f => (f.offlineSince || f.stale) && emtMemo.delete(n),
    () => emtMemo.delete(n),
  );
  return p;
};

// stopId -> routeIds serving it (all feeds), for the stop info panel; loaded on first use.
const stopLinesMemo = new Map<string, Promise<Record<string, string[]>>>();
export const loadStopLines = () =>
  memo(stopLinesMemo, 'all', () =>
    getJson<Record<string, string[]>>(`${base}data/stop-lines.json`),
  );

// Best-effort: load the files an offline session needs so they land in the service worker cache,
// one request at a time (stop files bypass the memo: the first one may predate the worker).
const quietly = (load: () => Promise<unknown>) => load().then(undefined, () => undefined);

export async function warmOffline(ids: string[]) {
  const seen = new Set<string>();
  await quietly(loadAllStops);
  await quietly(loadStopLines);
  for (const id of ids.filter(i => !i.startsWith('emt_') && !i.startsWith('par_4_'))) {
    const file = await getJson<StopFile>(
      `${base}data/stop/${encodeURIComponent(id)}.json`,
    ).then(
      f => f,
      () => null,
    );
    for (const r of file?.r ?? []) {
      if (seen.has(r)) continue;
      seen.add(r);
      await quietly(() => loadRoute(r));
    }
  }
}
