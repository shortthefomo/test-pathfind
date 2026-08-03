/**
 * path_find load test:
 *
 * Burst:
 *   1. Open all path_finds at once
 *   2. Wait until sessions emit async updates
 *   3. Hold for observeMs
 *   4. Close all at once
 *
 * Ramp:
 *   1. Ramp up: +1 path_find every addIntervalMs until maxConcurrency
 *   2. Wait until sessions emit async updates
 *   3. Hold at cap for observeMs
 *   4. Ramp down: close one path_find every addIntervalMs until none remain
 *
 * Final report includes create latencies, time-series of update gaps, and
 * individual session drill-down.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import readline from "node:readline";
import { DEFAULTS, parseArgs, resolveConfig } from "./config.js";
import { loadWallets } from "./discover-wallets.js";
import { startPathFindWorker } from "./pathfind-worker.js";
import { summarizeNumbers, fmtStats, fmtMs } from "./metrics.js";
import { sleep, shuffle } from "./xrpl.js";
import {
  renderRampLineChart,
  renderTimeSeriesChart,
  renderConcurrencyTable,
  renderSessionList,
  renderSessionDetail,
  sparkline,
} from "./chart.js";

function formatAmount(amt) {
  if (amt == null) return "n/a";
  if (typeof amt === "string") return `${amt} drops`;
  if (typeof amt === "object") {
    const cur = String(amt.currency || "").slice(0, 12);
    const iss = String(amt.issuer || "").slice(0, 8);
    return `${cur}/${iss}…=${amt.value}`;
  }
  return String(amt);
}

/**
 * Round-robin wallets + rotate through their funded trustline samples so we
 * keep drawing addresses/assets from the pool as concurrency grows.
 */
function createAssignmentCursor(wallets) {
  const order = shuffle([...wallets]);
  let i = 0;
  // Per-account token rotation offset so reuses pick different assets
  const tokenIdx = new Map();

  return {
    next() {
      const wallet = order[i % order.length];
      i++;
      const lines = (wallet.fundedTrustlines || []).filter(
        (l) => l?.currency && l?.account && Number(l.balance) > 0
      );
      const pool = lines.length ? lines : wallet.fundedTrustlines || [];
      const ti = tokenIdx.get(wallet.account) || 0;
      tokenIdx.set(wallet.account, ti + 1);
      // Rotate fundedTrustlines order so pickPathFindCandidates sees variety
      if (pool.length > 1) {
        const rotated = [
          ...pool.slice(ti % pool.length),
          ...pool.slice(0, ti % pool.length),
        ];
        return {
          source: { ...wallet, fundedTrustlines: rotated },
          dest: { ...wallet, fundedTrustlines: rotated },
        };
      }
      return { source: wallet, dest: wallet };
    },
  };
}

/**
 * Ordered create-response samples: one point per successful path_find create.
 */
export function createResponseSeries(timeline) {
  return timeline
    .filter((e) => e.type === "initial" && e.latencyMs != null)
    .map((e, i) => ({
      concurrency: e.concurrencyAtStart ?? e.openCount ?? i + 1,
      ms: e.latencyMs,
      sessionId: e.sessionId,
      tMs: e.t ?? null,
    }))
    .filter((p) => p.ms != null)
    .sort((a, b) => {
      if (a.tMs != null && b.tMs != null) return a.tMs - b.tMs;
      return String(a.sessionId).localeCompare(String(b.sessionId));
    });
}

/**
 * Create latencies as a time series (burst phase completion order).
 */
export function createLatencyOverTime(timeline) {
  return timeline
    .filter((e) => e.type === "initial" && e.latencyMs != null && e.t != null)
    .map((e) => ({ tMs: e.t, ms: e.latencyMs, sessionId: e.sessionId }))
    .sort((a, b) => a.tMs - b.tMs);
}

/**
 * Async update intervals over wall-clock time.
 * Optionally restrict to events at or after sinceT (run-relative ms).
 */
/**
 * Async update→update gaps over wall-clock time.
 * Skips the first follow-up per session (create → first update): that gap is
 * not a refresh interval and dwarfs real update cadence under load.
 */
export function updateGapOverTime(timeline, { sinceT = 0 } = {}) {
  return timeline
    .filter(
      (e) =>
        e.type === "follow_up" &&
        e.sincePreviousMs != null &&
        e.t != null &&
        e.t >= sinceT &&
        // seq 1 = first async update after create; only plot true refresh gaps
        (e.seq == null || e.seq > 1)
    )
    .map((e) => ({
      tMs: e.t,
      ms: e.sincePreviousMs,
      sessionId: e.sessionId,
    }))
    .sort((a, b) => a.tMs - b.tMs);
}

/** Default time-bucket width for update-gap / throughput series. */
export const UPDATE_BUCKET_MS = 3_000;

/**
 * Per-path_find update-gap series (3s buckets), aligned on a shared time axis
 * so the UI can overlay every session on one chart.
 *
 * @returns {{ tMs: number[], sessions: Array<{ sessionId: string, values: (number|null)[] }> }}
 */
