/**
 * Discover XRPL accounts that have many trustlines with non-zero balances.
 *
 * Strategy:
 *  1. Pull peer accounts from well-known issuer account_lines pages.
 *  2. Prefilter candidates by OwnerCount (>= min).
 *  3. Paginate account_lines and count lines with balance != 0.
 *  4. Snowball: peers of qualifiers become new candidates (market-maker graph).
 *  5. Keep a random sample of qualifiers and cache trustlines useful for path_find.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULTS, parseArgs, resolveConfig } from "./config.js";
import { connect, request, mapPool, shuffle } from "./xrpl.js";

/**
 * Paginate account_lines for an account.
 * @param {object} [opts]
 * @param {number} [opts.maxPages]
 * @param {number} [opts.limit]
 * @param {(lines: object[], funded: number) => boolean} [opts.stopWhen]
 *        return true to stop early (e.g. once enough funded lines found)
 * @returns {Promise<object[]>}
 */
export async function fetchAllLines(
  client,
  account,
  { maxPages = 50, limit = 400, stopWhen } = {}
) {
  const lines = [];
  let funded = 0;
  let marker;
  for (let page = 0; page < maxPages; page++) {
    const body = {
      command: "account_lines",
      account,
      ledger_index: "validated",
      limit,
    };
    if (marker !== undefined) body.marker = marker;

    let res;
    try {
      res = await request(client, body, { timeoutSeconds: 90 });
    } catch (err) {
      // actNotFound / account deleted / etc.
      if (
        String(err.message).includes("actNotFound") ||
        String(err.message).includes("lgrNotFound")
      ) {
        return lines;
      }
      throw err;
    }

    if (Array.isArray(res.lines)) {
      for (const l of res.lines) {
        lines.push(l);
        if (hasBalance(l)) funded++;
      }
    }
    if (stopWhen && stopWhen(lines, funded)) break;
    if (res.marker === undefined || res.marker === null) break;
    marker = res.marker;
  }
  return lines;
}

/** True if a trustline balance is non-zero (either side). */
export function hasBalance(line) {
  const bal = Number(line?.balance);
  return Number.isFinite(bal) && bal !== 0;
}

/**
 * Deep-page issuer account_lines to build a large peer set, then rank by OwnerCount.
 * High-trustline market makers are sparse among gateway holders — we need thousands
 * of candidates + OC ranking (not a shallow random sample).
 *
 * @returns {Promise<{candidates: string[], ownerCounts: Map<string, number>, heavyCount: number}>}
 */
export async function collectHeavyCandidates(
  client,
  issuers,
  {
    maxCandidates = 3000,
    minOwnerCount = 200,
    pagesPerIssuer = 25,
    concurrency = 16,
  } = {}
) {
  const seen = new Set();
  const candidates = [];

  // Prefer depth on the first few major issuers (where market makers show up)
  for (const issuer of issuers) {
    if (candidates.length >= maxCandidates) break;
    let marker;
    let pages = 0;
    let fromIssuer = 0;
    const issuerBudget = Math.min(
      pagesPerIssuer * 400,
      Math.max(800, maxCandidates - candidates.length)
    );

    while (pages < pagesPerIssuer && fromIssuer < issuerBudget && candidates.length < maxCandidates) {
      const body = {
        command: "account_lines",
        account: issuer,
        ledger_index: "validated",
        limit: 400,
      };
      if (marker !== undefined) body.marker = marker;

      let res;
      try {
        res = await request(client, body, { timeoutSeconds: 90 });
      } catch (err) {
        console.warn(`[discover] seed issuer ${issuer} failed: ${err.message}`);
        break;
      }
      pages++;

      for (const line of res.lines || []) {
        const peer = line.account;
        if (!peer || seen.has(peer)) continue;
        seen.add(peer);
        candidates.push(peer);
        fromIssuer++;
        if (candidates.length >= maxCandidates || fromIssuer >= issuerBudget) break;
      }

      if (res.marker === undefined || res.marker === null) break;
      marker = res.marker;
    }

    console.log(
      `[discover] issuer ${issuer}: pages=${pages} +${fromIssuer} total_candidates=${candidates.length}`
    );
  }

  console.log(`[discover] ranking ${candidates.length} candidates by OwnerCount…`);
  const ownerCounts = await fetchOwnerCounts(client, candidates, concurrency);
  const ranked = [...candidates].sort(
    (a, b) => (ownerCounts.get(b) || 0) - (ownerCounts.get(a) || 0)
  );
  const heavyCount = ranked.filter((a) => (ownerCounts.get(a) || 0) >= minOwnerCount).length;
  const top = ranked.slice(0, 5).map((a) => `${a.slice(0, 8)}…:OC${ownerCounts.get(a)}`);
  console.log(`[discover] heavy(OC≥${minOwnerCount})=${heavyCount} top=${top.join(", ")}`);

  return { candidates: ranked, ownerCounts, heavyCount };
}

