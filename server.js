'use strict';
/* Đêm Xác Sống — co-op server.
 * Job: serve static files + relay packets between machines in the same room.
 * Model: host-authoritative (one machine is the host, simulates the world, publishes snapshots),
 * the server only relays, elects the host and holds rooms, so added latency is near zero.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

let WebSocketServer;
try {
  ({ WebSocketServer } = require('ws'));
} catch (err) {
  console.error('[server] Missing the "ws" package. Run npm install and try again.');
  process.exit(1);
}

const PORT = Number(process.env.PORT) || 8080;
const ROOT = __dirname;
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

/* --------------------------------------------------------------- bad-network simulation
 * Off by default: with no flags the relay behaves exactly as before, not one setTimeout.
 *   node server.js --lag 80 --jitter 15 --loss 0.02 --dup 0.005 --reorder 0.01
 *   node server.js --lag 150 --loss 0.03 --trace docs/trace-xau.csv
 */
const ARGV = process.argv.slice(2);
function numFlag(name, def) {
  const i = ARGV.indexOf('--' + name);
  if (i < 0) return def;
  const v = Number(ARGV[i + 1]);
  return Number.isFinite(v) ? v : def;
}
function strFlag(name, def) {
  const i = ARGV.indexOf('--' + name);
  return i >= 0 && ARGV[i + 1] ? ARGV[i + 1] : def;
}
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

const SIM = {
  lag: Math.max(0, numFlag('lag', 0)),
  jitter: Math.max(0, numFlag('jitter', 0)),
  loss: clamp01(numFlag('loss', 0)),
  dup: clamp01(numFlag('dup', 0)),
  reorder: clamp01(numFlag('reorder', 0)),
};
const SIM_ON = !!(SIM.lag || SIM.jitter || SIM.loss || SIM.dup || SIM.reorder);
const TRACE = strFlag('trace', SIM_ON ? 'nettrace.csv' : null);

let traceOut = null;
if (TRACE) {
  const fresh = !fs.existsSync(TRACE);
  traceOut = fs.createWriteStream(TRACE, { flags: 'a' });
  if (fresh) traceOut.write('ms,kind,bytes,delay_ms,dropped\n');
}
const simStat = { sent: 0, dropped: 0, dup: 0, delaySum: 0, bytes: 0 };

function logTrace(kind, bytes, delay, dropped) {
  if (!traceOut) return;
  traceOut.write(Date.now() + ',' + kind + ',' + bytes + ',' + delay + ',' + dropped + '\n');
}

/** Send one text frame through the simulator (or straight through when off). */
function rawSend(ws, raw, kind) {
  if (!ws || ws.readyState !== 1) return;
  const bytes = Buffer.byteLength(raw, 'utf8');
  if (!SIM_ON) {
    try { ws.send(raw); } catch (e) { /* dead socket */ }
    return;
  }
  // Only snapshots are disposable (a later packet replaces an earlier one). Input, events,
  // revives and kill rewards must always arrive, as with real TCP — dropping them would be
  // testing a bug that does not exist in the real world.
  const disposable = kind === 's';
  if (disposable && SIM.loss && Math.random() < SIM.loss) {
    simStat.dropped++;
    logTrace(kind, bytes, 0, 1);
    return;
  }
  let d = SIM.lag + (SIM.jitter ? (Math.random() * 2 - 1) * SIM.jitter : 0);
  if (disposable && SIM.reorder && Math.random() < SIM.reorder) d += 20 + Math.random() * 60; // push back so later packets overtake it
  d = Math.max(0, Math.round(d));
  simStat.sent++;
  simStat.bytes += bytes;
  simStat.delaySum += d;
  logTrace(kind, bytes, d, 0);
  const deliver = () => {
    if (ws.readyState !== 1) return;
    try { ws.send(raw); } catch (e) { /* dead socket */ }
  };
  if (d > 0) setTimeout(deliver, d);
  else deliver();
  if (disposable && SIM.dup && Math.random() < SIM.dup) {
    simStat.dup++;
    setTimeout(deliver, d + 5 + Math.random() * 25);
  }
}

if (SIM_ON) {
  const timer = setInterval(() => {
    if (!simStat.sent && !simStat.dropped) return;
    const avg = simStat.delaySum / (simStat.sent || 1);
    console.log(`[netsim] ${simStat.sent} packets · dropped ${simStat.dropped} · duplicated ${simStat.dup} · mean delay ${avg.toFixed(1)} ms · ${(simStat.bytes / 1024).toFixed(1)} KB`);
    simStat.sent = simStat.dropped = simStat.dup = simStat.delaySum = simStat.bytes = 0;
  }, 10000);
  timer.unref?.();
}

const server = http.createServer((req, res) => {
  let urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';
  const file = path.join(ROOT, path.normalize(urlPath).replace(/^[/\\]+/, ''));
  if (!file.startsWith(ROOT)) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('403');
    return;
  }
  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Not found: ' + urlPath);
      return;
    }
    res.writeHead(200, {
      'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'cache-control': 'no-cache',
    });
    res.end(buf);
  });
});

const wss = new WebSocketServer({
  server,
  path: '/ws',
  perMessageDeflate: false, // compression adds per-packet latency — off for a realtime game
  maxPayload: 1 << 20,
  clientTracking: true,
});

/** roomKey -> { key, host: ws|null, members: Map<ws, member> } */
const rooms = new Map();
let nextPeerId = 1;

function send(ws, obj) {
  if (!ws || !obj) return;
  rawSend(ws, JSON.stringify(obj), obj.t ? String(obj.t) : 'ctl');
}

