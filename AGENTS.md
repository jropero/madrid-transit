# AGENTS.md

Madrid Cercanías (Renfe) and CRTM interurban bus departures. React 19 + TypeScript on Vite+ (`vp`), installable PWA, Windows Phone "Metro" look. Sibling of basel-transit. Static timetable comes from Renfe's open GTFS (baked into `public/data/` at build time), live delays, cancellations and alerts from Renfe's GTFS-Realtime JSON. Buses (NAP feed 1361) are **timetable only**: no live data. For setup and deployment, see [README.md](README.md).

## Commands

- `vp dev`: dev server at http://localhost:5173/m/ (base is `/m/`)
- `pnpm data`: runs `scripts/timetable.mjs` (downloads the GTFS zips into `.cache/`, rebuilds `public/data/`; cached zips younger than 24 h are reused). `vp run build` runs it first, then `tsc` and the production build. Run the build after every change; there is no test runner.
- `vp lint` (`pnpm lint`): Oxlint with type-aware checks plus SonarJS rules (cognitive complexity max 6, no nested ternaries). Rules live in the `lint` block of `vite.config.ts`. Fix findings rather than disabling rules; if a rule really doesn't fit, turn it off in the config with a one-line reason, not inline.
- `vp fmt` / `vp fmt --check`: Oxfmt, single quotes, 96 columns. `pnpm lint:css`: stylelint on `src/index.css`. `pnpm typecheck`: `tsc --noEmit`.
- Pre-commit hook (`.husky/pre-commit`) runs `vp staged`. Needs Node >= 22.22.
- Package manager: pnpm (`vp add`, `vp remove`). No new runtime dependencies for things a few lines can do.

## Layout

- `scripts/timetable.mjs`: plain Node, no dependencies. One step per feed (`buildRenfe`, `buildBus`) sharing the streaming CSV reader: system `unzip -p` + `readline`, never extracting files (`shapes.txt` is 196 MB, never touched). Renfe keeps Madrid routes (`route_id` starting `10T`). Writes `public/data/` (gitignored): `stops.json` (all stops, lazy: search and near me only; `k: 'r' | 'b'`, bus stops add `code` and `desc` = street), `stops-renfe.json` (Renfe stops only, always loaded: destination names, ♿), `routes.json` (Renfe and bus; bus routes add `name`), `days.json` (Renfe: `{from,to,days:{yyyymmdd:[serviceId]}}`), `stop/<id>.json`. **Every GTFS field is space-padded: trim all values.** The zips are untrusted data: parse them, never execute them.
- Renfe stop file: `{r,d,s}`: route ids, destination stop ids, rows per service id `[secs, tripId minus service prefix, r index, d index]`.
- Bus stop file: `{kind:'bus', r, h, c, d}`: route ids, headsigns, deduplicated calendars `c[i] = [weekdayMask (bit 0 = Sunday), startYmd, endYmd, added[], removed[]]` (inlined per stop so the client never needs the 5.7k-service table), rows `d = [secs, c index, r index, h index]` sorted by secs (may exceed 24h). The client tells the kinds apart with `isBus`.
- Towns: `town` on every stop in `stops.json` / `stops-renfe.json` (empty when unknown). Source: CRTM open data (datos.crtm.es) ArcGIS layer `M8_Red` (`CODIGOESTACION` = GTFS `stop_code`, province + municipality = INE code), names from `scripts/municipios.json` (Wikidata, INE code to name). Cached in `.cache/crtm-stops.json` for 7 days; failure never fails the build. Renfe stations use the nearest bus stop's town within 1,500 m.
- Bus feed: `GET https://nap.transportes.gob.es/api/Fichero/download/1361` with header `ApiKey: $NAP_TOKEN` (query `?token=` gives 401). Token from the environment or `.env`; the script only reads it when a download is needed. No token and no fresh `.cache/bus.zip`: warn and build Renfe only (never fail).
- `src/gtfs.ts`: shared logic. `madridTime` (Europe/Madrid, DST-safe), `scheduled` (Renfe: today's + yesterday's services; buses: `busScheduled` with `busActive` calendar logic, removed dates win over added over weekly pattern; next 2 h), `applyRealtime`, `parseAlerts`, stop search (accent-insensitive), `nearStops`, saved stops, formatting. Put new shared logic here.
- `src/data.ts`: fetches the local timetable files (memoised) and the live feeds through `rt.php` (last copy cached for offline).
- `src/storage.ts`: `loadJson` / `saveJson` with oldest-first eviction of cache entries.
- `src/App.tsx`: departures pane (saved-stop pivot, search, near me, lines grouped by line + destination, alerts, 30 s refresh of live data only) and the swipe pivot (departures | settings). `src/Alerts.tsx`, `src/AppBar.tsx`, `src/RefreshBar.tsx`, `src/Settings.tsx`, `src/accent.ts`, `src/motion.ts`, `src/icons.tsx` (vendored Fluent icons, don't add the package) come from basel-transit.
- `public/rt.php`: whitelist proxy (`?f=trip_updates|alerts`) to `https://gtfsrt.renfe.com/<f>.json` (no CORS upstream), 15 s cache in the temp dir. In dev, the Vite proxy in `vite.config.ts` rewrites `/m/rt.php?f=X` to the same URL, so client code is identical.
- `public/sw.js`: service worker (production only). `src/index.css`: the only stylesheet, always dark, no CSS framework.

## Data notes

- Renfe: feed covers about one month, one `service_id` per date, no `calendar_dates`. `days.json.to` drives the "timetable ends DD.MM — redeploy" warning.
- `trip_headsign` is blank: the destination is the trip's last stop. Realtime `tripUpdate.trip.tripId` matches GTFS `trip_id`; the delay is trip-level seconds. Alerts name routes (`10T0005C2`); only `10T` ones are shown, in Spanish as supplied.
- Buses: ids `par_8_17480` (Moncloa interchange), routes `8__421___`, headsigns uppercase (shown lowercase by CSS), ~6.6k served stops, 354 routes. `wheelchair_accessible` is 0 everywhere, so no ♿ for buses. Live delays and alerts apply to Renfe stops only.
- Attribution: "Powered by MITRAMS" with a link to https://www.transportes.gob.es/ is required by the NAP licence; keep it in README and the Settings about text.
- Stops: Atocha `18000`, Chamartín `17000`, Nuevos Ministerios `18002`, Sol `18101`.

## Rules

- All user-visible UI text is Spanish (Spain); code, comments and docs stay English. After adding or changing UI strings, run the `es-translator` agent (`.claude/agents/es-translator.md`, Haiku) to translate and check them.
- Never read, print or commit `.env` (it holds `NAP_TOKEN`).
- Wrap localStorage access in try/catch (use `loadJson` / `saveJson`). Keys are prefixed `madrid-transit:`.
- New parsing or maths logic gets an inline `console.assert` self-check.
- Interactive elements are real `<button>`s with `aria-*` state. Don't put `<div>`s inside buttons; use `<span>`.