export function perSessionUpdateGaps(
  timeline,
  { sinceT = 0, bucketMs = UPDATE_BUCKET_MS } = {}
) {
  const bySession = new Map();
  for (const e of timeline) {
    if (e.type !== "follow_up" || e.sincePreviousMs == null || e.t == null) continue;
    if (e.t < sinceT) continue;
    // Skip create → first update; only bucket true path_find refresh gaps
    if (e.seq != null && e.seq <= 1) continue;
    const id = e.sessionId || "?";
    if (!bySession.has(id)) bySession.set(id, []);
    bySession.get(id).push({ tMs: e.t, ms: e.sincePreviousMs });
  }
  if (!bySession.size) return { tMs: [], sessions: [] };

  // Shared bucket grid from global min/max across all sessions
  let minT = Infinity;
  let maxT = -Infinity;
  for (const pts of bySession.values()) {
    for (const p of pts) {
      if (p.tMs < minT) minT = p.tMs;
      if (p.tMs > maxT) maxT = p.tMs;
    }
  }
  const tMs = [];
  for (let t = Math.floor(minT / bucketMs) * bucketMs; t <= maxT; t += bucketMs) {
    tMs.push(t);
  }
  if (!tMs.length) tMs.push(minT);

  const tIndex = new Map(tMs.map((t, i) => [t, i]));
  const sessions = [...bySession.entries()]
    .sort((a, b) => String(a[0]).localeCompare(String(b[0])))
    .map(([sessionId, pts]) => {
      const buckets = Array.from({ length: tMs.length }, () => []);
      for (const p of pts) {
        const b = Math.floor(p.tMs / bucketMs) * bucketMs;
        // snap to nearest grid key that exists
        let idx = tIndex.get(b);
        if (idx == null) {
          // find closest
          let best = 0;
          let bestD = Infinity;
          for (let i = 0; i < tMs.length; i++) {
            const d = Math.abs(tMs[i] - p.tMs);
            if (d < bestD) {
              bestD = d;
              best = i;
            }
          }
          idx = best;
        }
        buckets[idx].push(p.ms);
      }
      const values = buckets.map((arr) =>
        arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null
      );
      return { sessionId, values };
    });

  return { tMs, sessions };
}

/**
 * Bucketed mean update gap over time (for smoother charts).
 * @param {Array<{ tMs: number, ms: number }>} series
 * @param {number} bucketMs
 */
export function bucketTimeSeries(series, bucketMs = UPDATE_BUCKET_MS) {
  if (!series?.length) return [];
  const minT = series[0].tMs;
  const map = new Map();
  for (const p of series) {
    const b = Math.floor((p.tMs - minT) / bucketMs) * bucketMs + minT;
    if (!map.has(b)) map.set(b, []);
    map.get(b).push(p.ms);
  }
  return [...map.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([tMs, vals]) => {
      const s = summarizeNumbers(vals);
      return { tMs, ms: s.mean, p50: s.p50, n: s.count };
    });
}

/**
 * Updates-per-second rate over time (bucketed).
 * Rate is stored in `ms` so the shared chart renderer can plot it.
 */
export function updateRateOverTime(timeline, { sinceT = 0, bucketMs = UPDATE_BUCKET_MS } = {}) {
  const events = timeline.filter(
    (e) => e.type === "follow_up" && e.t != null && e.t >= sinceT
  );
  if (!events.length) return [];
  const minT = Math.min(...events.map((e) => e.t));
  const map = new Map();
  for (const e of events) {
    const b = Math.floor((e.t - minT) / bucketMs) * bucketMs + minT;
    map.set(b, (map.get(b) || 0) + 1);
  }
  return [...map.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([tMs, count]) => ({
      tMs,
      ms: count / (bucketMs / 1000),
      n: count,
    }));
}

/**
 * Async update intervals bucketed by open count (legacy helper).
 */
export function updateIntervalSeries(timeline) {
  const byOpen = new Map();
  for (const e of timeline) {
    if (e.type !== "follow_up" || e.sincePreviousMs == null) continue;
    const c = e.openCount || 0;
    if (!c) continue;
    if (!byOpen.has(c)) byOpen.set(c, []);
    byOpen.get(c).push(e.sincePreviousMs);
  }
  return [...byOpen.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([concurrency, gaps]) => {
      const s = summarizeNumbers(gaps);
      return {
        concurrency,
        ms: s.mean,
        p50: s.p50,
        n: s.count,
      };
    });
}

/**
 * Aggregate create + update stats for the whole run (single peak bucket).
 */
export function bucketByConcurrency(timeline, maxConcurrency) {
  const map = new Map();
  map.set(maxConcurrency, {
    concurrency: maxConcurrency,
    initials: [],
    followGaps: [],
    errors: 0,
  });

  for (const ev of timeline) {
    if (ev.type === "initial" && ev.latencyMs != null) {
      map.get(maxConcurrency).initials.push(ev.latencyMs);
    } else if (ev.type === "follow_up" && ev.sincePreviousMs != null) {
      map.get(maxConcurrency).followGaps.push(ev.sincePreviousMs);
    } else if (ev.type === "error") {
      map.get(maxConcurrency).errors++;
    }
  }

  return [...map.values()]
    .filter((b) => b.initials.length || b.followGaps.length || b.errors)
    .map((b) => {
      const init = summarizeNumbers(b.initials);
      const gap = summarizeNumbers(b.followGaps);
      return {
        concurrency: b.concurrency,
        nInitial: init.count,
        initialAvg: init.mean,
        initialP50: init.p50,
        initialP95: init.p95,
        nFollowUps: gap.count,
        followGapAvg: gap.mean,
        followGapP50: gap.p50,
        followGapP95: gap.p95,
        errors: b.errors,
      };
    });
}

function countReadyWorkers(workers) {
  return workers.filter(
    (w) =>
      w.state.initial &&
      !w.state.closed &&
      !w.state.failed &&
      (w.state.followUps?.length || 0) > 0
  ).length;
}

function countOpenWorkers(workers) {
  return workers.filter(
    (w) => w.state.initial && !w.state.closed && !w.state.failed
  ).length;
}

