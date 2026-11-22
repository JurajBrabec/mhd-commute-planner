# MHD Commute Planner

Plan a personal public-transport commute in Bratislava using static timetables from imhd.sk. Configure the stops, line directions, walking links and departure windows you care about; the planner compares earliest-arrival itineraries and alternatives. Arrival times are estimates, not live delay information.

## Configure

Copy `config/routes.example.yaml` to `config/routes.yaml` and replace the placeholder stops and URLs with your own. Each line direction needs a separate entry, with an imhd.sk per-stop timetable URL for each configured boarding stop. The example is a schema illustration, not a working schedule.

`config/routes.yaml` contains private commute information and is ignored by Git and excluded from the container image. Check any files and history for private data before publishing.

## Run with Docker

```sh
docker build -t mhd-commute .
docker run --rm -p 127.0.0.1:3000:3000 \
  --mount type=bind,src="$(pwd)/config/routes.yaml",dst=/app/config/routes.yaml,readonly \
  mhd-commute
```

Open <http://127.0.0.1:3000>. The image binds to `0.0.0.0` inside the container; the example publishes only to the host's loopback interface. It runs as a non-root user. Its cache is ephemeral unless `/app/.cache` is mounted as a writable volume owned by that user. Restart the container after changing configuration.

**Trusted private use only:** the app has no authentication. Do not expose it to the public internet without access controls and a security review. Anyone who can access it can view the configured commute and refresh its cache.

## Run locally

Use Node.js 24 and npm:

```sh
npm ci
npm run build
npm start
```

`npm start` runs the built application; rebuild after changing source. For development, `npm run dev` runs TypeScript directly without a build.

`HOST` defaults to `127.0.0.1`, `PORT` to `3000`. To listen on another address, set them before starting, for example `HOST=0.0.0.0 PORT=8080 npm start`. The service has no authentication, so restrict network access.

For a console or JSON report use `npm run plan -- --json`; `npm run viz` generates `viz/mockups.html`. Both accept a config path and `--pattern=workday|freeday` (default: workday). The server supports changing patterns in the UI. It loads configuration at startup.

## Data and limitations

Fetched timetable pages are cached for the local calendar day; computed schedules are cached per day and pattern. **Refresh schedule** clears both caches and reloads the page. The displayed generation time is when the itinerary was computed, not necessarily when every timetable page was fetched. The UI also reports line numbers whose parsed departures or stop offsets changed since the previous successful comparison of that pattern. A first comparison establishes a baseline; it cannot detect earlier changes. Added or changed page URLs are identified as having no previous snapshot, and removed pages are reported by count. Fingerprints are stored separately in `.schedule-history/` and survive a cache refresh; mount `/app/.schedule-history` as a writable volume to retain them across container replacement. This tracks configured pages only, not the whole network.

Line filters select from precomputed itineraries rather than recalculating routes. The scraper depends on imhd.sk HTML and may break when the site changes. Service patterns do not offer arbitrary-date planning. Check imhd.sk's terms and applicable rights before redistributing timetable data or fixtures.

## Development

```sh
npm ci
npm test
npx tsc --noEmit
```

Tests use synthetic timetable fixtures and do not need network access. Synthetic fixtures avoid redistributing third-party pages but cannot guarantee compatibility with future site changes. To check one configured timetable against the live site, run `npm run check:live` (or `npm run check:live -- path/to/routes.yaml`). It makes one network request without using or changing the cache, checks both patterns and reports matching downstream stops; it does not verify the entire network. See `AGENTS.md` for module-level guidance.
