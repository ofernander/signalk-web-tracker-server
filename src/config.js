/**
 * Config — read and validate environment once at startup.
 *
 * Everything else imports from here rather than touching process.env directly.
 * A tracker with no signing key must not boot, so SHARED_KEY is required and
 * startup fails fast if it is absent.
 */
'use strict';

const path = require('node:path');

function required(name) {
  const value = process.env[name];
  if (!value || value.trim() === '') {
    console.error(`FATAL: environment variable ${name} is required and was not set.`);
    process.exit(1);
  }
  return value;
}

function optionalInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n)) {
    console.error(`FATAL: environment variable ${name} must be an integer, got "${raw}".`);
    process.exit(1);
  }
  return n;
}

const config = {
  // HMAC signing key shared with the boat plugin. No default — must be set.
  sharedKey: required('SHARED_KEY'),

  // Name shown as the heading in the web UI.
  vesselName: process.env.VESSEL_NAME || 'SignalK-Web-Tracker',

  // Port the container listens on (plain HTTP; TLS is terminated by the proxy).
  port: optionalInt('PORT', 8080),

  // Accept ingest requests whose timestamp is within this many seconds of now.
  // Defends against replay of captured requests.
  timestampWindowSec: optionalInt('TIMESTAMP_WINDOW_SEC', 300),

  // Where the sqlite database lives. Defaults to the data/ volume mount.
  dbPath: process.env.DB_PATH || path.join(__dirname, '..', 'data', 'web-tracker-server.db'),

  // Where log photos land. Sits inside the same volume mount as the db so a
  // single bind mount covers all persistent state.
  photoDir: process.env.PHOTO_DIR || path.join(__dirname, '..', 'data', 'photos'),

  // Simple in-process rate limit for the ingest endpoint (defense-in-depth on
  // top of HMAC). Max requests per window per client IP.
  ingestRateMax: optionalInt('INGEST_RATE_MAX', 60),
  ingestRateWindowSec: optionalInt('INGEST_RATE_WINDOW_SEC', 60),

  // Positions within this many meters of the last stored position are snapped
  // to it rather than stored as new coordinates — collapses stationary GPS
  // jitter so the track stays honest to real voyage movement. See ingest path
  // in db.js (ingestBatch).
  movementThresholdM: optionalInt('MOVEMENT_THRESHOLD_M', 100)
};

module.exports = config;
