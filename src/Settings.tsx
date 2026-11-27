import { useEffect, useRef, useState } from 'react';
import { loadTimetable, probeFeed } from './data.ts';
import {
  ddmm,
  healthChecks,
  healthLine,
  moveSaved,
  short,
  type Health,
  type Saved,
  type ProbeResult,
} from './gtfs.ts';
import HealthDialog from './HealthDialog.tsx';
import { THEMES, applyTheme, loadTheme, type Theme } from './theme.ts';
import { setLdEnabled, useLdEnabled } from './ld.ts';
import { ACCENTS, applyAccent, loadAccent, type AccentName } from './accent.ts';

type HealthRow = {
  key: string;
  label: string;
  query: string;
  health?: Health;
  probe?: ProbeResult;
};

// "estado de las fuentes": probes every feed in parallel and fills each line as it finishes.
function SourceHealth({ stops }: { stops: Saved[] }) {
  const [rows, setRows] = useState<HealthRow[]>([]);
  const [running, setRunning] = useState(false);
  const [shown, setShown] = useState<string | null>(null);
  const open = rows.find(r => r.key === shown);
  const run = () => {
    const checks = healthChecks(stops);
    setRows(checks.map(c => ({ key: c.key, label: c.label, query: c.query })));
    setRunning(true);
    const done = checks.map(c =>
      probeFeed(c).then(p => {
        const health = healthLine(c.kind, p, new Date());
        setRows(prev => prev.map(r => (r.key === c.key ? { ...r, health, probe: p } : r)));
      }),
    );
    void Promise.all(done).then(() => setRunning(false));
  };
  return (
    <>
      <h2 className="title">estado de las fuentes</h2>
      <div className="themes health-run">
        <button className="btn tilt" disabled={running} aria-busy={running} onClick={run}>
          comprobar
        </button>
      </div>
      <ul className="health" aria-live="polite">
        {rows.map(r => (
          <li key={r.key} className={r.health ? `health-${r.health.level}` : undefined}>
            {r.health && r.probe ? (
              <button
                className="health-open tilt"
                aria-haspopup="dialog"
                onClick={() => setShown(r.key)}
              >
                <span className="health-label">{r.label}</span>
                <span>{r.health.text} ›</span>
              </button>
            ) : (
              <>
                <span className="health-label">{r.label}</span>
                <span>comprobando…</span>
              </>
            )}
          </li>
        ))}
      </ul>
      {open?.health && open.probe && (
        <HealthDialog
          item={{
            label: open.label,
            query: open.query,
            health: open.health,
            probe: open.probe,
          }}
          onClose={() => setShown(null)}
        />
      )}
    </>
  );
}

type Pending = { id: string; delta: -1 | 1 };

// "paradas guardadas": reorder the saved stops; the departures pivot follows this order.
function SavedOrder({ stops, onStops }: { stops: Saved[]; onStops: (next: Saved[]) => void }) {
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const pending = useRef<Pending | null>(null);
  const [note, setNote] = useState('');
  useEffect(() => {
    const p = pending.current;
    pending.current = null;
    if (!p) return;
    const same = buttons.current.get(`${p.id}:${p.delta}`);
    const other = buttons.current.get(`${p.id}:${-p.delta}`);
    (same && !same.disabled ? same : other)?.focus();
  }, [stops]);
  const move = (index: number, delta: -1 | 1) => {
    const next = moveSaved(stops, index, delta);
    if (next === stops) return;
    const { id, name } = stops[index];
    pending.current = { id, delta };
    setNote(`${short(name)}: posición ${index + delta + 1} de ${stops.length}`);
    onStops(next);
  };
  const ref = (key: string) => (el: HTMLButtonElement | null) => {
    if (el) buttons.current.set(key, el);
    else buttons.current.delete(key);
  };
  return (
    <>
      <h2 className="title">paradas guardadas</h2>
      {stops.length === 0 && <p className="saved-empty">no hay paradas guardadas</p>}
      <ol className="saved-order">
        {stops.map((s, i) => (
          <li key={s.id}>
            <span className="saved-name">{short(s.name)}</span>
            <button
              ref={ref(`${s.id}:-1`)}
              className="btn tilt"
              aria-label={`Subir ${short(s.name)}`}
              disabled={i === 0}
              onClick={() => move(i, -1)}
            >
              <span aria-hidden="true">↑</span>
            </button>
            <button
              ref={ref(`${s.id}:1`)}
              className="btn tilt"
              aria-label={`Bajar ${short(s.name)}`}
              disabled={i === stops.length - 1}
              onClick={() => move(i, 1)}
            >
              <span aria-hidden="true">↓</span>
            </button>
          </li>
        ))}
      </ol>
      <span className="sr-only" aria-live="polite">
        {note}
      </span>
    </>
  );
}