/**
 * Inspect one account: OwnerCount prefilter + count trustlines with balances.
 * @returns {Promise<object|null>} wallet profile or null if it does not qualify
 */
export async function inspectAccount(client, account, minTrustlinesWithBalance) {
  let info;
  try {
    info = await request(
      client,
      {
        command: "account_info",
        account,
        ledger_index: "validated",
      },
      { timeoutSeconds: 30 }
    );
  } catch {
    return null;
  }

  const ownerCount = info?.account_data?.OwnerCount ?? 0;
  // OwnerCount counts all objects; if it's below the threshold we cannot have enough lines.
  if (ownerCount < minTrustlinesWithBalance) return null;

  // Page lines until we clear the funded threshold AND have a good sample of
  // tokens the wallet actually holds (balance > 0) for path_find amounts.
  const sampleTarget = 80;
  const heldTarget = 40;
  let heldSeen = 0;
  const lines = await fetchAllLines(client, account, {
    maxPages: 80,
    stopWhen: (_lines, funded) => {
      // recount held each page is expensive; approximate via filter on accumulated
      heldSeen = _lines.filter((l) => Number(l.balance) > 0).length;
      const enoughFunded = funded >= minTrustlinesWithBalance;
      const enoughHeldSample = heldSeen >= heldTarget;
      // Once funded threshold is met, keep going a bit for held samples, then stop
      return enoughFunded && (enoughHeldSample || funded >= minTrustlinesWithBalance + sampleTarget);
    },
  });
  const withBal = lines.filter(hasBalance);
  if (withBal.length < minTrustlinesWithBalance) return null;

  const held = withBal.filter((l) => Number(l.balance) > 0);
  const owed = withBal.filter((l) => Number(l.balance) < 0);

  // Prefer tokens the wallet HOLDS for path_find destination_amount samples.
  // Fall back to negative-balance lines only if needed to fill the sample.
  const sampleLines = [...held, ...owed].slice(0, sampleTarget);
  const funded = sampleLines.map((l) => ({
    account: l.account, // counterparty
    currency: l.currency,
    balance: l.balance,
    limit: l.limit,
  }));

  return {
    account,
    ownerCount,
    trustlineCount: lines.length,
    // may be a lower bound if we stopped early after crossing the threshold
    trustlinesWithBalance: withBal.length,
    heldTrustlines: held.length,
    fundedTrustlines: funded,
    discoveredAt: new Date().toISOString(),
  };
}

/**
 * Collect account addresses that post offers on books for the given IOUs.
 * Market makers with many trustlines show up repeatedly on DEX books.
 */
async function collectOrderBookAccounts(client, fundedLines, { maxBooks = 20, perBook = 40 } = {}) {
  const accounts = new Set();
  const books = [];
  const seenBook = new Set();

  for (const line of fundedLines) {
    if (!line?.currency || !line?.account) continue;
    const key = `${line.currency}:${line.account}`;
    if (seenBook.has(key)) continue;
    seenBook.add(key);
    books.push({ currency: line.currency, issuer: line.account });
    if (books.length >= maxBooks) break;
  }

  // This node expects XRP as `{ currency: "XRP" }` (object), not the bare string form.
  const xrp = { currency: "XRP" };

  for (const book of books) {
    // IOU → XRP and XRP → IOU sides
    for (const side of [
      {
        taker_gets: { currency: book.currency, issuer: book.issuer },
        taker_pays: xrp,
      },
      {
        taker_gets: xrp,
        taker_pays: { currency: book.currency, issuer: book.issuer },
      },
    ]) {
      try {
        const res = await request(
          client,
          {
            command: "book_offers",
            taker_gets: side.taker_gets,
            taker_pays: side.taker_pays,
            ledger_index: "validated",
            limit: perBook,
          },
          { timeoutSeconds: 30 }
        );
        for (const offer of res.offers || []) {
          if (offer.Account) accounts.add(offer.Account);
        }
      } catch {
        /* book may not exist */
      }
    }
  }

  return [...accounts];
}

/**
 * Fetch OwnerCount for many accounts (cheap prefilter / ranking).
 * @returns {Promise<Map<string, number>>}
 */
