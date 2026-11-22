# MHD Commute Planner

A personal Bratislava public-transit commute planner. The user configures a
network of stops, line directions, timetable URLs, walking links and departure
windows. The planner scrapes static imhd.sk schedules, computes earliest-arrival
itineraries and presents them in a browser or as JSON. Real-time disruption data
is outside the current scope.

## Development

- TypeScript / Node.js; npm is the package manager.
- `npm test` runs the Node test suite; `npx tsc --noEmit` type-checks.
- `npm start` serves the built application; run `npm run build` first.
  `npm run dev` serves TypeScript directly. `HOST` defaults to `127.0.0.1`
  and `PORT` to `3000`. Configuration is loaded at startup.
- `npm run viz` generates the static visualization; `npm run plan -- --json`
  emits structured planning output.
- `config/routes.yaml` is private local configuration and must not be committed.
  `config/routes.example.yaml` documents the schema with placeholder URLs.
- `.cache/` contains fetched timetable pages and must not be committed.

## Architecture

- `src/config.ts` loads and validates YAML configuration.
- `src/scraper.ts` parses imhd.sk timetable pages, selecting a workday or
  free-day pattern by label and using the middle departure epoch. It uses the
  conservative maximum stop offset for approximate travel times.
- `src/cache.ts` caches fetched pages by URL and local calendar date. The server
  additionally caches computed results by date and pattern; refresh clears both.
- `src/planner.ts` searches the configured graph and retains origin and
  destination alternatives. Same-stop walk transfers represent turn penalties.
- `src/format.ts` serializes itineraries, including explicit walk endpoints.
- `src/build-viz.ts` generates the HTML interface and provides the HTTP server.
  Its browser script is embedded in a template literal; avoid unescaped
  backticks inside it.
- `src/__tests__/` contains offline unit and HTTP integration tests and synthetic
  timetable HTML fixtures.

## Important limitations

- Line filters filter precomputed itineraries; they do not re-plan the network.
- Arrival estimates use static stop offsets, not live or exact per-trip data.
- Timetable pages and their URL structures can change; validate scraped results
  and configured stop names against the source.
- The application is intended for personal use on a trusted private network;
  exposing it publicly requires a separate security review and access controls.
