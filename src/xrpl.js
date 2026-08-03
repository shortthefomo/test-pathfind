import { XrplClient } from "xrpl-client";

/**
 * Create a client bound to the given endpoint and wait until ready.
 * @param {string} endpoint
 * @param {object} [options]
 */
export async function connect(endpoint, options = {}) {
  const client = new XrplClient(endpoint, {
    maxConnectionAttempts: options.maxConnectionAttempts ?? 5,
    connectAttemptTimeoutSeconds: options.connectAttemptTimeoutSeconds ?? 5,
    assumeOfflineAfterSeconds: options.assumeOfflineAfterSeconds ?? 30,
    ...options.clientOptions,
  });
  await client.ready();
  return client;
}

/**
 * Send a command and reject on XRPL-level error responses.
 * Note: for path_find (subscription), xrpl-client resolves with the full WS
 * envelope; for ordinary commands it resolves with `result`.
 */
export async function request(client, body, sendOptions = {}) {
  const res = await client.send(body, {
    timeoutSeconds: sendOptions.timeoutSeconds ?? 60,
    ...sendOptions,
  });
  if (res?.error || res?.status === "error" || res?.result?.error) {
    const msg =
      res.error_message ||
      res.error_exception ||
      res.result?.error_message ||
      res.error ||
      res.result?.error ||
      "unknown error";
    const code = res.error || res.result?.error || res.status;
    const err = new Error(`XRPL error (${code}): ${msg}`);
    err.response = res;
    throw err;
  }
  return res;
}

/** Sleep helper. */
export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Fisher–Yates shuffle (in place) and return the array. */
export function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/** Pick a random element. */
export function pick(arr) {
  if (!arr?.length) return undefined;
  return arr[Math.floor(Math.random() * arr.length)];
}

/**
 * Run async work over items with a concurrency cap.
 * @template T,R
 * @param {T[]} items
 * @param {number} concurrency
 * @param {(item: T, index: number) => Promise<R>} fn
 * @returns {Promise<R[]>}
 */
export async function mapPool(items, concurrency, fn) {
  const results = new Array(items.length);
  let next = 0;

  async function worker() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}
