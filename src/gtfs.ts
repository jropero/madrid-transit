// Shared logic: Madrid time, departures from the local timetable, GTFS-RT merging, alerts, stop search.
import { loadJson, saveJson } from './storage.ts';

export type Stop = { id: string; name: string; lat: number; lon: number; wa: boolean };
export type RouteInfo = { line: string; color: string; text: string };
export type RouteMap = Record<string, RouteInfo>;
export type DaysFile = { from: string; to: string; days: Record<string, string[]> };
// Per-stop timetable file: route ids (r), destination stop ids (d) and, per service id, rows of
// [secs since service-day midnight (may exceed 24h), trip id minus the service-id prefix, r index, d index].
export type StopFile = {
  r: string[];
  d: string[];
  s: Record<string, [number, string, number, number][]>;
};

export type Departure = {
  tripId: string;
  routeId: string;
  line: string;
  color: string;
  text: string;
  dest: string;
  planned: Date;
  expected: Date;
  cancelled: boolean;
};

export type TripUpdates = {
  entity?: {
    tripUpdate?: {
      trip?: { tripId?: string; scheduleRelationship?: string };
      delay?: number;
    };
  }[];
};
export type Alert = { id: string; routeIds: string[]; text: string; from: Date | null };
export type AlertFeed = {
  entity?: {
    id?: string;
    alert?: {
      activePeriod?: { start?: string; end?: string }[];
      informedEntity?: { routeId?: string }[];
      descriptionText?: { translation?: { text?: string }[] };
      headerText?: { translation?: { text?: string }[] };
    };
  }[];
};

const MADRID = 'Europe/Madrid';
const HORIZON_MS = 2 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

