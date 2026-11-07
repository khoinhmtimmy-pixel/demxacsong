'use strict';
/* Đêm Xác Sống — máy chủ co-op.
 * Nhiệm vụ: phục vụ file tĩnh + trung chuyển gói tin giữa các máy trong cùng phòng.
 * Mô hình: host-authoritative (một máy làm chủ, mô phỏng thế giới, phát snapshot),
 * server chỉ relay + bầu host + giữ phòng, nên độ trễ thêm vào gần như bằng 0.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

let WebSocketServer;
try {
  ({ WebSocketServer } = require('ws'));
} catch (err) {
  console.error('[server] Thiếu gói "ws". Chạy: npm install rồi thử lại.');
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

/* --------------------------------------------------------------- giả lập mạng xấu
 * Mặc định TẮT hoàn toàn: không cờ thì relay chạy y như cũ, không thêm setTimeout nào.
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

/** Gửi 1 khung văn bản qua lớp giả lập (hoặc gửi thẳng nếu tắt). */
function rawSend(ws, raw, kind) {
  if (!ws || ws.readyState !== 1) return;
  const bytes = Buffer.byteLength(raw, 'utf8');
  if (!SIM_ON) {
    try { ws.send(raw); } catch (e) { /* socket chết */ }
    return;
  }
  // Chỉ snapshot là dữ liệu "dùng một lần" (gói sau thay gói trước). Input, sự kiện,
  // cứu đồng đội, chia thưởng phải tới đủ như TCP thật — nếu bỏ chúng thì ta đang test
  // một lỗi không tồn tại trong đời thực.
  const disposable = kind === 's';
  if (disposable && SIM.loss && Math.random() < SIM.loss) {
    simStat.dropped++;
    logTrace(kind, bytes, 0, 1);
    return;
  }
  let d = SIM.lag + (SIM.jitter ? (Math.random() * 2 - 1) * SIM.jitter : 0);
  if (disposable && SIM.reorder && Math.random() < SIM.reorder) d += 20 + Math.random() * 60; // đẩy lùi để gói sau vượt lên
  d = Math.max(0, Math.round(d));
  simStat.sent++;
  simStat.bytes += bytes;
  simStat.delaySum += d;
  logTrace(kind, bytes, d, 0);
  const deliver = () => {
    if (ws.readyState !== 1) return;
    try { ws.send(raw); } catch (e) { /* socket chết */ }
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
    console.log(`[netsim] ${simStat.sent} gói · bỏ ${simStat.dropped} · nhân bản ${simStat.dup} · trễ TB ${avg.toFixed(1)} ms · ${(simStat.bytes / 1024).toFixed(1)} KB`);
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
      res.end('Không tìm thấy: ' + urlPath);
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
  perMessageDeflate: false, // nén làm tăng độ trễ từng gói — không dùng cho game realtime
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
    name: String(name || 'khách').slice(0, 16),
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

  // host cần biết thành viên mới để tạo "bóng" người chơi
  if (room.host !== ws) {
    send(room.host, { t: 'join', i: member.id, n: member.name });
  } else {
    for (const m of room.members.values()) {
      if (m.ws !== ws) send(ws, { t: 'join', i: m.id, n: m.name });
    }
  }
  console.log(`[phòng ${key}] +${member.name}#${member.id} (${room.members.size} người)`);
}

function leaveRoom(ws) {
  const member = ws.meta;
  if (!member || !member.room) return;
  const room = member.room;
  room.members.delete(ws);
  console.log(`[phòng ${room.key}] -${member.name}#${member.id} (${room.members.size} người)`);

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
      console.log(`[phòng ${room.key}] chuyển chủ phòng sang #${room.host.meta.id}`);
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
      case 'i': // input của người chơi -> chỉ host xử lý
        if (room.host && room.host !== ws) {
          m.f = member.id;
          send(room.host, m);
        }
        break;

      case 's': // snapshot từ host -> mọi máy khác
        if (room.host !== ws) return;
        m.f = m.f | 0;
        broadcast(room, m, ws);
        break;

      case 'e': // sự kiện (bắn, cứu, hạ gục...)
        m.f = member.id;
        broadcast(room, m, ws);
        break;

      case 'p': // presence -> chỉ host cần
        if (room.host && room.host !== ws) {
          m.f = member.id;
          send(room.host, m);
        }
        break;

      case 'rw': // phần thưởng host gửi cho đúng người hạ gục
        if (room.host !== ws) return;
        for (const mm of room.members.values()) {
          if (mm.id === m.to) {
            send(mm.ws, m);
            break;
          }
        }
        break;

      case 'pi': // đo ping
        send(ws, { t: 'po', c: m.c });
        break;

      default:
        break;
    }
  });

  ws.on('close', () => leaveRoom(ws));
  ws.on('error', () => leaveRoom(ws));
});

// Dọn kết nối chết (mất mạng, tắt máy) để không kẹt phòng
const sweep = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      leaveRoom(ws);
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    try { ws.ping(); } catch (e) { /* bỏ qua */ }
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
  console.log('Đêm Xác Sống — máy chủ co-op đang chạy');
  console.log('  Máy này:      http://localhost:' + PORT);
  lan.forEach((ip) => console.log('  Mạng LAN:     http://' + ip + ':' + PORT));
  if (SIM_ON) {
    console.log('  Giả lập mạng: lag ' + SIM.lag + 'ms · jitter ' + SIM.jitter + 'ms · mất ' + (SIM.loss * 100).toFixed(1) +
      '% · nhân bản ' + (SIM.dup * 100).toFixed(1) + '% · đảo thứ tự ' + (SIM.reorder * 100).toFixed(1) + '%');
    if (TRACE) console.log('  Ghi vết gói tin: ' + TRACE);
  } else {
    console.log('  Mạng thật (không giả lập). Thêm --lag/--loss để thử mạng xấu, xem docs/qa.md.');
  }
  console.log('  Mở 2 tab (hoặc 2 máy) cùng nhập một mã phòng để chơi co-op.');
});

process.on('SIGINT', () => {
  console.log('\nĐang tắt máy chủ...');
  for (const room of rooms.values()) broadcast(room, { t: 'bye' });
  if (traceOut) { try { traceOut.end(); } catch (e) { /* bỏ qua */ } }
  wss.close();
  server.close(() => process.exit(0));
});
