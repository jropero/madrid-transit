# madrid-transit

Next Renfe Cercanías departures in Madrid. A small React + TypeScript PWA on [Vite+](https://viteplus.dev), with a Windows Phone "Metro" look.

## Features

- **Departures:** the next 2 hours for a stop, grouped by line and destination, with Cercanías line colours, minutes left, `+N'` delay, cancelled departures struck through and step-free boarding (♿).
- **Service alerts:** active Renfe alerts for Madrid lines as a banner and a ⚠ on affected lines (Spanish, as supplied).
- **Saved stops:** Atocha and Sol are preset. Add stops by name search (accent-insensitive) or **near me**.
- **Offline:** the timetable is local, so departures work fully offline; the last live data is kept.
- **Metro UI:** swipe pivot, app bar, tilt on press, 20 accent colours, Selawik font, Fluent icons.

Notes for coding agents are in [AGENTS.md](AGENTS.md).

## Data

- Timetable: Renfe open GTFS, `https://ssl.renfe.com/ftransit/Fichero_CER_FOMENTO/fomento_transit.zip` (all Spain, updated daily). `pnpm data` filters the Madrid núcleo (`10T` routes) into `public/data/`. Needs Node >= 22 and the system `unzip`.
- Live: GTFS-Realtime JSON `https://gtfsrt.renfe.com/trip_updates.json` and `alerts.json` (no auth, no CORS), reached through `public/rt.php`.
- Attribution: data from Renfe Operadora. Verify the licence text on data.renfe.com before publishing.

## Development

`pnpm install`, then `pnpm dev` (runs on http://localhost:5173/m/). The first build or `pnpm data` downloads the 16 MB zip into `.cache/`. The dev server proxies `/m/rt.php` to Renfe.

## Deployment

Deployed at https://ekult.co.uk/m/.

- `base: '/m/'` in `vite.config.ts` is absolute on purpose (PWA scope).
- `pnpm build` rebuilds the timetable and the app. Copy the **entire** `dist/` to the server's `/m/` directory, including `rt.php` (PHP hosting required).
- The feed horizon is about one month: **rebuild and redeploy at least every ~3 weeks**. The app warns when the timetable ends within 7 days.

## Phase 2 (not built)

- EMT city buses via MobilityLabs: log in with X-ClientId + passKey inside `rt.php` (`?f=emt&stop=…`). Keep the credentials in a config file outside the webroot, never in the bundle or repo.
- Interurban buses: NAP feed 1361 with `NAP_TOKEN` in `.env`, same timetable script.
