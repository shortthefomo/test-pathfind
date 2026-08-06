/**
 * Polls XRPL server health during a load test so we can prove consensus
 * stayed healthy (or record when it degraded).
 *
 * Primary signal: server_state from `server_info`
 *   full / proposing  → healthy (in consensus)
 *   tracking          → transitional
 *   syncing / connected / disconnected → degraded / out of consensus
 *
 * Secondary: `get_counts` (admin) for memory / object pressure under load.
 * If the endpoint is not admin-enabled, counts are skipped without failing.
 */

import { connect, request } from "./xrpl.js";

/** States considered "in consensus" / healthy for a validating or full node. */
export const HEALTHY_SERVER_STATES = new Set(["full", "proposing"]);

/** Known server_state values (lowercase). */
export const SERVER_STATES = [
  "disconnected",
  "connected",
  "syncing",
  "tracking",
  "full",
  "proposing",
];

/**
 * Numeric rank for charting (higher = healthier).
 * Unknown states map to -1.
 */
export function serverStateRank(state) {
  if (state == null) return null;
  const s = String(state).toLowerCase();
  const order = {
    disconnected: 0,
    connected: 1,
    syncing: 2,
    tracking: 3,
    full: 4,
    proposing: 5,
  };
  return order[s] ?? -1;
}

export function isHealthyServerState(state) {
  if (state == null) return false;
  return HEALTHY_SERVER_STATES.has(String(state).toLowerCase());
}

/**
 * Extract compact fields from a server_info result.
 * xrpl-client may return either `{ info: {...} }` or the info object itself.
 */
export function extractServerInfo(raw) {
  const info =
    raw?.info && typeof raw.info === "object"
      ? raw.info
      : raw?.result?.info && typeof raw.result.info === "object"
        ? raw.result.info
        : raw && typeof raw === "object"
          ? raw
          : null;
  if (!info) return null;

  const state = info.server_state != null ? String(info.server_state) : null;
  const validated = info.validated_ledger || null;
  const closed = info.closed_ledger || null;
  const lastClose = info.last_close || null;

  // Normalize state_accounting transitions to numbers
  const accounting = {};
  if (info.state_accounting && typeof info.state_accounting === "object") {
    for (const [k, v] of Object.entries(info.state_accounting)) {
      accounting[k] = {
        duration_us: numOrNull(v?.duration_us),
        transitions: numOrNull(v?.transitions),
      };
    }
  }

  return {
    server_state: state,
    server_state_duration_us: numOrNull(info.server_state_duration_us),
    build_version: info.build_version ?? null,
    hostid: info.hostid ?? null,
    uptime: numOrNull(info.uptime),
    peers: numOrNull(info.peers),
    load_factor: numOrNull(info.load_factor),
    io_latency_ms: numOrNull(info.io_latency_ms),
    validation_quorum: numOrNull(info.validation_quorum),
    complete_ledgers: info.complete_ledgers ?? null,
    jq_trans_overflow: numOrNull(info.jq_trans_overflow),
    peer_disconnects: numOrNull(info.peer_disconnects),
    peer_disconnects_resources: numOrNull(info.peer_disconnects_resources),
    last_close: lastClose
      ? {
          converge_time_s: numOrNull(
            lastClose.converge_time_s ?? lastClose.converge_time
          ),
          proposers: numOrNull(lastClose.proposers),
        }
      : null,
    validated_ledger: validated
      ? {
          seq: numOrNull(validated.seq),
          age: numOrNull(validated.age),
          hash: validated.hash ?? null,
        }
      : null,
    closed_ledger: closed
      ? {
          seq: numOrNull(closed.seq),
          age: numOrNull(closed.age),
        }
      : null,
    state_accounting: accounting,
    amendment_blocked: Boolean(info.amendment_blocked),
  };
}

/**
 * Pathfinding-related get_counts keys (in-memory object tallies under load).
 * rippled may report them as `xrpl::Name` and/or bare `Name`.
 */
export const PATHFIND_COUNT_KEYS = [
  "PathFindTrustLine",
  "PathRequest",
  "STPath",
  "STPathElement",
  "STPathSet",
];

