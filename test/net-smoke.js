'use strict';
/* Quick relay test for the co-op engine (no browser needed).
 * Run: node test/net-smoke.js   (needs a server on PORT, default 8090)
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
  ok('host receives welcome', !!wa, JSON.stringify(a.inbox));
  ok('host is the room host', wa && wa.h === wa.i);

  const b = client();
  await b.ready;
  b.send2({ t: 'j', r: ROOM, n: 'client' });
  await wait(120);
  const wb = b.take('welcome');
  ok('client receives welcome', !!wb);
  ok('client sees host id', wb && wa && wb.h === wa.i);
  ok('host is told someone joined', !!a.take('join'));

  // input: client -> host
  b.send2({ t: 'i', x: 100, y: 0, a: 157, v: 190 });
  await wait(80);
  const inp = a.take('i');
  ok('input reaches host with the sender id', inp && inp.f === wb.i && inp.x === 100, JSON.stringify(inp));

  // snapshot: host -> client
  a.send2({ t: 's', f: 7, p: [[wa.i, 10, 20, 0, 80, 80, 0, 0, 0]], z: [], c: [], i: [] });
  await wait(80);
  const snap = b.take('s');
  ok('snapshot reaches client', snap && snap.f === 7);

  // shot event: client -> host
  b.send2({ t: 'e', e: 'shot', d: { x: 5, y: 6, d: 10, l: 1, v: [[100, 0]] } });
  await wait(80);
  const shot = a.take('e');
  ok('shot event reaches host', shot && shot.e === 'shot' && shot.f === wb.i);

  // reward: host -> the right player
  a.send2({ t: 'rw', to: wb.i, c: 120, s: 50 });
  await wait(80);
  const rw = b.take('rw');
  ok('reward goes to the right player', rw && rw.c === 120);

  // ping
  b.send2({ t: 'pi', c: 123 });
  await wait(80);
  ok('ping measured, reply received', !!b.take('po'));

  // host leaves the room -> the client takes over
  a.close();
  await wait(200);
  const promoted = b.take('host');
  ok('host re-election when the host leaves', promoted && promoted.h === wb.i, JSON.stringify(b.inbox));

  b.close();
  await wait(80);
  console.log(failed ? '\n' + failed + ' checks FAILED' : '\nAll network checks passed.');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error('Test error:', e.message);
  process.exit(1);
});