function printBurstProgress({ workers, maxConcurrency, timeline }) {
  const open = countOpenWorkers(workers);
  const ready = countReadyWorkers(workers);
  const fail = workers.filter((w) => w.state.failed).length;
  const pending = workers.length - open - fail;
  const creates = createResponseSeries(timeline);
  const initLats = creates.map((c) => c.ms);

  console.log("\n" + "═".repeat(72));
  console.log(
    ` BURST  opened=${open}/${maxConcurrency}  ready(updating)=${ready}/${open || maxConcurrency}  ` +
      `failed=${fail}  starting=${Math.max(0, pending)}  events=${timeline.length}`
  );
  if (initLats.length) {
    console.log(` ${fmtStats("create latencies", summarizeNumbers(initLats))}`);
    console.log(` create sparkline: ${sparkline(initLats, 48)}`);
  }
  const tail = timeline
    .filter((e) => e.type === "initial" || e.type === "error")
    .slice(-5);
  for (const e of tail) {
    if (e.type === "initial") {
      console.log(
        `  · [${e.sessionId}] CREATE ${fmtMs(e.latencyMs)}  ` +
          `alts=${e.alternatives} dest=${formatAmount(e.destination_amount)}`
      );
    } else {
      console.log(`  · [${e.sessionId}] ERR ${e.message}`);
    }
  }
  console.log("═".repeat(72));
}

function printObserveDashboard({
  workers,
  maxConcurrency,
  timeline,
  observeStartT,
  observeMs,
  runStartedAt,
}) {
  const open = countOpenWorkers(workers);
  const ready = countReadyWorkers(workers);
  const fail = workers.filter((w) => w.state.failed).length;
  const elapsedObserve = Date.now() - runStartedAt - observeStartT;
  const remain = Math.max(0, observeMs - elapsedObserve);

  console.log("\n" + "═".repeat(72));
  console.log(
    ` OBSERVE  open=${open}/${maxConcurrency}  updating=${ready}  failed=${fail}  ` +
      `elapsed=${fmtMs(elapsedObserve)}  remain=${fmtMs(remain)}  events=${timeline.length}`
  );

  const gaps = updateGapOverTime(timeline, { sinceT: observeStartT });
  const bucketed = bucketTimeSeries(gaps, UPDATE_BUCKET_MS);
  if (bucketed.length) {
    console.log(
      renderTimeSeriesChart(bucketed, {
        title: "async UPDATE gap over time (mean per 3s bucket)",
        yLabel: "upd gap",
        xLabel: "run time",
        width: 60,
        height: 12,
      })
    );
  } else if (gaps.length) {
    console.log(
      renderTimeSeriesChart(gaps, {
        title: "async UPDATE gap over time",
        yLabel: "upd gap",
        xLabel: "run time",
        width: 60,
        height: 12,
      })
    );
  } else {
    console.log("(waiting for async path_find updates…)");
  }

  const rates = updateRateOverTime(timeline, {
    sinceT: observeStartT,
    bucketMs: UPDATE_BUCKET_MS,
  });
  if (rates.length) {
    const fmtRate = (v) =>
      v == null || Number.isNaN(v) ? "n/a" : `${Number(v).toFixed(1)}/s`;
    console.log(
      renderTimeSeriesChart(rates, {
        title: "update throughput over time (updates/sec, 3s buckets)",
        yLabel: "upd/s",
        xLabel: "run time",
        width: 60,
        height: 8,
        fmtY: fmtRate,
      })
    );
  }

  const gapVals = gaps.map((g) => g.ms);
  if (gapVals.length) {
    console.log(
      ` ${fmtStats("update gaps (observe window)", summarizeNumbers(gapVals))}`
    );
    console.log(` update-gap sparkline: ${sparkline(gapVals, 48)}`);
  }

  const noUpdate = workers.filter(
    (w) =>
      w.state.initial &&
      !w.state.failed &&
      !w.state.closed &&
      !(w.state.followUps?.length)
  );
  if (noUpdate.length) {
    console.log(
      ` still silent (0 updates): ${noUpdate
        .slice(0, 8)
        .map((w) => w.sessionId)
        .join(", ")}${noUpdate.length > 8 ? ` +${noUpdate.length - 8}` : ""}`
    );
  }
  console.log("═".repeat(72));
}

/**
 * Build a compact UI/SSE snapshot from live workers + timeline.
 */
export function buildProgressSnapshot({
  phase,
  workers,
  timeline,
  maxConcurrency,
  observeMs,
  runStartedAt,
  observeStartT = null,
  phases = {},
  message = null,
  mode = "burst",
  addIntervalMs = 0,
}) {
  const open = countOpenWorkers(workers);
  const ready = countReadyWorkers(workers);
  const failed = workers.filter((w) => w.state.failed).length;
  const elapsedMs = Date.now() - runStartedAt;
  const createLatencies = createLatencyOverTime(timeline);
  // Full-run series so UI can shade the observe window against ramp up/down.
  const gapBuckets = bucketTimeSeries(
    updateGapOverTime(timeline, { sinceT: 0 }),
    UPDATE_BUCKET_MS
  ).map((b) => ({ tMs: b.tMs, ms: b.ms, n: b.n }));
  const updateRateBuckets = updateRateOverTime(timeline, {
    sinceT: 0,
    bucketMs: UPDATE_BUCKET_MS,
  }).map((b) => ({ tMs: b.tMs, rate: b.ms, n: b.n }));
  const perSessionGaps = perSessionUpdateGaps(timeline, {
    sinceT: 0,
    bucketMs: UPDATE_BUCKET_MS,
  });

  let observeElapsedMs = null;
  let observeRemainMs = null;
  if (observeStartT != null && phase === "observe") {
    observeElapsedMs = Math.max(0, elapsedMs - observeStartT);
    observeRemainMs = Math.max(0, observeMs - observeElapsedMs);
  }

  const observeEndT =
    observeStartT != null && observeMs != null
      ? observeStartT + observeMs
      : null;

  return {
    phase,
    mode,
    addIntervalMs,
    maxConcurrency,
    observeMs,
    observeStartT,
    observeEndT,
    opened: open,
    failed,
    ready,
    open,
    elapsedMs,
    observeElapsedMs,
    observeRemainMs,
    createLatencies: createLatencies.map((p) => ({
      tMs: p.tMs,
      ms: p.ms,
      sessionId: p.sessionId,
    })),
    updateGapBuckets: gapBuckets,
    updateRateBuckets,
    perSessionGaps,
    phases,
    message,
  };
}

