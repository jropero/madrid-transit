import { loadJson, saveJson } from './storage.ts';
import { freshRows, pruneKept, type CrtmRow } from './gtfs.ts';

// The estimate stores (manual scan, automatic scan) survive a reload: stop id -> target key ->
// rows. The `cache:` prefix + `at` make them evictable when storage is full. Storage is
// untrusted: parsing validates every field and drops what is malformed or already past.
export type Estimates = Record<string, Record<string, CrtmRow[]>>;
export const MANUAL_KEY = 'madrid-transit:cache:estimates:manual';
export const AUTO_KEY = 'madrid-transit:cache:estimates:auto';

type Wire = Record<string, unknown>;
const isObj = (v: unknown): v is Wire =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): v is string => typeof v === 'string';
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

export const serializeEstimates = (stops: Estimates, now: number) => ({
  at: now,
  stops: Object.fromEntries(
    Object.entries(stops).map(([stop, byKey]) => [
      stop,
      Object.fromEntries(
        Object.entries(pruneKept(byKey, now)).map(([k, rows]) => [
          k,
          rows.map(r => ({ ...r, when: r.when.getTime() })),
        ]),
      ),
    ]),
  ),
});

function parseRow(v: unknown): CrtmRow | null {
  if (!isObj(v) || !num(v.when) || !str(v.routeId) || !str(v.dest)) return null;
  const opt = <T>(ok: (x: unknown) => x is T, x: unknown) => (ok(x) ? x : undefined);
  return {
    when: new Date(v.when),
    routeId: v.routeId,
    dest: v.dest,
    line: str(v.line) ? v.line : v.routeId,
    issue: str(v.issue) ? v.issue : '',
    tram: v.tram === true,
    metro: v.metro === true,
    estimated: true,
    scheduled: false,
    route: opt(str, v.route),
    code: opt(str, v.code),
    from: opt(str, v.from),
    pi: opt(num, v.pi),
    found: opt(num, v.found),
    ...(v.arr === true ? { arr: true as const } : {}),
  };
}

const parseRows = (v: unknown, now: number): CrtmRow[] =>
  freshRows(
    (Array.isArray(v) ? v : []).flatMap(r => parseRow(r) ?? []),
    now,
  );

function parseByKey(v: unknown, now: number) {
  const out: Record<string, CrtmRow[]> = {};
  if (!isObj(v)) return out;
  for (const [k, rows] of Object.entries(v)) {
    const ok = parseRows(rows, now);
    if (ok.length) out[k] = ok;
  }
  return out;
}

export function parseEstimates(raw: unknown, now: number): Estimates {
  const out: Estimates = {};
  if (!isObj(raw) || !isObj(raw.stops)) return out;
  for (const [stop, v] of Object.entries(raw.stops)) {
    const byKey = parseByKey(v, now);
    if (Object.keys(byKey).length) out[stop] = byKey;
  }
  return out;
}
console.assert(
  (() => {
    const row = (min: number, extra: Partial<CrtmRow> = {}) =>
      ({
        when: new Date(min * 60_000),
        routeId: 'r',
        line: 'l',
        dest: 'X',
        issue: '7',
        tram: false,
        metro: false,
        estimated: true,
        scheduled: false,
        from: 's',
        found: 5,
        ...extra,
      }) as CrtmRow;
    const now = 10 * 60_000;
    const json = JSON.parse(
      JSON.stringify(
        serializeEstimates(
          { a: { k: [row(20, { arr: true }), row(1)] }, b: { k: [row(1)] } },
          now,
        ),
      ),
    );
    const back = parseEstimates(json, now);
    const r = back.a?.k?.[0];
    const garbage = [
      null,
      5,
      'x',
      [],
      { stops: 3 },
      { stops: { a: { k: [1, { when: 'x' }] } } },
    ];
    return (
      Object.keys(back).join() === 'a' &&
      back.a.k.length === 1 &&
      r.when.getTime() === 20 * 60_000 &&
      r.found === 5 &&
      r.issue === '7' &&
      r.arr === true &&
      r.from === 's' &&
      garbage.every(g => Object.keys(parseEstimates(g, now)).length === 0)
    );
  })(),
  'estimateStore: round trip, past rows and garbage dropped',
);

export const loadEstimates = (key: string): Estimates =>
  parseEstimates(loadJson<unknown>(key, null), Date.now());

export const saveEstimates = (key: string, stops: Estimates) =>
  saveJson(key, serializeEstimates(stops, Date.now()));
