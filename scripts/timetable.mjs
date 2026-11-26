// Builds the static Madrid timetable into public/data/: Renfe Cercanías (route_id 10T…) and, when
// available, CRTM interurban buses (ArcGIS item, NAP feed 1361 as fallback) and light rail (Metro
// Ligero ML1-ML3, Tranvía de Parla ML4; CRTM open data), both timetable only, plus Metro de Madrid
// and EMT stops/routes (live only). Plain Node, no dependencies.
// The downloaded GTFS zips are untrusted data: they are only parsed (never executed), live in
// .cache/, and single files are streamed through `unzip -p` (shapes.txt is never extracted).
import { spawn, spawnSync } from 'node:child_process';
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
const PUBLIC = `${ROOT}public/`;
const OUT = `${PUBLIC}data/`;
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const RENFE = {
  url: 'https://ssl.renfe.com/ftransit/Fichero_CER_FOMENTO/fomento_transit.zip',
  zip: `${CACHE}fomento.zip`,
};
// Renfe Media/Larga Distancia (Regional, Intercity, AVE, AVLO, AVANT, Euromed): stop ids are
// shared with Cercanías. Optional: a failed download without a cached zip builds without it.
const LD = {
  label: 'LD',
  url: 'https://ssl.renfe.com/gtransit/Fichero_AV_LD/google_transit.zip',
  zip: `${CACHE}ld.zip`,
};
// Ouigo España high-speed trains (NAP dataset 1766, ApiKey header): timetable only. Optional.
const OUIGO = {
  label: 'Ouigo',
  auth: true,
  url: 'https://nap.transportes.gob.es/api/Fichero/download/1766',
  zip: `${CACHE}ouigo.zip`,
};
// route_short_name -> tile label, name and colours (white text unless stated).
const LD_PRODUCTS = {
  AVE: { line: 'AVE', color: '#6B2C91', text: '#FFFFFF' },
  AVLO: { line: 'AVLO', color: '#C1007A', text: '#FFFFFF' },
  AVANT: { line: 'AVANT', color: '#8A5CB8', text: '#FFFFFF' },
  'AVANT EXP': { line: 'AVANT', color: '#8A5CB8', text: '#FFFFFF' },
  'AVE Euromed': { line: 'Euromed', color: '#6B2C91', text: '#FFFFFF' },
  Intercity: { line: 'IC', color: '#E05206', text: '#FFFFFF' },
  Regional: { line: 'MD', color: '#E39B00', text: '#000000' },
};
// LD-only Madrid stations kept as if they were Cercanías stops (no LD train calls at both this
// and a Cercanías station): 60000 = Puerta de Atocha.
const LD_HUBS = ['60000'];
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
// Town buses ("Autobuses Urbanos" of the whole region): public ArcGIS item (no key, 8.8 MB). Same
// GTFS shape and same stops table (par_8_<code>) as the interurban feed, so stops served by both
// networks are merged; towns come from the same layer (and cache file) as the interurban buses.
const URB = {
  key: 'urb',
  label: 'town bus',
  k: 'b',
  color: 'E60003',
  auth: false,
  urban: true,
  url: 'https://www.arcgis.com/sharing/rest/content/items/357e63c2904f43aeb5d8a267a64346d8/data',
  zip: `${CACHE}urb.zip`,
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
  address: true,
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
  address: true,
};