/**
 * Compact summary for UI history + comparison (no fullReply blobs).
 */
export function summarizeRunForUi(run, { id, label, status = "done" } = {}) {
  const report = run.report || buildReport(run);
  const createVals = (report.createLatencyOverTime || report.createLatencies || [])
    .map((p) => p.ms)
    .filter((v) => v != null);
  const gapVals = (report.updateGapOverTime || [])
    .map((p) => p.ms)
    .filter((v) => v != null);
  const rateVals = (report.updateRateOverTime || [])
    .map((p) => p.ms)
    .filter((v) => v != null);
  const createStats = summarizeNumbers(createVals);
  const gapStats = summarizeNumbers(gapVals);
  const rateStats = summarizeNumbers(rateVals);
  const opened = report.openFinal ?? run.sessions?.filter((s) => s.initial && !s.failed).length ?? 0;
  const failed = report.failed ?? run.sessions?.filter((s) => s.failed).length ?? 0;
  const maxConcurrency = run.maxConcurrency ?? report.maxConcurrency ?? 0;

  const observeStartT = run.observeStartT ?? report.observeStartT ?? null;
  const observeMs = run.observeMs ?? report.observeMs ?? null;
  const observeEndT =
    observeStartT != null && observeMs != null
      ? observeStartT + observeMs
      : null;

  return {
    id: id || run.id || null,
    label:
      label ||
      run.label ||
      `${maxConcurrency} open · ${fmtMs(observeMs)}`,
    status,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    config: {
      maxConcurrency,
      mode: run.mode ?? report.mode ?? "burst",
      addIntervalMs: run.addIntervalMs ?? report.addIntervalMs ?? 0,
      observeMs,
      readyTimeoutMs: run.readyTimeoutMs ?? report.readyTimeoutMs,
      endpoint: run.endpoint ?? report.endpoint,
    },
    observeStartT,
    observeEndT,
    phases: run.phases || report.phases || {},
    stats: {
      opened,
      failed,
      successRate: maxConcurrency > 0 ? opened / maxConcurrency : 0,
      create: {
        mean: createStats.mean,
        p50: createStats.p50,
        p95: createStats.p95,
        max: createStats.max,
        count: createStats.count,
      },
      updateGap: {
        mean: gapStats.mean,
        p50: gapStats.p50,
        p95: gapStats.p95,
        max: gapStats.max,
        count: gapStats.count,
      },
      updateRateMean: rateStats.mean,
    },
    series: {
      // Full-run series (for observe-window shading on charts). Stats above
      // still use observe-window-only series from the report.
      createOverTime: (report.createLatencyOverTime || []).map((p) => ({
        tMs: p.tMs,
        ms: p.ms,
        sessionId: p.sessionId,
      })),
      updateGapBuckets: (report.updateGapBucketsFull || report.updateGapBuckets || []).map(
        (p) => ({
          tMs: p.tMs,
          ms: p.ms,
          n: p.n,
        })
      ),
      updateRateBuckets: (
        report.updateRateOverTimeFull ||
        report.updateRateOverTime ||
        []
      ).map((p) => ({
        tMs: p.tMs,
        rate: p.ms,
        n: p.n,
      })),
      perSessionGaps:
        report.perSessionGapsFull ||
        report.perSessionGaps || { tMs: [], sessions: [] },
    },
  };
}

/**
 * Main load test. Burst closes all at once after observe; ramp ramps down
 * one session per addIntervalMs after the observe hold.
 *
 * @param {object} cfg
 * @param {object[]} wallets
 * @param {{ onProgress?: (snap: object) => void, quiet?: boolean }} [opts]
 */