export default function Settings({
  stops,
  onStops,
}: {
  stops: Saved[];
  onStops: (next: Saved[]) => void;
}) {
  const [accent, setAccent] = useState<AccentName>(loadAccent);
  const [theme, setTheme] = useState<Theme>(loadTheme);
  const ld = useLdEnabled();
  const [updated, setUpdated] = useState('');
  useEffect(() => {
    loadTimetable().then(
      tt => setUpdated(tt.days.updated ?? ''),
      () => undefined,
    );
  }, []);
  return (
    <>
      <SavedOrder stops={stops} onStops={onStops} />
      <h2 className="title">tema</h2>
      <div className="themes" role="group" aria-label="tema">
        {THEMES.map(t => (
          <button
            key={t.name}
            className="btn tilt"
            aria-pressed={theme === t.name}
            onClick={() => {
              setTheme(t.name);
              applyTheme(t.name);
            }}
          >
            {t.label}
          </button>
        ))}
      </div>
      <h2 className="title">trenes</h2>
      <div className="themes">
        <button className="btn tilt" aria-pressed={ld} onClick={() => setLdEnabled(!ld)}>
          trenes de media y larga distancia
        </button>
      </div>
      <h2 className="title">color de acento</h2>
      <div className="swatches">
        {ACCENTS.map(a => (
          <button
            key={a.name}
            className="swatch tilt"
            style={{ '--swatch': a.hex } as React.CSSProperties}
            aria-pressed={accent === a.name}
            aria-label={a.label}
            onClick={() => {
              setAccent(a.name);
              applyAccent(a.name);
            }}
          />
        ))}
      </div>
      <SourceHealth stops={stops} />
      <h2 className="title">acerca de</h2>
      <p className="about">
        Cercanías: horarios y retrasos en tiempo real de Renfe. Autobuses interurbanos, Metro,
        Metro Ligero y Tranvía de Parla: horarios y tiempos de paso del CRTM; municipios de los
        datos abiertos del CRTM. Tipografía: Selawik (SIL OFL). Iconos: Fluent UI System Icons
        (MIT).
      </p>
      <p className="about">
        Origen de los datos:{' '}
        <a href="https://data.renfe.com/legal" target="_blank" rel="noopener">
          Renfe Operadora
        </a>
        {updated && ` · horario actualizado ${ddmm(updated).slice(0, -1)}`}. Aplicación no
        oficial, sin relación con Renfe.
      </p>
      <p className="about">
        Powered by{' '}
        <a href="http://www.crtm.es/" target="_blank" rel="noopener">
          CRTM
        </a>
        . Datos del CRTM explotados por esta aplicación (
        <a href="https://www.crtm.es/licencia-de-uso" target="_blank" rel="noopener">
          licencia
        </a>
        ); el CRTM no patrocina esta aplicación.
      </p>
      <p className="about">
        Datos: EMT Madrid MobilityLabs. Powered by{' '}
        <a href="https://www.transportes.gob.es/" target="_blank" rel="noopener">
          MITRAMS
        </a>
        . Tiempo:{' '}
        <a href="https://open-meteo.com/" target="_blank" rel="noopener">
          Open-Meteo.com
        </a>{' '}
        (CC BY 4.0).
      </p>
    </>
  );
}
