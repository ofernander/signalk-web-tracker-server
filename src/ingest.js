/**
 * Ingest — POST /api/ingest
 *
 * The only write path. Guarded by HMAC auth (auth.js) over the RAW request body
 * and a simple per-IP rate limit. On success, upserts the batch and returns
 * { accepted } — the highest boat-side id in the batch — so the boat can
 * advance its sync watermark.
 *
 * Contract note: the boat sends each point's `ts` as an ISO-8601 string, but the
 * dedup key and storage use epoch seconds. We normalize ISO -> epoch here before
 * handing the batch to the db layer.
 */
'use strict';

const auth = require('./auth');
const db = require('./db');
const config = require('./config');

// --- simple in-process per-IP rate limiter (defense-in-depth) ---
const hits = new Map(); // ip -> { count, windowStart (sec) }

function rateLimited(ip) {
  const now = Math.floor(Date.now() / 1000);
  const entry = hits.get(ip);
  if (!entry || now - entry.windowStart >= config.ingestRateWindowSec) {
    hits.set(ip, { count: 1, windowStart: now });
    return false;
  }
  entry.count++;
  return entry.count > config.ingestRateMax;
}

// Periodically prune stale entries so the map doesn't grow unbounded.
setInterval(() => {
  const now = Math.floor(Date.now() / 1000);
  for (const [ip, entry] of hits) {
    if (now - entry.windowStart >= config.ingestRateWindowSec) hits.delete(ip);
  }
}, 60 * 1000).unref();

/**
 * Convert an incoming point's ts (ISO string or epoch number) to epoch seconds.
 * Returns null if unparseable.
 */
function toEpochSeconds(ts) {
  if (typeof ts === 'number' && Number.isFinite(ts)) {
    return Math.floor(ts);
  }
  if (typeof ts === 'string') {
    const ms = Date.parse(ts);
    if (!Number.isNaN(ms)) return Math.floor(ms / 1000);
  }
  return null;
}

/**
 * Validate and normalize a single incoming point. Returns a clean point or null.
 */
function normalizePoint(p) {
  if (!p || typeof p !== 'object') return null;
  const ts = toEpochSeconds(p.ts);
  if (ts === null) return null;
  if (typeof p.lat !== 'number' || typeof p.lon !== 'number') return null;
  if (p.lat < -90 || p.lat > 90 || p.lon < -180 || p.lon > 180) return null;

  const env = Array.isArray(p.env) ? p.env : [];
  const id = typeof p.id === 'number' ? p.id : 0;

  return { id, ts, lat: p.lat, lon: p.lon, env };
}

function handler(req, res) {
  const ip = req.ip || req.socket?.remoteAddress || 'unknown';

  if (rateLimited(ip)) {
    return res.status(429).json({ error: 'rate limited' });
  }

  // req.rawBody is captured by the raw-body middleware in server.js.
  const rawBody = req.rawBody;
  const result = auth.verify(
    req.get('X-Timestamp'),
    req.get('X-Signature'),
    rawBody
  );
  if (!result.ok) {
    // Do not leak which part failed to the client; log it server-side only.
    console.warn(`[ingest] auth rejected from ${ip}: ${result.reason}`);
    return res.status(401).json({ error: 'unauthorized' });
  }

  // Parse the (already-verified) body.
  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return res.status(400).json({ error: 'invalid JSON' });
  }

  if (!payload || !Array.isArray(payload.points)) {
    return res.status(400).json({ error: 'expected { points: [...] }' });
  }

  // Normalize + validate every point. Reject the batch if any point is bad,
  // so the boat doesn't silently lose data it thinks was accepted.
  const clean = [];
  for (const p of payload.points) {
    const np = normalizePoint(p);
    if (!np) {
      return res.status(400).json({ error: 'invalid point in batch' });
    }
    clean.push(np);
  }

  if (clean.length === 0) {
    return res.json({ accepted: 0, stored: 0 });
  }

  try {
    const { accepted, stored } = db.ingestBatch(clean);
    console.log(`[ingest] ${ip}: ${clean.length} received, ${stored} stored, accepted=${accepted}`);
    return res.json({ accepted, stored });
  } catch (error) {
    console.error(`[ingest] db error: ${error.message}`);
    return res.status(500).json({ error: 'storage error' });
  }
}

module.exports = handler;
// Shared with the log ingest route so a flood on either counts against the same
// per-IP budget.
module.exports.rateLimited = rateLimited;
