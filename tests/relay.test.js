const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('events');

process.env.PORT = '0';
const { server, wss } = require('../server/server');
const { RelayClient } = require('../client/relay');

const url = () => `ws://127.0.0.1:${server.address().port}`;
const clients = [];
function relay() {
  const r = new RelayClient();
  clients.push(r);
  return r;
}
const until = (r, state) =>
  new Promise((resolve) => {
    if (r.state === state) return resolve();
    const h = () => r.state === state && (r.off('state', h), resolve());
    r.on('state', h);
  });

test.before(() => new Promise((r) => (server.listening ? r() : server.once('listening', r))));
test.after(() => {
  for (const r of clients) r.close();
  for (const ws of wss.clients) ws.terminate();
  wss.close();
  server.close();
});

test('配置不全时不连接，直接报错', () => {
  const r = relay();
  r.connect({ serverUrl: '', room: 'a', secret: 'b', name: 'c' });
  assert.equal(r.state, 'error');
  assert.equal(r.send({ type: 'status' }), false);
});

test('连上后 online，两个客户端互相收到 status 和 poke', async () => {
  const a = relay();
  const b = relay();
  a.connect({ serverUrl: url(), room: 'relay-1', secret: 'pw', name: 'Ann' });
  await until(a, 'online');
  b.connect({ serverUrl: url(), room: 'relay-1', secret: 'pw', name: 'Tom' });
  await until(b, 'online');
  const got = [];
  b.on('message', (m) => got.push(m));
  assert.equal(a.send({ type: 'status', status: { category: 'study' } }), true);
  a.send({ type: 'poke', text: '嗨' });
  await new Promise((r) => setTimeout(r, 150));
  assert.ok(got.some((m) => m.type === 'status' && m.from === 'Ann'));
  assert.ok(got.some((m) => m.type === 'poke' && m.text === '嗨'));
});

test('密码错是致命错误，不会自动重连', async () => {
  const a = relay();
  a.connect({ serverUrl: url(), room: 'relay-2', secret: 'pw', name: 'Ann' });
  await until(a, 'online');
  const b = relay();
  b.connect({ serverUrl: url(), room: 'relay-2', secret: 'nope', name: 'Tom' });
  await until(b, 'error');
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(b._fatal, true);
  assert.equal(b.lastError, '房间密码不对');
  assert.equal(b.ws, null);
});

test('连接被服务器断开后自动重连', async () => {
  const a = relay();
  a.connect({ serverUrl: url(), room: 'relay-3', secret: 'pw', name: 'Ann' });
  await until(a, 'online');
  for (const ws of wss.clients) ws.terminate();
  await until(a, 'error');
  assert.match(a.lastError, /重连/);
  const [msg] = await once(a, 'message');
  assert.equal(msg.type, 'welcome');
  assert.equal(a.state, 'online');
});
