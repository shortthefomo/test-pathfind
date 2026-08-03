/**
 * One path_find create per XrplClient connection.
 *
 * XRPL docs (path_find create):
 *   - Only one open path_find per WebSocket connection (extra creates replace it).
 *   - destination_amount special case value "-1" means "deliver as much as possible",
 *     constrained by send_max when provided.
 *
 * On this node, fixed positive destination values (e.g. "0.001") frequently return
 * error "internal". Using value "-1" + a modest send_max is reliable.
 *
 * Tokens always come from the wallet's funded trustlines (not hardcoded pairs).
 * send_max uses a small amount — never the full trustline balance.
 */

import { countPathResults } from "./metrics.js";
import { connect, request, sleep, shuffle } from "./xrpl.js";

/** Modest default send_max in XRP drops (1 XRP). Not a full balance. */
export const DEFAULT_SEND_MAX_XRP_DROPS = "1000000";

/**
 * Resolve the issuer for a trustline token from the owner's perspective.
 *   balance > 0  → owner holds IOU issued by peer  → issuer = line.account
 *   balance < 0  → peer holds IOU issued by owner  → issuer = ownerAccount
 */
export function resolveIssuer(line, ownerAccount) {
  const bal = Number(line?.balance);
  if (Number.isFinite(bal) && bal < 0) return ownerAccount;
  return line.account;
}

/**
 * Small send_max value for a token — never the full balance.
 * Uses a fixed modest amount so pathfinding stays bounded.
 */
export function modestTokenValue(_line) {
  // Fixed small spend; do not use full balances for load-test path_find.
  return "1";
}

/**
 * Build destination_amount from a trustline using the path_find special case
 * value "-1" (max deliverable under send_max).
 */
export function trustlineToDestinationAmount(line, ownerAccount) {
  if (!line?.currency || !line?.account) {
    throw new Error("trustline missing currency/account (counterparty)");
  }
  if (!ownerAccount) {
    throw new Error("ownerAccount required to resolve token issuer");
  }
  return {
    currency: line.currency,
    issuer: resolveIssuer(line, ownerAccount),
    value: "-1",
  };
}

/**
 * Build send_max from a held trustline (small value) or fall back to XRP drops.
 */
export function buildSendMax(line, ownerAccount) {
  if (line?.currency && line?.account) {
    return {
      currency: line.currency,
      issuer: resolveIssuer(line, ownerAccount),
      value: modestTokenValue(line),
    };
  }
  return DEFAULT_SEND_MAX_XRP_DROPS;
}

/**
 * Pick path_find request candidates from a wallet's funded trustlines.
 *
 * Each candidate:
 *   destination_amount = { currency, issuer, value: "-1" }  // from a held token
 *   send_max           = small amount of another held token, or 1 XRP
 *
 * @returns {Array<{ destination_amount, send_max, destLine, sendLine }>}
 */
export function pickPathFindCandidates(wallet, count = 3) {
  const owner = wallet?.account;
  const lines = [...(wallet?.fundedTrustlines || [])].filter(
    (l) => l?.currency && l?.account
  );
  if (!owner || lines.length === 0) {
    throw new Error(
      `wallet ${owner || "?"} has no fundedTrustlines to path_find with`
    );
  }

  // Prefer tokens the wallet holds (balance > 0)
  const held = lines.filter((l) => Number(l.balance) > 0);
  const pool = held.length > 0 ? held : lines;
  const destLines = shuffle([...pool]).slice(0, Math.min(count, pool.length));

  return destLines.map((destLine) => {
    // Prefer a different held token as send_max source when available
    const others = pool.filter(
      (l) =>
        !(l.currency === destLine.currency && l.account === destLine.account)
    );
    const sendLine = others.length > 0 ? shuffle(others)[0] : null;

    return {
      destination_amount: trustlineToDestinationAmount(destLine, owner),
      send_max: buildSendMax(sendLine, owner),
      destLine,
      sendLine,
    };
  });
}

