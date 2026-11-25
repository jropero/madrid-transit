// Shared logic: Madrid time, departures from the local timetable, GTFS-RT merging, alerts, stop search.
import { loadJson, saveJson } from './storage.ts';

// k: 'r' Renfe station, 'b' bus stop, 't' light rail / tram stop (both with its code and street, to tell the two sides of a road apart), 'm' Metro de Madrid station (live only, code = stop number), 'e' EMT city bus stop (live only, code = stop number).
export type Stop = {
  id: string;
  name: string;
  lat: number;
  lon: number;
  wa: boolean;
  k?: 'r' | 'b' | 't' | 'm' | 'e';
  code?: string;
  desc?: string;
  town?: string; // municipality (CRTM open data), empty when unknown
};
// tram: Metro Ligero / Tranvía de Parla route (timetable only, same stop-file shape as buses).
export type RouteInfo = {
  line: string;
  color: string;
  text: string;
  name?: string;
  tram?: boolean;
  metro?: boolean;
};
export type RouteMap = Record<string, RouteInfo>;
// updated: date of Renfe's zip (HTTP Last-Modified, else download date), yyyymmdd.
export type DaysFile = {
  from: string;
  to: string;
  updated?: string;
  days: Record<string, string[]>;
};
// Per-stop timetable file: route ids (r), destination stop ids (d) and, per service id, rows of
// [secs since service-day midnight (may exceed 24h), trip id minus the service-id prefix, r index, d index,
// pattern index into the route's route/<routeId>.json].
export type RenfeFile = {
  r: string[];
  d: string[];
  s: Record<string, [number, string, number, number, number?][]>;
};
// Bus stop file (timetable only): route ids (r), headsigns (h), calendars (c: weekday bitmask with
// bit 0 = Sunday, start and end yyyymmdd, added and removed yyyymmdd dates) and rows
// [secs since service-day midnight (may exceed 24h), c index, r index, h index, pattern index], sorted by secs.
export type BusCalendar = [number, number, number, number[], number[]];
export type BusFile = {
  kind: 'bus';
  r: string[];
  h: string[];
  c: BusCalendar[];
  d: [number, number, number, number, number?][];
};
export type StopFile = RenfeFile | BusFile;
export const isBus = (f: StopFile | null | undefined): f is BusFile =>
  !!f && 'kind' in f && f.kind === 'bus';

