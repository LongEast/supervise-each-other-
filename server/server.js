// Buddy Pet relay server
// 两个人加入同一个「房间」，服务器只做实时转发：状态、戳一下、今日计划/复盘、上下线。
// 什么都不落盘：重启后缓存清空，客户端重连时会自己重发。
// 运行：npm install && npm start   （PORT 环境变量可改端口，默认 8787）

const http = require('http');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT || 8787);
const MAX_MEMBERS = Number(process.env.MAX_MEMBERS || 2);
const POKE_COOLDOWN_MS = Number(process.env.POKE_COOLDOWN_MS || 30_000);
const MAX_MSG_BYTES = 8 * 1024;
const MAX_JOURNAL_ITEMS = 8;

/** rooms: Map<roomId, { secretHash, members: Map<name, { ws, status, journal, lastPokeAt }> }> */
const rooms = new Map();

const hash = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const send = (ws, obj) => {
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
};
const clean = (s, max) => String(s ?? '').trim().slice(0, max);
// 用户手写的多行内容：先把换行等控制字符换成空格，再截断
const cleanText = (s, max) => clean(String(s ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' '), max);
const cleanTs = (n) => (Number.isFinite(n) && n > 0 ? Math.floor(n) : null);

/** 今日计划/复盘：只留认识的字段，条数和每个字段的长度都有上限；日期格式不对返回 null */
function cleanJournal(j) {
  if (!j || typeof j !== 'object' || typeof j.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(j.date)) return null;
  const items = (Array.isArray(j.items) ? j.items : [])
    .slice(0, MAX_JOURNAL_ITEMS)
    .map((it) => ({ text: cleanText(it?.text, 60), done: !!it?.done, reason: cleanText(it?.reason, 120) }))
    .filter((it) => it.text);
  return { date: j.date, items, planAt: cleanTs(j.planAt), reviewAt: cleanTs(j.reviewAt), improve: cleanText(j.improve, 200) };
}

function broadcast(room, exceptName, obj) {
  for (const [name, m] of room.members) {
    if (name !== exceptName && m.ws) send(m.ws, obj);
  }
}

function peersOf(room, me) {
  const out = [];
  for (const [name, m] of room.members) {
    if (name === me) continue;
    out.push({ name, online: !!m.ws, status: m.status || null, journal: m.journal || null });
  }
  return out;
}

const server = http.createServer((req, res) => {
  // 健康检查，方便部署平台探活
  res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('buddy-pet relay ok\n');
});

const wss = new WebSocketServer({ server, maxPayload: MAX_MSG_BYTES });

wss.on('connection', (ws) => {
  let roomId = null;
  let me = null;
  ws.isAlive = true;
  ws.on('pong', () => (ws.isAlive = true));
  // 超过 MAX_MSG_BYTES 或格式非法的帧会触发 error，ws 随后自己断开这条连接；
  // 不监听的话会变成未捕获异常，整个服务器进程退出
  ws.on('error', () => {});

  // 10 秒内没完成 hello 就断开
  const helloTimer = setTimeout(() => {
    if (!me) ws.close(4000, 'hello timeout');
  }, 10_000);

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (msg.type === 'hello') {
      if (me) return;
      const rid = clean(msg.room, 64);
      const name = clean(msg.name, 24);
      const secret = String(msg.secret ?? '');
      if (!rid || !name || !secret) {
        send(ws, { type: 'error', code: 'bad_hello', message: '房间号、密码、昵称都要填' });
        return ws.close(4001, 'bad hello');
      }
      let room = rooms.get(rid);
      if (!room) {
        room = { secretHash: hash(secret), members: new Map() };
        rooms.set(rid, room);
      } else if (room.secretHash !== hash(secret)) {
        send(ws, { type: 'error', code: 'bad_secret', message: '房间密码不对' });
        return ws.close(4003, 'bad secret');
      }
      const existing = room.members.get(name);
      if (!existing && room.members.size >= MAX_MEMBERS) {
        send(ws, { type: 'error', code: 'room_full', message: '房间已满（最多 ' + MAX_MEMBERS + ' 人）' });
        return ws.close(4004, 'room full');
      }
      if (existing && existing.ws && existing.ws !== ws) {
        // 同名重连：踢掉旧连接
        send(existing.ws, { type: 'error', code: 'replaced', message: '你在别处登录了' });
        existing.ws.close(4005, 'replaced');
      }
      clearTimeout(helloTimer);
      roomId = rid;
      me = name;
      const member = existing || { status: null, journal: null, lastPokeAt: 0 };
      member.ws = ws;
      room.members.set(name, member);
      send(ws, { type: 'welcome', you: name, peers: peersOf(room, name) });
      broadcast(room, name, { type: 'presence', name, online: true });
      return;
    }

    if (!me) return;
    const room = rooms.get(roomId);
    if (!room) return;
    const member = room.members.get(me);
    if (!member || member.ws !== ws) return;

    if (msg.type === 'status' && msg.status && typeof msg.status === 'object') {
      member.status = { ...msg.status, ts: Date.now() };
      broadcast(room, me, { type: 'status', from: me, status: member.status });
      return;
    }

    if (msg.type === 'poke') {
      const now = Date.now();
      const wait = member.lastPokeAt + POKE_COOLDOWN_MS - now;
      if (wait > 0) {
        send(ws, { type: 'poke_rejected', retryInMs: wait });
        return;
      }
      member.lastPokeAt = now;
      const text = clean(msg.text, 140) || '戳了你一下';
      broadcast(room, me, { type: 'poke', from: me, text, ts: now });
      send(ws, { type: 'poke_ok', ts: now });
      return;
    }

    if (msg.type === 'journal') {
      const journal = cleanJournal(msg.journal);
      if (!journal) return;
      // 每人只缓存日期最新的一份：过了零点补交昨天的复盘时照常转发，但不能把今天的缓存盖掉
      if (!member.journal || journal.date >= member.journal.date) member.journal = journal;
      broadcast(room, me, { type: 'journal', from: me, journal });
      return;
    }
  });

  ws.on('close', () => {
    clearTimeout(helloTimer);
    if (!me) return;
    const room = rooms.get(roomId);
    const member = room && room.members.get(me);
    if (member && member.ws === ws) {
      member.ws = null;
      broadcast(room, me, { type: 'presence', name: me, online: false });
    }
  });
});

// 心跳：清理掉线但没触发 close 的连接
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, 30_000);
wss.on('close', () => clearInterval(heartbeat));

server.listen(PORT, () => {
  console.log(`[buddy-pet] relay listening on :${PORT}`);
});

module.exports = { server, wss, cleanJournal };
