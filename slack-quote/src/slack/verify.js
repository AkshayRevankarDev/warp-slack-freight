import crypto from 'node:crypto';

const VERSION = 'v0';
const MAX_SKEW_SECONDS = 60 * 5; // Slack recommends rejecting anything older than 5 min.

// Slack signs `${version}:${timestamp}:${rawBody}` with HMAC-SHA256, then sends the
// hex digest in `X-Slack-Signature` and the timestamp in `X-Slack-Request-Timestamp`.
// See https://api.slack.com/authentication/verifying-requests-from-slack.
export function verifySlackRequest({ signingSecret, timestamp, signature, rawBody }) {
  if (!signingSecret) return { ok: false, reason: 'no_signing_secret_configured' };
  if (!timestamp || !signature) return { ok: false, reason: 'missing_headers' };

  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return { ok: false, reason: 'bad_timestamp' };
  if (Math.abs(Date.now() / 1000 - ts) > MAX_SKEW_SECONDS) {
    return { ok: false, reason: 'stale_timestamp' };
  }

  const base = `${VERSION}:${timestamp}:${rawBody}`;
  const expected = `${VERSION}=${crypto.createHmac('sha256', signingSecret).update(base).digest('hex')}`;

  // Both hex strings; timing-safe compare requires equal-length buffers.
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  if (a.length !== b.length) return { ok: false, reason: 'length_mismatch' };
  const equal = crypto.timingSafeEqual(a, b);
  return equal ? { ok: true } : { ok: false, reason: 'signature_mismatch' };
}

// Convenience: sign a body the same way Slack does. Used only by the smoke script.
export function signPayload({ signingSecret, timestamp, rawBody }) {
  const base = `${VERSION}:${timestamp}:${rawBody}`;
  return `${VERSION}=${crypto.createHmac('sha256', signingSecret).update(base).digest('hex')}`;
}
