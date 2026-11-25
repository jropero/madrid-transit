import { useState } from 'react';
import { ACCENTS, applyAccent, loadAccent, type AccentName } from './accent.ts';

export default function Settings() {
  const [accent, setAccent] = useState<AccentName>(loadAccent);
  return (
    <>
      <h2 className="title">accent colour</h2>
      <div className="swatches">
        {ACCENTS.map(a => (
          <button
            key={a.name}
            className="swatch tilt"
            style={{ '--swatch': a.hex } as React.CSSProperties}
            aria-pressed={accent === a.name}
            aria-label={a.name}
            onClick={() => {
              setAccent(a.name);
              applyAccent(a.name);
            }}
          />
        ))}
      </div>
      <h2 className="title">about</h2>
      <p className="about">
        Cercanías Madrid timetable and live delays from Renfe open data (GTFS and GTFS-Realtime,
        data.renfe.com). Interurban bus timetables (no live data) from the Consorcio Regional de
        Transportes de Madrid via the National Access Point. Type: Selawik (SIL OFL). Icons:
        Fluent UI System Icons (MIT).
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
