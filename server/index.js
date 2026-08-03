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
  createRunRecord,
  claimActive,
  releaseActive,
  setProgress,
  completeRun,
  failRun,
  subscribe,
  getActiveRunId,
  compareRuns,
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

  app.get("/api/runs/:id", (req, res) => {
    const entry = getRun(req.params.id);
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

  app.post("/api/runs", async (req, res) => {
    if (getActiveRunId()) {
      return res.status(409).json({
        error: "A run is already in progress",
        activeRunId: getActiveRunId(),
      });
    }

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

    const entry = createRunRecord({ config, label });
    if (!claimActive(entry.id)) {
      return res.status(409).json({ error: "Could not claim active run slot" });
    }

    res.status(202).json({
      id: entry.id,
      label: entry.label,
      status: entry.status,
      config: entry.config,
    });

    // Fire-and-forget run
    (async () => {
      try {
        console.log(
          `[api] starting run ${entry.id} mode=${mode}` +
            (mode === "ramp" ? ` interval=${addIntervalSec}s` : "") +
            ` max=${maxConcurrency} observe=${observeSec}s endpoint=${endpoint}`
        );
        const fullRun = await runLoadTest(config, wallets, {
          quiet: true,
          onProgress: (snap) => setProgress(entry.id, snap),
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
