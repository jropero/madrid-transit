// Builds the static Madrid timetable into public/data/: Renfe Cercanías (route_id 10T…) and, when
// available, CRTM interurban buses (ArcGIS item, NAP feed 1361 as fallback) and light rail (Metro
// Ligero ML1-ML3, Tranvía de Parla ML4; CRTM open data), both timetable only, plus Metro de Madrid
// and EMT stops/routes (live only). Plain Node, no dependencies.
// The downloaded GTFS zips are untrusted data: they are only parsed (never executed), live in
// .cache/, and single files are streamed through `unzip -p` (shapes.txt is never extracted).
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { gzipSync } from 'node:zlib';

const ROOT = new URL('..', import.meta.url).pathname;
const CACHE = `${ROOT}.cache/`;
const OUT = `${ROOT}public/data/`;
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const RENFE = {
  url: 'https://ssl.renfe.com/ftransit/Fichero_CER_FOMENTO/fomento_transit.zip',
  zip: `${CACHE}fomento.zip`,
};
const TOWN_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const CRTM_LAYERS = 'https://services5.arcgis.com/UxADft6QPcvFyDU1/arcgis/rest/services';
const NEAREST_TOWN_M = 1500;
// CRTM feeds sharing one pipeline. k: stop kind in stops.json; auth: needs the NAP ApiKey header;
// fallback: tried only after the main download failed (and, for NAP, only with a token);
// layer + townCache: the ArcGIS layer (CODIGOESTACION = stop_code) that gives each stop its town.
const BUS = {
  key: 'bus',
  label: 'bus',
  k: 'b',
  color: '8EBF42',
  auth: false,
  // Public ArcGIS item "GTFS Red de Autobuses Interurbanos" (73 MB, same file as NAP 1361, no key).
  url: 'https://www.arcgis.com/sharing/rest/content/items/885399f83408473c8d815e40c5e702b7/data',
  fallback: { auth: true, url: 'https://nap.transportes.gob.es/api/Fichero/download/1361' },
  zip: `${CACHE}bus.zip`,
  layer: 'M8_Red',
  townCache: `${CACHE}crtm-stops.json`,
};
// Light rail: public ArcGIS item (no key), 417 KB.
const ML = {
  key: 'ml',
  label: 'light rail',
  k: 't',
  color: '7DB713',
  auth: false,
  url: 'https://www.arcgis.com/sharing/rest/content/items/aaed26cc0ff64b0c947ac0bc3e033196/data',
  zip: `${CACHE}ml.zip`,
  layer: 'M10_Red',
  townCache: `${CACHE}crtm-m10.json`,
};

// Metro de Madrid: public ArcGIS item "GTFS Red de Metro" (1.5 MB). Stale calendar (ends
// 2025-05), so only stations, lines and colours are used; live times come from rt.php (4_<n>).
const METRO = {
  key: 'metro',
  label: 'metro',
  k: 'm',
  color: '2DBEF0',
  url: 'https://www.arcgis.com/sharing/rest/content/items/5c7f2951962540d69ffe8f640d94c246/data',
  zip: `${CACHE}metro.zip`,
  layer: 'M4_Red',
  townCache: `${CACHE}crtm-m4.json`,
};

// EMT city buses: public ArcGIS item (CRTM "GTFS Red de EMT", no key, 21 MB). Frequency-based
// trips, so only routes.txt and stops.txt are read: live arrivals come from rt.php (?f=emt).
const EMT = {
  key: 'emt',
  label: 'EMT',
  color: '0178BC',
  url: 'https://www.arcgis.com/sharing/rest/content/items/868df0e58fca47e79b942902dffd7da0/data',
  zip: `${CACHE}emt.zip`,
};

