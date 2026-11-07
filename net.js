/* Đêm Xác Sống — engine co-op.
 * Kiến trúc kiểu "battleground" hiện đại:
 *   - Host-authoritative: một máy làm chủ, mô phỏng thế giới, phát snapshot 20 Hz.
 *   - Client-side prediction + reconciliation: máy khác chạy dự đoán di chuyển của mình,
 *     chỉ kéo lệch khi lệch thật, nên không bị giật kiểu "teleport".
 *   - Snapshot interpolation: quái/vật phẩm được nội suy giữa 2 snapshot (đệm ~100 ms)
 *     thay vì nhảy theo gói tin.
 *   - Quantize + AOI: toạ độ làm tròn, chỉ gửi thực thể trong bán kính 1300 px quanh
 *     đồng đội, dữ liệu hiển thị (màu, hình) chỉ gửi 1 lần cho mỗi thực thể.
 *   - Delta-lite: gói tin nhỏ, không nén (nén làm tăng trễ).
 * Bật/tắt bảng thông số mạng bằng F3.
 */
(function () {
  'use strict';
  if (window.NET && window.NET.__coop) return;

  var NET = (window.NET = { __coop: true });
  var api = null;
  NET.attach = function (a) { api = a; };
  function S() { return api ? api.S() : null; }
  function msg(t) { if (api && api.msg) api.msg(t); }
  function now() { return (window.performance && performance.now) ? performance.now() : Date.now(); }
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }

  var TICK_MS = 50;   // 20 snapshot/giây (host)
  var IN_MS = 25;     // 40 input/giây (client)
  var PRES_MS = 100;  // 10 presence/giây
  var AOI = 1300;     // bán kính quan tâm (px)
  var WW = 98304000;
  var WH = 65536000;

  var ws = null, open = false, myId = 0, roomKey = '', isHost = false;
  var roster = [], room = null, handlers = {}, welcomeRes = null, welcomeTimer = 0;
  var netPlayers = [];
  var shadows = {};          // host: người chơi từ xa
  var eid = 0;               // id thực thể do host cấp
  var E = { z: {}, c: {}, i: {} };
  var lastArrive = 0, eIn = 50, interp = 100;
  var zSeen = 0, waveSeen = -1; // client: đã thấy quái của đợt này chưa
  var authSelf = null, authAt = 0, selfDn = 0;
  var stat = {
    frame: 0, inSeq: 0, lastIn: 0, lastPres: 0, lastTick: 0, lastPing: 0,
    ping: 0, jitter: 0, pl: 0, snaps: 0, sps: 0, corr: 0, din: 0, dout: 0,
    lastSec: now(), secSnaps: 0
  };

  /* ------------------------------------------------------------------ đồ hoạ phụ */

  var graph = null;
  function graphEl() {
    if (graph) return graph;
    graph = document.createElement('div');
    graph.id = 'netgraph';
    graph.style.cssText = 'position:fixed;left:8px;top:8px;z-index:99;font:800 11px/1.45 ui-monospace,monospace;' +
      'color:#9be15d;background:rgba(4,10,8,.86);border:1px solid #9be15d55;border-radius:8px;' +
      'padding:6px 9px;display:none;white-space:pre;text-shadow:0 1px 2px #000';
    var body = document.createElement('div');
    body.id = 'ngtext';
    var btn = document.createElement('button');
    btn.textContent = '⬇ xuất CSV';
    btn.style.cssText = 'margin-top:6px;font:800 10px ui-monospace,monospace;background:#9be15d;color:#04120a;' +
      'border:0;border-radius:5px;padding:3px 8px;cursor:pointer';
    btn.addEventListener('click', function (e) { e.preventDefault(); NET.exportCSV(); });
    graph.appendChild(body);
    graph.appendChild(btn);
    document.body.appendChild(graph);
    return graph;
  }
  // Trình duyệt dừng requestAnimationFrame khi tab bị ẩn. Với host, việc đó làm cả
  // phòng đứng yên — phải nói thẳng cho người chơi biết thay vì để họ đoán.
  document.addEventListener('visibilitychange', function () {
    if (document.hidden && isHost && api && api.msg) {
      api.msg('Chủ phòng: giữ tab hiển thị, nếu không đồng đội sẽ đứng yên.');
    }
  });

  window.addEventListener('keydown', function (e) {
    if (e.key === 'F3') {
      var g = graphEl();
      g.style.display = g.style.display === 'block' ? 'none' : 'block';
      e.preventDefault();
    }
  });

  /* ------------------------------------------------------------------ số liệu đo */

  var perf = {
    rows: [], frames: 0, fps: 0, fpsT0: now(), lastSample: now(), lastPaint: 0,
    lastBytes: 0, simMs: 0, drawMs: 0
  };

  function pc(arr, p) {
    if (!arr.length) return 0;
    var a = arr.slice().sort(function (x, y) { return x - y; });
    return a[Math.min(a.length - 1, Math.max(0, Math.floor(a.length * p)))];
  }

  function heapMB() {
    var m = window.performance && performance.memory;
    return m ? +(m.usedJSHeapSize / 1048576).toFixed(1) : -1;
  }

  function sampleRow(t) {
    var st = S();
    var total = stat.din + stat.dout;
    var kb = (total - perf.lastBytes) / 1024;
    perf.lastBytes = total;
    perf.rows.push({
      s: +(t / 1000).toFixed(1),
      fps: +perf.fps.toFixed(1),
      sim: +perf.simMs.toFixed(2),
      draw: +perf.drawMs.toFixed(2),
      snaps: stat.sps,
      kb: +Math.max(0, kb).toFixed(1),
      corr: stat.corr,
      ping: Math.round(stat.ping),
      jitter: +stat.jitter.toFixed(1),
      z: st ? st.z.length : -1,
      b: st ? st.b.length : -1,
      sp: st ? st.sp.length : -1,
      heap: heapMB()
    });
    if (perf.rows.length > 7200) perf.rows.shift(); // 2 giờ ở 1 mẫu/giây
  }

  function paint() {
    if (!graph || graph.style.display !== 'block') return;
    var el = document.getElementById('ngtext');
    if (!el) return;
    var s = NET.summary();
    var st = S();
    el.textContent =
      (isHost ? 'HOST' : 'CLIENT') + '  ping ' + s.ping + 'ms  jit ' + s.jitter.toFixed(1) + '\n' +
      'fps ' + perf.fps.toFixed(0) + '  sim ' + perf.simMs.toFixed(1) + 'ms  draw ' + perf.drawMs.toFixed(1) + 'ms\n' +
      'snap ' + stat.sps + '/s  interp ' + interp.toFixed(0) + 'ms  corr ' + stat.corr + '\n' +
      'quái ' + (st ? st.z.length : 0) + ' · đạn ' + (st ? st.b.length : 0) + ' · bạn ' + netPlayers.length + '\n' +
      'p95 draw ' + s.draw[1].toFixed(1) + 'ms · ' + s.kb[1].toFixed(1) + ' KB/s';
  }

  function tickMetrics(t) {
    perf.frames++;
    if (t - perf.fpsT0 >= 500) {
      perf.fps = perf.frames * 1000 / (t - perf.fpsT0);
      perf.frames = 0;
      perf.fpsT0 = t;
    }
    if (t - perf.lastSample >= 1000) {
      perf.lastSample = t;
      sampleRow(t);
      paint();
    } else if (t - perf.lastPaint > 250) {
      perf.lastPaint = t;
      paint();
    }
  }

  NET.timing = function (simMs, drawMs) {
    perf.simMs = perf.simMs ? perf.simMs * 0.85 + simMs * 0.15 : simMs;
    perf.drawMs = perf.drawMs ? perf.drawMs * 0.85 + drawMs * 0.15 : drawMs;
  };

  NET.summary = function () {
    var f = perf.rows.map(function (r) { return r.fps; });
    var sm = perf.rows.map(function (r) { return r.sim; });
    var dr = perf.rows.map(function (r) { return r.draw; });
    var kb = perf.rows.map(function (r) { return r.kb; });
    return {
      seconds: perf.rows.length,
      fps: [pc(f, 0.5), pc(f, 0.95)],
      sim: [pc(sm, 0.5), pc(sm, 0.95)],
      draw: [pc(dr, 0.5), pc(dr, 0.95)],
      kb: [pc(kb, 0.5), pc(kb, 0.95)],
      corr: stat.corr, ping: Math.round(stat.ping), jitter: stat.jitter
    };
  };

  NET.metrics = function () { return perf.rows.slice(); };
  NET.resetMetrics = function () {
    perf.rows = [];
    stat.corr = 0;
    perf.lastBytes = stat.din + stat.dout;
    perf.lastSample = now();
  };

  NET.csv = function () {
    var head = 't_s,fps,sim_ms,draw_ms,snaps_s,kb_s,corr,ping_ms,jitter,zombies,bullets,particles,heap_mb,role\n';
    var body = perf.rows.map(function (r) {
      return [r.s, r.fps, r.sim, r.draw, r.snaps, r.kb, r.corr, r.ping, r.jitter, r.z, r.b, r.sp, r.heap,
        isHost ? 'host' : 'client'].join(',');
    }).join('\n');
    var s = NET.summary();
    var tail = '\n# fps_p50,' + s.fps[0].toFixed(1) + ',fps_p95,' + s.fps[1].toFixed(1) +
      '\n# sim_p95_ms,' + s.sim[1].toFixed(2) + ',draw_p95_ms,' + s.draw[1].toFixed(2) +
      '\n# kb_p95,' + s.kb[1].toFixed(1) + ',corr,' + s.corr + ',ping_ms,' + s.ping + ',jitter,' + s.jitter.toFixed(1) +
      '\n# phút_đo,' + (perf.rows.length / 60).toFixed(1) + '\n';
    return head + body + tail;
  };

  NET.exportCSV = function () {
    var txt = NET.csv();
    var blob = new Blob([txt], { type: 'text/csv;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'netmetrics-' + new Date().toISOString().replace(/[:.]/g, '-') + '.csv';
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
    return txt.length;
  };

  /* ------------------------------------------------------------------ websocket */

  function send(o) {
    if (!open || !ws || ws.readyState !== 1) return;
    var raw = JSON.stringify(o);
    stat.dout += raw.length;
    try { ws.send(raw); } catch (e) { /* mất kết nối */ }
  }

  function makeRoom() {
    return {
      on: function (ev, fn) { (handlers[ev] || (handlers[ev] = [])).push(fn); },
      emit: function (ev, data) {
        // host tự áp dụng lệnh cứu của chính nó (server không gửi lại cho người gửi)
        if (isHost && ev === 'rev' && data && data.to) {
          var sh = shadows[data.to];
          if (sh && sh.dn) { sh.dn = 0; sh.dnT = 0; sh.hp = Math.max(1, sh.max * 0.5); }
        }
        send({ t: 'e', e: ev, d: data || {} });
        return Promise.resolve();
      },
      presence: function (o) {
        var t = now();
        if (t - stat.lastPres < PRES_MS) return Promise.resolve();
        stat.lastPres = t;
        send({ t: 'p', n: o.n, b: o.b | 0, g: o.g | 0, mh: Math.round(o.mh || 80) });
        return Promise.resolve();
      },
      peers: peersList,
      leave: function () { close(); },
      host: function () { return isHost; }
    };
  }

  NET.join = function (key, opts) {
    opts = opts || {};
    if (!location.host) return Promise.reject(new Error('Cần chạy qua máy chủ (node server.js)'));
    return new Promise(function (resolve, reject) {
      var proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
      try {
        ws = new WebSocket(proto + location.host + '/ws');
      } catch (e) {
        reject(e);
        return;
      }
      room = makeRoom();
      roomKey = key;
      handlers = {};
      shadows = {};
      E = { z: {}, c: {}, i: {} };
      netPlayers = [];
      welcomeRes = function () { resolve(room); };
      clearTimeout(welcomeTimer);
      welcomeTimer = setTimeout(function () {
        if (welcomeRes) {
          welcomeRes = null;
          close();
          reject(new Error('Hết thời gian kết nối'));
        }
      }, 8000);

      ws.onopen = function () {
        open = true;
        send({ t: 'j', r: key, n: (opts.name || 'khách').slice(0, 16) });
      };
      ws.onmessage = function (ev) {
        stat.din += (ev.data && ev.data.length) || 0;
        var m;
        try { m = JSON.parse(ev.data); } catch (e) { return; }
        onMsg(m);
      };
      ws.onclose = function () {
        var wasOpen = open;
        open = false;
        isHost = false;
        authSelf = null;
        if (welcomeRes) { welcomeRes = null; reject(new Error('Không kết nối được máy chủ')); return; }
        if (wasOpen && api && api.onDisconnect) api.onDisconnect();
      };
      ws.onerror = function () { /* onclose xử lý */ };
    });
  };

  function close() {
    open = false;
    isHost = false;
    welcomeRes = null;
    clearTimeout(welcomeTimer);
    if (ws) { try { ws.close(); } catch (e) { /* bỏ qua */ } }
    ws = null;
    shadows = {};
    E = { z: {}, c: {}, i: {} };
    netPlayers = [];
    myId = 0;
  }

  function onMsg(m) {
    switch (m.t) {
      case 'welcome':
        myId = m.i;
        setHost(m.h === myId);
        if (roster.length === 0 && myId) roster = [{ i: myId, n: '' }];
        if (welcomeRes) { var fn = welcomeRes; welcomeRes = null; clearTimeout(welcomeTimer); fn(); }
        break;
      case 'peers':
        roster = m.l || [];
        setHost(m.h === myId);
        break;
      case 'host':
        setHost(m.h === myId);
        break;
      case 'join':
        if (isHost) addShadow(m.i, m.n);
        break;
      case 'left':
        delete shadows[m.i];
        break;
      case 's':
        if (!isHost) ingest(m);
        break;
      case 'i':
        if (isHost) onInput(m);
        break;
      case 'p':
        if (isHost) onPresence(m);
        break;
      case 'e':
        if (isHost) onHostEvent(m);
        fire(m.e, { peer: m.f, isMe: m.f === myId, data: m.d || {} });
        break;
      case 'rw':
        if (m.to === myId) {
          var st = S();
          if (st) {
            st.coin += m.c | 0;
            st.score += m.s | 0;
            st.tx.push({ x: st.p.x, y: st.p.y - 30, t: 1.1, s: '+' + (m.c | 0) + ' xu', c: '#ffc83d' });
            if (api && api.hud) api.hud();
          }
        }
        break;
      case 'po': {
        var rtt = now() - m.c;
        stat.pl = rtt;
        stat.ping = stat.ping ? stat.ping * 0.8 + rtt * 0.2 : rtt;
        stat.jitter = stat.jitter * 0.8 + Math.abs(rtt - stat.ping) * 0.2;
        break;
      }
      case 'bye':
        msg('Chủ phòng đã đóng máy chủ.');
        break;
      default:
        break;
    }
  }

  function fire(ev, e) {
    var list = handlers[ev];
    if (!list) return;
    for (var i = 0; i < list.length; i++) {
      try { list[i](e); } catch (err) { /* một handler lỗi không làm sập mạng */ }
    }
  }

  function setHost(v) {
    if (v === isHost) return;
    isHost = v;
    if (isHost) {
      E = { z: {}, c: {}, i: {} };
      authSelf = null;
      for (var id in shadows) delete shadows[id];
    } else {
      shadows = {};
      lastArrive = 0;
      eIn = 50;
    }
  }

  function nameOf(id) {
    for (var i = 0; i < roster.length; i++) if (roster[i].i === id) return roster[i].n || ('P' + id);
    return 'P' + id;
  }

  /* ------------------------------------------------------------------ host */

  function addShadow(id, name) {
    var st = S();
    if (!st || shadows[id] || id === myId) return;
    var a = Math.random() * 6.283;
    shadows[id] = {
      id: id,
      name: name || nameOf(id),
      x: clamp(st.p.x + Math.cos(a) * 90, 16, WW - 16),
      y: clamp(st.p.y + Math.sin(a) * 90, 16, WH - 16),
      a: 0, hp: 80, max: 80, hit: 0, dn: 0, dnT: 0, b: 0, gi: 0,
      inx: 0, iny: 0, inv_: 190
    };
  }

  function onPresence(m) {
    var sh = shadows[m.f];
    if (!sh) { addShadow(m.f, m.n); sh = shadows[m.f]; }
    if (!sh) return;
    if (m.mh) sh.max = Math.max(1, m.mh | 0);
    if (m.b != null) sh.b = m.b | 0;
    if (m.g != null) sh.gi = m.g | 0;
    if (sh.hp > sh.max) sh.hp = sh.max;
  }

  function onInput(m) {
    var sh = shadows[m.f];
    if (!sh) return;
    sh.inx = (m.x | 0) / 100;
    sh.iny = (m.y | 0) / 100;
    sh.inv_ = Math.max(40, Math.min(900, m.v | 0)) || 190;
    if (m.a != null) sh.a = (m.a | 0) / 100;
  }

  function onHostEvent(m) {
    if (m.e === 'shot') applyShot(m.d || {}, m.f);
    else if (m.e === 'rev') {
      var sh = shadows[m.d && m.d.to];
      if (sh && sh.dn) { sh.dn = 0; sh.dnT = 0; sh.hp = Math.max(1, sh.max * 0.5); }
    } else if (m.e === 'chest') {
      var st0 = S();
      if (st0 && m.d && m.d.c) {
        for (var ci = 0; ci < st0.ch.length; ci++) {
          if (st0.ch[ci] && st0.ch[ci]._nid === m.d.c) { st0.ch[ci].life = 0; break; }
        }
      }
    } else if (m.e === 'dn') {
      var s2 = shadows[m.f];
      if (s2 && !s2.dn) { s2.dn = 1; s2.dnT = 30; s2.hp = 1; }
    } else if (m.e === 'kill') {
      var s3 = shadows[m.d && m.d.to];
      if (s3 && !s3.dn) { s3.dn = 1; s3.dnT = 30; s3.hp = 1; }
    }
  }

  function applyShot(d, from) {
    var st = S();
    if (!st || !d.x || !d.y) return;
    var v = d.v || [];
    for (var i = 0; i < v.length && i < 14; i++) {
      st.b.push({
        x: +d.x, y: +d.y, px: +d.x, py: +d.y,
        vx: +v[i][0], vy: +v[i][1],
        l: Math.min(3, +d.l || 1), d: Math.min(60, +d.d || 1),
        cr: 0, pc: 0, h: [], own: from
      });
    }
  }

  function updateShadows(dt) {
    for (var id in shadows) {
      var sh = shadows[id];
      sh.hit = Math.max(0, sh.hit - dt);
      if (sh.dn) {
        sh.dnT -= dt;
        if (sh.dnT <= 0) { sh.dn = 0; sh.hp = sh.max; }
        continue;
      }
      var ix = sh.inx, iy = sh.iny, l = Math.sqrt(ix * ix + iy * iy);
      if (l > 1) { ix /= l; iy /= l; }
      if (l > 0.05) {
        var sp = sh.inv_ * (1 + 0.5 * 0);
        sh.x = clamp(sh.x + ix * sp * dt, 16, WW - 16);
        sh.y = clamp(sh.y + iy * sp * dt, 16, WH - 16);
      }
      if (sh.hp <= 0) { sh.dn = 1; sh.dnT = 30; sh.hp = 1; }
    }
  }

  function nearAny(x, y, zones) {
    for (var i = 0; i < zones.length; i++) {
      var dx = zones[i].x - x, dy = zones[i].y - y;
      if (dx * dx + dy * dy < AOI * AOI) return true;
    }
    return false;
  }

  function zflags(z) {
    var f = 0;
    if (z.burn > 0) f |= 1;
    if (z.fl > 0) f |= 2;
    if (z.ch2) f |= 4;
    if (z.slow > 0) f |= 8;
    return f;
  }

  function hostTick() {
    var st = S();
    if (!st || !open) return;
    var f = ++stat.frame;
    var pl = [[myId, Math.round(st.p.x), Math.round(st.p.y), Math.round(st.p.a * 100),
      Math.round(st.p.hp), Math.round(st.p.max), (st.dn > 0 || st.dead > 0) ? 1 : 0,
      st.sk.b | 0, st.gi | 0]];
    var zones = [{ x: st.p.x, y: st.p.y }];
    for (var id in shadows) {
      var sh = shadows[id];
      pl.push([sh.id, Math.round(sh.x), Math.round(sh.y), Math.round(sh.a * 100),
        Math.round(sh.hp), Math.round(sh.max), sh.dn ? 1 : 0, sh.b | 0, sh.gi | 0]);
      zones.push({ x: sh.x, y: sh.y });
    }

    var zs = [], zn = {}, cs = [], its = [], i, o;
    for (i = 0; i < st.z.length; i++) {
      var z = st.z[i];
      if (z.dead || !nearAny(z.x, z.y, zones)) continue;
      if (!z._nid) z._nid = ++eid;
      zs.push([z._nid, Math.round(z.x), Math.round(z.y), Math.round(z.a * 100),
        Math.round(z.hp), Math.round(z.mx), zflags(z)]);
      if (!z._vs) {
        z._vs = 1;
        zn[z._nid] = [z.t | 0, Math.round(z.r), z.tier | 0, z.sk, z.cl, z.eye, z.hr,
          z.hs ? 1 : 0, Math.round(z.sd || 0), z.ac | 0, z.bn || ''];
      }
    }
    for (i = 0; i < st.ch.length; i++) {
      o = st.ch[i];
      if (!nearAny(o.x, o.y, zones)) continue;
      if (!o._nid) o._nid = ++eid;
      var cf = (o.beam ? 1 : 0) | (o.mim ? 2 : 0) | (o.bomb ? 4 : 0) | (o.perm ? 8 : 0) | (o.opn ? 16 : 0);
      cs.push([o._nid, Math.round(o.x), Math.round(o.y), o.t | 0, Math.round((o.o || 0) * 100), cf]);
    }
    for (i = 0; i < st.it.length; i++) {
      o = st.it[i];
      if (!nearAny(o.x, o.y, zones)) continue;
      if (!o._nid) o._nid = ++eid;
      its.push([o._nid, Math.round(o.x), Math.round(o.y), o.k | 0]);
    }

    send({ t: 's', f: f, w: st.wave | 0, tl: Math.max(0, Math.round(st.tl || 0)),
      p: pl, z: zs, zn: zn, c: cs, i: its });
  }

  /* ------------------------------------------------------------------ client */

  function mkZ(vis, row) {
    var o = {
      x: row[1], y: row[2], a: row[3] / 100, r: 13, t: 0, hp: row[4], mx: row[5],
      ph: 0, fl: 0, burn: 0, slow: 0, ch2: 0, tier: 0, kd: 0, bn: '',
      sk: '#6fa83a', cl: '#3a4a63', eye: '#ff4a3a', hr: '#1a1410', hs: 1, sd: 0, ac: 0
    };
    if (vis) {
      o.t = vis[0] | 0; o.r = vis[1] || 13; o.tier = vis[2] | 0;
      o.sk = vis[3] || o.sk; o.cl = vis[4] || o.cl; o.eye = vis[5] || o.eye;
      o.hr = vis[6] || o.hr; o.hs = vis[7]; o.sd = vis[8] || 0; o.ac = vis[9] | 0;
      o.bn = vis[10] || '';
    }
    return o;
  }

  function ingest(m) {
    var t = now();
    stat.snaps++;
    stat.secSnaps++;
    if (t - stat.lastSec > 1000) {
      stat.sps = Math.round(stat.secSnaps * 1000 / (t - stat.lastSec));
      stat.lastSec = t;
      stat.secSnaps = 0;
    }
    if (lastArrive) eIn = eIn * 0.8 + Math.min(250, t - lastArrive) * 0.2;
    lastArrive = t;
    interp = clamp(eIn * 1.6, 60, 220);

    var st = S();
    if (m.p) {
      netPlayers = m.p;
      for (var i = 0; i < m.p.length; i++) {
        var row = m.p[i];
        if (row[0] !== myId) continue;
        authSelf = { x: row[1], y: row[2] };
        authAt = t;
        if (st) {
          st.p.max = row[5] || st.p.max;
          st.p.hp = row[4];
          if (row[6] === 1 && st.mode === 16 && !(st.dn > 0) && !(st.dead > 0)) {
            st.dn = 30; st.p.hp = 1; st.p.hit = 99;
            msg('Bạn ngã xuống! Chờ đồng đội cứu (30 giây)');
            send({ t: 'e', e: 'dn', d: {} });
          }
          if (row[6] === 0 && st.dn > 0) { st.dn = 0; }
        }
      }
    }
    if (typeof m.w === 'number') {
      if (m.w !== waveSeen) { waveSeen = m.w; zSeen = 0; }
      if (st) {
        st.wave = m.w;
        if (typeof m.tl === 'number' && m.tl > 0) st.tl = m.tl;
      }
    }
    if (m.z && m.z.length) zSeen = 1;

    // quái
    var seen = {}, list = m.z || [];
    for (var k = 0; k < list.length; k++) {
      var a = list[k], id = a[0], e = E.z[id];
      if (!e || (m.zn && m.zn[id])) {
        e = E.z[id] = { obj: mkZ(m.zn && m.zn[id], a), px: a[1], py: a[2], nx: a[1], ny: a[2], t0: t, t1: t + eIn, hp: a[4], mx: a[5], stb: a[6] | 0 };
      }
      e.px = e.nx; e.py = e.ny;
      e.nx = a[1]; e.ny = a[2];
      e.t0 = t; e.t1 = t + eIn;
      e.hp = a[4]; e.mx = a[5] || 1; e.stb = a[6] | 0;
      seen[id] = 1;
    }
    for (var zid in E.z) if (!seen[zid]) delete E.z[zid];

    // rương
    seen = {};
    list = m.c || [];
    for (var q = 0; q < list.length; q++) {
      var c = list[q], cid = c[0], ce = E.c[cid];
      if (!ce) ce = E.c[cid] = { _nid: cid, x: 0, y: 0, t: 0, o: 0, opn: 0, op: 0, life: 1e9, perm: 0, beam: 0, mim: 0, bomb: 0 };
      ce.x = c[1]; ce.y = c[2]; ce.t = c[3] | 0;
      var so = (c[4] | 0) / 100;
      if (so > ce.o) ce.o = so; // giữ tiến độ mở của chính mình, không bị snapshot ghi đè
      var fl = c[5] | 0;
      ce.beam = fl & 1; ce.mim = fl & 2; ce.bomb = fl & 4; ce.perm = fl & 8;
      if (fl & 16) ce.opn = 1;
      seen[cid] = 1;
    }
    for (var ck in E.c) if (!seen[ck]) delete E.c[ck];

    // vật phẩm
    seen = {};
    list = m.i || [];
    for (var w = 0; w < list.length; w++) {
      var it = list[w], iid = it[0], ie = E.i[iid];
      if (!ie) ie = E.i[iid] = { x: 0, y: 0, k: 0, t: 25 };
      ie.x = it[1]; ie.y = it[2]; ie.k = it[3] | 0;
      seen[iid] = 1;
    }
    for (var ik in E.i) if (!seen[ik]) delete E.i[ik];
  }

  function applyWorld(dt) {
    var st = S();
    if (!st) return;
    var t = now() - interp, arr = [], id, e, u, o;

    for (id in E.z) {
      e = E.z[id];
      var span = e.t1 - e.t0;
      u = span > 0 ? (t - e.t0) / span : 1;
      u = u < 0 ? 0 : u > 1 ? 1 : u;
      o = e.obj;
      o.x = e.px + (e.nx - e.px) * u;
      o.y = e.py + (e.ny - e.py) * u;
      o.hp = e.hp;
      o.mx = e.mx;
      o.ph += dt * (o.t === 1 ? 10 : 6);
      o.burn = e.stb & 1 ? 1 : 0;
      o.fl = e.stb & 2 ? 0.08 : 0;
      o.ch2 = e.stb & 4 ? 1 : 0;
      o.slow = e.stb & 8 ? 1 : 0;
      arr.push(o);
    }
    st.z = arr;

    arr = [];
    for (id in E.c) {
      e = E.c[id];
      if (e.opn && e.op <= 0) continue; // đã mở xong, chờ host xoá
      arr.push(e);
    }
    // giữ lại rương "perm" (rương gắn với bản đồ của riêng máy này)
    var keep = st.ch || [];
    for (var k2 = 0; k2 < keep.length; k2++) {
      if (keep[k2] && keep[k2].perm && !keep[k2]._nid) arr.push(keep[k2]);
    }
    st.ch = arr;

    arr = [];
    for (id in E.i) { e = E.i[id]; arr.push(e); }
    st.it = arr;
  }

  function reconcile(dt) {
    var st = S();
    if (!st || !authSelf) return;
    if (now() - authAt > 400) return;
    if (st.dn > 0 || st.dead > 0) return;
    var p = st.p;
    var dx = authSelf.x - p.x, dy = authSelf.y - p.y;
    var d = Math.sqrt(dx * dx + dy * dy);
    if (d > 200) {
      p.x = authSelf.x; p.y = authSelf.y;
      stat.corr++;
    } else if (d > 0.8) {
      var k = Math.min(1, dt * 14);
      p.x += dx * k; p.y += dy * k;
      if (d > 24) stat.corr++;
    }
  }

  function sendInput() {
    var st = S();
    if (!st) return;
    var p = st.p;
    var sp = 190 * (1 + 0.08 * st.lv.spd + 0.06 * st.hw.hwspd + 0.04 * st.hw.hwms) * (st.haste > 0 ? 1.4 : 1);
    send({
      t: 'i', s: ++stat.inSeq,
      x: Math.round((st.imx || 0) * 100), y: Math.round((st.imy || 0) * 100),
      a: Math.round(p.a * 100), v: Math.round(sp)
    });
  }

  function peersList() {
    var out = [], i, row;
    for (i = 0; i < netPlayers.length; i++) {
      row = netPlayers[i];
      out.push({
        peer: row[0],
        isMe: row[0] === myId,
        sameTab: row[0] === myId,
        presence: {
          n: nameOf(row[0]), x: row[1], y: row[2], a: row[3] / 100,
          hp: row[4], mh: row[5] || 100, d: row[6] | 0, b: row[7] | 0, g: row[8] | 0,
          sc: 0, k: 0, dth: 0
        }
      });
    }
    return out;
  }

  /* ------------------------------------------------------------------ vòng lặp */

  NET.pre = function (dt) {
    if (!open) return;
    var t = now();
    if (isHost) {
      if (t - stat.lastTick >= TICK_MS) { stat.lastTick = t; hostTick(); }
      updateShadows(dt);
    } else {
      if (t - stat.lastIn >= IN_MS) { stat.lastIn = t; sendInput(); }
      if (t - stat.lastPing >= 1000) { stat.lastPing = t; send({ t: 'pi', c: t }); }
    }
    tickMetrics(t);
  };

  NET.post = function (dt) {
    if (!open) return;
    if (!isHost) { applyWorld(dt); reconcile(dt); }
  };

  NET.world = function () { return !(open && !isHost); };
  NET.zSeen = function () { return zSeen === 1; };
  NET.state = function () {
    var st = S();
    return {
      host: isHost, id: myId, connected: open, frame: stat.frame, snaps: stat.snaps,
      sps: stat.sps, ping: Math.round(stat.ping), interp: Math.round(interp),
      players: netPlayers.length, shadows: Object.keys(shadows).length,
      z: st ? st.z.length : -1, ch: st ? st.ch.length : -1,
      hp: st ? Math.round(st.p.hp) : -1, wave: st ? st.wave : -1
    };
  };
  NET.isHost = function () { return isHost; };
  NET.id = function () { return myId; };
  NET.room = function () { return roomKey; };

  NET.aggro = function (z) {
    if (!isHost) return null;
    var best = null, bd = 1100;
    for (var id in shadows) {
      var sh = shadows[id];
      if (sh.dn) continue;
      var d = Math.hypot(sh.x - z.x, sh.y - z.y);
      if (d < bd) { bd = d; best = sh; }
    }
    return best;
  };

  NET.chestOpened = function (nid) {
    if (!open || isHost) return;
    send({ t: 'e', e: 'chest', d: { c: nid } });
  };

  NET.rw = function (to, coin, score) {
    if (!isHost || !to || to === myId) return;
    send({ t: 'rw', to: to, c: Math.round(coin), s: Math.round(score) });
  };
})();