const parts = (d: Date) => {
  const f = new Intl.DateTimeFormat('en-GB', {
    timeZone: MADRID,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(d);
  const get = (t: string) => Number(f.find(p => p.type === t)?.value);
  return {
    y: get('year'),
    mo: get('month'),
    d: get('day'),
    h: get('hour'),
    mi: get('minute'),
    s: get('second'),
  };
};

// Madrid's UTC offset (ms) at an instant.
const offsetMs = (d: Date) => {
  const p = parts(d);
  return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - Math.floor(d.getTime() / 1000) * 1000;
};

const pad = (n: number) => String(n).padStart(2, '0');
const ymdOf = (ms: number) => {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
};

// Madrid calendar date (yyyymmdd) of an instant.
export const madridDate = (d: Date) => {
  const p = parts(d);
  return `${p.y}${pad(p.mo)}${pad(p.d)}`;
};

// Service day yyyymmdd + seconds after its local midnight -> instant (DST-safe: the wall clock
// is mapped to UTC through the offset in force at the result).
export function madridTime(yyyymmdd: string, secs: number): Date {
  const wall =
    Date.UTC(+yyyymmdd.slice(0, 4), +yyyymmdd.slice(4, 6) - 1, +yyyymmdd.slice(6, 8)) +
    secs * 1000;
  let at = new Date(wall - offsetMs(new Date(wall)));
  at = new Date(wall - offsetMs(at));
  return at;
}
console.assert(
  madridTime('20261125', 8 * 3600).toISOString() === '2026-11-25T07:00:00.000Z',
  'madridTime winter (CET)',
);
console.assert(
  madridTime('20260715', 8 * 3600).toISOString() === '2026-07-15T06:00:00.000Z',
  'madridTime summer (CEST)',
);
console.assert(
  madridTime('20261125', 25 * 3600).toISOString() === '2026-11-26T00:00:00.000Z',
  'madridTime past 24h rolls into the next day',
);
console.assert(madridDate(new Date('2026-07-15T22:30:00Z')) === '20260716', 'madridDate');

const shiftDay = (yyyymmdd: string, days: number) =>
  ymdOf(
    Date.UTC(+yyyymmdd.slice(0, 4), +yyyymmdd.slice(4, 6) - 1, +yyyymmdd.slice(6, 8)) +
      days * DAY_MS,
  );
console.assert(shiftDay('20261231', 1) === '20270101', 'shiftDay');

// Trip ids lose their service-id prefix in the file ("!" marks one that never had it).
const tripId = (serviceId: string, suffix: string) =>
  suffix.startsWith('!') ? suffix.slice(1) : serviceId + suffix;
console.assert(tripId('1027M', '19799C1') === '1027M19799C1', 'tripId prefix');
console.assert(tripId('1027M', '!X1') === 'X1', 'tripId bang');

const inWindow = (t: number, now: Date) =>
  t >= now.getTime() - 15 * 60_000 && t <= now.getTime() + HORIZON_MS;

// One service day's rows for a stop -> departures inside the window.
function dayDepartures(
  file: StopFile,
  day: string,
  routes: RouteMap,
  now: Date,
  serviceId: string,
): Departure[] {
  const out: Departure[] = [];
  for (const [secs, suffix, ri, di] of file.s[serviceId] ?? []) {
    const planned = madridTime(day, secs);
    const routeId = file.r[ri];
    const r = routes[routeId];
    if (!r || !inWindow(planned.getTime(), now)) continue;
    out.push({
      tripId: tripId(serviceId, suffix),
      routeId,
      line: r.line,
      color: r.color,
      text: r.text,
      dest: file.d[di],
      planned,
      expected: planned,
      cancelled: false,
    });
  }
  return out;
}

// Scheduled departures within [now - 15 min, now + 2 h], from today's and yesterday's service days
// (yesterday's trips run past midnight with secs >= 24h).
export function scheduled(
  file: StopFile,
  days: DaysFile,
  routes: RouteMap,
  now: Date,
): Departure[] {
  const today = madridDate(now);
  return [shiftDay(today, -1), today]
    .flatMap(day =>
      (days.days[day] ?? []).flatMap(sid => dayDepartures(file, day, routes, now, sid)),
    )
    .sort((a, b) => a.planned.getTime() - b.planned.getTime());
}

// Trip-level delay (seconds) and cancellation from GTFS-RT; the feed covers all of Spain.
export function applyRealtime(deps: Departure[], feed: TripUpdates | null): Departure[] {
  if (!feed?.entity) return deps;
  const byTrip = new Map<string, { delay: number; cancelled: boolean }>();
  for (const e of feed.entity) {
    const id = e.tripUpdate?.trip?.tripId;
    if (!id) continue;
    byTrip.set(id, {
      delay: Number(e.tripUpdate?.delay) || 0,
      cancelled: e.tripUpdate?.trip?.scheduleRelationship === 'CANCELED',
    });
  }
  return deps.map(d => {
    const u = byTrip.get(d.tripId);
    if (!u) return d;
    return {
      ...d,
      expected: new Date(d.planned.getTime() + u.delay * 1000),
      cancelled: u.cancelled,
    };
  });
}
console.assert(
  (() => {
    const d: Departure = {
      tripId: 't1',
      routeId: '10T1',
      line: 'C1',
      color: '#000',
      text: '#fff',
      dest: '1',
      planned: new Date('2026-11-25T07:00:00Z'),
      expected: new Date('2026-11-25T07:00:00Z'),
      cancelled: false,
    };
    const [a, b] = applyRealtime([d, { ...d, tripId: 't2' }], {
      entity: [
        { tripUpdate: { trip: { tripId: 't1' }, delay: 120 } },
        { tripUpdate: { trip: { tripId: 't2', scheduleRelationship: 'CANCELED' } } },
      ],
    });
    return (
      a.expected.toISOString() === '2026-11-25T07:02:00.000Z' && !a.cancelled && b.cancelled
    );
  })(),
  'applyRealtime delay and cancellation',
);

// Departures still worth showing: not yet gone (30 s grace), within the horizon by plan.
export const upcoming = (deps: Departure[], now: number) =>
  deps.filter(d => d.expected.getTime() >= now - 30_000);

const isMadridRoute = (id: string) => id.startsWith('10T');
const firstText = (t?: { translation?: { text?: string }[] }) =>
  t?.translation?.[0]?.text?.trim() ?? '';

type AlertEntity = NonNullable<AlertFeed['entity']>[number];

function toAlert(e: AlertEntity, now: number): Alert | null {
  const a = e.alert;
  const routeIds = (a?.informedEntity ?? []).map(i => i.routeId ?? '').filter(isMadridRoute);
  const text = firstText(a?.descriptionText) || firstText(a?.headerText);
  const start = Number(a?.activePeriod?.[0]?.start) * 1000;
  const end = Number(a?.activePeriod?.[0]?.end) * 1000;
  const active = !(start > now) && !(end < now);
  if (!e.id || !routeIds.length || !text || !active) return null;
  return { id: e.id, routeIds, text, from: start ? new Date(start) : null };
}

// Active alerts that name a Madrid núcleo route (Spanish text as supplied).
export const parseAlerts = (feed: AlertFeed | null, now = Date.now()): Alert[] =>
  (feed?.entity ?? []).map(e => toAlert(e, now)).filter((a): a is Alert => a !== null);
console.assert(
  parseAlerts({
    entity: [
      {
        id: 'a',
        alert: {
          informedEntity: [{ routeId: '10T0005C2' }],
          descriptionText: { translation: [{ text: ' hola ' }] },
        },
      },
      {
        id: 'b',
        alert: {
          informedEntity: [{ routeId: '30T0001C1' }],
          headerText: { translation: [{ text: 'x' }] },
        },
      },
    ],
  }).length === 1,
  'parseAlerts keeps only 10T routes',
);

export const alertsFor = (alerts: Alert[], routeIds: Set<string>) =>
  alerts.filter(a => a.routeIds.some(r => routeIds.has(r)));

const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
console.assert(fold('Chamartín') === 'chamartin', 'fold');

// Accent-insensitive substring search over every word of the name.
export const searchStops = (stops: Stop[], q: string): Stop[] => {
  const needle = fold(q.trim());
  if (!needle) return [];
  return stops.filter(s => fold(s.name).includes(needle)).slice(0, 15);
};

// Equirectangular approximation: fine at city scale.
export const metres = (a: { lat: number; lon: number }, b: { lat: number; lon: number }) => {
  const k = 111_320;
  const x = (b.lon - a.lon) * k * Math.cos(((a.lat + b.lat) / 2) * (Math.PI / 180));
  return Math.round(Math.hypot(x, (b.lat - a.lat) * k));
};
// Atocha <-> Chamartín is roughly 6 km.
console.assert(
  Math.abs(metres({ lat: 40.4065, lon: -3.6893 }, { lat: 40.4723, lon: -3.6826 }) - 7300) < 400,
  'metres',
);

export type NearStop = Stop & { dist: number };
export const nearStops = (stops: Stop[], here: { lat: number; lon: number }): NearStop[] =>
  stops
    .map(s => ({ ...s, dist: metres(here, s) }))
    .filter(s => s.dist <= 3000)
    .sort((a, b) => a.dist - b.dist)
    .slice(0, 10);

export const locate = () =>
  new Promise<{ lat: number; lon: number }>((resolve, reject) => {
    if (!navigator.geolocation)
      return reject(new Error('location not available in this browser'));
    navigator.geolocation.getCurrentPosition(
      ({ coords }) => resolve({ lat: coords.latitude, lon: coords.longitude }),
      err => reject(new Error(`location: ${err.message}`)),
      { enableHighAccuracy: true, timeout: 10_000 },
    );
  });

// Saved stops: [{ id, name }].
export type Saved = { id: string; name: string };
const STOPS_KEY = 'madrid-transit:stops';
const DEFAULT_STOPS: Saved[] = [
  { id: '18000', name: 'Madrid-Atocha Cercanías' },
  { id: '18101', name: 'Sol' },
];
export const loadSaved = (): Saved[] => {
  const s = loadJson<Saved[]>(STOPS_KEY, DEFAULT_STOPS);
  return Array.isArray(s) && s.length ? s : DEFAULT_STOPS;
};
export const saveSaved = (stops: Saved[]) => saveJson(STOPS_KEY, stops);

export const hhmm = (d: Date) =>
  d.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', timeZone: MADRID });

// "20261224" -> "24.12."
export const ddmm = (yyyymmdd: string) => `${yyyymmdd.slice(6, 8)}.${yyyymmdd.slice(4, 6)}.`;
console.assert(ddmm('20261224') === '24.12.', 'ddmm');

export const daysUntil = (yyyymmdd: string, now: Date) =>
  Math.floor((madridTime(yyyymmdd, 0).getTime() - now.getTime()) / DAY_MS);
