import { useEffect, useState } from 'react';
import { isOffline, loadRoute, loadStopNames } from './data.ts';
import { hhmm, nextStops, pickPattern, type Departure, type Pattern } from './gtfs.ts';

type Loaded = { pattern: Pattern | null; names: Map<string, string> };

// The vehicle's pattern: exact for timetable rows, else matched on the destination.
function choose(
  pi: number | undefined,
  dest: string,
  stopId: string,
  patterns: Pattern[],
  names: Map<string, string>,
) {
  if (pi !== undefined) return patterns[pi] ?? null;
  const name = names.get(dest) ?? dest;
  return patterns[pickPattern(patterns, stopId, name, id => names.get(id))] ?? null;
}

// Remaining stops of the next departure of a line, with estimated times (base: the departure's
// live or planned time at this stop plus the pattern's offsets).
export default function NextStops({
  dep,
  stopId,
  id,
  onSelect,
}: {
  dep: Departure;
  stopId: string;
  id: string;
  onSelect: (s: { id: string; name: string }, el: HTMLElement) => void;
}) {
  const [loaded, setLoaded] = useState<Loaded | 'error' | 'offline' | null>(null);
  const { routeId, pi, dest } = dep;
  useEffect(() => {
    let current = true;
    Promise.all([loadRoute(routeId), loadStopNames()]).then(
      ([route, names]) =>
        current && setLoaded({ pattern: choose(pi, dest, stopId, route.p, names), names }),
      err => current && setLoaded(isOffline(err) ? 'offline' : 'error'),
    );
    return () => {
      current = false;
    };
  }, [routeId, pi, dest, stopId]);

  if (!loaded)
    return (
      <p className="status next" id={id}>
        cargando…
      </p>
    );
  const rows =
    typeof loaded === 'string' || !loaded.pattern
      ? []
      : nextStops(loaded.pattern, stopId, dep.expected);
  if (!rows.length)
    return (
      <p className="status next" id={id}>
        {loaded === 'offline' ? 'sin conexión · paradas no guardadas' : 'sin paradas'}
      </p>
    );
  return (
    <ol className="next" id={id}>
      {rows.map((r, i) => {
        const name = (loaded as Loaded).names.get(r.id) ?? r.id;
        return (
          <li key={`${r.id}-${i}`}>
            <span className="at">{hhmm(r.at)}</span>
            {r.id === stopId ? (
              <span>{name}</span>
            ) : (
              <button
                className="stop-link tilt"
                aria-label={`Ver salidas de ${name}`}
                onClick={e => onSelect({ id: r.id, name }, e.currentTarget)}
              >
                <span>{name}</span>
              </button>
            )}
          </li>
        );
      })}
    </ol>
  );
}
