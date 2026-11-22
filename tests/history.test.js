const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { HistoryStore, emptyDay, cleanDay, friendSnapshot, shiftDate, weekStart, topList, buildDay, buildWeek } = require('../client/history');
const { ActivityTracker } = require('../client/activity');
const { DEFAULT_RULES } = require('../client/classifier');

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-history-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
/** 一天的记录：study / slack 是分钟 */
function day(date, study, slack, extra = {}) {
  const d = emptyDay(date);
  d.sec.study = study * 60;
  d.sec.slack = slack * 60;
  return Object.assign(d, extra);
}
const plan = (done, total, reviewed = true) => ({
  planAt: 1,
  reviewAt: reviewed ? 2 : null,
  items: Array.from({ length: total }, (_, i) => ({ text: `事情 ${i + 1}`, done: i < done })),
});

test('shiftDate / weekStart：一周从周一开始，跨月跨年也对', () => {
  assert.equal(shiftDate('2026-03-01', -1), '2026-02-28');
  assert.equal(shiftDate('2026-12-31', 1), '2027-01-01');
  assert.equal(weekStart('2026-11-22'), '2026-11-16'); // 周日算在这一周的最后一天
  assert.equal(weekStart('2026-11-16'), '2026-11-16');
  assert.equal(weekStart('2026-11-18'), '2026-11-16');
  assert.equal(weekStart('2027-01-01'), '2026-12-28');
});

test('cleanDay：旧版本的 today.json（只有 sec）补全成现在的格式；乱七八糟的值当 0', () => {
  const d = cleanDay({ date: '2026-11-20', sec: { study: 100, slack: 'x' }, by: { study: { 'a:Code': 60, bad: 5, 'd:x.com': -3 } }, hours: { study: [1, 2] } });
  assert.deepEqual(d.sec, { study: 100, slack: 0, neutral: 0 });
  assert.deepEqual(d.by, { study: { 'a:Code': 60 }, slack: {} });
  assert.equal(d.hours.study.length, 24);
  assert.deepEqual(d.hours.study.slice(0, 3), [1, 2, 0]);
  assert.deepEqual(d.pomo, { count: 0, focusMin: 0 });
  assert.equal(d.friend, null);
  assert.equal(cleanDay({ date: 'nope' }), null);
  assert.equal(cleanDay(null), null);
});

test('friendSnapshot：对方发来的时长和明细只留认识的字段，最多 30 项', () => {
  const list = Array.from({ length: 40 }, (_, i) => ({ domain: `site${i}.com`, sec: 100 + i }));
  const f = friendSnapshot('小陈', { study: 3600, slack: '9' }, { study: list, slack: [{ app: 'steam', sec: 50 }, { app: '', sec: 9 }, { sec: 3 }, 'x'] });
  assert.equal(f.name, '小陈');
  assert.deepEqual(f.sec, { study: 3600, slack: 0 });
  assert.equal(Object.keys(f.by.study).length, 30);
  assert.deepEqual(f.by.slack, { 'a:steam': 50 });
  assert.equal(friendSnapshot('', { study: 1 }, null), null);
});

test('HistoryStore：存了能读回；没记到东西的一天不存；没有的日子返回 null', (t) => {
  const store = new HistoryStore(path.join(tmpDir(t), 'history'));
  assert.equal(store.load('2026-11-20'), null);
  assert.equal(store.save(emptyDay('2026-11-20')), false);
  assert.equal(store.load('2026-11-20'), null);
  const d = day('2026-11-20', 90, 20, { pomo: { count: 2, focusMin: 50 } });
  d.hours.study[9] = 1800;
  assert.equal(store.save(d), true);
  assert.deepEqual(store.load('2026-11-20'), d);
  assert.equal(store.load('../config'), null); // 日期格式不对不去读文件
});

test('topList：按时间从长到短，域名和应用分开标', () => {
  assert.deepEqual(topList({ 'a:Code': 100.4, 'd:leetcode.cn': 300, 'a:Notion': 0.2 }, 5), [
    { domain: 'leetcode.cn', sec: 300 },
    { app: 'Code', sec: 100 },
  ]);
  assert.deepEqual(topList({ 'a:A': 3, 'a:B': 2, 'a:C': 1 }, 2).map((e) => e.app), ['A', 'B']);
});

