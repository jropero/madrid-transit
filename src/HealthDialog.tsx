// Popup with the raw answer of one source probe (Settings > estado de las fuentes).
import { useEffect, useRef } from 'react';
import { hhmm, upstreamMeaning, type Health, type ProbeResult } from './gtfs.ts';

export type Probed = { label: string; query: string; health: Health; probe: ProbeResult };

// Pretty JSON when it parses, else the text as received.
export const bodyText = (text: string | undefined): string => {
  if (!text) return '(vacía)';
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
};
console.assert(
  bodyText('{"a":1}') === '{\n  "a": 1\n}' &&
    bodyText('<html>') === '<html>' &&
    bodyText('') === '(vacía)',
  'bodyText pretty-prints JSON only',
);

const statusText = (p: ProbeResult) => {
  if (p.error === 'timeout') return `sin respuesta en ${Math.round(p.limitMs / 1000)} s`;
  if (p.error) return 'sin conexión';
  return `HTTP ${p.status}`;
};

export default function HealthDialog({ item, onClose }: { item: Probed; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
  }, []);
  const { probe: p } = item;
  return (
    <dialog
      ref={ref}
      className="health-dialog"
      aria-label={`Respuesta de ${item.label}`}
      onClose={onClose}
    >
      <h2 className="title">{item.label}</h2>
      <p>{item.health.text}</p>
      <p>
        {statusText(p)}
        {p.at ? ` · ${hhmm(new Date(p.at))}` : ''} ·{' '}
        {(p.ms / 1000).toFixed(1).replace('.', ',')} s
      </p>
      {p.upstream && <p>origen: {upstreamMeaning(p.upstream)}</p>}
      <p>
        <code>rt.php?{item.query}</code>
      </p>
      <p>respuesta del servidor:</p>
      <pre className="status-why-body">{bodyText(p.text)}</pre>
      <button className="btn tilt" onClick={() => ref.current?.close()}>
        cerrar
      </button>
    </dialog>
  );
}
