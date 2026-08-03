/** Default configuration for wallet discovery and path_find load testing. */

export const DEFAULTS = {
  /** WebSocket endpoint of the target rippled / clio node */
  endpoint: "ws://192.168.12.238:6006",

  /** Minimum trustlines that must have a non-zero balance */
  minTrustlinesWithBalance: 200,

  /** How many qualifying wallets to collect for the load test pool */
  walletPoolSize: 20,

  /**
   * Cap: open this many concurrent path_finds (burst all-at-once, or ramp up
   * one-by-one until this ceiling).
   */
  maxConcurrency: 50,

  /**
   * Open strategy:
   *   "burst" — fire all path_find creates in parallel, observe, close all
   *   "ramp"  — ramp up (+1 / addIntervalMs) → hold at cap for observeMs →
   *             ramp down (−1 / same interval)
   */
  mode: "ramp",

  /**
   * Ramp spacing (mode=ramp only): after each path_find fully opens (create
   * reply), wait this long before opening the next; same interval between
   * closes on the way down. Default 1s. CLI: --addIntervalSec / --addIntervalMs.
   */
  addIntervalMs: 1_000,

  /**
   * After all sessions are updating, keep them open and graph responses
   * over this window (default 30s). CLI: --observeMin / --observeSec.
   */
  observeMs: 30_000,

  /**
   * Max time to wait for every open session to receive at least one async
   * path_find update before starting the observe window.
   */
  readyTimeoutMs: 2 * 60 * 1000,

  /** How often to refresh the live time-series dashboard during observe */
  dashboardIntervalMs: 10_000,

  /** @deprecated alias of observeMs for older flags */
  holdAtPeakMs: 30_000,

  /** @deprecated old ratchet levels — ignored */
  concurrencyLevels: [10, 25, 50, 75, 100, 150, 200],

  settleMs: 10_000,

  /** Max candidates to inspect during discovery before giving up */
  maxCandidatesToScan: 2_000,

  /** Parallelism when checking candidate accounts for trustline counts */
  discoveryConcurrency: 8,

  /** Where discovered wallets are cached */
  walletsFile: "data/wallets.json",

  /** Where load-test metrics are written */
  resultsDir: "data/results",

  /**
   * Well-known mainnet issuers used as seeds to discover active holders.
   * account_lines on these returns peer accounts that often hold many assets.
   */
  seedIssuers: [
    "rvYAfWj5gh67oV6fW32ZzP3Aw4Eubs59B", // Bitstamp
    "rhub8VRN55s94qWKDv6jmDy1pUykJzF3wq", // GateHub
    "rKiCet8SdvWxPXnAgYarFUXMh1zCPz432Y", // RippleFox
    "rcA8X3TVMST1n3CJeAdGk1RdRCHii7N2h", // GateHub Fifth
    "rsoLo2S1kiGeCcn6hCUXVrCpGMWLrRrLZz", // Sologenic
    "rLHzPsX6oXkzU2qL12kHCH8G8cnZv1rBJh", // Bitso
    "r9Dr5xwkeLegBeXq6ujinjSBLQzQ1zQGjH", // Ripple Singapore
    "razqQKzJRdB4UxFPWf5NEpEG3WMkmwgcXA", // Ripple Malaysia
    "rchGBxcD1A1C2tdxF6papQYZ8kjRKMYcL", // Gatehub BTC
    "rXUMMaPpZq4xaMU4MCBeXmxgfTQVnQBc", // Alloy / EUR issuer cluster
  ],

  /** How deep to page each seed issuer while hunting high-OwnerCount peers */
  pagesPerIssuer: 50,

  /**
   * Use self path_find (source === destination). More reliable on many nodes
   * and still fully exercises the pathfinding engine. Set false for A→B.
   */
  selfPathFind: true,

  /**
   * Major DEX books used as the primary seed for market-maker discovery.
   * Offer posters on these books are far more likely to hold 200+ funded lines
   * than random gateway trustline holders.
   */
  seedBooks: [
    { currency: "USD", issuer: "rvYAfWj5gh67oV6fW32ZzP3Aw4Eubs59B" }, // Bitstamp USD
    { currency: "USD", issuer: "rhub8VRN55s94qWKDv6jmDy1pUykJzF3wq" }, // GateHub USD
    { currency: "EUR", issuer: "rhub8VRN55s94qWKDv6jmDy1pUykJzF3wq" }, // GateHub EUR
    { currency: "BTC", issuer: "rchGBxcD1A1C2tdxF6papQYZ8kjRKMYcL" }, // GateHub BTC
    { currency: "BTC", issuer: "rvYAfWj5gh67oV6fW32ZzP3Aw4Eubs59B" }, // Bitstamp BTC
    { currency: "USD", issuer: "rKiCet8SdvWxPXnAgYarFUXMh1zCPz432Y" }, // RippleFox USD
    { currency: "CNY", issuer: "rKiCet8SdvWxPXnAgYarFUXMh1zCPz432Y" }, // RippleFox CNY
    { currency: "534F4C4F00000000000000000000000000000000", issuer: "rsoLo2S1kiGeCcn6hCUXVrCpGMWLrRrLZz" }, // SOLO
  ],
};

