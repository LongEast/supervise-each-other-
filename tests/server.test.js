const test = require('node:test');
const assert = require('node:assert/strict');
const WebSocket = require('../server/node_modules/ws');

process.env.PORT = '0';
process.env.POKE_COOLDOWN_MS = '300';
const { server, wss, cleanJournal } = require('../server/server');

const url = () => `ws://127.0.0.1:${server.address().port}`;
const sockets = new Set();

/** 连接并返回一个带消息队列的小客户端 */
function client() {
  const ws = new WebSocket(url());
  sockets.add(ws);
  const queue = [];
  const waiters = [];
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    const i = waiters.findIndex((w) => w.pred(msg));
    if (i >= 0) waiters.splice(i, 1)[0].resolve(msg);
    else queue.push(msg);
  });
  const c = {
    ws,
    send: (obj) => ws.send(typeof obj === 'string' ? obj : JSON.stringify(obj)),
    /** 等一条满足条件的消息（默认按 type） */
    next(typeOrPred, ms = 2000) {
      const pred = typeof typeOrPred === 'function' ? typeOrPred : (m) => m.type === typeOrPred;
      const i = queue.findIndex(pred);
      if (i >= 0) return Promise.resolve(queue.splice(i, 1)[0]);
      return new Promise((resolve, reject) => {
        const w = { pred, resolve };
        waiters.push(w);
        setTimeout(() => {
          const k = waiters.indexOf(w);
          if (k >= 0) {
            waiters.splice(k, 1);
            reject(new Error('等消息超时: ' + typeOrPred));
          }
        }, ms);
      });
    },
    /** 确认一段时间内没有收到某类消息 */
    async none(type, ms = 250) {
      await new Promise((r) => setTimeout(r, ms));
      assert.equal(queue.filter((m) => m.type === type).length, 0, `不应该收到 ${type}`);
    },
    closed: () => new Promise((r) => (ws.readyState === ws.CLOSED ? r() : ws.once('close', (code) => r(code)))),
    close: () => ws.close(),
  };
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve(c));
    ws.once('error', reject);
  });
}

let roomSeq = 0;
/** 两个人加入同一个新房间 */
async function pair() {
  const room = 'room-' + ++roomSeq;
  const a = await client();
  a.send({ type: 'hello', room, secret: 'pw', name: 'Ann' });
  const wa = await a.next('welcome');
  const b = await client();
  b.send({ type: 'hello', room, secret: 'pw', name: 'Tom' });
  const wb = await b.next('welcome');
  await a.next('presence');
  return { room, a, b, wa, wb };
}

test.before(() => new Promise((r) => (server.listening ? r() : server.once('listening', r))));
test.after(() => {
  for (const ws of sockets) ws.terminate();
  wss.close();
  server.close();
});

test('hello → welcome，后加入的人能看到先来的人', async () => {
  const { wa, wb } = await pair();
  assert.equal(wa.you, 'Ann');
  assert.deepEqual(wa.peers, []);
  assert.equal(wb.peers.length, 1);
  assert.equal(wb.peers[0].name, 'Ann');
  assert.equal(wb.peers[0].online, true);
});

test('密码不对会被拒绝', async () => {
  const { room } = await pair();
  const c = await client();
  c.send({ type: 'hello', room, secret: 'wrong', name: 'Eve' });
  const err = await c.next('error');
  assert.equal(err.code, 'bad_secret');
  assert.equal(await c.closed(), 4003);
});

test('房间最多两个人', async () => {
  const { room } = await pair();
  const c = await client();
  c.send({ type: 'hello', room, secret: 'pw', name: 'Third' });
  assert.equal((await c.next('error')).code, 'room_full');
});

test('缺字段的 hello 会被拒绝', async () => {
  const c = await client();
  c.send({ type: 'hello', room: 'x', secret: '', name: 'A' });
  assert.equal((await c.next('error')).code, 'bad_hello');
});

test('status 转发给对方并缓存给后来的人', async () => {
  const room = 'room-' + ++roomSeq;
  const a = await client();
  a.send({ type: 'hello', room, secret: 'pw', name: 'Ann' });
  await a.next('welcome');
  a.send({ type: 'status', status: { category: 'study', app: 'Code' } });
  await new Promise((r) => setTimeout(r, 50));
  const b = await client();
  b.send({ type: 'hello', room, secret: 'pw', name: 'Tom' });
  const wb = await b.next('welcome');
  assert.equal(wb.peers[0].status.category, 'study');
  a.send({ type: 'status', status: { category: 'slack', app: 'chrome', domain: 'bilibili.com' } });
  const s = await b.next('status');
  assert.equal(s.from, 'Ann');
  assert.equal(s.status.domain, 'bilibili.com');
  assert.equal(typeof s.status.ts, 'number');
});