export type Departure = {
  tripId: string;
  routeId: string;
  line: string;
  color: string;
  text: string;
  dest: string; // Renfe: destination stop id; bus: headsign
  bus?: boolean; // timetable-only stop file (buses and light rail)
  tram?: boolean;
  emt?: boolean; // EMT city bus (live arrivals only)
  metro?: boolean; // Metro de Madrid (live arrivals only)
  planned: Date;
  expected: Date;
  cancelled: boolean;
  live: boolean; // from CRTM times or a GTFS-RT trip update, not the static timetable
  distM?: number; // EMT only: distance of the bus to the stop, metres
  pi?: number; // timetable rows: index of the trip's stop pattern in its route file
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

const PARTS_FORMAT = new Intl.DateTimeFormat('en-GB', {
  timeZone: MADRID,
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

const parts = (d: Date) => {
  const f = PARTS_FORMAT.formatToParts(d);
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
  file: RenfeFile,
  day: string,
  routes: RouteMap,
  now: Date,
  serviceId: string,
): Departure[] {
  const out: Departure[] = [];
  for (const [secs, suffix, ri, di, pi] of file.s[serviceId] ?? []) {
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
      pi,
      planned,
      expected: planned,
      cancelled: false,
      live: false,
    });
  }
  return out;
}

// Renfe: scheduled departures within [now - 15 min, now + 2 h], from today's and yesterday's service days
// (yesterday's trips run past midnight with secs >= 24h).
function renfeScheduled(
  file: RenfeFile,
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

// Does a bus calendar run on a service day (yyyymmdd)? Removed dates win over added ones, which
// win over the weekly pattern.
export function busActive(c: BusCalendar, day: string): boolean {
  const n = Number(day);
  if (c[4].includes(n)) return false;
  if (c[3].includes(n)) return true;
  const weekday = new Date(Date.UTC(+day.slice(0, 4), +day.slice(4, 6) - 1, +day.slice(6, 8)));
  return n >= c[1] && n <= c[2] && ((c[0] >> weekday.getUTCDay()) & 1) === 1;
}

// One service day's bus rows -> departures inside the window. Rows are prefiltered on seconds
// (with an hour of slack for DST days) so only a few reach the slower madridTime.
function busDay(file: BusFile, day: string, routes: RouteMap, now: Date): Departure[] {
  const midnight = madridTime(day, 0).getTime();
  const from = (now.getTime() - 15 * 60_000 - midnight) / 1000 - 3600;
  const to = (now.getTime() + HORIZON_MS - midnight) / 1000 + 3600;
  const active = file.c.map(c => busActive(c, day));
  const out: Departure[] = [];
  file.d.forEach(([secs, ci, ri, hsi, pi], i) => {
    const r = routes[file.r[ri]];
    if (secs < from || secs > to || !active[ci] || !r) return;
    const planned = madridTime(day, secs);
    if (!inWindow(planned.getTime(), now)) return;
    out.push({
      tripId: `${day}-${i}`,
      routeId: file.r[ri],
      line: r.line,
      color: r.color,
      text: r.text,
      dest: file.h[hsi],
      bus: true,
      tram: r.tram,
      pi,
      planned,
      expected: planned,
      cancelled: false,
      live: false,
    });
  });
  return out;
}

// Bus timetable only: no live data. Today's and yesterday's service days (> 24h times).
export function busScheduled(file: BusFile, routes: RouteMap, now: Date): Departure[] {
  const today = madridDate(now);
  return [shiftDay(today, -1), today]
    .flatMap(day => busDay(file, day, routes, now))
    .sort((a, b) => a.planned.getTime() - b.planned.getTime());
}

// Scheduled departures for either kind of stop file.
export const scheduled = (file: StopFile, days: DaysFile, routes: RouteMap, now: Date) =>
  isBus(file) ? busScheduled(file, routes, now) : renfeScheduled(file, days, routes, now);

// Self-checks: 2026-11-25 is a Wednesday, 2026-11-29 a Sunday; Madrid is UTC+1 in winter.
console.assert(
  (() => {
    const routes: RouteMap = { R: { line: '1', color: '#8EBF42', text: '#fff' } };
    const file = (c: BusCalendar, secs: number): BusFile => ({
      kind: 'bus',
      r: ['R'],
      h: ['X'],
      c: [c],
      d: [[secs, 0, 0, 0]],
    });
    const at = (iso: string) => new Date(iso);
    // Sunday-only service at 08:00: runs on Sunday 29th, not on Wednesday 25th.
    const sun = file([1, 20261101, 20271231, [], []], 8 * 3600);
    const sunOk =
      busScheduled(sun, routes, at('2026-11-29T06:50:00Z')).length === 1 &&
      busScheduled(sun, routes, at('2026-11-25T06:50:00Z')).length === 0;
    // Every day, but Wednesday 25th removed.
    const holiday = file([127, 20261101, 20271231, [], [20261125]], 8 * 3600);
    const removedOk =
      busScheduled(holiday, routes, at('2026-11-25T06:50:00Z')).length === 0 &&
      busScheduled(holiday, routes, at('2026-11-26T06:50:00Z')).length === 1;
    // 24:02 of the 25th is 00:02 on the 26th: shown just after midnight (23:30Z = 00:30 CET).
    const late = file([127, 20261101, 20271231, [], []], 24 * 3600 + 120);
    const lateDeps = busScheduled(late, routes, at('2026-11-25T23:10:00Z'));
    const lateOk =
      lateDeps.length === 1 && lateDeps[0].planned.toISOString() === '2026-11-25T23:02:00.000Z';
    // An added date outside the weekly pattern runs.
    const added = file([0, 20261101, 20271231, [20261125], []], 8 * 3600);
    const addedOk = busScheduled(added, routes, at('2026-11-25T06:50:00Z')).length === 1;
    return sunOk && removedOk && lateOk && addedOk;
  })(),
  'busScheduled: Sunday-only, removed date, 24:02 after midnight, added date',
);

// Light-rail routes use the bus stop-file shape: timetable only, flagged as trams for the label.
console.assert(
  (() => {
    const routes: RouteMap = { M: { line: 'ML4', color: '#7DB713', text: '#fff', tram: true } };
    const file: BusFile = {
      kind: 'bus',
      r: ['M'],
      h: ['X'],
      c: [[127, 20261101, 20271231, [], []]],
      d: [[8 * 3600, 0, 0, 0]],
    };
    const [d] = scheduled(
      file,
      { from: '', to: '', days: {} },
      routes,
      new Date('2026-11-25T06:50:00Z'),
    );
    return !!d && d.bus === true && d.tram === true;
  })(),
  'k t stops go through the timetable-only path and keep the tram flag',
);

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
      live: true,
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
      live: false,
    };
    const [a, b, c] = applyRealtime([d, { ...d, tripId: 't2' }, { ...d, tripId: 't3' }], {
      entity: [
        { tripUpdate: { trip: { tripId: 't1' }, delay: 120 } },
        { tripUpdate: { trip: { tripId: 't2', scheduleRelationship: 'CANCELED' } } },
      ],
    });
    return (
      a.expected.toISOString() === '2026-11-25T07:02:00.000Z' &&
      !a.cancelled &&
      b.cancelled &&
      a.live &&
      b.live &&
      !c.live
    );
  })(),
  'applyRealtime delay, cancellation and live flag',
);

