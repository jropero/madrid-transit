# madrid-transit

Next Renfe Cercanías and interurban bus departures in Madrid. A small React + TypeScript PWA on [Vite+](https://viteplus.dev), with a Windows Phone "Metro" look.

## Features

- **Departures:** the next 2 hours for a stop, grouped by line and destination, with Cercanías line colours, minutes left, `+N'` delay, cancelled departures struck through and step-free boarding (♿).
- **Service alerts:** active Renfe alerts for Madrid lines as a banner and a ⚠ on affected lines (Spanish, as supplied).
- **Interurban buses (CRTM):** ~6,600 stops and 354 lines from the national NAP feed. **Timetable only**: no live delays or alerts for buses (Renfe stops keep them). Search shows the stop code and street to tell the two sides of a road apart.
- **Saved stops:** Atocha and Sol are preset. Add stops by name or stop code search (accent-insensitive) or **near me**.
- **Offline:** the timetable is local, so departures work fully offline; the last live data is kept.
- **Metro UI:** swipe pivot, app bar, tilt on press, 20 accent colours, Selawik font, Fluent icons.

Notes for coding agents are in [AGENTS.md](AGENTS.md).

## Data

- Timetable: Renfe open GTFS, `https://ssl.renfe.com/ftransit/Fichero_CER_FOMENTO/fomento_transit.zip` (all Spain, updated daily). `pnpm data` filters the Madrid núcleo (`10T` routes) into `public/data/`. Needs Node >= 22 and the system `unzip`.
- Buses: NAP (Punto de Acceso Nacional) feed 1361, `https://nap.transportes.gob.es/api/Fichero/download/1361`, sent with the header `ApiKey: <NAP_TOKEN>` (a query `?token=` gives 401). Put `NAP_TOKEN=…` in `.env` (gitignored) or the environment. The 74 MB zip is cached in `.cache/bus.zip`; a copy younger than 24 h is used without a download and without a token. Without a token and without a fresh cache, `pnpm data` warns and builds Renfe only (the build does not fail). `shapes.txt` (196 MB) is never extracted. The calendar is a weekly pattern plus `calendar_dates` exceptions, so the bus data rarely needs a refresh.
- Towns: CRTM open data (datos.crtm.es), ArcGIS layer `M8_Red` (`https://services5.arcgis.com/UxADft6QPcvFyDU1/arcgis/rest/services/M8_Red/FeatureServer/0`, no auth): `CODIGOESTACION` equals the GTFS `stop_code`, province + municipality code give the INE code, resolved to a name through `scripts/municipios.json` (Wikidata). Cached in `.cache/crtm-stops.json` for 7 days; if the fetch fails, `pnpm data` warns and builds without towns. Renfe stations take the town of the nearest bus stop within 1,500 m. Search matches the town and results show it.
- Live (Renfe only): GTFS-Realtime JSON `https://gtfsrt.renfe.com/trip_updates.json` and `alerts.json` (no auth, no CORS), reached through `public/rt.php`.
- Attribution: Renfe data from Renfe Operadora (verify the licence text on data.renfe.com before publishing). Bus data: **Powered by MITRAMS** ([transportes.gob.es](https://www.transportes.gob.es/)), required by the NAP licence; shown in the Settings about text.

## Development

`pnpm install`, then `pnpm dev` (runs on http://localhost:5173/m/). The first build or `pnpm data` downloads the 16 MB Renfe zip (and, with `NAP_TOKEN` set, the 74 MB bus zip) into `.cache/`. The dev server proxies `/m/rt.php` to Renfe.

## Deployment

Deployed at https://ekult.co.uk/m/.

- `base: '/m/'` in `vite.config.ts` is absolute on purpose (PWA scope).
- `pnpm build` rebuilds the timetable and the app. Copy the **entire** `dist/` to the server's `/m/` directory, including `rt.php` (PHP hosting required).
- The feed horizon is about one month: **rebuild and redeploy at least every ~3 weeks**. The app warns when the timetable ends within 7 days.

## Not built

- EMT city buses via MobilityLabs: log in with X-ClientId + passKey inside `rt.php` (`?f=emt&stop=…`). Keep the credentials in a config file outside the webroot, never in the bundle or repo.
