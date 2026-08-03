/**
 * In-memory run history with optional disk persistence under data/results/.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { summarizeRunForUi, saveResults } from "../src/loadtest.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const RESULTS_DIR = path.join(ROOT, "data", "results");
const INDEX_PATH = path.join(RESULTS_DIR, "ui-index.json");

/** @type {Map<string, object>} */
const runs = new Map();

/** @type {string | null} */
let activeRunId = null;

export function getActiveRunId() {
  return activeRunId;
}

export function listRuns() {
  return [...runs.values()]
    .map((r) => stripHeavy(r))
    .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
}

export function getRun(id) {
  return runs.get(id) || null;
}

function stripHeavy(entry) {
  const { fullRun, listeners, ...rest } = entry;
  return rest;
}

export function createRunRecord({ config, label }) {
  const id = randomUUID().slice(0, 8);
  const modeTag =
    config.mode === "ramp"
      ? `ramp/${Math.round((config.addIntervalMs || 0) / 1000)}s · `
      : "";
  const entry = {
    id,
    label:
      label ||
      `${modeTag}${config.maxConcurrency} open · ${Math.round((config.observeMs || 0) / 1000)}s`,
    status: "queued",
    startedAt: new Date().toISOString(),
    endedAt: null,
    config,
    progress: null,
    summary: null,
    error: null,
    /** @type {Set<(payload: object) => void>} */
    listeners: new Set(),
    fullRun: null,
  };
  runs.set(id, entry);
  return entry;
}

export function subscribe(id, fn) {
  const entry = runs.get(id);
  if (!entry) return () => {};
  entry.listeners.add(fn);
  if (entry.progress) fn({ type: "progress", data: entry.progress });
  if (entry.status === "done" && entry.summary) {
    fn({ type: "done", data: entry.summary });
  }
  if (entry.status === "error" && entry.error) {
    fn({ type: "error", data: { message: entry.error } });
  }
  return () => entry.listeners.delete(fn);
}

function broadcast(entry, payload) {
  for (const fn of entry.listeners) {
    try {
      fn(payload);
    } catch {
      /* ignore subscriber errors */
    }
  }
}

export function setProgress(id, snapshot) {
  const entry = runs.get(id);
  if (!entry) return;
  entry.progress = snapshot;
  entry.status = snapshot.phase === "done" ? "running" : "running";
  if (
    snapshot.phase === "burst" ||
    snapshot.phase === "ramp" ||
    snapshot.phase === "ramp_up" ||
    snapshot.phase === "ramp_down" ||
    snapshot.phase === "ready" ||
    snapshot.phase === "observe" ||
    snapshot.phase === "closing"
  ) {
    entry.status = "running";
  }
  broadcast(entry, { type: "progress", data: snapshot });
}

export async function completeRun(id, fullRun) {
  const entry = runs.get(id);
  if (!entry) return null;
  entry.fullRun = fullRun;
  entry.endedAt = fullRun.endedAt || new Date().toISOString();
  entry.status = "done";
  entry.summary = summarizeRunForUi(fullRun, {
    id,
    label: entry.label,
    status: "done",
  });
  entry.progress = {
    ...(entry.progress || {}),
    phase: "done",
    message: "Run complete",
  };
  if (activeRunId === id) activeRunId = null;

  try {
    await saveResults(RESULTS_DIR, {
      ...fullRun,
      id,
      label: entry.label,
    });
    await persistIndex();
  } catch (err) {
    console.warn("[run-store] persist failed:", err.message);
  }

  broadcast(entry, { type: "done", data: entry.summary });
  return entry.summary;
}

export function failRun(id, error) {
  const entry = runs.get(id);
  if (!entry) return;
  entry.status = "error";
  entry.error = error?.message || String(error);
  entry.endedAt = new Date().toISOString();
  if (activeRunId === id) activeRunId = null;
  broadcast(entry, { type: "error", data: { message: entry.error } });
  persistIndex().catch(() => {});
}

export function claimActive(id) {
  if (activeRunId && activeRunId !== id) {
    const other = runs.get(activeRunId);
    if (other && (other.status === "running" || other.status === "queued")) {
      return false;
    }
  }
  activeRunId = id;
  const entry = runs.get(id);
  if (entry) entry.status = "running";
  return true;
}

