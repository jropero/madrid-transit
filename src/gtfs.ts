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
  u?: boolean; // served only by town buses ("autobuses urbanos")
};
// tram: Metro Ligero / Tranvía de Parla route (timetable only, same stop-file shape as buses).
export type RouteInfo = {
  line: string;
  color: string;
  text: string;
  name?: string;
  tram?: boolean;
  metro?: boolean;
  urban?: boolean; // town bus (CRTM "Autobuses Urbanos")
  ld?: boolean; // media/larga distancia (Renfe AVE, AVLO, AVANT, Euromed, IC, MD; Ouigo)
  op?: string; // operator of a media/larga distancia route when not Renfe ('ouigo')
  svc?: Partial<Record<DayType, Svc>>; // EMT: service summary per day type
};
// [first HH:MM, last HH:MM, min headway (min), max headway (min)]
export type Svc = [string, string, number, number];
export type DayType = 'lab' | 'sab' | 'fes';
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
// ld: media/larga distancia rows `[secs, calendar index, r index, d index, pattern index, full trip id]`
// sorted by secs, with their own calendars (same shape as buses).
// Both kinds of row end with the origin index (into `o`) when the build has it.
export type LdRow = [number, number, number, number, number, string, number?];
// Trips that end at the stop: [arrival secs, calendar index, r index, o index, pattern index, trip id].
export type LdArrRow = [number, number, number, number, number, string];
export type RenfeFile = {
  r: string[];
  d: string[];
  o?: string[]; // origin stop ids
  s: Record<string, [number, string, number, number, number?, number?][]>;
  // Cercanías trips that end here: [arrival secs, trip id minus prefix, r index, o index, pattern index].
  a?: Record<string, [number, string, number, number, number?][]>;
  ld?: { c: BusCalendar[]; x: LdRow[]; a?: LdArrRow[] };
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
  t?: 1; // a trip ends here: llegadas board
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
  origins?: string[]; // arrivals: every origin of the coupled trains merged into this row
  origin?: string; // Renfe: the trip's first stop id (set on departure and arrival rows)
  bus?: boolean; // timetable-only stop file (buses and light rail)
  tram?: boolean;
  urban?: boolean; // town bus
  emt?: boolean; // EMT city bus (live arrivals only)
  metro?: boolean; // Metro de Madrid (live arrivals only)
  ld?: boolean; // Renfe media/larga distancia
  mode?: string; // tile caption (media/larga distancia: lowercase product name)
  planned: Date;
  expected: Date;
  cancelled: boolean;
  live: boolean; // from CRTM times or a GTFS-RT trip update, not the static timetable
  // A CRTM timetable time (no estimate) before a tracked bus of the same line and destination:
  // CRTM lost that bus, or the tracked one is it running late (shown as "no confirmado").
  unconfirmed?: boolean;
  estimated?: boolean; // projected from a live bus at an earlier stop (line scan), not live here
  estFrom?: string; // estimated rows: the stop id the live bus was seen at
  alsoEst?: Date; // live rows: the line scan's own estimate of this bus, when it differs by 2+ min
  distM?: number; // EMT only: distance of the bus to the stop, metres
  pi?: number; // timetable rows: index of the trip's stop pattern in its route file
  endStop?: string; // CRTM rows: the trip's last stop (`par_<code>`), to pick its pattern
  issue?: string; // CRTM rows: the trip id (`codIssue`), stable across stops: the same bus
};

// Per-stop update, slimmed to a delay (seconds) or an absolute time (unix seconds, a string).
export type StopTimeUpdate = {
  stopId?: string;
  arrival?: { delay?: number; time?: string | number };
  departure?: { delay?: number; time?: string | number };
};
export type TripUpdates = {
  entity?: {
    tripUpdate?: {
      trip?: { tripId?: string; scheduleRelationship?: string };
      delay?: number;
      stopTimeUpdate?: StopTimeUpdate[];
    };
  }[];
};
export type VehicleStatus = 'STOPPED_AT' | 'INCOMING_AT' | 'IN_TRANSIT_TO';
export type VehiclePosition = {
  tripId?: string;
  stopId?: string;
  status?: VehicleStatus;
  timestamp?: string | number;
};
export type VehiclePositions = { entity?: { vehicle?: VehiclePosition }[] };
export type Alert = {
  id: string;
  routeIds: string[];
  title: string;
  text: string;
  from: Date | null;
  to?: Date | null;
  // Optional "more info" link (http/https only).
  url?: string;
  // Short Spanish validity line (EMT incidents), '' or absent when unknown.
  when?: string;
};
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

const originOf = (file: RenfeFile, oi?: number) =>
  oi === undefined ? undefined : file.o?.[oi];

// One service day's rows for a stop -> departures inside the window.
function dayDepartures(
  file: RenfeFile,
  day: string,
  routes: RouteMap,
  now: Date,
  serviceId: string,
): Departure[] {
  const out: Departure[] = [];
  for (const [secs, suffix, ri, di, pi, oi] of file.s[serviceId] ?? []) {
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
      origin: originOf(file, oi),
      pi,
      planned,
      expected: planned,
      cancelled: false,
      live: false,
    });
  }
  return out;
}

// Window of seconds since a service day's midnight worth looking at (an hour of slack for DST days).
function secsWindow(day: string, now: Date) {
  const midnight = madridTime(day, 0).getTime();
  return {
    from: (now.getTime() - 15 * 60_000 - midnight) / 1000 - 3600,
    to: (now.getTime() + HORIZON_MS - midnight) / 1000 + 3600,
  };
}

// One service day's media/larga distancia rows -> departures inside the window.
export function ldDay(
  ld: NonNullable<RenfeFile['ld']>,
  file: RenfeFile,
  day: string,
  routes: RouteMap,
  now: Date,
): Departure[] {
  const { from, to } = secsWindow(day, now);
  const active = ld.c.map(c => busActive(c, day));
  const out: Departure[] = [];
  for (const [secs, ci, ri, di, pi, id, oi] of ld.x) {
    const routeId = file.r[ri];
    const r = routes[routeId];
    if (secs < from || secs > to || !active[ci] || !r) continue;
    const planned = madridTime(day, secs);
    if (!inWindow(planned.getTime(), now)) continue;
    out.push({
      tripId: id,
      routeId,
      line: r.line,
      color: r.color,
      text: r.text,
      dest: file.d[di],
      origin: originOf(file, oi),
      ld: true,
      mode: r.name?.toLowerCase(),
      pi,
      planned,
      expected: planned,
      cancelled: false,
      live: false,
    });
  }
  return out;
}
console.assert(
  (() => {
    const routes: RouteMap = { L: { line: 'AVE', color: '#000', text: '#fff', ld: true } };
    const file: RenfeFile = { r: ['L'], d: ['9'], s: {} };
    const wk = 0b0111110;
    const ld = {
      c: [
        [wk, 20260101, 20261231, [], [20261125]],
        [wk, 20260101, 20261231, [], []],
      ] as BusCalendar[],
      x: [
        [36000, 0, 0, 0, 0, 'A'],
        [36000, 1, 0, 0, 0, 'B'],
      ] as LdRow[],
    };
    // 2026-11-25 is a Wednesday: calendar 0 removes it, calendar 1 runs; 10:00 Madrid = 09:00Z.
    const now = new Date('2026-11-25T08:30:00Z');
    const out = ldDay(ld, file, '20261125', routes, now);
    return (
      out.length === 1 && out[0].tripId === 'B' && out[0].ld === true && out[0].dest === '9'
    );
  })(),
  'ldDay calendars and removed dates',
);

// Renfe: scheduled departures within [now - 15 min, now + 2 h], from today's and yesterday's service days
// (yesterday's trips run past midnight with secs >= 24h), plus media/larga distancia from the stop's
// own calendars when `ld` is on.
function renfeScheduled(
  file: RenfeFile,
  days: DaysFile,
  routes: RouteMap,
  now: Date,
  withLd = true,
): Departure[] {
  const today = madridDate(now);
  const ld = withLd ? file.ld : undefined;
  return [shiftDay(today, -1), today]
    .flatMap(day => [
      ...(days.days[day] ?? []).flatMap(sid => dayDepartures(file, day, routes, now, sid)),
      ...(ld ? ldDay(ld, file, day, routes, now) : []),
    ])
    .sort((a, b) => a.planned.getTime() - b.planned.getTime());
}

// One arrival row, whichever file it came from.
type ArrRow = { secs: number; ri: number; dest: string; origin?: string; pi?: number };

// Cercanías arrivals of one service day: passing trains (a departure row whose trip started
// elsewhere; the arrival time is taken as the departure time) and trips that end here (exact
// arrival time). Trips that start here are not arrivals.
function dayArrivals(
  file: RenfeFile,
  day: string,
  routes: RouteMap,
  now: Date,
  serviceId: string,
  stopId: string,
): Departure[] {
  const passing = (file.s[serviceId] ?? []).map(
    ([secs, suffix, ri, di, pi, oi]): [ArrRow, string] => [
      { secs, ri, dest: file.d[di], origin: originOf(file, oi), pi },
      suffix,
    ],
  );
  const ending = (file.a?.[serviceId] ?? []).map(
    ([secs, suffix, ri, oi, pi]): [ArrRow, string] => [
      { secs, ri, dest: stopId, origin: originOf(file, oi), pi },
      suffix,
    ],
  );
  return [...passing, ...ending].flatMap(([row, suffix]) => {
    const dep = arrivalDep(file, row, day, routes, now, stopId);
    return dep ? [{ ...dep, tripId: tripId(serviceId, suffix) }] : [];
  });
}

// A row -> departure-shaped arrival (tripId left to the caller); null when it starts here, has no
// known origin, is not on a known route or is outside the window.
function arrivalDep(
  file: RenfeFile,
  row: ArrRow,
  day: string,
  routes: RouteMap,
  now: Date,
  stopId: string,
): Departure | null {
  const routeId = file.r[row.ri];
  const r = routes[routeId];
  if (!r || !row.origin || row.origin === stopId) return null;
  const planned = madridTime(day, row.secs);
  if (!inWindow(planned.getTime(), now)) return null;
  return {
    tripId: '',
    routeId,
    line: r.line,
    color: r.color,
    text: r.text,
    dest: row.dest,
    origin: row.origin,
    pi: row.pi,
    planned,
    expected: planned,
    cancelled: false,
    live: false,
  };
}

// Media/larga distancia arrivals of one service day: passing rows (origin elsewhere) and the
// trips that end here.
function ldArrivals(
  ld: NonNullable<RenfeFile['ld']>,
  file: RenfeFile,
  day: string,
  routes: RouteMap,
  now: Date,
  stopId: string,
): Departure[] {
  const { from, to } = secsWindow(day, now);
  const active = ld.c.map(c => busActive(c, day));
  const passing = ld.x.map(([secs, ci, ri, di, pi, id, oi]): [ArrRow, number, string] => [
    { secs, ri, dest: file.d[di], origin: originOf(file, oi), pi },
    ci,
    id,
  ]);
  const ending = (ld.a ?? []).map(([secs, ci, ri, oi, pi, id]): [ArrRow, number, string] => [
    { secs, ri, dest: stopId, origin: originOf(file, oi), pi },
    ci,
    id,
  ]);
  return [...passing, ...ending].flatMap(([row, ci, id]) => {
    if (row.secs < from || row.secs > to || !active[ci]) return [];
    const dep = arrivalDep(file, row, day, routes, now, stopId);
    const r = routes[file.r[row.ri]];
    return dep ? [{ ...dep, tripId: id, ld: true, mode: r.name?.toLowerCase() }] : [];
  });
}

// Renfe arrivals within [now - 15 min, now + 2 h]: same days and window as `renfeScheduled`.
// `dest` is the trip's destination (this stop for trips that end here), `origin` its first stop.
export function renfeArrivals(
  file: RenfeFile,
  days: DaysFile,
  routes: RouteMap,
  now: Date,
  withLd: boolean,
  stopId: string,
): Departure[] {
  const today = madridDate(now);
  const ld = withLd ? file.ld : undefined;
  return [shiftDay(today, -1), today]
    .flatMap(day => [
      ...(days.days[day] ?? []).flatMap(sid =>
        dayArrivals(file, day, routes, now, sid, stopId),
      ),
      ...(ld ? ldArrivals(ld, file, day, routes, now, stopId) : []),
    ])
    .sort((a, b) => a.planned.getTime() - b.planned.getTime());
}
console.assert(
  (() => {
    const routes: RouteMap = {
      R: { line: 'C1', color: '#000', text: '#fff' },
      L: { line: 'AVE', color: '#000', text: '#fff', name: 'AVE', ld: true },
    };
    const file: RenfeFile = {
      r: ['R', 'L'],
      d: ['Z', 'HERE'],
      o: ['A', 'HERE'],
      // 10:00 passes (from A), 10:10 starts here (excluded).
      s: {
        S: [
          [36000, 'p1', 0, 0, 0, 0],
          [36600, 'h1', 0, 0, 0, 1],
        ],
      },
      a: { S: [[37200, 't1', 0, 0, 1]] }, // 10:20 ends here
      ld: {
        c: [[0b1111111, 20260101, 20261231, [], []]],
        x: [[38400, 0, 1, 0, 0, 'LP', 0]], // 10:40 passing
        a: [[39000, 0, 1, 0, 0, 'LT']], // 10:50 ends here
      },
    };
    const days: DaysFile = { from: '20260101', to: '20261231', days: { '20261125': ['S'] } };
    const now = new Date('2026-11-25T08:30:00Z'); // 09:30 Madrid
    const out = renfeArrivals(file, days, routes, now, true, 'HERE');
    const ids = out.map(d => d.tripId).join();
    const term = out.find(d => d.tripId === 'St1');
    return (
      ids === 'Sp1,St1,LP,LT' &&
      term?.dest === 'HERE' &&
      term.origin === 'A' &&
      out[0].dest === 'Z' &&
      out[3].ld === true &&
      renfeArrivals(file, days, routes, now, false, 'HERE').length === 2
    );
  })(),
  'renfeArrivals: passing and terminus rows in, rows starting here out',
);

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
  const { from, to } = secsWindow(day, now);
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
      urban: r.urban,
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
export const scheduled = (
  file: StopFile,
  days: DaysFile,
  routes: RouteMap,
  now: Date,
  withLd = true,
) =>
  isBus(file)
    ? busScheduled(file, routes, now)
    : renfeScheduled(file, days, routes, now, withLd);

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

// Order by expected time (planned plus delay, or the live time), ties by planned.
export const byExpected = (a: Departure, b: Departure) =>
  a.expected.getTime() - b.expected.getTime() || a.planned.getTime() - b.planned.getTime();

export type SortMode = 'line' | 'time';
// Anything but 'time' (including a missing or foreign stored value) means 'line'.
export const parseSort = (v: unknown): SortMode => (v === 'time' ? 'time' : 'line');

export const TIME_ROWS_MAX = 30;

// "Por hora": every departure in one list by expected time, capped (cancelled ones included).
export const timeOrdered = (deps: Departure[], max = TIME_ROWS_MAX) =>
  [...deps].sort(byExpected).slice(0, max);
console.assert(
  (() => {
    const mk = (t: number) => ({ expected: new Date(t), planned: new Date(t) }) as Departure;
    const out = timeOrdered([mk(3), mk(1), mk(2)], 2);
    return (
      out.length === 2 && out[0].expected.getTime() === 1 && out[1].expected.getTime() === 2
    );
  })() &&
    parseSort('time') === 'time' &&
    parseSort('x') === 'line' &&
    parseSort(null) === 'line',
  'timeOrdered sorts by expected time and caps; parseSort defaults to line',
);

// "Por hora" filter: only tracked rows (live or estimated), or everything.
export type TimeFilter = 'confirmed' | 'all';
export const parseTimeFilter = (v: unknown): TimeFilter => (v === 'all' ? 'all' : 'confirmed');

export const TIME_WINDOW_MS = 60 * 60_000;
export const inTimeWindow = (d: Departure, now: number) => {
  const t = d.expected.getTime();
  return t >= now - 60_000 && t <= now + TIME_WINDOW_MS;
};

// The "por hora" board: rows expected in [now - 1 min, now + 60 min], filtered, time-ordered, capped.
export const timeRows = (
  deps: Departure[],
  now: number,
  filter: TimeFilter,
  max = TIME_ROWS_MAX,
) =>
  timeOrdered(
    deps.filter(d => inTimeWindow(d, now) && (filter === 'all' || d.live || !!d.estimated)),
    max,
  );
