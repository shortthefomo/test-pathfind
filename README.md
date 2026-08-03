# XRPL `path_find` load test

Burst load-tester for rippled/clio pathfinding, with a **Vue 3** dashboard for multi-round runs and fall-off comparison.

## Modes

| Mode | Command | What it does |
|------|---------|----------------|
| **UI (dev)** | `npm run dev` | Express API + Vite Vue app at http://localhost:5173 |
| **UI (prod)** | `npm run build && npm start` | Serves built `web/dist` |
| **CLI** | `npm run cli -- --skipDiscover --max=50 --observeMin=2` | Terminal load test |
| **Discover** | `npm run discover` | Cache high-trustline wallets |

Default node: `ws://192.168.12.238:6006`

## How a round works

1. **Burst** — open all path_finds in parallel (as fast as possible)
2. **Ready** — wait until every successful session emits async updates
3. **Observe** — keep them open and graph metrics for N seconds (default 2 min)
4. Close sessions; store summary for history/compare

## Vue dashboard

```bash
npm install
npm run discover          # once, if data/wallets.json is missing
npm run dev
```

Open **http://localhost:5173**

- Pick **max** 10 / 50 / 200 or custom up to **1000**
- Set **observe** 30s / 1m / 2m / 5m or custom
- **Fire test round** — live charts stream over SSE
- Run another round with different options
- Multi-select history rows → **Compare** charts (create/gap fall-off vs concurrency, success rate, overlaid time series)

Only **one** run at a time.

## CLI options

```bash
npm run cli -- --skipDiscover --max=200 --observeMin=2
npm run cli -- --skipDiscover --max=10 --observeSec=30 --inspect
```

| Flag | Default | Meaning |
|------|---------|---------|
| `--endpoint` | `ws://192.168.12.238:6006` | WebSocket URL |
| `--max` / `--cutoff` | `200` | Concurrent path_finds (burst) |
| `--observeMin` | `2` | Observe window (minutes) |
| `--observeSec` | | Observe window (seconds) |
| `--readyTimeoutSec` | `120` | Max wait for all sessions to update |
| `--skipDiscover` | | Use `data/wallets.json` |
| `--inspect` | | Interactive session drill-down after CLI run |

## Why multiple connections?

Per the [path_find docs](https://xrpl.org/docs/references/http-websocket-apis/public-api-methods/path-and-order-book-methods/path_find), only one path_find may be open per WebSocket. This tool opens **one `XrplClient` per concurrent request**.

## Project layout

```
server/           # Express API + Vite middleware
web/              # Vue 3 UI (Chart.js)
src/              # Load-test engine (shared CLI + API)
data/wallets.json # Wallet cache
data/results/     # Run outputs + UI index
```

## Notes

- Max concurrency is capped at **1000** in the API/UI.
- Loads above ~200 sockets can hit OS fd limits or node capacity — the form warns above 200.
- Path quality under load is not guaranteed; empty `alternatives` is a useful stress signal.
