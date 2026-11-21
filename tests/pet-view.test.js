const test = require('node:test');
const assert = require('node:assert/strict');
const { friendView, meView, petView } = require('../client/renderer/pet-view');

const status = (category, extra = {}) => ({ paused: false, category, app: 'Code', domain: null, todaySec: { study: 60, slack: 30, neutral: 0 }, slackStreakSec: 0, ...extra });
const friend = (s, online = true) => ({ name: 'Tom', online, status: s });

test('friendView：没有搭子 / 不在线是 offline，在线按 TA 发来的状态', () => {
  assert.deepEqual(friendView(null), { key: 'offline', name: null });
  assert.deepEqual(friendView({ friend: null }), { key: 'offline', name: null });
  assert.equal(friendView({ friend: friend(status('study'), false) }).key, 'offline');
  assert.equal(friendView({ friend: friend(null) }).key, 'neutral'); // 刚上线，还没收到状态
  assert.equal(friendView({ friend: friend({ paused: true }) }).key, 'paused');
  for (const c of ['study', 'slack', 'away', 'private']) assert.equal(friendView({ friend: friend(status(c)) }).key, c);
  assert.equal(friendView({ friend: friend(status('slack')) }).name, 'Tom');
});

test('meView：自己的学习 / 摸鱼 / 离开 / 隐私都照实显示，带上 me 标记', () => {
  for (const c of ['study', 'slack', 'away', 'private', 'neutral']) {
    const v = meView({ me: { name: 'Amy', status: status(c) } });
    assert.deepEqual({ me: v.me, key: v.key, name: v.name }, { me: true, key: c, name: 'Amy' });
  }
  const s = status('slack', { slackStreakSec: 900, domain: 'bilibili.com' });
  assert.equal(meView({ me: { name: 'Amy', status: s } }).status, s); // 卡片上的「正在看…」「连续摸鱼」都从这里拿
});

test('meView：暂停分享时是 paused（搭子看到的也是这个）；自己没有 offline，没连上服务器也照常显示', () => {
  assert.equal(meView({ me: { name: 'Amy', status: { paused: true } } }).key, 'paused');
  const v = meView({ me: { name: 'Amy', status: status('study') }, friend: null, connection: { state: 'error' } });
  assert.equal(v.key, 'study');
  // 还没填昵称、还没收到状态也不会出错
  assert.deepEqual(meView({ me: { name: '', status: null } }), { me: true, key: 'neutral', name: '', status: null });
  assert.equal(meView(null).key, 'neutral');
});

test('petView：默认演搭子，petView 是 me 时演自己；认不出的值当搭子', () => {
  const state = { me: { name: 'Amy', status: status('slack') }, friend: friend(status('study')) };
  assert.deepEqual(petView(state), friendView(state));
  assert.deepEqual(petView({ ...state, petView: 'friend' }), friendView(state));
  assert.deepEqual(petView({ ...state, petView: 'whatever' }), friendView(state));
  const mine = petView({ ...state, petView: 'me' });
  assert.deepEqual({ me: mine.me, key: mine.key, name: mine.name }, { me: true, key: 'slack', name: 'Amy' });
  assert.equal(petView(null).key, 'offline'); // 主进程的状态还没到
});