test('buildDay：一天的时长、按小时分布、明细、番茄、计划，和前一天比', () => {
  const today = day('2026-11-22', 190, 35, { pomo: { count: 4, focusMin: 100 }, by: { study: { 'a:Code': 5100, 'd:leetcode.cn': 3300 }, slack: { 'd:bilibili.com': 2100 } } });
  today.hours.study[9] = 2400;
  today.friend = friendSnapshot('小陈', { study: 9600, slack: 3000 }, { study: [{ app: 'WINWORD', sec: 9000 }], slack: [] });
  const recs = { '2026-11-22': today, '2026-11-21': day('2026-11-21', 95, 40) };
  const journals = { '2026-11-22': { me: plan(4, 5, false), friend: { name: '小陈', journal: plan(3, 4, false) } } };
  const r = buildDay({ date: '2026-11-22', today: '2026-11-22', loadRecord: (d) => recs[d] || null, loadJournal: (d) => journals[d] || {} });
  assert.deepEqual(r.me.sec, { study: 190 * 60, slack: 35 * 60 });
  assert.equal(r.me.hours.study[9], 2400);
  assert.deepEqual(r.me.top.study[0], { app: 'Code', sec: 5100 });
  assert.deepEqual(r.me.pomo, { count: 4, focusMin: 100 });
  assert.deepEqual(r.me.plan, { total: 5, done: 4, reviewed: false });
  assert.equal(r.me.items.length, 5);
  assert.deepEqual(r.prev, { study: 95 * 60, slack: 40 * 60 });
  assert.equal(r.friend.name, '小陈');
  assert.deepEqual(r.friend.sec, { study: 9600, slack: 3000 });
  assert.deepEqual(r.friend.plan, { total: 4, done: 3, reviewed: false });

  // 没有记录的一天（装上这个版本之前）：时长是 0，标明没记录；前一天也没有就没得比
  const empty = buildDay({ date: '2026-11-10', today: '2026-11-22', loadRecord: () => null, loadJournal: () => ({ me: plan(2, 2) }) });
  assert.equal(empty.me.recorded, false);
  assert.deepEqual(empty.me.sec, { study: 0, slack: 0 });
  assert.equal(empty.prev, null);
  assert.equal(empty.friend, null);
  assert.deepEqual(empty.me.plan, { total: 2, done: 2, reviewed: true });
});

test('buildWeek：周一到周日每天一格，合计、计划完成、最常用的，和上一周比', () => {
  const study = [195, 170, 210, 140, 180, 95, 190];
  const slack = [30, 45, 20, 50, 25, 40, 35];
  const pomos = [4, 3, 5, 2, 4, 1, 4];
  const plans = [[4, 5], [3, 4], [5, 5], [2, 4], [4, 5], [2, 3], [4, 5]];
  const recs = {};
  const journals = {};
  study.forEach((m, i) => {
    const d = shiftDate('2026-11-16', i);
    recs[d] = day(d, m, slack[i], { pomo: { count: pomos[i], focusMin: pomos[i] * 25 }, by: { study: { 'a:Code': m * 30, 'd:leetcode.cn': m * 20 }, slack: { 'd:bilibili.com': slack[i] * 60 } } });
    journals[d] = { me: plan(plans[i][0], plans[i][1], i !== 3) };
  });
  recs['2026-11-12'] = day('2026-11-12', 600, 100); // 上一周只有一天有记录
  const w = buildWeek({ date: '2026-11-18', today: '2026-11-22', loadRecord: (d) => recs[d] || null, loadJournal: (d) => journals[d] || {} });
  assert.deepEqual([w.from, w.to], ['2026-11-16', '2026-11-22']);
  assert.deepEqual(w.days.map((d) => d.me.sec.study / 60), study);
  assert.deepEqual(w.days.map((d) => d.me.pomo), pomos);
  assert.deepEqual(w.days[3].me.plan, { total: 4, done: 2, reviewed: false });
  assert.deepEqual(w.me.sec, { study: 1180 * 60, slack: 245 * 60 });
  assert.deepEqual(w.me.pomo, { count: 23, focusMin: 575 });
  assert.deepEqual(w.me.plan, { done: 24, total: 31, reviewedDays: 6, days: 7 });
  assert.deepEqual(w.me.top.study.map((e) => e.app || e.domain), ['Code', 'leetcode.cn']);
  assert.deepEqual(w.prev, { study: 600 * 60, slack: 100 * 60 });
  assert.equal(w.friend, null);

  // 这一周还没过完：以后的日子标成 future，不去读记录
  const asked = [];
  const mid = buildWeek({ date: '2026-11-18', today: '2026-11-18', loadRecord: (d) => (asked.push(d), recs[d] || null), loadJournal: () => ({}) });
  assert.deepEqual(mid.days.map((d) => d.future), [false, false, false, true, true, true, true]);
  assert.ok(!asked.includes('2026-11-19'));
  assert.equal(mid.me.recordedDays, 3);
  // 上一周一天记录都没有：没得比
  assert.equal(buildWeek({ date: '2026-11-18', today: '2026-11-22', loadRecord: (d) => (d >= '2026-11-16' ? recs[d] : null), loadJournal: () => ({}) }).prev, null);
});

