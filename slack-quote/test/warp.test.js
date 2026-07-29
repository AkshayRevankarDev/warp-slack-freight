import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WarpClient, WarpError } from '../src/warp.js';

// Small helper that returns a fake fetch driven by a scripted list of responses.
function scriptedFetch(steps) {
  let i = 0;
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url: url.toString(), init });
    const step = steps[i++] || steps[steps.length - 1];
    if (typeof step === 'function') return step({ url, init });
    return step;
  };
  fn.calls = calls;
  return fn;
}

function makeRes({ status = 200, body = {}, headers = {} } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => headers[k.toLowerCase()] ?? headers[k] ?? null },
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    json: async () => (typeof body === 'string' ? JSON.parse(body) : body),
  };
}

test('happy path returns parsed json', async () => {
  const fetchImpl = scriptedFetch([makeRes({ body: { ok: true } })]);
  const c = new WarpClient({ baseUrl: 'http://x', fetchImpl });
  const out = await c.request('/whatever');
  assert.deepEqual(out, { ok: true });
});

test('retries 503 with Retry-After and eventually succeeds', async () => {
  const fetchImpl = scriptedFetch([
    makeRes({ status: 503, body: { code: 'upstream_unavailable', message: 'nope' }, headers: { 'Retry-After': '0' } }),
    makeRes({ status: 503, body: { code: 'upstream_unavailable', message: 'nope' }, headers: { 'Retry-After': '0' } }),
    makeRes({ body: { ok: true } }),
  ]);
  const c = new WarpClient({ baseUrl: 'http://x', fetchImpl });
  const out = await c.request('/x');
  assert.deepEqual(out, { ok: true });
  assert.equal(fetchImpl.calls.length, 3);
});

test('gives up after MAX_RETRIES with a WarpError carrying code/status', async () => {
  const fetchImpl = scriptedFetch([
    makeRes({ status: 429, body: { code: 'rate_limit_exceeded', message: 'slow down' }, headers: { 'Retry-After': '0' } }),
  ]);
  const c = new WarpClient({ baseUrl: 'http://x', fetchImpl });
  await assert.rejects(c.request('/x'), (e) => {
    assert.ok(e instanceof WarpError);
    assert.equal(e.status, 429);
    assert.equal(e.code, 'rate_limit_exceeded');
    return true;
  });
});

test('does not retry a 400', async () => {
  const fetchImpl = scriptedFetch([
    makeRes({ status: 400, body: { code: 'required_field_missing', message: 'pickupDate' } }),
  ]);
  const c = new WarpClient({ baseUrl: 'http://x', fetchImpl });
  await assert.rejects(c.request('/x'), (e) => e instanceof WarpError && e.status === 400);
  assert.equal(fetchImpl.calls.length, 1);
});

test('timeout maps to WarpError with status 504', async () => {
  const fetchImpl = async (_url, { signal }) => {
    return new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => {
        const err = new Error('aborted');
        err.name = 'AbortError';
        reject(err);
      });
    });
  };
  const c = new WarpClient({ baseUrl: 'http://x', fetchImpl, timeoutMs: 10 });
  await assert.rejects(c.request('/x'), (e) => e instanceof WarpError && e.status === 504);
});