// EMT city buses: public ArcGIS item (CRTM "GTFS Red de EMT", no key, 21 MB). Frequency-based
// trips, so only routes.txt and stops.txt are read: live arrivals come from rt.php (?f=emt).
const EMT = {
  key: 'emt',
  label: 'EMT',
  color: '0178BC',
  url: 'https://www.arcgis.com/sharing/rest/content/items/868df0e58fca47e79b942902dffd7da0/data',
  zip: `${CACHE}emt.zip`,
  layer: 'M6_Red',
  townCache: `${CACHE}crtm-m6.json`,
  address: true,
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

// The terminus of each trip with 2+ calls: { tripId, list, arr, stopId, pi }, `arr` being the
// arrival at the last stop (row element 3: arrival_time, falling back to departure_time).
// Rows must already be sorted (tripCalls does it), so run this after tripCalls.
function* tripEnds(byTrip, patOf) {
  for (const [tripId, list] of byTrip) {
    if (list.length < 2) continue;
    const [, , stopId, arr] = list.at(-1);
    yield { tripId, list, arr, stopId, pi: patOf(tripId, list) };
  }
}

async function loadByTrip(zip, wanted) {
  const byTrip = new Map(); // tripId -> [[seq, depSecs, stopId, arrSecs]]
  const stopIds = new Map(); // intern stop ids: 1.3M rows share ~9k strings
  for await (const s of rows(zip, 'stop_times.txt')) {
    if (!wanted.has(s.trip_id)) continue;
    const list = byTrip.get(s.trip_id) ?? [];
    const stopId = stopIds.get(s.stop_id) ?? stopIds.set(s.stop_id, s.stop_id).get(s.stop_id);
    const dep = toSecs(s.departure_time || s.arrival_time);
    list.push([
      Number(s.stop_sequence),
      dep,
      stopId,
      toSecs(s.arrival_time || s.departure_time),
    ]);
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

// Per stop, compact: { r: routeIds, d: destStopIds, o: originStopIds,
//   s: { serviceId: [[secs, tripSuffix, ri, di, pi, oi]] },
//   a: { serviceId: [[arrSecs, tripSuffix, ri, oi, pi]] } }
// (pi = index into the route's patterns in route/<routeId>.json). `s` rows are departures, `a`
// rows are trips that END at the stop (arrival time, origin), each sorted by time.
// The trip id is stored without its service-id prefix (the client re-adds it).
const newRenfeFile = () => ({ r: [], d: [], o: [], s: {}, a: {} });
const tripSuffix = (tripId, serviceId) =>
  tripId.startsWith(serviceId) ? tripId.slice(serviceId.length) : `!${tripId}`;

function renfeFiles(trips, byTrip, pats) {
  const files = new Map();
  const patOf = (tripId, list) => pats.add(trips.get(tripId).routeId, patternOf(list));
  const fileOf = id => files.get(id) ?? files.set(id, newRenfeFile()).get(id);
  for (const { tripId, list, secs, stopId, pi } of tripCalls(byTrip, patOf)) {
    const { routeId, serviceId } = trips.get(tripId);
    const f = fileOf(stopId);
    const [di, oi] = [indexOf(f.d, list.at(-1)[2]), indexOf(f.o, list[0][2])];
    const row = [secs, tripSuffix(tripId, serviceId), indexOf(f.r, routeId), di, pi, oi];
    (f.s[serviceId] ??= []).push(row);
  }
  for (const { tripId, list, arr, stopId, pi } of tripEnds(byTrip, patOf)) {
    const { routeId, serviceId } = trips.get(tripId);
    const f = fileOf(stopId);
    const row = [
      arr,
      tripSuffix(tripId, serviceId),
      indexOf(f.r, routeId),
      indexOf(f.o, list[0][2]),
      pi,
    ];
    (f.a[serviceId] ??= []).push(row);
  }
  for (const f of files.values()) {
    for (const list of [...Object.values(f.s), ...Object.values(f.a)]) {
      list.sort((a, b) => a[0] - b[0]);
    }
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
  const empty = newRenfeFile();
  days.updated = renfeUpdated();
  return { routes, stops, days, files, empty, pats, trips: trips.size };
}

// ---------------------------------------------------------------- Renfe Media/Larga Distancia

async function ldRoutes(zip) {
  const routes = {};
  for await (const r of rows(zip, 'routes.txt')) {
    const product = LD_PRODUCTS[r.route_short_name];
    if (product) routes[r.route_id] = { ...product, name: r.route_short_name, ld: true };
  }
  return routes;
}

// Trips of known products that call at a stop of `madrid` (the Cercanías Madrid stop ids).
// Returns { trips: tripId -> { routeId, serviceId }, byTrip }.
async function ldTrips(zip, routes, madrid) {
  const all = new Map();
  for await (const t of rows(zip, 'trips.txt')) {
    if (routes[t.route_id])
      all.set(t.trip_id, { routeId: t.route_id, serviceId: t.service_id });
  }
  const byTrip = await loadByTrip(zip, all);
  const calls = list => list.some(r => madrid.has(r[2]));
  for (const [tripId, list] of [...byTrip]) if (!calls(list)) byTrip.delete(tripId);
  return { trips: new Map([...all].filter(([id]) => byTrip.has(id))), byTrip };
}

// Per stop: { c: [calendars], x: [[secs, ci, ri, di, pi, tripId, oi]],
//   a: [[arrSecs, ci, ri, oi, pi, tripId]], r, d, o } (r/d/o are local until mergeLd points them
// at the Cercanías file's arrays). `a` rows are trips that END at the stop.
function ldFiles(trips, byTrip, cals, pats) {
  const files = new Map();
  const patOf = (tripId, list) => pats.add(trips.get(tripId).routeId, patternOf(list));
  const calKey = calKeys(cals);
  const fileOf = id =>
    files.get(id) ??
    files.set(id, { r: [], d: [], o: [], c: [], x: [], a: [], keys: [] }).get(id);
  for (const { tripId, list, secs, stopId, pi } of tripCalls(byTrip, patOf)) {
    const { routeId, serviceId } = trips.get(tripId);
    const f = fileOf(stopId);
    const ci = calIndex(f, calKey, serviceId);
    const [di, oi] = [indexOf(f.d, list.at(-1)[2]), indexOf(f.o, list[0][2])];
    f.x.push([secs, ci, indexOf(f.r, routeId), di, pi, tripId, oi]);
  }
  for (const { tripId, list, arr, stopId, pi } of tripEnds(byTrip, patOf)) {
    const { routeId, serviceId } = trips.get(tripId);
    const f = fileOf(stopId);
    const ci = calIndex(f, calKey, serviceId);
    f.a.push([arr, ci, indexOf(f.r, routeId), indexOf(f.o, list[0][2]), pi, tripId]);
  }
  for (const f of files.values()) {
    delete f.keys;
    f.x.sort((a, b) => a[0] - b[0]);
    f.a.sort((a, b) => a[0] - b[0]);
  }
  return files;
}

// Adds the LD stops the Cercanías set lacks (same fields as renfeStops); returns how many.
async function ldStops(zip, touched, target) {
  const known = new Set(target.map(s => s.id));
  const added = (await renfeStops(zip, touched)).filter(s => !known.has(s.id));
  target.push(...added);
  return added.length;
}

async function buildLd(renfe) {
  try {
    if (!(await ensureFeed(LD))) return null;
    const zip = LD.zip;
    const routes = await ldRoutes(zip);
    const madrid = new Set([...renfe.stops.map(s => s.id), ...LD_HUBS]);
    const { trips, byTrip } = await ldTrips(zip, routes, madrid);
    const kept = new Set([...trips.values()].map(t => t.routeId));
    for (const id of Object.keys(routes)) if (!kept.has(id)) delete routes[id];
    const used = new Set([...trips.values()].map(t => t.serviceId));
    const cals = await busCalendars(zip, used);
    const pats = makePatterns();
    const files = ldFiles(trips, byTrip, cals, pats);
    const touched = new Set([...byTrip.values()].flatMap(list => list.map(r => r[2])));
    const newStops = await ldStops(zip, touched, renfe.stops);
    return { routes, files, pats, trips: trips.size, newStops };
  } catch (err) {
    console.warn(`LD step failed (${err.message}): skipping`);
    return null;
  }
}

// Cercanías file + LD rows: { r, d, o, s, a, ld: { c, x, a } } with the LD rows re-pointed at the
// merged r (route ids), d (destination stop ids) and o (origin stop ids).
function mergeLd(base, ldf) {
  if (!ldf) return base;
  const r = [...base.r];
  const d = [...base.d];
  const ri = ldf.r.map(v => indexOf(r, v));
  const di = ldf.d.map(v => indexOf(d, v));
  const o = [...base.o];
  const oi = ldf.o.map(v => indexOf(o, v));
  const x = ldf.x.map(([secs, c, ra, da, pi, id, oa]) => [
    secs,
    c,
    ri[ra],
    di[da],
    pi,
    id,
    oi[oa],
  ]);
  const a = ldf.a.map(([secs, c, ra, oa, pi, id]) => [secs, c, ri[ra], oi[oa], pi, id]);
  return { r, d, o, s: base.s, a: base.a, ld: { c: ldf.c, x, a } };
}
console.assert(
  (() => {
    const base = { r: ['10T1'], d: ['9'], o: ['7'], s: {}, a: {} };
    const ldf = {
      r: ['LD1'],
      d: ['8', '9'],
      o: ['6', '7'],
      c: [[127, 1, 2, [], []]],
      x: [[5, 0, 0, 1, 3, 'T', 1]],
      a: [[9, 0, 0, 0, 3, 'T']],
    };
    const m = mergeLd(base, ldf);
    return (
      m.r.join() === '10T1,LD1' &&
      m.d.join() === '9,8' &&
      m.o.join() === '7,6' &&
      JSON.stringify(m.ld.x[0]) === '[5,0,1,0,3,"T",0]' &&
      JSON.stringify(m.ld.a[0]) === '[9,0,1,1,3,"T"]' &&
      mergeLd(base, undefined) === base
    );
  })(),
  'mergeLd re-points LD rows at the merged route, destination and origin arrays',
);
console.assert(
  (() => {
    const trip = [
      [1, 100, 'a', 100],
      [2, 200, 'b', 190],
    ];
    const byTrip = new Map([
      ['t', trip],
      ['u', [[1, 5, 'z', 5]]],
    ]);
    const ends = [...tripEnds(byTrip, () => 0)];
    return ends.length === 1 && ends[0].stopId === 'b' && ends[0].arr === 190;
  })(),
  'tripEnds yields the arrival at the last stop of trips with 2+ calls',
);

const foldName = n =>
  n.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim();
console.assert(foldName(' Núñez  de Balboa') === 'nunez de balboa', 'foldName');

// ---------------------------------------------------------------- Ouigo (high-speed, timetable only)

const OUIGO_MAP_M = 600;
// Name words that differ between operators for the same station ("Madrid Puerta de Atocha").
const foldStation = n =>
  foldName(n)
    .replace(/\b(madrid|puerta|de|estacion|la|el)\b/g, '')
    .replace(/[^a-z0-9]+/g, '');
console.assert(
  foldStation('Madrid Puerta de Atocha') === foldStation('Madrid-Puerta de Atocha') &&
    foldStation('Madrid Puerta de Atocha') === 'atocha',
  'foldStation',
);

// The Renfe stop an Ouigo stop stands for: among Renfe stops within OUIGO_MAP_M, the one with the
// same folded name, else the nearest. Returns { stop, dist } or null.
function nearestRenfe(o, candidates) {
  const near = candidates
    .map(s => ({ stop: s, dist: metres(o, s) }))
    .filter(x => x.dist <= OUIGO_MAP_M)
    .sort((a, b) => a.dist - b.dist);
  const same = near.find(x => foldStation(x.stop.name) === foldStation(o.name));
  return same ?? near[0] ?? null;
}
console.assert(
  (() => {
    const c = [
      { id: 'a', name: 'Sol', lat: 40, lon: -3 },
      { id: 'b', name: 'Madrid Atocha', lat: 40.001, lon: -3 },
    ];
    const m = nearestRenfe({ name: 'Atocha', lat: 40.0005, lon: -3 }, c);
    return m.stop.id === 'b' && nearestRenfe({ name: 'X', lat: 41, lon: -3 }, c) === null;
  })(),
  'nearestRenfe prefers the same name, ignores stops beyond 600 m',
);

// Ouigo stops.txt -> { stops: ouigoId -> renfeId, added: [new k:'r' stops], table: [report lines] }.
async function ouigoStopMap(zip, renfeStops) {
  const map = new Map();
  const added = [];
  const table = [];
  for await (const s of rows(zip, 'stops.txt')) {
    const o = {
      id: s.stop_id,
      name: s.stop_name,
      lat: coord(s.stop_lat),
      lon: coord(s.stop_lon),
    };
    const hit = nearestRenfe(o, renfeStops);
    if (hit) {
      map.set(o.id, hit.stop.id);
      table.push(`${o.name} -> ${hit.stop.id} ${hit.stop.name} (${Math.round(hit.dist)} m)`);
      continue;
    }
    map.set(o.id, `ouigo_${o.id}`);
    added.push({ ...o, id: `ouigo_${o.id}`, wa: s.wheelchair_boarding === '1', k: 'r' });
    table.push(`${o.name} -> ouigo_${o.id} (added, no Renfe stop within ${OUIGO_MAP_M} m)`);
  }
  return { map, added, table };
}

async function ouigoRoutes(zip) {
  const routes = {};
  for await (const r of rows(zip, 'routes.txt')) {
    routes[r.route_id] = {
      line: 'OUIGO',
      name: 'Ouigo',
      color: '#E6007E',
      text: '#FFFFFF',
      ld: true,
      op: 'ouigo',
    };
  }
  return routes;
}

// Trips as { trips: ouigo:<tripId> -> { routeId: ouigo_<routeId>, serviceId }, byTrip } with the
// stop ids already mapped to Renfe ids. Only trips calling at a `madrid` stop are kept.
async function ouigoTrips(zip, routes, stopMap, madrid) {
  const all = new Map();
  for await (const t of rows(zip, 'trips.txt')) {
    if (routes[t.route_id])
      all.set(t.trip_id, { routeId: t.route_id, serviceId: t.service_id });
  }
  const raw = await loadByTrip(zip, all);
  const trips = new Map();
  const byTrip = new Map();
  for (const [id, list] of raw) {
    const mapped = list.map(([seq, dep, stopId, arr]) => [seq, dep, stopMap.get(stopId), arr]);
    if (!mapped.some(r => madrid.has(r[2]))) continue;
    trips.set(`ouigo:${id}`, { ...all.get(id), routeId: `ouigo_${all.get(id).routeId}` });
    byTrip.set(`ouigo:${id}`, mapped);
  }
  return { trips, byTrip };
}

// Folds `from` (an LD stop file of the same shape) into `into`, re-pointing its r/d/o/c indexes.
function mergeLdFile(into, from) {
  const idx = (dst, src) => src.map(v => indexOf(dst, v));
  const [ri, di, oi] = [idx(into.r, from.r), idx(into.d, from.d), idx(into.o, from.o)];
  const keys = into.c.map(c => JSON.stringify(c));
  const ci = from.c.map(c => {
    const i = indexOf(keys, JSON.stringify(c));
    if (i === into.c.length) into.c.push(c);
    return i;
  });
  for (const [secs, c, r, d, p, id, o] of from.x)
    into.x.push([secs, ci[c], ri[r], di[d], p, id, oi[o]]);
  for (const [secs, c, r, o, p, id] of from.a) into.a.push([secs, ci[c], ri[r], oi[o], p, id]);
  into.x.sort((a, b) => a[0] - b[0]);
  into.a.sort((a, b) => a[0] - b[0]);
}

// Adds every stop file of `extra` to `files` (merging where both have the stop).
function mergeLdFiles(files, extra) {
  for (const [id, f] of extra) {
    if (files.has(id)) mergeLdFile(files.get(id), f);
    else files.set(id, f);
  }
}
console.assert(
  (() => {
    const mk = (r, id) => ({
      r: [r],
      d: ['9'],
      o: ['7'],
      c: [[1, 2, 3, [], []]],
      x: [[10, 0, 0, 0, 0, id, 0]],
      a: [],
    });
    const m = mk('A', 't1');
    mergeLdFile(m, {
      ...mk('B', 'ouigo:t2'),
      c: [[9, 2, 3, [], []]],
      x: [[5, 0, 0, 0, 0, 'ouigo:t2', 0]],
    });
    return (
      m.r.join() === 'A,B' &&
      m.c.length === 2 &&
      m.x[0][5] === 'ouigo:t2' &&
      m.x[0][1] === 1 &&
      m.x[0][2] === 1 &&
      m.x[1][5] === 't1'
    );
  })(),
  'mergeLdFile re-points routes and calendars and keeps rows sorted',
);

// Ouigo high-speed: its own stop ids are mapped to Renfe stops (new k:'r' stops when none is near),
// trips are `ouigo:<id>`, routes `ouigo_<id>`. Rows use the LD per-stop format. Optional: a
// missing NAP token or any failure builds without it.
async function buildOuigo(renfe, madrid) {
  try {
    if (!(await ensureFeed(OUIGO))) return null;
    const zip = OUIGO.zip;
    const { map, added, table } = await ouigoStopMap(zip, renfe.stops);
    const routes = await ouigoRoutes(zip);
    const { trips, byTrip } = await ouigoTrips(zip, routes, map, madrid);
    const used = new Set([...trips.values()].map(t => t.serviceId));
    const cals = await busCalendars(zip, used);
    const pats = makePatterns();
    const files = ldFiles(trips, byTrip, cals, pats);
    renfe.stops.push(...added);
    const kept = new Map([...trips.values()].map(t => [t.routeId, true]));
    const out = Object.fromEntries(
      Object.entries(routes)
        .map(([id, r]) => [`ouigo_${id}`, r])
        .filter(([id]) => kept.has(id)),
    );
    return { routes: out, files, pats, trips: trips.size, table, added: added.length };
  } catch (err) {
    console.warn(`Ouigo step failed (${err.message}): skipping`);
    return null;
  }
}

// ---------------------------------------------------------------- Buses

// Town of a town-bus route id (`9__1__106_`: line 1 of municipality 106, province 28 = Madrid).
const urbanTown = (routeId, names) => {
  const muni = routeId.split('__')[2]?.replace(/\D/g, '');
  return muni ? (names[`28${muni.padStart(3, '0')}`] ?? '') : '';
};
console.assert(urbanTown('9__1__106_', { 28106: 'Parla' }) === 'Parla', 'urbanTown');
console.assert(urbanTown('9__1__9_', { 28009: 'X' }) === 'X', 'urbanTown pads');

// Town buses repeat short names across towns, so the long name carries the town.
const urbanExtra = (r, names) => {
  const town = urbanTown(r.route_id, names);
  return { urban: true, name: town ? `${r.route_long_name} · ${town}` : r.route_long_name };
};

async function busRoutes(zip, feed) {
  const routes = {};
  const names = feed.urban ? municipios() : {};
  for await (const r of rows(zip, 'routes.txt')) {
    routes[r.route_id] = {
      line: r.route_short_name,
      color: `#${r.route_color || feed.color}`,
      text: `#${r.route_text_color || 'FFFFFF'}`,
      name: r.route_long_name,
      ...(feed.k === 't' && { tram: true }),
      ...(feed.urban && urbanExtra(r, names)),
    };
  }
  return routes;
}

const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Bus `trip_headsign` is the last stop's name ("AV.RONDA-CARMEN CONDE"); the destination riders
// know is in `trip_short_name` after the line number ("461 PARLA", "lv 466  VALDEMORO"). Null
// when it doesn't have that shape (notes like "Por bus-VAO"), so the caller keeps the headsign.
const shortNameDest = (shortName, line) =>
  line
    ? (shortName.match(new RegExp(`^(?:\\S+\\s+)?${escapeRe(line)}\\s+(\\S.*)$`, 'i'))?.[1] ??
      null)
    : null;
console.assert(
  shortNameDest('461 PARLA', '461') === 'PARLA' &&
    shortNameDest('lv 466  VALDEMORO', '466') === 'VALDEMORO' &&
    shortNameDest('460 MADRID (Plaza Elíptica)', '460') === 'MADRID (Plaza Elíptica)' &&
    shortNameDest('Por bus-VAO', '688') === null &&
    shortNameDest('191191B ROBREGORDO', '191B') === null &&
    shortNameDest('1 CIRCULAR', '') === null,
  'shortNameDest',
);

async function busTrips(zip, routes, feed) {
  const trips = new Map(); // tripId -> { routeId, serviceId, head }
  for await (const t of rows(zip, 'trips.txt')) {
    if (!routes[t.route_id]) continue;
    // Light rail headsigns are already destinations; its short names are "A-B" route names.
    const dest =
      feed.k === 'b' ? shortNameDest(t.trip_short_name, routes[t.route_id].line) : null;
    const head = dest || t.trip_headsign || routes[t.route_id].name;
    trips.set(t.trip_id, {
      routeId: t.route_id,
      serviceId: t.service_id,
      head,
      short: !!dest,
      dir: t.direction_id,
    });
  }
  return trips;
}

// Words that say nothing about a place.
const FILLER_WORDS = new Set(['del', 'las', 'los']);
const destWords = n =>
  foldName(n)
    .split(/[^a-z0-9]+/)
    .filter(w => w.length > 2 && !FILLER_WORDS.has(w));
// The place of a destination, without its variant note: "MADRID (Plaza Elíptica) por los Llanos"
// -> "MADRID", "PARLA (Por Palomeque…)" -> "PARLA".
const destPlace = head => head.split(/\s*\(|\s+(?:por|sin|hasta|desde)\s/i)[0];
const samePlace = (a, b) => {
  const y = new Set(destWords(destPlace(b)));
  return destWords(destPlace(a)).some(w => y.has(w));
};
console.assert(
  samePlace('MADRID (Plaza Elíptica) por los Llanos', 'MADRID (Plaza Elíptica)') &&
    !samePlace('PARLA (Por Palomeque previa petición de parada)', 'MADRID (Plaza Elíptica)') &&
    samePlace('MADRID(Canillejas)', 'MADRID (Canillejas)'),
  'samePlace',
);

// The most common value of a list (first seen wins a tie), or undefined when empty.
const mostCommon = list => {
  const n = new Map();
  for (const x of list) n.set(x, (n.get(x) ?? 0) + 1);
  return [...n].reduce((best, x) => (x[1] > (best?.[1] ?? 0) ? x : best), undefined)?.[0];
};

const lastStopOf = list => list.reduce((a, b) => (b[0] > a[0] ? b : a))[2];

// Short-name trips grouped by route + direction + last stop.
function shortGroups(trips, byTrip) {
  const groups = new Map();
  for (const [tripId, t] of trips) {
    const list = byTrip.get(tripId);
    if (!t.short || !list?.length) continue;
    const key = `${t.routeId}|${t.dir}|${lastStopOf(list)}`;
    groups.set(key, [...(groups.get(key) ?? []), t]);
  }
  return groups;
}

// Destinations per route + direction, to spot a short name that names the other end.
function headsByDir(trips) {
  const out = new Map();
  for (const t of trips.values()) {
    const key = `${t.routeId}|${t.dir}`;
    out.set(key, (out.get(key) ?? new Set()).add(t.head));
  }
  return out;
}

const shareWord = (a, b) => {
  const y = new Set(destWords(b));
  return destWords(a).some(w => y.has(w));
};

// Does `head` misname a trip of the group whose main destination is `main`? Only when the main
// one shares a word with the last stop's name (the trip demonstrably ends there) and `head` is a
// destination of the opposite direction or shares no word with that name. Name variants and feed
// typos are left alone; so are groups whose last stop names neither (line 254's mixed-up
// directions).
const misnamed = (g, head, main) =>
  !samePlace(head, main) &&
  shareWord(main, g.lastName) &&
  (g.isOtherEnd(head) || !shareWord(head, g.lastName));

// Some short names name the origin, not where the trip goes: on line 464, trips ending at Plaza
// Elíptica are called "464 PARLA (Por Palomeque…)" or "464 YUNCLILLOS"; on 828, trips ending at
// Canillejas "828 ALCOBENDAS". Per route + direction + last stop, the main destination is the
// most common one that is not a destination of the opposite direction; a misnamed one (see
// `misnamed`) takes it. `stopName` maps stop ids to names. Returns how many trips changed.
function fixShortHeads(trips, byTrip, stopName) {
  const byDir = headsByDir(trips);
  let changed = 0;
  for (const [key, group] of shortGroups(trips, byTrip)) {
    const [routeId, dir, last] = key.split('|');
    const other = [...(byDir.get(`${routeId}|${dir === '0' ? '1' : '0'}`) ?? [])];
    const g = {
      // The exact name only: "ARGANDA (Hospital) - MORATA" is not the other end's "… - RIVAS".
      isOtherEnd: head => other.some(h => foldName(h) === foldName(head)),
      lastName: stopName(last) ?? '',
    };
    changed += renameGroup(g, group);
  }
  return changed;
}

// Gives the group's misnamed trips its main destination; returns how many changed.
function renameGroup(g, group) {
  const main = mostCommon(group.map(t => t.head).filter(h => !g.isOtherEnd(h)));
  const wrong = main ? group.filter(t => misnamed(g, t.head, main)) : [];
  for (const t of wrong) t.head = main;
  return wrong.length;
}
console.assert(
  (() => {
    const trip = (head, last, dir = '1', routeId = 'R') => [
      { routeId, head, short: true, dir },
      [
        [1, 0, 'a'],
        [2, 9, last],
      ],
    ];
    const all = [
      trip('MADRID (Plaza Elíptica)', 'pe'),
      trip('MADRID (Plaza Elíptica)', 'pe'),
      trip('MADRID (Plaza Elíptica) por los Llanos', 'pe'),
      trip('PARLA (Por Palomeque previa petición de parada)', 'pe'),
      trip('YUNCLILLOS', 'pe'),
      trip('PARLA', 'rb'),
      trip('YUNCLILLOS', 'yu', '0'),
      // 828: more trips carry the other end's name than the real destination.
      trip('ALCOBENDAS', 'ca', '1', 'S'),
      trip('ALCOBENDAS', 'ca', '1', 'S'),
      trip('MADRID(Canillejas)', 'ca', '1', 'S'),
      trip('ALCOBENDAS', 'al', '0', 'S'),
      // A loop: both directions end where they start, each keeps its name.
      trip('PARLA', 'lo', '0', 'N'),
      trip('MADRID (Atocha)', 'lo', '1', 'N'),
    ];
    const trips = new Map(all.map(([t], i) => [i, t]));
    const byTrip = new Map(all.map(([, l], i) => [i, l]));
    const names = {
      pe: 'INTERCAMBIADOR DE PLAZA ELÍPTICA',
      ca: 'INTERCAMBIADOR DE CANILLEJAS',
    };
    const n = fixShortHeads(trips, byTrip, id => names[id]);
    const heads = [...trips.values()].map(t => t.head);
    return (
      n === 4 &&
      heads[2] === 'MADRID (Plaza Elíptica) por los Llanos' &&
      heads[3] === 'MADRID (Plaza Elíptica)' &&
      heads[4] === 'MADRID (Plaza Elíptica)' &&
      heads[5] === 'PARLA' &&
      heads[7] === 'MADRID(Canillejas)' &&
      heads[8] === 'MADRID(Canillejas)' &&
      heads[11] === 'PARLA' &&
      heads[12] === 'MADRID (Atocha)'
    );
  })(),
  'fixShortHeads',
);

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

// calendar.txt and calendar_dates.txt are each optional in GTFS (a feed may ship only one).
async function* optionalRows(zip, name) {
  const listing = spawnSync('unzip', ['-Z1', zip], { encoding: 'utf8' }).stdout ?? '';
  if (listing.split('\n').includes(name)) yield* rows(zip, name);
}

async function addExceptions(zip, cals, used) {
  for await (const e of optionalRows(zip, 'calendar_dates.txt')) {
    if (!used.has(e.service_id)) continue;
    const cal = cals.get(e.service_id) ?? EMPTY_CAL();
    cals.set(e.service_id, cal);
    applyException(cal, e);
  }
}

// serviceId -> [weekdayMask, startYmd, endYmd, added[], removed[]] (dates as numbers).
async function busCalendars(zip, used) {
  const cals = new Map();
  for await (const c of optionalRows(zip, 'calendar.txt')) {
    if (used.has(c.service_id))
      cals.set(c.service_id, [maskOf(c), +c.start_date, +c.end_date, [], []]);
  }
  await addExceptions(zip, cals, used);
  for (const cal of cals.values()) cal[4] = cal[4].filter(d => runsOn(cal, d)).sort();
  return cals;
}

// Per stop: { kind: 'bus', r: routeIds, h: headsigns, c: [calendars], d: [[secs, ci, ri, hi, pi]] }.
// Calendars are inlined per stop and deduplicated, so the client never needs the whole table.
// Index of a service's calendar in a stop file's deduplicated `c` (`keys` mirrors it as JSON).
function calIndex(f, calKey, serviceId) {
  const key = calKey.get(serviceId) ?? JSON.stringify(EMPTY_CAL());
  const ci = indexOf(f.keys, key);
  if (ci === f.c.length) f.c.push(JSON.parse(key));
  return ci;
}
const calKeys = cals => new Map([...cals].map(([id, cal]) => [id, JSON.stringify(cal)]));

// `t: 1` = some trip of the feed ends at this stop (the client offers the llegadas board).
function markTermini(files, byTrip) {
  for (const list of byTrip.values()) {
    const f = list.length > 1 ? files.get(list.at(-1)[2]) : null;
    if (f) f.t = 1;
  }
}

function busFiles(trips, byTrip, cals, pats) {
  const files = new Map();
  const patOf = (tripId, list) => pats.add(trips.get(tripId).routeId, patternOf(list));
  const calKey = calKeys(cals); // serviceId -> JSON of its calendar
  for (const { tripId, secs, stopId, pi } of tripCalls(byTrip, patOf)) {
    const { routeId, serviceId, head } = trips.get(tripId);
    const f = files.get(stopId) ?? { kind: 'bus', r: [], h: [], c: [], d: [], keys: [] };
    const ci = calIndex(f, calKey, serviceId);
    f.d.push([secs, ci, indexOf(f.r, routeId), indexOf(f.h, head), pi]);
    files.set(stopId, f);
  }
  markTermini(files, byTrip);
  for (const f of files.values()) {
    delete f.keys;
    f.d.sort((a, b) => a[0] - b[0]);
  }
  return files;
}

// Per-stop merge of two bus stop files (interurban + town): routes, headsigns and calendars are
// unioned and the rows of `b` re-pointed at the merged indices. Pattern indices stay valid because
// the two feeds never share a route id (patterns are per route).
function mergeBusFiles(a, b) {
  const keys = a.c.map(c => JSON.stringify(c));
  const out = { kind: 'bus', r: [...a.r], h: [...a.h], c: [], d: [...a.d] };
  if (a.t || b.t) out.t = 1;
  const ri = b.r.map(v => indexOf(out.r, v));
  const hi = b.h.map(v => indexOf(out.h, v));
  const ci = b.c.map(c => indexOf(keys, JSON.stringify(c)));
  for (const [secs, c, r, h, pi] of b.d) out.d.push([secs, ci[c], ri[r], hi[h], pi]);
  out.c = keys.map(k => JSON.parse(k));
  out.d.sort((x, y) => x[0] - y[0]);
  return out;
}
console.assert(
  (() => {
    const cal1 = [127, 20261101, 20271231, [], []];
    const cal2 = [1, 20261101, 20271231, [], [20261129]];
    const a = { kind: 'bus', r: ['8__1'], h: ['A'], c: [cal1], d: [[100, 0, 0, 0, 2]] };
    const b = {
      kind: 'bus',
      r: ['9__X', '8__1'],
      h: ['B', 'A'],
      c: [cal2, cal1],
      d: [
        [50, 0, 0, 0, 7],
        [200, 1, 1, 1, 3],
        [300, 0, 0, 1],
      ],
    };
    const m = mergeBusFiles(a, b);
    const row = i => JSON.stringify(m.d[i]);
    return (
      m.r.join() === '8__1,9__X' &&
      m.h.join() === 'A,B' &&
      m.c.length === 2 &&
      JSON.stringify(m.c[0]) === JSON.stringify(cal1) &&
      JSON.stringify(m.c[1]) === JSON.stringify(cal2) &&
      row(0) === '[50,1,1,1,7]' &&
      row(1) === '[100,0,0,0,2]' &&
      row(2) === '[200,0,0,0,3]' &&
      row(3) === '[300,1,1,0,null]'
    );
  })(),
  'mergeBusFiles remaps routes, headsigns, calendars and keeps pattern indices',
);

// Stops of the town feed not in the interurban one, flagged `u` (served only by town buses).
function urbanOnlyStops(bus, urb) {
  const known = new Set((bus?.stops ?? []).map(s => s.id));
  return urb.stops.filter(s => !known.has(s.id)).map(s => ({ ...s, u: true }));
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
  const trips = await busTrips(zip, routes, feed);
  const used = new Set([...trips.values()].map(t => t.serviceId));
  const cals = await busCalendars(zip, used);
  const byTrip = await loadByTrip(zip, trips);
  const stopNames = new Map();
  for await (const s of rows(zip, 'stops.txt')) stopNames.set(s.stop_id, s.stop_name);
  const fixed = fixShortHeads(trips, byTrip, id => stopNames.get(id));
  if (fixed) console.log(`${feed.label}: ${fixed} short-name destinations replaced`);
  const pats = makePatterns();
  const files = busFiles(trips, byTrip, cals, pats);
  const stops = await busStops(zip, files, feed);
  return { routes, stops, files, pats, trips: trips.size };
}

// Never fails the build: a missing or broken town-bus feed only drops town-only stops.
async function buildUrban() {
  try {
    return await buildCrtm(URB);
  } catch (err) {
    console.warn(`town bus step failed (${err.message}): skipping`);
    return null;
  }
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

// calendar.txt service id -> day type: Sunday/holiday services `fes`, Saturday-only `sab`, the
// rest (Mon-Thu, Fri, Mon-Fri) `lab`.
function dayTypeOf(c) {
  if (c.sunday === '1') return 'fes';
  const weekday = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'].some(
    d => c[d] === '1',
  );
  return c.saturday === '1' && !weekday ? 'sab' : 'lab';
}
async function emtDayTypes(zip) {
  const types = new Map();
  for await (const c of rows(zip, 'calendar.txt')) {
    types.set(c.service_id, dayTypeOf(c));
  }
  return types;
}

const hhmmOf = secs => {
  const m = Math.floor(secs / 60) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
};

// Frequency entries [dayType, startSecs, endSecs, headwaySecs] -> per day type
// [firstHHMM, lastHHMM, minHeadwayMin, maxHeadwayMin].
function summariseFreq(entries) {
  const out = {};
  for (const [day, start, end, headway] of entries) {
    const min = Math.max(1, Math.round(headway / 60));
    const [a, b, lo, hi] = out[day] ?? [start, end, min, min];
    out[day] = [Math.min(a, start), Math.max(b, end), Math.min(lo, min), Math.max(hi, min)];
  }
  return Object.fromEntries(
    Object.entries(out).map(([d, [a, b, lo, hi]]) => [d, [hhmmOf(a), hhmmOf(b), lo, hi]]),
  );
}
console.assert(
  (() => {
    const s = summariseFreq([
      ['lab', 25200, 28799, 1380],
      ['lab', 28800, 86399, 660],
      ['lab', 25200, 86399, 900],
      ['fes', 32400, 79199, 1200],
    ]);
    return (
      JSON.stringify(s.lab) === '["07:00","23:59",11,23]' &&
      JSON.stringify(s.fes) === '["09:00","21:59",20,20]' &&
      !s.sab
    );
  })(),
  'summariseFreq: first/last, min/max headway, per day type',
);

// Adds `svc` (per day type summary) to the EMT routes from frequencies.txt (streamed).
async function emtTrips(zip, keys) {
  const days = await emtDayTypes(zip);
  const trips = new Map();
  for await (const t of rows(zip, 'trips.txt')) {
    const key = keys.get(t.route_id);
    const day = days.get(t.service_id);
    if (key && day) trips.set(t.trip_id, [key, day]);
  }
  return trips;
}

async function emtService(zip, routes, keys) {
  const trips = await emtTrips(zip, keys);
  const byRoute = new Map();
  for await (const f of rows(zip, 'frequencies.txt')) {
    const [key, day] = trips.get(f.trip_id) ?? [];
    const headway = Number(f.headway_secs);
    if (!key || !(headway > 0)) continue;
    byRoute.set(key, [
      ...(byRoute.get(key) ?? []),
      [day, toSecs(f.start_time), toSecs(f.end_time), headway],
    ]);
  }
  for (const [key, list] of byRoute) routes[key].svc = summariseFreq(list);
  return byRoute.size;
}

// Never fails the build: a missing or broken EMT feed only drops EMT stops.
async function buildEmt() {
  try {
    if (!(await ensureFeed({ ...EMT, auth: false }))) return null;
    const zip = EMT.zip;
    const { routes, keys } = await emtRoutes(zip);
    const stops = await emtStops(zip);
    if (!stops.length) throw new Error('no stops');
    const withSvc = await emtService(zip, routes, keys).catch(err => {
      console.warn(`EMT frequencies skipped (${err.message})`);
      return 0;
    });
    const ofTrip = await tripRoutes(zip, id => keys.get(id));
    const pats = await streamPatterns(
      zip,
      id => ofTrip.get(id),
      id => (/^\d{1,6}$/.test(id) ? `emt_${id}` : null),
    );
    return { routes, stops, pats, withSvc };
  } catch (err) {
    console.warn(`EMT step failed (${err.message}): skipping`);
    return null;
  }
}

// ---------------------------------------------------------------- Towns (CRTM open data)

// Town names by INE code (Wikidata, committed). Untrusted-looking data is only ever parsed.
const municipios = () => JSON.parse(readFileSync(`${ROOT}scripts/municipios.json`, 'utf8'));

// One ArcGIS page: CODIGOESTACION (= GTFS stop_code) -> INE code (province + municipality).
const TOWN_FIELDS = 'CODIGOESTACION,CODIGOMUNICIPIO,CODIGOPROVINCIA';
const ADDRESS_FIELDS = 'TIPOVIA,PARTICULA,NOMBREVIA,NUMEROPORTAL';
async function crtmPage(layer, offset, address) {
  const params = new URLSearchParams({
    where: '1=1',
    outFields: address ? `${TOWN_FIELDS},${ADDRESS_FIELDS}` : TOWN_FIELDS,
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

async function crtmRecords(layer, address) {
  const records = [];
  for (let more = true; more;) {
    const page = await crtmPage(layer, records.length, address);
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
    // A cache written before the address fields were requested is unusable for address feeds.
    const ok = Array.isArray(data) && (!feed.address || !data.length || 'NOMBREVIA' in data[0]);
    return ok ? data : null;
  } catch {
    return null;
  }
};
const cacheFresh = feed =>
  existsSync(feed.townCache) && Date.now() - statSync(feed.townCache).mtimeMs < TOWN_MAX_AGE_MS;

async function fetchRecords(feed) {
  const records = await crtmRecords(feed.layer, !!feed.address);
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

// "<TIPOVIA> <PARTICULA> <NOMBREVIA> <NUMEROPORTAL>" without blank parts (PARTICULA ' ' = none).
const addressOf = r =>
  [r.TIPOVIA, r.PARTICULA, r.NOMBREVIA, r.NUMEROPORTAL]
    .map(v => String(v ?? '').trim())
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ');
console.assert(
  addressOf({
    TIPOVIA: 'Calle',
    PARTICULA: 'del',
    NOMBREVIA: 'Doctor Esquerdo',
    NUMEROPORTAL: 49,
  }) === 'Calle del Doctor Esquerdo 49' &&
    addressOf({ TIPOVIA: 'Calle', PARTICULA: ' ', NOMBREVIA: 'Mayor', NUMEROPORTAL: '' }) ===
      'Calle Mayor',
  'addressOf',
);

// Fills `desc` (street address) from the feed's layer on stops that have none. Returns the
// number of stops that now have one.
async function assignAddresses(stops, feed) {
  const byCode = new Map();
  for (const r of await crtmData(feed))
    byCode.set(String(r.CODIGOESTACION ?? '').trim(), addressOf(r));
  for (const s of stops) if (!s.desc?.trim()) s.desc = byCode.get(s.code) || s.desc;
  return stops.filter(s => s.desc?.trim()).length;
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

async function assignTowns(renfeStops, bus, ml, metro, urbOnly) {
  const t = { bus: 0, ml: 0, metro: 0, renfe: 0, urb: 0 };
  if (urbOnly.length) t.urb = assignCrtmTowns(urbOnly, await townsByCode(URB));
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

// The stop's CRTM file: interurban and town buses at one stop are merged into one.
const crtmFile = (id, crtm) => {
  const found = crtm.flatMap(f => f.files.get(id) ?? []);
  return found.length ? found.reduce(mergeBusFiles) : null;
};

async function writeStopFiles(stops, renfe, crtm, ld) {
  for (const s of stops) {
    if (s.k === 'e' || s.k === 'm') continue; // EMT and Metro stops have no file (live only)
    const base = renfe.files.get(s.id) ?? renfe.empty;
    const file = crtmFile(s.id, crtm) ?? mergeLd(base, ld?.files.get(s.id));
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

// stop-lines.json = { stopId: [routeId, ...] } over every feed's patterns (the stop info panel
// reads it instead of scanning hundreds of route files).
function stopLines(feeds) {
  const map = new Map();
  const routes = feeds.filter(Boolean).flatMap(f => [...f.pats.routes]);
  for (const [routeId, { list }] of routes.filter(([id]) => /^[\w.-]{1,40}$/.test(id))) {
    for (const stopId of new Set(list.flat(2).filter(x => typeof x === 'string'))) {
      map.set(stopId, (map.get(stopId) ?? new Set()).add(routeId));
    }
  }
  return Object.fromEntries(
    [...map].map(([id, set]) => [id, [...set].sort((a, b) => a.localeCompare(b))]),
  );
}
console.assert(
  (() => {
    const pats = {
      routes: new Map([
        [
          'r1',
          {
            list: [
              [
                ['a', 0],
                ['b', 60],
              ],
              [
                ['b', 0],
                ['c', 9],
              ],
            ],
          },
        ],
      ]),
    };
    const m = stopLines([{ pats }, null]);
    return m.a.join() === 'r1' && m.b.join() === 'r1' && m.c.length === 1;
  })(),
  'stopLines maps stops to the routes whose patterns contain them',
);

// public/rt-stops.php: the stops rt.php may fetch live (keyed arrays for O(1) isset). EMT stop
// numbers; CRTM codes `8_`/`10_`/`4_` from the stop ids (Metro: kept ids after the merge) and
// `6_<emt number>` (fallback). Every key must match rt.php's regexes. Generated, not committed.
const EMT_KEY = /^\d{1,6}$/;
const CRTM_KEY = /^(4|6|8|10)_\d{1,6}$/;
console.assert(CRTM_KEY.test('10_52') && !CRTM_KEY.test('8_0\n'), 'CRTM_KEY');

function allowList(stops) {
  const emt = new Set();
  const crtm = new Set();
  for (const s of stops) {
    if (s.k === 'e') {
      emt.add(s.code);
      crtm.add(`6_${s.code}`);
    } else if (/^par_(4|8|10)_\d+$/.test(s.id)) {
      crtm.add(s.id.slice(4));
    }
  }
  const bad = [...emt].filter(k => !EMT_KEY.test(k));
  bad.push(...[...crtm].filter(k => !CRTM_KEY.test(k)));
  if (bad.length)
    throw new Error(`allow-list keys rejected by rt.php: ${bad.slice(0, 5).join(', ')}`);
  return { emt: [...emt], crtm: [...crtm] };
}

// PHP single-quoted string: only \ and ' need escaping (keys are validated digits anyway).
const phpKey = k => `'${k.replace(/[\\']/g, '\\$&')}' => 1`;
const phpGroup = (name, keys) => `'${name}' => [${keys.map(phpKey).join(', ')}]`;

async function writeAllowList(stops) {
  const list = allowList(stops);
  const php = `<?php return [${phpGroup('emt', list.emt)}, ${phpGroup('crtm', list.crtm)}];\n`;
  await writeFile(`${PUBLIC}rt-stops.php`, php);
  const by = Object.groupBy(list.crtm, k => k.split('_')[0]);
  console.log(
    `rt-stops.php ${kb(Buffer.byteLength(php))}: emt ${list.emt.length}, crtm 8_ ${by[8]?.length ?? 0}, 10_ ${by[10]?.length ?? 0}, 4_ ${by[4]?.length ?? 0}, 6_ ${by[6]?.length ?? 0}`,
  );
}

const crtmLine = (name, f) =>
  f
    ? `${name}: routes ${Object.keys(f.routes).length}, trips ${f.trips}, stops ${f.stops.length}`
    : `${name}: skipped`;

function report(renfe, bus, urb, ml, metro, emt, stops, sz, urbOnly, ld) {
  const files = readdirSync(`${OUT}stop`).map(f => [f, statSync(`${OUT}stop/${f}`).size]);
  const total = files.reduce((n, [, s]) => n + s, 0);
  const [bigName, bigSize] = files.reduce((a, b) => (b[1] > a[1] ? b : a));
  const big = sizes(readFileSync(`${OUT}stop/${bigName}`, 'utf8'));
  const { from, to } = renfe.days;
  console.log(
    `renfe: routes ${Object.keys(renfe.routes).length}, trips ${renfe.trips}, stops ${renfe.stops.length}, days ${from}..${to}`,
  );
  console.log(
    ld
      ? `LD: routes ${Object.keys(ld.routes).length}, trips ${ld.trips}, stops ${ld.files.size} (${ld.newStops} added to Renfe stops)`
      : 'LD: skipped',
  );
  console.log(crtmLine('bus', bus));
  console.log(crtmLine('town bus', urb));
  if (urb)
    console.log(
      `town bus: ${urbOnly.length} town-only stops, ${urb.stops.length - urbOnly.length} merged`,
    );
  console.log(crtmLine('light rail', ml));
  console.log(
    metro
      ? `Metro: routes ${Object.keys(metro.routes).length}, stations ${metro.stops.length} (${metro.merged} duplicates merged)`
      : 'Metro: skipped',
  );
  console.log(
    emt
      ? `EMT: routes ${Object.keys(emt.routes).length} (${emt.withSvc} with svc), stops ${emt.stops.length}`
      : 'EMT: skipped',
  );
  console.log(
    `stops.json ${kb(sz.stops.raw)} raw, ${kb(sz.stops.gz)} gzip (${stops.length} stops)`,
  );
  console.log(`stop-lines.json ${kb(sz.lines.raw)} raw, ${kb(sz.lines.gz)} gzip`);
  const rf = readdirSync(`${OUT}route`).map(f => [f, statSync(`${OUT}route/${f}`).size]);
  const [rBig, rBigSize] = rf.reduce((a, b) => (b[1] > a[1] ? b : a));
  console.log(
    `route files ${rf.length}, total ${kb(rf.reduce((n, [, s]) => n + s, 0))}, largest ${rBig} ${kb(rBigSize)}`,
  );
  console.log(
    `per-stop files ${files.length}, total ${kb(total)}, largest ${bigName} ${kb(bigSize)} raw, ${kb(big.gz)} gzip`,
  );
}

// The LD build with the Ouigo stop files merged in (a bare shell when only Ouigo built).
function joinOuigo(ld, ouigo) {
  if (!ouigo) return ld;
  const base = ld ?? {
    routes: {},
    files: new Map(),
    pats: makePatterns(),
    trips: 0,
    newStops: 0,
  };
  mergeLdFiles(base.files, ouigo.files);
  return base;
}

function reportOuigo(ouigo) {
  if (!ouigo) return console.log('Ouigo: skipped');
  console.log(
    `Ouigo: routes ${Object.keys(ouigo.routes).length}, trips ${ouigo.trips}, stops ${ouigo.table.length} (${ouigo.table.length - ouigo.added} mapped, ${ouigo.added} added)`,
  );
  for (const line of ouigo.table) console.log(`  ${line}`);
}

async function main() {
  const renfe = await buildRenfe();
  const madrid = new Set([...renfe.stops.map(s => s.id), ...LD_HUBS]);
  const ld0 = await buildLd(renfe); // adds its stops to renfe.stops before towns are assigned
  const ouigo = await buildOuigo(renfe, madrid);
  const ld = joinOuigo(ld0, ouigo);
  const bus = await buildCrtm(BUS);
  const ml = await buildCrtm(ML);
  const urb = await buildUrban();
  const metro = await buildMetro();
  const emt = await buildEmt();
  const urbOnly = urb ? urbanOnlyStops(bus, urb) : [];
  const a = {
    emt: emt ? await assignAddresses(emt.stops, EMT) : 0,
    metro: metro ? await assignAddresses(metro.stops, METRO) : 0,
    ml: ml ? await assignAddresses(ml.stops, ML) : 0,
  };
  console.log(
    `addresses: EMT ${a.emt}/${emt?.stops.length ?? 0}, metro ${a.metro}/${metro?.stops.length ?? 0}, light rail ${a.ml}/${ml?.stops.length ?? 0}`,
  );
  const t = await assignTowns(renfe.stops, bus, ml, metro, urbOnly);
  console.log(
    `towns: town-only bus ${t.urb}/${urbOnly.length}, bus ${t.bus}/${bus?.stops.length ?? 0}, light rail ${t.ml}/${ml?.stops.length ?? 0}, metro ${t.metro}/${metro?.stops.length ?? 0}, renfe ${t.renfe}/${renfe.stops.length} (nearest bus stop within ${NEAREST_TOWN_M} m)`,
  );
  const stops = [
    ...renfe.stops,
    ...(bus?.stops ?? []),
    ...urbOnly,
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
    ...ld?.routes,
    ...ouigo?.routes,
    ...bus?.routes,
    ...urb?.routes,
    ...ml?.routes,
    ...metro?.routes,
    ...emt?.routes,
  });
  await writeJson('days.json', renfe.days);
  await writeStopFiles(stops, renfe, [bus, urb, ml].filter(Boolean), ld);
  await writeRouteFiles([renfe, ld, ouigo, bus, urb, ml, metro, emt]);
  sz.lines = await writeJson(
    'stop-lines.json',
    stopLines([renfe, ld, ouigo, bus, urb, ml, metro, emt]),
  );
  await writeAllowList(stops);
  report(renfe, bus, urb, ml, metro, emt, stops, sz, urbOnly, ld);
  reportOuigo(ouigo);
}

await main();