async function fetchOwnerCounts(client, accounts, concurrency) {
  const map = new Map();
  await mapPool(accounts, concurrency, async (account) => {
    try {
      const info = await request(
        client,
        { command: "account_info", account, ledger_index: "validated" },
        { timeoutSeconds: 20 }
      );
      map.set(account, info?.account_data?.OwnerCount ?? 0);
    } catch {
      map.set(account, 0);
    }
  });
  return map;
}

/**
 * Seed candidates from major DEX books (offer Account fields).
 */
async function seedFromBooks(client, seedBooks, { perBook = 60 } = {}) {
  const asLines = (seedBooks || []).map((b) => ({
    currency: b.currency,
    account: b.issuer,
  }));
  return collectOrderBookAccounts(client, asLines, {
    maxBooks: asLines.length,
    perBook,
  });
}

/**
 * Discover a random set of wallets meeting the trustline threshold.
 *
 * 1. Seed from major DEX order-book offer posters (best hit rate)
 * 2. Optionally expand via issuer holders ranked by OwnerCount
 * 3. Inspect heavies for funded trustline count
 * 4. Snowball through order books of each qualifier's currencies
 */
export async function discoverWallets(cfg) {
  const client = await connect(cfg.endpoint);
  console.log(`[discover] connected to ${cfg.endpoint}`);
  console.log(
    `[discover] looking for ${cfg.walletPoolSize} wallets with ≥${cfg.minTrustlinesWithBalance} funded trustlines`
  );

  try {
    // --- primary seed: DEX market makers ---
    console.log(`[discover] seeding from ${cfg.seedBooks?.length || 0} major order books…`);
    const bookSeeds = await seedFromBooks(client, cfg.seedBooks || [], { perBook: 80 });
    console.log(`[discover] order-book seeds: ${bookSeeds.length}`);

    // --- secondary seed: deep issuer holders (fills out the pool) ---
    const { candidates: issuerRanked, ownerCounts, heavyCount: issuerHeavy } =
      await collectHeavyCandidates(client, cfg.seedIssuers, {
        maxCandidates: cfg.maxCandidatesToScan,
        minOwnerCount: cfg.minTrustlinesWithBalance,
        pagesPerIssuer: cfg.pagesPerIssuer ?? 50,
        concurrency: cfg.discoveryConcurrency,
      });

    // Merge: book seeds first, then issuer-ranked
    const seen = new Set();
    const merged = [];
    for (const a of [...bookSeeds, ...issuerRanked]) {
      if (seen.has(a)) continue;
      seen.add(a);
      merged.push(a);
    }

    // Rank book seeds by OC as well
    const bookOC = await fetchOwnerCounts(client, bookSeeds, cfg.discoveryConcurrency);
    for (const [k, v] of bookOC) ownerCounts.set(k, v);

    let queue = merged.sort(
      (a, b) => (ownerCounts.get(b) || 0) - (ownerCounts.get(a) || 0)
    );
    const heavyCount = queue.filter(
      (a) => (ownerCounts.get(a) || 0) >= cfg.minTrustlinesWithBalance
    ).length;

    console.log(
      `[discover] ranked candidates=${queue.length} heavy(OC≥${cfg.minTrustlinesWithBalance})=${heavyCount} ` +
        `(issuerHeavy=${issuerHeavy} bookSeeds=${bookSeeds.length}) topOC=${ownerCounts.get(queue[0]) || 0}`
    );

    const found = [];
    const foundSet = new Set();
    let scanned = 0;
    let rejected = 0;
    const batchSize = Math.max(cfg.discoveryConcurrency, 4);
    // Soft cap; raised automatically as snowball discovers more high-OC peers
    let maxScan = Math.max(heavyCount + 80, cfg.walletPoolSize * 25, 120);

    while (found.length < cfg.walletPoolSize && queue.length > 0 && scanned < maxScan) {
      // Prefer still-uninspected high-OC accounts
      const batch = queue.splice(0, batchSize);
      const results = await mapPool(batch, cfg.discoveryConcurrency, async (acct) => {
        if (foundSet.has(acct)) return null;
        const oc = ownerCounts.get(acct);
        // Skip obvious lightweights when we already know OC
        if (oc !== undefined && oc < cfg.minTrustlinesWithBalance) return null;
        try {
          return await inspectAccount(client, acct, cfg.minTrustlinesWithBalance);
        } catch (err) {
          console.warn(`[discover] inspect ${acct}: ${err.message}`);
          return null;
        }
      });

      for (let i = 0; i < results.length; i++) {
        const r = results[i];
        const acct = batch[i];
        // Count only accounts we actually tried to inspect
        const oc = ownerCounts.get(acct);
        if (oc !== undefined && oc < cfg.minTrustlinesWithBalance) continue;
        scanned++;

        if (r && !foundSet.has(r.account)) {
          found.push(r);
          foundSet.add(r.account);
          console.log(
            `[discover] ✓ ${r.account}  lines≥${r.trustlineCount} funded≥${r.trustlinesWithBalance} ownerCount=${r.ownerCount}  (${found.length}/${cfg.walletPoolSize})`
          );

          if (found.length < cfg.walletPoolSize) {
            // Trustline counterparties are usually issuers, not other market makers.
            // Harvest offer-book participants for this wallet's funded currencies —
            // those accounts are far more likely to also be multi-line traders.
            const bookAccounts = await collectOrderBookAccounts(
              client,
              r.fundedTrustlines || [],
              { maxBooks: 25, perBook: 40 }
            );
            const newPeers = [];
            for (const p of bookAccounts) {
              if (seen.has(p) || foundSet.has(p) || p === r.account) continue;
              seen.add(p);
              newPeers.push(p);
            }
            if (newPeers.length) {
              const peerOC = await fetchOwnerCounts(
                client,
                newPeers,
                cfg.discoveryConcurrency
              );
              for (const [k, v] of peerOC) ownerCounts.set(k, v);
              const rankedPeers = newPeers
                .filter((p) => (peerOC.get(p) || 0) >= cfg.minTrustlinesWithBalance)
                .sort((a, b) => (peerOC.get(b) || 0) - (peerOC.get(a) || 0));
              queue = [...rankedPeers, ...queue];
              maxScan = Math.max(maxScan, scanned + rankedPeers.length + 40);
              console.log(
                `[discover] orderbook snowball +${rankedPeers.length} high-OC / ${newPeers.length} peers from ${r.account} (queue=${queue.length} maxScan=${maxScan})`
              );
            }
          }

          if (found.length >= cfg.walletPoolSize) break;
        } else {
          rejected++;
        }
      }

      if (scanned % 10 === 0 || found.length >= cfg.walletPoolSize) {
        console.log(
          `[discover] progress inspected=${scanned} rejected=${rejected} found=${found.length} queue=${queue.length}`
        );
      }
    }

    if (found.length === 0) {
      throw new Error(
        `No wallets found with ≥${cfg.minTrustlinesWithBalance} funded trustlines. ` +
          `Try lowering --minTrustlinesWithBalance, raising --maxCandidatesToScan, or adding seed issuers.`
      );
    }

    const wallets = shuffle(found).slice(0, cfg.walletPoolSize);
    return wallets;
  } finally {
    client.close();
  }
}

