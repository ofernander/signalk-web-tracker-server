/**
 * Auth — verify the HMAC signature and timestamp on an ingest request.
 *
 * Mirror of the boat plugin's signing (client/lib/sync.js):
 *   signature = HMAC-SHA256( `${timestamp}.${rawBody}` )  as hex
 * where timestamp is epoch seconds as a string and rawBody is the exact bytes
 * of the request body. The raw body MUST be captured before any JSON parsing,
 * because re-serializing would change the bytes and break the signature.
 */
'use strict';

const crypto = require('node:crypto');
const config = require('./config');

/**
 * Verify a request.
 * @param {string} timestamp - value of the X-Timestamp header (epoch seconds)
 * @param {string} signature - value of the X-Signature header (hex)
 * @param {string|Buffer} rawBody - exact request body bytes
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
function verify(timestamp, signature, rawBody) {
  if (!timestamp || !signature) {
    return { ok: false, reason: 'missing timestamp or signature' };
  }

  // Timestamp must be a valid integer within the allowed window.
  const ts = Number.parseInt(timestamp, 10);
  if (Number.isNaN(ts)) {
    return { ok: false, reason: 'timestamp not an integer' };
  }
  const nowSec = Math.floor(Date.now() / 1000);
  const skew = Math.abs(nowSec - ts);
  if (skew > config.timestampWindowSec) {
    return { ok: false, reason: `timestamp outside window (${skew}s > ${config.timestampWindowSec}s)` };
  }

  // Recompute the expected signature over the exact same string the boat signed.
  const body = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody);
  const expected = crypto
    .createHmac('sha256', config.sharedKey)
    .update(`${ts}.${body}`)
    .digest('hex');

  // Constant-time compare. timingSafeEqual throws if lengths differ, so guard.
  const provided = String(signature);
  if (provided.length !== expected.length) {
    return { ok: false, reason: 'signature mismatch' };
  }
  const match = crypto.timingSafeEqual(
    Buffer.from(provided, 'utf8'),
    Buffer.from(expected, 'utf8')
  );
  if (!match) {
    return { ok: false, reason: 'signature mismatch' };
  }

  return { ok: true };
}

module.exports = { verify };
