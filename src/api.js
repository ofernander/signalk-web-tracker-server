/**
 * API — GET /api/track
 *
 * Public, read-only. No auth. Returns the vessel name plus the whole journey
 * in a compact shape the map can draw directly:
 *   { vessel: "...", count: N, points: [ { ts, lat, lon, env: [...] }, ... ] }
 * ordered oldest-first.
 */
'use strict';

const db = require('./db');
const config = require('./config');

function handler(req, res) {
  try {
    const points = db.getTrack();
    res.json({ vessel: config.vesselName, count: points.length, points });
  } catch (error) {
    console.error(`[api] track error: ${error.message}`);
    res.status(500).json({ error: 'read error' });
  }
}

module.exports = handler;