test('poke 转发、截断到 140 字、冷却期内被拒绝', async () => {
  const { a, b } = await pair();
  a.send({ type: 'poke', text: 'x'.repeat(500) });
  const p = await b.next('poke');
  assert.equal(p.from, 'Ann');
  assert.equal(p.text.length, 140);
  await a.next('poke_ok');
  a.send({ type: 'poke', text: 'again' });
  const rej = await a.next('poke_rejected');
  assert.ok(rej.retryInMs > 0 && rej.retryInMs <= 300);
  await b.none('poke');
  await new Promise((r) => setTimeout(r, 320));
  a.send({ type: 'poke', text: '' });
  assert.equal((await b.next('poke')).text, '戳了你一下');
});

test('断线后对方收到 presence，同名重连会顶掉旧连接', async () => {
  const { room, a, b } = await pair();
  b.close();
  const off = await a.next((m) => m.type === 'presence' && m.online === false);
  assert.equal(off.name, 'Tom');
  const a2 = await client();
  a2.send({ type: 'hello', room, secret: 'pw', name: 'Ann' });
  await a2.next('welcome');
  assert.equal((await a.next('error')).code, 'replaced');
  assert.equal(await a.closed(), 4005);
});

test('坏 JSON 和 hello 之前的消息被忽略，连接不会断', async () => {
  const c = await client();
  c.send('not json');
  c.send({ type: 'poke', text: 'hi' });
  c.send({ type: 'hello', room: 'room-' + ++roomSeq, secret: 'pw', name: 'Solo' });
  assert.equal((await c.next('welcome')).you, 'Solo');
});

// ---------- 今日计划 / 复盘（journal） ----------
const journalOf = (over = {}) => ({ date: '2026-03-10', items: [{ text: '写论文', done: false }, { text: '跑步', done: true }], planAt: 1000, reviewAt: null, improve: '', ...over });

test('journal 转发给对方，并带上发送者', async () => {
  const { a, b } = await pair();
  a.send({ type: 'journal', journal: journalOf() });
  const m = await b.next('journal');
  assert.equal(m.from, 'Ann');
  assert.deepEqual(m.journal, {
    date: '2026-03-10',
    items: [{ text: '写论文', done: false, reason: '' }, { text: '跑步', done: true, reason: '' }],
    planAt: 1000,
    reviewAt: null,
    improve: '',
  });
  await a.none('journal'); // 不会回显给自己
});

test('journal 缓存每人最新的一份，后加入 / 重连的人在 welcome 里就能拿到', async () => {
  const room = 'room-' + ++roomSeq;
  const a = await client();
  a.send({ type: 'hello', room, secret: 'pw', name: 'Ann' });
  const wa = await a.next('welcome');
  assert.deepEqual(wa.peers, []);
  a.send({ type: 'journal', journal: journalOf() });
  a.send({ type: 'journal', journal: journalOf({ items: [{ text: '写论文', done: true }] }) });
  await new Promise((r) => setTimeout(r, 50));
  const b = await client();
  b.send({ type: 'hello', room, secret: 'pw', name: 'Tom' });
  const wb = await b.next('welcome');
  assert.deepEqual(wb.peers[0].journal.items, [{ text: '写论文', done: true, reason: '' }]);
  // Ann 掉线后缓存还在；Tom 重连仍能拿到
  a.close();
  await b.next((m) => m.type === 'presence' && m.online === false);
  const b2 = await client();
  b2.send({ type: 'hello', room, secret: 'pw', name: 'Tom' });
  const wb2 = await b2.next('welcome');
  assert.equal(wb2.peers[0].online, false);
  assert.equal(wb2.peers[0].journal.planAt, 1000);
});

test('还没发过 journal 时，welcome 里是 null', async () => {
  const { wb } = await pair();
  assert.equal(wb.peers[0].journal, null);
});