export async function runLoadTest(cfg, wallets, opts = {}) {
  const onProgress = typeof opts.onProgress === "function" ? opts.onProgress : null;
  const quiet = Boolean(opts.quiet ?? onProgress);
  const maxConcurrency = Math.min(
    1000,
    Math.max(1, Number(cfg.maxConcurrency ?? cfg.cutoff ?? 50) || 50)
  );
  const mode =
    String(cfg.mode || "burst").toLowerCase() === "ramp" ? "ramp" : "burst";
  const addIntervalMs =
    mode === "ramp"
      ? Math.max(0, Number(cfg.addIntervalMs ?? 1_000) || 0)
      : 0;
  const observeMs = cfg.observeMs ?? cfg.holdAtPeakMs ?? 30_000;
  const readyTimeoutMs = cfg.readyTimeoutMs ?? 2 * 60 * 1000;
  const dashboardIntervalMs = quiet
    ? Math.min(cfg.dashboardIntervalMs ?? 5_000, 5_000)
    : cfg.dashboardIntervalMs ?? 10_000;
  /** Phase while opening: "burst" or "ramp_up". */
  const openPhase = mode === "ramp" ? "ramp_up" : "burst";

  const log = (...args) => {
    if (!quiet) console.log(...args);
  };
  const warn = (...args) => {
    if (!quiet) console.warn(...args);
    else console.warn(...args);
  };

  if (mode === "ramp") {
    log(
      `[loadtest] mode: ramp_up → ready → hold(observe) → ramp_down` +
        ` (interval ${fmtMs(addIntervalMs)})`
    );
  } else {
    log("[loadtest] mode: burst → ready → observe → close-all");
  }
  log(`[loadtest] endpoint=${cfg.endpoint}`);
  if (mode === "ramp") {
    log(
      `[loadtest] ramp up: +1 every ${fmtMs(addIntervalMs)} → ${maxConcurrency}, ` +
        `hold ${fmtMs(observeMs)}, ramp down: −1 every ${fmtMs(addIntervalMs)}`
    );
  } else {
    log(`[loadtest] open ${maxConcurrency} path_finds as fast as possible`);
  }
  log(
    `[loadtest] ready timeout ${fmtMs(readyTimeoutMs)}  observe ${fmtMs(observeMs)}`
  );
  log(`[loadtest] wallet pool: ${wallets.length}`);
  log(
    "[loadtest] accounts:",
    wallets.map((w) => w.account).join(", ")
  );

  if (!wallets.length) throw new Error("No wallets available for load test");

  const cursor = createAssignmentCursor(wallets);
  /** @type {import('./pathfind-worker.js').PathFindWorker[]} */
  const workers = [];
  const timeline = [];
  const runStartedAt = Date.now();
  let observeStartT = null;
  let lastProgressAt = 0;
  /** Live phase for onEvent → progress routing. */
  let currentPhase = openPhase;

  const run = {
    startedAt: new Date().toISOString(),
    endpoint: cfg.endpoint,
    mode,
    addIntervalMs,
    maxConcurrency,
    observeMs,
    readyTimeoutMs,
    walletCount: wallets.length,
    wallets: wallets.map((w) => ({
      account: w.account,
      trustlinesWithBalance: w.trustlinesWithBalance,
      heldTrustlines: w.heldTrustlines,
    })),
    timeline: [],
    sessions: [],
    phases: {},
  };

  const getOpenCount = () => countOpenWorkers(workers);

  const emitProgress = (phase, message = null, force = false) => {
    if (!onProgress) return;
    const now = Date.now();
    // Throttle chatty phases; always allow phase transitions (force)
    if (
      !force &&
      (phase === "burst" ||
        phase === "ramp_up" ||
        phase === "ramp" ||
        phase === "ramp_down") &&
      now - lastProgressAt < 250
    )
      return;
    if (!force && phase === "ready" && now - lastProgressAt < 400) return;
    lastProgressAt = now;
    try {
      onProgress(
        buildProgressSnapshot({
          phase,
          workers,
          timeline,
          maxConcurrency,
          observeMs,
          runStartedAt,
          observeStartT,
          phases: run.phases,
          message,
          mode,
          addIntervalMs,
        })
      );
    } catch (err) {
      console.warn("[loadtest] onProgress error:", err.message);
    }
  };

  const setPhase = (phase, message = null) => {
    currentPhase = phase;
    emitProgress(phase, message, true);
  };

  const onEvent = (evt) => {
    timeline.push({ ...evt, t: Date.now() - runStartedAt });
    if (evt.type === "initial" || evt.type === "error") {
      emitProgress(currentPhase);
    } else if (
      evt.type === "follow_up" &&
      (currentPhase === "observe" ||
        currentPhase === "ready" ||
        currentPhase === "ramp_up" ||
        currentPhase === "ramp_down")
    ) {
      emitProgress(currentPhase);
    }
  };

  const launchOne = (n) => {
    const { source, dest } = cursor.next();
    const sessionId = `PF${String(n).padStart(4, "0")}`;
    // Ramp: concurrency grows with n; burst: target is always max
    const concurrencyAtStart = mode === "ramp" ? n : maxConcurrency;
    return startPathFindWorker({
      endpoint: cfg.endpoint,
      sourceWallet: source,
      destWallet: dest,
      sessionId,
      concurrencyAtStart,
      getOpenCount,
      onEvent,
      selfPathFind: cfg.selfPathFind !== false,
      maxTokenAttempts: 3,
    }).then((worker) => {
      workers.push(worker);
      if (worker.state.failed) {
        if (!quiet) {
          console.warn(
            `  [${sessionId}] FAILED  (${worker.state.error || worker.state.errors?.[0]?.message || "?"})`
          );
        }
      } else if (!quiet) {
        console.log(
          `  [${sessionId}] CREATE ${fmtMs(worker.state.initial.latencyMs)}  ` +
            `alts=${worker.state.initial.alternatives} paths=${worker.state.initial.pathsComputed}  ` +
            `dest=${formatAmount(worker.state.destination_amount)}  ` +
            `open=${countOpenWorkers(workers)}/${maxConcurrency}`
        );
      }
      emitProgress(openPhase);
      return worker;
    });
  };

  // ── 1. OPEN: burst (all at once) or ramp_up (+1 every addIntervalMs) ──
  if (mode === "ramp") {
    log(
      `\n[loadtest] RAMP UP: +1 path_find every ${fmtMs(addIntervalMs)} → ${maxConcurrency}…`
    );
    log(
      "[loadtest] ramp up awaits each create before the next interval (true +1 concurrency / step)"
    );
    setPhase(
      "ramp_up",
      `Ramping up: +1 path_find every ${fmtMs(addIntervalMs)}…`
    );
  } else {
    log(
      `\n[loadtest] BURST: launching ${maxConcurrency} path_find workers in parallel…`
    );
    setPhase("burst", "Launching path_find workers…");
  }
  const openStartedAt = Date.now();

  if (mode === "ramp") {
    // Sequential: fully open (or fail) one session, then wait, then next.
    // Fire-and-forget every N ms piles up in-flight creates; under load they
    // complete in a clump and the charts look like a sudden burst at the end.
    for (let n = 1; n <= maxConcurrency; n++) {
      await launchOne(n);
      emitProgress(
        "ramp_up",
        `Open ${countOpenWorkers(workers)}/${maxConcurrency}` +
          (n < maxConcurrency
            ? ` — next in ${fmtMs(addIntervalMs)}`
            : " — at cap")
      );
      if (n < maxConcurrency && addIntervalMs > 0) {
        await sleep(addIntervalMs);
      }
    }
  } else {
    const launchPromises = [];
    for (let n = 1; n <= maxConcurrency; n++) {
      launchPromises.push(launchOne(n));
    }
    await Promise.all(launchPromises);
  }
  const openMs = Date.now() - openStartedAt;
  const openStats = {
    durationMs: openMs,
    opened: countOpenWorkers(workers),
    failed: workers.filter((w) => w.state.failed).length,
    addIntervalMs: mode === "ramp" ? addIntervalMs : 0,
  };
  run.phases[openPhase] = openStats;
  // Alias for older UI that looked for phases.ramp
  if (mode === "ramp") run.phases.ramp = openStats;
  log(
    `\n[loadtest] ${mode === "ramp" ? "ramp up" : "burst"} done in ${fmtMs(openMs)}: ` +
      `open=${openStats.opened} failed=${openStats.failed}`
  );
  if (!quiet) printBurstProgress({ workers, maxConcurrency, timeline });
  emitProgress(
    openPhase,
    mode === "ramp" ? "Ramp up complete — at cap" : "Burst complete",
    true
  );

  // ── 2. READY: hold until every open session has ≥1 async update ───
  log(
    `\n[loadtest] READY: waiting until all open sessions emit updates (timeout ${fmtMs(readyTimeoutMs)})…`
  );
  setPhase("ready", "Waiting for async updates…");
  const readyStartedAt = Date.now();
  let allReady = false;

  while (Date.now() - readyStartedAt < readyTimeoutMs) {
    const open = countOpenWorkers(workers);
    const ready = countReadyWorkers(workers);
    if (open === 0) {
      warn("[loadtest] no open sessions — nothing to wait for");
      break;
    }
    if (ready >= open) {
      allReady = true;
      break;
    }
    if (!quiet) {
      process.stdout.write(
        `\r  ready ${ready}/${open}  (elapsed ${fmtMs(Date.now() - readyStartedAt)})   `
      );
    }
    emitProgress("ready");
    await sleep(500);
  }
  if (!quiet) process.stdout.write("\n");

  const readyMs = Date.now() - readyStartedAt;
  const openAfterReady = countOpenWorkers(workers);
  const readyCount = countReadyWorkers(workers);
  run.phases.ready = {
    durationMs: readyMs,
    allReady,
    open: openAfterReady,
    updating: readyCount,
  };
  if (allReady) {
    log(
      `[loadtest] all ${readyCount} open sessions are updating (waited ${fmtMs(readyMs)})`
    );
  } else {
    warn(
      `[loadtest] ready timeout: ${readyCount}/${openAfterReady} updating after ${fmtMs(readyMs)} — proceeding to observe`
    );
  }
  if (!quiet) printBurstProgress({ workers, maxConcurrency, timeline });
  emitProgress("ready", allReady ? "All sessions updating" : "Ready timeout", true);

  // ── 3. OBSERVE / HOLD AT CAP ──────────────────────────────────────
  observeStartT = Date.now() - runStartedAt;
  run.phases.observe = {
    startT: observeStartT,
    durationMs: observeMs,
  };
  setPhase(
    "observe",
    mode === "ramp"
      ? `Holding at cap for ${fmtMs(observeMs)}…`
      : "Observing responses…"
  );

  if (observeMs > 0 && countOpenWorkers(workers) > 0) {
    log(
      `\n[loadtest] ${mode === "ramp" ? "HOLD/OBSERVE" : "OBSERVE"}: ` +
        `at open=${countOpenWorkers(workers)} for ${fmtMs(observeMs)}…`
    );
    const observeEnd = Date.now() + observeMs;
    let nextDash = Date.now();
    while (Date.now() < observeEnd) {
      if (Date.now() >= nextDash) {
        if (!quiet) {
          printObserveDashboard({
            workers,
            maxConcurrency,
            timeline,
            observeStartT,
            observeMs,
            runStartedAt,
          });
        }
        emitProgress("observe", null, true);
        nextDash = Date.now() + dashboardIntervalMs;
      }
      await sleep(Math.min(1000, Math.max(0, observeEnd - Date.now())));
    }
    if (!quiet) {
      printObserveDashboard({
        workers,
        maxConcurrency,
        timeline,
        observeStartT,
        observeMs,
        runStartedAt,
      });
    }
    emitProgress(
      "observe",
      mode === "ramp" ? "Hold complete — ramping down" : "Observe complete",
      true
    );
  } else {
    log("[loadtest] observe window is 0 or no open sessions — skipping");
  }

  // ── 4. CLOSE: ramp down (mode=ramp) or close-all (burst) ──────────
  if (mode === "ramp") {
    log(
      `\n[loadtest] RAMP DOWN: −1 path_find every ${fmtMs(addIntervalMs)}…`
    );
    setPhase(
      "ramp_down",
      `Ramping down: −1 path_find every ${fmtMs(addIntervalMs)}…`
    );
    const rampDownStartedAt = Date.now();
    let closedCount = 0;

    // Close newest-first so open count falls from cap → 0
    while (true) {
      const openList = workers.filter(
        (w) => w.state.initial && !w.state.closed && !w.state.failed
      );
      if (!openList.length) break;

      const w = openList[openList.length - 1];
      const remainingAfter = openList.length - 1;
      if (!quiet) {
        console.log(
          `  [${w.sessionId}] CLOSE  open→${remainingAfter}/${maxConcurrency}`
        );
      }
      await w.stop();
      closedCount++;
      emitProgress(
        "ramp_down",
        `Closed ${w.sessionId} — ${remainingAfter}/${maxConcurrency} open`
      );

      if (remainingAfter > 0 && addIntervalMs > 0) {
        await sleep(addIntervalMs);
      }
    }

    // Sweep any failed / never-opened workers
    await Promise.all(workers.map((w) => w.stop()));

    const rampDownMs = Date.now() - rampDownStartedAt;
    run.phases.ramp_down = {
      durationMs: rampDownMs,
      closed: closedCount,
      addIntervalMs,
    };
    log(
      `[loadtest] ramp down done in ${fmtMs(rampDownMs)}: closed ${closedCount} sessions`
    );
    emitProgress("ramp_down", "Ramp down complete", true);
  } else {
    setPhase("closing", "Closing sessions…");
    log(`\n[loadtest] closing ${workers.length} path_find sessions…`);
    await Promise.all(workers.map((w) => w.stop()));
  }

  run.endedAt = new Date().toISOString();
  run.timeline = timeline;
  run.sessions = workers.map((w) => ({ ...w.state }));
  run.observeStartT = observeStartT;
  run.buckets = bucketByConcurrency(timeline, maxConcurrency);
  run.report = buildReport(run);

  if (!quiet) {
    console.log("\n\n########## FINAL REPORT ##########\n");
    printFinalReport(run);
  }

  setPhase("done", "Run complete");

  if (!quiet) {
    if (cfg.inspect && process.stdin.isTTY && process.stdout.isTTY) {
      await interactiveDrillDown(run.sessions);
    } else {
      console.log(
        "\nTip: re-run with --inspect to interactively open individual sessions (PF0001, list, fail, q)."
      );
      console.log("     Or open the saved results JSON for full per-request detail.");
    }
  }

  return run;
}