// CRTM stop times (undocumented website endpoint, via rt.php). XML-to-JSON style: a single child
// is an object, several are an array, none is an empty object.
type One<T> = T | T[];
type CrtmLine = { codLine?: string; shortDescription?: string };
type CrtmTime = {
  line?: CrtmLine;
  destinationStop?: { name?: string };
  time?: string;
  codIssue?: string;
};
export type CrtmJson = {
  stopTimes?: {
    times?: { Time?: One<CrtmTime> };
    linesStatus?: { LineStatus?: One<{ line?: CrtmLine; SAEStatus?: boolean | string }> };
  };
};
export type CrtmRow = {
  when: Date;
  routeId: string;
  line: string;
  dest: string;
  tram: boolean;
  metro: boolean;
  issue: string;
};

const many = <T>(v: One<T> | undefined): T[] => {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
};

// Rows from CRTM, future only, in time order. Lines that report SAEStatus false (no live data
// for them) are dropped so the timetable keeps covering them.
export function parseCrtm(json: CrtmJson | null, now: Date): CrtmRow[] {
  const st = json?.stopTimes;
  const off = new Set(
    many(st?.linesStatus?.LineStatus)
      .filter(l => l.SAEStatus === false || l.SAEStatus === 'false')
      .map(l => l.line?.codLine),
  );
  const rows: CrtmRow[] = [];
  for (const t of many(st?.times?.Time)) {
    const routeId = t.line?.codLine ?? '';
    const when = new Date(t.time ?? '');
    if (!routeId || off.has(routeId) || !(when.getTime() >= now.getTime())) continue;
    rows.push({
      when,
      routeId,
      line: t.line?.shortDescription ?? routeId,
      dest: t.destinationStop?.name?.trim() ?? '',
      tram: routeId.startsWith('10__'),
      metro: routeId.startsWith('4__'),
      issue: t.codIssue ?? '',
    });
  }
  return rows.sort((a, b) => a.when.getTime() - b.when.getTime());
}

