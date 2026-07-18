/**
 * API — GET /api/track
 *
 * Public, read-only. No auth. Returns the vessel name plus the whole journey
 * in a compact shape the map can draw directly:
 *   { vessel, count, points: [...], logs: [...] }
 * both ordered oldest-first.
 *
 * Logs ride along rather than getting their own endpoint: they're a handful of
 * rows against tens of thousands of points, and folding them in means one fetch
 * and one failure mode instead of two.
 */
'use strict';

const db = require('./db');
const config = require('./config');

function handler(req, res) {
  try {
    const points = db.getTrack();
    const logs = db.getLogs();
    res.json({ vessel: config.vesselName, count: points.length, points, logs });
  } catch (error) {
    console.error(`[api] track error: ${error.message}`);
    res.status(500).json({ error: 'read error' });
  }
}

module.exports = handler;