test('buildWeek：搭子每天的时长来自记录里的 friend，计划来自计划存档里对方的那份', () => {
  const recs = {
    '2026-11-16': day('2026-11-16', 60, 10, { friend: friendSnapshot('小陈', { study: 7200, slack: 600 }, { study: [{ app: 'WINWORD', sec: 7000 }], slack: [] }) }),
    '2026-11-17': day('2026-11-17', 60, 10, { friend: friendSnapshot('小陈', { study: 3600, slack: 1200 }, { study: [{ app: 'WINWORD', sec: 3000 }], slack: [] }) }),
  };
  const journals = { '2026-11-17': { me: null, friend: { name: '小陈', journal: plan(3, 4) } } };
  const w = buildWeek({ date: '2026-11-17', today: '2026-11-22', loadRecord: (d) => recs[d] || null, loadJournal: (d) => journals[d] || {} });
  assert.equal(w.friend.name, '小陈');
  assert.equal(w.friend.recordedDays, 2);
  assert.deepEqual(w.friend.sec, { study: 10800, slack: 1800 });
  assert.deepEqual(w.friend.top.study, [{ app: 'WINWORD', sec: 10000 }]);
  assert.deepEqual(w.friend.plan, { done: 3, total: 4, reviewedDays: 1, days: 1 });
  assert.deepEqual(w.days[1].friend, { recorded: true, sec: { study: 3600, slack: 1200 }, plan: { total: 4, done: 3, reviewed: true } });
});

// ---------- tracker 这边：往今天的记录里记、跨天归档 ----------
function makeTracker(t, dataDir = tmpDir(t)) {
  const tr = new ActivityTracker({ dataDir, getRules: () => DEFAULT_RULES, getSettings: () => ({ idleMinutes: 5 }), selfProcNames: ['electron'] });
  t.after(() => tr.stop());
  return tr;
}

test('tracker：学习和摸鱼的时间同时记到所在的那个小时里', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date(2026, 10, 20, 9, 30, 0) });
  const tr = makeTracker(t);
  const tick = (proc, ms) => {
    t.mock.timers.tick(ms);
    tr.onSample({ proc, title: '', idleMs: 0 }, Date.now());
  };
  tick('Code', 0);
  tick('Code', 8000); // 9 点学了 8 秒
  tick('steam', 5000); // 又学了 5 秒，然后切去摸鱼
  tick('steam', 6000); // 摸鱼 6 秒
  assert.equal(tr.today.hours.study[9], 13);
  assert.equal(tr.today.hours.slack[9], 6);
  assert.equal(tr.today.hours.study.reduce((a, b) => a + b, 0), tr.today.sec.study);
});

test('tracker：番茄数和搭子的时长记在今天的记录里，存盘后能读回', (t) => {
  const tr = makeTracker(t);
  tr.addPomodoro(25);
  tr.addPomodoro('50');
  tr.setFriendDay('小陈', { study: 600, slack: 60 }, { study: [{ app: 'Code', sec: 500 }], slack: [] });
  tr.setFriendDay('', { study: 1 }, null); // 没名字的不记，也不会把之前的冲掉
  assert.deepEqual(tr.dayRecord().pomo, { count: 2, focusMin: 75 });
  tr._saveToday();
  const back = tr._loadToday();
  assert.deepEqual(back.pomo, { count: 2, focusMin: 75 });
  assert.deepEqual(back.friend, { name: '小陈', sec: { study: 600, slack: 60 }, by: { study: { 'a:Code': 500 }, slack: {} } });
});

test('tracker：跨天时把过完的那一天归档；上次退出后跨了天，启动时补归档', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date(2026, 2, 10, 23, 59, 50) });
  const dir = tmpDir(t);
  const tr = makeTracker(t, dir);
  tr.onSample({ proc: 'Code', title: '', idleMs: 0 }, Date.now());
  t.mock.timers.tick(6000);
  tr.onSample({ proc: 'Code', title: '', idleMs: 0 }, Date.now());
  tr.addPomodoro(25);
  t.mock.timers.tick(8000); // 过了零点
  tr.onSample({ proc: 'Code', title: '', idleMs: 0 }, Date.now());
  const archived = new HistoryStore(path.join(dir, 'history')).load('2026-03-10');
  assert.equal(archived.sec.study, 6);
  assert.equal(archived.hours.study[23], 6);
  assert.equal(archived.pomo.count, 1);
  assert.equal(tr.today.date, '2026-03-11');
  assert.equal(tr.today.pomo.count, 0);

  // 3 月 11 日退出，13 日才再打开：11 日的记录不能丢
  tr.onSample({ proc: 'Code', title: '', idleMs: 0 }, Date.now() + 5000);
  tr.stop();
  t.mock.timers.setTime(new Date(2026, 2, 13, 8, 0, 0).getTime());
  const tr2 = makeTracker(t, dir);
  assert.equal(tr2.today.date, '2026-03-13');
  assert.equal(tr2.today.sec.study, 0);
  assert.ok(new HistoryStore(path.join(dir, 'history')).load('2026-03-11').sec.study > 0);
});