// Merge rule: a line present in the CRTM rows uses the CRTM times; lines absent from it keep
// their timetable departures. CRTM rows are limited to the usual 2 h window.
export function mergeCrtm(
  planned: Departure[],
  rows: CrtmRow[] | null,
  routes: RouteMap,
  now: Date,
): Departure[] {
  if (!rows?.length) return planned;
  const lines = new Set(rows.map(r => r.routeId));
  const live = rows
    .filter(r => r.when.getTime() <= now.getTime() + HORIZON_MS)
    .map((r, i): Departure => ({
      tripId: `crtm-${r.issue}-${r.routeId}-${i}`,
      routeId: r.routeId,
      line: routes[r.routeId]?.line ?? r.line,
      color: routes[r.routeId]?.color ?? '#555555',
      text: routes[r.routeId]?.text ?? '#ffffff',
      dest: r.dest,
      bus: true,
      tram: r.tram,
      metro: r.metro,
      planned: r.when,
      expected: r.when,
      cancelled: false,
      live: true,
    }));
  return [...planned.filter(d => !lines.has(d.routeId)), ...live].sort(
    (a, b) => a.expected.getTime() - b.expected.getTime(),
  );
}
console.assert(
  (() => {
    const now = new Date('2026-11-25T09:00:00Z');
    const t = (cod: string, time: string) => ({
      line: { codLine: cod, shortDescription: cod.slice(3, 6) },
      destinationStop: { name: 'X' },
      time,
    });
    const single = parseCrtm(
      { stopTimes: { times: { Time: t('8__461___', '2026-11-25T10:05:00+01:00') } } },
      now,
    );
    const array = parseCrtm(
      {
        stopTimes: {
          times: {
            Time: [
              t('8__461___', '2026-11-25T10:20:00+01:00'),
              t('8__461___', '2026-11-25T10:05:00+01:00'),
              t('8__462___', '2026-11-25T10:30:00+01:00'),
            ],
          },
          linesStatus: { LineStatus: { line: { codLine: '8__462___' }, SAEStatus: false } },
        },
      },
      now,
    );
    const empty = parseCrtm({ stopTimes: { times: {} } }, now);
    return (
      single.length === 1 &&
      single[0].when.toISOString() === '2026-11-25T09:05:00.000Z' &&
      array.length === 2 &&
      array[0].when.getTime() < array[1].when.getTime() &&
      empty.length === 0 &&
      parseCrtm(null, now).length === 0
    );
  })(),
  'parseCrtm: single object, array (sorted, SAE false dropped), empty {}',
);
console.assert(
  (() => {
    const now = new Date('2026-11-25T09:00:00Z');
    const dep = (routeId: string, iso: string): Departure => ({
      tripId: iso + routeId,
      routeId,
      line: routeId,
      color: '#000',
      text: '#fff',
      dest: 'H',
      bus: true,
      planned: new Date(iso),
      expected: new Date(iso),
      cancelled: false,
      live: false,
    });
    const row: CrtmRow = {
      when: new Date('2026-11-25T09:07:00Z'),
      routeId: 'A',
      line: 'A',
      dest: 'X',
      tram: false,
      metro: false,
      issue: '1',
    };
    const out = mergeCrtm(
      [dep('A', '2026-11-25T09:10:00Z'), dep('B', '2026-11-25T09:20:00Z')],
      [row],
      {},
      now,
    );
    return (
      out.length === 2 &&
      out[0].routeId === 'A' &&
      out[0].expected.toISOString() === '2026-11-25T09:07:00.000Z' &&
      out[0].live &&
      out[1].routeId === 'B' &&
      !out[1].live &&
      mergeCrtm([dep('B', '2026-11-25T09:20:00Z')], [], {}, now).length === 1
    );
  })(),
  'mergeCrtm: CRTM lines replace the timetable, other lines keep it',
);

// EMT MobilityLabs arrivals (via rt.php): code "00", rows at data[0].Arrive. estimateArrive is
// seconds (string or number); 999999 means no estimate (more than 45 min).
export type EmtJson = {
  code?: string;
  data?: {
    Incident?: {
      ListaIncident?: { data?: { guid?: string; title?: string; description?: string }[] };
    };
    Arrive?: {
      line?: string;
      destination?: string;
      estimateArrive?: string | number;
      DistanceBus?: string | number;
    }[];
  }[];
};
export type EmtRow = {
  when: Date;
  routeId: string;
  line: string;
  dest: string;
  distM?: number;
};
const NO_ESTIMATE = 999_999;

