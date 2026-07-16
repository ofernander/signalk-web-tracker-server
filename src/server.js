/**
 * Server — express wiring and startup.
 *
 * Route layout:
 *   POST /api/ingest   authenticated write path (raw body for HMAC)
 *   GET  /api/track    public read-only JSON for the map
 *   GET  /*            static map UI from public/
 *
 * The ingest route needs the EXACT request bytes to verify the HMAC, so it uses
 * a raw body parser that stashes the buffer on req.rawBody. The rest of the app
 * uses normal JSON parsing. TLS is terminated by the reverse proxy in front of
 * this container; here we listen plain HTTP.
 */
'use strict';

const express = require('express');
const path = require('node:path');

const config = require('./config');
const db = require('./db');
const ingestHandler = require('./ingest');
const trackHandler = require('./api');

function start() {
  db.init();

  const app = express();

  // Trust the reverse proxy so req.ip reflects the real client, not the proxy.
  app.set('trust proxy', true);

  // Ingest: capture the raw body as a string for HMAC verification. We do NOT
  // json-parse here — ingest.js parses the already-verified raw body itself.
  app.post(
    '/api/ingest',
    express.raw({ type: '*/*', limit: '5mb' }),
    (req, res, next) => {
      req.rawBody = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
      next();
    },
    ingestHandler
  );

  // Public read-only track data.
  app.get('/api/track', trackHandler);

  // Static map UI.
  app.use(express.static(path.join(__dirname, '..', 'public')));

  // Basic health check for the proxy / container orchestration.
  app.get('/healthz', (req, res) => res.json({ ok: true, points: db.getCount() }));

  const server = app.listen(config.port, () => {
    console.log(`[server] listening on :${config.port}`);
  });

  // Graceful shutdown so the sqlite handle closes cleanly.
  function shutdown(signal) {
    console.log(`[server] ${signal} received, shutting down`);
    server.close(() => {
      db.close();
      process.exit(0);
    });
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

start();
