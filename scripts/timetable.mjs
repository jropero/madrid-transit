// Builds the static Madrid timetable (Renfe Cercanías, route_id 10T…) into public/data/.
// Plain Node, no dependencies. The downloaded GTFS zip is untrusted data: it is only parsed
// (never executed), lives in .cache/, and stop_times.txt is streamed through `unzip -p`.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  rmSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const URL_ZIP = 'https://ssl.renfe.com/ftransit/Fichero_CER_FOMENTO/fomento_transit.zip';
const ROOT = new URL('..', import.meta.url).pathname;
const CACHE = `${ROOT}.cache/`;
const ZIP = `${CACHE}fomento.zip`;
const OUT = `${ROOT}public/data/`;
const MAX_AGE_MS = 12 * 60 * 60 * 1000;

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

async function download() {
  mkdirSync(CACHE, { recursive: true });
  if (existsSync(ZIP) && Date.now() - statSync(ZIP).mtimeMs < MAX_AGE_MS) {
    console.log('using cached zip');
    return;
  }
  console.log('downloading', URL_ZIP);
  const res = await fetch(URL_ZIP);
  if (!res.ok || !res.body) throw new Error(`download failed: HTTP ${res.status}`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(ZIP));
}

// Streams one file of the zip as objects keyed by header name.
async function* rows(name) {
  const unzip = spawn('unzip', ['-p', ZIP, name], { stdio: ['ignore', 'pipe', 'inherit'] });
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

const isMadrid = routeId => routeId.startsWith('10T');

async function loadRoutes() {
  const routes = {};
  for await (const r of rows('routes.txt')) {
    if (!isMadrid(r.route_id)) continue;
    routes[r.route_id] = {
      line: r.route_short_name,
      color: `#${r.route_color || '75B6E0'}`,
      text: `#${r.route_text_color || 'FFFFFF'}`,
    };
  }
  return routes;
}

async function loadTrips(routes) {
  const trips = new Map(); // tripId -> { routeId, serviceId }
  for await (const t of rows('trips.txt')) {
    if (routes[t.route_id])
      trips.set(t.trip_id, { routeId: t.route_id, serviceId: t.service_id });
  }
  return trips;
}

const pad = n => String(n).padStart(2, '0');
const ymd = d => `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
const parseYmd = s => new Date(Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8)));
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

// Every date a calendar row runs on (its weekday flags between start_date and end_date).
function* datesOf(c) {
  const end = parseYmd(c.end_date);
  for (let d = parseYmd(c.start_date); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    if (c[WEEKDAYS[d.getUTCDay()]] === '1') yield ymd(d);
  }
}

async function loadDays(usedServices) {
  const days = {};
  for await (const c of rows('calendar.txt')) {
    if (!usedServices.has(c.service_id)) continue;
    for (const key of datesOf(c)) (days[key] ??= []).push(c.service_id);
  }
  const keys = Object.keys(days).sort();
  return { days, from: keys[0], to: keys.at(-1) };
}

async function loadStopTimes(trips) {
  const byTrip = new Map(); // tripId -> [[seq, depSecs, stopId]]
  for await (const s of rows('stop_times.txt')) {
    if (!trips.has(s.trip_id)) continue;
    const list = byTrip.get(s.trip_id) ?? [];
    list.push([Number(s.stop_sequence), toSecs(s.departure_time || s.arrival_time), s.stop_id]);
    byTrip.set(s.trip_id, list);
  }
  return byTrip;
}

// Per stop, compact: { r: routeIds, d: destStopIds, s: { serviceId: [[secs, tripSuffix, ri, di]] } }.
// The trip id is stored without its service-id prefix (the client re-adds it); rows are sorted by
// secs (which may exceed 24h); each trip's last stop is dropped (no departure there).
function addTrip(files, tripId, list, { routeId, serviceId }) {
  list.sort((a, b) => a[0] - b[0]);
  const dest = list.at(-1)[2];
  const suffix = tripId.startsWith(serviceId) ? tripId.slice(serviceId.length) : `!${tripId}`;
  for (const [, secs, stopId] of list.slice(0, -1)) {
    const f = files.get(stopId) ?? { r: [], d: [], s: {} };
    (f.s[serviceId] ??= []).push([secs, suffix, indexOf(f.r, routeId), indexOf(f.d, dest)]);
    files.set(stopId, f);
  }
}

function buildDepartures(trips, byTrip) {
  const files = new Map();
  for (const [tripId, list] of byTrip) addTrip(files, tripId, list, trips.get(tripId));
  for (const f of files.values()) {
    for (const rows of Object.values(f.s)) rows.sort((a, b) => a[0] - b[0]);
  }
  return files;
}

const indexOf = (arr, v) => {
  const i = arr.indexOf(v);
  return i >= 0 ? i : arr.push(v) - 1;
};

async function loadStops(wanted) {
  const stops = [];
  for await (const s of rows('stops.txt')) {
    if (!wanted.has(s.stop_id)) continue;
    stops.push({
      id: s.stop_id,
      name: s.stop_name,
      lat: Number(s.stop_lat),
      lon: Number(s.stop_lon),
      wa: s.wheelchair_boarding === '1',
    });
  }
  return stops.sort((a, b) => a.name.localeCompare(b.name, 'es'));
}

async function main() {
  await download();
  const routes = await loadRoutes();
  const trips = await loadTrips(routes);
  const byTrip = await loadStopTimes(trips);
  const perStop = buildDepartures(trips, byTrip);
  // Every stop a Madrid trip touches, termini included (they name destinations).
  const touched = new Set([...byTrip.values()].flatMap(list => list.map(r => r[2])));
  const stops = await loadStops(touched);
  const used = new Set([...trips.values()].map(t => t.serviceId));
  const { days, from, to } = await loadDays(used);

  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(`${OUT}stop`, { recursive: true });
  await writeFile(`${OUT}stops.json`, JSON.stringify(stops));
  await writeFile(`${OUT}routes.json`, JSON.stringify(routes));
  await writeFile(`${OUT}days.json`, JSON.stringify({ from, to, days }));
  // One file per stop, an empty file for terminus-only stops, so the client never hits a 404.
  for (const { id } of stops) {
    await writeFile(
      `${OUT}stop/${id}.json`,
      JSON.stringify(perStop.get(id) ?? { r: [], d: [], s: {} }),
    );
  }

  const files = readdirSync(`${OUT}stop`).map(f => [f, statSync(`${OUT}stop/${f}`).size]);
  const total = files.reduce((n, [, s]) => n + s, 0);
  const [bigName, bigSize] = files.reduce((a, b) => (b[1] > a[1] ? b : a));
  console.log(
    `routes ${Object.keys(routes).length}, trips ${trips.size}, stops ${stops.length}, ` +
      `per-stop files ${files.length}, days ${Object.keys(days).length} (${from}..${to})`,
  );
  console.log(
    `per-stop total ${(total / 1024).toFixed(0)} KB, largest ${bigName} ${(bigSize / 1024).toFixed(0)} KB`,
  );
}

await main();
