const crypto = require("crypto");

/**
 * What every connector shares: outbound HTTP with a timeout and retries, and
 * constant-time signature checks for incoming webhooks.
 */

class ProviderError extends Error {
  constructor(message, { status = null, retryable = false } = {}) {
    super(message);
    this.status = status;
    this.retryable = retryable;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * fetch + JSON with a per-attempt timeout. Network failures, 429 and 5xx are
 * retried with exponential backoff (0.5s, 1s, 2s…); a 4xx is the provider's
 * answer and comes back at once. Never puts credentials in error messages.
 */
async function requestJson(url, { method = "GET", headers = {}, body, timeoutMs = 10000, retries = 2 } = {}) {
  let attempt = 0;
  for (;;) {
    try {
      const res = await fetch(url, {
        method,
        headers: { Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}), ...headers },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await res.text();
      let data = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        data = null;
      }
      if (res.ok) return { status: res.status, data };
      const retryable = res.status === 429 || res.status >= 500;
      if (retryable && attempt < retries) throw new ProviderError(`HTTP ${res.status}`, { status: res.status, retryable });
      return { status: res.status, data };
    } catch (error) {
      const retryable = error instanceof ProviderError ? error.retryable : true; // timeouts and network errors
      if (!retryable || attempt >= retries) {
        if (error instanceof ProviderError) throw error;
        const timedOut = error.name === "TimeoutError" || error.name === "AbortError";
        throw new ProviderError(timedOut ? "The provider did not answer in time." : "Could not reach the provider.", {
          retryable: true,
        });
      }
      await sleep(500 * 2 ** attempt);
      attempt += 1;
    }
  }
}

/** HMAC-SHA256 of the raw request body, hex. */
const hmacHex = (secret, raw) => crypto.createHmac("sha256", secret).update(raw ?? "").digest("hex");

/** Compares two strings in constant time; false when either is missing. */
function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

module.exports = { requestJson, hmacHex, safeEqual, ProviderError };