export function releaseActive(id) {
  if (activeRunId === id) activeRunId = null;
}

async function persistIndex() {
  await fs.mkdir(RESULTS_DIR, { recursive: true });
  const index = listRuns().map((r) => ({
    id: r.id,
    label: r.label,
    status: r.status,
    startedAt: r.startedAt,
    endedAt: r.endedAt,
    config: r.config,
    summary: r.summary,
    error: r.error,
  }));
  await fs.writeFile(INDEX_PATH, JSON.stringify(index, null, 2));
}

/**
 * Load UI index + best-effort import of recent summary JSON files.
 */
export async function loadFromDisk() {
  try {
    const raw = await fs.readFile(INDEX_PATH, "utf8");
    const index = JSON.parse(raw);
    if (Array.isArray(index)) {
      for (const item of index) {
        if (!item?.id) continue;
        runs.set(item.id, {
          id: item.id,
          label: item.label,
          status: item.status || "done",
          startedAt: item.startedAt,
          endedAt: item.endedAt,
          config: item.config,
          progress: null,
          summary: item.summary,
          error: item.error || null,
          listeners: new Set(),
          fullRun: null,
        });
      }
    }
  } catch {
    /* no index yet */
  }

  // Import orphan summaries from CLI runs (no id in ui-index)
  try {
    const files = await fs.readdir(RESULTS_DIR);
    const summaries = files.filter((f) => f.endsWith("-summary.json"));
    for (const f of summaries.slice(-30)) {
      try {
        const raw = await fs.readFile(path.join(RESULTS_DIR, f), "utf8");
        const report = JSON.parse(raw);
        const id = f.replace(/^loadtest-/, "").replace(/-summary\.json$/, "").slice(0, 20);
        if (runs.has(id)) continue;
        // Build a pseudo-run for summarizeRunForUi
        const pseudo = {
          startedAt: report.startedAt,
          endedAt: report.endedAt,
          endpoint: report.endpoint,
          maxConcurrency: report.maxConcurrency,
          observeMs: report.observeMs,
          readyTimeoutMs: report.readyTimeoutMs,
          phases: report.phases,
          sessions: [],
          timeline: [],
          report,
        };
        const summary = summarizeRunForUi(pseudo, {
          id,
          label: `${report.maxConcurrency} open · CLI`,
          status: "done",
        });
        // Prefer series already on report
        if (report.createLatencyOverTime) {
          summary.series.createOverTime = report.createLatencyOverTime.map((p) => ({
            tMs: p.tMs,
            ms: p.ms,
          }));
        }
        if (report.updateGapBuckets) {
          summary.series.updateGapBuckets = report.updateGapBuckets.map((p) => ({
            tMs: p.tMs,
            ms: p.ms,
            n: p.n,
          }));
        }
        if (report.updateRateOverTime) {
          summary.series.updateRateBuckets = report.updateRateOverTime.map((p) => ({
            tMs: p.tMs,
            rate: p.ms,
            n: p.n,
          }));
        }
        runs.set(id, {
          id,
          label: summary.label,
          status: "done",
          startedAt: report.startedAt,
          endedAt: report.endedAt,
          config: summary.config,
          progress: null,
          summary,
          error: null,
          listeners: new Set(),
          fullRun: null,
        });
      } catch {
        /* skip bad file */
      }
    }
  } catch {
    /* no results dir */
  }
}

export function compareRuns(ids) {
  const selected = ids
    .map((id) => runs.get(id))
    .filter((r) => r && r.summary)
    .map((r) => r.summary);

  const falloff = selected
    .map((s) => ({
      id: s.id,
      label: s.label,
      maxConcurrency: s.config.maxConcurrency,
      createMean: s.stats.create.mean,
      createP50: s.stats.create.p50,
      createP95: s.stats.create.p95,
      updateGapMean: s.stats.updateGap.mean,
      updateGapP50: s.stats.updateGap.p50,
      updateGapP95: s.stats.updateGap.p95,
      successRate: s.stats.successRate,
      opened: s.stats.opened,
      failed: s.stats.failed,
      updateRateMean: s.stats.updateRateMean,
    }))
    .sort((a, b) => a.maxConcurrency - b.maxConcurrency);

  return { runs: selected, falloff };
}