console.assert(
  (() => {
    const now = Date.UTC(2026, 10, 27, 20, 0);
    const mk = (min: number, extra: Partial<Departure>) =>
      ({
        expected: new Date(now + min * 60_000),
        planned: new Date(now + min * 60_000),
        live: false,
        ...extra,
      }) as Departure;
    const deps = [
      mk(90, { live: true }),
      mk(-5, { live: true }),
      mk(30, {}),
      mk(20, { estimated: true }),
      mk(10, { live: true, cancelled: true }),
      mk(60, {}),
    ];
    const all = timeRows(deps, now, 'all');
    const conf = timeRows(deps, now, 'confirmed');
    return (
      all.length === 4 &&
      conf.length === 2 &&
      conf[0].live === true &&
      conf[1].estimated === true &&
      timeRows(deps, now, 'all', 1).length === 1 &&
      parseTimeFilter('all') === 'all' &&
      parseTimeFilter('x') === 'confirmed' &&
      parseTimeFilter(null) === 'confirmed'
    );
  })(),
  'timeRows: 60 min window, confirmed filter, cap; parseTimeFilter defaults to confirmed',
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
  const merged = deps.map(d => {
    const u = byTrip.get(d.tripId);
    if (!u) return d;
    return {
      ...d,
      expected: new Date(d.planned.getTime() + u.delay * 1000),
      cancelled: u.cancelled,
      live: true,
    };
  });
  return merged.sort(byExpected);
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
    const out = applyRealtime([d, { ...d, tripId: 't2' }, { ...d, tripId: 't3' }], {
      entity: [
        { tripUpdate: { trip: { tripId: 't1' }, delay: 120 } },
        { tripUpdate: { trip: { tripId: 't2', scheduleRelationship: 'CANCELED' } } },
      ],
    });
    // Result is ordered by expected time, so the delayed t1 comes last.
    const [b, c, a] = out;
    if (a.tripId !== 't1') return false;
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

export const isOuigo = (routeId: string) => routeId.startsWith('ouigo_');
console.assert(isOuigo('ouigo_R1') && !isOuigo('10T0005C2'), 'isOuigo');

// Renfe lists one physical train under several trip ids (variants, or two products at once).
// Among LD departures keep one per planned time + destination: the live one if any, else the
// first in current order. Other departures are untouched.
// `arrivals`: the kept row also lists every distinct origin of the rows it stands for (`origins`,
// in current order), since coupled twins share a destination but not an origin.
// Never merges rows of different operators (Ouigo routes are `ouigo_<id>`).
const ldKey = (d: Departure) =>
  `${d.planned.getTime()}|${d.dest}|${isOuigo(d.routeId) ? 'ouigo' : 'renfe'}`;

// Distinct origins per planned time + destination, in current order.
function originsByKey(deps: Departure[]) {
  const origins = new Map<string, string[]>();
  for (const d of deps) {
    const list = origins.get(ldKey(d)) ?? [];
    if (d.origin && !list.includes(d.origin)) list.push(d.origin);
    origins.set(ldKey(d), list);
  }
  return origins;
}

export function dedupeLd(deps: Departure[], arrivals = false): Departure[] {
  const best = new Map<string, Departure>();
  for (const d of deps) {
    const cur = best.get(ldKey(d));
    if (d.ld && (!cur || (d.live && !cur.live))) best.set(ldKey(d), d);
  }
  const origins = originsByKey(deps.filter(d => d.ld));
  return deps
    .filter(d => !d.ld || best.get(ldKey(d)) === d)
    .map(d => (arrivals && d.ld ? { ...d, origins: origins.get(ldKey(d)) } : d));
}
console.assert(
  (() => {
    const t = new Date('2026-11-25T19:35:00Z');
    const mk = (tripId: string, live: boolean, planned = t): Departure => ({
      tripId,
      routeId: 'L',
      line: 'IC',
      color: '#000',
      text: '#fff',
      dest: '9',
      ld: true,
      planned,
      expected: planned,
      cancelled: false,
      live,
    });
    const other = mk('Z', false, new Date('2026-11-25T20:35:00Z'));
    const out = dedupeLd([mk('002951', false), mk('002952', true), mk('37095', false), other]);
    const arr = dedupeLd(
      [
        { ...mk('A1', false), origin: 'X' },
        { ...mk('A2', true), origin: 'Y' },
        { ...mk('A3', false), origin: 'X' },
      ],
      true,
    );
    return (
      out.length === 2 &&
      out[0].tripId === '002952' &&
      out[1] === other &&
      arr.length === 1 &&
      arr[0].tripId === 'A2' &&
      arr[0].origins?.join() === 'X,Y'
    );
  })(),
  'dedupeLd keeps the live row and distinct times',
);
console.assert(
  (() => {
    const t = new Date('2026-11-25T19:35:00Z');
    const mk = (routeId: string): Departure => ({
      tripId: routeId,
      routeId,
      line: 'X',
      color: '#000',
      text: '#fff',
      dest: '9',
      ld: true,
      planned: t,
      expected: t,
      cancelled: false,
      live: false,
    });
    return dedupeLd([mk('AV1'), mk('ouigo_R1'), mk('AV2')]).length === 2;
  })(),
  'dedupeLd never merges Renfe and Ouigo rows',
);

// Long line labels (AVLO, AVANT, Euromed) get a smaller font to fit the tile: CSS class suffix.
export const tileSize = (line: string) => {
  if (line.length > 4) return ' xlong';
  return line.length === 4 ? ' long' : '';
};
console.assert(
  tileSize('C10') === '' && tileSize('AVLO') === ' long' && tileSize('Euromed') === ' xlong',
  'tileSize',
);

// CRTM stop times (undocumented website endpoint, via rt.php). XML-to-JSON style: a single child
// is an object, several are an array, none is an empty object.
type One<T> = T | T[];
type CrtmLine = { codLine?: string; shortDescription?: string };
type CrtmTime = {
  line?: CrtmLine;
  destination?: string; // "ORIGIN-TERMINUS" on arrival rows (`type=2`)
  destinationStop?: { name?: string; codStop?: string };
  time?: string;
  codIssue?: string;
};
export type CrtmJson = {
  stopTimes?: {
    actualDate?: string;
    times?: { Time?: One<CrtmTime> };
    linesStatus?: { LineStatus?: One<{ line?: CrtmLine; SAEStatus?: boolean | string }> };
  };
};
export type CrtmRow = {
  when: Date;
  routeId: string;
  line: string;
  dest: string; // CRTM's destination text, or the timetable headsign once a direction is assigned
  route?: string; // CRTM's `destination` text ("ORIGIN-TERMINUS"), used by the arrivals board
  code?: string; // CRTM code of the destination stop (`8_16578`), when given
  pi?: number; // route pattern of the assigned timetable direction (when it has just one)
  tram: boolean;
  metro: boolean;
  issue: string;
  scheduled?: boolean; // a bus time on the whole minute: CRTM's timetable, not an estimate
  estimated?: true; // projected from a live bus at an earlier stop of the line (line scan)
  from?: string; // estimated rows: the stop id the live bus was seen at
  arr?: true; // estimated rows: an arrivals estimate (llegadas board), not a departure one
  found?: number; // estimated rows: when the scan found the bus (ms epoch)
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
      route: t.destination?.trim() || undefined,
      code: t.destinationStop?.codStop?.trim() || undefined,
      tram: routeId.startsWith('10__'),
      metro: routeId.startsWith('4__'),
      issue: t.codIssue ?? '',
      scheduled: isCrtmScheduled(routeId, when),
    });
  }
  return dedupeCrtm(rows.sort((a, b) => a.when.getTime() - b.when.getTime()));
}

// Arrivals (`type=2`): CRTM's destination text is "ORIGIN-TERMINUS" (both with their town in
// brackets); the origin is what comes before the first "-", the whole text when there is none.
export const arrivalOrigin = (text: string) => {
  const i = text.indexOf('-');
  return (i < 0 ? text : text.slice(0, i)).trim();
};
// Arrival rows name their origin in `dest` (taken from `route`, CRTM's `destination`), so grouping by line + destination groups by origin.
export const arrivalRows = (rows: CrtmRow[]): CrtmRow[] =>
  rows.map(r => ({ ...r, dest: arrivalOrigin(r.route ?? r.dest) }));
console.assert(
  arrivalOrigin('POZUELO (Ciudad de la Imagen)-MADRID (Intercambiador Moncloa)') ===
    'POZUELO (Ciudad de la Imagen)' &&
    arrivalOrigin(' PARLA ') === 'PARLA' &&
    arrivalOrigin('A-B-C') === 'A',
  'arrivalOrigin: text before the first dash, trimmed',
);

// CRTM bus estimates carry seconds (14:50:56); a time on the whole minute is the timetable
// (stop 16578: 1@15:18:00 and 3@15:22:00 are exactly the GTFS runs). Seen on interurban (`8_`)
// and town (`9_`) buses only, so light rail, Metro and EMT rows stay live.
const isCrtmScheduled = (routeId: string, when: Date) =>
  /^[89]_/.test(routeId) && when.getUTCSeconds() === 0;
console.assert(
  isCrtmScheduled('8__461___', new Date('2026-11-26T15:18:00+01:00')) &&
    !isCrtmScheduled('8__461___', new Date('2026-11-26T15:34:32+01:00')) &&
    isCrtmScheduled('9__1__106_', new Date('2026-11-26T15:18:00+01:00')) &&
    !isCrtmScheduled('10__ML1___', new Date('2026-11-26T15:18:00+01:00')) &&
    !isCrtmScheduled('4__1___', new Date('2026-11-26T15:18:00+01:00')),
  'isCrtmScheduled: whole-minute bus times are the timetable',
);

// CRTM sometimes lists one bus twice under a minute apart (line 462 at 16578: 15:31:00 and
// 15:31:33). Same route and destination within 60 s -> one row, preferring a time with seconds
// (an estimate) over a whole minute (likely the schedule). `rows` sorted by time.
const DUPLICATE_MS = 60_000;
const hasSeconds = (r: CrtmRow) => r.when.getUTCSeconds() !== 0;
function dedupeCrtm(rows: CrtmRow[]): CrtmRow[] {
  const out: CrtmRow[] = [];
  for (const r of rows) {
    const i = out.findIndex(
      o =>
        o.routeId === r.routeId &&
        o.dest === r.dest &&
        r.when.getTime() - o.when.getTime() < DUPLICATE_MS,
    );
    if (i < 0) out.push(r);
    else if (!hasSeconds(out[i]) && hasSeconds(r)) out[i] = r;
  }
  return out.sort((a, b) => a.when.getTime() - b.when.getTime());
}

