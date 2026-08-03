/**
 * Terminal charts for path_find load-test metrics.
 *
 * Burst mode primary: response metrics over wall-clock time during the
 * observe window (update gaps, create latencies, update rates).
 * Legacy: create latency vs open count (still useful for create phase).
 */

import { fmtMs } from "./metrics.js";

/**
 * Line chart of samples ordered by time (x = elapsed ms, y = metric ms or rate).
 *
 * @param {Array<{ tMs: number, ms: number }>} series
 * @param {{ width?: number, height?: number, title?: string, yLabel?: string, xLabel?: string }} [opts]
 */
export function renderTimeSeriesChart(series, opts = {}) {
  const width = opts.width ?? 64;
  const height = opts.height ?? 12;
  const title = opts.title ?? "metric over time";
  const yLabel = opts.yLabel ?? "value";
  const xLabel = opts.xLabel ?? "time";
  /** Format y-axis numbers; default treats values as milliseconds. */
  const fmtY = opts.fmtY ?? fmtMs;

  const points = (series || [])
    .filter(
      (p) =>
        p &&
        p.tMs != null &&
        Number.isFinite(p.tMs) &&
        p.ms != null &&
        Number.isFinite(p.ms) &&
        p.ms >= 0
    )
    .sort((a, b) => a.tMs - b.tMs);

  if (points.length === 0) {
    return `(no samples yet: ${title})`;
  }

  const minT = points[0].tMs;
  const maxT = points[points.length - 1].tMs;
  const maxMs = Math.max(...points.map((p) => p.ms), 1);
  const minMs = 0;

  const cols = Math.min(width, Math.max(points.length, 2));
  const colVals = Array.from({ length: cols }, () => []);
  for (const p of points) {
    const x =
      maxT === minT
        ? 0
        : Math.round(((p.tMs - minT) / (maxT - minT)) * (cols - 1));
    colVals[x].push(p.ms);
  }
  const colAvg = colVals.map((arr) =>
    arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null
  );

  const yOf = (ms) => {
    if (ms == null) return null;
    const t = (ms - minMs) / (maxMs - minMs || 1);
    return Math.max(0, Math.min(height - 1, Math.round(t * (height - 1))));
  };

  const grid = Array.from({ length: height }, () => Array(cols).fill(" "));
  let prevX = null;
  let prevY = null;
  for (let x = 0; x < cols; x++) {
    if (colAvg[x] == null) continue;
    const y = yOf(colAvg[x]);
    grid[y][x] = "●";
    if (prevX != null) {
      const dx = x - prevX;
      const dy = y - prevY;
      const steps = Math.max(Math.abs(dx), Math.abs(dy), 1);
      for (let s = 1; s < steps; s++) {
        const ix = prevX + Math.round((dx * s) / steps);
        const iy = prevY + Math.round((dy * s) / steps);
        if (grid[iy][ix] === " ") grid[iy][ix] = "·";
      }
    }
    prevX = x;
    prevY = y;
  }

  const mean = points.reduce((a, p) => a + p.ms, 0) / points.length;
  const rows = [];
  rows.push(`┌─ ${title}`);
  rows.push(
    `│  y: ${yLabel}  min=${fmtY(Math.min(...points.map((p) => p.ms)))}  max=${fmtY(maxMs)}  mean=${fmtY(mean)}`
  );
  rows.push(
    `│  x: ${xLabel}  ${fmtMs(minT)} → ${fmtMs(maxT)}  (n=${points.length})`
  );

  for (let row = height - 1; row >= 0; row--) {
    let line = "│" + grid[row].join("");
    if (row === height - 1) line += `  ${fmtY(maxMs)}`;
    else if (row === 0) line += `  ${fmtY(minMs)}`;
    else if (row === Math.floor(height / 2)) line += `  ${fmtY(maxMs / 2)}`;
    rows.push(line);
  }

  rows.push("└" + "─".repeat(cols));
  const left = fmtMs(minT);
  const right = fmtMs(maxT);
  const pad = Math.max(0, cols - left.length - right.length);
  rows.push("  " + left + " ".repeat(pad) + right + `  ${xLabel} →`);

  return rows.join("\n");
}

/**
 * Line chart of a sequence of samples ordered by concurrency (open count).
 * Each sample is typically one initial path_find create latency at open# N.
 *
 * @param {Array<{ concurrency: number, ms: number }>} series
 * @param {{ width?: number, height?: number, title?: string, yLabel?: string }} [opts]
 */
