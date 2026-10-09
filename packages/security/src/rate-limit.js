// @asynx6/security rate limiter — token-bucket + sliding-window, zero deps.
// Use to throttle model-provider calls, tool invocations, or API endpoints.
//
// Token bucket: burst capacity, refilled at a steady rate. Best for APIs
// that tolerate short bursts (model calls).
//
// Sliding window: max N events in the last windowMs. Best for hard caps
// ("max 100 tool calls per run").
//
// Both are per-key and in-memory; a run lives in one process, so no store
// is needed. Call `reset(key)` between runs.

export class TokenBucket {
  constructor({ capacity, refillPerSec, clock = Date.now } = {}) {
    if (!Number.isFinite(capacity) || capacity <= 0) throw new Error('TokenBucket: capacity must be a positive number');
    if (!Number.isFinite(refillPerSec) || refillPerSec <= 0) throw new Error('TokenBucket: refillPerSec must be a positive number');
    this.capacity = capacity;
    this.refillPerSec = refillPerSec;
    this.clock = clock;
    this.tokens = new Map();
    this.lastRefill = new Map();
  }

  _state(key) {
    const now = this.clock();
    let tokens = this.tokens.get(key);
    let last = this.lastRefill.get(key);
    if (tokens === undefined) { tokens = this.capacity; last = now; }
    // Refill only what elapsed, capped at capacity.
    const elapsed = Math.max(0, (now - last) / 1000);
    tokens = Math.min(this.capacity, tokens + elapsed * this.refillPerSec);
    this.tokens.set(key, tokens);
    this.lastRefill.set(key, now);
    return tokens;
  }

  /** Try to consume `cost` tokens. Returns true if allowed. */
  tryConsume(key, cost = 1) {
    const tokens = this._state(key);
    if (tokens >= cost) {
      this.tokens.set(key, tokens - cost);
      return true;
    }
    return false;
  }

  /** Wait (ms) until `cost` tokens are available, or 0 if allowed now. */
  waitMs(key, cost = 1) {
    const tokens = this._state(key);
    if (tokens >= cost) return 0;
    const deficit = cost - tokens;
    return Math.ceil((deficit / this.refillPerSec) * 1000);
  }

  /** Tokens available for `key` right now (fractional). */
  available(key) {
    return this._state(key);
  }

  reset(key) {
    this.tokens.delete(key);
    this.lastRefill.delete(key);
  }

  resetAll() {
    this.tokens.clear();
    this.lastRefill.clear();
  }
}

export class SlidingWindow {
  constructor({ max, windowMs, clock = Date.now } = {}) {
    if (!Number.isFinite(max) || max <= 0) throw new Error('SlidingWindow: max must be a positive number');
    if (!Number.isFinite(windowMs) || windowMs <= 0) throw new Error('SlidingWindow: windowMs must be a positive number');
    this.max = max;
    this.windowMs = windowMs;
    this.clock = clock;
    this.hits = new Map();
  }

  /** Record a hit and return whether it is allowed under the window cap. */
  tryHit(key) {
    const now = this.clock();
    const cutoff = now - this.windowMs;
    const arr = this.hits.get(key) ?? [];
    // Drop stale entries on every call so the array never grows unbounded.
    const fresh = [];
    for (const t of arr) {
      if (t > cutoff) fresh.push(t);
    }
    fresh.push(now);
    this.hits.set(key, fresh);
    return fresh.length <= this.max;
  }

  /** Count of hits in the current window for `key`. */
  count(key) {
    const now = this.clock();
    const cutoff = now - this.windowMs;
    const arr = this.hits.get(key) ?? [];
    let c = 0;
    for (const t of arr) {
      if (t > cutoff) c++;
    }
    return c;
  }

  reset(key) { this.hits.delete(key); }
  resetAll() { this.hits.clear(); }
}

/** Thrown when a limit is exceeded so callers can distinguish it from other errors. */
export class RateLimitError extends Error {
  constructor(message, { key, limit, retryAfterMs } = {}) {
    super(message);
    this.name = 'RateLimitError';
    this.key = key;
    this.limit = limit;
    this.retryAfterMs = retryAfterMs;
  }
}
