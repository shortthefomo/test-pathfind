/**
 * Express API + Vite Vue dev middleware for path_find load-test UI.
 *
 * Dev:  node server/index.js   → http://localhost:5173
 * Prod: vite build && NODE_ENV=production node server/index.js
 */

import express from "express";
import cors from "cors";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { createServer as createViteServer } from "vite";
import { DEFAULTS } from "../src/config.js";
import { loadWallets } from "../src/discover-wallets.js";
import { runLoadTest } from "../src/loadtest.js";
import {
  loadFromDisk,
  listRuns,
  getRun,
  getRunHydrated,
  createRunRecord,
  claimActive,
  releaseActive,
  setProgress,
  completeRun,
  failRun,
  subscribe,
  getActiveRunId,
  compareRuns,
  getRequestPlan,
} from "./run-store.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const PORT = Number(process.env.PORT) || 5173;
const isProd = process.env.NODE_ENV === "production";

async function main() {
  await loadFromDisk();

  const app = express();
  app.use(cors());
  app.use(express.json({ limit: "2mb" }));

  // ── API ──────────────────────────────────────────────────────────
  app.get("/api/health", async (_req, res) => {
    let walletCount = 0;
    let walletsError = null;
    const walletsFile = path.resolve(ROOT, DEFAULTS.walletsFile);
    try {
      const wallets = await loadWallets(walletsFile);
      walletCount = wallets.length;
    } catch (err) {
      walletCount = 0;
      walletsError = err.message;
    }
    res.json({
      ok: true,
      endpoint: DEFAULTS.endpoint,
      walletsFile,
      walletCount,
      walletsError,
      activeRunId: getActiveRunId(),
      maxConcurrencyCap: 1000,
    });
  });

  app.get("/api/wallets", async (_req, res) => {
    try {
      const wallets = await loadWallets(DEFAULTS.walletsFile);
      res.json({
        count: wallets.length,
        wallets: wallets.map((w) => ({
          account: w.account,
          trustlinesWithBalance: w.trustlinesWithBalance,
          heldTrustlines: w.heldTrustlines,
        })),
      });
    } catch (err) {
      res.status(404).json({ error: err.message });
    }
  });

  app.get("/api/runs", (_req, res) => {
    res.json({ runs: listRuns(), activeRunId: getActiveRunId() });
  });

  app.get("/api/runs/:id", async (req, res) => {
    const entry = await getRunHydrated(req.params.id);
    if (!entry) return res.status(404).json({ error: "run not found" });
    const { listeners, fullRun, ...rest } = entry;
    res.json(rest);
  });

  app.get("/api/compare", (req, res) => {
    const ids = String(req.query.ids || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (ids.length < 1) {
      return res.status(400).json({ error: "pass ids=id1,id2" });
    }
    res.json(compareRuns(ids));
  });

  /**
   * Shared start helper for fresh runs and replays.
   * @param {object} opts
   * @param {object} opts.config
   * @param {string|null} opts.label
   * @param {object[]|null} opts.requestPlan
   * @param {string|null} opts.replayOf
   * @param {object[]} opts.wallets
   * @param {import('express').Response} res
   */
  function startRunAsync({ config, label, requestPlan, replayOf, wallets }, res) {
    if (getActiveRunId()) {
      res.status(409).json({
        error: "A run is already in progress",
        activeRunId: getActiveRunId(),
      });
      return null;
    }

    const entry = createRunRecord({
      config,
      label,
      replayOf: replayOf || null,
    });
    if (!claimActive(entry.id)) {
      res.status(409).json({ error: "Could not claim active run slot" });
      return null;
    }

    res.status(202).json({
      id: entry.id,
      label: entry.label,
      status: entry.status,
      config: entry.config,
      replayOf: entry.replayOf,
      isReplay: Boolean(requestPlan?.length),
      requestPlanCount: requestPlan?.length || 0,
    });

    (async () => {
      try {
        const mode = config.mode;
        console.log(
          `[api] starting run ${entry.id}` +
            (requestPlan?.length
              ? ` REPLAY of ${replayOf} (${requestPlan.length} path_finds)`
              : "") +
            ` mode=${mode}` +
            (mode === "ramp"
              ? ` interval=${Math.round((config.addIntervalMs || 0) / 1000)}s`
              : "") +
            ` max=${config.maxConcurrency} observe=${Math.round((config.observeMs || 0) / 1000)}s endpoint=${config.endpoint}`
        );
        const fullRun = await runLoadTest(config, wallets, {
          quiet: true,
          onProgress: (snap) => setProgress(entry.id, snap),
          requestPlan: requestPlan || null,
          replayOf: replayOf || null,
        });
        fullRun.id = entry.id;
        fullRun.label = entry.label;
        await completeRun(entry.id, fullRun);
        console.log(`[api] run ${entry.id} complete`);
      } catch (err) {
        console.error(`[api] run ${entry.id} failed:`, err);
        failRun(entry.id, err);
        releaseActive(entry.id);
      }
    })();

    return entry;
  }

  app.post("/api/runs", async (req, res) => {
    const body = req.body || {};
    let maxConcurrency = Number(body.maxConcurrency ?? DEFAULTS.maxConcurrency ?? 50);
    if (!Number.isFinite(maxConcurrency)) maxConcurrency = 50;
    maxConcurrency = Math.min(1000, Math.max(1, Math.floor(maxConcurrency)));

    let observeSec = Number(
      body.observeSec ?? Math.round((DEFAULTS.observeMs || 30_000) / 1000)
    );
    if (!Number.isFinite(observeSec) || observeSec < 1) observeSec = 30;
    observeSec = Math.min(3600, Math.floor(observeSec));

    let readyTimeoutSec = Number(body.readyTimeoutSec ?? 120);
    if (!Number.isFinite(readyTimeoutSec) || readyTimeoutSec < 5) {
      readyTimeoutSec = 120;
    }

    const mode =
      String(body.mode || DEFAULTS.mode || "ramp").toLowerCase() === "burst"
        ? "burst"
        : "ramp";

    let addIntervalSec = Number(
      body.addIntervalSec ?? Math.round((DEFAULTS.addIntervalMs || 1_000) / 1000)
    );
    if (!Number.isFinite(addIntervalSec) || addIntervalSec < 0) {
      addIntervalSec = 1;
    }
    // Cap interval so a 1000-cap ramp cannot stall forever (max 60s between opens)
    addIntervalSec = Math.min(60, addIntervalSec);
    const addIntervalMs =
      mode === "ramp" ? Math.round(addIntervalSec * 1000) : 0;

    const endpoint = String(body.endpoint || DEFAULTS.endpoint).trim();
    const label = body.label ? String(body.label).slice(0, 80) : null;

    const config = {
      endpoint,
      mode,
      addIntervalMs,
      maxConcurrency,
      observeMs: observeSec * 1000,
      readyTimeoutMs: readyTimeoutSec * 1000,
      selfPathFind: true,
    };

    let wallets;
    try {
      wallets = await loadWallets(path.resolve(ROOT, DEFAULTS.walletsFile));
      wallets = wallets.filter(
        (w) =>
          (w.trustlinesWithBalance ?? 0) >= DEFAULTS.minTrustlinesWithBalance
      );
      if (!wallets.length) {
        return res.status(400).json({
          error: `No wallets meet minTrustlinesWithBalance=${DEFAULTS.minTrustlinesWithBalance}. Run npm run discover first.`,
        });
      }
    } catch (err) {
      return res.status(400).json({
        error: `Failed to load wallets: ${err.message}. Run npm run discover first.`,
      });
    }

    startRunAsync({ config, label, requestPlan: null, replayOf: null, wallets }, res);
  });

  /**
   * Rerun a previous run with the same path_find requests in the same order.
   * Body may override endpoint / observeSec / readyTimeoutSec / mode / addIntervalSec / label.
   */
  app.post("/api/runs/:id/rerun", async (req, res) => {
    const sourceId = req.params.id;
    const source = getRun(sourceId);
    if (!source) {
      return res.status(404).json({ error: "run not found" });
    }
    if (source.status === "running" || source.status === "queued") {
      return res.status(409).json({ error: "Cannot rerun a run that is still active" });
    }

    let requestPlan;
    try {
      requestPlan = await getRequestPlan(sourceId);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }

    const body = req.body || {};
    const srcCfg = source.config || {};

    let observeSec = Number(
      body.observeSec ??
        Math.round((srcCfg.observeMs || DEFAULTS.observeMs || 30_000) / 1000)
    );
    if (!Number.isFinite(observeSec) || observeSec < 1) observeSec = 30;
    observeSec = Math.min(3600, Math.floor(observeSec));

    let readyTimeoutSec = Number(
      body.readyTimeoutSec ??
        Math.round((srcCfg.readyTimeoutMs || 120_000) / 1000)
    );
    if (!Number.isFinite(readyTimeoutSec) || readyTimeoutSec < 5) {
      readyTimeoutSec = 120;
    }

    const mode =
      String(body.mode || srcCfg.mode || DEFAULTS.mode || "ramp").toLowerCase() ===
      "burst"
        ? "burst"
        : "ramp";

    let addIntervalSec = Number(
      body.addIntervalSec ??
        Math.round((srcCfg.addIntervalMs || DEFAULTS.addIntervalMs || 1_000) / 1000)
    );
    if (!Number.isFinite(addIntervalSec) || addIntervalSec < 0) {
      addIntervalSec = 1;
    }
    addIntervalSec = Math.min(60, addIntervalSec);
    const addIntervalMs =
      mode === "ramp" ? Math.round(addIntervalSec * 1000) : 0;

    const endpoint = String(
      body.endpoint || srcCfg.endpoint || DEFAULTS.endpoint
    ).trim();

    const label =
      body.label != null
        ? String(body.label).slice(0, 80)
        : `replay←${sourceId}`;

    const config = {
      endpoint,
      mode,
      addIntervalMs,
      maxConcurrency: requestPlan.length,
      observeMs: observeSec * 1000,
      readyTimeoutMs: readyTimeoutSec * 1000,
      selfPathFind: true,
    };

    // Replay does not need wallets; pass empty array
    startRunAsync(
      {
        config,
        label,
        requestPlan,
        replayOf: sourceId,
        wallets: [],
      },
      res
    );
  });

  /** Inspect the request plan that would be replayed for a run. */
  app.get("/api/runs/:id/plan", async (req, res) => {
    try {
      const plan = await getRequestPlan(req.params.id);
      res.json({
        id: req.params.id,
        count: plan.length,
        plan,
      });
    } catch (err) {
      const status = String(err.message || "").includes("not found") ? 404 : 400;
      res.status(status).json({ error: err.message });
    }
  });

  app.get("/api/runs/:id/events", (req, res) => {
    const entry = getRun(req.params.id);
    if (!entry) return res.status(404).json({ error: "run not found" });

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();

    const send = (payload) => {
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    };

    send({ type: "hello", data: { id: entry.id, status: entry.status } });
    const unsub = subscribe(entry.id, send);

    const heartbeat = setInterval(() => {
      res.write(`: ping\n\n`);
    }, 15_000);

    req.on("close", () => {
      clearInterval(heartbeat);
      unsub();
    });
  });

  // ── Frontend ─────────────────────────────────────────────────────
  if (isProd) {
    const dist = path.join(ROOT, "web", "dist");
    if (fs.existsSync(dist)) {
      app.use(express.static(dist));
      app.get("*", (_req, res) => {
        res.sendFile(path.join(dist, "index.html"));
      });
    } else {
      app.get("/", (_req, res) => {
        res
          .status(500)
          .send("No web/dist — run npm run build first, or use npm run dev");
      });
    }
  } else {
    const vite = await createViteServer({
      root: path.join(ROOT, "web"),
      configFile: path.join(ROOT, "vite.config.js"),
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  }

  app.listen(PORT, () => {
    console.log(
      `[server] path_find UI  →  http://localhost:${PORT}  (${isProd ? "prod" : "dev"})`
    );
  });
}

main().catch((err) => {
  console.error("[server] fatal:", err);
  process.exit(1);
});
