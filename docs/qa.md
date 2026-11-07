# QA — "Prove it does not lag"

Goal: every claim that "the lag is gone" must come with **measurements**, not a feeling.

## 1. Three network tiers

| Tier | Conditions | Passes when |
|---|---|---|
| LAN | RTT < 5 ms, 0 % loss | no stutter; `corr` < 5/min; zombies behind by ≤ 1 snapshot |
| Normal | 60 ms, 1 % loss | movement smooth; no teleporting; `corr` < 20/min |
| Bad | 150 ms, 3 % loss, 30 ms jitter | still playable; no state divergence; `corr` < 60/min |

## 2. Running each tier

```bash
# LAN — no simulation
npm start

# Normal — 60ms, 1% snapshot loss, 10ms jitter
node server.js --lag 60 --jitter 10 --loss 0.01 --trace docs/trace-normal.csv

# Bad — 150ms, 3% snapshot loss, 30ms jitter, 1% reorder
node server.js --lag 150 --jitter 30 --loss 0.03 --reorder 0.01 --trace docs/trace-bad.csv
```

Available flags: `--lag` (ms), `--jitter` (± ms), `--loss` (0–1), `--dup` (0–1), `--reorder` (0–1), `--trace` (CSV file).

**Important rule:** only **snapshots** are dropped/duplicated/reordered. Input, shot events, revives and kill rewards always arrive — on real TCP packet loss means *delay*, not *a lost message*. Dropping them would test a bug that does not exist.

The server prints every 10 seconds: packets, drops, mean delay, KB — enough to confirm the simulator is really running.

## 3. Collecting numbers in-game

1. Join a co-op match, press **F3** → panel shows ping, jitter, fps, sim ms, draw ms, snap/s, interp, `corr`, zombie/bullet counts.
2. One row per second is recorded (up to 2 hours).
3. Press **⬇ export CSV** → downloads `netmetrics-<time>.csv`: one row per second with fps/sim/draw/KB/corr/heap, and p50/p95 plus minutes measured in the footer.
4. Paste the p95 numbers into the table in section 5 and into `docs/baseline.md`.

## 4. Seven scenarios (3 minutes each, fixed seed)

| ID | Scenario | Question | Result |
|---|---|---|---|
| S1 | 150 zombies, constant fire | p95 frame time, KB/s | not measured |
| S2 | Boss + area attacks | can the client see the attack in time to dodge | not measured |
| S3 | One player down, the other revives | do both machines agree | not measured |
| S4 | Host leaves mid-match | does the room survive, is the wave continuous | not measured |
| S5 | Joining mid-wave | wave jump / wrong spawn | not measured |
| S6 | 10,000 bullets | memory leak, do `S.b`/`S.sp` grow | not measured |
| S7 | 30 minutes continuous | heap, tile cache, entity count after 30 min | not measured |

The "Result" column may only be filled in after a CSV exists. Never from a feeling.

## 5. Symptom → cause → fix

| Symptom | Usual cause | Where to fix |
|---|---|---|
| Teleporting when touching a zombie | over-aggressive reconciliation | 200 px threshold + 14×dt easing (`net.js`) |
| Zombies slide slightly | interpolation shorter than snapshot spacing | 1.6× packet interval buffer (`interp`) |
| Hit registered but no damage | host checks at the new position | lag compensation `RTT/2` (not done yet) |
| Gets slower the longer you play | blood baked into the tile cache | cap blood per tile, evict distant tiles |
| Stutter right after joining | client runs an empty frame before the first snapshot | wait for the first snapshot before `run=true` |

## 6. Two-machine playtest checklist (10 minutes)

1. `npm start` on the faster machine; open `http://<LAN-IP>:8080` on the second machine (a phone works).
2. Same room code, pick **Online · Co-op**, play 3 waves.
3. Press F3 on both machines, take screenshots, export both CSVs.
4. Repeat with `--lag 60`, then `--lag 150 --loss 0.03`.
5. Write three lines of feedback: movement / shooting / zombies.

## 7. Measurement caveats

- **A hidden tab stops `requestAnimationFrame`** → fps and every in-game number read zero. Measure in a real, visible browser window, never a background tab.
- Measuring on the machine that also runs the server includes the server's work; run the server elsewhere for clean numbers.
- The impairment simulator is verified automatically: `npm test` (see `test/netsim.js`).