/**
 * AssetCache counters exposed by get_counts (path_find performance work).
 * Cumulative: hits/misses/lines_loaded/rebuilds. Gauge: cache_lines.
 */
export const PATHFIND_CACHE_KEYS = [
  "pathfind_cache_hits",
  "pathfind_cache_misses",
  "pathfind_lines_loaded",
  "pathfind_cache_rebuilds",
  "pathfind_cache_lines",
];

/** All pathfind keys charted together on the object-counts chart. */
export const PATHFIND_CHART_KEYS = [
  ...PATHFIND_COUNT_KEYS,
  ...PATHFIND_CACHE_KEYS,
];

/** Short labels for charts / CLI (match bare type name). */
export const PATHFIND_COUNT_LABELS = {
  PathFindTrustLine: "PathFindTrustLine",
  PathRequest: "PathRequest",
  STPath: "STPath",
  STPathElement: "STPathElement",
  STPathSet: "STPathSet",
  pathfind_cache_hits: "pathfind_cache_hits",
  pathfind_cache_misses: "pathfind_cache_misses",
  pathfind_lines_loaded: "pathfind_lines_loaded",
  pathfind_cache_rebuilds: "pathfind_cache_rebuilds",
  pathfind_cache_lines: "pathfind_cache_lines",
};

/** Chart colors for pathfind series (object counts + cache counters). */
export const PATHFIND_CHART_COLORS = {
  PathRequest: "#38bdf8",
  PathFindTrustLine: "#fbbf24",
  STPath: "#a78bfa",
  STPathElement: "#34d399",
  STPathSet: "#f472b6",
  pathfind_cache_hits: "#22d3ee",
  pathfind_cache_misses: "#fb7185",
  pathfind_lines_loaded: "#f97316",
  pathfind_cache_rebuilds: "#e879f9",
  pathfind_cache_lines: "#a3e635",
};

/**
 * Read a counter that may appear as bare name or `xrpl::name`.
 * @param {object} body
 * @param {string} shortName  e.g. "PathRequest"
 */
export function pickCount(body, shortName) {
  if (!body || shortName == null) return null;
  const candidates = [
    shortName,
    `xrpl::${shortName}`,
    // some builds use fully-qualified variants with different separators
    `xrpld::${shortName}`,
  ];
  for (const k of candidates) {
    if (body[k] != null) {
      const n = numOrNull(body[k]);
      if (n != null) return n;
    }
  }
  // Case-insensitive fallback (keys sometimes vary in casing)
  const want = shortName.toLowerCase();
  const wantNs = `xrpl::${want}`;
  for (const [k, v] of Object.entries(body)) {
    const lk = String(k).toLowerCase();
    if (lk === want || lk === wantNs || lk.endsWith(`::${want}`)) {
      const n = numOrNull(v);
      if (n != null) return n;
    }
  }
  return null;
}

/**
 * Compact interesting counters from get_counts (admin).
 * Response shape varies; keep known high-signal fields + pathfind types.
 */
export function extractGetCounts(raw) {
  const body =
    raw?.result && typeof raw.result === "object" && !raw.Transaction
      ? raw.result
      : raw && typeof raw === "object"
        ? raw
        : null;
  if (!body || body.error) return null;

  const pick = (k) => (body[k] != null ? numOrNull(body[k]) : null);

  const pathfind = {};
  for (const key of PATHFIND_COUNT_KEYS) {
    pathfind[key] = pickCount(body, key);
  }
  // AssetCache counters (exact key names from get_counts / PathRequestManager)
  for (const key of PATHFIND_CACHE_KEYS) {
    pathfind[key] = pick(key) ?? pickCount(body, key);
  }

  return {
    Transaction: pick("Transaction"),
    Ledger: pick("Ledger"),
    NodeObject: pick("NodeObject"),
    STObject: pick("STObject"),
    STTx: pick("STTx"),
    STValidation: pick("STValidation"),
    write_load: pick("write_load"),
    node_writes: pick("node_writes"),
    node_reads_total: pick("node_reads_total"),
    node_reads_hit: pick("node_reads_hit"),
    node_hit_rate: pick("node_hit_rate"),
    ledger_hit_rate: pick("ledger_hit_rate"),
    treenode_cache_size: pick("treenode_cache_size"),
    treenode_track_size: pick("treenode_track_size"),
    historical_perminute: pick("historical_perminute"),
    // Pathfinding in-memory object counts (primary load signal for this tool)
    ...pathfind,
    // Nested copy for consumers that want a group
    pathfind: { ...pathfind },
    // keep string uptime if present
    uptime: body.uptime != null ? String(body.uptime) : null,
  };
}