// Self-check fixture: a bare timetable departure.
const testDep = (routeId: string, iso: string): Departure => ({
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

const crtmDeparture = (r: CrtmRow, i: number, routes: RouteMap): Departure => ({
  tripId: `crtm-${r.issue}-${r.routeId}-${i}`,
  routeId: r.routeId,
  line: routes[r.routeId]?.line ?? r.line,
  color: routes[r.routeId]?.color ?? '#555555',
  text: routes[r.routeId]?.text ?? '#ffffff',
  dest: r.dest,
  pi: r.pi,
  issue: r.issue || undefined,
  endStop: r.code ? `par_${r.code}` : undefined,
  bus: true,
  tram: r.tram,
  urban: routes[r.routeId]?.urban,
  metro: r.metro,
  planned: r.when,
  expected: r.when,
  cancelled: false,
  // A whole-minute bus time still stands for (and replaces) its timetable run, but is not live.
  live: !r.scheduled && !r.estimated,
  estimated: r.estimated,
  estFrom: r.from,
});

// Replacement bucket of a live row: its route and, when its destination is the headsign of one of
// the route's timetable directions at this stop, that direction (else '' = the whole route).
const bucketOf = (r: CrtmRow, heads: Map<string, Set<string>>) =>
  `${r.routeId}|${heads.get(r.routeId)?.has(r.dest) ? r.dest : ''}`;

// Live times (ms, ascending) per bucket, for the rows inside the window.
function crtmSpans(rows: CrtmRow[], heads: Map<string, Set<string>>): Map<string, number[]> {
  const spans = new Map<string, number[]>();
  for (const r of rows) {
    const key = bucketOf(r, heads);
    spans.set(key, [...(spans.get(key) ?? []), r.when.getTime()]);
  }
  for (const times of spans.values()) times.sort((a, b) => a - b);
  return spans;
}

// A live row claims a timetable run at most this far from it; further away it is an extra bus.
const CLAIM_MAX_MS = 20 * 60_000;

// Live time -> timetable run pairs within CLAIM_MAX_MS, closest first (earlier run on a tie).
function claimPairs(rows: Departure[], live: number[]) {
  const pairs = live.flatMap((t, li) =>
    rows.map(d => ({ li, d, gap: Math.abs(d.planned.getTime() - t) })),
  );
  return pairs
    .filter(p => p.gap <= CLAIM_MAX_MS)
    .sort((a, b) => a.gap - b.gap || a.d.planned.getTime() - b.d.planned.getTime());
}

// Each live time claims at most one run and each run is claimed once, best matches first, so
// CRTM's own 16:00:00 takes the 16:00 run before an estimate of 15:55:35 can.
function claimedRuns(rows: Departure[], live: number[]): Set<Departure> {
  const claimed = new Set<Departure>();
  const used = new Set<number>();
  for (const { li, d } of claimPairs(rows, live)) {
    if (used.has(li) || claimed.has(d)) continue;
    used.add(li);
    claimed.add(d);
  }
  return claimed;
}

// CRTM times are rounded to the whole minute, so a live row at hh:mm stands for timetable
// times up to hh:mm:59.
const CRTM_PRECISION_MS = 59_000;

// Timetable rows of one covered route (and direction) that its live rows replace: everything
// planned up to the latest live time (gone, or running late as one of the live buses), plus
// the runs the live rows claim (claimedRuns: a bus 4 min early takes its own later slot instead
// of leaving it as a phantom departure; nothing further than CLAIM_MAX_MS away).
function replacedByLive(rows: Departure[], live: number[]): Departure[] {
  const last = live.at(-1) ?? -Infinity;
  const out = new Set(rows.filter(d => d.planned.getTime() <= last + CRTM_PRECISION_MS));
  return [...out, ...claimedRuns(rows, live)];
}

// Merge rule: a route is covered by CRTM only if it has a row in [now - 1 min, now + 2 h]. A
// covered route shows its live rows plus the timetable rows that no live row stands for (see
// replacedByLive); live rows whose `dest` is a timetable headsign of the route (see
// assignDirections) consume only the rows of that direction. Uncovered routes (including routes
// CRTM lists only far in the future) keep their whole timetable. There is deliberately no
// "timetable rows long before CRTM's first time survive" rule: it showed a live and a scheduled
// row for the same bus.
export function mergeCrtm(
  planned: Departure[],
  rows: CrtmRow[] | null,
  routes: RouteMap,
  now: Date,
): Departure[] {
  if (!rows?.length) return planned;
  const from = now.getTime() - 60_000;
  const to = now.getTime() + HORIZON_MS;
  const inWindow = rows.filter(r => r.when.getTime() >= from && r.when.getTime() <= to);
  const heads = new Map<string, Set<string>>();
  for (const d of planned)
    heads.set(d.routeId, (heads.get(d.routeId) ?? new Set()).add(d.dest));
  const dropped = new Set<Departure>();
  for (const [key, live] of crtmSpans(inWindow, heads)) {
    const [routeId, head] = key.split('|');
    const own = planned.filter(d => d.routeId === routeId && (!head || d.dest === head));
    for (const d of replacedByLive(own, live)) dropped.add(d);
  }
  const live = markUnconfirmed(
    dropTimetableTwin(inWindow.map((r, i) => crtmDeparture(r, i, routes))),
  );
  return [...planned.filter(d => !dropped.has(d)), ...live].sort(byExpected);
}

// Two rows are one bus when both carry a CRTM trip id and it is equal, two buses when both carry
// one and they differ; null when either has none (the time rules decide).
// Consecutive ids are one bus too: on a circular line (16578, line 1) the bus ending trip n goes on
// as trip n + 1 (a scan found estimates #810 / #811 beside CRTM's live #811 and timetable #853
// for #852).
const sameTrip = (a: string, b: string) =>
  a === b || (/^\d+$/.test(a) && /^\d+$/.test(b) && Math.abs(Number(a) - Number(b)) === 1);
const sameBus = (a: Departure, b: Departure): boolean | null =>
  a.issue && b.issue ? sameTrip(a.issue, b.issue) : null;

// CRTM lists one bus twice: its timetable time on the whole minute (id n) and the live one (id n
// +- 1), 4 min apart (16578, 462 getafe: 14:14:00 #…967 and live 14:18:16 #…966). The whole-minute
// row goes when a live row of the same route + destination is the same bus within 10 min.
function dropTimetableTwin(crtm: Departure[]): Departure[] {
  const twin = (d: Departure) =>
    !d.live &&
    crtm.some(
      o =>
        o.live &&
        o.routeId === d.routeId &&
        o.dest === d.dest &&
        sameBus(d, o) === true &&
        Math.abs(o.expected.getTime() - d.expected.getTime()) <= 10 * 60_000,
    );
  return crtm.filter(d => !twin(d));
}
console.assert(
  (() => {
    const at = (m: number) => new Date(Date.UTC(2026, 10, 27, 20, m));
    const row = (m: number, issue: string, live: boolean) =>
      ({ routeId: 'r', dest: 'X', expected: at(m), issue, live }) as Departure;
    const out = dropTimetableTwin([row(14, '967', false), row(18, '966', true)]);
    return (
      out.length === 1 &&
      out[0].live &&
      dropTimetableTwin([row(14, '967', false), row(18, '900', true)]).length === 2 &&
      dropTimetableTwin([row(0, '967', false), row(18, '966', true)]).length === 2
    );
  })(),
  'dropTimetableTwin',
);

// CRTM rows not live (timetable times) with a tracked bus of the same route and destination
// after them get `unconfirmed` (stop 16578, line 1 at 15:30: 15:39:00 before the tracked
// 15:55:35). A line-scan estimate is a tracked bus too (seen live at an earlier stop).
// A row whose trip id some tracked row carries is that bus, at whatever time: never "lost" (16578,
// 461: 00:07:00 #827 with the 23:53 estimate of #827 and a later estimate of #835).
const tracked = (d: Departure) => d.live || !!d.estimated;
function markUnconfirmed(crtm: Departure[]): Departure[] {
  const isTracked = (d: Departure) => crtm.some(o => tracked(o) && sameBus(d, o) === true);
  const trackedLater = (d: Departure) =>
    crtm.some(
      o =>
        tracked(o) &&
        o.routeId === d.routeId &&
        o.dest === d.dest &&
        o.expected > d.expected &&
        sameBus(d, o) !== true,
    );
  const lost = (d: Departure) => !tracked(d) && !isTracked(d) && trackedLater(d);
  return crtm.map(d => (lost(d) ? { ...d, unconfirmed: true } : d));
}
console.assert(
  (() => {
    const at = (m: number) => new Date(Date.UTC(2026, 10, 27, 20, m));
    const row = (m: number, extra: Partial<Departure>) =>
      ({ routeId: 'r', dest: 'X', expected: at(m), live: false, ...extra }) as Departure;
    const [sched, est, later] = markUnconfirmed([
      row(5, {}),
      row(16, { estimated: true }),
      row(30, {}),
    ]);
    return !!sched.unconfirmed && !est.unconfirmed && !later.unconfirmed;
  })(),
  'markUnconfirmed: timetable times before an estimate are unconfirmed',
);
console.assert(
  (() => {
    const at = (m: number) => new Date(Date.UTC(2026, 10, 27, 20, m));
    const row = (m: number, extra: Partial<Departure>) =>
      ({ routeId: 'r', dest: 'X', expected: at(m), live: false, ...extra }) as Departure;
    const [same, diff] = markUnconfirmed([
      row(5, { issue: '1' }),
      row(6, { issue: '9' }),
      row(16, { estimated: true, issue: '1' }),
    ]);
    // #1 tracked earlier (estimate at 3), a later estimate of #2: the 20 is still #1's.
    const [, mine] = markUnconfirmed([
      row(3, { estimated: true, issue: '1' }),
      row(20, { issue: '1' }),
      row(28, { estimated: true, issue: '9' }),
    ]);
    return !same.unconfirmed && !!diff.unconfirmed && !mine.unconfirmed;
  })(),
  'markUnconfirmed: the same trip id is not unconfirmed, another one is',
);

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
    const t = (cod: string, time: string, dest = 'X') => ({
      line: { codLine: cod, shortDescription: cod },
      destinationStop: { name: dest },
      time,
    });
    const rows = parseCrtm(
      {
        stopTimes: {
          times: {
            Time: [
              t('A', '2026-11-26T15:31:00+01:00'),
              t('A', '2026-11-26T15:31:33+01:00'),
              t('B', '2026-11-26T15:31:10+01:00'),
              t('A', '2026-11-26T15:31:20+01:00', 'Y'),
              t('A', '2026-11-26T15:33:00+01:00'),
            ],
          },
        },
      },
      new Date('2026-11-26T14:00:00Z'),
    );
    const show = rows.map(r => `${r.routeId}${r.dest}${r.when.toISOString().slice(14, 19)}`);
    return show.join(' ') === 'BX31:10 AY31:20 AX31:33 AX33:00';
  })(),
  'parseCrtm: one bus listed twice under a minute apart becomes one row (the estimate)',
);
console.assert(
  (() => {
    const now = new Date('2026-11-25T09:00:00Z');
    const dep = (routeId: string, iso: string) => testDep(routeId, iso);
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
      [dep('A', '2026-11-25T09:05:00Z'), dep('B', '2026-11-25T09:20:00Z')],
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
      mergeCrtm([dep('B', '2026-11-25T09:20:00Z')], [], {}, now).length === 1 &&
      mergeCrtm([dep('B', '2026-11-25T09:20:00Z')], null, {}, now).length === 1
    );
  })(),
  'mergeCrtm: CRTM lines replace the timetable, other lines keep it, empty/null rows',
);
console.assert(
  (() => {
    const now = new Date('2026-11-25T14:35:00Z');
    const dep = (iso: string, routeId = 'A') => testDep(routeId, iso);
    const row = (iso: string): CrtmRow => ({
      when: new Date(iso),
      routeId: 'A',
      line: 'A',
      dest: 'X',
      tram: false,
      metro: false,
      issue: '1',
    });
    const at = (h: string) => `2026-11-25T${h}Z`;
    const plan = (...hs: string[]) => hs.map(h => dep(at(h)));
    const show = (out: Departure[]) =>
      out.map(d => `${d.expected.toISOString().slice(11, 16)}${d.live ? 'L' : ''}`).join(' ');
    // (a) live 14:48:20 replaces the 14:48 timetable row.
    const a = mergeCrtm(plan('14:48:00'), [row(at('14:48:20'))], {}, now);
    // (b) a bus scheduled 14:30 runs 22 min late: its slot (and 14:45) goes, 15:00 stays.
    const b = mergeCrtm(
      plan('14:30:00', '14:45:00', '15:00:00'),
      [row(at('14:52:00'))],
      {},
      now,
    );
    // (c) two live buses consume 14:40 (<= last live) and the next slot 14:55.
    const c = mergeCrtm(
      plan('14:40:00', '14:55:00', '15:10:00'),
      [row(at('14:40:00')), row(at('14:41:00'))],
      {},
      now,
    );
    // (d) 07827 case: one far-future CRTM row leaves the whole timetable in place.
    const d = mergeCrtm(plan('14:40:00', '15:10:00'), [row(at('22:34:00'))], {}, now);
    // Another route stays untouched.
    const e = mergeCrtm([dep(at('14:50:00'), 'B')], [row(at('14:52:00'))], {}, now);
    // (g) stop 16578, line 1 at 15:30: the CRTM timetable time 15:39 before the tracked 15:55
    // is unconfirmed; 16:00 (after it) and other lines are not.
    const sched = (h: string, routeId = 'A'): CrtmRow => ({
      ...row(at(h)),
      routeId,
      issue: `s${h}${routeId}`, // its own trip, not the live row's
      scheduled: true,
    });
    const g = mergeCrtm(
      [],
      [sched('15:39:00'), row(at('15:55:35')), sched('16:00:00'), sched('15:40:00', 'B')],
      {},
      new Date(at('15:30:00')),
    );
    const flags = g.map(
      d => `${d.expected.toISOString().slice(11, 16)}${d.unconfirmed ? '?' : ''}`,
    );
    // (h) same moment with the timetable: 15:39 and 16:00 are CRTM's own, the 15:55 estimate is
    // an extra bus (no run within 20 min left), so the 16:21 run stays.
    const h = mergeCrtm(
      plan('15:39:00', '16:00:00', '16:21:00'),
      [sched('15:39:00'), row(at('15:55:35')), sched('16:00:00')],
      {},
      new Date(at('15:30:00')),
    );
    // (f) stop 16578, line 1 at 14:46: live 14:54 is the 14:58 bus early, not the 14:38 one 16 min
    // late; no phantom 14:58 is left (14:38 is past the last live time and goes too).
    const f = mergeCrtm(
      plan('14:38:00', '14:58:00', '15:18:00'),
      [row(at('14:54:05'))],
      {},
      new Date(at('14:46:00')),
    );
    return (
      show(a) === '14:48L' &&
      show(b) === '14:52L 15:00' &&
      show(c) === '14:40L 14:41L 15:10' &&
      show(d) === '14:40 15:10' &&
      show(e) === '14:50 14:52L' &&
      show(f) === '14:54L 15:18' &&
      flags.join(' ') === '15:39? 15:40 15:55 16:00' &&
      show(h) === '15:39 15:55L 16:00 16:21'
    );
  })(),
  'mergeCrtm: live rows replace their timetable slots (late, early, nearest, several), far-future keeps it, unconfirmed marks',
);
console.assert(
  (() => {
    const now = new Date('2026-11-25T15:02:00Z');
    const at = (h: string) => `2026-11-25T${h}Z`;
    const row = (h: string): CrtmRow => ({
      when: new Date(at(h)),
      routeId: '461',
      line: '461',
      dest: 'X',
      tram: false,
      metro: false,
      issue: '1',
    });
    // Minute-rounded live 15:06 and 15:15 replace the 15:06:20 and 15:15:30 timetable rows.
    const out = mergeCrtm(
      [
        testDep('461', at('15:06:20')),
        testDep('461', at('15:15:30')),
        testDep('461', at('15:24:10')),
      ],
      [row('15:06:00'), row('15:15:00')],
      {},
      now,
    );
    return (
      out
        .map(d => `${d.expected.toISOString().slice(11, 16)}${d.live ? 'L' : ''}`)
        .join(' ') === '15:06L 15:15L 15:24'
    );
  })(),
  'mergeCrtm: minute-rounded live times replace timetable rows with seconds in the same minute',
);

