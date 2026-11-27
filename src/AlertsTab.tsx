import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { count } from './Alerts.tsx';
import { parseAvisos, type AvisosMode } from './avisos.ts';
import { LineTile } from './LineScan.tsx';
import StatusNote from './StatusNote.tsx';
import {
  errNoteOf,
  feedNoteOf,
  fetchAlerts,
  fetchAvisos,
  fetchEmt,
  isOffline,
  loadAllStops,
  loadStopDeps,
  nearFailure,
} from './data.ts';
import {
  AREA_RADIUS,
  alertsFor,
  locate,
  mergeIncidents,
  parseAlerts,
  parseEmtIncidents,
  short,
  stopsWithin,
  type Alert,
  type FeedNote,
  type NearStop,
  type RouteMap,
  type Saved,
  type Stop,
  bodyOf,
} from './gtfs.ts';

// The pivot "alertas": every alert for the selected stop and the stops within AREA_RADIUS of it
// (or of the user), split by source. Each source is one entry of SOURCES; a new one (e.g. a CRTM
// alert feed) only needs its `load`. Dismissals (salidas) are ignored here.
const REFRESH_MS = 60_000;
const EMT_MAX = 6; // nearest EMT stops asked
const EMT_PARALLEL = 3; // requests in flight

type Point = { lat: number; lon: number };
type Centre = { key: string; stopId: string; at: Point | null };
type Area = { at: Point; me: boolean; stops: NearStop[] };
type Item = { alert: Alert; seen: string[]; lines: string[] };
type Group = {
  label: string;
  items: Item[];
  error?: string;
  note?: FeedNote | null;
};
// `groups` (CRTM, one per mode) are rendered instead of `items`, which then only feeds the count.
type Result = { items: Item[]; note: FeedNote | null; warn?: string[]; groups?: Group[] };
type Section = ({ k: 'ok' } & Result) | { k: 'error'; text: string; note: FeedNote | null };
type Source = {
  key: string;
  label: string;
  kinds: (Stop['k'] | undefined)[]; // the section shows when the area has such stops
  load: (area: Area) => Promise<Result>;
};

// Runs `fn` over `items`, at most `n` at a time; results keep the order of `items`.
async function pool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return out;
}
void pool([1, 2, 3, 4], 2, async x => x * 2).then(r =>
  console.assert(r.join() === '2,4,6,8', 'pool keeps order'),
);

const ofKind = (area: Area, kinds: Source['kinds']) =>
  area.stops.filter(s => kinds.includes(s.k));

// Renfe: the network-wide feed, narrowed to the routes serving the Renfe stations of the area.
async function loadRenfe(area: Area): Promise<Result> {
  const ids = ofKind(area, ['r']).map(s => s.id);
  const [feed, files] = await Promise.all([
    fetchAlerts(),
    Promise.all(ids.map(id => loadStopDeps(id).catch(() => null))),
  ]);
  const mine = new Set(files.flatMap(f => f?.r ?? []));
  const items = alertsFor(parseAlerts(feed.data), mine).map(alert => ({
    alert,
    seen: [],
    lines: alert.routeIds.filter(r => mine.has(r)),
  }));
  return { items, note: feedNoteOf('Renfe', feed) };
}

const stopLabel = (s: Stop) => (s.code ? `${short(s.name)} (${s.code})` : short(s.name));

async function probeEmt(s: Stop) {
  try {
    const feed = await fetchEmt(s.id);
    const alerts = parseEmtIncidents(feed.data, new Date());
    return { stop: stopLabel(s), alerts, note: feedNoteOf('EMT', feed), error: null };
  } catch (error) {
    return { stop: stopLabel(s), alerts: [], note: null, error };
  }
}

const emtWarn = (all: number, failed: number) => [
  ...(all > EMT_MAX ? [`solo las ${EMT_MAX} paradas de EMT más cercanas, de ${all}`] : []),
  ...(failed ? [`${failed} sin respuesta`] : []),
];

// EMT: incidents per stop, nearest stops only, the same incident merged across stops.
async function loadEmt(area: Area): Promise<Result> {
  const all = ofKind(area, ['e']);
  const probes = await pool(all.slice(0, EMT_MAX), EMT_PARALLEL, probeEmt);
  const failed = probes.filter(p => p.error !== null);
  if (probes.length && failed.length === probes.length) throw failed[0].error;
  const items = mergeIncidents(probes).map(m => ({ ...m, lines: [] }));
  return {
    items,
    note: probes.find(p => p.note)?.note ?? null,
    warn: emtWarn(all.length, failed.length),
  };
}