function buildReport(run) {
  const creates = createResponseSeries(run.timeline);
  const createOverTime = createLatencyOverTime(run.timeline);
  const observeStartT = run.observeStartT ?? 0;
  // Observe-window-only (for hold-at-cap stats / terminal dashboards)
  const gaps = updateGapOverTime(run.timeline, { sinceT: observeStartT });
  const gapBuckets = bucketTimeSeries(gaps, UPDATE_BUCKET_MS);
  const rates = updateRateOverTime(run.timeline, {
    sinceT: observeStartT,
    bucketMs: UPDATE_BUCKET_MS,
  });
  const perSessionGaps = perSessionUpdateGaps(run.timeline, {
    sinceT: observeStartT,
    bucketMs: UPDATE_BUCKET_MS,
  });
  // Full run (for UI charts that shade the observe window across phases)
  const gapsFull = updateGapOverTime(run.timeline, { sinceT: 0 });
  const gapBucketsFull = bucketTimeSeries(gapsFull, UPDATE_BUCKET_MS);
  const ratesFull = updateRateOverTime(run.timeline, {
    sinceT: 0,
    bucketMs: UPDATE_BUCKET_MS,
  });
  const perSessionGapsFull = perSessionUpdateGaps(run.timeline, {
    sinceT: 0,
    bucketMs: UPDATE_BUCKET_MS,
  });
  return {
    endpoint: run.endpoint,
    mode: run.mode || "burst",
    addIntervalMs: run.addIntervalMs ?? 0,
    maxConcurrency: run.maxConcurrency,
    observeMs: run.observeMs,
    observeStartT: run.observeStartT ?? null,
    readyTimeoutMs: run.readyTimeoutMs,
    phases: run.phases,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    openFinal: run.sessions.filter((s) => s.initial && !s.failed).length,
    failed: run.sessions.filter((s) => s.failed).length,
    createLatencies: creates,
    createLatencyOverTime: createOverTime,
    updateGapOverTime: gaps,
    updateGapBuckets: gapBuckets,
    updateRateOverTime: rates,
    perSessionGaps,
    updateGapBucketsFull: gapBucketsFull,
    updateRateOverTimeFull: ratesFull,
    perSessionGapsFull,
    buckets: run.buckets,
  };
}

