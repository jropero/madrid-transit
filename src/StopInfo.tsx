import { useEffect, useState } from 'react';
import { Icon } from './icons.tsx';
import { loadAllStops, loadRoute, loadStopLines, loadStopNames } from './data.ts';
import {
  classifyEnd,
  dayType,
  destinationsAfter,
  nearbyStops,
  sourceOf,
  stopKind,
  svcText,
  typicalGaps,
  type Departure,
  type End,
  type NearStop,
  type RouteInfo,
  type RouteMap,
  type Saved,
  type Stop,
} from './gtfs.ts';

type LinesMap = Record<string, string[]>;

export type LineInfo = {
  routeId: string;
  route: RouteInfo;
  end: End;
  dests: string[];
};

const MAX_LINES = 30;

// stop-lines.json (stopId -> routeIds), loaded on first use and memoised in data.ts.
function useLinesMap(): LinesMap | null {
  const [map, setMap] = useState<LinesMap | null>(null);
  useEffect(() => {
    let current = true;
    loadStopLines().then(
      m => current && setMap(m),
      () => current && setMap({}),
    );
    return () => {
      current = false;
    };
  }, []);
  return map;
}

const byLine = (a: LineInfo, b: LineInfo) =>
  a.route.line.localeCompare(b.route.line, 'es', { numeric: true });

// The lines serving a stop with their role there (cabecera / final) and destinations.
async function describeLines(
  stopId: string,
  routeIds: string[],
  routes: RouteMap,
): Promise<LineInfo[]> {
  const names = await loadStopNames();
  const known = routeIds.filter(id => routes[id]).slice(0, MAX_LINES);
  const files = await Promise.all(known.map(id => loadRoute(id).catch(() => ({ p: [] }))));
  return known
    .map((routeId, i) => ({
      routeId,
      route: routes[routeId],
      end: classifyEnd(files[i].p, stopId),
      dests: destinationsAfter(files[i].p, stopId).map(d => names.get(d) ?? d),
    }))
    .sort(byLine);
}

function useLineInfos(stopId: string, routes: RouteMap): LineInfo[] | null {
  const map = useLinesMap();
  const [lines, setLines] = useState<{ id: string; list: LineInfo[] } | null>(null);
  useEffect(() => {
    if (!map) return;
    let current = true;
    describeLines(stopId, map[stopId] ?? [], routes).then(
      list => current && setLines({ id: stopId, list }),
      () => current && setLines({ id: stopId, list: [] }),
    );
    return () => {
      current = false;
    };
  }, [map, stopId, routes]);
  return lines?.id === stopId ? lines.list : null;
}

const vehicle = (r: RouteInfo, routeId: string) =>
  routeId.startsWith('emt_') || !(r.metro || r.tram || routeId.startsWith('10T'))
    ? 'autobuses'
    : 'trenes';

// "Cabecera de la línea 40 · sale cada 11–23 min (07:00–23:59) · sin datos en vivo hasta ..."
// EMT frequency for today's day type, else the typical gap from today's departures.
const rateOf = (l: LineInfo, gap: string, now: Date) =>
  svcText(l.route.svc?.[dayType(now)]) || gap;

const noLive = (routeId: string) =>
  routeId.startsWith('emt_')
    ? ' · sin datos en vivo hasta que el autobús inicia el recorrido'
    : '';

export function lineText(l: LineInfo, gap: string, now: Date): string {
  const name = l.route.line;
  const rate = rateOf(l, gap, now);
  if (l.end === 'final')
    return `Final de la línea ${name} · los ${vehicle(l.route, l.routeId)} terminan aquí`;
  if (l.end === 'cabecera')
    return `Cabecera de la línea ${name}${rate ? ` · sale ${rate}` : ''}${noLive(l.routeId)}`;
  return rate ? `Línea ${name} · ${rate}` : `Línea ${name}`;
}
console.assert(
  (() => {
    const route = { line: '40', color: '', text: '', svc: { lab: ['07:00', '23:59', 11, 23] } };
    const l = (end: End): LineInfo => ({
      routeId: 'emt_40',
      route: route as RouteInfo,
      end,
      dests: [],
    });
    const t = new Date('2026-11-25T12:00:00Z');
    return (
      lineText(l('cabecera'), '', t).startsWith(
        'Cabecera de la línea 40 · sale cada 11–23 min (07:00–23:59) · sin datos en vivo',
      ) &&
      lineText(l('final'), '', t) === 'Final de la línea 40 · los autobuses terminan aquí' &&
      lineText(l(null), '', t) === 'Línea 40 · cada 11–23 min (07:00–23:59)'
    );
  })(),
  'lineText: cabecera / final / through',
);

const tileStyle = (r: RouteInfo) =>
  ({ '--tile': r.color, '--tile-text': r.text }) as React.CSSProperties;

// Shown instead of the bare "no departures" line: what serves the stop and why it may be blank.
export function NoDepartures({
  stopId,
  routes,
  now,
  fallback,
}: {
  stopId: string;
  routes: RouteMap;
  now: number;
  fallback: string;
}) {
  const lines = useLineInfos(stopId, routes);
  if (!lines?.length) return <p className="status">{fallback}</p>;
  return (
    <ul className="svc-list">
      {lines.map(l => (
        <li key={l.routeId}>
          <span className="tile mini" style={tileStyle(l.route)}>
            <b>{l.route.line}</b>
          </span>
          <span>{lineText(l, '', new Date(now))}</span>
        </li>
      ))}
    </ul>
  );
}

