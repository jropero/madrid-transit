import { useEffect, useState } from 'react';
import { loadTimetable } from './data.ts';
import { ddmm } from './gtfs.ts';
import { THEMES, applyTheme, loadTheme, type Theme } from './theme.ts';
import { ACCENTS, applyAccent, loadAccent, type AccentName } from './accent.ts';

export default function Settings() {
  const [accent, setAccent] = useState<AccentName>(loadAccent);
  const [theme, setTheme] = useState<Theme>(loadTheme);
  const [updated, setUpdated] = useState('');
  useEffect(() => {
    loadTimetable().then(
      tt => setUpdated(tt.days.updated ?? ''),
      () => undefined,
    );
  }, []);
  return (
    <>
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
        .
      </p>
    </>
  );
}