// CRTM publishes mode-wide notices on its "Avisos" pages: one page per mode present in the area.
const CRTM_MODES: { kind: Stop['k']; mode: AvisosMode; label: string }[] = [
  { kind: 'b', mode: 'interurbanos', label: 'autobuses interurbanos' },
  { kind: 't', mode: 'metro-ligero', label: 'metro ligero' },
  { kind: 'm', mode: 'metro', label: 'metro' },
];
const CRTM_GENERAL = 'avisos generales del CRTM para toda la red, no solo para estas paradas';

const publishedOn = (d: Date | null) =>
  d
    ? `publicado el ${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`
    : '';

async function loadCrtmMode(m: (typeof CRTM_MODES)[number]): Promise<Group> {
  try {
    const feed = await fetchAvisos(m.mode);
    const items = parseAvisos(feed.data.html, m.mode).map(a => ({
      alert: { ...a, when: publishedOn(a.from) },
      seen: [],
      lines: [],
    }));
    return { label: m.label, items, note: feedNoteOf('CRTM', feed) };
  } catch (err) {
    return { label: m.label, items: [], error: failText(err), note: errNoteOf('CRTM', err) };
  }
}

async function loadCrtm(area: Area): Promise<Result> {
  const modes = CRTM_MODES.filter(m => ofKind(area, [m.kind]).length);
  const groups = await Promise.all(modes.map(loadCrtmMode));
  if (groups.every(g => g.error)) throw new Error(groups[0]?.error);
  return { items: groups.flatMap(g => g.items), note: null, warn: [CRTM_GENERAL], groups };
}

const SOURCES: Source[] = [
  { key: 'renfe', label: 'Renfe', kinds: ['r'], load: loadRenfe },
  { key: 'emt', label: 'EMT', kinds: ['e'], load: loadEmt },
  { key: 'crtm', label: 'CRTM', kinds: ['b', 't', 'm'], load: loadCrtm },
];

function failText(err: unknown) {
  return isOffline(err)
    ? 'sin conexión · avisos no disponibles'
    : 'no se pudieron cargar los avisos';
}

async function runSource(src: Source, area: Area): Promise<Section> {
  try {
    return { k: 'ok', ...(await src.load(area)) };
  } catch (err) {
    return { k: 'error', text: failText(err), note: errNoteOf(src.label, err) };
  }
}

type Got = { key: string; area: Area | null; error: string; sections: Record<string, Section> };

// The area around the centre: the user's position, or the selected stop's own coordinates.
async function resolveArea(c: Centre): Promise<Area | string> {
  let all: Stop[];
  try {
    all = await loadAllStops();
  } catch (err) {
    return nearFailure(err);
  }
  const at = c.at ?? all.find(s => s.id === c.stopId);
  if (!at) return 'parada no encontrada';
  return { at, me: c.at !== null, stops: stopsWithin(all, at, AREA_RADIUS) };
}

// Loads when `active` and whenever the centre changes, then every REFRESH_MS while the page is
// visible. A refresh keeps the old answer on screen; a new centre starts from "cargando…".
function useAreaAlerts(centre: Centre, active: boolean) {
  const [got, setGot] = useState<Got | null>(null);
  const gen = useRef(0);
  const load = useCallback(async () => {
    const g = ++gen.current;
    const patch = (fn: (prev: Got) => Got) =>
      setGot(prev => (g === gen.current && prev?.key === centre.key ? fn(prev) : prev));
    const area = await resolveArea(centre);
    if (g !== gen.current) return;
    const fresh = typeof area === 'string' ? { area: null, error: area } : { area, error: '' };
    setGot(prev => ({
      key: centre.key,
      sections: prev?.key === centre.key ? prev.sections : {},
      ...fresh,
    }));
    if (typeof area === 'string') return;
    for (const src of SOURCES.filter(s => ofKind(area, s.kinds).length)) {
      void runSource(src, area).then(sec =>
        patch(prev => ({ ...prev, sections: { ...prev.sections, [src.key]: sec } })),
      );
    }
  }, [centre]);

  useEffect(() => {
    if (!active) return;
    void load();
    const id = setInterval(() => document.hidden || void load(), REFRESH_MS);
    return () => clearInterval(id);
  }, [active, load]);

  return got?.key === centre.key ? got : null;
}

