/**
 * In-memory run history with optional disk persistence under data/results/.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import {
  summarizeRunForUi,
  saveResults,
  loadRequestPlanFromResultsFile,
} from "../src/loadtest.js";
import {
  buildRequestPlanFromSessions,
  normalizeRequestPlan,
} from "../src/pathfind-session.js";

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
  return {
    ...rest,
    canRerun: Boolean(
      (Array.isArray(rest.requestPlan) && rest.requestPlan.length) ||
        rest.summary?.canRerun ||
        rest.resultsPath
    ),
    requestPlanCount:
      (Array.isArray(rest.requestPlan) && rest.requestPlan.length) ||
      rest.summary?.requestPlanCount ||
      0,
    // Do not send full plan in list payloads (can be large); keep on entry for rerun
    requestPlan: undefined,
  };
}

export function createRunRecord({ config, label, replayOf = null }) {
  const id = randomUUID().slice(0, 8);
  const modeTag =
    config.mode === "ramp"
      ? `ramp/${Math.round((config.addIntervalMs || 0) / 1000)}s · `
      : "";
  const replayTag = replayOf ? `replay←${replayOf} · ` : "";
  const entry = {
    id,
    label:
      label ||
      `${replayTag}${modeTag}${config.maxConcurrency} open · ${Math.round((config.observeMs || 0) / 1000)}s`,
    status: "queued",
    startedAt: new Date().toISOString(),
    endedAt: null,
    config,
    progress: null,
    summary: null,
    error: null,
    /** Ordered path_find creates for exact re-runs */
    requestPlan: null,
    replayOf: replayOf || null,
    resultsPath: null,
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
  // Keep compact plan on the entry so reruns work after fullRun is GC'd later
  let plan = normalizeRequestPlan(fullRun.requestPlan);
  if (!plan.length && Array.isArray(fullRun.sessions)) {
    plan = buildRequestPlanFromSessions(fullRun.sessions);
  }
  entry.requestPlan = plan.length ? plan : null;
  entry.summary = summarizeRunForUi(
    { ...fullRun, requestPlan: plan },
    {
      id,
      label: entry.label,
      status: "done",
    }
  );
  entry.progress = {
    ...(entry.progress || {}),
    phase: "done",
    message: "Run complete",
  };
  if (activeRunId === id) activeRunId = null;

  try {
    const saved = await saveResults(RESULTS_DIR, {
      ...fullRun,
      id,
      label: entry.label,
      requestPlan: plan,
    });
    entry.resultsPath = saved?.fullPath || null;
    await persistIndex();
  } catch (err) {
    console.warn("[run-store] persist failed:", err.message);
  }

  broadcast(entry, { type: "done", data: entry.summary });
  return entry.summary;
}

/**
 * Resolve the ordered path_find request plan for a completed run.
 * Checks in-memory plan, fullRun, then on-disk results by id / resultsPath.
 *
 * @param {string} id
 * @returns {Promise<object[]>}
 */
