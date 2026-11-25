// Builds the static Madrid timetable into public/data/: Renfe Cercanías (route_id 10T…) and, when
// available, CRTM interurban buses (NAP feed 1361, timetable only). Plain Node, no dependencies.
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
const TOWN_CACHE = `${CACHE}crtm-stops.json`;
const CRTM_URL =
  'https://services5.arcgis.com/UxADft6QPcvFyDU1/arcgis/rest/services/M8_Red/FeatureServer/0/query';
const NEAREST_TOWN_M = 1500;
const BUS = {
  url: 'https://nap.transportes.gob.es/api/Fichero/download/1361',
  zip: `${CACHE}bus.zip`,
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
}

async function ensureRenfe() {
  mkdirSync(CACHE, { recursive: true });
  if (fresh(RENFE.zip)) console.log('using cached Renfe zip');
  else await download(RENFE);
}

// A cached zip younger than 24 h needs no token. Returns false when buses must be skipped.
async function ensureBus() {
  mkdirSync(CACHE, { recursive: true });
  if (fresh(BUS.zip)) {
    console.log('using cached bus zip');
    return true;
  }
  const token = napToken();
  if (!token) {
    console.warn('NAP_TOKEN missing and no fresh .cache/bus.zip: skipping buses (Renfe only)');
    return false;
  }
  try {
    await download(BUS, { ApiKey: token });
  } catch (err) {
    console.warn(`bus download failed (${err.message}): skipping buses`);
    return existsSync(BUS.zip);
  }
  return true;
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
    if (!head) head = f;
    else yield Object.fromEntries(head.map((h, i) => [h, f[i] ?? '']));
  }
  await done;
}

const indexOf = (arr, v) => {
  const i = arr.indexOf(v);
  return i >= 0 ? i : arr.push(v) - 1;
};
const coord = v => Number(Number(v).toFixed(5));