// Minimal CSV line split with quote support; every field is trimmed (GTFS here is space-padded).
export function splitCsv(line) {
  const out = [];
  let cur = '';
  let quoted = false;
  for (const ch of line) {
    if (ch === '"') quoted = !quoted;
    else if (ch === ',' && !quoted) {
      out.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  out.push(cur.trim());
  return out;
}
console.assert(
  splitCsv('a  ,"b, c" ,  d').join('|') === 'a|b, c|d',
  'splitCsv trims and keeps quoted commas',
);

// Equirectangular approximation (same as src/gtfs.ts).
const metres = (a, b) => {
  const k = 111_320;
  const x = (b.lon - a.lon) * k * Math.cos(((a.lat + b.lat) / 2) * (Math.PI / 180));
  return Math.round(Math.hypot(x, (b.lat - a.lat) * k));
};
console.assert(
  Math.abs(metres({ lat: 40.4065, lon: -3.6893 }, { lat: 40.4723, lon: -3.6826 }) - 7300) < 400,
  'metres',
);

// "06:35:00" -> seconds since service-day midnight (may exceed 24h).
export const toSecs = t => {
  const [h, m, s] = t.split(':').map(Number);
  return h * 3600 + m * 60 + s;
};
console.assert(toSecs('25:10:30') === 90630, 'toSecs');

const fresh = zip => existsSync(zip) && Date.now() - statSync(zip).mtimeMs < MAX_AGE_MS;

// NAP_TOKEN from the environment or a `NAP_TOKEN=` line of .env (only read when a download is
// needed; never printed).
function napToken() {
  if (process.env.NAP_TOKEN) return process.env.NAP_TOKEN;
  try {
    const line = readFileSync(`${ROOT}.env`, 'utf8')
      .split('\n')
      .find(l => l.startsWith('NAP_TOKEN='));
    return (
      line
        ?.slice('NAP_TOKEN='.length)
        .trim()
        .replace(/^["']|["']$/g, '') ?? ''
    );
  } catch {
    return '';
  }
}

// Downloads to a temp name first so an interrupted download never becomes the cached zip.
async function download(feed, headers = {}) {
  console.log('downloading', feed.url);
  const res = await fetch(feed.url, { headers });
  if (!res.ok || !res.body) throw new Error(`download failed: HTTP ${res.status}`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(`${feed.zip}.part`));
  renameSync(`${feed.zip}.part`, feed.zip);
  return res.headers.get('last-modified');
}

// Madrid calendar date (yyyymmdd) of a Date.
const madridYmd = d =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid' }).format(d).replaceAll('-', '');
console.assert(madridYmd(new Date('2026-11-25T23:30:00Z')) === '20261126', 'madridYmd');

// Renfe's zip date (HTTP Last-Modified, else the download date), kept next to the zip so a
// cached zip keeps reporting it. Shown in the app as "horario actualizado".
const UPDATED = `${RENFE.zip}.updated`;
function renfeUpdated() {
  try {
    const v = readFileSync(UPDATED, 'utf8').trim();
    if (/^\d{8}$/.test(v)) return v;
  } catch {
    // no sidecar: fall back to the zip's own date
  }
  return madridYmd(statSync(RENFE.zip).mtime);
}

async function ensureRenfe() {
  mkdirSync(CACHE, { recursive: true });
  if (fresh(RENFE.zip)) return console.log('using cached Renfe zip');
  const lm = await download(RENFE);
  const date = lm && !Number.isNaN(Date.parse(lm)) ? new Date(lm) : new Date();
  await writeFile(UPDATED, madridYmd(date));
}

// Request headers of a feed; null when it needs a NAP token that is missing.
function feedHeaders(feed) {
  if (!feed.auth) return {};
  const token = napToken();
  return token ? { ApiKey: token } : null;
}

// A cached zip younger than 24 h needs no token. Returns false when the feed must be skipped.
async function ensureFeed(feed) {
  mkdirSync(CACHE, { recursive: true });
  if (fresh(feed.zip)) {
    console.log(`using cached ${feed.label} zip`);
    return true;
  }
  for (const source of [feed, feed.fallback]) {
    if (source && (await tryDownload(feed, source))) return true;
  }
  console.warn(`${feed.label} download failed: skipping`);
  return existsSync(feed.zip);
}

// One download attempt of `source` (the feed itself or its fallback) into the feed's zip.
async function tryDownload(feed, source) {
  const headers = feedHeaders(source);
  if (!headers) {
    console.warn(`NAP_TOKEN missing: cannot use the ${feed.label} fallback`);
    return false;
  }
  try {
    await download({ url: source.url, zip: feed.zip }, headers);
    return true;
  } catch (err) {
    console.warn(`${feed.label} download failed (${err.message})`);
    return false;
  }
}

// Streams one file of a zip as objects keyed by header name.
async function* rows(zip, name) {
  const unzip = spawn('unzip', ['-p', zip, name], { stdio: ['ignore', 'pipe', 'inherit'] });
  const done = new Promise((resolve, reject) => {
    unzip.on('error', reject);
    unzip.on('close', code =>
      code === 0 ? resolve() : reject(new Error(`unzip ${name}: ${code}`)),
    );
  });
  const rl = createInterface({ input: unzip.stdout, crlfDelay: Infinity });
  let head = null;
  for await (const line of rl) {
    if (!line.trim()) continue;
    const f = splitCsv(line);
    if (!head) head = f.map(h => h.replace(/^\uFEFF/, ''));
    else yield Object.fromEntries(head.map((h, i) => [h, f[i] ?? '']));
  }
  await done;
}

const indexOf = (arr, v) => {
  const i = arr.indexOf(v);
  return i >= 0 ? i : arr.push(v) - 1;
};
const coord = v => Number(Number(v).toFixed(5));

// Stop patterns per route: the unique stop sequences with offsets (seconds) from the first stop.
// pats.add(routeId, stops) -> pattern index; pats.routes: routeId -> { list, index }.
function makePatterns() {
  const routes = new Map();
  return {
    routes,
    add(routeId, stops) {
      const r = routes.get(routeId) ?? { list: [], index: new Map() };
      routes.set(routeId, r);
      const key = stops.join();
      const known = r.index.get(key);
      if (known !== undefined) return known;
      r.list.push(stops);
      r.index.set(key, r.list.length - 1);
      return r.list.length - 1;
    },
  };
}

// [[stopId, offsetSecs]] of a trip's sorted rows [[seq, secs, stopId]]; consecutive repeats of
// one stop (after id mapping) collapse into the first.
function patternOf(list, mapId = id => id) {
  const out = [];
  const first = list[0][1];
  for (const [, secs, id] of list) {
    const stop = mapId(id);
    if (stop && stop !== out.at(-1)?.[0]) out.push([stop, secs - first]);
  }
  return out;
}
console.assert(
  JSON.stringify(
    patternOf(
      [
        [1, 100, 'a'],
        [2, 160, 'b'],
        [3, 220, 'b2'],
      ],
      id => (id === 'b2' ? 'b' : id),
    ),
  ) === '[["a",0],["b",60]]',
  'patternOf offsets and collapse',
);

// Per-stop trip rows: sorted by departure, the last stop of each trip is dropped (no departure
// there). `byTrip` maps tripId -> [[seq, secs, stopId]]. `patOf(tripId, list)` gives the trip's
// pattern index, yielded as `pi` with every row.
function* tripCalls(byTrip, patOf) {
  for (const [tripId, list] of byTrip) {
    list.sort((a, b) => a[0] - b[0]);
    const pi = patOf(tripId, list);
    for (const [, secs, stopId] of list.slice(0, -1)) yield { tripId, list, secs, stopId, pi };
  }
}

async function loadByTrip(zip, wanted) {
  const byTrip = new Map(); // tripId -> [[seq, depSecs, stopId]]
  const stopIds = new Map(); // intern stop ids: 1.3M rows share ~9k strings
  for await (const s of rows(zip, 'stop_times.txt')) {
    if (!wanted.has(s.trip_id)) continue;
    const list = byTrip.get(s.trip_id) ?? [];
    const stopId = stopIds.get(s.stop_id) ?? stopIds.set(s.stop_id, s.stop_id).get(s.stop_id);
    list.push([Number(s.stop_sequence), toSecs(s.departure_time || s.arrival_time), stopId]);
    byTrip.set(s.trip_id, list);
  }
  return byTrip;
}

const pad = n => String(n).padStart(2, '0');
const ymd = d => `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
const parseYmd = s => new Date(Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8)));
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

// ---------------------------------------------------------------- Renfe

const isMadrid = routeId => routeId.startsWith('10T');

async function renfeRoutes(zip) {
  const routes = {};
  for await (const r of rows(zip, 'routes.txt')) {
    if (!isMadrid(r.route_id)) continue;
    routes[r.route_id] = {
      line: r.route_short_name,
      color: `#${r.route_color || '75B6E0'}`,
      text: `#${r.route_text_color || 'FFFFFF'}`,
    };
  }
  return routes;
}

async function renfeTrips(zip, routes) {
  const trips = new Map(); // tripId -> { routeId, serviceId }
  for await (const t of rows(zip, 'trips.txt')) {
    if (routes[t.route_id])
      trips.set(t.trip_id, { routeId: t.route_id, serviceId: t.service_id });
  }
  return trips;
}

// Every date a calendar row runs on (its weekday flags between start_date and end_date).
function* datesOf(c) {
  const end = parseYmd(c.end_date);
  for (let d = parseYmd(c.start_date); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    if (c[WEEKDAYS[d.getUTCDay()]] === '1') yield ymd(d);
  }
}

async function renfeDays(zip, usedServices) {
  const days = {};
  for await (const c of rows(zip, 'calendar.txt')) {
    if (!usedServices.has(c.service_id)) continue;
    for (const key of datesOf(c)) (days[key] ??= []).push(c.service_id);
  }
  const keys = Object.keys(days).sort();
  return { days, from: keys[0], to: keys.at(-1) };
}

// Per stop, compact: { r: routeIds, d: destStopIds, s: { serviceId: [[secs, tripSuffix, ri, di, pi]] } }
// (pi = index into the route's patterns in route/<routeId>.json).
// The trip id is stored without its service-id prefix (the client re-adds it).
function renfeFiles(trips, byTrip, pats) {
  const files = new Map();
  const patOf = (tripId, list) => pats.add(trips.get(tripId).routeId, patternOf(list));
  for (const { tripId, list, secs, stopId, pi } of tripCalls(byTrip, patOf)) {
    const { routeId, serviceId } = trips.get(tripId);
    const suffix = tripId.startsWith(serviceId) ? tripId.slice(serviceId.length) : `!${tripId}`;
    const f = files.get(stopId) ?? { r: [], d: [], s: {} };
    const row = [secs, suffix, indexOf(f.r, routeId), indexOf(f.d, list.at(-1)[2]), pi];
    (f.s[serviceId] ??= []).push(row);
    files.set(stopId, f);
  }
  for (const f of files.values()) {
    for (const list of Object.values(f.s)) list.sort((a, b) => a[0] - b[0]);
  }
  return files;
}

async function renfeStops(zip, wanted) {
  const stops = [];
  for await (const s of rows(zip, 'stops.txt')) {
    if (!wanted.has(s.stop_id)) continue;
    stops.push({
      id: s.stop_id,
      name: s.stop_name,
      lat: coord(s.stop_lat),
      lon: coord(s.stop_lon),
      wa: s.wheelchair_boarding === '1',
      k: 'r',
    });
  }
  return stops;
}

async function buildRenfe() {
  await ensureRenfe();
  const zip = RENFE.zip;
  const routes = await renfeRoutes(zip);
  const trips = await renfeTrips(zip, routes);
  const byTrip = await loadByTrip(zip, trips);
  const pats = makePatterns();
  const files = renfeFiles(trips, byTrip, pats);
  // Every stop a Madrid trip touches, termini included (they name destinations).
  const touched = new Set([...byTrip.values()].flatMap(list => list.map(r => r[2])));
  const stops = await renfeStops(zip, touched);
  const used = new Set([...trips.values()].map(t => t.serviceId));
  const days = await renfeDays(zip, used);
  // Renfe is the core data: an empty result fails the build (buses, light rail and towns only warn).
  if (!trips.size || !days.to) throw new Error('Renfe feed has no Madrid trips or days');
  // An empty file for terminus-only stops, so the client never hits a 404.
  const empty = { r: [], d: [], s: {} };
  days.updated = renfeUpdated();
  return { routes, stops, days, files, empty, pats, trips: trips.size };
}

// ---------------------------------------------------------------- Buses

async function busRoutes(zip, feed) {
  const routes = {};
  for await (const r of rows(zip, 'routes.txt')) {
    routes[r.route_id] = {
      line: r.route_short_name,
      color: `#${r.route_color || feed.color}`,
      text: `#${r.route_text_color || 'FFFFFF'}`,
      name: r.route_long_name,
      ...(feed.k === 't' && { tram: true }),
    };
  }
  return routes;
}

async function busTrips(zip, routes) {
  const trips = new Map(); // tripId -> { routeId, serviceId, head }
  for await (const t of rows(zip, 'trips.txt')) {
    if (!routes[t.route_id]) continue;
    const head = t.trip_headsign || routes[t.route_id].name;
    trips.set(t.trip_id, { routeId: t.route_id, serviceId: t.service_id, head });
  }
  return trips;
}

// Weekday bitmask, bit n = JS getUTCDay() n (0 = Sunday).
const maskOf = c => WEEKDAYS.reduce((m, d, i) => (c[d] === '1' ? m | (1 << i) : m), 0);

// A removed date only matters when the weekly pattern would have run on it.
const runsOn = (cal, date) => {
  const day = parseYmd(String(date)).getUTCDay();
  return date >= cal[1] && date <= cal[2] && (cal[0] >> day) & 1;
};

const EMPTY_CAL = () => [0, 0, 0, [], []];

// Applies one calendar_dates row (1 = added, 2 = removed) to a calendar.
function applyException(cal, e) {
  if (e.exception_type === '1') cal[3].push(+e.date);
  else if (e.exception_type === '2') cal[4].push(+e.date);
}

async function addExceptions(zip, cals, used) {
  for await (const e of rows(zip, 'calendar_dates.txt')) {
    if (!used.has(e.service_id)) continue;
    const cal = cals.get(e.service_id) ?? EMPTY_CAL();
    cals.set(e.service_id, cal);
    applyException(cal, e);
  }
}

// serviceId -> [weekdayMask, startYmd, endYmd, added[], removed[]] (dates as numbers).
async function busCalendars(zip, used) {
  const cals = new Map();
  for await (const c of rows(zip, 'calendar.txt')) {
    if (used.has(c.service_id))
      cals.set(c.service_id, [maskOf(c), +c.start_date, +c.end_date, [], []]);
  }
  await addExceptions(zip, cals, used);
  for (const cal of cals.values()) cal[4] = cal[4].filter(d => runsOn(cal, d)).sort();
  return cals;
}

// Per stop: { kind: 'bus', r: routeIds, h: headsigns, c: [calendars], d: [[secs, ci, ri, hi, pi]] }.
// Calendars are inlined per stop and deduplicated, so the client never needs the whole table.
function busFiles(trips, byTrip, cals, pats) {
  const files = new Map();
  const patOf = (tripId, list) => pats.add(trips.get(tripId).routeId, patternOf(list));
  const calKey = new Map(); // serviceId -> JSON of its calendar
  for (const [id, cal] of cals) calKey.set(id, JSON.stringify(cal));
  for (const { tripId, secs, stopId, pi } of tripCalls(byTrip, patOf)) {
    const { routeId, serviceId, head } = trips.get(tripId);
    const f = files.get(stopId) ?? { kind: 'bus', r: [], h: [], c: [], d: [], keys: [] };
    const key = calKey.get(serviceId) ?? JSON.stringify(EMPTY_CAL());
    const ci = indexOf(f.keys, key);
    if (ci === f.c.length) f.c.push(JSON.parse(key));
    f.d.push([secs, ci, indexOf(f.r, routeId), indexOf(f.h, head), pi]);
    files.set(stopId, f);
  }
  for (const f of files.values()) {
    delete f.keys;
    f.d.sort((a, b) => a[0] - b[0]);
  }
  return files;
}

async function busStops(zip, served, feed) {
  const stops = [];
  for await (const s of rows(zip, 'stops.txt')) {
    if (!served.has(s.stop_id)) continue;
    stops.push({
      id: s.stop_id,
      name: s.stop_name,
      lat: coord(s.stop_lat),
      lon: coord(s.stop_lon),
      wa: feed.k === 't' && s.wheelchair_boarding === '1',
      k: feed.k,
      code: s.stop_code,
      desc: s.stop_desc,
    });
  }
  return stops;
}

// Bus and light rail share this step (same GTFS shape, same per-stop file format).
async function buildCrtm(feed) {
  if (!(await ensureFeed(feed))) return null;
  const zip = feed.zip;
  const routes = await busRoutes(zip, feed);
  const trips = await busTrips(zip, routes);
  const used = new Set([...trips.values()].map(t => t.serviceId));
  const cals = await busCalendars(zip, used);
  const byTrip = await loadByTrip(zip, trips);
  const pats = makePatterns();
  const files = busFiles(trips, byTrip, cals, pats);
  const stops = await busStops(zip, files, feed);
  return { routes, stops, files, pats, trips: trips.size };
}

// ---------------------------------------------------------------- Metro de Madrid

// Routes keyed by GTFS route_id (`4__1___`, what CRTM live times report as codLine).
async function metroRoutes(zip) {
  const routes = {};
  for await (const r of rows(zip, 'routes.txt')) {
    routes[r.route_id] = {
      line: r.route_short_name,
      color: `#${r.route_color || METRO.color}`,
      text: `#${r.route_text_color || 'FFFFFF'}`,
      name: r.route_long_name,
      metro: true,
    };
  }
  return routes;
}

// Stations only (location_type 0); entrances and parents (acc_, est_) are skipped.
async function metroStops(zip) {
  const stops = [];
  for await (const s of rows(zip, 'stops.txt')) {
    if (s.location_type !== '0' || !s.stop_id.startsWith('par_4_')) continue;
    stops.push({
      id: s.stop_id,
      name: s.stop_name,
      lat: coord(s.stop_lat),
      lon: coord(s.stop_lon),
      wa: s.wheelchair_boarding === '1',
      k: 'm',
      code: s.stop_code,
      desc: s.stop_desc.replace(/\s+/g, ' '),
    });
  }
  return stops;
}

const MERGE_M = 300;
const foldName = n =>
  n.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim();
console.assert(foldName(' Núñez  de Balboa') === 'nunez de balboa', 'foldName');

// The Metro GTFS has one station record per line at an interchange, but CRTM answers every
// line's trains for any of them. Stations with the same normalised name within 300 m become one:
// the lowest code is kept (as id), wa is any, the town comes with the kept record.
// Returns { stops, alias } (alias: dropped stop id -> kept stop id).
function mergeMetro(stops) {
  const byName = Map.groupBy(stops, s => foldName(s.name));
  const alias = new Map();
  const kept = [...byName.values()].flatMap(group => mergeGroup(group, alias));
  return { stops: kept, alias };
}

// One name's stations -> the kept ones (one per cluster within 300 m); fills `alias`.
function mergeGroup(group, alias) {
  group.sort((a, b) => Number(a.code) - Number(b.code) || a.id.localeCompare(b.id));
  const heads = [];
  for (const s of group) {
    const head = heads.find(h => metres(h, s) <= MERGE_M);
    if (!head) heads.push(s);
    else {
      head.wa ||= s.wa;
      alias.set(s.id, head.id);
    }
  }
  return heads;
}
console.assert(
  (() => {
    const s = (id, code, lat, wa) => ({ id, code, name: 'Sol', lat, lon: -3.7, wa });
    const m = mergeMetro([
      s('b', '35', 40.4, false),
      s('a', '12', 40.4001, true),
      s('c', '9', 41, false),
    ]);
    return (
      m.stops.length === 2 &&
      m.alias.get('b') === 'a' &&
      m.stops.find(x => x.id === 'a').wa &&
      !m.alias.has('c')
    );
  })(),
  'mergeMetro merges same name within 300 m, keeps the lowest code',
);

// Streams stop_times.txt and collects one pattern per unique stop sequence and route, without
// keeping the file in memory (EMT's is ~100 MB). `routeOf(tripId)` -> route id (or undefined to
// skip the trip), `mapId(stopId)` -> output stop id (or falsy to drop the call). Rows of one trip
// are expected to be contiguous.
async function streamPatterns(zip, routeOf, mapId) {
  const pats = makePatterns();
  let tripId = null;
  let list = [];
  const flush = () => {
    const routeId = tripId && routeOf(tripId);
    if (routeId && list.length > 1) {
      list.sort((a, b) => a[0] - b[0]);
      const pattern = patternOf(list, mapId);
      if (pattern.length > 1) pats.add(routeId, pattern);
    }
    list = [];
  };
  for await (const s of rows(zip, 'stop_times.txt')) {
    if (s.trip_id !== tripId) {
      flush();
      tripId = s.trip_id;
    }
    if (routeOf(tripId)) {
      list.push([
        Number(s.stop_sequence),
        toSecs(s.departure_time || s.arrival_time),
        s.stop_id,
      ]);
    }
  }
  flush();
  return pats;
}

// trip_id -> route id (through `routeKey(route_id)`; falsy = skip) from trips.txt.
async function tripRoutes(zip, routeKey) {
  const map = new Map();
  for await (const t of rows(zip, 'trips.txt')) {
    const key = routeKey(t.route_id);
    if (key) map.set(t.trip_id, key);
  }
  return map;
}

// Never fails the build: a missing or broken Metro feed only drops Metro stops.
async function buildMetro() {
  try {
    if (!(await ensureFeed(METRO))) return null;
    const routes = await metroRoutes(METRO.zip);
    const all = await metroStops(METRO.zip);
    if (!all.length) throw new Error('no stops');
    const { stops, alias } = mergeMetro(all);
    const ofTrip = await tripRoutes(METRO.zip, id => routes[id] && id);
    const pats = await streamPatterns(
      METRO.zip,
      id => ofTrip.get(id),
      id => alias.get(id) ?? (id.startsWith('par_4_') ? id : null),
    );
    return { routes, stops, merged: alias.size, pats };
  } catch (err) {
    console.warn(`Metro step failed (${err.message}): skipping`);
    return null;
  }
}

// ---------------------------------------------------------------- EMT city buses

// Routes keyed `emt_<short name>` (what the client builds from the live `line`).
// Also returns `keys`: GTFS route_id -> that key (stop patterns are collected per key).
async function emtRoutes(zip) {
  const routes = {};
  const keys = new Map();
  for await (const r of rows(zip, 'routes.txt')) {
    if (!r.route_short_name) continue;
    keys.set(r.route_id, `emt_${r.route_short_name}`);
    routes[`emt_${r.route_short_name}`] = {
      line: r.route_short_name,
      color: `#${r.route_color || EMT.color}`,
      text: `#${r.route_text_color || 'FFFFFF'}`,
      name: r.route_long_name,
    };
  }
  return { routes, keys };
}

// stop_id is the EMT stop number (digits only; anything else is dropped).
async function emtStops(zip) {
  const stops = [];
  for await (const s of rows(zip, 'stops.txt')) {
    if (!/^\d{1,6}$/.test(s.stop_id) || !s.stop_name) continue;
    stops.push({
      id: `emt_${s.stop_id}`,
      name: s.stop_name,
      lat: coord(s.stop_lat),
      lon: coord(s.stop_lon),
      wa: false,
      k: 'e',
      code: s.stop_id,
      town: 'Madrid',
    });
  }
  return stops;
}

// Never fails the build: a missing or broken EMT feed only drops EMT stops.
async function buildEmt() {
  try {
    if (!(await ensureFeed({ ...EMT, auth: false }))) return null;
    const zip = EMT.zip;
    const { routes, keys } = await emtRoutes(zip);
    const stops = await emtStops(zip);
    if (!stops.length) throw new Error('no stops');
    const ofTrip = await tripRoutes(zip, id => keys.get(id));
    const pats = await streamPatterns(
      zip,
      id => ofTrip.get(id),
      id => (/^\d{1,6}$/.test(id) ? `emt_${id}` : null),
    );
    return { routes, stops, pats };
  } catch (err) {
    console.warn(`EMT step failed (${err.message}): skipping`);
    return null;
  }
}

// ---------------------------------------------------------------- Towns (CRTM open data)

// Town names by INE code (Wikidata, committed). Untrusted-looking data is only ever parsed.
const municipios = () => JSON.parse(readFileSync(`${ROOT}scripts/municipios.json`, 'utf8'));

// One ArcGIS page: CODIGOESTACION (= GTFS stop_code) -> INE code (province + municipality).
async function crtmPage(layer, offset) {
  const params = new URLSearchParams({
    where: '1=1',
    outFields: 'CODIGOESTACION,CODIGOMUNICIPIO,CODIGOPROVINCIA',
    returnGeometry: 'false',
    f: 'json',
    resultOffset: String(offset),
  });
  const res = await fetch(`${CRTM_LAYERS}/${layer}/FeatureServer/0/query?${params}`, {
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function crtmRecords(layer) {
  const records = [];
  for (let more = true; more;) {
    const page = await crtmPage(layer, records.length);
    const got = (page.features ?? []).map(f => f.attributes ?? {});
    records.push(...got);
    more = !!page.exceededTransferLimit && got.length > 0;
  }
  return records;
}

const ineOf = r =>
  `${String(r.CODIGOPROVINCIA ?? '').padStart(2, '0')}${String(r.CODIGOMUNICIPIO ?? '').padStart(3, '0')}`;
console.assert(ineOf({ CODIGOPROVINCIA: 28, CODIGOMUNICIPIO: '106' }) === '28106', 'ineOf');
console.assert(ineOf({ CODIGOPROVINCIA: '5', CODIGOMUNICIPIO: 7 }) === '05007', 'ineOf pads');

const readCache = feed => {
  try {
    const data = JSON.parse(readFileSync(feed.townCache, 'utf8'));
    return Array.isArray(data) ? data : null;
  } catch {
    return null;
  }
};
const cacheFresh = feed =>
  existsSync(feed.townCache) && Date.now() - statSync(feed.townCache).mtimeMs < TOWN_MAX_AGE_MS;

async function fetchRecords(feed) {
  const records = await crtmRecords(feed.layer);
  if (!records.length) throw new Error('no records');
  await writeFile(feed.townCache, JSON.stringify(records));
  return records;
}

// Cached for 7 days; a failed fetch falls back to any cache, else no towns (never fails).
async function crtmData(feed) {
  mkdirSync(CACHE, { recursive: true });
  const fresh = cacheFresh(feed) ? readCache(feed) : null;
  if (fresh) return fresh;
  try {
    return await fetchRecords(feed);
  } catch (err) {
    const old = readCache(feed);
    console.warn(
      `CRTM ${feed.layer} town fetch failed (${err.message}): ${old ? 'using old cache' : 'no towns'}`,
    );
    return old ?? [];
  }
}

// stop_code -> town name.
async function townsByCode(feed) {
  const names = municipios();
  const byCode = new Map();
  for (const r of await crtmData(feed)) {
    const name = names[ineOf(r)];
    if (name && r.CODIGOESTACION != null) byCode.set(String(r.CODIGOESTACION).trim(), name);
  }
  return byCode;
}

// Town of the nearest stop within 1,500 m, or ''.
function nearestTown(s, withTown) {
  const near = withTown
    .map(b => ({ b, d: metres(s, b) }))
    .filter(x => x.d <= NEAREST_TOWN_M)
    .sort((x, y) => x.d - y.d)[0];
  return near?.b.town ?? '';
}

// CRTM stops (bus, light rail) get their town by code from their own layer: short codes collide
// across feeds, so a code is only ever looked up in the layer of its feed. Returns the count.
function assignCrtmTowns(stops, byCode) {
  for (const s of stops) s.town = byCode.get(s.code) ?? '';
  return stops.filter(s => s.town).length;
}

// Renfe stations (no code) get the town of the nearest bus stop within 1,500 m.
function assignRenfeTowns(renfeStops, busStops) {
  const withTown = busStops.filter(s => s.town);
  for (const s of renfeStops) s.town = nearestTown(s, withTown);
  return renfeStops.filter(s => s.town).length;
}

async function assignTowns(renfeStops, bus, ml, metro) {
  const t = { bus: 0, ml: 0, metro: 0, renfe: 0 };
  if (metro) t.metro = assignCrtmTowns(metro.stops, await townsByCode(METRO));
  if (bus) t.bus = assignCrtmTowns(bus.stops, await townsByCode(BUS));
  if (ml) t.ml = assignCrtmTowns(ml.stops, await townsByCode(ML));
  t.renfe = assignRenfeTowns(renfeStops, bus?.stops ?? []);
  return t;
}
console.assert(
  (() => {
    const bus = [{ code: '1' }];
    const ml = [{ code: '1' }];
    assignCrtmTowns(bus, new Map([['1', 'Madrid']]));
    assignCrtmTowns(ml, new Map([['1', 'Parla']]));
    return bus[0].town === 'Madrid' && ml[0].town === 'Parla';
  })(),
  'colliding stop codes keep the town of their own feed',
);

// ---------------------------------------------------------------- Output

const kb = n => `${(n / 1024).toFixed(0)} KB`;
const sizes = text => ({ raw: Buffer.byteLength(text), gz: gzipSync(text).length });

async function writeJson(name, value) {
  const text = JSON.stringify(value);
  await writeFile(`${OUT}${name}`, text);
  return sizes(text);
}

async function writeStopFiles(stops, renfe, crtm) {
  for (const s of stops) {
    if (s.k === 'e' || s.k === 'm') continue; // EMT and Metro stops have no file (live only)
    const file =
      crtm.find(f => f.files.has(s.id))?.files.get(s.id) ??
      renfe.files.get(s.id) ??
      renfe.empty;
    await writeFile(`${OUT}stop/${s.id}.json`, JSON.stringify(file));
  }
}

// route/<routeId>.json = { p: [[[stopId, offsetSecs], ...], ...] }: the unique stop patterns of
// each route, from every feed. Route ids that are not plain file names are skipped.
async function writeRouteFiles(feeds) {
  mkdirSync(`${OUT}route`, { recursive: true });
  let n = 0;
  for (const f of feeds.filter(Boolean)) {
    for (const [routeId, { list }] of f.pats.routes) {
      if (!/^[\w.-]{1,40}$/.test(routeId)) continue;
      await writeFile(`${OUT}route/${routeId}.json`, JSON.stringify({ p: list }));
      n++;
    }
  }
  return n;
}

const crtmLine = (name, f) =>
  f
    ? `${name}: routes ${Object.keys(f.routes).length}, trips ${f.trips}, stops ${f.stops.length}`
    : `${name}: skipped`;

function report(renfe, bus, ml, metro, emt, stops, sz) {
  const files = readdirSync(`${OUT}stop`).map(f => [f, statSync(`${OUT}stop/${f}`).size]);
  const total = files.reduce((n, [, s]) => n + s, 0);
  const [bigName, bigSize] = files.reduce((a, b) => (b[1] > a[1] ? b : a));
  const big = sizes(readFileSync(`${OUT}stop/${bigName}`, 'utf8'));
  const { from, to } = renfe.days;
  console.log(
    `renfe: routes ${Object.keys(renfe.routes).length}, trips ${renfe.trips}, stops ${renfe.stops.length}, days ${from}..${to}`,
  );
  console.log(crtmLine('bus', bus));
  console.log(crtmLine('light rail', ml));
  console.log(
    metro
      ? `Metro: routes ${Object.keys(metro.routes).length}, stations ${metro.stops.length} (${metro.merged} duplicates merged)`
      : 'Metro: skipped',
  );
  console.log(
    emt
      ? `EMT: routes ${Object.keys(emt.routes).length}, stops ${emt.stops.length}`
      : 'EMT: skipped',
  );
  console.log(
    `stops.json ${kb(sz.stops.raw)} raw, ${kb(sz.stops.gz)} gzip (${stops.length} stops)`,
  );
  const rf = readdirSync(`${OUT}route`).map(f => [f, statSync(`${OUT}route/${f}`).size]);
  const [rBig, rBigSize] = rf.reduce((a, b) => (b[1] > a[1] ? b : a));
  console.log(
    `route files ${rf.length}, total ${kb(rf.reduce((n, [, s]) => n + s, 0))}, largest ${rBig} ${kb(rBigSize)}`,
  );
  console.log(
    `per-stop files ${files.length}, total ${kb(total)}, largest ${bigName} ${kb(bigSize)} raw, ${kb(big.gz)} gzip`,
  );
}

async function main() {
  const renfe = await buildRenfe();
  const bus = await buildCrtm(BUS);
  const ml = await buildCrtm(ML);
  const metro = await buildMetro();
  const emt = await buildEmt();
  const t = await assignTowns(renfe.stops, bus, ml, metro);
  console.log(
    `towns: bus ${t.bus}/${bus?.stops.length ?? 0}, light rail ${t.ml}/${ml?.stops.length ?? 0}, metro ${t.metro}/${metro?.stops.length ?? 0}, renfe ${t.renfe}/${renfe.stops.length} (nearest bus stop within ${NEAREST_TOWN_M} m)`,
  );
  const stops = [
    ...renfe.stops,
    ...(bus?.stops ?? []),
    ...(ml?.stops ?? []),
    ...(metro?.stops ?? []),
    ...(emt?.stops ?? []),
  ].sort((a, b) => a.name.localeCompare(b.name, 'es'));

  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(`${OUT}stop`, { recursive: true });
  const sz = { stops: await writeJson('stops.json', stops) };
  // Renfe stops alone are small and always needed (destination names); stops.json is lazy.
  await writeJson('stops-renfe.json', renfe.stops);
  await writeJson('routes.json', {
    ...renfe.routes,
    ...bus?.routes,
    ...ml?.routes,
    ...metro?.routes,
    ...emt?.routes,
  });
  await writeJson('days.json', renfe.days);
  await writeStopFiles(stops, renfe, [bus, ml].filter(Boolean));
  await writeRouteFiles([renfe, bus, ml, metro, emt]);
  report(renfe, bus, ml, metro, emt, stops, sz);
}

await main();