export function renderRampLineChart(series, opts = {}) {
  const width = opts.width ?? 64;
  const height = opts.height ?? 14;
  const title = opts.title ?? "path_find CREATE response time vs open count";
  const yLabel = opts.yLabel ?? "response";

  const points = (series || [])
    .filter((p) => p && p.concurrency > 0 && p.ms != null && Number.isFinite(p.ms) && p.ms >= 0)
    .sort((a, b) => a.concurrency - b.concurrency);

  if (points.length === 0) {
    return `(no samples yet: ${title})`;
  }

  const minC = points[0].concurrency;
  const maxC = points[points.length - 1].concurrency;
  const maxMs = Math.max(...points.map((p) => p.ms), 1);
  // floor y at 0 so degradation from baseline is visible
  const minMs = 0;

  // Map each concurrency sample onto an x column (1 point can share a col → avg)
  const cols = Math.min(width, Math.max(points.length, 2));
  const colVals = Array.from({ length: cols }, () => []);
  for (const p of points) {
    const x =
      maxC === minC
        ? 0
        : Math.round(((p.concurrency - minC) / (maxC - minC)) * (cols - 1));
    colVals[x].push(p.ms);
  }
  const colAvg = colVals.map((arr) =>
    arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null
  );

  // y position 0..height-1 for a value (0 = bottom)
  const yOf = (ms) => {
    if (ms == null) return null;
    const t = (ms - minMs) / (maxMs - minMs || 1);
    return Math.max(0, Math.min(height - 1, Math.round(t * (height - 1))));
  };

  const grid = Array.from({ length: height }, () => Array(cols).fill(" "));
  // draw line connecting consecutive non-null columns
  let prevX = null;
  let prevY = null;
  for (let x = 0; x < cols; x++) {
    if (colAvg[x] == null) continue;
    const y = yOf(colAvg[x]);
    grid[y][x] = "●";
    if (prevX != null) {
      // Bresenham-ish connect
      const dx = x - prevX;
      const dy = y - prevY;
      const steps = Math.max(Math.abs(dx), Math.abs(dy), 1);
      for (let s = 1; s < steps; s++) {
        const ix = prevX + Math.round((dx * s) / steps);
        const iy = prevY + Math.round((dy * s) / steps);
        if (grid[iy][ix] === " ") grid[iy][ix] = "·";
      }
    }
    prevX = x;
    prevY = y;
  }

  const rows = [];
  rows.push(`┌─ ${title}`);
  rows.push(
    `│  y: ${yLabel}  min=${fmtMs(Math.min(...points.map((p) => p.ms)))}  max=${fmtMs(maxMs)}  mean=${fmtMs(points.reduce((a, p) => a + p.ms, 0) / points.length)}`
  );
  rows.push(`│  x: open path_finds  ${minC} → ${maxC}  (n=${points.length} creates)`);

  for (let row = height - 1; row >= 0; row--) {
    let line = "│" + grid[row].join("");
    if (row === height - 1) line += `  ${fmtMs(maxMs)}`;
    else if (row === 0) line += `  ${fmtMs(minMs)}`;
    else if (row === Math.floor(height / 2)) line += `  ${fmtMs(maxMs / 2)}`;
    rows.push(line);
  }

  rows.push("└" + "─".repeat(cols));
  const left = String(minC);
  const right = String(maxC);
  const pad = Math.max(0, cols - left.length - right.length);
  rows.push("  " + left + " ".repeat(pad) + right + "  open path_finds →");

  return rows.join("\n");
}

/** @deprecated alias */
export function renderLatencyChart(series, opts = {}) {
  const mapped = (series || []).map((p) => ({
    concurrency: p.concurrency,
    ms: p.avgMs ?? p.ms ?? p.p50Ms,
  }));
  return renderRampLineChart(mapped, opts);
}

/**
 * Compact sparkline for a numeric series in order (e.g. create latencies PF1..N).
 */
export function sparkline(values, width = 40) {
  const blocks = "▁▂▃▄▅▆▇█";
  const vals = (values || []).filter((v) => v != null && Number.isFinite(v));
  if (!vals.length) return "─".repeat(width);
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  // resample to width
  let out = "";
  for (let i = 0; i < width; i++) {
    const idx = Math.min(vals.length - 1, Math.round((i / Math.max(width - 1, 1)) * (vals.length - 1)));
    const v = vals[idx];
    const t = max === min ? 1 : (v - min) / (max - min);
    out += blocks[Math.min(blocks.length - 1, Math.floor(t * (blocks.length - 1)))];
  }
  return out;
}

/**
 * Rolling average of last `window` samples for a smoother degradation view.
 */
