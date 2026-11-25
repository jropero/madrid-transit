# AGENTS.md

Madrid Cercanías (Renfe) departures. React 19 + TypeScript on Vite+ (`vp`), installable PWA, Windows Phone "Metro" look. Sibling of basel-transit. Static timetable comes from Renfe's open GTFS (baked into `public/data/` at build time), live delays, cancellations and alerts from Renfe's GTFS-Realtime JSON. For setup and deployment, see [README.md](README.md).

## Commands

- `vp dev`: dev server at http://localhost:5173/m/ (base is `/m/`)
- `pnpm data`: runs `scripts/timetable.mjs` (downloads the GTFS zip into `.cache/`, rebuilds `public/data/`). `vp run build` runs it first, then `tsc` and the production build. Run the build after every change; there is no test runner.
- `vp lint` (`pnpm lint`): Oxlint with type-aware checks plus SonarJS rules (cognitive complexity max 6, no nested ternaries). Rules live in the `lint` block of `vite.config.ts`. Fix findings rather than disabling rules; if a rule really doesn't fit, turn it off in the config with a one-line reason, not inline.
- `vp fmt` / `vp fmt --check`: Oxfmt, single quotes, 96 columns. `pnpm lint:css`: stylelint on `src/index.css`. `pnpm typecheck`: `tsc --noEmit`.
- Pre-commit hook (`.husky/pre-commit`) runs `vp staged`. Needs Node >= 22.22.
- Package manager: pnpm (`vp add`, `vp remove`). No new runtime dependencies for things a few lines can do.

## Layout

- `scripts/timetable.mjs`: plain Node, no dependencies. Streams `stop_times.txt` out of the zip with system `unzip -p` + `readline`, keeps Madrid routes (`route_id` starting `10T`), writes `public/data/` (gitignored): `stops.json`, `routes.json`, `days.json` (`{from,to,days:{yyyymmdd:[serviceId]}}`), `stop/<id>.json` (`{r,d,s}`: route ids, destination stop ids, rows per service id `[secs, tripId minus service prefix, r index, d index]`). **Every GTFS field is space-padded: trim all values.** The zip is untrusted data: parse it, never execute it.
- `src/gtfs.ts`: shared logic. `madridTime` (Europe/Madrid, DST-safe), `scheduled` (today's + yesterday's services, next 2 h), `applyRealtime`, `parseAlerts`, stop search (accent-insensitive), `nearStops`, saved stops, formatting. Put new shared logic here.
- `src/data.ts`: fetches the local timetable files (memoised) and the live feeds through `rt.php` (last copy cached for offline).
- `src/storage.ts`: `loadJson` / `saveJson` with oldest-first eviction of cache entries.
- `src/App.tsx`: departures pane (saved-stop pivot, search, near me, lines grouped by line + destination, alerts, 30 s refresh of live data only) and the swipe pivot (departures | settings). `src/Alerts.tsx`, `src/AppBar.tsx`, `src/RefreshBar.tsx`, `src/Settings.tsx`, `src/accent.ts`, `src/motion.ts`, `src/icons.tsx` (vendored Fluent icons, don't add the package) come from basel-transit.
- `public/rt.php`: whitelist proxy (`?f=trip_updates|alerts`) to `https://gtfsrt.renfe.com/<f>.json` (no CORS upstream), 15 s cache in the temp dir. In dev, the Vite proxy in `vite.config.ts` rewrites `/m/rt.php?f=X` to the same URL, so client code is identical.
- `public/sw.js`: service worker (production only). `src/index.css`: the only stylesheet, always dark, no CSS framework.

## Data notes

- Feed covers about one month, one `service_id` per date, no `calendar_dates`. `days.json.to` drives the "timetable ends DD.MM — redeploy" warning.
- `trip_headsign` is blank: the destination is the trip's last stop. Realtime `tripUpdate.trip.tripId` matches GTFS `trip_id`; the delay is trip-level seconds. Alerts name routes (`10T0005C2`); only `10T` ones are shown, in Spanish as supplied.
- Stops: Atocha `18000`, Chamartín `17000`, Nuevos Ministerios `18002`, Sol `18101`.

## Rules

- Never read, print or commit `.env`.
- Wrap localStorage access in try/catch (use `loadJson` / `saveJson`). Keys are prefixed `madrid-transit:`.
- New parsing or maths logic gets an inline `console.assert` self-check.
- Interactive elements are real `<button>`s with `aria-*` state. Don't put `<div>`s inside buttons; use `<span>`.