/**
 * First → last deltas + peak for pathfind get_counts fields.
 * @param {object|null} firstCounts
 * @param {object|null} lastCounts
 * @param {object[]} countSamples  samples that have get_counts
 */
export function summarizePathfindCounts(firstCounts, lastCounts, countSamples = []) {
  const out = {};
  for (const key of PATHFIND_CHART_KEYS) {
    const series = countSamples
      .map((s) => s.get_counts?.[key] ?? s.get_counts?.pathfind?.[key])
      .filter((n) => n != null);
    const first = firstCounts?.[key] ?? firstCounts?.pathfind?.[key] ?? null;
    const last = lastCounts?.[key] ?? lastCounts?.pathfind?.[key] ?? null;
    const max = series.length ? Math.max(...series) : last ?? first;
    const min = series.length ? Math.min(...series) : first ?? last;
    out[key] = {
      first,
      last,
      min,
      max,
      delta:
        first != null && last != null ? last - first : null,
    };
  }
  return out;
}

function numOrNull(v) {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Diff state_accounting transitions between two snapshots.
 * Positive delta = entered that state N more times during the window.
 */
export function accountingTransitionDeltas(first, last) {
  const a = first?.state_accounting || {};
  const b = last?.state_accounting || {};
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const out = {};
  for (const k of keys) {
    const t0 = a[k]?.transitions ?? 0;
    const t1 = b[k]?.transitions ?? 0;
    const d = t1 - t0;
    if (d !== 0) out[k] = d;
  }
  return out;
}

/**
 * Build consensus health summary from a list of monitor samples.
 * @param {object[]} samples  run-relative snapshots from ServerMonitor
 */
export function summarizeConsensus(samples) {
  const ok = (samples || []).filter((s) => s && !s.error && s.server_info);
  const errors = (samples || []).filter((s) => s?.error);

  if (!ok.length) {
    return {
      sampled: samples?.length || 0,
      errorCount: errors.length,
      available: false,
      broke: null,
      verdict: "no samples — server monitor could not collect server_info",
      statesSeen: [],
      stateChanges: [],
      firstState: null,
      lastState: null,
      timeInHealthyMs: 0,
      timeInUnhealthyMs: 0,
      minValidatedSeq: null,
      maxValidatedSeq: null,
      ledgerAdvance: null,
      maxLedgerAge: null,
      maxLoadFactor: null,
      maxIoLatencyMs: null,
      maxConvergeTimeS: null,
      minProposers: null,
      maxProposers: null,
      accountingDeltas: {},
      getCountsAvailable: false,
      pathfindCounts: null,
      series: [],
    };
  }

  const stateChanges = [];
  let prevState = null;
  let timeInHealthyMs = 0;
  let timeInUnhealthyMs = 0;
  const statesSeen = new Set();

  for (let i = 0; i < ok.length; i++) {
    const s = ok[i];
    const state = s.server_info.server_state;
    if (state) statesSeen.add(String(state).toLowerCase());
    if (prevState != null && state != null && String(state).toLowerCase() !== String(prevState).toLowerCase()) {
      stateChanges.push({
        tMs: s.tMs,
        from: prevState,
        to: state,
        phase: s.phase || null,
      });
    }
    prevState = state;

    // Duration until next sample (or 0 for last)
    const nextT = i + 1 < ok.length ? ok[i + 1].tMs : s.tMs;
    const dt = Math.max(0, nextT - s.tMs);
    if (isHealthyServerState(state)) timeInHealthyMs += dt;
    else timeInUnhealthyMs += dt;
  }

  const first = ok[0];
  const last = ok[ok.length - 1];
  const firstState = first.server_info.server_state;
  const lastState = last.server_info.server_state;

  // Broke = any sample not healthy, or any transition out of healthy
  const unhealthySamples = ok.filter(
    (s) => !isHealthyServerState(s.server_info.server_state)
  );
  const leftHealthy = stateChanges.some(
    (c) =>
      isHealthyServerState(c.from) && !isHealthyServerState(c.to)
  );
  const broke = unhealthySamples.length > 0 || leftHealthy;

  const seqs = ok
    .map((s) => s.server_info.validated_ledger?.seq)
    .filter((n) => n != null);
  const ages = ok
    .map((s) => s.server_info.validated_ledger?.age)
    .filter((n) => n != null);
  const loads = ok
    .map((s) => s.server_info.load_factor)
    .filter((n) => n != null);
  const ios = ok
    .map((s) => s.server_info.io_latency_ms)
    .filter((n) => n != null);
  const converges = ok
    .map((s) => s.server_info.last_close?.converge_time_s)
    .filter((n) => n != null);
  const proposers = ok
    .map((s) => s.server_info.last_close?.proposers)
    .filter((n) => n != null);

  const minSeq = seqs.length ? Math.min(...seqs) : null;
  const maxSeq = seqs.length ? Math.max(...seqs) : null;

  const countsOk = ok.filter((s) => s.get_counts);
  const accountingDeltas = accountingTransitionDeltas(
    first.server_info,
    last.server_info
  );

  let verdict;
  if (broke) {
    const badStates = [...new Set(unhealthySamples.map((s) => s.server_info.server_state))];
    verdict =
      `CONSENSUS DEGRADED — left healthy state` +
      (badStates.length ? ` (saw: ${badStates.join(", ")})` : "") +
      (stateChanges.length
        ? `; ${stateChanges.length} state change(s)`
        : "");
  } else {
    verdict =
      `CONSENSUS OK — stayed ${String(firstState || "healthy").toUpperCase()}` +
      ` for entire run (${ok.length} samples, ${stateChanges.length} state change(s))`;
  }

  const pathfindCounts = summarizePathfindCounts(
    first.get_counts,
    last.get_counts,
    countsOk
  );

  // Compact series for charts / UI
  const series = ok.map((s) => {
    const gc = s.get_counts;
    const pathfind = {};
    for (const key of PATHFIND_CHART_KEYS) {
      pathfind[key] = gc?.[key] ?? gc?.pathfind?.[key] ?? null;
    }
    return {
      tMs: s.tMs,
      phase: s.phase || null,
      server_state: s.server_info.server_state,
      stateRank: serverStateRank(s.server_info.server_state),
      healthy: isHealthyServerState(s.server_info.server_state),
      validatedSeq: s.server_info.validated_ledger?.seq ?? null,
      ledgerAge: s.server_info.validated_ledger?.age ?? null,
      loadFactor: s.server_info.load_factor ?? null,
      ioLatencyMs: s.server_info.io_latency_ms ?? null,
      peers: s.server_info.peers ?? null,
      convergeTimeS: s.server_info.last_close?.converge_time_s ?? null,
      proposers: s.server_info.last_close?.proposers ?? null,
      // get_counts highlights
      txInMemory: gc?.Transaction ?? null,
      nodeObject: gc?.NodeObject ?? null,
      writeLoad: gc?.write_load ?? null,
      // pathfind object counts (in-memory)
      PathFindTrustLine: pathfind.PathFindTrustLine,
      PathRequest: pathfind.PathRequest,
      STPath: pathfind.STPath,
      STPathElement: pathfind.STPathElement,
      STPathSet: pathfind.STPathSet,
      // AssetCache counters
      pathfind_cache_hits: pathfind.pathfind_cache_hits,
      pathfind_cache_misses: pathfind.pathfind_cache_misses,
      pathfind_lines_loaded: pathfind.pathfind_lines_loaded,
      pathfind_cache_rebuilds: pathfind.pathfind_cache_rebuilds,
      pathfind_cache_lines: pathfind.pathfind_cache_lines,
      pathfind,
    };
  });

  return {
    sampled: samples.length,
    okSamples: ok.length,
    errorCount: errors.length,
    available: true,
    broke,
    verdict,
    statesSeen: [...statesSeen],
    stateChanges,
    firstState,
    lastState,
    timeInHealthyMs,
    timeInUnhealthyMs,
    minValidatedSeq: minSeq,
    maxValidatedSeq: maxSeq,
    ledgerAdvance: minSeq != null && maxSeq != null ? maxSeq - minSeq : null,
    maxLedgerAge: ages.length ? Math.max(...ages) : null,
    maxLoadFactor: loads.length ? Math.max(...loads) : null,
    maxIoLatencyMs: ios.length ? Math.max(...ios) : null,
    maxConvergeTimeS: converges.length ? Math.max(...converges) : null,
    minProposers: proposers.length ? Math.min(...proposers) : null,
    maxProposers: proposers.length ? Math.max(...proposers) : null,
    accountingDeltas,
    getCountsAvailable: countsOk.length > 0,
    getCountsSamples: countsOk.length,
    pathfindCounts,
    series,
    // First/last full extracts for forensics
    first: compactSample(first),
    last: compactSample(last),
  };
}

function compactSample(s) {
  if (!s) return null;
  return {
    tMs: s.tMs,
    phase: s.phase || null,
    server_info: s.server_info,
    get_counts: s.get_counts || null,
    error: s.error || null,
  };
}

/**
 * Live monitor: dedicated WS connection, periodic server_info + get_counts.
 */
export class ServerMonitor {
  /**
   * @param {object} opts
   * @param {string} opts.endpoint
   * @param {() => number} opts.getElapsedMs  run-relative ms
   * @param {() => string} [opts.getPhase]
   * @param {number} [opts.intervalMs=2000]
   * @param {(sample: object) => void} [opts.onSample]
   * @param {(msg: string) => void} [opts.onWarn]
   */
  constructor(opts) {
    this.endpoint = opts.endpoint;
    this.getElapsedMs = opts.getElapsedMs;
    this.getPhase = opts.getPhase || (() => null);
    this.intervalMs = Math.max(500, Number(opts.intervalMs) || 2_000);
    this.onSample = typeof opts.onSample === "function" ? opts.onSample : null;
    this.onWarn = typeof opts.onWarn === "function" ? opts.onWarn : null;

    /** @type {object[]} */
    this.samples = [];
    this._client = null;
    this._timer = null;
    this._running = false;
    this._inFlight = false;
    this._getCountsDisabled = false;
    this._started = false;
    this._stopped = false;
  }

  get latest() {
    return this.samples.length ? this.samples[this.samples.length - 1] : null;
  }

  async start() {
    if (this._started) return;
    this._started = true;
    this._running = true;
    try {
      this._client = await connect(this.endpoint, {
        maxConnectionAttempts: 3,
        connectAttemptTimeoutSeconds: 5,
      });
    } catch (err) {
      this._warn(`server monitor connect failed: ${err.message}`);
      this._pushError(err.message);
      // Still try interval in case it comes up later
    }

    // Immediate sample, then interval
    await this.poll();
    this._timer = setInterval(() => {
      this.poll().catch(() => {});
    }, this.intervalMs);
    // Don't keep process alive solely for the timer
    if (this._timer?.unref) this._timer.unref();
  }

  async stop() {
    if (this._stopped) return;
    this._stopped = true;
    this._running = false;
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    // Final sample (allow one more poll even though _running is false)
    this._running = true;
    try {
      await this.poll();
    } catch {
      /* ignore */
    }
    this._running = false;
    if (this._client) {
      try {
        this._client.close?.();
      } catch {
        /* ignore */
      }
      this._client = null;
    }
  }

  async poll() {
    if (!this._running && this._started && !this._client) return;
    if (this._inFlight) return;
    this._inFlight = true;
    const tMs = this.getElapsedMs();
    const phase = this.getPhase();

    try {
      if (!this._client) {
        try {
          this._client = await connect(this.endpoint, {
            maxConnectionAttempts: 2,
            connectAttemptTimeoutSeconds: 4,
          });
        } catch (err) {
          this._pushError(err.message, tMs, phase);
          return;
        }
      }

      let infoRaw;
      try {
        infoRaw = await request(this._client, { command: "server_info" }, {
          timeoutSeconds: 15,
        });
      } catch (err) {
        this._pushError(`server_info: ${err.message}`, tMs, phase);
        return;
      }

      const server_info = extractServerInfo(infoRaw);
      if (!server_info) {
        this._pushError("server_info: empty/unparseable result", tMs, phase);
        return;
      }

      let get_counts = null;
      if (!this._getCountsDisabled) {
        try {
          // min_count: 0 so small pathfind object tallies are not filtered out
          const countsRaw = await request(
            this._client,
            { command: "get_counts", min_count: 0 },
            { timeoutSeconds: 15 }
          );
          get_counts = extractGetCounts(countsRaw);
          if (!get_counts) {
            // Parse failed or error body — disable further attempts
            this._getCountsDisabled = true;
            this._warn(
              "get_counts unavailable or unparseable (admin RPC?) — continuing with server_info only"
            );
          }
        } catch (err) {
          this._getCountsDisabled = true;
          this._warn(
            `get_counts failed (${err.message}) — continuing with server_info only`
          );
        }
      }

      const sample = {
        tMs,
        phase,
        server_info,
        get_counts,
        error: null,
      };
      this.samples.push(sample);
      if (this.onSample) {
        try {
          this.onSample(sample);
        } catch {
          /* ignore */
        }
      }
    } finally {
      this._inFlight = false;
    }
  }

  _pushError(message, tMs = null, phase = null) {
    const sample = {
      tMs: tMs ?? this.getElapsedMs(),
      phase: phase ?? this.getPhase(),
      server_info: null,
      get_counts: null,
      error: message,
    };
    this.samples.push(sample);
    if (this.onSample) {
      try {
        this.onSample(sample);
      } catch {
        /* ignore */
      }
    }
  }

  _warn(msg) {
    if (this.onWarn) this.onWarn(msg);
    else console.warn(`[server-monitor] ${msg}`);
  }

  /** Snapshot suitable for progress SSE (latest + compact series + summary). */
  progressView() {
    const summary = summarizeConsensus(this.samples);
    const latest = this.latest;
    return {
      available: summary.available,
      broke: summary.broke,
      verdict: summary.verdict,
      firstState: summary.firstState,
      lastState: summary.lastState,
      statesSeen: summary.statesSeen,
      stateChanges: summary.stateChanges,
      series: summary.series,
      getCountsAvailable: summary.getCountsAvailable,
      pathfindCounts: summary.pathfindCounts,
      latest: latest
        ? {
            tMs: latest.tMs,
            phase: latest.phase,
            server_state: latest.server_info?.server_state ?? null,
            healthy: latest.server_info
              ? isHealthyServerState(latest.server_info.server_state)
              : false,
            validatedSeq: latest.server_info?.validated_ledger?.seq ?? null,
            ledgerAge: latest.server_info?.validated_ledger?.age ?? null,
            loadFactor: latest.server_info?.load_factor ?? null,
            peers: latest.server_info?.peers ?? null,
            convergeTimeS: latest.server_info?.last_close?.converge_time_s ?? null,
            proposers: latest.server_info?.last_close?.proposers ?? null,
            txInMemory: latest.get_counts?.Transaction ?? null,
            writeLoad: latest.get_counts?.write_load ?? null,
            PathFindTrustLine: latest.get_counts?.PathFindTrustLine ?? null,
            PathRequest: latest.get_counts?.PathRequest ?? null,
            STPath: latest.get_counts?.STPath ?? null,
            STPathElement: latest.get_counts?.STPathElement ?? null,
            STPathSet: latest.get_counts?.STPathSet ?? null,
            pathfind_cache_hits: latest.get_counts?.pathfind_cache_hits ?? null,
            pathfind_cache_misses: latest.get_counts?.pathfind_cache_misses ?? null,
            pathfind_lines_loaded: latest.get_counts?.pathfind_lines_loaded ?? null,
            pathfind_cache_rebuilds: latest.get_counts?.pathfind_cache_rebuilds ?? null,
            pathfind_cache_lines: latest.get_counts?.pathfind_cache_lines ?? null,
            pathfind: latest.get_counts?.pathfind || null,
            error: latest.error || null,
          }
        : null,
    };
  }
}
