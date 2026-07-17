# signalk-web-tracker-server

Receives position reports from the [signalk-web-tracker](https://github.com/ofernander/signalk-web-tracker)
plugin.

## Requirements
- Public facing server with terminal access and basic web hosting knowledge
- Docker and Docker Compose

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
This key later gets used in the SignalK plugin.

Set `VESSEL_NAME` to whatever should title the map.

Then:
```bash
mkdir -p data
docker compose up -d --build
```

`mkdir -p data` first, or Docker creates it root-owned. The container publishes
to host port 8080.

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
| `DB_PATH` | `data/web-tracker-server.db` | 

## API

Three routes. One authenticated write, two public reads.

| Route | Auth | Purpose |
|---|---|---|
| `POST /api/ingest` | HMAC | Boat pushes a batch of points |
| `GET /api/track` | none | Whole track as JSON, for the map |
| `GET /healthz` | none | Liveness |

### `POST /api/ingest`
Authenticated. Accepts a batch of points from the boat.

Headers:
- `X-Timestamp` — Unix seconds
- `X-Signature` — `HMAC-SHA256(SHARED_KEY, "{timestamp}.{rawBody}")`, hex

The signature covers the exact request bytes, so the server captures the raw
body before parsing. Requests outside `TIMESTAMP_WINDOW_SEC`, with a bad
signature, or missing either header get a 401.

Request body:
```json
{
  "points": [
    {
      "id": 412,
      "ts": "2026-07-17T15:11:04.000Z",
      "lat": 37.7793,
      "lon": -122.2527,
      "env": [
        { "label": "Heading", "value": 215, "unit": "°" },
        { "label": "Wind Speed", "value": 4.4, "unit": "kt" }
      ]
    }
  ]
}
```

Per point: `ts` accepts an ISO-8601 string or epoch seconds and is normalized to
epoch seconds on the way in. `lat`/`lon` must be numbers in range. `id` is the
boat-side row id, used only to compute `accepted`; it defaults to 0 if absent.
`env` is optional and free-form — the server stores whatever labels the boat
sends, which is why a sensor added mid-voyage needs no server change.

Example:
```bash
BODY='{"points":[{"id":1,"ts":"2026-07-17T15:11:04.000Z","lat":37.7793,"lon":-122.2527,"env":[]}]}'
TS=$(date +%s)
SIG=$(printf '%s.%s' "$TS" "$BODY" | openssl dgst -sha256 -hmac "$SHARED_KEY" -hex | awk '{print $2}')

curl -X POST http://localhost:8080/api/ingest \
  -H "Content-Type: application/json" \
  -H "X-Timestamp: $TS" \
  -H "X-Signature: $SIG" \
  -d "$BODY"
```

Returns `{ accepted, stored }`. `accepted` is the highest boat-side id in the
batch and advances the plugin's watermark; `stored` is how many were new.

Points are deduplicated on `(timestamp, latitude, longitude)`, not on the boat's
id — a replayed batch returns 200 with `stored: 0` while `accepted` still
advances. That is the lost-ACK recovery path, and the durability design depends
on it.

A malformed point rejects the whole batch. This is deliberate — the alternative
silently drops data — but it means a bad buffered point stalls the watermark
until it is dealt with.

An empty `points` array is accepted and returns `{ accepted: 0, stored: 0 }`.

Responses:

| Code | Body | When |
|---|---|---|
| 200 | `{ accepted, stored }` | Batch stored, or replayed |
| 400 | `{ "error": "invalid JSON" }` | Body isn't parseable JSON |
| 400 | `{ "error": "expected { points: [...] }" }` | No `points` array |
| 400 | `{ "error": "invalid point in batch" }` | Any point fails validation |
| 401 | `{ "error": "unauthorized" }` | Bad/missing signature or timestamp |
| 429 | `{ "error": "rate limited" }` | Over `INGEST_RATE_MAX` for this IP |
| 500 | `{ "error": "storage error" }` | Write failed |

The 401 body never says which check failed — the reason is logged server-side
only, so a caller can't probe for it.

### `GET /api/track`
Public, no auth. Returns `{ vessel, count, points }`, oldest first.

```bash
curl http://localhost:8080/api/track
```

```json
{
  "vessel": "VESSEL NAME",
  "count": 2,
  "points": [
    {
      "ts": 1752764604,
      "lat": 37.7791,
      "lon": -122.2521,
      "env": [{ "label": "Heading", "value": 212, "unit": "°" }]
    },
    {
      "ts": 1752768204,
      "lat": 37.7793,
      "lon": -122.2527,
      "env": [{ "label": "Heading", "value": 215, "unit": "°" }]
    }
  ]
}
```

`ts` is epoch seconds here, not the ISO string the boat sent. No pagination and
no filtering — the whole track comes back every call. The map's date range
filters client-side from this payload.

Returns 500 `{ "error": "read error" }` if the read fails.

### `GET /healthz`
Liveness.

```bash
curl http://localhost:8080/healthz
```

```json
{ "ok": true, "points": 1284 }
```

`points` is the total row count, ignoring any date filtering.

## Data
SQLite at `data/web-tracker-server.db`

To clear all track data:
```bash
docker compose down
rm data/web-tracker-server.db
docker compose up -d
```