// Per-stop trip rows: sorted by departure, the last stop of each trip is dropped (no departure
// there). `byTrip` maps tripId -> [[seq, secs, stopId]].
function* tripCalls(byTrip) {
  for (const [tripId, list] of byTrip) {
    list.sort((a, b) => a[0] - b[0]);
    for (const [, secs, stopId] of list.slice(0, -1)) yield { tripId, list, secs, stopId };
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

// Per stop, compact: { r: routeIds, d: destStopIds, s: { serviceId: [[secs, tripSuffix, ri, di]] } }.
// The trip id is stored without its service-id prefix (the client re-adds it).
function renfeFiles(trips, byTrip) {
  const files = new Map();
  for (const { tripId, list, secs, stopId } of tripCalls(byTrip)) {
    const { routeId, serviceId } = trips.get(tripId);
    const suffix = tripId.startsWith(serviceId) ? tripId.slice(serviceId.length) : `!${tripId}`;
    const f = files.get(stopId) ?? { r: [], d: [], s: {} };
    const row = [secs, suffix, indexOf(f.r, routeId), indexOf(f.d, list.at(-1)[2])];
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
  const files = renfeFiles(trips, byTrip);
  // Every stop a Madrid trip touches, termini included (they name destinations).
  const touched = new Set([...byTrip.values()].flatMap(list => list.map(r => r[2])));
  const stops = await renfeStops(zip, touched);
  const used = new Set([...trips.values()].map(t => t.serviceId));
  const days = await renfeDays(zip, used);
  // An empty file for terminus-only stops, so the client never hits a 404.
  const empty = { r: [], d: [], s: {} };
  return { routes, stops, days, files, empty, trips: trips.size };
}

// ---------------------------------------------------------------- Buses

async function busRoutes(zip) {
  const routes = {};
  for await (const r of rows(zip, 'routes.txt')) {
    routes[r.route_id] = {
      line: r.route_short_name,
      color: `#${r.route_color || '8EBF42'}`,
      text: `#${r.route_text_color || 'FFFFFF'}`,
      name: r.route_long_name,
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

// Per stop: { kind: 'bus', r: routeIds, h: headsigns, c: [calendars], d: [[secs, ci, ri, hi]] }.
// Calendars are inlined per stop and deduplicated, so the client never needs the whole table.
function busFiles(trips, byTrip, cals) {
  const files = new Map();
  const calKey = new Map(); // serviceId -> JSON of its calendar
  for (const [id, cal] of cals) calKey.set(id, JSON.stringify(cal));
  for (const { tripId, secs, stopId } of tripCalls(byTrip)) {
    const { routeId, serviceId, head } = trips.get(tripId);
    const f = files.get(stopId) ?? { kind: 'bus', r: [], h: [], c: [], d: [], keys: [] };
    const key = calKey.get(serviceId) ?? JSON.stringify(EMPTY_CAL());
    const ci = indexOf(f.keys, key);
    if (ci === f.c.length) f.c.push(JSON.parse(key));
    f.d.push([secs, ci, indexOf(f.r, routeId), indexOf(f.h, head)]);
    files.set(stopId, f);
  }
  for (const f of files.values()) {
    delete f.keys;
    f.d.sort((a, b) => a[0] - b[0]);
  }
  return files;
}

async function busStops(zip, served) {
  const stops = [];
  for await (const s of rows(zip, 'stops.txt')) {
    if (!served.has(s.stop_id)) continue;
    stops.push({
      id: s.stop_id,
      name: s.stop_name,
      lat: coord(s.stop_lat),
      lon: coord(s.stop_lon),
      wa: false,
      k: 'b',
      code: s.stop_code,
      desc: s.stop_desc,
    });
  }
  return stops;
}

async function buildBus() {
  if (!(await ensureBus())) return null;
  const zip = BUS.zip;
  const routes = await busRoutes(zip);
  const trips = await busTrips(zip, routes);
  const used = new Set([...trips.values()].map(t => t.serviceId));
  const cals = await busCalendars(zip, used);
  const byTrip = await loadByTrip(zip, trips);
  const files = busFiles(trips, byTrip, cals);
  const stops = await busStops(zip, files);
  return { routes, stops, files, trips: trips.size };
}

// ---------------------------------------------------------------- Towns (CRTM open data)

// Town names by INE code (Wikidata, committed). Untrusted-looking data is only ever parsed.
const municipios = () => JSON.parse(readFileSync(`${ROOT}scripts/municipios.json`, 'utf8'));

// One ArcGIS page: CODIGOESTACION (= GTFS stop_code) -> INE code (province + municipality).
async function crtmPage(offset) {
  const params = new URLSearchParams({
    where: '1=1',
    outFields: 'CODIGOESTACION,CODIGOMUNICIPIO,CODIGOPROVINCIA',
    returnGeometry: 'false',
    f: 'json',
    resultOffset: String(offset),
  });
  const res = await fetch(`${CRTM_URL}?${params}`, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function crtmRecords() {
  const records = [];
  for (let more = true; more;) {
    const page = await crtmPage(records.length);
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

const readCache = () => {
  try {
    const data = JSON.parse(readFileSync(TOWN_CACHE, 'utf8'));
    return Array.isArray(data) ? data : null;
  } catch {
    return null;
  }
};
const cacheFresh = () =>
  existsSync(TOWN_CACHE) && Date.now() - statSync(TOWN_CACHE).mtimeMs < TOWN_MAX_AGE_MS;

async function fetchRecords() {
  const records = await crtmRecords();
  if (!records.length) throw new Error('no records');
  await writeFile(TOWN_CACHE, JSON.stringify(records));
  return records;
}

// Cached for 7 days; a failed fetch falls back to any cache, else no towns (never fails).
async function crtmData() {
  mkdirSync(CACHE, { recursive: true });
  const fresh = cacheFresh() ? readCache() : null;
  if (fresh) return fresh;
  try {
    return await fetchRecords();
  } catch (err) {
    const old = readCache();
    console.warn(
      `CRTM town fetch failed (${err.message}): ${old ? 'using old cache' : 'no towns'}`,
    );
    return old ?? [];
  }
}

// stop_code -> town name.
async function townsByCode() {
  const names = municipios();
  const byCode = new Map();
  for (const r of await crtmData()) {
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

// Bus stops get their town by code; Renfe stations (no code) the town of the nearest bus stop
// within 1,500 m. Mutates the stops; returns how many of each got a town.
function assignTowns(renfeStops, busStops, byCode) {
  for (const s of busStops) s.town = byCode.get(s.code) ?? '';
  const withTown = busStops.filter(s => s.town);
  for (const s of renfeStops) s.town = nearestTown(s, withTown);
  return {
    bus: withTown.length,
    busAll: busStops.length,
    renfe: renfeStops.filter(s => s.town).length,
    renfeAll: renfeStops.length,
  };
}

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

// ---------------------------------------------------------------- Output

const kb = n => `${(n / 1024).toFixed(0)} KB`;
const sizes = text => ({ raw: Buffer.byteLength(text), gz: gzipSync(text).length });

async function writeJson(name, value) {
  const text = JSON.stringify(value);
  await writeFile(`${OUT}${name}`, text);
  return sizes(text);
}

async function writeStopFiles(stops, renfe, bus) {
  for (const s of stops) {
    const file = bus?.files.get(s.id) ?? renfe.files.get(s.id) ?? renfe.empty;
    await writeFile(`${OUT}stop/${s.id}.json`, JSON.stringify(file));
  }
}

function report(renfe, bus, stops, sz) {
  const files = readdirSync(`${OUT}stop`).map(f => [f, statSync(`${OUT}stop/${f}`).size]);
  const total = files.reduce((n, [, s]) => n + s, 0);
  const [bigName, bigSize] = files.reduce((a, b) => (b[1] > a[1] ? b : a));
  const big = sizes(readFileSync(`${OUT}stop/${bigName}`, 'utf8'));
  const { from, to } = renfe.days;
  console.log(
    `renfe: routes ${Object.keys(renfe.routes).length}, trips ${renfe.trips}, stops ${renfe.stops.length}, days ${from}..${to}`,
  );
  console.log(
    bus
      ? `bus: routes ${Object.keys(bus.routes).length}, trips ${bus.trips}, stops ${bus.stops.length}`
      : 'bus: skipped',
  );
  console.log(
    `stops.json ${kb(sz.stops.raw)} raw, ${kb(sz.stops.gz)} gzip (${stops.length} stops)`,
  );
  console.log(
    `per-stop files ${files.length}, total ${kb(total)}, largest ${bigName} ${kb(bigSize)} raw, ${kb(big.gz)} gzip`,
  );
}

async function main() {
  const renfe = await buildRenfe();
  const bus = await buildBus();
  const t = assignTowns(renfe.stops, bus?.stops ?? [], bus ? await townsByCode() : new Map());
  console.log(
    `towns: bus ${t.bus}/${t.busAll}, renfe ${t.renfe}/${t.renfeAll} (nearest bus stop within ${NEAREST_TOWN_M} m)`,
  );
  const stops = [...renfe.stops, ...(bus?.stops ?? [])].sort((a, b) =>
    a.name.localeCompare(b.name, 'es'),
  );

  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(`${OUT}stop`, { recursive: true });
  const sz = { stops: await writeJson('stops.json', stops) };
  // Renfe stops alone are small and always needed (destination names); stops.json is lazy.
  await writeJson('stops-renfe.json', renfe.stops);
  await writeJson('routes.json', { ...renfe.routes, ...bus?.routes });
  await writeJson('days.json', renfe.days);
  await writeStopFiles(stops, renfe, bus);
  report(renfe, bus, stops, sz);
}

await main();
