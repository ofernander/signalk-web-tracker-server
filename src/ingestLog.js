/**
 * Ingest logs — POST /api/ingest/log
 *
 * Sibling of ingest.js: same HMAC-over-raw-body auth, same rate limiter,
 * different payload. One log per request, photos base64'd inline.
 *
 * Atomicity is deliberate and matches the boat's contract: the whole log
 * (text + every photo) either lands or it doesn't. A partial log is worse than
 * a retry, and the boat re-sends on failure.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const auth = require('./auth');
const db = require('./db');
const config = require('./config');

// Photos arrive base64'd in the JSON body. The boat caps the total at 3.5MB
// pre-encoding, which lands ~4.7MB on the wire — inside express's 5mb limit
// with headroom. These are a backstop, not the primary guard: the boat refuses
// to send oversized logs and warns the user to trim first.
const MAX_PHOTOS = 12;
const MAX_PHOTO_BYTES = 1024 * 1024;      // per photo, decoded
const MAX_PHOTOS_TOTAL_BYTES = 4 * 1024 * 1024;

// Only formats a browser canvas can emit. The boat resizes client-side before
// upload, so anything else means something is wrong upstream.
const ALLOWED_MIME = new Map([
  ['image/jpeg', 'jpg'],
  ['image/png', 'png'],
  ['image/webp', 'webp']
]);

// A uuid from the wire becomes part of a filename, so it is validated as a
// strict uuid-shaped string rather than trusted. Anything with a slash or a dot
// never reaches the filesystem.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function toEpochSeconds(ts) {
  if (typeof ts === 'number' && Number.isFinite(ts)) return Math.floor(ts);
  if (typeof ts === 'string') {
    const ms = Date.parse(ts);
    if (!Number.isNaN(ms)) return Math.floor(ms / 1000);
  }
  return null;
}

/**
 * Validate and normalize an incoming log. Returns a clean log or null.
 */
function normalizeLog(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (typeof raw.uuid !== 'string' || !UUID_RE.test(raw.uuid)) return null;

  const ts = toEpochSeconds(raw.ts);
  if (ts === null) return null;

  // Position is optional: a log written with no GPS fix is still a log. It just
  // won't get a map marker.
  let lat = null;
  let lon = null;
  if (raw.lat !== null && raw.lat !== undefined) {
    if (typeof raw.lat !== 'number' || raw.lat < -90 || raw.lat > 90) return null;
    lat = raw.lat;
  }
  if (raw.lon !== null && raw.lon !== undefined) {
    if (typeof raw.lon !== 'number' || raw.lon < -180 || raw.lon > 180) return null;
    lon = raw.lon;
  }

  return {
    uuid: raw.uuid.toLowerCase(),
    ts,
    lat,
    lon,
    voyageName: typeof raw.voyageName === 'string' ? raw.voyageName : null,
    logText: typeof raw.logText === 'string' ? raw.logText : null,
    env: Array.isArray(raw.env) ? raw.env : [],
    distanceSinceLast: typeof raw.distanceSinceLast === 'number' ? raw.distanceSinceLast : null,
    totalDistance: typeof raw.totalDistance === 'number' ? raw.totalDistance : null
  };
}

/**
 * Decode and validate photos.
 * @returns {{ photos: Array<{buf: Buffer, ext: string}> } | { error: string }}
 */
function decodePhotos(rawPhotos) {
  if (rawPhotos === undefined || rawPhotos === null) return { photos: [] };
  if (!Array.isArray(rawPhotos)) return { error: 'photos must be an array' };
  if (rawPhotos.length > MAX_PHOTOS) return { error: 'too many photos' };

  const photos = [];
  let total = 0;

  for (const p of rawPhotos) {
    if (!p || typeof p !== 'object') return { error: 'invalid photo' };
    const ext = ALLOWED_MIME.get(p.mime);
    if (!ext) return { error: 'unsupported photo type' };
    if (typeof p.data !== 'string') return { error: 'invalid photo' };

    let buf;
    try {
      buf = Buffer.from(p.data, 'base64');
    } catch {
      return { error: 'invalid photo encoding' };
    }
    if (buf.length === 0) return { error: 'empty photo' };
    if (buf.length > MAX_PHOTO_BYTES) return { error: 'photo too large' };

    total += buf.length;
    if (total > MAX_PHOTOS_TOTAL_BYTES) return { error: 'photos too large' };

    photos.push({ buf, ext });
  }

  return { photos };
}