function printFinalReport(run) {
  const creates = createResponseSeries(run.timeline);
  const createOverTime = createLatencyOverTime(run.timeline);
  const observeStartT = run.observeStartT ?? 0;
  const gaps = updateGapOverTime(run.timeline, { sinceT: observeStartT });
  const gapBuckets = bucketTimeSeries(gaps, UPDATE_BUCKET_MS);
  const rates = updateRateOverTime(run.timeline, {
    sinceT: observeStartT,
    bucketMs: UPDATE_BUCKET_MS,
  });

  console.log("── phases ──");
  const rampUp = run.phases?.ramp_up || run.phases?.ramp;
  if (rampUp) {
    console.log(
      `  ramp_up:   ${fmtMs(rampUp.durationMs)}  open=${rampUp.opened} failed=${rampUp.failed}` +
        (rampUp.addIntervalMs ? `  interval=${fmtMs(rampUp.addIntervalMs)}` : "")
    );
  }
  if (run.phases?.burst) {
    console.log(
      `  burst:     ${fmtMs(run.phases.burst.durationMs)}  open=${run.phases.burst.opened} failed=${run.phases.burst.failed}`
    );
  }
  if (run.phases?.ready) {
    console.log(
      `  ready:     ${fmtMs(run.phases.ready.durationMs)}  updating=${run.phases.ready.updating}/${run.phases.ready.open}` +
        (run.phases.ready.allReady ? "  (all ready)" : "  (timeout)")
    );
  }
  if (run.phases?.observe) {
    console.log(
      `  observe:   ${fmtMs(run.phases.observe.durationMs)}` +
        (run.mode === "ramp" ? "  (hold at cap)" : "")
    );
  }
  if (run.phases?.ramp_down) {
    console.log(
      `  ramp_down: ${fmtMs(run.phases.ramp_down.durationMs)}  closed=${run.phases.ramp_down.closed}` +
        (run.phases.ramp_down.addIntervalMs
          ? `  interval=${fmtMs(run.phases.ramp_down.addIntervalMs)}`
          : "")
    );
  }
  console.log("");

  if (createOverTime.length) {
    console.log(
      renderTimeSeriesChart(createOverTime, {
        title: "FINAL: CREATE response time over burst (send → first WS reply)",
        yLabel: "create latency",
        xLabel: "run time",
        width: 64,
        height: 12,
      })
    );
    console.log("");
  } else if (creates.length) {
    console.log(
      renderRampLineChart(
        creates.map((c, i) => ({ concurrency: i + 1, ms: c.ms })),
        {
          title: "FINAL: CREATE response times (session completion order)",
          yLabel: "create latency",
          width: 64,
          height: 12,
        }
      )
    );
    console.log("");
  }

  if (gapBuckets.length) {
    console.log(
      renderTimeSeriesChart(gapBuckets, {
        title: "FINAL: async UPDATE gap over observe window (mean / 3s)",
        yLabel: "upd gap",
        xLabel: "run time",
        width: 64,
        height: 14,
      })
    );
    console.log("");
  } else if (gaps.length) {
    console.log(
      renderTimeSeriesChart(gaps, {
        title: "FINAL: async UPDATE gap over observe window",
        yLabel: "upd gap",
        xLabel: "run time",
        width: 64,
        height: 14,
      })
    );
    console.log("");
  }

  if (rates.length) {
    const fmtRate = (v) =>
      v == null || Number.isNaN(v) ? "n/a" : `${Number(v).toFixed(1)}/s`;
    console.log(
      renderTimeSeriesChart(rates, {
        title: "FINAL: update throughput (updates/sec, 3s buckets)",
        yLabel: "upd/s",
        xLabel: "run time",
        width: 64,
        height: 10,
        fmtY: fmtRate,
      })
    );
    console.log("");
  }

  if (creates.length) {
    const vals = creates.map((c) => c.ms);
    console.log(
      ` create sparkline: ${sparkline(vals, 56)}\n` +
        `   n=${vals.length}  min=${fmtMs(Math.min(...vals))}  max=${fmtMs(Math.max(...vals))}  ` +
        `mean=${fmtMs(vals.reduce((a, b) => a + b, 0) / vals.length)}`
    );
  }
  if (gaps.length) {
    const vals = gaps.map((g) => g.ms);
    console.log(
      ` update-gap sparkline: ${sparkline(vals, 56)}\n` +
        `   n=${vals.length}  ${fmtStats("gaps", summarizeNumbers(vals))}`
    );
  }

  console.log("\n── aggregate table (all sessions at peak open count) ──");
  console.log(renderConcurrencyTable(run.buckets));
  console.log("\n── individual requests (create ms = send→first reply) ──");
  console.log(renderSessionList(run.sessions, { limit: 80 }));
  console.log("");
  console.log(
    `sessions: ok=${run.sessions.filter((s) => s.initial && !s.failed).length}  ` +
      `failed=${run.sessions.filter((s) => s.failed).length}  ` +
      `total=${run.sessions.length}`
  );
}