// Live rows in time order; entries without a line or a usable estimate are dropped.
export function parseEmt(json: EmtJson | null, now: Date): EmtRow[] {
  const arrive = json?.code === '00' ? json.data?.[0]?.Arrive : null;
  if (!Array.isArray(arrive)) return [];
  return arrive
    .map(a => ({
      line: a?.line?.trim() ?? '',
      dest: a?.destination?.trim() ?? '',
      s: Number(a?.estimateArrive),
      m: Number(a?.DistanceBus ?? NaN),
    }))
    .filter(a => a.line && Number.isFinite(a.s) && a.s >= 0 && a.s < NO_ESTIMATE)
    .map(a => ({
      when: new Date(now.getTime() + a.s * 1000),
      routeId: `emt_${a.line}`,
      line: a.line,
      dest: a.dest,
      ...(Number.isFinite(a.m) && a.m >= 0 ? { distM: a.m } : {}),
    }))
    .sort((a, b) => a.when.getTime() - b.when.getTime());
}

// Plain text of an HTML fragment, never through innerHTML: DOMParser textContent (scripts
// do not run and images load nothing in a parsed document), else tags stripped by regex.
const plainText = (html: string) => {
  const doc =
    typeof DOMParser === 'undefined'
      ? null
      : new DOMParser().parseFromString(html, 'text/html');
  const raw = doc ? (doc.body.textContent ?? '') : html.replace(/<[^>]*>/g, ' ');
  return raw.replace(/\s+/g, ' ').trim();
};

// Stop incidents from data[0].Incident.ListaIncident.data (deduplicated by guid); `Incident`
// may be {} or missing. Shown as alerts that apply to the whole stop (no route ids).
type EmtIncident = { guid?: string; title?: string; description?: string };
const toIncident = (i: EmtIncident | null | undefined): Alert | null => {
  const id = i?.guid?.trim();
  const text = [i?.title, i?.description && plainText(i.description)]
    .map(t => t?.trim() ?? '')
    .filter(Boolean)
    .join(' ');
  return id && text ? { id, routeIds: [], text, from: null } : null;
};

export function parseEmtIncidents(json: EmtJson | null): Alert[] {
  const list = json?.code === '00' ? json.data?.[0]?.Incident?.ListaIncident?.data : null;
  if (!Array.isArray(list)) return [];
  const byId = new Map<string, Alert>();
  for (const a of list.map(toIncident)) if (a && !byId.has(a.id)) byId.set(a.id, a);
  return [...byId.values()];
}
console.assert(
  (() => {
    const inc = {
      title: 'Evento Deportivo: Zona Bernabéu. Afectadas 4 líneas de EMT.',
      guid: 'CE371CE0-ECBC-4897-866F-4F1B681B28DE',
      description:
        "El 23 de noviembre  <b>hay</b> evento.<p><img src='http://x/y.png'></p>\n<p>Gracias</p>",
    };
    const out = parseEmtIncidents({
      code: '00',
      data: [{ Incident: { ListaIncident: { data: [inc, inc] } } }],
    });
    return (
      out.length === 1 &&
      out[0].id === inc.guid &&
      out[0].text ===
        'Evento Deportivo: Zona Bernabéu. Afectadas 4 líneas de EMT. El 23 de noviembre hay evento. Gracias' &&
      parseEmtIncidents({ code: '00', data: [{ Incident: {} }] }).length === 0 &&
      parseEmtIncidents({ code: '00', data: [{}] }).length === 0 &&
      parseEmtIncidents(null).length === 0
    );
  })(),
  'parseEmtIncidents: docs example (deduped, HTML to text, image dropped), empty Incident, missing',
);

// EMT rows as departures (tile colour from routes.json).
export const emtDepartures = (rows: EmtRow[], routes: RouteMap): Departure[] =>
  rows.map((r, i) => ({
    tripId: `emt-${r.routeId}-${i}`,
    routeId: r.routeId,
    line: r.line,
    color: routes[r.routeId]?.color ?? '#0178BC',
    text: routes[r.routeId]?.text ?? '#ffffff',
    dest: r.dest,
    bus: true,
    emt: true,
    planned: r.when,
    expected: r.when,
    cancelled: false,
    live: true,
    distM: r.distM,
  }));