/**
 * Build a path_find create request (docs shape).
 *
 * @param {object} sourceWallet
 * @param {object} destWallet
 * @param {{ destination_amount, send_max }} amounts
 * @param {{ self?: boolean }} [opts]
 */
export function buildPathFindRequest(
  sourceWallet,
  destWallet,
  amounts,
  { self = true } = {}
) {
  const req = {
    command: "path_find",
    subcommand: "create",
    source_account: sourceWallet.account,
    destination_account: self ? sourceWallet.account : destWallet.account,
    destination_amount: amounts.destination_amount,
  };
  // send_max required for reliable path_find with value "-1" on this node
  if (amounts.send_max != null) {
    req.send_max = amounts.send_max;
  }
  return req;
}

/**
 * Run a single path_find session: new client → create → measure initial +
 * follow-ups for observeMs → close → destroy client.
 */
export async function runPathFindSession({
  endpoint,
  sourceWallet,
  destWallet,
  observeMs,
  sessionId,
  onEvent,
  selfPathFind = true,
  maxTokenAttempts = 3,
}) {
  // Self: tokens from source. Cross: destination_amount from dest (what they receive).
  const tokenWallet = selfPathFind ? sourceWallet : destWallet;
  const candidates = pickPathFindCandidates(tokenWallet, maxTokenAttempts);

  const session = {
    sessionId,
    source: sourceWallet.account,
    destination: selfPathFind ? sourceWallet.account : destWallet.account,
    destination_amount: null,
    send_max: null,
    tokenWallet: tokenWallet.account,
    startedAt: new Date().toISOString(),
    t0: Date.now(),
    initial: null,
    followUps: [],
    errors: [],
    closed: false,
    attempts: [],
  };

  let lastErr;

  for (let attempt = 0; attempt < candidates.length; attempt++) {
    const candidate = candidates[attempt];
    const req = buildPathFindRequest(sourceWallet, destWallet, candidate, {
      self: selfPathFind,
    });
    session.destination_amount = candidate.destination_amount;
    session.send_max = candidate.send_max;
    session.destination = req.destination_account;

    // NEW XrplClient for every path_find create (including retries)
    const result = await attemptPathFindOnNewClient({
      endpoint,
      req,
      observeMs,
      sessionId,
      attempt,
      onEvent,
      collectFollowUps: true,
    });

    session.attempts.push({
      attempt,
      destination_amount: candidate.destination_amount,
      send_max: candidate.send_max,
      ok: result.ok,
      latencyMs: result.initial?.latencyMs,
      message: result.error?.message,
    });

    if (result.ok) {
      session.t0 = result.t0;
      session.initial = result.initial;
      session.followUps = result.followUps;
      session.closed = result.closed;
      if (result.closeError) {
        session.errors.push({
          phase: "close",
          message: result.closeError,
          at: Date.now(),
        });
      }
      lastErr = null;
      break;
    }

    lastErr = result.error;
    session.errors.push({
      phase: "initial",
      attempt,
      message: result.error?.message || "unknown",
      destination_amount: candidate.destination_amount,
      send_max: candidate.send_max,
      at: Date.now(),
    });
    onEvent?.({
      type: "error",
      sessionId,
      phase: "initial",
      attempt,
      message: result.error?.message,
      destination_amount: candidate.destination_amount,
      send_max: candidate.send_max,
    });

    await sleep(100 + attempt * 100);
  }

  if (!session.initial) {
    throw (
      lastErr ||
      new Error(
        `path_find create failed for ${candidates.length} trustline token(s) on ${tokenWallet.account}`
      )
    );
  }

  session.endedAt = new Date().toISOString();
  session.durationMs = Date.now() - session.t0;
  session.summary = summarizeSession(session);
  return session;
}

/**
 * Single path_find create on a brand-new XrplClient.
 * Client is always closed/destroyed before return.
 */
