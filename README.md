# madrid-transit

Next Renfe Cercanías, interurban bus and light rail (Metro Ligero, Tranvía de Parla) departures in Madrid. A small React + TypeScript PWA on [Vite+](https://viteplus.dev), with a Windows Phone "Metro" look.

## Features

- **Departures:** the next 2 hours for a stop, grouped by line and destination, with Cercanías line colours, minutes left, `+N'` delay, cancelled departures struck through and step-free boarding (♿).
- **Service alerts:** active Renfe alerts for Madrid lines as a banner and a ⚠ on affected lines (Spanish, as supplied).
- **Light rail (CRTM):** Metro Ligero ML1-ML3 and Tranvía de Parla ML4 (57 stops, 4 lines), **timetable only**. Tiles say "tranvía"; search shows the town.
- **Interurban buses (CRTM):** ~6,600 stops and 354 lines from the national NAP feed. Timetable plus CRTM stop times (see Data sources); no alerts for buses (Renfe stops keep delays and alerts). Search shows the stop code and street to tell the two sides of a road apart.
- **Saved stops:** Atocha and Sol are preset. Add stops by name or stop code search (accent-insensitive) or **near me**.
- **Offline:** the timetable is local, so departures work fully offline; the last live data is kept.
- **Metro UI:** swipe pivot, app bar, tilt on press, light or dark theme (automatic by default, switchable in settings), 20 accent colours, Selawik font, Fluent icons.

Notes for coding agents are in [AGENTS.md](AGENTS.md).

## Data

- Timetable: Renfe open GTFS, `https://ssl.renfe.com/ftransit/Fichero_CER_FOMENTO/fomento_transit.zip` (all Spain, updated daily). `pnpm data` filters the Madrid núcleo (`10T` routes) into `public/data/`. Needs Node >= 22 and the system `unzip`.
- Buses: the public CRTM ArcGIS item `885399f83408473c8d815e40c5e702b7` (no key, same file as NAP 1361) is downloaded first; only if that fails and `NAP_TOKEN` is set does the script fall back to NAP (Punto de Acceso Nacional) feed 1361, `https://nap.transportes.gob.es/api/Fichero/download/1361`, sent with the header `ApiKey: <NAP_TOKEN>` (a query `?token=` gives 401). Put `NAP_TOKEN=…` in `.env` (gitignored) or the environment. The 74 MB zip is cached in `.cache/bus.zip`; a copy younger than 24 h is used without a download and without a token. Without a token and without a fresh cache, `pnpm data` warns and builds Renfe only (the build does not fail). `shapes.txt` (196 MB) is never extracted. The calendar is a weekly pattern plus `calendar_dates` exceptions, so the bus data rarely needs a refresh.
- Town buses ("Autobuses Urbanos", CRTM public ArcGIS item `357e63c2904f43aeb5d8a267a64346d8`, no key): town bus lines of the Comunidad de Madrid outside EMT Madrid city. Same GTFS shape and pipeline as the interurban buses (per-stop files merged with them, `kind: 'bus'`); their routes are marked `urban` in `routes.json`.
- Light rail: CRTM "GTFS Red de Metro Ligero", public ArcGIS item `https://www.arcgis.com/sharing/rest/content/items/aaed26cc0ff64b0c947ac0bc3e033196/data` (417 KB, no key), cached in `.cache/ml.zip` for 24 h; same pipeline as buses. Licence: https://www.crtm.es/licencia-de-uso. Its towns come from layer `M10_Red` (cached in `.cache/crtm-m10.json`); stop codes collide with bus codes, so each feed only uses its own layer.
- Towns: CRTM open data (datos.crtm.es), ArcGIS layer `M8_Red` (`https://services5.arcgis.com/UxADft6QPcvFyDU1/arcgis/rest/services/M8_Red/FeatureServer/0`, no auth): `CODIGOESTACION` equals the GTFS `stop_code`, province + municipality code give the INE code, resolved to a name through `scripts/municipios.json` (Wikidata). Cached in `.cache/crtm-stops.json` for 7 days; if the fetch fails, `pnpm data` warns and builds without towns. Renfe stations take the town of the nearest bus stop within 1,500 m. Search matches the town and results show it.
- Live (Renfe only): GTFS-Realtime JSON `https://gtfsrt.renfe.com/trip_updates.json` and `alerts.json` (no auth, no CORS), reached through `public/rt.php`.
- Bus and light-rail stop times: CRTM website endpoint `https://www.crtm.es/widgets/api/GetStopsTimes.php?codStop=<8|10>_<code>&type=1&orderBy=2&stopTimesByIti=3` (no auth, no CORS). It is **undocumented** and may change or break without notice; the timetable is the fallback. Reached through `public/rt.php` (`?f=crtm&stop=…`, stop validated against the generated allow-list `rt-stops.php`, 30 s cache per stop). Lines absent from the answer keep their timetable times.
- Data and licences (also shown in Settings, in Spanish):
  - Renfe: licence https://data.renfe.com/legal. Required: "Origen de los datos: Renfe Operadora", the timetable update date (`days.json.updated`, the zip's HTTP Last-Modified, else the download date; shown as "horario actualizado DD.MM") and a note that the app is unofficial and unrelated to Renfe.
  - CRTM (Metro, Metro Ligero, buses, EMT stops, towns, stop times): licence https://www.crtm.es/licencia-de-uso. Required: "Powered by CRTM" linking to http://www.crtm.es/, a note that the data is processed ("datos explotados") and that CRTM does not sponsor the app.
  - Buses (NAP feed 1361): **Powered by MITRAMS** ([transportes.gob.es](https://www.transportes.gob.es/)), required by the NAP licence. EMT live data: "Datos: EMT Madrid MobilityLabs".
- Line stops: `public/data/route/<routeId>.json` = `{ p: [[[stopId, offsetSecs], ...], ...] }`, the unique stop patterns of each route (Renfe, buses, light rail from stop_times; Metro and EMT streamed from their stop_times, calendars ignored). Timetable rows carry a pattern index. Metro interchange stations (one GTFS record per line) are merged by name within 300 m.

## Development

`pnpm install`, then `pnpm dev` (runs on http://localhost:5173/m/). The first build or `pnpm data` downloads the 16 MB Renfe zip (and, with `NAP_TOKEN` set, the 74 MB bus zip) into `.cache/`. The dev server proxies `/m/rt.php` to Renfe and CRTM.

## Deployment

Deployed at https://ekult.co.uk/m/.

- `base: '/m/'` in `vite.config.ts` is absolute on purpose (PWA scope).
- `pnpm build` rebuilds the timetable and the app. The **entire** `dist/` belongs in the server's `/m/` directory, including `rt.php` and the generated `rt-stops.php` (PHP hosting required). `rt.php` keeps its caches, EMT token and rate counters in `../../cache/madrid-transit` (outside `public_html`); limits (EMT/CRTM calls per minute, requests per client, negative-cache time) are constants at the top of `rt.php`.
- The feed horizon is about one month. The app warns when the timetable ends within 7 days.

### GitHub Actions

`.github/workflows/deploy.yml` builds and deploys over SSH on every push to `main`, nightly at 02:30 UTC (after Renfe's daily update, so the timetable never runs out) and on demand (`gh workflow run deploy.yml`). Steps: install, `pnpm run build` (with `NAP_TOKEN`), `scripts/check-dist.mjs` (sanity gate: data files, `rt.php` and `rt-stops.php` exist, Renfe timetable has at least 3 days left, more than 1000 stop files), `php -l` on both PHP files and a `php -S` smoke test of `rt.php` (only requests rejected before any upstream call), then `rsync -az --delete --delay-updates` of `dist/` to `DEPLOY_PATH`. `--delete` makes `/m` identical to `dist/`, so the workflow refuses a `DEPLOY_PATH` that does not end in `/m`. A Renfe failure or a failed gate stops the run before the deploy step, leaving the live site untouched; bus, light rail and town failures only warn (the gate catches missing stop files).

One-time setup:

1. `ssh-keygen -t ed25519 -f ~/.ssh/madrid_deploy -N '' -C madrid-transit-deploy`
2. hPanel, Advanced, SSH Access: add `~/.ssh/madrid_deploy.pub`; note host, port (Hostinger usually `65002`) and user.
3. Copy the ED25519 "Huella digital de la clave del host" from hPanel → SSH Access and run `gh variable set SSH_HOST_FP --body 'SHA256:…'`. The deploy pins the host key to this fingerprint. Then connect once to check: `ssh -i ~/.ssh/madrid_deploy -p <port> <user>@<host> 'ls domains/ekult.co.uk/public_html'`.
4. In this repo: `gh secret set NAP_TOKEN`, `gh secret set SSH_HOST`, `gh secret set SSH_PORT`, `gh secret set SSH_USER`, `gh secret set SSH_KEY < ~/.ssh/madrid_deploy`, `gh variable set DEPLOY_PATH --body '/home/<user>/domains/ekult.co.uk/public_html/m'`.
5. The old `SSH_KNOWN_HOSTS` secret is no longer used; delete it with `gh secret delete SSH_KNOWN_HOSTS`.

## Not built

- EMT city buses via MobilityLabs: log in with email + password headers (legacy X-ClientId + passKey as fallback) inside `rt.php` (`?f=emt&stop=…`). Keep the credentials in a config file outside the webroot, never in the bundle or repo.

## EMT city buses

Live arrivals come from EMT Madrid MobilityLabs through `public/rt.php?f=emt&stop=<n>`. Credentials stay server-side: set the GitHub secrets `EMT_EMAIL` and `EMT_PASSWORD` (your MobilityLabs account; the working method, basic tier, 25k requests/day; the password must be printable ASCII). The legacy pair `EMT_CLIENT_ID` / `EMT_PASS_KEY` is still written if set but the API currently rejects it with code 84; the deploy workflow writes `emt.json` to `$DEPLOY_PATH/../../emt.json` (outside `public_html`, mode 600). Without them the step is skipped and EMT stops fall back to CRTM times. `vp dev` forwards `f=emt` requests to the deployed `rt.php`. Mind the API quota (arrivals are cached 30 s per stop). Stops and lines: CRTM "GTFS Red de EMT" (ArcGIS item `868df0e58fca47e79b942902dffd7da0`). Data provided by EMT Madrid MobilityLabs.