console.assert(
  (() => {
    const now = new Date('2026-11-25T09:00:00Z');
    const a = (
      line: string,
      destination: string,
      estimateArrive: string | number,
      DistanceBus?: string | number,
    ) => ({ line, destination, estimateArrive, DistanceBus });
    const rows = parseEmt(
      {
        code: '00',
        data: [
          {
            Arrive: [
              a('27', 'PLAZA', '300', 146),
              a('28', 'PLAZA', '360', '1234'),
              a('29', 'PLAZA', '420'),
              a('', 'X', 60),
              a('5', 'Y', 999999),
              a('1', 'Z', 'x'),
            ],
          },
        ],
      },
      now,
    );
    return (
      rows.length === 3 &&
      rows[0].routeId === 'emt_27' &&
      rows[0].distM === 146 &&
      rows[1].distM === 1234 &&
      rows[2].distM === undefined &&
      rows[0].when.toISOString() === '2026-11-25T09:05:00.000Z' &&
      parseEmt({ code: '00', data: [{}] }, now).length === 0 &&
      parseEmt({ code: '80' }, now).length === 0 &&
      parseEmt(null, now).length === 0 &&
      parseEmt({ code: '00', data: [{ Arrive: 'x' as never }] }, now).length === 0 &&
      emtDepartures(rows, {})[0].live
    );
  })(),
  'parseEmt: normal, DistanceBus number/string/missing, no line, no estimate, malformed, empty and error responses',
);

// "146 m", or "1,2 km" from 1000 m (es-ES, one decimal).
export const fmtDist = (m: number) =>
  m < 1000
    ? `${Math.round(m)} m`
    : `${(m / 1000).toLocaleString('es-ES', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} km`;
