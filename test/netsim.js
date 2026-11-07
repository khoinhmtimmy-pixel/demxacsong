'use strict';
/* Kiểm chứng bộ giả lập mạng xấu của server.js — không cần trình duyệt.
 *
 *   node test/netsim.js
 *
 * Kiểm tra: (1) không cờ thì không thêm trễ và không mất gói,
 *           (2) --lag/--loss tạo đúng mức trễ và đúng tỉ lệ mất snapshot,
 *           (3) file --trace được ghi đúng.
 */
const { spawn } = require('child_process');
const net = require('net');
const fs = require('fs');
const WebSocket = require('ws');

const TRACE = 'test/.trace-test.csv';
let failed = 0;

function ok(name, cond, extra) {
  console.log((cond ? '  ✓ ' : '  ✗ ') + name + (cond ? '' : '  ' + (extra || '')));
  if (!cond) failed++;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitPort(port, ms = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const up = await new Promise((res) => {
      const s = net.connect(port, '127.0.0.1');
      s.on('connect', () => { s.end(); res(true); });
      s.on('error', () => res(false));
    });
    if (up) return true;
    await sleep(120);
  }
  return false;
}

function startServer(port, extra) {
  const p = spawn(process.execPath, ['server.js', ...extra], {
    env: { ...process.env, PORT: String(port) },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  p.stderr.on('data', (d) => process.stderr.write('[server] ' + d));
  return p;
}

function client(port) {
  const ws = new WebSocket('ws://127.0.0.1:' + port + '/ws');
  ws.inbox = [];
  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw.toString()); } catch (e) { return; }
    ws.inbox.push({ m, t: Date.now() });
  });
  ws.ready = new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  ws.send2 = (o) => ws.send(JSON.stringify(o));
  return ws;
}

async function measure(port, count) {
  const a = client(port);
  await a.ready;
  a.send2({ t: 'j', r: 'zs-16-netsim', n: 'host' });
  await sleep(250);
  const b = client(port);
  await b.ready;
  b.send2({ t: 'j', r: 'zs-16-netsim', n: 'client' });
  await sleep(350);

  const sentAt = new Map();
  for (let f = 1; f <= count; f++) {
    sentAt.set(f, Date.now());
    a.send2({ t: 's', f: f, p: [], z: [], c: [], i: [] });
    await sleep(2);
  }
  await sleep(1500);

  const got = b.inbox.filter((x) => x.m.t === 's');
  const delays = got.map((x) => x.t - (sentAt.get(x.m.f) || x.t));
  const mean = delays.reduce((s, v) => s + v, 0) / Math.max(1, delays.length);
  a.close();
  b.close();
  await sleep(120);
  return { sent: count, received: got.length, mean: mean };
}

(async () => {
  try { fs.unlinkSync(TRACE); } catch (e) { /* chưa có file */ }

  // 1) Mạng thật: không cờ thì không được thêm trễ, không được mất gói
  const clean = startServer(8091, []);
  if (!(await waitPort(8091))) {
    console.error('Không khởi động được server ở cổng 8091');
    process.exit(1);
  }
  const good = await measure(8091, 60);
  ok('không cờ: nhận đủ 60 snapshot', good.received === 60, 'nhận ' + good.received);
  ok('không cờ: trễ trung bình < 30 ms', good.mean < 30, good.mean.toFixed(1) + ' ms');
  clean.kill();
  await sleep(200);

  // 2) Mạng xấu: lag 60ms + jitter, mất 20% snapshot
  const bad = startServer(8092, ['--lag', '60', '--jitter', '10', '--loss', '0.2', '--trace', TRACE]);
  if (!(await waitPort(8092))) {
    console.error('Không khởi động được server ở cổng 8092');
    process.exit(1);
  }
  const res = await measure(8092, 200);
  ok('lag 60 ms: trễ trung bình trong khoảng 40–140 ms', res.mean > 40 && res.mean < 140, res.mean.toFixed(1) + ' ms');
  const dropRate = 1 - res.received / 200;
  ok('làm rơi khoảng 20% snapshot', dropRate > 0.05 && dropRate < 0.4, (dropRate * 100).toFixed(0) + '% rơi');
  ok('vẫn giữ được đa số snapshot', res.received > 100, res.received + '/200');
  bad.kill();
  await sleep(350);

  // 3) File vết gói tin
  let header = '';
  let lines = 0;
  try {
    const rows = fs.readFileSync(TRACE, 'utf8').trim().split('\n');
    header = rows[0];
    lines = rows.length - 1;
  } catch (e) { /* không có file */ }
  ok('có file vết gói tin', lines > 100, lines + ' dòng');
  ok('header CSV đúng', header === 'ms,kind,bytes,delay_ms,dropped', header);
  try { fs.unlinkSync(TRACE); } catch (e) { /* bỏ qua */ }

  console.log(failed ? '\n' + failed + ' kiểm tra THẤT BẠI' : '\nBộ giả lập mạng hoạt động đúng.');
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error('Lỗi kiểm thử:', e.message);
  process.exit(1);
});