function rosterOf(room) {
  const list = [];
  for (const m of room.members.values()) list.push({ i: m.id, n: m.name });
  return list;
}

function broadcast(room, obj, except) {
  const raw = JSON.stringify(obj);
  const kind = obj && obj.t ? String(obj.t) : 'ctl';
  for (const m of room.members.values()) {
    if (m.ws === except) continue;
    rawSend(m.ws, raw, kind);
  }
}

function joinRoom(ws, key, name) {
  const member = {
    ws,
    id: nextPeerId++,
    name: String(name || 'guest').slice(0, 16),
    presence: null,
  };
  ws.meta = member;

  let room = rooms.get(key);
  if (!room) {
    room = { key, host: null, members: new Map() };
    rooms.set(key, room);
  }
  room.members.set(ws, member);
  member.room = room;
  if (!room.host || room.host.readyState !== 1) room.host = ws;

  send(ws, {
    t: 'welcome',
    i: member.id,
    r: key,
    h: room.host === ws ? member.id : (room.host.meta ? room.host.meta.id : 0),
  });

  const peers = { t: 'peers', l: rosterOf(room), h: room.host.meta ? room.host.meta.id : 0 };
  broadcast(room, peers);

  // the host needs to know about new members to create "shadow" player
  if (room.host !== ws) {
    send(room.host, { t: 'join', i: member.id, n: member.name });
  } else {
    for (const m of room.members.values()) {
      if (m.ws !== ws) send(ws, { t: 'join', i: m.id, n: m.name });
    }
  }
  console.log(`[room ${key}] +${member.name}#${member.id} (${room.members.size} players)`);
}

function leaveRoom(ws) {
  const member = ws.meta;
  if (!member || !member.room) return;
  const room = member.room;
  room.members.delete(ws);
  console.log(`[room ${room.key}] -${member.name}#${member.id} (${room.members.size} players)`);

  if (room.host === ws) {
    room.host = null;
    for (const m of room.members.values()) {
      if (m.ws.readyState === 1) {
        room.host = m.ws;
        break;
      }
    }
    if (room.host) {
      broadcast(room, { t: 'host', h: room.host.meta.id });
      console.log(`[room ${room.key}] host moved to #${room.host.meta.id}`);
    }
  }

  broadcast(room, { t: 'left', i: member.id });
  if (room.members.size === 0) rooms.delete(room.key);
  ws.meta = null;
}

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    if (raw.length > 1 << 20) return;
    let m;
    try {
      m = JSON.parse(raw);
    } catch (e) {
      return;
    }
    if (!m || typeof m.t !== 'string') return;

    if (m.t === 'j') {
      const key = String(m.r || 'phong1').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 40) || 'phong1';
      joinRoom(ws, key, m.n);
      return;
    }

    const member = ws.meta;
    if (!member || !member.room) return;
    const room = member.room;

    switch (m.t) {
      case 'i': // player input -> only the host handles it
        if (room.host && room.host !== ws) {
          m.f = member.id;
          send(room.host, m);
        }
        break;

      case 's': // host snapshot -> every other machine
        if (room.host !== ws) return;
        m.f = m.f | 0;
        broadcast(room, m, ws);
        break;

      case 'e': // events (shots, revives, kills...)
        m.f = member.id;
        broadcast(room, m, ws);
        break;

      case 'p': // presence -> only the host needs it
        if (room.host && room.host !== ws) {
          m.f = member.id;
          send(room.host, m);
        }
        break;

      case 'rw': // rewards the host sends to the player who scored the kill
        if (room.host !== ws) return;
        for (const mm of room.members.values()) {
          if (mm.id === m.to) {
            send(mm.ws, m);
            break;
          }
        }
        break;

      case 'pi': // ping measurement
        send(ws, { t: 'po', c: m.c });
        break;

      default:
        break;
    }
  });

  ws.on('close', () => leaveRoom(ws));
  ws.on('error', () => leaveRoom(ws));
});

// Clean up dead connections (network loss, shutdown) so rooms do not jam
const sweep = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      leaveRoom(ws);
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    try { ws.ping(); } catch (e) { /* dropped qua */ }
  }
}, 20000);
sweep.unref?.();

server.listen(PORT, () => {
  const nets = require('os').networkInterfaces();
  const lan = [];
  for (const name of Object.keys(nets)) {
    for (const n of nets[name] || []) {
      if (n.family === 'IPv4' && !n.internal) lan.push(n.address);
    }
  }
  console.log('Đêm Xác Sống — co-op server running');
  console.log('  This machine:      http://localhost:' + PORT);
  lan.forEach((ip) => console.log('  LAN:     http://' + ip + ':' + PORT));
  if (SIM_ON) {
    console.log('  Network simulation: lag ' + SIM.lag + 'ms · jitter ' + SIM.jitter + 'ms · lost ' + (SIM.loss * 100).toFixed(1) +
      '% · duplicated ' + (SIM.dup * 100).toFixed(1) + '% · reordered ' + (SIM.reorder * 100).toFixed(1) + '%');
    if (TRACE) console.log('  Packet trace: ' + TRACE);
  } else {
    console.log('  Real network (no simulation). Add --lag/--loss to test a bad link, see docs/qa.md.');
  }
  console.log('  Open two tabs (or two machines) and enter the same room code to play co-op.');
});

process.on('SIGINT', () => {
  console.log('\nShutting down...');
  for (const room of rooms.values()) broadcast(room, { t: 'bye' });
  if (traceOut) { try { traceOut.end(); } catch (e) { /* dropped qua */ } }
  wss.close();
  server.close(() => process.exit(0));
});
