/** Lightweight stats helpers for latency / path-result measurement. */

export function percentile(sorted, p) {
  if (!sorted.length) return null;
  if (sorted.length === 1) return sorted[0];
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  const w = idx - lo;
  return sorted[lo] * (1 - w) + sorted[hi] * w;
}

export function summarizeNumbers(values) {
  if (!values.length) {
    return { count: 0, min: null, max: null, mean: null, p50: null, p95: null, p99: null };
  }
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    count: sorted.length,
    min: sorted[0],
    max: sorted[sorted.length - 1],
    mean: sum / sorted.length,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
  };
}

/**
 * Count path alternatives and nested paths_computed entries.
 * Accepts either a raw path_find payload or a full WS envelope `{ result, type, ... }`
 * (xrpl-client resolves path_find create with the full envelope).
 */
export function countPathResults(message) {
  const body =
    message &&
    typeof message === "object" &&
    message.result &&
    message.alternatives === undefined
      ? message.result
      : message;

  const alternatives = Array.isArray(body?.alternatives) ? body.alternatives : [];
  let pathsComputed = 0;
  for (const alt of alternatives) {
    if (Array.isArray(alt?.paths_computed)) {
      pathsComputed += alt.paths_computed.length;
    }
  }
  return {
    alternatives: alternatives.length,
    pathsComputed,
    fullReply: Boolean(body?.full_reply),
  };
}

export function fmtMs(ms) {
  if (ms == null || Number.isNaN(ms)) return "n/a";
  if (ms < 1000) return `${ms.toFixed(1)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

export function fmtStats(label, stats) {
  if (!stats || stats.count === 0) return `${label}: (no samples)`;
  return (
    `${label}: n=${stats.count} ` +
    `min=${fmtMs(stats.min)} p50=${fmtMs(stats.p50)} ` +
    `p95=${fmtMs(stats.p95)} p99=${fmtMs(stats.p99)} max=${fmtMs(stats.max)} ` +
    `mean=${fmtMs(stats.mean)}`
  );
}
