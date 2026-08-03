/**
 * XRPL path_find load-test client
 *
 * 1. Discover (or load cached) wallets with ≥200 funded trustlines
 * 2. Open path_finds up to --max:
 *      burst — all at once, or
 *      ramp  — +1 every N sec, hold for observe, then −1 every N sec
 * 3. Hold until every open session is emitting async updates
 * 4. Observe / hold at cap, then close (burst: all; ramp: gradual)
 *
 * Usage:
 *   node src/index.js --skipDiscover
 *   node src/index.js --skipDiscover --max=200 --observeMin=2
 *   node src/index.js --skipDiscover --max=10 --observeSec=30
 *   node src/index.js --skipDiscover --mode=ramp --addIntervalSec=3 --max=50
 */

import path from "node:path";
import fs from "node:fs/promises";
import { DEFAULTS, parseArgs, resolveConfig } from "./config.js";
import { discoverWallets, saveWallets, loadWallets } from "./discover-wallets.js";
import { runLoadTest, saveResults } from "./loadtest.js";

function printHelp() {
  console.log(`
xrpl-pathfind-loadtest

path_find load test against a rippled WebSocket (xrpl-client).

Phases (burst):
  1. Open --max path_finds in parallel
  2. Wait until sessions receive async updates
  3. Hold/observe for --observeMin (default 2)
  4. Close all at once

Phases (ramp):
  1. Ramp up: +1 path_find every --addIntervalSec until --max
  2. Wait until sessions receive async updates
  3. Hold at cap for observe window
  4. Ramp down: −1 path_find every --addIntervalSec until none remain

Options:
  --endpoint=URL              WebSocket URL (default: ${DEFAULTS.endpoint})
  --walletsFile=PATH          Cache file for discovered wallets (default: ${DEFAULTS.walletsFile})
  --resultsDir=PATH           Metrics output directory (default: ${DEFAULTS.resultsDir})
  --walletPoolSize=N          Qualifying wallets to collect (default: ${DEFAULTS.walletPoolSize})
  --minTrustlinesWithBalance  Funded trustline threshold (default: ${DEFAULTS.minTrustlinesWithBalance})
  --max=50                    Max concurrent open path_finds (alias: --cutoff)
  --mode=burst|ramp           Strategy (default: ramp)
  --addIntervalSec=1          Ramp: seconds between +1 up / −1 down (default: 1)
  --addIntervalMs=N           Ramp: same as above, in milliseconds
  --observeMin=N              Hold-at-cap / observe window in minutes
  --observeSec=30             Observe window in seconds (default: 30)
  --readyTimeoutSec=120       Max wait for all sessions to start updating
  --skipDiscover              Reuse walletsFile
  --rediscover                Force fresh discovery
  --discoverOnly              Only discover wallets, then exit
  --inspect                   After run, interactive drill-down of individual sessions
  --help

Examples:
  npm start -- --skipDiscover --max=200 --observeMin=2
  npm start -- --skipDiscover --max=10 --observeSec=30
  npm start -- --skipDiscover --mode=ramp --addIntervalSec=3 --max=50 --observeSec=60
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
    mode: args.mode,
    addIntervalMs: args.addIntervalMs,
    addIntervalSec: args.addIntervalSec,
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

  console.log(
    `═══ XRPL path_find load test (${cfg.mode} → ready → observe) ═══`
  );
  console.log("config:", {
    endpoint: cfg.endpoint,
    walletsFile: cfg.walletsFile,
    mode: cfg.mode,
    addIntervalMs: cfg.mode === "ramp" ? cfg.addIntervalMs : undefined,
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
