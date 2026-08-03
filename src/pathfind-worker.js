/**
 * Long-lived path_find worker: one XrplClient, one open path_find, continuous
 * follow-up collection until stop().
 *
 * Used by the burst load test (open many workers in parallel, keep monitoring).
 */

import { countPathResults } from "./metrics.js";
import {
  pickPathFindCandidates,
  buildPathFindRequest,
} from "./pathfind-session.js";
import { connect, request, sleep } from "./xrpl.js";

/**
 * @typedef {object} PathFindWorker
 * @property {string} sessionId
 * @property {number} concurrencyAtStart
 * @property {() => number} getOpenCount  live open worker count
 * @property {() => Promise<object>} stop
 * @property {object} state  mutable metrics bag
 */

/**
 * Open a new client + path_find create. Resolves when initial reply arrives
 * (or all token attempts fail). Follow-ups keep streaming until stop().
 *
 * @param {object} opts
 * @returns {Promise<PathFindWorker>}
 */
export async function startPathFindWorker({
  endpoint,
  sourceWallet,
  destWallet,
  sessionId,
  concurrencyAtStart,
  getOpenCount,
  onEvent,
  selfPathFind = true,
  maxTokenAttempts = 3,
}) {
  const tokenWallet = selfPathFind ? sourceWallet : destWallet;
  const candidates = pickPathFindCandidates(tokenWallet, maxTokenAttempts);

  const state = {
    sessionId,
    source: sourceWallet.account,
    destination: selfPathFind ? sourceWallet.account : destWallet.account,
    destination_amount: null,
    send_max: null,
    concurrencyAtStart,
    startedAt: new Date().toISOString(),
    t0: Date.now(),
    initial: null,
    followUps: [],
    errors: [],
    attempts: [],
    closed: false,
    failed: false,
    error: null,
  };

  let client = null;
  let followUpHandler = null;
  let stopped = false;
  let stopResolve;
  const stoppedPromise = new Promise((r) => {
    stopResolve = r;
  });

  async function destroyClient() {
    if (!client) return;
    if (followUpHandler) {
      try {
        if (typeof client.removeListener === "function") {
          client.removeListener("path", followUpHandler);
        } else if (typeof client.off === "function") {
          client.off("path", followUpHandler);
        }
      } catch {
        /* ignore */
      }
    }
    try {
      client.close();
    } catch {
      /* ignore */
    }
    try {
      client.destroy?.();
    } catch {
      /* ignore */
    }
    client = null;
  }

  async function tryCreate(candidate, attempt) {
    await destroyClient();
    client = await connect(endpoint);

    const req = buildPathFindRequest(sourceWallet, destWallet, candidate, {
      self: selfPathFind,
    });
    state.destination_amount = candidate.destination_amount;
    state.send_max = candidate.send_max;
    state.destination = req.destination_account;

    followUpHandler = (msg) => {
      if (stopped) return;
      if (msg?.type !== "path_find") return;
      if (!state.initial) return;

      const receivedAt = Date.now();
      const counts = countPathResults(msg);
      const openCount = typeof getOpenCount === "function" ? getOpenCount() : null;
      const entry = {
        seq: state.followUps.length + 1,
        receivedAt,
        offsetMs: receivedAt - state.t0,
        sincePreviousMs:
          state.followUps.length > 0
            ? receivedAt - state.followUps[state.followUps.length - 1].receivedAt
            : state.initial
              ? receivedAt - state.initial.receivedAt
              : null,
        alternatives: counts.alternatives,
        pathsComputed: counts.pathsComputed,
        fullReply: counts.fullReply,
        openCount,
      };
      state.followUps.push(entry);
      onEvent?.({
        type: "follow_up",
        sessionId,
        ...entry,
        concurrencyAtStart,
      });
    };
    client.on("path", followUpHandler);

    // High-res timing: send → first WS reply for path_find create
    const sendAt = Date.now();
    const sendHr = performance.now();
    state.t0 = sendAt;
    try {
      const initialRes = await request(client, req, {
        timeoutSeconds: 90,
        noReplayAfterReconnect: true,
      });
      const receivedAt = Date.now();
      const latencyMs = performance.now() - sendHr;
      const counts = countPathResults(initialRes);
      state.initial = {
        receivedAt,
        latencyMs,
        sendAt,
        alternatives: counts.alternatives,
        pathsComputed: counts.pathsComputed,
        fullReply: counts.fullReply,
      };
      state.attempts.push({
        attempt,
        ok: true,
        latencyMs: state.initial.latencyMs,
        destination_amount: candidate.destination_amount,
        send_max: candidate.send_max,
      });
      onEvent?.({
        type: "initial",
        sessionId,
        attempt,
        latencyMs: state.initial.latencyMs,
        alternatives: counts.alternatives,
        pathsComputed: counts.pathsComputed,
        fullReply: counts.fullReply,
        destination_amount: candidate.destination_amount,
        send_max: candidate.send_max,
        concurrencyAtStart,
        // Use intended open# at start (worker not yet in parent list while creating)
        openCount: concurrencyAtStart,
        source_account: req.source_account,
        destination_account: req.destination_account,
      });
      return true;
    } catch (err) {
      state.attempts.push({
        attempt,
        ok: false,
        message: err.message,
        destination_amount: candidate.destination_amount,
        send_max: candidate.send_max,
      });
      state.errors.push({
        phase: "initial",
        attempt,
        message: err.message,
        at: Date.now(),
      });
      onEvent?.({
        type: "error",
        sessionId,
        phase: "initial",
        attempt,
        message: err.message,
        destination_amount: candidate.destination_amount,
        send_max: candidate.send_max,
        concurrencyAtStart,
      });
      try {
        await request(
          client,
          { command: "path_find", subcommand: "close" },
          { timeoutSeconds: 10, noReplayAfterReconnect: true }
        );
      } catch {
        /* ignore */
      }
      await destroyClient();
      return false;
    }
  }

  let opened = false;
  for (let attempt = 0; attempt < candidates.length; attempt++) {
    if (stopped) break;
    const ok = await tryCreate(candidates[attempt], attempt);
    if (ok) {
      opened = true;
      break;
    }
    await sleep(100 + attempt * 80);
  }

  if (!opened) {
    state.failed = true;
    state.error = "path_find create failed for all token candidates";
    state.closed = true;
    await destroyClient();
    stopResolve();
    const worker = {
      sessionId,
      concurrencyAtStart,
      getOpenCount,
      state,
      async stop() {
        return state;
      },
    };
    return worker;
  }

  async function stop() {
    if (stopped) {
      await stoppedPromise;
      return state;
    }
    stopped = true;
    try {
      if (client) {
        await request(
          client,
          { command: "path_find", subcommand: "close" },
          { timeoutSeconds: 15, noReplayAfterReconnect: true }
        );
        state.closed = true;
      }
    } catch (err) {
      state.errors.push({ phase: "close", message: err.message, at: Date.now() });
    }
    await destroyClient();
    state.endedAt = new Date().toISOString();
    state.durationMs = Date.now() - state.t0;
    stopResolve();
    return state;
  }

  return {
    sessionId,
    concurrencyAtStart,
    getOpenCount,
    state,
    stop,
  };
}