console.assert(
  fmtDist(146) === '146 m' && fmtDist(1234) === '1,2 km',
  'fmtDist: metres below 1000, km with a comma above',
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

// Alerts without route ids (EMT stop incidents) apply to the whole stop.
export const alertsFor = (alerts: Alert[], routeIds: Set<string>) =>
  alerts.filter(a => !a.routeIds.length || a.routeIds.some(r => routeIds.has(r)));

const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
console.assert(fold('Chamartín') === 'chamartin', 'fold');

// Ranks a stop for a search: exact stop code, exact name ("Parla" the station beats the
// town's bus stops), name prefix or exact town, name substring, town substring, street;
// null = no match.
const rankWhole = (s: Stop, needle: string): number | null => {
  const name = fold(s.name);
  const town = fold(s.town ?? '');
  const hits = [
    s.code === needle,
    name === needle,
    name.startsWith(needle) || town === needle,
    name.includes(needle),
    town.includes(needle),
    fold(s.desc ?? '').includes(needle),
  ];
  const i = hits.indexOf(true);
  return i < 0 ? null : i;
};

// Several words ("parla tajo"): each must appear in the code, name, town or street.
const rank = (s: Stop, needle: string): number | null => {
  const whole = rankWhole(s, needle);
  if (whole !== null || !needle.includes(' ')) return whole;
  const hay = fold(`${s.code ?? ''} ${s.name} ${s.town ?? ''} ${s.desc ?? ''}`);
  return needle.split(' ').every(w => hay.includes(w)) ? 6 : null;
};

// Stops in a town: exact town name first, else any town containing the text.
const inTown = (stops: Stop[], town: string): Stop[] => {
  const t = fold(town.trim());
  if (!t) return stops;
  const exact = stops.filter(s => fold(s.town ?? '') === t);
  return exact.length ? exact : stops.filter(s => fold(s.town ?? '').includes(t));
};

const MODE_ORDER = 'rmtbe';
const modeIndex = (s: Stop) => {
  const i = MODE_ORDER.indexOf(s.k ?? 'b');
  return i < 0 ? MODE_ORDER.length : i;
};

// Train stations first, then metro, tram, bus; then by name.
const byModeName = (a: Stop, b: Stop) =>
  modeIndex(a) - modeIndex(b) || a.name.localeCompare(b.name, 'es');

// Town only: every stop in that town, trains, metro, trams, buses. Stop text: ranked matches (within the town).
export const searchStops = (stops: Stop[], q: string, town = ''): Stop[] => {
  const pool = inTown(stops, town);
  const needle = fold(q.trim()).replaceAll(/\s+/g, ' ');
  if (!needle) return town.trim() ? pool.toSorted(byModeName) : [];
  return pool
    .flatMap(s => {
      const r = rank(s, needle);
      return r === null ? [] : [{ s, r }];
    })
    .sort((a, b) => a.r - b.r || byModeName(a.s, b.s))
    .slice(0, 40)
    .map(x => x.s);
};
console.assert(
  searchStops(
    [
      { id: 'a', name: 'X Sol', lat: 0, lon: 0, wa: false },
      { id: 'b', name: 'Sol', lat: 0, lon: 0, wa: false },
    ],
    'sol',
  )[0].id === 'b',
  'searchStops ranks prefix matches first',
);
console.assert(
  (() => {
    const base = { lat: 0, lon: 0, wa: false };
    const found = searchStops(
      [
        { ...base, id: 'street', name: 'Z', desc: 'Calle Parla 1' },
        { ...base, id: 'town', name: 'Y', town: 'Parla' },
        { ...base, id: 'name', name: 'X Parla' },
        { ...base, id: 'prefix', name: 'Parlamento' },
        { ...base, id: 'code', name: 'W', code: 'parla' },
        { ...base, id: 'accent', name: 'V', town: 'Parlá' },
      ],
      'parla',
    ).map(s => s.id);
    return found.join() === 'code,prefix,accent,town,name,street';
  })(),
  'searchStops ranks code, prefix/exact town, substring, town, street',
);
console.assert(
  searchStops(
    [
      { id: 'a', name: 'RÍO TAJO-RÍO GUADARRAMA', town: 'Parla', lat: 0, lon: 0, wa: false },
      { id: 'b', name: 'RÍO TAJO', town: 'Toledo', lat: 0, lon: 0, wa: false },
    ],
    'parla  tajo',
  )
    .map(s => s.id)
    .join() === 'a',
  'searchStops matches every word across fields',
);
console.assert(
  (() => {
    const base = { lat: 0, lon: 0, wa: false };
    const stops = [
      { ...base, id: 'p2', name: 'Río Tajo', town: 'Parla' },
      { ...base, id: 'p1', name: 'Alfonso XIII', town: 'Parla' },
      { ...base, id: 't', name: 'Río Tajo', town: 'Toledo' },
    ];
    return (
      searchStops(stops, '', 'parla')
        .map(s => s.id)
        .join() === 'p1,p2' &&
      searchStops(stops, 'tajo', 'Parla')
        .map(s => s.id)
        .join() === 'p2'
    );
  })(),
  'searchStops filters by town',
);

console.assert(
  (() => {
    const base = { lat: 0, lon: 0, wa: false, town: 'Parla' };
    const buses = Array.from({ length: 60 }, (_, i) => ({
      ...base,
      id: `b${i}`,
      name: `Calle ${i}`,
      k: 'b' as const,
    }));
    const stops = [
      ...buses,
      { ...base, id: 'tram', name: 'Alfonso XIII', k: 't' as const },
      { ...base, id: 'bus', name: 'Zeta', k: 'b' as const },
      { ...base, id: 'rail', name: 'Parla', k: 'r' as const },
    ];
    const town = searchStops(stops, '', 'Parla').map(s => s.id);
    return (
      searchStops(stops, 'parla')[0].id === 'rail' &&
      town[0] === 'rail' &&
      town[1] === 'tram' &&
      town[2] === 'b0'
    );
  })(),
  'searchStops: exact name first, town listing orders r, t, b',
);

console.assert(
  (() => {
    const base = { lat: 0, lon: 0, wa: false };
    const stops = [
      { ...base, id: 'bus', name: 'Sol', k: 'b' as const },
      { ...base, id: 'metro', name: 'SOL', k: 'm' as const },
      { ...base, id: 'rail', name: 'Sol', k: 'r' as const },
    ];
    return (
      searchStops(stops, 'sol')
        .map(x => x.id)
        .join() === 'rail,metro,bus'
    );
  })(),
  'searchStops: same name orders Renfe, Metro, bus',
);
console.assert(
  parseCrtm(
    {
      stopTimes: {
        times: { Time: { line: { codLine: '4__1___' }, time: '2999-01-01T00:00:00Z' } },
      },
    },
    new Date(),
  )[0]?.metro === true,
  'parseCrtm flags Metro lines',
);

export const townsOf = (stops: Stop[]): string[] =>
  [...new Set(stops.flatMap(s => (s.town ? [s.town] : [])))].sort((a, b) =>
    a.localeCompare(b, 'es'),
  );

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
      return reject(new Error('ubicación no disponible en este navegador'));
    navigator.geolocation.getCurrentPosition(
      ({ coords }) => resolve({ lat: coords.latitude, lon: coords.longitude }),
      err => reject(new Error(`ubicación: ${err.message}`)),
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

// Stop patterns of one route (route/<routeId>.json): unique stop sequences, each a list of
// [stopId, offsetSecs from the first stop].
export type Pattern = [string, number][];
export type RouteFile = { p: Pattern[] };
export type StopTime = { id: string; at: Date };

const stopIndex = (p: Pattern, stopId: string) => p.findIndex(x => x[0] === stopId);
const stopsAfter = (p: Pattern, stopId: string) => {
  const i = stopIndex(p, stopId);
  return i < 0 ? 0 : p.length - 1 - i;
};

// Accent-insensitive, either name may contain the other ("PINAR DE CHAMARTIN" vs "Pinar de Chamartín").
const sameName = (a: string, b: string) => {
  const x = fold(a);
  const y = fold(b);
  return !!x && !!y && (x === y || x.includes(y) || y.includes(x));
};

// Pattern for live rows that carry no pattern index (Metro, EMT, CRTM): among the patterns that
// still have stops after `stopId`, the longest whose last stop is named like the destination,
// else the longest. Returns an index, or -1 when no pattern contains the stop.
export function pickPattern(
  patterns: Pattern[],
  stopId: string,
  dest: string,
  nameOf: (id: string) => string | undefined,
): number {
  const longest = (ok: (p: Pattern) => boolean) => {
    let best = -1;
    let most = 0;
    patterns.forEach((p, i) => {
      const n = stopsAfter(p, stopId);
      if (n > most && ok(p)) [best, most] = [i, n];
    });
    return best;
  };
  const named = dest ? longest(p => sameName(nameOf(p.at(-1)?.[0] ?? '') ?? '', dest)) : -1;
  return named >= 0 ? named : longest(() => true);
}

// The stops after `stopId` with estimated times: `at` is when the vehicle leaves `stopId`
// (planned, live or estimated), later stops add the pattern's offset difference.
export function nextStops(p: Pattern, stopId: string, at: Date): StopTime[] {
  const i = stopIndex(p, stopId);
  if (i < 0) return [];
  return p
    .slice(i + 1)
    .map(([id, off]) => ({ id, at: new Date(at.getTime() + (off - p[i][1]) * 1000) }));
}
console.assert(
  (() => {
    const long: Pattern = [
      ['a', 0],
      ['b', 60],
      ['c', 180],
      ['d', 300],
    ];
    const short: Pattern = [
      ['a', 0],
      ['b', 90],
      ['c', 200],
    ];
    const names: Record<string, string> = { c: 'Calle C', d: 'DÉ' };
    const nameOf = (id: string) => names[id];
    const t = nextStops(long, 'b', new Date('2026-11-25T09:00:00Z'));
    return (
      t.map(x => x.id).join() === 'c,d' &&
      t[0].at.toISOString() === '2026-11-25T09:02:00.000Z' &&
      t[1].at.toISOString() === '2026-11-25T09:04:00.000Z' &&
      nextStops(long, 'zz', new Date()).length === 0 &&
      pickPattern([short, long], 'a', 'de', nameOf) === 1 &&
      pickPattern([short, long], 'a', 'calle c', nameOf) === 0 &&
      pickPattern([short, long], 'a', 'nowhere', nameOf) === 1 &&
      pickPattern([short, long], 'd', '', nameOf) === -1 &&
      pickPattern([short, long], 'zz', '', nameOf) === -1
    );
  })(),
  'nextStops offsets, pickPattern: destination match, longest fallback, none',
);
