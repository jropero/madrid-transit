import { useEffect, useId, useState } from 'react';
import { Icon } from './icons.tsx';
import { loadJson, saveJson } from './storage.ts';
import { alertsFor, isRelevant, mentionedLines, textHash, type Alert } from './gtfs.ts';

const DISMISSED = 'madrid-transit:dismissed'; // { alertId: textHash }
const SEEN = 'madrid-transit:dismissed-seen'; // { alertId: last seen ms }
const KEEP_MS = 14 * 24 * 3600 * 1000;

type Dismissed = Record<string, string>;

// Dismissed alert ids with the hash of the text they were dismissed at; an id not seen for
// 14 days is forgotten.
function useDismissed(alerts: Alert[]) {
  const [dismissed, setDismissed] = useState<Dismissed>(() =>
    loadJson<Dismissed>(DISMISSED, {}),
  );
  useEffect(() => {
    const now = Date.now();
    const seen = loadJson<Record<string, number>>(SEEN, {});
    for (const a of alerts) if (a.id in dismissed) seen[a.id] = now;
    const keep = Object.keys(dismissed).filter(id => now - (seen[id] ?? now) < KEEP_MS);
    const next = Object.fromEntries(keep.map(id => [id, dismissed[id]]));
    saveJson(SEEN, Object.fromEntries(keep.map(id => [id, seen[id] ?? now])));
    if (keep.length !== Object.keys(dismissed).length) {
      saveJson(DISMISSED, next);
      setDismissed(next);
    }
  }, [alerts, dismissed]);
  const save = (next: Dismissed) => {
    saveJson(DISMISSED, next);
    setDismissed(next);
  };
  return {
    dismissed,
    hide: (a: Alert) => save({ ...dismissed, [a.id]: textHash(a.text) }),
    restore: () => save({}),
  };
}

export type AlertBoard = {
  relevant: Alert[];
  others: Alert[];
  hidden: number;
  hide: (a: Alert) => void;
  restore: () => void;
  // Whether a relevant, visible alert concerns this route or line.
  marks: (routeId: string, line: string) => boolean;
};

// Alerts for the stop on screen: visible ones split by relevance, the dismissed count, and
// the lines to mark.
export function useAlertBoard(
  alerts: Alert[],
  routeIds: Set<string>,
  lines: Set<string>,
): AlertBoard {
  const { dismissed, hide, restore } = useDismissed(alerts);
  const forStop = alertsFor(alerts, routeIds);
  const shown = forStop.filter(a => dismissed[a.id] !== textHash(a.text));
  const relevant = shown.filter(a => isRelevant(a, routeIds, lines));
  const named = new Set(relevant.flatMap(a => [...a.routeIds, ...mentionedLines(a.text)]));
  return {
    relevant,
    others: shown.filter(a => !relevant.includes(a)),
    hidden: forStop.length - shown.length,
    hide,
    restore,
    marks: (routeId, line) => named.has(routeId) || named.has(line.toLowerCase()),
  };
}

function AlertRow({ alert, board }: { alert: Alert; board: AlertBoard }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <li>
      <button
        className="alert-row"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => setOpen(!open)}
      >
        <span lang="es">{alert.title}</span>
      </button>
      {open && (
        <span id={id} className="alert-full">
          {alert.when && <span lang="es">{alert.when} · </span>}
          <span lang="es">{alert.text}</span>
          {alert.url && (
            <>
              {' '}
              <a href={alert.url} target="_blank" rel="noopener">
                Más información
              </a>
            </>
          )}
          <button className="alert-hide" onClick={() => board.hide(alert)}>
            ocultar
          </button>
        </span>
      )}
    </li>
  );
}

const AlertList = ({ list, board }: { list: Alert[]; board: AlertBoard }) =>
  list.length ? (
    <ul className="alert-list">
      {list.map(a => (
        <AlertRow key={a.id} alert={a} board={board} />
      ))}
    </ul>
  ) : null;

const count = (n: number) => `${n} ${n === 1 ? 'aviso' : 'avisos'}`;

function Hidden({ board }: { board: AlertBoard }) {
  return board.hidden ? (
    <p className="alert-hidden">
      (+{board.hidden} {board.hidden === 1 ? 'oculto' : 'ocultos'}){' '}
      <button onClick={board.restore}>mostrar</button>
    </p>
  ) : null;
}

// One collapsed bar for all alerts of the stop (Spanish, as supplied by Renfe or EMT); expands
// to one line per alert, relevant ones first, each opening to its full text.
export default function Alerts({ board }: { board: AlertBoard }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const all = [...board.relevant, ...board.others];
  if (!all.length) return <Hidden board={board} />;
  return (
    <section className="alerts">
      <button
        className="alert-bar"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => setOpen(!open)}
      >
        <Icon name="alert" size={18} /> <b>{count(all.length)}</b>
        <span className="alert-title" lang="es">
          {' · '}
          {all[0].title}
        </span>
      </button>
      <Hidden board={board} />
      {open && (
        <div id={id}>
          <AlertList list={board.relevant} board={board} />
          {board.relevant.length > 0 && board.others.length > 0 && (
            <h3 className="alert-sub">Otros avisos</h3>
          )}
          <AlertList list={board.others} board={board} />
        </div>
      )}
    </section>
  );
}

export const AlertMark = ({ on }: { on: boolean }) =>
  on ? (
    <span
      className="warn-mark"
      role="img"
      aria-label="aviso de servicio"
      title="aviso de servicio"
    >
      <Icon name="alert" size={16} />
    </span>
  ) : null;

export const AccessMark = ({ on }: { on: boolean }) =>
  on ? (
    <span
      className="acc"
      role="img"
      aria-label="acceso sin escalones"
      title="acceso sin escalones"
    >
      <Icon name="access" size={22} />
    </span>
  ) : null;
