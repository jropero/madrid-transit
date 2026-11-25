import { useState } from 'react';
import { ACCENTS, applyAccent, loadAccent, type AccentName } from './accent.ts';

export default function Settings() {
  const [accent, setAccent] = useState<AccentName>(loadAccent);
  return (
    <>
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
        Horarios de Cercanías Madrid y retrasos en tiempo real, con datos abiertos de Renfe
        (GTFS y GTFS-Realtime, data.renfe.com). Horarios de autobuses interurbanos (sin datos en
        vivo) del Consorcio Regional de Transportes de Madrid a través del Punto de Acceso
        Nacional. Metro Ligero y Tranvía de Parla: datos abiertos del CRTM (sin datos en vivo).
        Municipios de las paradas: datos abiertos del CRTM (datos.crtm.es). Tipografía: Selawik
        (SIL OFL). Iconos: Fluent UI System Icons (MIT).
      </p>
      <p className="about">
        Powered by{' '}
        <a href="https://www.transportes.gob.es/" target="_blank" rel="noreferrer">
          MITRAMS
        </a>
      </p>
    </>
  );
}