export function rollingAverage(series, window = 5) {
  const out = [];
  for (let i = 0; i < series.length; i++) {
    const from = Math.max(0, i - window + 1);
    const slice = series.slice(from, i + 1);
    const avg = slice.reduce((a, p) => a + p.ms, 0) / slice.length;
    out.push({ concurrency: series[i].concurrency, ms: avg });
  }
  return out;
}

/**
 * Table: create response time by open count (+ separate update-interval cols).
 */
export function renderConcurrencyTable(buckets) {
  const lines = [];
  lines.push(
    "open | create ms | create p50 | n_fu | update-gap p50 | update-gap avg | errs"
  );
  lines.push(
    "-----+-----------+------------+------+----------------+----------------+-----"
  );
  for (const b of buckets) {
    if (!b.nInitial && !b.nFollowUps && !b.errors) continue;
    lines.push(
      [
        String(b.concurrency).padStart(4),
        fmtMs(b.initialAvg).padStart(9),
        fmtMs(b.initialP50).padStart(10),
        String(b.nFollowUps ?? 0).padStart(4),
        fmtMs(b.followGapP50).padStart(14),
        fmtMs(b.followGapAvg).padStart(14),
        String(b.errors ?? 0).padStart(4),
      ].join(" | ")
    );
  }
  return lines.join("\n");
}

/**
 * List individual open/closed sessions for drill-down.
 */
export function renderSessionList(sessions, { limit = 50 } = {}) {
  const lines = [];
  lines.push(
    "id       | open# | account          | token        | create ms | #fu | last upd gap | status"
  );
  lines.push(
    "---------+-------+------------------+--------------+-----------+-----+--------------+-------"
  );
  const list = sessions.slice(0, limit);
  for (const s of list) {
    const tok =
      typeof s.destination_amount === "object"
        ? String(s.destination_amount.currency || "").slice(0, 12)
        : "?";
    const init =
      s.initial?.latencyMs != null ? fmtMs(s.initial.latencyMs).padStart(9) : "      n/a";
    const lastGap =
      s.followUps?.length > 0
        ? fmtMs(s.followUps[s.followUps.length - 1].sincePreviousMs).padStart(12)
        : "         n/a";
    const status = s.failed ? "FAIL" : s.closed ? "closed" : s.initial ? "open" : "starting";
    lines.push(
      [
        String(s.sessionId || "").padEnd(8),
        String(s.concurrencyAtStart ?? "?").padStart(5),
        String(s.source || "").slice(0, 16).padEnd(16),
        tok.padEnd(12),
        init,
        String(s.followUps?.length ?? 0).padStart(3),
        lastGap,
        status,
      ].join(" | ")
    );
  }
  if (sessions.length > limit) {
    lines.push(`… ${sessions.length - limit} more (see results JSON)`);
  }
  return lines.join("\n");
}

/**
 * Detail block for one session (individual request drill-down).
 */
export function renderSessionDetail(s) {
  if (!s) return "(session not found)";
  const lines = [];
  lines.push(`══ session ${s.sessionId} ══`);
  lines.push(`  source:      ${s.source}`);
  lines.push(`  destination: ${s.destination}`);
  lines.push(`  open# when created: ${s.concurrencyAtStart}`);
  lines.push(`  destination_amount: ${JSON.stringify(s.destination_amount)}`);
  lines.push(`  send_max: ${JSON.stringify(s.send_max)}`);
  lines.push(
    `  CREATE response: ${
      s.initial
        ? `${fmtMs(s.initial.latencyMs)} (send→first WS reply)  alts=${s.initial.alternatives} paths=${s.initial.pathsComputed} full=${s.initial.fullReply}`
        : "n/a"
    }`
  );
  lines.push(`  async updates (type=path_find): ${s.followUps?.length ?? 0}`);
  const fus = (s.followUps || []).slice(0, 25);
  for (const f of fus) {
    lines.push(
      `    #${f.seq}  +${fmtMs(f.offsetMs)} from create  gap=${fmtMs(f.sincePreviousMs)}  ` +
        `alts=${f.alternatives} paths=${f.pathsComputed} full=${f.fullReply}  open#=${f.openCount ?? "?"}`
    );
  }
  if ((s.followUps?.length || 0) > 25) {
    lines.push(`    … ${s.followUps.length - 25} more updates`);
  }
  if (s.errors?.length) {
    lines.push(`  errors: ${s.errors.length}`);
    for (const e of s.errors.slice(0, 5)) {
      lines.push(`    [${e.phase}] ${e.message}`);
    }
  }
  return lines.join("\n");
}