function AlertItem({ item, routes }: { item: Item; routes: RouteMap | null }) {
  const { alert } = item;
  const tiles = new Map(
    item.lines.flatMap(r => (routes?.[r] ? [[routes[r].line, routes[r]] as const] : [])),
  );
  return (
    <li className="area-alert">
      <b lang="es">{alert.title}</b>
      {alert.when && <span lang="es"> · {alert.when}</span>}
      {bodyOf(alert) && (
        <span className="alert-full" lang="es">
          {bodyOf(alert)}
        </span>
      )}
      {alert.url && (
        <a href={alert.url} target="_blank" rel="noopener">
          Más información
        </a>
      )}
      {tiles.size > 0 && (
        <span className="area-lines" aria-label="líneas afectadas">
          {[...tiles.values()].map(r => (
            <LineTile key={r.line} route={r} />
          ))}
        </span>
      )}
      {item.seen.length > 0 && <span className="alert-full">en: {item.seen.join(' · ')}</span>}
    </li>
  );
}

function GroupBody({ g, routes }: { g: Group; routes: RouteMap | null }) {
  return (
    <>
      <h4 className="alert-sub">{g.label}</h4>
      {g.error && <p className="status">{g.error}</p>}
      {!g.error && g.items.length === 0 && <p className="status">sin avisos</p>}
      <AlertList items={g.items} routes={routes} />
      {g.note && <StatusNote note={g.note} />}
    </>
  );
}

function AlertList({ items, routes }: { items: Item[]; routes: RouteMap | null }) {
  if (!items.length) return null;
  return (
    <ul className="alert-list">
      {items.map(i => (
        <AlertItem key={i.alert.id} item={i} routes={routes} />
      ))}
    </ul>
  );
}

function SourceBody({ sec, routes }: { sec: Section | undefined; routes: RouteMap | null }) {
  if (!sec) return <p className="status">cargando…</p>;
  if (sec.k === 'error')
    return (
      <>
        <p className="status">{sec.text}</p>
        {sec.note && <StatusNote note={sec.note} />}
      </>
    );
  return (
    <>
      {sec.groups ? (
        sec.groups.map(g => <GroupBody key={g.label} g={g} routes={routes} />)
      ) : (
        <AlertList items={sec.items} routes={routes} />
      )}
      {sec.warn?.map(w => (
        <p key={w} className="status">
          {w}
        </p>
      ))}
      {sec.note && <StatusNote note={sec.note} />}
    </>
  );
}

const countText = (sec: Section | undefined) => {
  if (!sec || sec.k === 'error') return '';
  return sec.items.length ? count(sec.items.length) : 'sin avisos';
};

function SourceSection(p: { src: Source; sec: Section | undefined; routes: RouteMap | null }) {
  const n = countText(p.sec);
  return (
    <section aria-label={p.src.label}>
      <h3 className="section-sub">{n ? `${p.src.label} · ${n}` : p.src.label}</h3>
      <SourceBody sec={p.sec} routes={p.routes} />
    </section>
  );
}

function areaLine(stop: Saved, got: Got | null) {
  if (got?.error) return got.error;
  if (!got?.area) return 'buscando paradas…';
  const n = got.area.stops.length - (got.area.me ? 0 : 1);
  const near = `${n} ${n === 1 ? 'parada' : 'paradas'} a menos de ${AREA_RADIUS} m`;
  return got.area.me ? `cerca de ti: ${near}` : `${short(stop.name)} y ${near}`;
}

export default function AlertsTab(p: {
  stop: Saved;
  active: boolean;
  routes: RouteMap | null;
}) {
  const { stop } = p;
  const [here, setHere] = useState<Point | null>(null);
  const [locating, setLocating] = useState('');
  useEffect(() => setHere(null), [stop.id]);
  const centre = useMemo<Centre>(
    () => ({
      key: here ? `me:${here.lat.toFixed(4)},${here.lon.toFixed(4)}` : `stop:${stop.id}`,
      stopId: stop.id,
      at: here,
    }),
    [here, stop.id],
  );
  const got = useAreaAlerts(centre, p.active);

  async function nearMe() {
    setLocating('localizando…');
    try {
      setHere(await locate());
      setLocating('');
    } catch (err) {
      setLocating(nearFailure(err));
    }
  }

  const sources = SOURCES.filter(s => got?.area && ofKind(got.area, s.kinds).length);
  return (
    <>
      <h2 className="title">{short(stop.name)}</h2>
      <h3 className="section-sub">alertas</h3>
      <div className="board-mode">
        <button className="btn tilt" aria-pressed={!here} onClick={() => setHere(null)}>
          parada seleccionada
        </button>
        <button className="btn tilt" aria-pressed={!!here} onClick={() => void nearMe()}>
          cerca de mí
        </button>
      </div>
      <p className="status" role="status" aria-live="polite">
        {locating || areaLine(stop, got)}
      </p>
      {sources.map(src => (
        <SourceSection key={src.key} src={src} sec={got?.sections[src.key]} routes={p.routes} />
      ))}
    </>
  );
}