export async function saveWallets(file, wallets) {
  const abs = path.resolve(file);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  const payload = {
    generatedAt: new Date().toISOString(),
    count: wallets.length,
    wallets,
  };
  await fs.writeFile(abs, JSON.stringify(payload, null, 2));
  console.log(`[discover] wrote ${wallets.length} wallets → ${abs}`);
  return abs;
}

export async function loadWallets(file) {
  const abs = path.resolve(file);
  const raw = await fs.readFile(abs, "utf8");
  const data = JSON.parse(raw);
  const wallets = data.wallets || data;
  if (!Array.isArray(wallets) || wallets.length === 0) {
    throw new Error(`No wallets in ${abs}`);
  }
  return wallets;
}

async function main() {
  const args = parseArgs();
  const cfg = resolveConfig({
    endpoint: args.endpoint || DEFAULTS.endpoint,
    minTrustlinesWithBalance: args.minTrustlinesWithBalance ?? DEFAULTS.minTrustlinesWithBalance,
    walletPoolSize: args.walletPoolSize ?? args.wallets ?? DEFAULTS.walletPoolSize,
    maxCandidatesToScan: args.maxCandidatesToScan ?? DEFAULTS.maxCandidatesToScan,
    discoveryConcurrency: args.discoveryConcurrency ?? DEFAULTS.discoveryConcurrency,
    walletsFile: args.walletsFile || args.out || DEFAULTS.walletsFile,
  });

  console.log("[discover] config:", {
    endpoint: cfg.endpoint,
    minTrustlinesWithBalance: cfg.minTrustlinesWithBalance,
    walletPoolSize: cfg.walletPoolSize,
    walletsFile: cfg.walletsFile,
  });

  const wallets = await discoverWallets(cfg);
  await saveWallets(cfg.walletsFile, wallets);
  console.log("[discover] done.");
}

const isDirect =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirect) {
  main().catch((err) => {
    console.error("[discover] fatal:", err);
    process.exit(1);
  });
}