// EMT MobilityLabs arrivals (via rt.php): code "00", rows at data[0].Arrive. estimateArrive is
// seconds (string or number); 999999 means no estimate (more than 45 min).
export type EmtJson = {
  code?: string;
  data?: {
    Incident?: {
      ListaIncident?: { data?: EmtIncident[] };
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

// CRTM network-6 (EMT) rows use `6__21___`; routes.json and route files key them `emt_21`. The
// short name is used as is ('001' and '1' are distinct EMT lines), else the id is unwrapped.
export const emtRouteId = (codLine: string, short?: string) =>
  `emt_${short?.trim() || codLine.replace(/^6__/, '').replace(/_+$/, '')}`;

export const emtFromCrtm = (rows: CrtmRow[]): CrtmRow[] =>
  rows.map(r =>
    r.routeId.startsWith('6__')
      ? { ...r, routeId: emtRouteId(r.routeId, r.line === r.routeId ? '' : r.line) }
      : r,
  );
console.assert(
  (() => {
    const r = (routeId: string, line: string) => ({ routeId, line }) as CrtmRow;
    const out = emtFromCrtm([
      r('6__21___', '21'),
      r('6__C03___', '6__C03___'),
      r('6__001___', '001'),
      r('8__1___', '1'),
    ]);
    return (
      out[0].routeId === 'emt_21' &&
      out[1].routeId === 'emt_C03' &&
      emtRouteId('6__C03___') === 'emt_C03' &&
      out[2].routeId === 'emt_001' &&
      emtRouteId('6__001___') === 'emt_001' &&
      emtRouteId('6__1___') === 'emt_1' &&
      out[3].routeId === '8__1___'
    );
  })(),
  'emtFromCrtm: 6__21___ -> emt_21, 6__C03___ -> emt_C03, leading zeros kept, other networks untouched',
);

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

// EMT validity stamps ("25/11/2026 11:30:00", "28/10/2026 6:30:00") are Madrid wall-clock time.
// Unparseable -> null (unknown).
const EMT_STAMP = /^(\d{1,2})\/(\d{1,2})\/(\d{4}) (\d{1,2}):(\d{2})(?::(\d{2}))?$/;
export function parseEmtStamp(s: string | undefined): Date | null {
  const m = EMT_STAMP.exec(s?.trim() ?? '');
  if (!m) return null;
  const [d, mo, h, mi, sec] = [+m[1], +m[2], +m[4], +m[5], +(m[6] ?? 0)];
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || sec > 59) return null;
  return madridTime(`${m[3]}${pad(mo)}${pad(d)}`, h * 3600 + mi * 60 + sec);
}

// Whether a validity window is worth showing: not over, and starting within 24 h.
const incidentLive = (from: Date | null, to: Date | null, now: Date) =>
  (!to || to.getTime() > now.getTime()) && (!from || from.getTime() <= now.getTime() + DAY_MS);

// Stop incidents from data[0].Incident.ListaIncident.data (deduplicated by guid and by text);
// `Incident` may be {} or missing. Shown as alerts that apply to the whole stop (no route ids).
// Expired incidents are dropped; ones starting more than 24 h from now stay hidden.
type EmtIncident = {
  guid?: string;
  title?: string;
  description?: string;
  rssFrom?: string;
  rssTo?: string;
  moreInfo?: { '@url'?: string };
};
const safeUrl = (u?: string) => (u && /^https?:\/\//i.test(u.trim()) ? u.trim() : undefined);
const toIncident = (i: EmtIncident | null | undefined): Alert | null => {
  const id = i?.guid?.trim();
  const title = i?.title?.trim() ?? '';
  const text = [title, i?.description && plainText(i.description)]
    .map(t => t?.trim() ?? '')
    .filter(Boolean)
    .join(' ');
  if (!id || !text) return null;
  const url = safeUrl(i?.moreInfo?.['@url']);
  const from = parseEmtStamp(i?.rssFrom);
  const to = parseEmtStamp(i?.rssTo);
  return { id, routeIds: [], title: title || text, text, from, to, ...(url ? { url } : {}) };
};
const textKey = (a: Alert) => a.text.toLowerCase().replace(/\s+/g, ' ');

export function parseEmtIncidents(json: EmtJson | null, now: Date): Alert[] {
  const list = json?.code === '00' ? json.data?.[0]?.Incident?.ListaIncident?.data : null;
  if (!Array.isArray(list)) return [];
  const seen = new Set<string>();
  const fresh = (a: Alert) => {
    const keys = [`id:${a.id}`, `text:${textKey(a)}`];
    const dup = keys.some(k => seen.has(k));
    keys.forEach(k => seen.add(k));
    return !dup;
  };
  return list
    .map(toIncident)
    .filter((a): a is Alert => a !== null && fresh(a))
    .filter(a => incidentLive(a.from, a.to ?? null, now))
    .map(a => ({ ...a, when: validityLine(a, now) }));
}

// Incidents of several EMT stops as one list: the same id or text counts once, with every
// stop label it was seen at (in the order given).
export function mergeIncidents(
  perStop: { stop: string; alerts: Alert[] }[],
): { alert: Alert; seen: string[] }[] {
  const byKey = new Map<string, { alert: Alert; seen: string[] }>();
  const out: { alert: Alert; seen: string[] }[] = [];
  const add = (stop: string, alert: Alert) => {
    const keys = [`id:${alert.id}`, `text:${textKey(alert)}`];
    const entry = keys.map(k => byKey.get(k)).find(Boolean) ?? { alert, seen: [] };
    if (!out.includes(entry)) out.push(entry);
    if (!entry.seen.includes(stop)) entry.seen.push(stop);
    keys.forEach(k => byKey.set(k, entry));
  };
  perStop.forEach(({ stop, alerts }) => alerts.forEach(a => add(stop, a)));
  return out;
}
console.assert(
  (() => {
    const al = (id: string, text: string): Alert => ({
      id,
      routeIds: [],
      title: text,
      text,
      from: null,
    });
    const m = mergeIncidents([
      { stop: 'A', alerts: [al('1', 'Obras  en la calle')] },
      { stop: 'B', alerts: [al('2', 'obras en la calle'), al('3', 'otro')] },
      { stop: 'C', alerts: [al('1', 'x')] },
    ]);
    return m.length === 2 && m[0].seen.join() === 'A,B,C' && m[1].seen.join() === 'B';
  })(),
  'mergeIncidents dedupes by id and text',
);

const dm = (d: Date) => {
  const p = parts(d);
  return `${p.d}/${pad(p.mo)}`;
};
const hm = (d: Date) => {
  const p = parts(d);
  return `${pad(p.h)}:${pad(p.mi)}`;
};
const stamp = (d: Date) => `${dm(d)} ${hm(d)}`;

// Short Spanish validity line for an alert ('' when no dates): "25/11 11:30–15:00",
// "desde 27/11 17:00" for an upcoming one, "hasta 25/11 15:00" when only the end is known.
const range = (from: Date, to: Date) =>
  dm(from) === dm(to) ? `${dm(from)} ${hm(from)}–${hm(to)}` : `${stamp(from)}–${stamp(to)}`;
export function validityLine(a: Alert, now: Date): string {
  const { from, to = null } = a;
  if (from && to) return range(from, to);
  if (!from) return to ? `hasta ${stamp(to)}` : '';
  return from.getTime() > now.getTime() ? `desde ${stamp(from)}` : '';
}
console.assert(
  (() => {
    const now = new Date('2026-11-25T14:23:00Z'); // 15:23 Madrid
    const stampOf = (h: number, d = 0) => {
      const t = new Date(now.getTime() + h * 3600_000 + d * DAY_MS);
      const p = parts(t);
      return `${p.d}/${p.mo}/${p.y} ${p.h}:${pad(p.mi)}:00`;
    };
    const mk = (guid: string, rssFrom: string, rssTo: string, description = guid) => ({
      guid,
      title: 'Aviso',
      description,
      rssFrom,
      rssTo,
    });
    const ids = (list: EmtIncident[]) =>
      parseEmtIncidents(
        { code: '00', data: [{ Incident: { ListaIncident: { data: list } } }] },
        now,
      )
        .map(a => a.id)
        .join();
    const six = parseEmtStamp('28/10/2026 6:30:00');
    const act = parseEmtStamp('25/11/2026 11:30:00');
    const out = parseEmtIncidents(
      {
        code: '00',
        data: [
          {
            Incident: {
              ListaIncident: { data: [mk('a', '25/11/2026 11:30:00', '25/11/2026 15:00:00')] },
            },
          },
        ],
      },
      now,
    );
    return (
      ids([mk('old', stampOf(-30), stampOf(-24))]) === '' &&
      ids([mk('on', stampOf(-3), stampOf(5))]) === 'on' &&
      ids([mk('far', stampOf(48), stampOf(60))]) === '' &&
      ids([mk('soon', stampOf(3), stampOf(9))]) === 'soon' &&
      ids([mk('x', '', '', 'same'), mk('y', '', '', 'same')]) === 'x' &&
      six?.toISOString() === '2026-10-28T05:30:00.000Z' &&
      act?.toISOString() === '2026-11-25T10:30:00.000Z' &&
      parseEmtStamp('garbage') === null &&
      out.length === 0 &&
      validityLine(
        {
          ...mk('v', '', ''),
          id: 'v',
          routeIds: [],
          text: '',
          from: act,
          to: parseEmtStamp('25/11/2026 15:00:00'),
        },
        now,
      ) === '25/11 11:30–15:00' &&
      validityLine(
        {
          id: 'u',
          routeIds: [],
          title: '',
          text: '',
          from: parseEmtStamp('27/11/2026 17:00:00'),
          to: null,
        },
        now,
      ) === 'desde 27/11 17:00'
    );
  })(),
  'parseEmtIncidents: expired dropped, active kept, >24 h ahead hidden, <24 h kept, 1-digit hour, text dedupe, validityLine',
);
console.assert(
  (() => {
    const inc = {
      title: 'Evento Deportivo: Zona Bernabéu. Afectadas 4 líneas de EMT.',
      guid: 'CE371CE0-ECBC-4897-866F-4F1B681B28DE',
      description:
        "El 23 de noviembre  <b>hay</b> evento.<p><img src='http://x/y.png'></p>\n<p>Gracias</p>",
    };
    const out = parseEmtIncidents(
      { code: '00', data: [{ Incident: { ListaIncident: { data: [inc, inc] } } }] },
      new Date(),
    );
    return (
      out.length === 1 &&
      out[0].id === inc.guid &&
      out[0].text ===
        'Evento Deportivo: Zona Bernabéu. Afectadas 4 líneas de EMT. El 23 de noviembre hay evento. Gracias' &&
      parseEmtIncidents({ code: '00', data: [{ Incident: {} }] }, new Date()).length === 0 &&
      parseEmtIncidents({ code: '00', data: [{}] }, new Date()).length === 0 &&
      parseEmtIncidents(null, new Date()).length === 0
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
  deps.filter(d => d.expected.getTime() >= now - 30_000).sort(byExpected);

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
  const title = firstText(a?.headerText) || text;
  return { id: e.id, routeIds, title, text, from: start ? new Date(start) : null };
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

// Line short names an alert text mentions after "línea(s)" ("líneas 14, 43, 120 y 150") or as
// "L1"; whole tokens only, lower case, so "línea 140" never matches "14".
const LINE_TOKEN = '[a-z]{0,2}\\d+[a-z]?';
const LINE_LIST = new RegExp(
  `\\blineas?\\s+(${LINE_TOKEN}(?:\\s*(?:,|y|e|o|/)\\s*${LINE_TOKEN})*)`,
  'g',
);
export function mentionedLines(text: string): Set<string> {
  const folded = fold(text);
  const lists = [...folded.matchAll(LINE_LIST)].flatMap(m => m[1].split(/[^a-z0-9]+/));
  const prefixed = [...folded.matchAll(/\bl(\d{1,3})\b/g)].map(m => m[1]);
  return new Set([...lists, ...prefixed].filter(t => /\d/.test(t)));
}

// Relevant to a stop: names one of its routes, or (no route ids, e.g. EMT incidents) mentions
// one of its lines.
export const isRelevant = (a: Alert, routeIds: Set<string>, lines: Set<string>) =>
  a.routeIds.length
    ? a.routeIds.some(r => routeIds.has(r))
    : [...mentionedLines(a.text)].some(l => lines.has(l));
console.assert(
  (() => {
    const al = (text: string): Alert => ({
      id: 'x',
      routeIds: [],
      title: text,
      text,
      from: null,
    });
    const lines = new Set(['14', '27']);
    const m = (t: string) => [...mentionedLines(t)].join();
    return (
      isRelevant(
        al('Desvío: las líneas 14, 43, 120 y 150, tendrán parada…'),
        new Set(),
        lines,
      ) &&
      isRelevant(al('Desvío de la línea 27 por obras'), new Set(), lines) &&
      isRelevant(al('Corte en L14'), new Set(), lines) &&
      !isRelevant(al('Afectada la línea 140'), new Set(), lines) &&
      !isRelevant(al('Líneas 114 y 214'), new Set(), lines) &&
      !isRelevant(al('Evento en el Bernabéu, 14 de noviembre'), new Set(), lines) &&
      m('Línea N1 y línea 5.') === 'n1,5'
    );
  })(),
  'mentionedLines / isRelevant: lists, singular, L-prefix, whole-token only',
);

// Short stable hash of an alert text, to notice when a dismissed alert changes.
export const textHash = (s: string) => {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h.toString(36);
};
console.assert(textHash('a') !== textHash('b') && textHash('a') === textHash('a'), 'textHash');

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

// An alert's text without its title when the text repeats it first (EMT: title + description).
export const bodyOf = (a: { title: string; text: string }) =>
  a.text.startsWith(a.title) ? a.text.slice(a.title.length).trim() : a.text;
console.assert(
  bodyOf({ title: 'Obras', text: 'Obras Desde el 12' }) === 'Desde el 12' &&
    bodyOf({ title: 'Obras', text: 'Obras' }) === '' &&
    bodyOf({ title: 'X', text: 'Y' }) === 'Y',
  'bodyOf drops a repeated title',
);

// Every stop within `radius` metres of a point, nearest first (no cap, unlike `nearStops`).
export const AREA_RADIUS = 500;
export const stopsWithin = (
  stops: Stop[],
  at: { lat: number; lon: number },
  radius = AREA_RADIUS,
): NearStop[] =>
  stops
    .map(s => ({ ...s, dist: metres(at, s) }))
    .filter(s => s.dist <= radius)
    .sort((a, b) => a.dist - b.dist);
console.assert(
  (() => {
    const mk = (id: string, lat: number): Stop => ({
      id,
      name: id,
      lat,
      lon: -3.69,
      wa: false,
    });
    const r = stopsWithin([mk('far', 40.42), mk('b', 40.404), mk('a', 40.4), mk('c', 40.4)], {
      lat: 40.4,
      lon: -3.69,
    });
    return r.map(s => s.id).join() === 'a,c,b';
  })(),
  'stopsWithin: within 500 m, nearest first',
);

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
export const short = (name: string) => name.replace(/^Madrid-/, '');
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

// Swaps a saved stop with its neighbour; an out-of-range move returns the same array.
export const moveSaved = (stops: Saved[], index: number, delta: -1 | 1): Saved[] => {
  const to = index + delta;
  if (index < 0 || index >= stops.length || to < 0 || to >= stops.length) return stops;
  const next = [...stops];
  [next[index], next[to]] = [next[to], next[index]];
  return next;
};
{
  const abc = [
    { id: 'a', name: 'A' },
    { id: 'b', name: 'B' },
    { id: 'c', name: 'C' },
  ];
  const ids = (x: Saved[]) => x.map(v => v.id).join('');
  console.assert(ids(moveSaved(abc, 1, -1)) === 'bac', 'moveSaved up');
  console.assert(ids(moveSaved(abc, 1, 1)) === 'acb', 'moveSaved down');
  console.assert(moveSaved(abc, 0, -1) === abc, 'moveSaved first up');
  console.assert(moveSaved(abc, 2, 1) === abc, 'moveSaved last down');
  console.assert(ids(abc) === 'abc', 'moveSaved does not mutate');
}

export const hhmm = (d: Date) =>
  d.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', timeZone: MADRID });

// Status line of a live CRTM/EMT fetch: waiting (plain for 2 s, then counting), timed out, or
// fresh with the age of the answer (omitted under 10 s).
export type LiveStatus =
  | { kind: 'waiting'; label: string; waitedMs: number }
  | { kind: 'timeout'; label: string; timetable: boolean }
  | {
      kind: 'fresh';
      label: string;
      fetchedAt: number;
      now: number;
      anyLive: boolean; // some displayed departure is live
      timetable: boolean;
    };

// Why a live feed failed (rt.php `X-Upstream-Error`, or worked out by the client in dev):
// HTTP status (0 = none) and kind: timeout | network | http | invalid | html.
export type UpstreamError = { code: number; kind: string };

const HTTP_MEANING: Record<number, string> = {
  400: 'petición no válida',
  401: 'acceso denegado',
  403: 'acceso denegado',
  404: 'no encontrado',
  429: 'demasiadas peticiones',
  503: 'servicio no disponible',
};

const httpMeaning = (code: number) =>
  HTTP_MEANING[code] ?? (code >= 500 ? 'error del servidor' : 'error');

// The failure in words: "HTTP 502 · error del servidor" / "sin respuesta (tiempo agotado)".
export function upstreamMeaning(e: UpstreamError): string {
  if (e.kind === 'timeout') return 'sin respuesta (tiempo agotado)';
  if (e.kind === 'network') return 'sin respuesta (error de red)';
  if (e.kind === 'html') return `HTTP ${e.code} · respuesta no válida (HTML)`;
  if (e.kind === 'invalid') return `HTTP ${e.code} · respuesta no válida`;
  return `HTTP ${e.code} · ${httpMeaning(e.code)}`;
}

// Second status line: "CRTM: HTTP 502 · error del servidor".
export const upstreamText = (label: string, e: UpstreamError) =>
  `${label}: ${upstreamMeaning(e)}`;

// A failing live feed as the status note shows it. `url`: the rt.php request (for `&why=1`);
// `body` / `at`: the failing response (first 2048 chars) and its time when the client has them.
export type FeedNote = {
  label: string;
  err: UpstreamError;
  url?: string;
  body?: string;
  at?: number;
};

// Live copies older than this are not used for times, delays or positions (the timetable takes over).
export const LIVE_MAX_AGE_MS = 30 * 60_000;
export const isLiveStale = (fetchedAt: number, now: number) =>
  now - fetchedAt > LIVE_MAX_AGE_MS;
console.assert(
  !isLiveStale(1000, 1000 + LIVE_MAX_AGE_MS) && isLiveStale(1000, 1001 + LIVE_MAX_AGE_MS),
  'isLiveStale',
);

// Status of a feed whose latest copy is too old: "CRTM: últimos datos de las 19:18 · horario".
export const staleText = (label: string, fetchedAt: number, timetable: boolean) =>
  `${label}: últimos datos de las ${hhmm(new Date(fetchedAt))} · ${
    timetable ? 'horario' : 'sin datos en vivo'
  }`;
console.assert(
  staleText('CRTM', Date.UTC(2026, 0, 15, 18, 18), true) ===
    'CRTM: últimos datos de las 19:18 · horario' &&
    staleText('CRTM', Date.UTC(2026, 0, 15, 18, 18), false) ===
      'CRTM: últimos datos de las 19:18 · sin datos en vivo',
  'staleText',
);

console.assert(
  upstreamText('CRTM', { code: 200, kind: 'html' }) ===
    'CRTM: HTTP 200 · respuesta no válida (HTML)' &&
    upstreamText('CRTM', { code: 200, kind: 'invalid' }) ===
      'CRTM: HTTP 200 · respuesta no válida' &&
    upstreamText('CRTM', { code: 502, kind: 'http' }) ===
      'CRTM: HTTP 502 · error del servidor' &&
    upstreamText('Renfe', { code: 0, kind: 'timeout' }) ===
      'Renfe: sin respuesta (tiempo agotado)' &&
    upstreamText('Renfe', { code: 0, kind: 'network' }) ===
      'Renfe: sin respuesta (error de red)' &&
    upstreamText('EMT', { code: 401, kind: 'http' }) === 'EMT: HTTP 401 · acceso denegado' &&
    upstreamText('EMT', { code: 503, kind: 'http' }) ===
      'EMT: HTTP 503 · servicio no disponible' &&
    upstreamText('EMT', { code: 429, kind: 'http' }) ===
      'EMT: HTTP 429 · demasiadas peticiones' &&
    upstreamText('EMT', { code: 418, kind: 'http' }) === 'EMT: HTTP 418 · error',
  'upstreamText',
);

const ageNote = (ms: number) => {
  const secs = Math.floor(ms / 1000);
  if (secs < 10) return '';
  return secs < 60 ? ` (hace ${secs} s)` : ` (hace ${Math.floor(secs / 60)} min)`;
};

const waitingText = (label: string, waitedMs: number) =>
  waitedMs < 2000
    ? 'esperando datos en vivo…'
    : `esperando a ${label} · ${Math.floor(waitedMs / 1000)} s`;

export function liveStatusText(s: LiveStatus): string {
  if (s.kind === 'waiting') return waitingText(s.label, s.waitedMs);
  if (s.kind === 'timeout') {
    return `${s.label} no responde · ${s.timetable ? 'mostrando horario' : 'reintentando'}`;
  }
  return freshText(s);
}

// The source answered: "en vivo" only when a displayed departure is live, else say it had
// nothing for this stop (Renfe: for the shown trains).
function freshText(s: Extract<LiveStatus, { kind: 'fresh' }>): string {
  const at = hhmm(new Date(s.fetchedAt));
  if (s.anyLive) {
    return s.label === 'Renfe'
      ? `datos en vivo ${at}`
      : `en vivo · ${s.label} ${at}${ageNote(Math.max(0, s.now - s.fetchedAt))}`;
  }
  const none =
    s.label === 'Renfe'
      ? 'Renfe sin actualizaciones para estos trenes'
      : `${s.label} sin tiempos para esta parada`;
  return s.timetable ? `${none} · horario (${at})` : none;
}

{
  const t = Date.UTC(2026, 0, 15, 14, 44, 0); // 15:44 in Madrid
  const fresh = (age: number, anyLive = true, timetable = true, label = 'CRTM') =>
    liveStatusText({
      kind: 'fresh',
      label,
      fetchedAt: t,
      now: t + age,
      anyLive,
      timetable,
    });
  console.assert(
    liveStatusText({ kind: 'waiting', label: 'CRTM', waitedMs: 1500 }) ===
      'esperando datos en vivo…',
    'waiting under 2 s',
  );
  console.assert(
    liveStatusText({ kind: 'waiting', label: 'CRTM', waitedMs: 5200 }) ===
      'esperando a CRTM · 5 s',
    'waiting 5 s',
  );
  console.assert(
    liveStatusText({ kind: 'timeout', label: 'Renfe', timetable: true }) ===
      'Renfe no responde · mostrando horario',
    'timeout with timetable',
  );
  console.assert(
    liveStatusText({ kind: 'timeout', label: 'EMT', timetable: false }) ===
      'EMT no responde · reintentando',
    'timeout without timetable',
  );
  console.assert(fresh(3000) === 'en vivo · CRTM 15:44', 'fresh');
  console.assert(fresh(40_000) === 'en vivo · CRTM 15:44 (hace 40 s)', '40 s old');
  console.assert(
    fresh(3000, false) === 'CRTM sin tiempos para esta parada · horario (15:44)',
    'answered, none live, timetable',
  );
  console.assert(
    fresh(3000, false, false, 'EMT') === 'EMT sin tiempos para esta parada',
    'answered, none live, no timetable',
  );
  console.assert(
    fresh(3000, false, true, 'Renfe') ===
      'Renfe sin actualizaciones para estos trenes · horario (15:44)',
    'Renfe answered, none live',
  );
  console.assert(fresh(3000, true, true, 'Renfe') === 'datos en vivo 15:44', 'Renfe live');
}

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

// Line scan: a bus stop with no live CRTM times borrows the nearest earlier stop of the line
// that has a live bus and projects that bus's time forward with the pattern's offsets.
export type LineOption = { routeId: string; head: string; pi: number; arr?: true };
export type ScanStop = { id: string; off: number };

const topCount = (counts: Map<number, number>) =>
  [...counts].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]?.[0] ?? 0;

// Distinct (route, headsign) pairs of a bus stop file, each with its most common pattern.
export function lineOptions(file: BusFile): LineOption[] {
  const groups = new Map<string, LineOption & { counts: Map<number, number> }>();
  for (const [, , r, h, pi] of file.d) {
    const key = `${r}|${h}`;
    const g = groups.get(key) ?? {
      routeId: file.r[r],
      head: file.h[h],
      pi: 0,
      counts: new Map<number, number>(),
    };
    if (pi !== undefined) g.counts.set(pi, (g.counts.get(pi) ?? 0) + 1);
    groups.set(key, g);
  }
  return [...groups.values()]
    .map(g => ({ routeId: g.routeId, head: g.head, pi: topCount(g.counts) }))
    .sort((a, b) => a.routeId.localeCompare(b.routeId, 'es', { numeric: true }));
}

// The scan option for a departure's line: same route and headsign, else the route's first.
export const optionFor = (opts: LineOption[], routeId: string, head: string) =>
  opts.find(o => o.routeId === routeId && o.head === head) ??
  opts.find(o => o.routeId === routeId) ??
  null;
console.assert(
  (() => {
    const opts = [
      { routeId: 'r', head: 'A', pi: 0 },
      { routeId: 'r', head: 'B', pi: 1 },
    ];
    return (
      optionFor(opts, 'r', 'B')?.pi === 1 &&
      optionFor(opts, 'r', 'X')?.pi === 0 &&
      optionFor(opts, 'z', 'A') === null
    );
  })(),
  'optionFor',
);

// The stops before `stopId` in the pattern, nearest first, at most `max` (default: all of them,
// back to the first stop; a stop repeated on a circular line is not its own upstream).
export function scanOrder(p: Pattern, stopId: string, max = Infinity): ScanStop[] {
  const i = stopIndex(p, stopId);
  if (i <= 0) return [];
  return p
    .slice(0, i)
    .filter(([id]) => id !== stopId)
    .slice(-max)
    .reverse()
    .map(([id, off]) => ({ id, off }));
}

// The part of a scan order from which a bus can still land within `maxSecs` of timetable travel
// at `here` (nearest first, so the offsets only grow). A pattern without offsets is not cut.
export function scanWithin(p: Pattern, here: string, order: ScanStop[], maxSecs: number) {
  const i = stopIndex(p, here);
  if (i < 0) return order;
  return order.filter(s => p[i][1] - s.off <= maxSecs);
}
console.assert(
  (() => {
    const p: Pattern = [
      ['a', 0],
      ['b', 1800],
      ['c', 3600],
      ['d', 5400],
      ['e', 5400],
    ];
    const o = scanOrder(p, 'e');
    const flat: Pattern = [
      ['a', 0],
      ['b', 0],
      ['c', 0],
    ];
    return (
      scanWithin(p, 'e', o, 3600)
        .map(s => s.id)
        .join() === 'd,c,b' && scanWithin(flat, 'c', scanOrder(flat, 'c'), 3600).length === 2
    );
  })(),
  'scanWithin',
);

// The buses of one scan pass, found nearest stop first. A bus is identified by `issue` (CRTM's
// trip id, stable across stops): the nearest stop that sees it live projects it. A row without
// an issue is a new bus only when its projected time is over 2 min from every bus found.
export type FoundBus = { issue: string; stopId: string; rows: CrtmRow[] };
export const MAX_BUSES = 3;
const SAME_BUS_MS = 120_000;

const groupByIssue = (hits: CrtmRow[]): [string, CrtmRow[]][] => {
  const byIssue = new Map<string, CrtmRow[]>();
  const loose: [string, CrtmRow[]][] = [];
  for (const h of hits) {
    if (!h.issue) loose.push(['', [h]]);
    else byIssue.set(h.issue, [...(byIssue.get(h.issue) ?? []), h]);
  }
  return [...byIssue, ...loose];
};

const nearProjection = (found: FoundBus[], rows: CrtmRow[]) =>
  found.some(b =>
    b.rows.some(r =>
      rows.some(x => Math.abs(x.when.getTime() - r.when.getTime()) <= SAME_BUS_MS),
    ),
  );

const isNewBus = (found: FoundBus[], issue: string, projected: CrtmRow[]) =>
  issue ? !found.some(b => b.issue === issue) : !nearProjection(found, projected);

export function addBuses(
  found: FoundBus[],
  stopId: string,
  hits: CrtmRow[],
  project: (rows: CrtmRow[]) => CrtmRow[],
  max = MAX_BUSES,
): FoundBus[] {
  const out = [...found];
  for (const [issue, rows] of groupByIssue(hits)) {
    const projected = project(rows);
    if (out.length < max && isNewBus(out, issue, projected))
      out.push({ issue, stopId, rows: projected });
  }
  return out;
}
console.assert(
  (() => {
    const row = (issue: string, min: number) =>
      ({ issue, when: new Date(min * 60_000) }) as unknown as CrtmRow;
    const id = (rows: CrtmRow[]) => rows;
    const a = addBuses([], 's1', [row('1', 10)], id);
    const same = addBuses(a, 's2', [row('1', 12)], id);
    const second = addBuses(same, 's3', [row('2', 40)], id);
    const nearLoose = addBuses(second, 's4', [row('', 11)], id);
    const farLoose = addBuses(second, 's4', [row('', 70)], id);
    const capped = addBuses(farLoose, 's5', [row('9', 90)], id, 3);
    const grouped = addBuses([], 's1', [row('1', 10), row('1', 30)], id);
    return (
      a.length === 1 &&
      same.length === 1 &&
      same[0].stopId === 's1' &&
      second.length === 2 &&
      second[1].stopId === 's3' &&
      nearLoose.length === 2 &&
      farLoose.length === 3 &&
      capped.length === 3 &&
      grouped.length === 1 &&
      grouped[0].rows.length === 2
    );
  })(),
  'addBuses',
);

// Arrivals scan options of a terminus: per route of the stop file, its longest pattern that
// ends at `stopId`, labelled "desde <town of its first stop>" (`townOf` falls back to a name).
export function arrivalOptions(
  stopId: string,
  routes: string[],
  patternsByRoute: Record<string, Pattern[] | undefined>,
  townOf: (id: string) => string,
): LineOption[] {
  const out: LineOption[] = [];
  for (const routeId of routes) {
    const pats = patternsByRoute[routeId] ?? [];
    let best = -1;
    pats.forEach((p, i) => {
      const ends = p.length > 1 && p[p.length - 1][0] === stopId;
      if (ends && (best < 0 || p.length > pats[best].length)) best = i;
    });
    if (best >= 0)
      out.push({
        routeId,
        head: `desde ${townOf(pats[best][0][0])}`,
        pi: best,
        arr: true,
      });
  }
  return out.sort((a, b) => a.routeId.localeCompare(b.routeId, 'es', { numeric: true }));
}
console.assert(
  (() => {
    const pats = {
      A: [
        [
          ['x', 0],
          ['t', 60],
        ],
        [
          ['y', 0],
          ['x', 60],
          ['t', 120],
        ],
        [
          ['t', 0],
          ['x', 60],
        ],
      ] as Pattern[],
      B: [[['x', 0]]] as Pattern[],
    };
    const o = arrivalOptions('t', ['B', 'A', 'C'], pats, id => id.toUpperCase());
    return (
      o.length === 1 &&
      o[0].routeId === 'A' &&
      o[0].pi === 1 &&
      o[0].head === 'desde Y' &&
      o[0].arr === true
    );
  })(),
  'arrivalOptions: longest pattern ending at the stop, one option per route',
);

// Arrival rows at an upstream stop: the route's live rows whose trip ends at `stopId` (CRTM's
// destination stop code is the stop id without "par_"); no headsign comparison.
export const arrivalMatches = (rows: CrtmRow[], routeId: string, stopId: string) =>
  rows.filter(
    r =>
      r.routeId === routeId &&
      !r.scheduled &&
      !r.estimated &&
      r.code === stopId.replace(/^par_/, ''),
  );

// Live rows of the line + direction at an upstream stop. Whole-minute bus rows are CRTM's
// timetable. `single`: the stop has just one direction of the route, so CRTM's own destination
// text (not the headsign) is what the rows carry.
export const liveMatches = (rows: CrtmRow[], routeId: string, head: string, single: boolean) =>
  rows.filter(
    r => r.routeId === routeId && !r.scheduled && !r.estimated && (single || r.dest === head),
  );

// Project live rows seen at `from` onto `here` (same pattern, offset difference), as rows of
// the target direction.
export function projectRows(
  rows: CrtmRow[],
  p: Pattern,
  from: string,
  here: string,
  target: { head: string; pi: number; arr?: true },
): CrtmRow[] {
  const iu = stopIndex(p, from);
  const ih = stopIndex(p, here);
  if (iu < 0 || ih < 0) return [];
  const shift = (p[ih][1] - p[iu][1]) * 1000;
  return rows.map(r => ({
    ...r,
    when: new Date(r.when.getTime() + shift),
    // Arrivals: `dest` is the origin (CRTM's own arrival rows group the same way).
    dest: target.arr ? arrivalOrigin(r.route ?? r.dest) : target.head,
    pi: target.pi,
    scheduled: false,
    estimated: true,
    from,
    ...(target.arr ? { arr: true as const } : {}),
  }));
}

// Estimates of the manual scan and of the automatic one (por hora): one projection per route +
// destination (+ board kind) within 60 s, the manual one first.
export function mergeProjected(manual: CrtmRow[], auto: CrtmRow[]): CrtmRow[] {
  const out = [...manual];
  for (const a of auto) {
    const dup = out.some(
      m =>
        m.routeId === a.routeId &&
        m.dest === a.dest &&
        !!m.arr === !!a.arr &&
        Math.abs(m.when.getTime() - a.when.getTime()) <= 60_000,
    );
    if (!dup) out.push(a);
  }
  return out;
}

// Estimates are kept (per stop, per scan target key) until a live row pairs with them, a newer
// scan of the line finds a bus, or their time is past: never because of age, a stop change or a
// pass that found nothing.
export type KeptRows = Record<string, CrtmRow[]>;
const PAST_MS = 60_000; // a row stays until its time is this far past (the board's window)

export const freshRows = (rows: CrtmRow[], now: number): CrtmRow[] =>
  rows.filter(r => r.when.getTime() >= now - PAST_MS);

// Drops past rows, and keys left without rows.
export function pruneKept(kept: KeptRows, now: number): KeptRows {
  const out: KeptRows = {};
  for (const [k, rows] of Object.entries(kept)) {
    const fresh = freshRows(rows, now);
    if (fresh.length) out[k] = fresh;
  }
  return out;
}

// The rows of a scan being replaced (or left) go under its key; none: nothing changes. The old
// entry of the key the new scan is about to own stays until that scan finds a bus.
export function keepEstimate(
  kept: KeptRows,
  key: string | null,
  rows: CrtmRow[],
  now: number,
): KeptRows {
  const next =
    key !== null && rows.length > 0
      ? { ...kept, [key]: mergeBuses(kept[key] ?? [], rows) }
      : kept;
  return pruneKept(next, now);
}
console.assert(
  (() => {
    const row = (ms: number) => ({ when: new Date(ms) }) as unknown as CrtmRow;
    const a = keepEstimate({}, 'a', [row(100_000)], 0);
    const empty = keepEstimate(a, 'b', [], 0);
    const nullKey = keepEstimate(a, null, [row(100_000)], 0);
    const past = pruneKept(a, 100_000 + PAST_MS + 1);
    const edge = pruneKept(a, 100_000 + PAST_MS);
    return (
      Object.keys(a).join() === 'a' &&
      Object.keys(empty).join() === 'a' &&
      Object.keys(nullKey).join() === 'a' &&
      Object.keys(past).length === 0 &&
      Object.keys(edge).join() === 'a' &&
      keepEstimate(a, 'a', [row(200_000)], 0)['a'][0].when.getTime() === 200_000 &&
      freshRows([row(1_000), row(100_000)], 100_000 + PAST_MS).length === 1
    );
  })(),
  'keepEstimate / pruneKept / freshRows',
);

// Fresh rows plus the old rows of buses the fresh ones do not show (a scan may miss a bus for a
// moment, its estimate stays). Same bus: the same non-empty `issue`; an old row without one is
// that bus when a fresh row of the same route + dest + kind is within 2 min.
// Rows are never restamped: each keeps the `found` of the pass that made it, and when both sides
// carry the same bus the newer `found` wins (a tie: the fresh row).
export function mergeBuses(old: CrtmRow[], incoming: CrtmRow[]): CrtmRow[] {
  const newer = (f: CrtmRow) =>
    !!f.issue && old.some(o => o.issue === f.issue && (o.found ?? 0) > (f.found ?? 0));
  const fresh = incoming.filter(f => !newer(f));
  const issues = new Set(fresh.map(r => r.issue).filter(Boolean));
  const seen = (o: CrtmRow) =>
    fresh.some(
      f =>
        f.routeId === o.routeId &&
        f.dest === o.dest &&
        !!f.arr === !!o.arr &&
        Math.abs(f.when.getTime() - o.when.getTime()) <= SAME_BUS_MS,
    );
  return [...fresh, ...old.filter(o => (o.issue ? !issues.has(o.issue) : !seen(o)))];
}
console.assert(
  (() => {
    const row = (issue: string, min: number, dest = 'X') =>
      ({ issue, routeId: 'r', dest, when: new Date(min * 60_000) }) as unknown as CrtmRow;
    const missed = mergeBuses([row('1', 10), row('2', 30)], [row('1', 12)]);
    const loose = mergeBuses([row('', 10), row('', 40)], [row('', 11)]);
    const other = mergeBuses([row('', 10, 'Y')], [row('', 10)]);
    return (
      missed.length === 2 &&
      missed[0].when.getTime() === 12 * 60_000 &&
      missed[1].issue === '2' &&
      loose.length === 2 &&
      loose[1].when.getTime() === 40 * 60_000 &&
      other.length === 2 &&
      mergeBuses([], [row('1', 1)]).length === 1 &&
      (() => {
        const o = { ...row('1', 10), found: 20 } as CrtmRow;
        const f = { ...row('1', 12), found: 10 } as CrtmRow;
        const r = mergeBuses([o], [f]);
        return r.length === 1 && r[0] === o && mergeBuses([f], [o])[0] === o;
      })()
    );
  })(),
  'mergeBuses',
);

// Of several finds of one bus (route + dest + board kind + `issue`) only the newest (max `found`,
// none = 0) stays, whichever scan made it; so two buses of a line from different passes both
// stay. Rows without an issue: the newest find per line, a tie keeps every row of it. Input
// order is kept.
// Finds of one line within SUPERSEDE_MS are one bus too, whatever their trip ids (16578: line 3
// showed 13:58 and 14:01 for one bus, headway there is 40+ min): the newer pass wins, within one
// pass the later time.
const SUPERSEDE_MS = 5 * 60_000;
export function newestPerBus(rows: CrtmRow[]): CrtmRow[] {
  const key = (r: CrtmRow) => `${r.routeId}|${r.dest}|${r.arr ? 1 : 0}|${r.issue || ''}`;
  const max = new Map<string, number>();
  for (const r of rows) max.set(key(r), Math.max(max.get(key(r)) ?? 0, r.found ?? 0));
  const kept = rows.filter(r => (r.found ?? 0) === max.get(key(r)));
  const superseded = (r: CrtmRow) =>
    kept.some(
      o =>
        o.routeId === r.routeId &&
        o.dest === r.dest &&
        !!o.arr === !!r.arr &&
        Math.abs(o.when.getTime() - r.when.getTime()) <= SUPERSEDE_MS &&
        ((o.found ?? 0) > (r.found ?? 0) ||
          ((o.found ?? 0) === (r.found ?? 0) && o.when > r.when)),
    );
  return kept.filter(r => !superseded(r));
}
console.assert(
  (() => {
    const row = (route: string, ms: number, found?: number, arr?: true, issue = '') =>
      ({
        routeId: route,
        dest: 'X',
        when: new Date(ms),
        found,
        arr,
        issue,
      }) as unknown as CrtmRow;
    const rows = [row('a', 1, 10), row('a', 2, 10), row('a', 3, 20), row('b', 1, 5)];
    const out = newestPerBus(rows);
    const buses = newestPerBus([
      row('a', 0, 10, undefined, '1'),
      row('a', 30 * 60_000, 20, undefined, '2'),
    ]);
    const same = newestPerBus([
      row('a', 1, 10, undefined, '1'),
      row('a', 2, 20, undefined, '1'),
    ]);
    return (
      out.length === 2 &&
      out[0].when.getTime() === 3 &&
      out[1].routeId === 'b' &&
      newestPerBus([row('a', 1, 20), row('a', 2, 20), row('a', 3, 10)]).length === 1 &&
      newestPerBus([row('a', 1, 10), row('a', 2, 5, true)]).length === 2 &&
      newestPerBus([row('a', 1), row('a', 2, 3)]).length === 1 &&
      buses.length === 2 &&
      same.length === 1 &&
      same[0].when.getTime() === 2 &&
      newestPerBus([row('a', 0, 10, undefined, '1'), row('a', 3 * 60_000, 20, undefined, '2')])
        .length === 1 &&
      newestPerBus([row('a', 0, 10, undefined, '1'), row('a', 6 * 60_000, 20, undefined, '2')])
        .length === 2 &&
      newestPerBus([
        row('a', 0, 10, undefined, '1'),
        row('a', 3 * 60_000, 10, undefined, '2'),
      ])[0].when.getTime() ===
        3 * 60_000
    );
  })(),
  'newestPerBus',
);

// An estimate and a live row of one line (`single`: the stop has one direction of the route, so
// only the route is compared).
const sameLine = (a: Departure, b: Departure, single: (routeId: string) => boolean) =>
  a.routeId === b.routeId && (single(a.routeId) || a.dest === b.dest);

// A live time and an estimate more than 10 min apart are two buses, even with the same trip id.
const PAIR_MAX_MS = 10 * 60_000;
const ALSO_EST_MS = 2 * 60_000;
type Pair = { est: Departure; live: Departure; gap: number };

// Every estimate with the own live rows of its line within PAIR_MAX_MS, closest first (when both
// carry a trip id they pair only if it is equal).
function pairCandidates(deps: Departure[], single: (routeId: string) => boolean): Pair[] {
  const lives = deps.filter(d => d.live && !d.estimated);
  return deps
    .filter(d => d.estimated)
    .flatMap(est =>
      lives
        .filter(live => sameLine(est, live, single) && sameBus(est, live) !== false)
        .map(live => ({
          est,
          live,
          gap: Math.abs(live.expected.getTime() - est.expected.getTime()),
        })),
    )
    .filter(c => c.gap <= PAIR_MAX_MS)
    .sort((a, b) => a.gap - b.gap);
}

// An estimate that stays on the board stands for the timetable time it projects (CRTM's own
// whole-minute time or a timetable run of the same line and destination, nearest within 2 min):
// that time is dropped, else 16578 showed "461 21:49 estimado" right above "461 21:50". Each
// estimate takes at most one; live, estimated and "no confirmado" rows are never dropped. With
// trip ids (`issue`): the same id is dropped at any time gap, a different id never.
const SHADOW_MS = 5 * 60_000; // 16578, line 1: est. 14:15 vs CRTM's 14:18:00
const plainRow = (d: Departure) => !d.live && !d.estimated && !d.unconfirmed && !d.cancelled;
function nearestPlain(deps: Departure[], est: Departure, gone: Set<Departure>) {
  const free = deps.filter(d => d.routeId === est.routeId && plainRow(d) && !gone.has(d));
  const mine = free.find(d => sameBus(est, d) === true); // same trip id: any time gap
  if (mine) return mine;
  let best: Departure | null = null;
  let gap = SHADOW_MS;
  for (const d of free) {
    const g = Math.abs(d.expected.getTime() - est.expected.getTime());
    if (d.dest === est.dest && sameBus(est, d) !== false && g <= gap) [best, gap] = [d, g];
  }
  return best;
}
export function dropShadowed(deps: Departure[]): Departure[] {
  const gone = new Set<Departure>();
  for (const est of deps.filter(d => d.estimated)) {
    const d = nearestPlain(deps, est, gone);
    if (d) gone.add(d);
  }
  return gone.size ? deps.filter(d => !gone.has(d)) : deps;
}
console.assert(
  (() => {
    const t0 = Date.UTC(2026, 10, 27, 20, 0);
    const mk = (min: number, extra: Partial<Departure> = {}) =>
      ({
        routeId: 'r',
        dest: 'X',
        expected: new Date(t0 + min * 60_000),
        live: false,
        ...extra,
      }) as Departure;
    const est = mk(49.5, { estimated: true });
    const out = dropShadowed([est, mk(50), mk(51), mk(60), mk(50, { dest: 'Y' })]);
    const keep = dropShadowed([est, mk(48, { unconfirmed: true }), mk(56)]);
    return (
      out.length === 4 &&
      out
        .filter(d => d.dest === 'X' && !d.estimated)
        .map(d => d.expected.getTime())
        .join() === [t0 + 51 * 60_000, t0 + 60 * 60_000].join() &&
      keep.length === 3
    );
  })(),
  'dropShadowed: an estimate replaces the timetable time it stands for',
);

// An estimated departure and the stop's own live departure of the same line are one bus: the
// estimate is dropped (each live row takes one, closest pairs first) and, when the two times
// differ by 2+ min, the live row remembers it as `alsoEst`. An unpaired estimate stays.
// Other estimates of the live row's bus (its other trip id): they stand for it too.
const siblings = (cands: Pair[], live: Departure) =>
  cands.filter(e => e.live === live && sameBus(e.est, live) === true).map(e => e.est);

export function pairEstimates(
  deps: Departure[],
  single: (routeId: string) => boolean = () => false,
): Departure[] {
  const gone = new Set<Departure>();
  const taken = new Map<Departure, Pair>();
  const cands = pairCandidates(deps, single);
  for (const c of cands) {
    if (gone.has(c.est) || taken.has(c.live)) continue;
    gone.add(c.est);
    taken.set(c.live, c);
    for (const e of siblings(cands, c.live)) gone.add(e);
  }
  return deps
    .filter(d => !gone.has(d))
    .map(d => {
      const p = taken.get(d);
      return p && p.gap >= ALSO_EST_MS ? { ...d, alsoEst: p.est.expected } : d;
    });
}
console.assert(
  (() => {
    const t0 = Date.UTC(2026, 10, 27, 20, 0);
    const mk = (min: number, extra: Partial<Departure>) =>
      ({
        routeId: 'r',
        dest: 'X',
        expected: new Date(t0 + min * 60_000),
        planned: new Date(t0 + min * 60_000),
        live: false,
        ...extra,
      }) as Departure;
    const live = mk(10, { live: true });
    const far = pairEstimates([live, mk(15, { estimated: true })]);
    const near = pairEstimates([live, mk(11, { estimated: true })]);
    const twoLive = pairEstimates([
      live,
      mk(30, { live: true }),
      mk(12, { estimated: true }),
      mk(29, { estimated: true }),
    ]);
    const lone = pairEstimates([mk(40, { estimated: true }), live]);
    const apart = pairEstimates([live, mk(21, { estimated: true })]);
    const other = pairEstimates([live, mk(15, { estimated: true, dest: 'Y' })]);
    const single = pairEstimates([live, mk(15, { estimated: true, dest: 'Y' })], () => true);
    return (
      far.length === 1 &&
      far[0].alsoEst?.getTime() === t0 + 15 * 60_000 &&
      near.length === 1 &&
      near[0].alsoEst === undefined &&
      twoLive.length === 2 &&
      twoLive[0].alsoEst?.getTime() === t0 + 12 * 60_000 &&
      twoLive[1].alsoEst === undefined &&
      lone.length === 2 &&
      apart.length === 2 &&
      other.length === 2 &&
      single.length === 1
    );
  })(),
  'pairEstimates: nearest own live row of the line, alsoEst from 2 min, unpaired stays',
);
console.assert(
  (() => {
    const t0 = Date.UTC(2026, 10, 27, 20, 0);
    const mk = (min: number, extra: Partial<Departure>) =>
      ({
        ...extra,
        routeId: 'r',
        dest: 'X',
        live: extra.live ?? false,
        expected: new Date(t0 + min * 60_000),
        planned: new Date(t0 + min * 60_000),
      }) as Departure;
    const same = pairEstimates([
      mk(10, { live: true, issue: '1' }),
      mk(19, { estimated: true, issue: '1' }),
    ]);
    const far = pairEstimates([
      mk(10, { live: true, issue: '1' }),
      mk(25, { estimated: true, issue: '1' }),
    ]);
    const diff = pairEstimates([
      mk(10, { live: true, issue: '1' }),
      mk(11, { estimated: true, issue: '9' }),
    ]);
    return same.length === 1 && far.length === 2 && diff.length === 2;
  })(),
  'pairEstimates: the same trip id pairs within 10 min, over it or a different id never',
);
console.assert(
  (() => {
    const t0 = Date.UTC(2026, 10, 27, 20, 0);
    const mk = (min: number, extra: Partial<Departure> = {}) =>
      ({
        ...extra,
        routeId: 'r',
        dest: 'X',
        live: false,
        expected: new Date(t0 + min * 60_000),
      }) as Departure;
    const est = mk(53, { estimated: true, issue: '1' });
    const far = dropShadowed([est, mk(67, { issue: '1' })]);
    const diff = dropShadowed([est, mk(53, { issue: '9' })]);
    const loose = dropShadowed([est, mk(54)]);
    const wide = dropShadowed([est, mk(56)]);
    return far.length === 1 && diff.length === 2 && loose.length === 1 && wide.length === 1;
  })(),
  'dropShadowed: the same trip id is dropped at any gap, a different one never',
);

console.assert(
  (() => {
    const file: BusFile = {
      kind: 'bus',
      r: ['A', 'B'],
      h: ['X', 'Y'],
      c: [],
      d: [
        [0, 0, 0, 0, 2],
        [1, 0, 0, 0, 3],
        [2, 0, 0, 0, 3],
        [3, 0, 1, 1, 0],
      ],
    };
    const opts = lineOptions(file);
    const pat: Pattern = [
      ['a', 0],
      ['b', 60],
      ['c', 180],
      ['d', 300],
      ['e', 420],
    ];
    const order = scanOrder(pat, 'd');
    const t0 = new Date('2026-11-26T15:00:30Z');
    const row = (routeId: string, dest: string, scheduled = false): CrtmRow => ({
      when: t0,
      routeId,
      line: routeId,
      dest,
      tram: false,
      metro: false,
      issue: '',
      scheduled,
    });
    const hits = liveMatches(
      [row('A', 'X'), row('A', 'Z'), row('B', 'X'), row('A', 'X', true)],
      'A',
      'X',
      false,
    );
    const proj = projectRows(hits, pat, 'b', 'd', { head: 'X', pi: 3 });
    const endRow = { ...row('A', 'MADRID'), route: 'HOYO-MADRID', code: '8_77' };
    const arrHits = arrivalMatches(
      [endRow, row('A', 'X'), { ...endRow, scheduled: true }],
      'A',
      'par_8_77',
    );
    const arrProj = projectRows(arrHits, pat, 'b', 'd', { head: 'desde Q', pi: 3, arr: true });
    return (
      arrHits.length === 1 &&
      arrProj[0].dest === 'HOYO' &&
      arrProj[0].arr === true &&
      arrProj[0].estimated === true &&
      proj[0].arr === undefined &&
      opts.length === 2 &&
      opts[0].routeId === 'A' &&
      opts[0].pi === 3 &&
      opts[1].pi === 0 &&
      order.map(o => o.id).join() === 'c,b,a' &&
      order[0].off === 180 &&
      scanOrder(pat, 'd', 2).length === 2 &&
      scanOrder(pat, 'a').length === 0 &&
      scanOrder(pat, 'zz').length === 0 &&
      hits.length === 1 &&
      liveMatches([row('A', 'Z')], 'A', 'X', true).length === 1 &&
      proj.length === 1 &&
      proj[0].when.toISOString() === '2026-11-26T15:04:30.000Z' &&
      proj[0].estimated === true &&
      proj[0].from === 'b' &&
      proj[0].pi === 3 &&
      projectRows(hits, pat, 'zz', 'd', { head: 'X', pi: 3 }).length === 0 &&
      mergeProjected(proj, arrProj).length === 2 &&
      mergeProjected(
        proj,
        proj.map(r => ({ ...r, when: new Date(r.when.getTime() + 30_000) })),
      ).length === 1 &&
      mergeProjected(
        proj,
        proj.map(r => ({ ...r, when: new Date(r.when.getTime() + 90_000) })),
      ).length === 2
    );
  })(),
  'line scan: lineOptions, scanOrder, liveMatches, projectRows, mergeProjected',
);

// Accent-insensitive, either name may contain the other ("PINAR DE CHAMARTIN" vs "Pinar de Chamartín").
const sameName = (a: string, b: string) => {
  const x = fold(a);
  const y = fold(b);
  return !!x && !!y && (x === y || x.includes(y) || y.includes(x));
};

// Pattern for live rows that carry no pattern index (Metro, EMT, CRTM): among the patterns that
// still have stops after `stopId`, the longest that ends at `endId` (CRTM's destination stop,
// when known: 460 runs to PARLA end at La Ballena, a name the headsign doesn't match), else the
// longest whose last stop is named like the destination, else the longest. Returns an index, or
// -1 when no pattern contains the stop.
export function pickPattern(
  patterns: Pattern[],
  stopId: string,
  dest: string,
  nameOf: (id: string) => string | undefined,
  endId?: string,
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
  const ends = endId ? longest(p => p.at(-1)?.[0] === endId) : -1;
  if (ends >= 0) return ends;
  const named = dest ? longest(p => sameName(nameOf(p.at(-1)?.[0] ?? '') ?? '', dest)) : -1;
  return named >= 0 ? named : longest(() => true);
}

// Some feeds chain a bus's laps into one trip (CRTM 256: Madrid > Daganzo > Madrid, 13 times):
// cut at the first stop already seen, keeping it only as the very last one (circular line).
function oneLap(rest: Pattern, stopId: string): Pattern {
  const seen = new Set([stopId]);
  const end = rest.findIndex(([id]) => seen.size === seen.add(id).size);
  if (end < 0) return rest;
  return end === rest.length - 1 && rest[end][0] === stopId ? rest : rest.slice(0, end);
}

// The stops after `stopId` with estimated times: `at` is when the vehicle leaves `stopId`
// (planned, live or estimated), later stops add the pattern's offset difference.
export function nextStops(p: Pattern, stopId: string, at: Date): StopTime[] {
  const i = stopIndex(p, stopId);
  if (i < 0) return [];
  return oneLap(p.slice(i + 1), stopId).map(([id, off]) => ({
    id,
    at: new Date(at.getTime() + (off - p[i][1]) * 1000),
  }));
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
      oneLap(
        [
          ['b', 1],
          ['c', 2],
          ['a', 3],
          ['b', 4],
          ['c', 5],
        ],
        'a',
      ).length === 2 &&
      oneLap(
        [
          ['b', 1],
          ['a', 2],
        ],
        'a',
      ).length === 2 &&
      pickPattern([short, long], 'a', 'de', nameOf) === 1 &&
      pickPattern([short, long], 'a', 'calle c', nameOf) === 0 &&
      pickPattern([short, long], 'a', 'nowhere', nameOf) === 1 &&
      pickPattern([short, long], 'a', 'nowhere', nameOf, 'c') === 0 &&
      pickPattern([short, long], 'a', 'de', nameOf, 'zz') === 1 &&
      pickPattern([short, long], 'd', '', nameOf) === -1 &&
      pickPattern([short, long], 'zz', '', nameOf) === -1
    );
  })(),
  'nextStops offsets, pickPattern: destination match, longest fallback, none',
);

// ---------------------------------------------------------------- Following a train

// Planned time at every stop of the pattern, given when the train leaves `stopId`.
export function plannedTimes(p: Pattern, stopId: string, at: Date): StopTime[] {
  const i = stopIndex(p, stopId);
  if (i < 0) return [];
  return p.map(([id, off]) => ({ id, at: new Date(at.getTime() + (off - p[i][1]) * 1000) }));
}

const finite = (n: unknown) =>
  n === undefined || !Number.isFinite(Number(n)) ? null : Number(n);

// One stop-time update: its delay, else its absolute time minus the planned one.
function updateDelay(u: StopTimeUpdate, plan: Date | undefined): number | null {
  const t = u.departure ?? u.arrival;
  const delay = finite(t?.delay);
  if (delay !== null) return Math.round(delay);
  const abs = finite(t?.time);
  return abs === null || !plan ? null : Math.round(abs - plan.getTime() / 1000);
}

// Delay (seconds) per stop from a trip update's stop-time updates: the feed's delay, or its
// absolute time minus the planned one (`planned`: stop id -> planned time).
export function stopDelays(
  updates: StopTimeUpdate[] | undefined,
  planned: Map<string, Date>,
): Map<string, number> {
  const out = new Map<string, number>();
  for (const u of updates ?? []) {
    const secs = updateDelay(u, u.stopId ? planned.get(u.stopId) : undefined);
    if (u.stopId && secs !== null) out.set(u.stopId, secs);
  }
  return out;
}

export type TripTime = { id: string; planned: Date; expected: Date | null };

// Expected time per stop: planned plus the stop's own delay, else the trip delay, else unknown.
export function expectedTimes(
  times: StopTime[],
  delays: Map<string, number>,
  tripDelay: number | null,
): TripTime[] {
  return times.map(({ id, at }) => {
    const secs = delays.get(id) ?? tripDelay;
    return {
      id,
      planned: at,
      expected: secs === null ? null : new Date(at.getTime() + secs * 1000),
    };
  });
}

export type Progress = { index: number; state: 'at' | 'arriving' | 'between' };
const PROGRESS: Record<VehicleStatus, Progress['state']> = {
  STOPPED_AT: 'at',
  INCOMING_AT: 'arriving',
  IN_TRANSIT_TO: 'between',
};

// Where the train is in the pattern: index of the stop it is at / arriving at / heading to
// (between = past the previous stop); null when the position's stop is not in the pattern.
export function trainProgress(p: Pattern, pos: VehiclePosition | null): Progress | null {
  const state = pos?.status ? PROGRESS[pos.status] : undefined;
  const index = pos?.stopId ? stopIndex(p, pos.stopId) : -1;
  return state && index >= 0 ? { index, state } : null;
}

export const tripEntry = (feed: TripUpdates | null, tripId: string) => {
  const u = feed?.entity?.find(e => e.tripUpdate?.trip?.tripId === tripId)?.tripUpdate;
  if (!u) return null;
  const delay = u.delay === undefined ? NaN : Number(u.delay);
  return { delay: Number.isFinite(delay) ? delay : null, stops: u.stopTimeUpdate };
};

export const findPosition = (feed: VehiclePositions | null, tripId: string) =>
  feed?.entity?.find(e => e.vehicle?.tripId === tripId)?.vehicle ?? null;

console.assert(
  (() => {
    const p: Pattern = [
      ['a', 0],
      ['b', 60],
      ['c', 180],
    ];
    const t = plannedTimes(p, 'b', new Date('2026-11-25T09:00:00Z'));
    const planned = new Map(t.map(x => [x.id, x.at]));
    const d = stopDelays(
      [
        { stopId: 'a', departure: { delay: 120 } },
        { stopId: 'b', arrival: { time: '1795597320' } },
        { stopId: 'zz', arrival: { delay: 5 } },
        { stopId: 'c' },
      ],
      planned,
    );
    const e = expectedTimes(t, d, 60);
    const pos = (stopId: string, status: VehicleStatus) => ({ stopId, status });
    return (
      t[0].at.toISOString() === '2026-11-25T08:59:00.000Z' &&
      t[2].at.toISOString() === '2026-11-25T09:02:00.000Z' &&
      d.get('a') === 120 &&
      d.get('b') === 120 &&
      d.get('zz') === 5 &&
      !d.has('c') &&
      e[2].expected?.toISOString() === '2026-11-25T09:03:00.000Z' &&
      expectedTimes(t, d, null)[2].expected === null &&
      trainProgress(p, pos('b', 'STOPPED_AT'))?.state === 'at' &&
      trainProgress(p, pos('c', 'INCOMING_AT'))?.index === 2 &&
      trainProgress(p, pos('c', 'IN_TRANSIT_TO'))?.state === 'between' &&
      trainProgress(p, pos('zz', 'STOPPED_AT')) === null &&
      trainProgress(p, null) === null &&
      tripEntry({ entity: [{ tripUpdate: { trip: { tripId: 'x' }, delay: 30 } }] }, 'x')
        ?.delay === 30 &&
      tripEntry(null, 'x') === null &&
      findPosition({ entity: [{ vehicle: { tripId: 'x' } }] }, 'y') === null
    );
  })(),
  'follow train: plannedTimes, stopDelays, expectedTimes, trainProgress, feed lookups',
);

// ---------------------------------------------------------------- CRTM direction assignment

// A timetable direction of a route at this stop: its headsign, the route patterns it uses and
// (when asked for a date) its planned departures around that date, in epoch ms.
export type Direction = { head: string; pis: number[]; times: number[] };

// Planned departures (ms) of one file row on the service days yesterday..tomorrow of `around`.
function rowTimes(file: BusFile, row: BusFile['d'][number], around: Date): number[] {
  const cal = file.c[row[1]];
  if (!cal) return [];
  const today = madridDate(around);
  return [shiftDay(today, -1), today, shiftDay(today, 1)]
    .filter(day => busActive(cal, day))
    .map(day => madridTime(day, row[0]).getTime());
}

// Distinct directions (headsigns) of `routeId` in this stop's timetable file; `around` fills
// `times` (else empty).
export function stopDirections(file: BusFile, routeId: string, around?: Date): Direction[] {
  const ri = file.r.indexOf(routeId);
  const byHead = new Map<string, Direction>();
  for (const row of file.d.filter(row => row[2] === ri)) {
    const [, , , h, pi] = row;
    const d = byHead.get(file.h[h]) ?? { head: file.h[h], pis: [], times: [] };
    d.pis.push(...(pi === undefined || d.pis.includes(pi) ? [] : [pi]));
    d.times.push(...(around ? rowTimes(file, row, around) : []));
    byHead.set(file.h[h], d);
  }
  return [...byHead.values()];
}

// Words that tell nothing about a destination ("VENUS NORTE" and "VENUS SUR" are one place).
const GENERIC_WORDS = new Set(['del', 'las', 'los', 'norte', 'sur', 'este', 'oeste']);
const nameWords = (s: string) =>
  fold(s)
    .split(/[^a-z0-9]+/)
    .filter(w => w.length > 2 && !GENERIC_WORDS.has(w));
const sharedWords = (a: string, b: string) => {
  const y = nameWords(b);
  return nameWords(a).filter(w => y.includes(w)).length;
};

// The directions sharing the highest positive score (empty when none scores).
function topScored(dirs: Direction[], score: (d: Direction) => number): Direction[] {
  const scored = dirs.map(d => ({ d, s: score(d) }));
  const best = Math.max(...scored.map(x => x.s));
  return best > 0 ? scored.filter(x => x.s === best).map(x => x.d) : [];
}

// Live times within this many minutes of a planned departure count as that departure.
const TIME_MATCH_MIN = 20;
// Closeness of the live time to the direction's nearest planned departure (0 = none near).
const timeScore = (when: Date) => (d: Direction) =>
  Math.max(
    0,
    TIME_MATCH_MIN - Math.min(...d.times.map(t => Math.abs(t - when.getTime()) / 60_000)),
  );

// The single top-scoring direction; a tie is broken by the nearest planned time.
function uniqueBest(
  dirs: Direction[],
  score: (d: Direction) => number,
  when: Date,
): Direction | undefined {
  const top = topScored(dirs, score);
  if (top.length < 2) return top[0];
  const near = topScored(top, timeScore(when));
  return near.length === 1 ? near[0] : undefined;
}

type DirCtx = {
  row: CrtmRow;
  stopId: string;
  patterns: Pattern[];
  nameOf: (id: string) => string | undefined;
};

// Is stop `id` the row's destination stop (CRTM code or name)?
const isDest = (c: DirCtx, id: string) =>
  (!!c.row.code && id === `par_${c.row.code}`) || sameName(c.nameOf(id) ?? '', c.row.dest);
// 1 when some pattern of the direction passes the test on its stop ids (all, or after this stop).
const anyPattern = (c: DirCtx, d: Direction, test: (p: Pattern) => boolean) =>
  d.pis.some(pi => !!c.patterns[pi] && test(c.patterns[pi])) ? 1 : 0;

// Rules in order: the destination is a direction's last stop; its headsign shares significant
// words with the destination text; the destination is somewhere after this stop; a planned
// departure of the direction is near the live time (CRTM sometimes names a stop that no pattern
// has). (Names in the tail come late: on a circular line both directions pass both ends.)
// Variants ending at the same stop ("PINTO", "PINTO (por ctra. A-42)") tie on the name rules;
// the nearest planned time breaks the tie.
const directionRules: ((c: DirCtx) => (d: Direction) => number)[] = [
  c => d => anyPattern(c, d, p => isDest(c, p.at(-1)?.[0] ?? '')),
  c => d => sharedWords(c.row.dest, d.head),
  c => d =>
    anyPattern(c, d, p => p.slice(stopIndex(p, c.stopId) + 1).some(([id]) => isDest(c, id))),
  c => timeScore(c.row.when),
];

// Timetable direction a live row belongs to, or undefined when unknown or ambiguous. One
// direction at the stop: that one.
export function directionOf(c: DirCtx, dirs: Direction[]): Direction | undefined {
  if (dirs.length < 2) return dirs[0];
  for (const rule of directionRules) {
    const d = uniqueBest(dirs, rule(c), c.row.when);
    if (d) return d;
  }
  return undefined;
}

// Live rows with `dest` replaced by the timetable headsign of their direction, so they group
// with (and replace) that direction's timetable rows. `patternsOf` and `dirsOf` are per route.
export function assignDirections(
  rows: CrtmRow[],
  file: BusFile,
  stopId: string,
  patternsOf: Record<string, Pattern[]>,
  nameOf: (id: string) => string | undefined,
): CrtmRow[] {
  const cache = new Map<string, Direction[]>();
  const dirsOf = (id: string) => {
    const dirs = cache.get(id) ?? stopDirections(file, id, rows[0]?.when);
    cache.set(id, dirs);
    return dirs;
  };
  return rows.map(row => {
    const patterns = patternsOf[row.routeId] ?? [];
    const d = directionOf({ row, stopId, patterns, nameOf }, dirsOf(row.routeId));
    return d ? { ...row, dest: d.head, pi: d.pis.length === 1 ? d.pis[0] : undefined } : row;
  });
}

console.assert(
  (() => {
    const now = new Date('2026-11-25T09:00:00Z');
    const names: Record<string, string> = {
      a: 'ESTRELLA POLAR NORTE',
      b: 'VENUS NORTE',
      s: 'PARLA CENTRO',
      c: 'VENUS SUR',
      d: 'ESTRELLA POLAR SUR',
      x: 'OTRA',
    };
    const nameOf = (id: string) => names[id];
    // ML4-like circular line: names in the patterns differ from CRTM's destinations.
    const p0: Pattern = [
      ['s', 0],
      ['b', 60],
      ['a', 120],
    ];
    const p1: Pattern = [
      ['s', 0],
      ['d', 60],
      ['c', 120],
    ];
    const file: BusFile = {
      kind: 'bus',
      r: ['L', 'M'],
      h: ['ESTRELLA POLAR NORTE', 'VENUS SUR', 'ONLY'],
      c: [],
      d: [
        [0, 0, 0, 0, 0],
        [0, 0, 0, 1, 1],
        [0, 0, 1, 2, 0],
      ],
    };
    const row = (routeId: string, dest: string, iso: string): CrtmRow => ({
      when: new Date(iso),
      routeId,
      line: routeId,
      dest,
      tram: false,
      metro: false,
      issue: '1',
    });
    const live = assignDirections(
      [
        row('L', 'VENUS NORTE', '2026-11-25T09:10:00Z'),
        row('L', 'ESTRELLA POLAR SUR', '2026-11-25T09:11:00Z'),
        row('M', 'WHATEVER', '2026-11-25T09:12:00Z'),
        row('L', 'OTRA', '2026-11-25T09:13:00Z'),
      ],
      file,
      's',
      { L: [p0, p1] },
      nameOf,
    );
    const dep = (head: string, iso: string): Departure => ({
      ...testDep('L', iso),
      dest: head,
    });
    const out = mergeCrtm(
      [
        dep('VENUS SUR', '2026-11-25T09:09:30Z'),
        dep('VENUS SUR', '2026-11-25T09:30:00Z'),
        dep('ESTRELLA POLAR NORTE', '2026-11-25T09:11:20Z'),
        dep('ESTRELLA POLAR NORTE', '2026-11-25T09:40:00Z'),
      ],
      live.slice(0, 2),
      {},
      now,
    );
    const groups = out.map(d => `${d.dest}${d.live ? 'L' : ''}`).join('|');
    return (
      live[0].dest === 'VENUS SUR' &&
      live[0].pi === 1 &&
      live[1].dest === 'ESTRELLA POLAR NORTE' &&
      live[2].dest === 'ONLY' &&
      live[3].dest === 'OTRA' &&
      groups === 'VENUS SURL|ESTRELLA POLAR NORTEL|VENUS SUR|ESTRELLA POLAR NORTE'
    );
  })(),
  'assignDirections: ML4 words match, single direction takes headsign, unmatched keeps CRTM text, per-direction replacement',
);

console.assert(
  (() => {
    // Line 471 at Parla: two variants end at the same stop; line 463: CRTM names a stop no
    // pattern has. 2026-11-26 is a Thursday; 10:47 / 11:07 Madrid = 09:47 / 10:07 UTC.
    const p: Pattern = [
      ['s', 0],
      ['end', 60],
    ];
    const file: BusFile = {
      kind: 'bus',
      r: ['L'],
      h: ['PINTO', 'PINTO (por ctra. A-42)'],
      c: [[0b1111111, 20260101, 20261231, [], []]],
      d: [
        [10 * 3600 + 47 * 60, 0, 0, 0, 0],
        [11 * 3600 + 7 * 60, 0, 0, 1, 0],
      ],
    };
    const row = (dest: string, iso: string): CrtmRow => ({
      when: new Date(iso),
      routeId: 'L',
      line: 'L',
      dest,
      tram: false,
      metro: false,
      issue: '1',
    });
    const nameOf = (id: string) => (id === 'end' ? 'SUR-POLIDEPORTIVO' : 'X');
    const out = assignDirections(
      [
        row('SUR-POLIDEPORTIVO', '2026-11-26T09:48:00Z'),
        row('AV.PRINCESA JUANA AUSTRIA', '2026-11-26T10:06:00Z'),
        row('AV.PRINCESA JUANA AUSTRIA', '2026-11-26T15:00:00Z'),
      ],
      file,
      's',
      { L: [p] },
      nameOf,
    );
    return (
      out[0].dest === 'PINTO' &&
      out[1].dest === 'PINTO (por ctra. A-42)' &&
      out[2].dest === 'AV.PRINCESA JUANA AUSTRIA'
    );
  })(),
  'assignDirections: nearest planned time breaks ties and matches unknown destinations',
);

// ---------------------------------------------------------------- Stop info and terminus text

// Today's day type in Madrid: Sunday = fes, Saturday = sab, else lab (holidays are not known).
export function dayType(now: Date): DayType {
  const wd = new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone: MADRID }).format(
    now,
  );
  if (wd === 'Sun') return 'fes';
  return wd === 'Sat' ? 'sab' : 'lab';
}
console.assert(
  dayType(new Date('2026-11-25T12:00:00Z')) === 'lab' &&
    dayType(new Date('2026-11-28T12:00:00Z')) === 'sab' &&
    dayType(new Date('2026-11-29T12:00:00Z')) === 'fes' &&
    dayType(new Date('2026-11-28T23:30:00Z')) === 'fes',
  'dayType: Madrid weekday, not UTC',
);

// "cada 11–23 min (07:00–23:59)", or "cada 12 min (…)" when both ends agree; '' when unknown.
export function svcText(svc: Svc | undefined): string {
  if (!svc) return '';
  const [from, to, lo, hi] = svc;
  return `cada ${lo === hi ? lo : `${lo}–${hi}`} min (${from}–${to})`;
}
console.assert(
  svcText(['07:00', '23:59', 11, 23]) === 'cada 11–23 min (07:00–23:59)' &&
    svcText(['07:00', '23:59', 12, 12]) === 'cada 12 min (07:00–23:59)' &&
    svcText(undefined) === '',
  'svcText',
);

export type End = 'cabecera' | 'final' | null;
// Role of a stop in a route's patterns: first stop of any pattern = cabecera, only ever last =
// final, else (or absent) null.
export function classifyEnd(patterns: Pattern[], stopId: string): End {
  const here = patterns.filter(p => stopIndex(p, stopId) >= 0);
  if (here.some(p => p[0][0] === stopId)) return 'cabecera';
  return here.length > 0 && here.every(p => p.at(-1)?.[0] === stopId) ? 'final' : null;
}

// Distinct last-stop ids of the patterns that still continue after `stopId`.
export function destinationsAfter(patterns: Pattern[], stopId: string): string[] {
  const ids = patterns.filter(p => stopsAfter(p, stopId) > 0).map(p => p.at(-1)?.[0] ?? '');
  return [...new Set(ids.filter(Boolean))];
}
console.assert(
  (() => {
    const out: Pattern[] = [
      [
        ['t', 0],
        ['m', 60],
        ['z', 120],
      ],
      [
        ['z', 0],
        ['m', 60],
        ['t', 120],
      ],
    ];
    const through: Pattern[] = [
      [
        ['a', 0],
        ['m', 60],
        ['b', 120],
      ],
    ];
    return (
      classifyEnd(out, 't') === 'cabecera' &&
      classifyEnd([out[1]], 't') === 'final' &&
      classifyEnd(through, 'm') === null &&
      classifyEnd(through, 'zz') === null &&
      destinationsAfter(out, 'm').join() === 'z,t' &&
      destinationsAfter(out, 't').join() === 'z' &&
      destinationsAfter([out[1]], 't').length === 0
    );
  })(),
  'classifyEnd: cabecera / final / through, destinationsAfter',
);

export const NEARBY_M = 150;
// Other stops (different id) within `radius` metres, nearest first.
export const nearbyStops = (all: Stop[], here: Stop, radius = NEARBY_M): NearStop[] =>
  all
    .filter(s => s.id !== here.id)
    .map(s => ({ ...s, dist: metres(here, s) }))
    .filter(s => s.dist <= radius)
    .sort((a, b) => a.dist - b.dist);

// Stop type for the info panel.
export function stopKind(s: Stop): string {
  if (s.k === 'r') return 'Cercanías';
  if (s.k === 'm') return 'Metro';
  if (s.k === 't') return 'tranvía';
  if (s.k === 'e') return 'EMT';
  return s.u ? 'urbano' : 'interurbano';
}

// Where a line's data comes from.
export function sourceOf(routeId: string, r: RouteInfo | undefined): string {
  if (routeId.startsWith('emt_')) return 'EMT MobilityLabs (en vivo)';
  if (r?.metro) return 'CRTM (en vivo)';
  if (r?.tram) return 'CRTM (en vivo) y horario';
  if (r?.op === 'ouigo' || isOuigo(routeId)) return 'Ouigo: solo horario';
  if (!r || r.ld || routeId.startsWith('10T')) return 'Renfe GTFS-RT (en vivo) y horario';
  return 'CRTM (en vivo) y horario';
}

// Typical headway in minutes per route from upcoming departures: the median gap between
// consecutive departures of one destination (>= 2 needed), pooled over destinations.
export function typicalGaps(deps: Departure[]): Map<string, number> {
  const byDest = new Map<string, Departure[]>();
  for (const d of deps) {
    const k = `${d.routeId}|${d.dest}`;
    byDest.set(k, [...(byDest.get(k) ?? []), d]);
  }
  const gaps = new Map<string, number[]>();
  for (const list of byDest.values()) {
    const t = list.map(d => d.expected.getTime()).sort((a, b) => a - b);
    const g = gaps.get(list[0].routeId) ?? [];
    t.slice(1).forEach((x, i) => g.push((x - t[i]) / 60_000));
    gaps.set(list[0].routeId, g);
  }
  const out = new Map<string, number>();
  for (const [id, g] of gaps) {
    if (!g.length) continue;
    g.sort((a, b) => a - b);
    out.set(id, Math.max(1, Math.round(g[Math.floor((g.length - 1) / 2)])));
  }
  return out;
}
console.assert(
  (() => {
    const at = (m: number, dest: string) =>
      ({ routeId: 'r', dest, expected: new Date(m * 60_000) }) as Departure;
    const g = typicalGaps([at(0, 'a'), at(10, 'a'), at(21, 'a'), at(5, 'b'), at(99, 'c')]);
    return g.get('r') === 10 && typicalGaps([at(0, 'a')]).size === 0;
  })(),
  'typicalGaps: median gap per destination, single departures ignored',
);

// Natural order for line groups: line (C2 < C10, 10 < 421), then destination as shown
// (without "Madrid-"); accents ignored.
export function compareLines(
  a: { line: string; dest: string },
  b: { line: string; dest: string },
) {
  const opts = { numeric: true, sensitivity: 'base' } as const;
  return (
    a.line.localeCompare(b.line, 'es', opts) ||
    short(a.dest).localeCompare(short(b.dest), 'es', opts)
  );
}
console.assert(
  (() => {
    const l = (line: string, dest = 'x') => ({ line, dest });
    return (
      compareLines(l('C2'), l('C10')) < 0 &&
      compareLines(l('C4a'), l('C4b')) < 0 &&
      compareLines(l('10'), l('421')) < 0 &&
      compareLines(l('421'), l('10')) > 0 &&
      compareLines(l('C1', 'Álcala'), l('C1', 'Béjar')) < 0 &&
      compareLines(l('C1', 'a'), l('C1', 'A')) === 0 &&
      compareLines(l('C3', 'Madrid-Chamartín-Clara Campoamor'), l('C3', 'Aranjuez')) > 0
    );
  })(),
  'compareLines: natural line order, then destination',
);

// Settings "estado de las fuentes": one diagnostic request per feed (rt.php, no cache involved).
export type ProbeKind = 'renfe' | 'crtm' | 'emt';
export type ProbeCheck = { key: string; label: string; kind: ProbeKind; query: string };
export type ProbeResult = {
  status: number; // HTTP status, 0 = none
  ms: number; // wall time
  ageS: number; // X-Data-Age: seconds since rt.php fetched its copy
  upstream?: UpstreamError;
  json: unknown;
  error?: 'timeout' | 'network';
  limitMs: number; // the timeout that applied
  text?: string; // the response body as received (first PROBE_TEXT_MAX chars)
  at?: number; // when the request started (ms)
};
export const PROBE_TEXT_MAX = 20_000;
export type Health = { level: 'ok' | 'warn' | 'bad'; text: string };

const CRTM_SAVED = /^par_((?:8|10|4)_\d+)$/;
const MAX_CRTM_CHECKS = 6;
const MAX_EMT_CHECKS = 3;
const REFERENCE_CRTM: Saved = { id: 'par_8_17480', name: 'Moncloa (parada de referencia)' };

// The checks to run: Renfe, CRTM for saved CRTM stops (or one reference stop), EMT for saved EMT stops.
export function healthChecks(saved: Saved[]): ProbeCheck[] {
  const crtm = saved.filter(s => CRTM_SAVED.test(s.id)).slice(0, MAX_CRTM_CHECKS);
  const emt = saved.filter(s => /^emt_\d+$/.test(s.id)).slice(0, MAX_EMT_CHECKS);
  return [
    { key: 'renfe', label: 'Renfe Cercanías', kind: 'renfe', query: 'f=trip_updates' },
    ...(crtm.length ? crtm : [REFERENCE_CRTM]).map(s => ({
      key: `crtm:${s.id}`,
      label: `CRTM · ${short(s.name)}`,
      kind: 'crtm' as const,
      query: `f=crtm&stop=${s.id.replace('par_', '')}`,
    })),
    ...emt.map(s => ({
      key: `emt:${s.id}`,
      label: `EMT · ${short(s.name)}`,
      kind: 'emt' as const,
      query: `f=emt&stop=${s.id.replace('emt_', '')}`,
    })),
  ];
}
console.assert(
  (() => {
    const mk = (id: string) => ({ id, name: id });
    const none = healthChecks([mk('18000')]);
    const many7 = healthChecks(
      ['par_8_1', 'par_10_2', 'par_4_3', 'par_8_4', 'par_8_5', 'par_8_6', 'par_8_7', 'x'].map(
        mk,
      ),
    );
    const emt = healthChecks([mk('emt_72'), mk('emt_1'), mk('emt_2'), mk('emt_3')]);
    return (
      none.length === 2 &&
      none[1].query === 'f=crtm&stop=8_17480' &&
      many7.filter(c => c.kind === 'crtm').length === 6 &&
      many7[2].query === 'f=crtm&stop=10_2' &&
      emt.filter(c => c.kind === 'emt').length === 3 &&
      emt[2].query === 'f=emt&stop=72'
    );
  })(),
  'healthChecks',
);

// Saved stops whose live times are worth fetching ahead at app start, in saved order: CRTM bus,
// light rail and Metro stops (max 6) and EMT stops (max 3), the same caps as the health check,
// to keep the shared CRTM budget in mind. The stop on screen may be among them; the fetch memo
// shares its request.
export function prefetchTargets(saved: Saved[]) {
  return {
    crtm: saved
      .filter(s => CRTM_SAVED.test(s.id))
      .slice(0, MAX_CRTM_CHECKS)
      .map(s => s.id),
    emt: saved
      .filter(s => /^emt_\d+$/.test(s.id))
      .slice(0, MAX_EMT_CHECKS)
      .map(s => s.id),
  };
}
console.assert(
  (() => {
    const ids = ['18000', 'par_8_1', 'par_10_2', 'emt_72', 'par_4_3', 'par_8_4', 'par_8_5'];
    const more = ['par_8_6', 'par_8_7', 'emt_1', 'emt_2', 'emt_3'];
    const t = prefetchTargets([...ids, ...more].map(id => ({ id, name: id })));
    return (
      t.crtm.join() === 'par_8_1,par_10_2,par_4_3,par_8_4,par_8_5,par_8_6' &&
      t.emt.join() === 'emt_72,emt_1,emt_2' &&
      prefetchTargets([{ id: '18000', name: 'Atocha' }]).crtm.length === 0
    );
  })(),
  'prefetchTargets',
);

// CRTM rows by time: all, within [now - 1 min, now + 2 h] (soon), of those with seconds (live:
// an estimate) vs a whole minute (CRTM timetable), and later than 2 h. `now` is the response's
// own `actualDate` when it parses, else `fallback`.
export type CrtmCounts = {
  total: number;
  soon: number;
  live: number;
  sched: number;
  later: number;
};
const WINDOW_MS = 2 * 3_600_000;
const crtmBucket = (ms: number, now: number) => {
  if (ms > now + WINDOW_MS) return 'later';
  if (!(ms >= now - 60_000)) return null;
  return Math.floor(ms / 1000) % 60 === 0 ? 'sched' : 'live';
};
export function crtmCounts(json: CrtmJson | null, fallback: Date): CrtmCounts {
  const st = json?.stopTimes;
  const ref = new Date(st?.actualDate ?? '').getTime();
  const now = Number.isNaN(ref) ? fallback.getTime() : ref;
  const out = { total: 0, soon: 0, live: 0, sched: 0, later: 0 };
  for (const t of many(st?.times?.Time)) {
    const bucket = crtmBucket(new Date(t?.time ?? '').getTime(), now);
    out.total++;
    if (bucket) out[bucket]++;
    if (bucket === 'live' || bucket === 'sched') out.soon++;
  }
  return out;
}
console.assert(
  (() => {
    const t = (time: string) => ({ line: { codLine: '8__1___' }, time });
    const c = crtmCounts(
      {
        stopTimes: {
          actualDate: '2026-11-26T15:00:00+01:00',
          times: {
            Time: [
              t('2026-11-26T14:50:00+01:00'),
              t('2026-11-26T15:00:30+01:00'),
              t('2026-11-26T15:18:00+01:00'),
              t('2026-11-26T17:30:00+01:00'),
            ],
          },
        },
      },
      new Date(0),
    );
    const one = crtmCounts(
      { stopTimes: { times: { Time: t('2026-11-26T15:00:30+01:00') } } },
      new Date('2026-11-26T14:00:00+01:00'),
    );
    return (
      c.total === 4 &&
      c.soon === 2 &&
      c.live === 1 &&
      c.sched === 1 &&
      c.later === 1 &&
      one.total === 1 &&
      one.soon === 1 &&
      one.live === 1 &&
      crtmCounts(null, new Date()).total === 0
    );
  })(),
  'crtmCounts',
);

const secsText = (ms: number) =>
  `${(ms / 1000).toLocaleString('es-ES', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} s`;
const countText = (n: number, one: string, many: string) =>
  `${n.toLocaleString('es-ES')} ${n === 1 ? one : many}`;

// What the body holds: line start (`bien`, or why not) and the counts.
type Summary = { level: Health['level']; head: string; tail: string };
const good = (tail: string): Summary => ({ level: 'ok', head: 'bien', tail });
const empty = (head = 'respuesta vacía'): Summary => ({ level: 'warn', head, tail: '' });

function crtmSummary(json: unknown, now: Date): Summary {
  const c = crtmCounts(json as CrtmJson | null, now);
  if (c.total === 0) return empty();
  if (c.soon > 0) {
    return good(
      `${countText(c.soon, 'próxima', 'próximas')} (${c.live} en vivo, ${c.sched} horario)`,
    );
  }
  const s = empty('sin horas en las próximas 2 h');
  return { ...s, tail: c.later ? `${c.later} más tarde` : '' };
}

function summarise(kind: ProbeKind, json: unknown, now: Date): Summary {
  if (kind === 'crtm') return crtmSummary(json, now);
  if (kind === 'emt') {
    const n = parseEmt(json as EmtJson | null, now).length;
    return n ? good(countText(n, 'llegada', 'llegadas')) : empty('sin llegadas');
  }
  const entities = (json as { entity?: unknown } | null)?.entity;
  const n = Array.isArray(entities) ? entities.length : 0;
  return n ? good(countText(n, 'tren', 'trenes')) : empty();
}

// The request itself failed (no answer, HTTP error, body not JSON): text, else null.
function failureText(p: ProbeResult, now: Date): string | null {
  if (p.error === 'timeout') return `sin respuesta en ${Math.round(p.limitMs / 1000)} s`;
  if (p.error) return 'sin conexión';
  const at = hhmm(now);
  if (p.status < 200 || p.status >= 300) {
    const why = upstreamMeaning(p.upstream ?? { code: p.status, kind: 'http' });
    return `error ${why} · ${at}`;
  }
  return p.json === null ? `respuesta no válida · ${at}` : null;
}

// One status line for a finished probe; a healthy one starts with `bien`.
export function healthLine(kind: ProbeKind, p: ProbeResult, now: Date): Health {
  const failure = failureText(p, now);
  if (failure) return { level: 'bad', text: failure };
  const s = summarise(kind, p.json, now);
  const age = p.ageS > 0 ? `copia de hace ${Math.round(p.ageS)} s` : '';
  const text = [s.head, secsText(p.ms), age, s.tail].filter(Boolean).join(' · ');
  return { level: s.level, text };
}
console.assert(
  (() => {
    const now = new Date('2026-11-26T14:00:00Z');
    const p = (o: Partial<ProbeResult>): ProbeResult => ({
      status: 200,
      ms: 600,
      ageS: 0,
      json: null,
      limitMs: 65_000,
      ...o,
    });
    const at = (time: string) => ({ line: { codLine: '8__1___' }, time });
    const crtm = healthLine(
      'crtm',
      p({
        ageS: 12,
        json: {
          stopTimes: {
            times: { Time: [at('2026-11-26T14:10:30Z'), at('2026-11-26T14:20:00Z')] },
          },
        },
      }),
      now,
    );
    const late = healthLine(
      'crtm',
      p({ json: { stopTimes: { times: { Time: at('2026-11-26T18:00:00Z') } } } }),
      now,
    );
    const none = healthLine('crtm', p({ ms: 400, json: { stopTimes: { times: {} } } }), now);
    const renfe = healthLine('renfe', p({ ageS: 8, json: { entity: [{}, {}] } }), now);
    const err = healthLine(
      'crtm',
      p({ status: 502, upstream: { code: 200, kind: 'html' } }),
      now,
    );
    return (
      crtm.text === 'bien · 0,6 s · copia de hace 12 s · 2 próximas (1 en vivo, 1 horario)' &&
      late.level === 'warn' &&
      late.text === 'sin horas en las próximas 2 h · 0,6 s · 1 más tarde' &&
      none.text === 'respuesta vacía · 0,4 s' &&
      renfe.text === 'bien · 0,6 s · copia de hace 8 s · 2 trenes' &&
      err.level === 'bad' &&
      err.text.startsWith('error HTTP 200 · respuesta no válida (HTML)') &&
      healthLine('emt', p({ error: 'timeout' }), now).text === 'sin respuesta en 65 s' &&
      healthLine('emt', p({ error: 'network' }), now).text === 'sin conexión'
    );
  })(),
  'healthLine',
);
