/**
 * DB — persistence for the tracker server.
 *
 * One table: points. Idempotency is enforced by a UNIQUE(timestamp, latitude,
 * longitude) constraint plus INSERT ... ON CONFLICT DO NOTHING, so a re-sent
 * batch (after a lost ACK on the boat side) is harmless. The boat-side point id
 * is NOT stored — it is only used to compute the 'accepted' high-water mark
 * echoed back so the boat can advance its watermark.
 *
 * This upsert/replay/accepted flow was verified against node:sqlite on Node
 * 22.22 before this module was written.
 */
'use strict';

const { DatabaseSync: Database } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');
const config = require('./config');

let db = null;
let upsertStmt = null;

function init() {
  // Ensure the parent directory of the db file exists (the volume mount).
  const dir = path.dirname(config.dbPath);
  fs.mkdirSync(dir, { recursive: true });

  db = new Database(config.dbPath);

  db.exec(`
    CREATE TABLE IF NOT EXISTS points (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp INTEGER NOT NULL,
      latitude REAL NOT NULL,
      longitude REAL NOT NULL,
      env TEXT,
      created_at INTEGER DEFAULT (strftime('%s', 'now')),
      UNIQUE(timestamp, latitude, longitude)
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_points_timestamp ON points(timestamp)`);

  upsertStmt = db.prepare(`
    INSERT INTO points (timestamp, latitude, longitude, env)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(timestamp, latitude, longitude) DO NOTHING
  `);

  console.log(`[db] ready at ${config.dbPath}`);
}

/**
 * Ingest a batch of points from the boat.
 * @param {Array<{id:number, ts:string, lat:number, lon:number, env:Array}>} points
 * @returns {{ accepted: number, stored: number }}
 *   accepted = highest boat-side id seen in the batch (advances boat watermark)
 *   stored   = number of rows actually inserted (excludes deduped replays)
 */
function ingestBatch(points) {
  let accepted = 0;
  let stored = 0;

  // Wrap in a transaction so a large batch is one disk sync, not N.
  db.exec('BEGIN');
  try {
    for (const p of points) {
      const result = upsertStmt.run(
        p.ts,
        p.lat,
        p.lon,
        p.env ? JSON.stringify(p.env) : '[]'
      );
      if (Number(result.changes) > 0) stored++;
      if (typeof p.id === 'number' && p.id > accepted) accepted = p.id;
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }

  return { accepted, stored };
}

/**
 * All stored points, oldest first, env parsed back into arrays.
 * @returns {Array<{ts:number, lat:number, lon:number, env:Array}>}
 */
function getTrack() {
  const rows = db.prepare(`
    SELECT timestamp, latitude, longitude, env
    FROM points
    ORDER BY timestamp ASC
  `).all();

  return rows.map(r => ({
    ts: r.timestamp,
    lat: r.latitude,
    lon: r.longitude,
    env: r.env ? JSON.parse(r.env) : []
  }));
}

function getCount() {
  const row = db.prepare('SELECT COUNT(*) AS n FROM points').get();
  return row ? row.n : 0;
}

function close() {
  if (db) {
    db.close();
    db = null;
  }
}

module.exports = { init, ingestBatch, getTrack, getCount, close };