/**
 * @param {(ip: string) => boolean} rateLimited shared with the track ingest route
 */
function makeHandler(rateLimited) {
  return function handler(req, res) {
    const ip = req.ip || req.socket?.remoteAddress || 'unknown';

    if (rateLimited(ip)) {
      return res.status(429).json({ error: 'rate limited' });
    }

    // req.rawBody is captured by the raw-body middleware in server.js.
    const rawBody = req.rawBody;
    const result = auth.verify(req.get('X-Timestamp'), req.get('X-Signature'), rawBody);
    if (!result.ok) {
      // Do not leak which part failed to the client; log it server-side only.
      console.warn(`[ingestLog] auth rejected from ${ip}: ${result.reason}`);
      return res.status(401).json({ error: 'unauthorized' });
    }

    let payload;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return res.status(400).json({ error: 'invalid JSON' });
    }

    const log = normalizeLog(payload && payload.log);
    if (!log) return res.status(400).json({ error: 'invalid log' });

    const decoded = decodePhotos(payload.photos);
    if (decoded.error) return res.status(400).json({ error: decoded.error });

    // A log is only a log if it has written text OR at least one photo. A bare
    // position is the tracking plugin's job, not this endpoint's — noon-log
    // gates these out client-side, but the server does not trust the client:
    // accept-and-drop keeps a misbehaving or outdated caller from planting
    // blank markers on the map. 2xx so the caller treats it as done and does
    // not retry; nothing is stored.
    const hasText = typeof log.logText === 'string' && log.logText.trim().length > 0;
    const hasPhotos = decoded.photos.length > 0;
    if (!hasText && !hasPhotos) {
      console.log(`[ingestLog] ${ip}: ${log.uuid} dropped — no text or photos`);
      return res.json({ uuid: log.uuid, stored: false, dropped: true, photos: 0 });
    }

    // Filenames are derived from the validated uuid, never from the wire.
    const filenames = decoded.photos.map((p, i) => `${log.uuid}-${i}.${p.ext}`);

    // Photos this log used to have. Anything not in the new set is stale once
    // the upsert lands, and gets removed after — not before, so a failed write
    // leaves the previous version intact.
    let previous = [];
    try {
      previous = db.getExistingPhotos(log.uuid);
    } catch (error) {
      console.error(`[ingestLog] db error reading photos: ${error.message}`);
      return res.status(500).json({ error: 'storage error' });
    }

    // Write files first: a row pointing at a missing file is worse than an
    // orphaned file no row references.
    const written = [];
    try {
      fs.mkdirSync(config.photoDir, { recursive: true });
      decoded.photos.forEach((p, i) => {
        const dest = path.join(config.photoDir, filenames[i]);
        fs.writeFileSync(dest, p.buf);
        written.push(dest);
      });
    } catch (error) {
      // Roll back the files we managed to write — the log is all-or-nothing.
      for (const f of written) {
        try { fs.unlinkSync(f); } catch { /* best effort */ }
      }
      console.error(`[ingestLog] photo write failed: ${error.message}`);
      return res.status(500).json({ error: 'storage error' });
    }

    let stored;
    try {
      ({ stored } = db.upsertLog(log, filenames));
    } catch (error) {
      for (const f of written) {
        try { fs.unlinkSync(f); } catch { /* best effort */ }
      }
      console.error(`[ingestLog] db error: ${error.message}`);
      return res.status(500).json({ error: 'storage error' });
    }

    // Now safe to drop photos the log no longer references.
    for (const name of previous) {
      if (filenames.includes(name)) continue;
      try { fs.unlinkSync(path.join(config.photoDir, name)); } catch { /* best effort */ }
    }

    console.log(`[ingestLog] ${ip}: ${log.uuid} ${stored ? 'stored' : 'updated'}, ${filenames.length} photo(s)`);
    return res.json({ uuid: log.uuid, stored, photos: filenames.length });
  };
}

module.exports = makeHandler;
