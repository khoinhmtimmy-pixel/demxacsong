# Performance baseline — Đêm Xác Sống

Principle: **never claim something got faster without a number**. Every performance change must
fill in the table below, together with the raw CSV.

## Tooling status

| Piece | Status |
|---|---|
| F3 panel (ping, fps, sim/draw ms, snap/s, interp, corr) | ✅ present |
| Per-second CSV export + p50/p95 | ✅ present (`⬇ export CSV` in F3) |
| Bad-network simulation in `server.js` (`--lag/--jitter/--loss/--dup/--reorder`) | ✅ present |
| Packet trace to CSV (`--trace`) | ✅ present |
| Simulator verification (`test/netsim.js`) | ✅ automated |
| **Real browser measurements** | ⛔ **not measured** — needs a visible tab |

## Measurement table

Each row: run the scenario from `docs/qa.md`, export the CSV from F3, fill in p95.

| Scenario | Network tier | fps p50 | draw p95 (ms) | sim p95 (ms) | KB/s p95 | corr | Notes |
|---|---|---|---|---|---|---|---|
| S1 · 150 zombies | LAN | not measured | not measured | not measured | not measured | not measured | |
| S1 · 150 zombies | Normal (60 ms) | not measured | not measured | not measured | not measured | not measured | |
| S1 · 150 zombies | Bad (150 ms) | not measured | not measured | not measured | not measured | not measured | |
| S2 · Boss | LAN | not measured | not measured | not measured | not measured | not measured | |
| S6 · 10k bullets | LAN | not measured | not measured | not measured | not measured | not measured | |
| S7 · 30 minutes | LAN | not measured | not measured | not measured | not measured | not measured | final heap: ? |

## Pass thresholds

- `draw p95` < 16 ms with 150 zombies.
- `KB/s p95` < 35 KB/s per client (netcode v2 target; currently JSON so it will be higher).
- `corr` < 20 per minute at the Normal tier.
- Heap after 30 minutes does not grow monotonically (< 20 % swing).

## History

| Date | Change | Before | After |
|---|---|---|---|
| — | (empty, waiting for the first measurement run) | — | — |
