// Thin client for the Warp freight API. Two things it does that a naive fetch doesn't:
//   1. Retries transient 429/503 responses, honoring Retry-After (capped).
//   2. Wraps every error in a WarpError so callers can distinguish user-facing
//      problems (bad zip, no rates) from operational ones (upstream down).

const MAX_RETRIES = 2;
const MAX_RETRY_AFTER_MS = 5_000;
const DEFAULT_TIMEOUT_MS = 20_000; // slightly above the mock's 16s worst case

export class WarpError extends Error {
  constructor(message, { status, code, retriable = false, cause } = {}) {
    super(message);
    this.name = 'WarpError';
    this.status = status ?? null;
    this.code = code ?? null;
    this.retriable = retriable;
    if (cause) this.cause = cause;
  }
}

export class WarpClient {
  constructor({ baseUrl, apiKey, fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    if (!baseUrl) throw new Error('WarpClient: baseUrl is required');
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.apiKey = apiKey || 'mock';
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  async request(path, { method = 'GET', body, query, retries = MAX_RETRIES } = {}) {
    const url = new URL(this.baseUrl + path);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
      }
    }
    const init = {
      method,
      headers: {
        'apikey': this.apiKey,
        'Accept': 'application/json',
      },
    };
    if (body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }

    let attempt = 0;
    // Retry loop: only 429/503 are retried, and only up to `retries` times.
    for (;;) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      let res;
      try {
        res = await this.fetch(url, { ...init, signal: controller.signal });
      } catch (e) {
        clearTimeout(timer);
        if (e.name === 'AbortError') {
          throw new WarpError(`Upstream timed out after ${this.timeoutMs}ms`, {
            status: 504, code: 'timeout', retriable: false, cause: e,
          });
        }
        throw new WarpError(`Network error: ${e.message}`, {
          status: 0, code: 'network_error', retriable: false, cause: e,
        });
      }
      clearTimeout(timer);

      if (res.ok) {
        // Some endpoints (documents/invoices) return objects; some (tracking) arrays. Either is fine.
        return res.json();
      }

      const isRetriable = res.status === 429 || res.status === 503;
      const bodyText = await res.text().catch(() => '');
      let payload = null;
      try { payload = bodyText ? JSON.parse(bodyText) : null; } catch { /* not json */ }

      if (isRetriable && attempt < retries) {
        const wait = retryAfterMs(res.headers.get('Retry-After'), attempt);
        await sleep(wait);
        attempt++;
        continue;
      }

      throw new WarpError(
        payload?.message || `Warp API error (${res.status})`,
        { status: res.status, code: payload?.code || null, retriable: isRetriable },
      );
    }
  }

  // --- endpoint wrappers -------------------------------------------------

  rateShop(body) {
    return this.request('/freights/freight-quote', { method: 'POST', body });
  }
  singleQuote(body) {
    return this.request('/freights/quote', { method: 'POST', body });
  }
  tracking(trackingNumbers) {
    return this.request('/freights/tracking', { method: 'POST', body: { trackingNumbers } });
  }
  shipments({ page = 1, pageSize = 5 } = {}) {
    return this.request('/freights/shipments', { query: { page, pageSize } });
  }
  events(shipmentId) {
    return this.request(`/freights/events/${encodeURIComponent(shipmentId)}`);
  }
  documents(orderId) {
    return this.request(`/freights/documents/${encodeURIComponent(orderId)}`);
  }
  invoice(orderId) {
    return this.request(`/freights/invoices/${encodeURIComponent(orderId)}`);
  }
}

function retryAfterMs(header, attempt) {
  // Retry-After may be seconds (integer) or an HTTP-date. We only care about seconds
  // in practice — the mock sends "2" or "3". Fall back to exponential backoff.
  const parsed = Number(header);
  if (Number.isFinite(parsed) && parsed >= 0) {
    return Math.min(parsed * 1000, MAX_RETRY_AFTER_MS);
  }
  return Math.min(500 * 2 ** attempt, MAX_RETRY_AFTER_MS);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
