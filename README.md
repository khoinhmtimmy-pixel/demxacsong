# Đêm Xác Sống — online co-op edition

A single-file zombie survival shooter, now with a real **host-authoritative co-op engine** running over a small relay server.

## Run the game

```bash
npm install      # installs "ws" (one package)
npm start        # http://localhost:8080
```

Open **two tabs** (or two machines on the same LAN) → pick **Co-op** or **Arena** → enter the **same room code** → Start.
The first machine in the room becomes **HOST**; the second one is a **CLIENT**.

On a LAN, another machine opens `http://<host-ip>:8080` (the IP is printed when you run `npm start`).

Press **F3** in-game for the network panel: ping, jitter, snapshots/s, interpolation delay, and the number of position corrections.

The menu has a **Tiếng Việt / English** button that switches the whole interface between the two languages. The choice is stored per device (`localStorage` key `zlang`) and applies immediately, including mid-run.

## Architecture

| Piece | Role |
|---|---|
| `index.html` | The whole game (unchanged apart from a few hook points) |
| `net.js` | Co-op engine: client prediction, snapshots, interpolation, AOI |
| `server.js` | Static file server + packet relay + host election |
| `lang.js` | English→Vietnamese table + runtime that swaps DOM text and canvas labels |

The model follows modern battleground netcode rather than "send my position 12 times a second":

1. **Host-authoritative** — the host simulates the world (zombies, chests, damage) and publishes **20 Hz snapshots**. Clients do not decide kills themselves, which is what prevents state divergence.
2. **Client-side prediction** — a client still moves immediately on its own input instead of waiting for the server, so controls never feel delayed.
3. **Reconciliation** — when a host snapshot arrives the client compares the authoritative position with its predicted one: small error is eased away (14×dt), only a large one (>200 px) is snapped. No more jitter or teleporting.
4. **Snapshot interpolation** — zombies and chests are interpolated between two snapshots with a ~100–160 ms buffer (adaptive to jitter), so motion stays smooth at only 20 packets/s.
5. **Quantize + AOI** — coordinates travel as integers, only entities within 1300 px of a teammate are sent, and display data (colour, shape, boss name) is sent **once** per entity.
6. **No packet compression** — `perMessageDeflate` is off because compression adds per-packet latency; quantization already keeps packets small.
7. **Host migration** — if the host leaves, the next machine takes over and the room survives.

## What is synchronized in co-op

- Zombies, chests, items, boss attacks: owned by the host, clients only render them.
- Teammate bullets: the client sends a shot event, the host resolves the hit and credits the **player who actually scored the kill**.
- Coins, score, guns, upgrades, quests, chests: still **per-machine** progression (saved to localStorage as before).
- Downed / reviving a teammate: state lives on the host, the revive signal goes through the server.
- Single player (no room code) behaves exactly like the original build and needs no network.

## Measuring performance & testing bad networks

Press **F3** in a match for: ping, jitter, fps, simulation/render time (ms), snapshots/s, interpolation delay, position corrections, zombie/bullet counts.

- One row per second is recorded; press **⬇ export CSV** to download it (p50/p95 in the footer).
- Bad-network simulation (off by default):

```bash
node server.js --lag 60 --jitter 10 --loss 0.01                 # normal network
node server.js --lag 150 --jitter 30 --loss 0.03 --reorder 0.01  # bad network
node server.js --lag 80 --loss 0.02 --trace docs/trace.csv       # log every packet
```

Only **snapshots** are dropped/duplicated/reordered; input, shot events, revives and kill rewards always arrive — like real TCP, where packet loss means *delay*, not *lost messages*.

The full procedure, seven scenarios and pass thresholds: see `docs/qa.md`. Current measurements: `docs/baseline.md`.

## Testing

```bash
node server.js &                 # or npm start on port 8080
PORT=8090 node server.js &       # dedicated port for tests
PORT=8090 node test/net-smoke.js
```

`npm test` runs `test/netsim.js` — it verifies the impairment simulator (no flags adds no delay, `--lag 60` produces that delay, `--loss` drops the right share, `--trace` writes the right format).

`test/net-smoke.js` checks: joining a room, host election, client→host input, host→client snapshots, shot events, kill rewards going to the right player, ping measurement, and host re-election when the host leaves.

## Notes

- Playing over the Internet requires opening port 8080 and using a public IP / VPN (Tailscale, ZeroTier…) or a reverse proxy with WebSocket support.
- The server does not simulate the game, it only relays — so added latency is essentially zero compared with a direct connection.
- If the host has a high ping, clients still move smoothly (thanks to prediction), but zombies react at the host's pace.
