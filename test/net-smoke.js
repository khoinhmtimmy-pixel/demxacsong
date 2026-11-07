'use strict';
/* Kiểm thử nhanh phần relay của engine co-op (không cần trình duyệt).
 * Chạy: node test/net-smoke.js   (cần server đang chạy ở PORT, mặc định 8090)
 */
const WebSocket = require('ws');

const PORT = Number(process.env.PORT) || 8090;
const URL = 'ws://127.0.0.1:' + PORT + '/ws';
const ROOM = 'zs-16-test';

let failed = 0;
function ok(name, cond, extra) {
  console.log((cond ? '  ✓ ' : '  ✗ ') + name + (cond ? '' : '  ' + (extra || '')));
  if (!cond) failed++;
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function client() {
  const ws = new WebSocket(URL);
  ws.inbox = [];
  ws.on('message', (raw) => ws.inbox.push(JSON.parse(raw.toString())));
  ws.ready = new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  ws.send2 = (o) => ws.send(JSON.stringify(o));
  ws.take = (type) => {
    const i = ws.inbox.findIndex((m) => m.t === type);
    return i >= 0 ? ws.inbox.splice(i, 1)[0] : null;
  };
  return ws;
}

async function main() {
  const a = client();
  await a.ready;
  a.send2({ t: 'j', r: ROOM, n: 'host' });
  await wait(120);
  const wa = a.take('welcome');
  ok('host nhận welcome', !!wa, JSON.stringify(a.inbox));
  ok('host là chủ phòng', wa && wa.h === wa.i);

  const b = client();
  await b.ready;
  b.send2({ t: 'j', r: ROOM, n: 'client' });
  await wait(120);
  const wb = b.take('welcome');
  ok('client nhận welcome', !!wb);
  ok('client thấy host id', wb && wa && wb.h === wa.i);
  ok('host được báo có người vào', !!a.take('join'));

  // input: client -> host
  b.send2({ t: 'i', x: 100, y: 0, a: 157, v: 190 });
  await wait(80);
  const inp = a.take('i');
  ok('input chuyển tới host kèm id người gửi', inp && inp.f === wb.i && inp.x === 100, JSON.stringify(inp));

  // snapshot: host -> client
  a.send2({ t: 's', f: 7, p: [[wa.i, 10, 20, 0, 80, 80, 0, 0, 0]], z: [], c: [], i: [] });
  await wait(80);
  const snap = b.take('s');
  ok('snapshot tới client', snap && snap.f === 7);

  // sự kiện bắn: client -> host
  b.send2({ t: 'e', e: 'shot', d: { x: 5, y: 6, d: 10, l: 1, v: [[100, 0]] } });
  await wait(80);
  const shot = a.take('e');
  ok('sự kiện bắn tới host', shot && shot.e === 'shot' && shot.f === wb.i);

  // thưởng: host -> đúng người
  a.send2({ t: 'rw', to: wb.i, c: 120, s: 50 });
  await wait(80);
  const rw = b.take('rw');
  ok('phần thưởng về đúng người', rw && rw.c === 120);

  // ping
  b.send2({ t: 'pi', c: 123 });
  await wait(80);
  ok('đo ping có phản hồi', !!b.take('po'));

  // host rời phòng -> client lên làm chủ
  a.close();
  await wait(200);
  const promoted = b.take('host');
  ok('bầu lại chủ phòng khi host thoát', promoted && promoted.h === wb.i, JSON.stringify(b.inbox));

  b.close();
  await wait(80);
  console.log(failed ? '\n' + failed + ' kiểm tra THẤT BẠI' : '\nTất cả kiểm tra mạng đều đạt.');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error('Lỗi kiểm thử:', e.message);
  process.exit(1);
});
