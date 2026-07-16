# signalk-web-tracker-server

Receives position reports from the [signalk-web-tracker](https://github.com/ofernander/signalk-web-tracker)
plugin and serves a map of the voyage.

The boat pushes; the server never reaches back. Points are signed with a shared
key, stored in SQLite, and served to a public read-only map.

## Requirements
- Docker and Docker Compose
- A reverse proxy in front (TLS terminates there; the container speaks plain HTTP)

## Install
```bash
git clone https://github.com/ofernander/signalk-web-tracker-server.git
cd signalk-web-tracker-server
cp .env.example .env
```

Set `SHARED_KEY` to a long random string:
```bash
openssl rand -hex 32
```
The same value goes in the plugin's "Shared Signing Key" field. If they differ,
every push is rejected with a 401.

Set `VESSEL_NAME` to whatever should title the map.

Then:
```bash
mkdir -p data
docker compose up -d --build
```

`mkdir -p data` first, or Docker creates it root-owned. The container publishes
to host port 8088; point the proxy there.

## Configuration
All via `.env`. See `.env.example` for the full list.

| Variable | Default | Notes |
|---|---|---|
| `SHARED_KEY` | — | Required. Server exits if unset. |
| `VESSEL_NAME` | `SignalK-Web-Tracker` | Map heading and page title. |
| `PORT` | `8080` | Inside the container. |
| `TIMESTAMP_WINDOW_SEC` | `300` | Replay window for ingest. |
| `INGEST_RATE_MAX` | `60` | Per client IP, per window. |
| `INGEST_RATE_WINDOW_SEC` | `60` | |
| `DB_PATH` | `data/web-tracker-server.db` | Rarely needed. Must stay under `/app/data` or the DB lands on the container's writable layer and vanishes on rebuild. |

## API

### `POST /api/ingest`
Authenticated. Accepts a batch of points from the boat.

Headers:
- `X-Timestamp` — Unix seconds
- `X-Signature` — `HMAC-SHA256(SHARED_KEY, "{timestamp}.{rawBody}")`, hex

The signature covers the exact request bytes, so the server captures the raw
body before parsing. Requests outside `TIMESTAMP_WINDOW_SEC`, with a bad
signature, or missing either header get a 401.

Returns `{ accepted, stored }`. `accepted` is the highest boat-side id in the
batch and advances the plugin's watermark; `stored` is how many were new.

Points are deduplicated on `(timestamp, latitude, longitude)`, not on the boat's
id — a replayed batch returns 200 with `stored: 0` while `accepted` still
advances. That is the lost-ACK recovery path, and the durability design depends
on it.

A malformed point rejects the whole batch. This is deliberate — the alternative
silently drops data — but it means a bad buffered point stalls the watermark
until it is dealt with.

### `GET /api/track`
Public, no auth. Returns `{ vessel, count, points }`, oldest first.

### `GET /healthz`
Liveness.

## Data
SQLite at `data/web-tracker-server.db`, bind-mounted from the host. Uses Node's
built-in `node:sqlite`, which emits an experimental warning on startup.

To wipe the track:
```bash
docker compose down
rm data/web-tracker-server.db
docker compose up -d
```

Note this only clears the server. The plugin's watermark still says those points
were delivered, so it won't resend them — the map restarts from the next new
point. To replay history, clear the plugin's own database on the boat too.

## Map
MapLibre GL JS with vector tiles from [OpenFreeMap](https://openfreemap.org),
plus the [OpenSeaMap](https://www.openseamap.org/) seamark overlay for buoys,
lights and traffic separation schemes.

Tiles are fetched by the viewer's browser, not proxied through this server.

The basemap style is `public/map_style.json` — a fork of OSM Liberty, editable
in [Maputnik](https://maputnik.github.io/editor/). Every layer carries an
explicit `visibility` for toggling. Load the file into Maputnik, edit, export,
replace. `BASEMAP_STYLE` in `public/app.js` points at it.

Leave the `background` layer visible. It is the only generic land fill; without
it, anything that isn't water or landcover renders as a hole.
