// Metro progress at the top edge: a bar counting down to the next refresh, flying dots while a request runs.
// Purely visual (the status line covers screen readers); `key={at}` restarts the CSS animation on every load.
export const REFRESH_MS = 30_000;

export default function RefreshBar({ at, loading }: { at: number | null; loading: boolean }) {
  if (at === null) return null;
  return (
    <div className="refresh" aria-hidden="true">
      {loading ? (
        [0, 1, 2, 3, 4].map(i => <i key={i} style={{ animationDelay: `${i * 0.12}s` }} />)
      ) : (
        <span key={at} style={{ animationDuration: `${REFRESH_MS}ms` }} />
      )}
    </div>
  );
}
