// Second status line: why a live feed is failing, a button that opens the details (provider, HTTP
// status, time of the last attempt and the server's response as plain text).
import { useEffect, useId, useState } from 'react';
import { fetchWhy } from './data.ts';
import { hhmm, upstreamMeaning, upstreamText, type FeedNote } from './gtfs.ts';

type Details = { at: number | null; body: string };
type Loaded = Details | 'loading' | 'none';

// What the client already knows (dev, or a failed fetch), else what rt.php remembers (`&why=1`).
async function loadDetails({ url, body, at }: Pick<FeedNote, 'url' | 'body' | 'at'>) {
  if (body !== undefined) return { at: at ?? null, body };
  if (!url) return null;
  const why = await fetchWhy(url);
  return why ? { at: why.at * 1000, body: why.body } : null;
}

// Keyed by the note's fields, not the object: it is rebuilt on every refresh.
function useDetails({ url, body, at }: FeedNote, open: boolean): Loaded {
  const [got, setGot] = useState<Loaded>('loading');
  useEffect(() => {
    if (!open) return;
    let live = true;
    setGot('loading');
    loadDetails({ url, body, at }).then(
      d => live && setGot(d ?? 'none'),
      () => live && setGot('none'),
    );
    return () => {
      live = false;
    };
  }, [url, body, at, open]);
  return got;
}

function Response({ got }: { got: Loaded }) {
  if (got === 'loading') return <p>cargando…</p>;
  if (got === 'none') return <p>sin detalles</p>;
  return (
    <>
      <p>último intento {got.at === null ? '—' : hhmm(new Date(got.at))}</p>
      <p>respuesta del servidor:</p>
      <pre className="status-why-body">{got.body === '' ? '(vacía)' : got.body}</pre>
    </>
  );
}

export default function StatusNote({ note }: { note: FeedNote }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const got = useDetails(note, open);
  return (
    <>
      <button
        type="button"
        className="status-note"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen(o => !o)}
      >
        {upstreamText(note.label, note.err)} {open ? '⌃' : '›'}
      </button>
      <div id={id} className="status-why" hidden={!open}>
        <p>proveedor: {note.label}</p>
        <p>{upstreamMeaning(note.err)}</p>
        {open && <Response got={got} />}
      </div>
    </>
  );
}
