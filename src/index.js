/**
 * XRPL path_find load-test client
 *
 * 1. Discover (or load cached) wallets with ≥200 funded trustlines
 * 2. Burst-open all path_finds as fast as possible
 * 3. Hold until every open session is emitting async updates
 * 4. Observe for N minutes (default 2) and graph responses over time
 *
 * Usage:
 *   node src/index.js --skipDiscover
 *   node src/index.js --skipDiscover --max=200 --observeMin=2
 *   node src/index.js --skipDiscover --max=10 --observeSec=30
 */

import path from "node:path";
import fs from "node:fs/promises";
import { DEFAULTS, parseArgs, resolveConfig } from "./config.js";
import { discoverWallets, saveWallets, loadWallets } from "./discover-wallets.js";
import { runLoadTest, saveResults } from "./loadtest.js";

function printHelp() {
  console.log(`
xrpl-pathfind-loadtest

Burst path_find load test against a rippled WebSocket (xrpl-client).

Phases:
  1. Open --max path_finds in parallel (as fast as possible)
  2. Hold until every successful session is receiving async updates
  3. Graph update gaps / throughput over --observeMin minutes (default 2)
  4. Close all sessions and print the final report

Options:
  --endpoint=URL              WebSocket URL (default: ${DEFAULTS.endpoint})
  --walletsFile=PATH          Cache file for discovered wallets (default: ${DEFAULTS.walletsFile})
  --resultsDir=PATH           Metrics output directory (default: ${DEFAULTS.resultsDir})
  --walletPoolSize=N          Qualifying wallets to collect (default: ${DEFAULTS.walletPoolSize})
  --minTrustlinesWithBalance  Funded trustline threshold (default: ${DEFAULTS.minTrustlinesWithBalance})
  --max=200                   Concurrent open path_finds (alias: --cutoff)
  --observeMin=2              Observe/graph window in minutes (default: 2)
  --observeSec=N              Observe window in seconds (overrides --observeMin)
  --readyTimeoutSec=120       Max wait for all sessions to start updating
  --skipDiscover              Reuse walletsFile
  --rediscover                Force fresh discovery
  --discoverOnly              Only discover wallets, then exit
  --inspect                   After run, interactive drill-down of individual sessions
  --help

Examples:
  npm start -- --skipDiscover --max=200 --observeMin=2
  npm start -- --skipDiscover --max=10 --observeSec=30
  npm run discover -- --walletPoolSize=20
`);
}

async function fileExists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const args = parseArgs();
  if (args.help || args.h) {
    printHelp();
    return;
  }

  const cfg = resolveConfig({
    endpoint: args.endpoint || DEFAULTS.endpoint,
    walletsFile: args.walletsFile || DEFAULTS.walletsFile,
    resultsDir: args.resultsDir || DEFAULTS.resultsDir,
    walletPoolSize: args.walletPoolSize ?? args.wallets ?? DEFAULTS.walletPoolSize,
    minTrustlinesWithBalance:
      args.minTrustlinesWithBalance ?? DEFAULTS.minTrustlinesWithBalance,
    maxConcurrency: args.max ?? args.cutoff ?? args.maxConcurrency,
    observeMs: args.observeMs,
    observeMin: args.observeMin,
    observeSec: args.observeSec,
    holdAtPeakMs: args.holdAtPeakMs,
    holdAtPeakSec: args.holdAtPeakSec,
    readyTimeoutMs: args.readyTimeoutMs,
    readyTimeoutSec: args.readyTimeoutSec,
    readyTimeoutMin: args.readyTimeoutMin,
    maxCandidatesToScan: args.maxCandidatesToScan ?? DEFAULTS.maxCandidatesToScan,
    discoveryConcurrency: args.discoveryConcurrency ?? DEFAULTS.discoveryConcurrency,
    selfPathFind: args.crossAccount ? false : args.selfPathFind !== false,
    inspect: Boolean(args.inspect),
  });

  console.log("═══ XRPL path_find load test (burst → ready → observe) ═══");
  console.log("config:", {
    endpoint: cfg.endpoint,
    walletsFile: cfg.walletsFile,
    maxConcurrency: cfg.maxConcurrency,
    observeMs: cfg.observeMs,
    readyTimeoutMs: cfg.readyTimeoutMs,
    skipDiscover: Boolean(args.skipDiscover),
  });

  let wallets;
  const walletsPath = path.resolve(cfg.walletsFile);
  const hasCache = await fileExists(walletsPath);

  if (args.skipDiscover) {
    if (!hasCache) {
      throw new Error(`--skipDiscover set but wallets file missing: ${walletsPath}`);
    }
    wallets = await loadWallets(cfg.walletsFile);
    console.log(`[main] loaded ${wallets.length} wallets from cache`);
  } else if (args.discoverOnly || !hasCache || args.rediscover) {
    wallets = await discoverWallets(cfg);
    await saveWallets(cfg.walletsFile, wallets);
    if (args.discoverOnly) {
      console.log("[main] discoverOnly — exiting before load test");
      return;
    }
  } else {
    console.log(
      `[main] reusing cached wallets at ${walletsPath} (pass --rediscover to refresh)`
    );
    wallets = await loadWallets(cfg.walletsFile);
  }

  wallets = wallets.filter(
    (w) => (w.trustlinesWithBalance ?? 0) >= cfg.minTrustlinesWithBalance
  );
  if (wallets.length === 0) {
    throw new Error(
      `No wallets meet minTrustlinesWithBalance=${cfg.minTrustlinesWithBalance}. Run discovery again.`
    );
  }
  console.log(`[main] using ${wallets.length} wallets`);
  console.log("[main] accounts:");
  for (const w of wallets) {
    console.log(
      `  ${w.account}  funded≥${w.trustlinesWithBalance}  held≥${w.heldTrustlines ?? "?"}`
    );
  }

  const run = await runLoadTest(cfg, wallets);
  await saveResults(cfg.resultsDir, run);
  console.log("[main] complete.");
}

main().catch((err) => {
  console.error("[main] fatal:", err);
  process.exit(1);
});