/**
 * Let the user inspect individual path_find requests after the run.
 */
async function interactiveDrillDown(sessions) {
  const byId = new Map(sessions.map((s) => [s.sessionId, s]));
  console.log(
    "\nInspect individual requests: type a session id (e.g. PF0003), " +
      "'list', 'fail', or 'q' to quit."
  );

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const ask = (q) => new Promise((resolve) => rl.question(q, resolve));

  try {
    while (true) {
      const ans = String(await ask("> ")).trim();
      if (!ans || ans === "q" || ans === "quit" || ans === "exit") break;
      if (ans === "list") {
        console.log(renderSessionList(sessions, { limit: 200 }));
        continue;
      }
      if (ans === "fail" || ans === "failed") {
        console.log(
          renderSessionList(
            sessions.filter((s) => s.failed),
            { limit: 200 }
          )
        );
        continue;
      }
      let s = byId.get(ans) || byId.get(ans.toUpperCase());
      if (!s) {
        const num = ans.replace(/\D/g, "");
        if (num) s = byId.get(`PF${num.padStart(4, "0")}`);
      }
      if (!s) {
        console.log(`unknown id '${ans}' — try 'list'`);
        continue;
      }
      console.log(renderSessionDetail(s));
    }
  } finally {
    rl.close();
  }
}

export async function saveResults(resultsDir, run) {
  const absDir = path.resolve(resultsDir);
  await fs.mkdir(absDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const fullPath = path.join(absDir, `loadtest-${stamp}.json`);
  const summaryPath = path.join(absDir, `loadtest-${stamp}-summary.json`);
  await fs.writeFile(fullPath, JSON.stringify(run, null, 2));
  await fs.writeFile(summaryPath, JSON.stringify(run.report, null, 2));
  console.log(`[loadtest] full results → ${fullPath}`);
  console.log(`[loadtest] summary     → ${summaryPath}`);
  return { fullPath, summaryPath };
}

async function main() {
  const args = parseArgs();
  const cfg = resolveConfig({
    endpoint: args.endpoint || DEFAULTS.endpoint,
    maxConcurrency: args.max ?? args.cutoff ?? args.maxConcurrency,
    observeMs: args.observeMs,
    observeMin: args.observeMin,
    observeSec: args.observeSec,
    holdAtPeakMs: args.holdAtPeakMs,
    holdAtPeakSec: args.holdAtPeakSec,
    readyTimeoutMs: args.readyTimeoutMs,
    readyTimeoutSec: args.readyTimeoutSec,
    readyTimeoutMin: args.readyTimeoutMin,
    walletsFile: args.walletsFile || DEFAULTS.walletsFile,
    resultsDir: args.resultsDir || DEFAULTS.resultsDir,
    selfPathFind: args.crossAccount ? false : undefined,
    inspect: Boolean(args.inspect),
  });

  if (args.max !== undefined) cfg.maxConcurrency = Number(args.max);
  if (args.cutoff !== undefined) cfg.maxConcurrency = Number(args.cutoff);

  console.log("[loadtest] config:", {
    endpoint: cfg.endpoint,
    maxConcurrency: cfg.maxConcurrency,
    observeMs: cfg.observeMs,
    readyTimeoutMs: cfg.readyTimeoutMs,
    walletsFile: cfg.walletsFile,
  });

  const wallets = await loadWallets(cfg.walletsFile);
  console.log(`[loadtest] loaded ${wallets.length} wallets from ${cfg.walletsFile}`);

  const run = await runLoadTest(cfg, wallets);
  await saveResults(cfg.resultsDir, run);
  console.log("[loadtest] done.");
}

const isDirect =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirect) {
  main().catch((err) => {
    console.error("[loadtest] fatal:", err);
    process.exit(1);
  });
}