// Open state of the info panel; closes when another stop is selected.
export function useInfoToggle(stopId: string) {
  const [open, setOpen] = useState(false);
  useEffect(() => setOpen(false), [stopId]);
  return [open, () => setOpen(o => !o)] as const;
}

export function InfoButton({
  open,
  panelId,
  onToggle,
}: {
  open: boolean;
  panelId: string;
  onToggle: () => void;
}) {
  return (
    <button
      className="info-btn"
      aria-expanded={open}
      aria-controls={open ? panelId : undefined}
      aria-label="información de la parada"
      onClick={onToggle}
    >
      <Icon name="info" size={22} />
    </button>
  );
}

const osmUrl = (s: Stop) =>
  `https://www.openstreetmap.org/?mlat=${s.lat}&mlon=${s.lon}#map=18/${s.lat}/${s.lon}`;

function Facts({ stop }: { stop: Stop }) {
  const rows: [string, React.ReactNode][] = [
    ['Dirección', stop.desc],
    ['Código', stop.code],
    ['Tipo', stopKind(stop)],
    ['Municipio', stop.town],
    ['Sin escalones', stop.wa ? 'sí' : 'no consta'],
  ];
  return (
    <dl className="facts">
      {rows
        .filter(([, v]) => v)
        .map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
    </dl>
  );
}

function LineRows({
  lines,
  gaps,
  now,
}: {
  lines: LineInfo[];
  gaps: Map<string, number>;
  now: Date;
}) {
  return (
    <ul className="svc-list">
      {lines.map(l => {
        const gap = gaps.get(l.routeId);
        const dests = l.dests.length ? `hacia ${l.dests.join(', ')}` : '';
        const rate = rateOf(l, gap ? `cada ~${gap} min` : '', now);
        return (
          <li key={l.routeId}>
            <span className="tile mini" style={tileStyle(l.route)}>
              <b>{l.route.line}</b>
            </span>
            <span>
              {l.end && <b className="end-tag">{l.end}</b>}
              {[dests, rate].filter(Boolean).join(' · ')}
              <small className="sub">{sourceOf(l.routeId, l.route)}</small>
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function useNearby(stop: Stop | undefined) {
  const [near, setNear] = useState<NearStop[] | null>(null);
  useEffect(() => {
    if (!stop) return;
    let current = true;
    loadAllStops().then(
      all => current && setNear(nearbyStops(all, stop)),
      () => current && setNear([]),
    );
    return () => {
      current = false;
    };
  }, [stop]);
  return near;
}

const label = (s: NearStop, lines: string[]) => {
  const main = s.k === 'b' || s.k === 'e' ? (s.code ?? s.name) : s.name;
  return `${stopKind(s)} ${main}${lines.length ? ` (${lines.join(', ')})` : ''}`;
};

const groupByKind = (near: NearStop[]) => {
  const groups = new Map<string, NearStop[]>();
  for (const s of near) groups.set(stopKind(s), [...(groups.get(stopKind(s)) ?? []), s]);
  return [...groups];
};

function Nearby({
  near,
  linesMap,
  routes,
  onSelect,
}: {
  near: NearStop[];
  linesMap: LinesMap | null;
  routes: RouteMap;
  onSelect: (s: Saved) => void;
}) {
  const groups = groupByKind(near);
  return (
    <>
      <h3>Cerca (150 m)</h3>
      {groups.map(([kind, list]) => (
        <ul className="near" key={kind} aria-label={kind}>
          {list.map(s => {
            const ids = linesMap?.[s.id] ?? [];
            const lines = [...new Set(ids.flatMap(id => routes[id]?.line ?? []))];
            return (
              <li key={s.id}>
                <button className="link" onClick={() => onSelect({ id: s.id, name: s.name })}>
                  <span>{label(s, lines.slice(0, 6))}</span>
                  <span className="dist"> · {s.dist} m</span>
                </button>
              </li>
            );
          })}
        </ul>
      ))}
    </>
  );
}

export function StopInfo({
  id,
  stop,
  routes,
  deps,
  now,
  onSelect,
}: {
  id: string;
  stop: Stop | undefined;
  routes: RouteMap;
  deps: Departure[];
  now: number;
  onSelect: (s: Saved) => void;
}) {
  const lines = useLineInfos(stop?.id ?? '', routes);
  const linesMap = useLinesMap();
  const near = useNearby(stop);
  if (!stop)
    return (
      <section className="info" id={id}>
        <p className="status">cargando…</p>
      </section>
    );
  return (
    <section className="info" id={id} aria-label="Información de la parada">
      <Facts stop={stop} />
      <p>
        <a href={osmUrl(stop)} target="_blank" rel="noopener">
          ver en mapa
        </a>
      </p>
      <h3>Líneas</h3>
      {lines ? (
        <LineRows lines={lines} gaps={typicalGaps(deps)} now={new Date(now)} />
      ) : (
        <p className="status">cargando…</p>
      )}
      {near && near.length > 0 && (
        <Nearby near={near} linesMap={linesMap} routes={routes} onSelect={onSelect} />
      )}
    </section>
  );
}