/**
 * Parse CLI flags of the form --key=value or --key value.
 * Booleans: --flag / --no-flag
 */
export function parseArgs(argv = process.argv.slice(2)) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const body = a.slice(2);
    if (body.startsWith("no-")) {
      out[body.slice(3)] = false;
      continue;
    }
    if (body.includes("=")) {
      const [k, ...rest] = body.split("=");
      out[k] = rest.join("=");
      continue;
    }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      out[body] = next;
      i++;
    } else {
      out[body] = true;
    }
  }
  return out;
}

export function resolveConfig(overrides = {}) {
  // Drop undefined so explicit `args.foo || undefined` does not wipe defaults.
  const clean = Object.fromEntries(
    Object.entries(overrides).filter(([, v]) => v !== undefined)
  );
  const cfg = { ...DEFAULTS, ...clean };

  if (typeof cfg.concurrencyLevels === "string") {
    cfg.concurrencyLevels = cfg.concurrencyLevels
      .split(",")
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n) && n > 0);
  }
  if (typeof cfg.observeMs === "string") cfg.observeMs = Number(cfg.observeMs);
  if (cfg.observeMin !== undefined && cfg.observeMin !== null) {
    // convenience: --observeMin=2 → 2 minutes
    cfg.observeMs = Number(cfg.observeMin) * 60 * 1000;
  }
  if (cfg.observeSec !== undefined && cfg.observeSec !== null) {
    cfg.observeMs = Number(cfg.observeSec) * 1000;
  }
  if (cfg.readyTimeoutSec !== undefined && cfg.readyTimeoutSec !== null) {
    cfg.readyTimeoutMs = Number(cfg.readyTimeoutSec) * 1000;
  }
  if (cfg.readyTimeoutMin !== undefined && cfg.readyTimeoutMin !== null) {
    cfg.readyTimeoutMs = Number(cfg.readyTimeoutMin) * 60 * 1000;
  }
  // --holdAtPeakSec / --holdAtPeakMs still accepted as aliases for observe window
  if (cfg.holdAtPeakSec !== undefined && cfg.holdAtPeakSec !== null) {
    cfg.holdAtPeakMs = Number(cfg.holdAtPeakSec) * 1000;
    cfg.observeMs = cfg.holdAtPeakMs;
  }
  if (cfg.holdAtPeakMs !== undefined && cfg.holdAtPeakMs !== null && clean.holdAtPeakMs !== undefined) {
    cfg.observeMs = Number(cfg.holdAtPeakMs);
  }
  if (cfg.addIntervalSec !== undefined && cfg.addIntervalSec !== null) {
    cfg.addIntervalMs = Number(cfg.addIntervalSec) * 1000;
  }
  // aliases
  if (cfg.max !== undefined) cfg.maxConcurrency = Number(cfg.max);
  if (cfg.cutoff !== undefined) cfg.maxConcurrency = Number(cfg.cutoff);

  // mode: accept ramp / burst; infer ramp if addInterval was explicitly set
  if (typeof cfg.mode === "string") {
    cfg.mode = cfg.mode.toLowerCase().trim();
  }
  const intervalExplicit =
    clean.addIntervalMs !== undefined || clean.addIntervalSec !== undefined;
  if (clean.mode === undefined && intervalExplicit && Number(cfg.addIntervalMs) > 0) {
    cfg.mode = "ramp";
  } else if (cfg.mode !== "burst" && cfg.mode !== "ramp") {
    cfg.mode = "burst";
  }
  if (cfg.mode === "ramp") {
    const interval = Number(cfg.addIntervalMs);
    if (!Number.isFinite(interval) || interval < 0) cfg.addIntervalMs = 1_000;
  }

  for (const key of [
    "walletPoolSize",
    "minTrustlinesWithBalance",
    "settleMs",
    "maxCandidatesToScan",
    "discoveryConcurrency",
    "observeMs",
    "readyTimeoutMs",
    "dashboardIntervalMs",
    "maxConcurrency",
    "addIntervalMs",
    "holdAtPeakMs",
  ]) {
    if (typeof cfg[key] === "string") cfg[key] = Number(cfg[key]);
  }

  return cfg;
}