test('journal 日期切换：新一天的盖掉旧的；补交昨天的会转发，但不会盖掉今天的缓存', async () => {
  const room = 'room-' + ++roomSeq;
  const a = await client();
  a.send({ type: 'hello', room, secret: 'pw', name: 'Ann' });
  await a.next('welcome');
  const b = await client();
  b.send({ type: 'hello', room, secret: 'pw', name: 'Tom' });
  await b.next('welcome');
  a.send({ type: 'journal', journal: journalOf({ date: '2026-03-10' }) });
  a.send({ type: 'journal', journal: { date: '2026-03-11', items: [] } }); // 过了零点，新的一天还没写
  a.send({ type: 'journal', journal: journalOf({ date: '2026-03-10', reviewAt: 2000 }) }); // 补交昨天的复盘
  assert.equal((await b.next('journal')).journal.date, '2026-03-10');
  assert.equal((await b.next('journal')).journal.date, '2026-03-11');
  const late = await b.next('journal');
  assert.equal(late.journal.date, '2026-03-10');
  assert.equal(late.journal.reviewAt, 2000);
  const b2 = await client();
  b2.send({ type: 'hello', room, secret: 'pw', name: 'Tom' });
  const w = await b2.next('welcome');
  assert.deepEqual(w.peers[0].journal, { date: '2026-03-11', items: [], planAt: null, reviewAt: null, improve: '' });
});

test('journal 字段清洗：多余字段丢掉，最多 8 条，超长截断，换行变空格', async () => {
  const { a, b } = await pair();
  a.send({
    type: 'journal',
    journal: {
      date: '2026-03-10',
      items: Array.from({ length: 12 }, (_, i) => ({ text: `事情${i}` + 'x'.repeat(100), done: 'yes', reason: 'r'.repeat(300), title: '窗口标题' })),
      planAt: '不是数字',
      reviewAt: 5.7,
      improve: '早点\n开始' + '！'.repeat(300),
      url: 'https://example.com/a?b=c',
      extra: { nested: true },
    },
  });
  const j = (await b.next('journal')).journal;
  assert.deepEqual(Object.keys(j).sort(), ['date', 'improve', 'items', 'planAt', 'reviewAt']);
  assert.equal(j.items.length, 8);
  assert.deepEqual(Object.keys(j.items[0]).sort(), ['done', 'reason', 'text']);
  assert.equal(j.items[0].text.length, 60);
  assert.equal(j.items[0].reason.length, 120);
  assert.equal(j.items[0].done, true);
  assert.equal(j.planAt, null);
  assert.equal(j.reviewAt, 5);
  assert.equal(j.improve.length, 200);
  assert.ok(j.improve.startsWith('早点 开始'));
});

test('格式不对的 journal 直接丢掉，不转发也不缓存', async () => {
  const { room, a, b } = await pair();
  for (const journal of [null, 'x', 42, [], {}, { date: '昨天', items: [] }, { date: '2026-3-1' }, { date: 20260310 }]) a.send({ type: 'journal', journal });
  await b.none('journal');
  const b2 = await client();
  b2.send({ type: 'hello', room, secret: 'pw', name: 'Tom' });
  assert.equal((await b2.next('welcome')).peers[0].journal, null);
});

test('超过 8KB 的消息只断开这一条连接，服务器不会崩，别人不受影响', async () => {
  const { a, b } = await pair();
  a.send({ type: 'journal', journal: { date: '2026-03-10', items: [{ text: 'x'.repeat(9000) }] } });
  assert.equal(await a.closed(), 1009);
  assert.equal((await b.next((m) => m.type === 'presence' && m.online === false)).name, 'Ann');
  b.send({ type: 'status', status: { category: 'study' } }); // 服务器还活着
  const c = await client();
  c.send({ type: 'hello', room: 'room-' + ++roomSeq, secret: 'pw', name: 'Solo' });
  assert.equal((await c.next('welcome')).you, 'Solo');
});

test('cleanJournal 和客户端的清洗规则一致', () => {
  const client = require('../client/journal');
  const samples = [
    journalOf(),
    { date: '2026-03-10', items: Array.from({ length: 20 }, (_, i) => ({ text: '汉'.repeat(100) + i, done: i % 2, reason: '\u0000a\tb'.repeat(80) })), planAt: 3.3, reviewAt: -1, improve: '  多\r\n行  ' },
    { date: '2026-03-10', items: 'nope', improve: 5 },
    { date: 'bad' },
    null,
  ];
  for (const s of samples) assert.deepEqual(cleanJournal(s), client.cleanJournal(s));
});
