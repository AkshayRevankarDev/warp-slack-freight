import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifySlackRequest, signPayload } from '../src/slack/verify.js';

const SECRET = 'test-secret';

test('accepts a correctly signed request', () => {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const rawBody = 'command=%2Fquote&text=90001+to+60601+1000+lbs';
  const signature = signPayload({ signingSecret: SECRET, timestamp, rawBody });
  const result = verifySlackRequest({ signingSecret: SECRET, timestamp, signature, rawBody });
  assert.equal(result.ok, true);
});

test('rejects a tampered body', () => {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const rawBody = 'command=%2Fquote&text=original';
  const signature = signPayload({ signingSecret: SECRET, timestamp, rawBody });
  const result = verifySlackRequest({ signingSecret: SECRET, timestamp, signature, rawBody: rawBody + '&extra=1' });
  assert.equal(result.ok, false);
});

test('rejects stale timestamps', () => {
  const timestamp = String(Math.floor(Date.now() / 1000) - 60 * 10);
  const rawBody = 'a=b';
  const signature = signPayload({ signingSecret: SECRET, timestamp, rawBody });
  const result = verifySlackRequest({ signingSecret: SECRET, timestamp, signature, rawBody });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'stale_timestamp');
});

test('rejects missing headers', () => {
  const result = verifySlackRequest({ signingSecret: SECRET, timestamp: null, signature: null, rawBody: '' });
  assert.equal(result.ok, false);
});