async function attemptPathFindOnNewClient({
  endpoint,
  req,
  observeMs,
  sessionId,
  attempt,
  onEvent,
  collectFollowUps,
}) {
  const client = await connect(endpoint);
  const followUps = [];
  let initialResolved = false;
  const t0 = Date.now();

  const followUpHandler = (msg) => {
    // Docs: async updates have top-level type === "path_find"
    if (msg?.type !== "path_find") return;
    if (!initialResolved) return;

    const receivedAt = Date.now();
    const counts = countPathResults(msg);
    const entry = {
      seq: followUps.length + 1,
      receivedAt,
      offsetMs: receivedAt - t0,
      sincePreviousMs:
        followUps.length > 0
          ? receivedAt - followUps[followUps.length - 1].receivedAt
          : null,
      alternatives: counts.alternatives,
      pathsComputed: counts.pathsComputed,
      fullReply: counts.fullReply,
    };
    followUps.push(entry);
    onEvent?.({ type: "follow_up", sessionId, attempt, ...entry });
  };

  client.on("path", followUpHandler);

  try {
    const sendAt = Date.now();
    let initialRes;
    try {
      // path_find is a subscription in xrpl-client → full WS envelope
      initialRes = await request(client, req, {
        timeoutSeconds: 90,
        noReplayAfterReconnect: true,
      });
    } catch (err) {
      try {
        await request(
          client,
          { command: "path_find", subcommand: "close" },
          { timeoutSeconds: 10, noReplayAfterReconnect: true }
        );
      } catch {
        /* ignore */
      }
      return { ok: false, error: err, t0: sendAt };
    }

    const receivedAt = Date.now();
    const counts = countPathResults(initialRes);
    const initial = {
      receivedAt,
      latencyMs: receivedAt - sendAt,
      alternatives: counts.alternatives,
      pathsComputed: counts.pathsComputed,
      fullReply: counts.fullReply,
      status: initialRes?.status,
      type: initialRes?.type,
    };
    initialResolved = true;

    onEvent?.({
      type: "initial",
      sessionId,
      attempt,
      latencyMs: initial.latencyMs,
      alternatives: counts.alternatives,
      pathsComputed: counts.pathsComputed,
      fullReply: counts.fullReply,
      destination_amount: req.destination_amount,
      send_max: req.send_max,
      source_account: req.source_account,
      destination_account: req.destination_account,
    });

    if (collectFollowUps && observeMs > 0) {
      await sleep(observeMs);
    }

    let closed = false;
    let closeError;
    try {
      await request(
        client,
        { command: "path_find", subcommand: "close" },
        { timeoutSeconds: 30, noReplayAfterReconnect: true }
      );
      closed = true;
    } catch (err) {
      // noPathRequest is fine if server already dropped it
      closeError = err.message;
    }

    return {
      ok: true,
      t0: sendAt,
      initial,
      followUps,
      closed,
      closeError,
    };
  } finally {
    if (typeof client.removeListener === "function") {
      client.removeListener("path", followUpHandler);
    } else if (typeof client.off === "function") {
      client.off("path", followUpHandler);
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
  }
}

function summarizeSession(session) {
  const fuAlts = session.followUps.map((f) => f.alternatives);
  const fuPaths = session.followUps.map((f) => f.pathsComputed);
  const fuGaps = session.followUps
    .map((f) => f.sincePreviousMs)
    .filter((v) => v != null);

  return {
    initialLatencyMs: session.initial?.latencyMs ?? null,
    initialAlternatives: session.initial?.alternatives ?? null,
    initialPathsComputed: session.initial?.pathsComputed ?? null,
    initialFullReply: session.initial?.fullReply ?? null,
    followUpCount: session.followUps.length,
    followUpAlternatives: fuAlts,
    followUpPathsComputed: fuPaths,
    followUpGapsMs: fuGaps,
    lastFollowUpOffsetMs:
      session.followUps.length > 0
        ? session.followUps[session.followUps.length - 1].offsetMs
        : null,
    errorCount: session.errors.length,
    destination_amount: session.destination_amount,
    send_max: session.send_max,
  };
}
