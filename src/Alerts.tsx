import { useState } from 'react';
import { Icon } from './icons.tsx';
import { alertsFor, type Alert } from './gtfs.ts';

// Service alerts for the routes on screen (Spanish, as supplied by Renfe); tap to expand.
export default function Alerts({
  alerts,
  routeIds,
}: {
  alerts: Alert[];
  routeIds: Set<string>;
}) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <>
      {alertsFor(alerts, routeIds).map(a => (
        <section key={a.id} className="alert">
          <button
            aria-expanded={open === a.id}
            onClick={() => setOpen(open === a.id ? null : a.id)}
          >
            <Icon name="alert" size={18} /> <span lang="es">{a.text}</span>
          </button>
        </section>
      ))}
    </>
  );
}

export const AlertMark = ({ on }: { on: boolean }) =>
  on ? (
    <span className="warn-mark" role="img" aria-label="service alert" title="service alert">
      <Icon name="alert" size={16} />
    </span>
  ) : null;

export const AccessMark = ({ on }: { on: boolean }) =>
  on ? (
    <span className="acc" role="img" aria-label="step-free boarding" title="step-free boarding">
      <Icon name="access" size={16} />
    </span>
  ) : null;
