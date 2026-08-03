export async function getHealth() {
  const r = await fetch("/api/health");
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export async function listRuns() {
  const r = await fetch("/api/runs");
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export async function getRun(id) {
  const r = await fetch(`/api/runs/${id}`);
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export async function startRun(body) {
  const r = await fetch("/api/runs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || r.statusText);
  return data;
}

export async function compareRuns(ids) {
  const r = await fetch(`/api/compare?ids=${ids.map(encodeURIComponent).join(",")}`);
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

/**
 * Subscribe to SSE progress for a run.
 * @returns {() => void} unsubscribe / close
 */
export function watchRun(id, onEvent) {
  const es = new EventSource(`/api/runs/${id}/events`);
  es.onmessage = (ev) => {
    try {
      const payload = JSON.parse(ev.data);
      onEvent(payload);
    } catch {
      /* ignore */
    }
  };
  es.onerror = () => {
    // browser will retry; surface soft error
    onEvent({ type: "sse_error" });
  };
  return () => es.close();
}

export function fmtMs(ms) {
  if (ms == null || Number.isNaN(ms)) return "—";
  if (ms < 1000) return `${ms.toFixed(0)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}

export function fmtPct(r) {
  if (r == null || Number.isNaN(r)) return "—";
  return `${(r * 100).toFixed(1)}%`;
}

export const RUN_COLORS = [
  "#38bdf8",
  "#fbbf24",
  "#a78bfa",
  "#34d399",
  "#f472b6",
  "#fb923c",
  "#2dd4bf",
  "#e879f9",
];

/** Stable-ish HSL color for a session index (overlay many lines). */
export function sessionColor(i, total = 1, alpha = 0.85) {
  const hue = Math.round((i * 137.508) % 360); // golden-angle spread
  const light = 55 + (i % 3) * 6;
  return `hsla(${hue}, 72%, ${light}%, ${alpha})`;
}

/**
 * Build Chart.js datasets that overlay every path_find session's update gaps.
 * @param {{ tMs?: number[], sessions?: Array<{ sessionId: string, values: (number|null)[] }> }} perSession
 */
export function buildPerSessionOverlay(perSession) {
  const tMs = perSession?.tMs || [];
  const sessions = perSession?.sessions || [];
  if (!tMs.length || !sessions.length) {
    return { labels: [], datasets: [], sessionCount: 0 };
  }
  const t0 = tMs[0];
  const labels = tMs.map((t) => ((t - t0) / 1000).toFixed(0) + "s");
  const n = sessions.length;
  const showLegend = n <= 16;
  const datasets = sessions.map((s, i) => ({
    label: s.sessionId,
    data: s.values,
    borderColor: sessionColor(i, n, n > 40 ? 0.45 : 0.85),
    backgroundColor: "transparent",
    borderWidth: n > 80 ? 0.8 : n > 30 ? 1.1 : 1.5,
    pointRadius: 0,
    pointHoverRadius: 3,
    tension: 0.2,
    spanGaps: true,
    fill: false,
  }));
  return { labels, datasets, sessionCount: n, showLegend };
}
