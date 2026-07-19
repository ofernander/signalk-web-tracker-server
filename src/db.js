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
let upsertLogStmt = null;
let deletePhotosStmt = null;
let insertPhotoStmt = null;

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

  // Logs from the boat's noon-log plugin. Keyed on a boat-generated UUID, NOT
  // on any local id: noon-log drops and recreates its tables on schema drift,
  // so its autoincrement ids are not durable. The UUID is assigned at log
  // creation and survives that.
  //
  // voyage_name is denormalized rather than modelled — the server has no
  // concept of a voyage, it just displays the label the boat sent. A renamed
  // voyage means future logs carry the new name and old ones keep the old,
  // which is a truthful historical record.
  db.exec(`
    CREATE TABLE IF NOT EXISTS logs (
      uuid TEXT PRIMARY KEY,
      timestamp INTEGER NOT NULL,
      latitude REAL,
      longitude REAL,
      voyage_name TEXT,
      log_text TEXT,
      env TEXT,
      distance_since_last REAL,
      total_distance REAL,
      created_at INTEGER DEFAULT (strftime('%s', 'now')),
      updated_at INTEGER DEFAULT (strftime('%s', 'now'))
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_logs_timestamp ON logs(timestamp)`);

  // One row per photo. filename is server-generated from the log uuid — never
  // taken from the wire, since a client-supplied name on a public endpoint is a
  // path traversal risk.
  db.exec(`
    CREATE TABLE IF NOT EXISTS log_photos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      log_uuid TEXT NOT NULL,
      filename TEXT NOT NULL,
      seq INTEGER NOT NULL,
      FOREIGN KEY (log_uuid) REFERENCES logs(uuid) ON DELETE CASCADE
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_log_photos_uuid ON log_photos(log_uuid)`);

  // Upsert, not insert: a re-published log (edit, or a retry after a lost ACK)
  // updates in place rather than duplicating.
  upsertLogStmt = db.prepare(`
    INSERT INTO logs (uuid, timestamp, latitude, longitude, voyage_name, log_text, env,
                      distance_since_last, total_distance)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(uuid) DO UPDATE SET
      timestamp = excluded.timestamp,
      latitude = excluded.latitude,
      longitude = excluded.longitude,
      voyage_name = excluded.voyage_name,
      log_text = excluded.log_text,
      env = excluded.env,
      distance_since_last = excluded.distance_since_last,
      total_distance = excluded.total_distance,
      updated_at = strftime('%s', 'now')
  `);

  deletePhotosStmt = db.prepare(`DELETE FROM log_photos WHERE log_uuid = ?`);
  insertPhotoStmt = db.prepare(`
    INSERT INTO log_photos (log_uuid, filename, seq) VALUES (?, ?, ?)
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
    // Running "last real position" the snap measures against. Seeded from the
    // DB so the first point of a batch is compared to the true last fix, then
    // advanced as we insert so within-batch movement is measured correctly too.
    let anchor = getLastStored(); // { ts, lat, lon } | null
    const threshold = config.movementThresholdM;

    for (const p of points) {
      let lat = p.lat;
      let lon = p.lon;

      // If we have a prior position and this point hasn't moved past the
      // threshold, snap its coordinates onto that prior position. The row is
      // still stored (timestamp + env preserved) — only the coordinates
      // collapse, so a stationary boat makes one dot and adds zero distance.
      if (anchor && threshold > 0) {
        const moved = haversineMeters(anchor.lat, anchor.lon, lat, lon);
        if (moved < threshold) {
          lat = anchor.lat;
          lon = anchor.lon;
        }
      }

      const result = upsertStmt.run(
        p.ts,
        lat,
        lon,
        p.env ? JSON.stringify(p.env) : '[]'
      );
      if (Number(result.changes) > 0) {
        stored++;
        // Advance the anchor to the position actually stored (snapped or not),
        // but only on a real insert — a deduped replay must not move it.
        anchor = { ts: p.ts, lat, lon };
      }
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

/**
 * Great-circle distance in meters between two lat/lon pairs. Mirrors the
 * plugin's haversine (lib/distance.js) so the server measures movement the same
 * way the boat does. Earth radius 6371000 m.
 */
function haversineMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = d => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/**
 * The most recently stored position (highest timestamp), or null if the table
 * is empty. Used by the ingest snap to decide whether an incoming point has
 * really moved.
 */
function getLastStored() {
  const row = db.prepare(
    `SELECT timestamp, latitude, longitude FROM points ORDER BY timestamp DESC LIMIT 1`
  ).get();
  return row ? { ts: row.timestamp, lat: row.latitude, lon: row.longitude } : null;
}

/**
 * Store one log and its photo filenames. Photo rows are replaced wholesale on
 * re-publish: the boat is the source of truth for which photos belong to a log,
 * so a removed photo must disappear here too.
 *
 * The caller writes the image files BEFORE calling this — a db row pointing at
 * a file that doesn't exist is worse than an orphan file that no row references.
 *
 * @returns {{ stored: boolean }} false if the log already existed and was updated
 */
function upsertLog(log, filenames) {
  db.exec('BEGIN');
  try {
    // ON CONFLICT DO UPDATE reports changes: 1 exactly like an insert does, so
    // result.changes cannot distinguish the two. Check first, inside the same
    // transaction so the answer can't race another writer.
    const existing = db.prepare(
      `SELECT 1 FROM logs WHERE uuid = ?`
    ).get(log.uuid);

    upsertLogStmt.run(
      log.uuid,
      log.ts,
      log.lat,
      log.lon,
      log.voyageName,
      log.logText,
      log.env ? JSON.stringify(log.env) : '[]',
      log.distanceSinceLast,
      log.totalDistance
    );

    deletePhotosStmt.run(log.uuid);
    filenames.forEach((name, i) => insertPhotoStmt.run(log.uuid, name, i));

    db.exec('COMMIT');
    return { stored: !existing };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

/**
 * All logs, oldest first, with photo filenames attached.
 */
function getLogs() {
  const rows = db.prepare(`
    SELECT uuid, timestamp, latitude, longitude, voyage_name, log_text, env,
           distance_since_last, total_distance
    FROM logs
    ORDER BY timestamp ASC
  `).all();

  const photoStmt = db.prepare(
    `SELECT filename FROM log_photos WHERE log_uuid = ? ORDER BY seq ASC`
  );

  return rows.map(r => ({
    uuid: r.uuid,
    ts: r.timestamp,
    lat: r.latitude,
    lon: r.longitude,
    voyage: r.voyage_name,
    text: r.log_text,
    env: r.env ? JSON.parse(r.env) : [],
    distance: {
      sinceLast: r.distance_since_last,
      total: r.total_distance
    },
    photos: photoStmt.all(r.uuid).map(p => p.filename)
  }));
}

/**
 * Filenames currently associated with a log. Used to clean up photos dropped
 * on a re-publish.
 */
function getExistingPhotos(logUuid) {
  return db.prepare(
    `SELECT filename FROM log_photos WHERE log_uuid = ?`
  ).all(logUuid).map(r => r.filename);
}

function close() {
  if (db) {
    db.close();
    db = null;
  }
}

module.exports = {
  init, ingestBatch, getTrack, getCount, close,
  upsertLog, getLogs, getExistingPhotos
};