export async function getRequestPlan(id) {
  const entry = runs.get(id);
  if (!entry) {
    throw new Error(`run not found: ${id}`);
  }

  let plan = normalizeRequestPlan(entry.requestPlan);
  if (plan.length) return plan;

  if (entry.fullRun) {
    plan = normalizeRequestPlan(entry.fullRun.requestPlan);
    if (!plan.length && Array.isArray(entry.fullRun.sessions)) {
      plan = buildRequestPlanFromSessions(entry.fullRun.sessions);
    }
    if (plan.length) {
      entry.requestPlan = plan;
      return plan;
    }
  }

  // Prefer explicit results path
  if (entry.resultsPath) {
    try {
      const loaded = await loadRequestPlanFromResultsFile(entry.resultsPath);
      entry.requestPlan = loaded.plan;
      return loaded.plan;
    } catch {
      /* fall through */
    }
  }

  // Scan results dir for a full JSON with matching id
  try {
    const files = await fs.readdir(RESULTS_DIR);
    const fulls = files.filter(
      (f) =>
        f.startsWith("loadtest-") &&
        f.endsWith(".json") &&
        !f.endsWith("-summary.json")
    );
    for (const f of fulls.slice().reverse()) {
      try {
        const raw = await fs.readFile(path.join(RESULTS_DIR, f), "utf8");
        const data = JSON.parse(raw);
        if (data.id !== id) continue;
        plan = normalizeRequestPlan(data.requestPlan);
        if (!plan.length && Array.isArray(data.sessions)) {
          plan = buildRequestPlanFromSessions(data.sessions);
        }
        if (plan.length) {
          entry.requestPlan = plan;
          entry.resultsPath = path.join(RESULTS_DIR, f);
          return plan;
        }
      } catch {
        /* skip */
      }
    }
  } catch {
    /* no dir */
  }

  throw new Error(
    `No request plan available for run ${id}. Re-run a new test first (older results may lack path_find request details).`
  );
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
  // Persist plan so reruns work after server restart without re-reading multi-MB full JSON
  const index = [...runs.values()].map((r) => ({
    id: r.id,
    label: r.label,
    status: r.status,
    startedAt: r.startedAt,
    endedAt: r.endedAt,
    config: r.config,
    summary: r.summary
      ? {
          ...r.summary,
          // strip heavy series from index? keep as-is for now (already there)
        }
      : null,
    error: r.error,
    replayOf: r.replayOf || null,
    resultsPath: r.resultsPath || null,
    requestPlan: r.requestPlan || null,
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
        const plan = normalizeRequestPlan(item.requestPlan);
        runs.set(item.id, {
          id: item.id,
          label: item.label,
          status: item.status || "done",
          startedAt: item.startedAt,
          endedAt: item.endedAt,
          config: item.config,
          progress: null,
          summary: item.summary
            ? {
                ...item.summary,
                canRerun:
                  plan.length > 0 ||
                  item.summary.canRerun ||
                  Boolean(item.resultsPath),
                requestPlanCount:
                  plan.length || item.summary.requestPlanCount || 0,
                replayOf: item.replayOf || item.summary.replayOf || null,
              }
            : null,
          error: item.error || null,
          requestPlan: plan.length ? plan : null,
          replayOf: item.replayOf || null,
          resultsPath: item.resultsPath || null,
          listeners: new Set(),
          fullRun: null,
        });
      }
    }
  } catch {
    /* no index yet */
  }

  // Import orphan summaries from true CLI runs only (not already in ui-index).
  // UI completeRun writes loadtest-<stamp>.json with id/label and records
  // resultsPath on the index entry. Matching by stamp/id avoids re-importing
  // those as fake "N open · CLI" duplicates on every server restart.
  try {
    const knownStamps = new Set();
    for (const r of runs.values()) {
      if (!r.resultsPath) continue;
      const base = path.basename(r.resultsPath);
      const m = base.match(/^loadtest-(.+)\.json$/);
      if (m) knownStamps.add(m[1]);
    }

    const files = await fs.readdir(RESULTS_DIR);
    const summaries = files.filter((f) => f.endsWith("-summary.json"));
    for (const f of summaries.slice(-30)) {
      try {
        const stamp = f
          .replace(/^loadtest-/, "")
          .replace(/-summary\.json$/, "");
        if (knownStamps.has(stamp)) continue;

        // Prefer full JSON when present: UI runs store id/label there; CLI does not.
        const fullPath = path.join(RESULTS_DIR, `loadtest-${stamp}.json`);
        let full = null;
        try {
          full = JSON.parse(await fs.readFile(fullPath, "utf8"));
        } catch {
          /* summary-only orphan */
        }
        if (full?.id && runs.has(full.id)) {
          // Index entry exists but resultsPath was missing — link it now.
          const existing = runs.get(full.id);
          if (existing && !existing.resultsPath) {
            existing.resultsPath = fullPath;
          }
          continue;
        }

        const raw = await fs.readFile(path.join(RESULTS_DIR, f), "utf8");
        const report = JSON.parse(raw);

        const id =
          (full?.id && String(full.id)) ||
          `cli-${stamp}`.slice(0, 24);
        if (runs.has(id)) continue;

        const isUiArtifact = Boolean(full?.id || full?.label);
        const label =
          full?.label ||
          (isUiArtifact
            ? `${report.maxConcurrency} open`
            : `${report.maxConcurrency} open · CLI`);

        // Build a pseudo-run for summarizeRunForUi
        const pseudo = {
          startedAt: report.startedAt || full?.startedAt,
          endedAt: report.endedAt || full?.endedAt,
          endpoint: report.endpoint || full?.endpoint,
          maxConcurrency: report.maxConcurrency ?? full?.maxConcurrency,
          observeMs: report.observeMs ?? full?.observeMs,
          readyTimeoutMs: report.readyTimeoutMs ?? full?.readyTimeoutMs,
          phases: report.phases || full?.phases,
          sessions: [],
          timeline: [],
          report,
        };
        const summary = summarizeRunForUi(pseudo, {
          id,
          label,
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
          startedAt: report.startedAt || full?.startedAt,
          endedAt: report.endedAt || full?.endedAt,
          config: summary.config,
          progress: null,
          summary,
          error: null,
          requestPlan: null,
          replayOf: full?.replayOf || null,
          resultsPath: full ? fullPath : null,
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
