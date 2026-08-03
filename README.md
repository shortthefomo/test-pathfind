# XRPL `path_find` load test

Load-tester for rippled/clio pathfinding, with a **Vue 3** dashboard for multi-round runs and fall-off comparison. Supports **burst** (all at once) and **ramp** (up → hold → down).

## Modes

| Mode | Command | What it does |
|------|---------|----------------|
| **UI (dev)** | `npm run dev` | Express API + Vite Vue app at http://localhost:5173 |
| **UI (prod)** | `npm run build && npm start` | Serves built `web/dist` |
| **CLI** | `npm run cli -- --skipDiscover --max=50 --observeMin=2` | Terminal load test |
| **Discover** | `npm run discover` | Cache high-trustline wallets |

Default node: `ws://192.168.12.238:6006`

## How a round works

### Burst
1. Open all path_finds in parallel (as fast as possible)
2. **Ready** — wait until sessions emit async updates
3. **Observe** — hold and graph metrics for N seconds
4. Close all at once

### Ramp
1. **Ramp up** — open +1 path_find every interval (default 3s) until max concurrent
2. **Ready** — wait until sessions emit async updates
3. **Hold / observe** — keep all open at the cap for the observe window
4. **Ramp down** — close −1 path_find every **same** interval until none remain

## Vue dashboard

```bash
npm install
npm run discover          # once, if data/wallets.json is missing
npm run dev
```

Open **http://localhost:5173**

- Defaults: **Ramp**, **1s** interval, **max 50**, **hold 30s**
- Pick **open mode**: Burst or Ramp
- Ramp: set **interval** (used for both ramp-up and ramp-down)
- Pick **max** concurrent path_finds (the cap)
- Set **observe** window (hold time at cap in ramp mode)
- **Fire test round** — live charts stream over SSE
- Multi-select history rows → **Compare** charts

Only **one** run at a time.

## CLI options

```bash
npm run cli -- --skipDiscover --max=200 --observeMin=2
npm run cli -- --skipDiscover --max=10 --observeSec=30 --inspect
npm run cli -- --skipDiscover --mode=ramp --addIntervalSec=3 --max=50 --observeSec=60
```

| Flag | Default | Meaning |
|------|---------|---------|
| `--endpoint` | `ws://192.168.12.238:6006` | WebSocket URL |
| `--max` / `--cutoff` | `50` | Max concurrent path_finds (cap) |
| `--mode` | `ramp` | `burst` or `ramp` (up → hold → down) |
| `--addIntervalSec` | `1` | Ramp: seconds between +1 up and −1 down |
| `--observeMin` | | Hold-at-cap / observe window (minutes) |
| `--observeSec` | `30` | Observe / hold-at-cap window (seconds) |
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
