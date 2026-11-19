const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const J = require('../client/journal');

function tmpStore(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-journal-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return new J.JournalStore(path.join(dir, 'journal'));
}

/** 一个可控的 JournalSync：sent 记录发出去的消息，env 控制暂停 / 在线 / 今天是几号 */
function makeSync(t, env = {}) {
  const e = { paused: false, online: true, today: '2026-03-10', ...env };
  const sent = [];
  const store = tmpStore(t);
  const sync = new J.JournalSync({
    store,
    send: (m) => (e.online ? (sent.push(JSON.parse(JSON.stringify(m))), true) : false),
    isPaused: () => e.paused,
    today: () => e.today,
  });
  return { sync, store, sent, env: e };
}
const plan = (...texts) => ({ items: texts.map((text) => ({ text, done: false })) });
const at = (h, m = 0) => new Date(2026, 2, 10, h, m);
const CFG = { planTime: '09:00', reviewTime: '22:00' };

// ---------- 字段清洗 ----------
test('cleanJournal：只留认识的字段，最多 8 条，超长截断，去掉控制字符和空条目', () => {
  const j = J.cleanJournal({
    date: '2026-03-10',
    items: [
      ...Array.from({ length: 10 }, (_, i) => ({ text: `第 ${i} 件`, done: i % 2, reason: 'r'.repeat(500), evil: '<script>' })),
    ],
    planAt: 123.9,
    reviewAt: 'x',
    improve: '早点\n开始\u0000',
    title: '窗口标题不该出现在这里',
    url: 'https://example.com/secret?x=1',
  });
  assert.equal(j.items.length, 8);
  assert.deepEqual(Object.keys(j).sort(), ['date', 'improve', 'items', 'planAt', 'reviewAt']);
  assert.deepEqual(Object.keys(j.items[0]).sort(), ['done', 'reason', 'text']);
  assert.equal(j.items[1].done, true);
  assert.equal(j.items[0].reason.length, 120);
  assert.equal(j.planAt, 123);
  assert.equal(j.reviewAt, null);
  assert.equal(j.improve, '早点 开始');
  assert.equal(J.cleanJournal({ date: '2026-03-10', items: [{ text: '  ' }, { text: 'x'.repeat(100) }] }).items[0].text.length, 60);
});

test('cleanJournal：日期不对或不是对象返回 null', () => {
  assert.equal(J.cleanJournal(null), null);
  assert.equal(J.cleanJournal('2026-03-10'), null);
  assert.equal(J.cleanJournal({ date: '../../etc/passwd', items: [] }), null);
  assert.equal(J.cleanJournal({ date: '2026-3-1', items: [] }), null);
});

test('清洗后的 journal 一定塞得进服务器 8KB 的消息上限', () => {
  const worst = J.cleanJournal({
    date: '2026-03-10',
    items: Array.from({ length: 20 }, () => ({ text: '"'.repeat(999), done: false, reason: '\\'.repeat(999) })),
    improve: '汉'.repeat(999),
    planAt: Date.now(),
    reviewAt: Date.now(),
  });
  assert.ok(Buffer.byteLength(JSON.stringify({ type: 'journal', journal: worst })) < 8 * 1024);
});

test('日期工具：addDays 跨月跨年，dayDiff，toMinutes', () => {
  assert.equal(J.addDays('2026-03-01', -1), '2026-02-28');
  assert.equal(J.addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(J.dayDiff('2026-03-01', '2026-02-27'), 2);
  assert.equal(J.toMinutes('09:05'), 545);
  assert.ok(Number.isNaN(J.toMinutes('24:00')));
  assert.ok(Number.isNaN(J.toMinutes('9点')));
});

// ---------- 本机存储 ----------
test('每天一个文件 journal/YYYY-MM-DD.json，自己的和对方的都在里面', (t) => {
  const { sync, store } = makeSync(t);
  sync.save('plan', plan('写论文', '跑步'), 1000);
  sync.onFriend('Tom', { date: '2026-03-10', items: [{ text: '刷题', done: true }], planAt: 5 });
  const file = path.join(store.dir, '2026-03-10.json');
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(raw.me.items.length, 2);
  assert.equal(raw.friend.name, 'Tom');
  assert.equal(raw.friend.journal.items[0].text, '刷题');
  assert.deepEqual(fs.readdirSync(store.dir), ['2026-03-10.json']);
});

test('坏文件当成空的一天；读出来的内容会再清洗一遍', (t) => {
  const store = tmpStore(t);
  fs.mkdirSync(store.dir, { recursive: true });
  fs.writeFileSync(path.join(store.dir, '2026-03-10.json'), '{oops');
  assert.deepEqual(store.load('2026-03-10'), { date: '2026-03-10', me: null, friend: null, prompt: {} });
  fs.writeFileSync(path.join(store.dir, '2026-03-11.json'), JSON.stringify({ me: { date: '2026-03-11', items: [{ text: 'a', x: 1 }], planAt: 1 } }));
  assert.deepEqual(store.load('2026-03-11').me.items, [{ text: 'a', done: false, reason: '' }]);
});

test('recent：最近 7 天，新的在前，没记录的那天是空的，不带提醒状态', (t) => {
  const { sync, store, env } = makeSync(t);
  sync.save('plan', plan('今天的事'));
  env.today = '2026-03-08';
  sync.save('plan', plan('前天的事'));
  const days = store.recent(7, '2026-03-10');
  assert.deepEqual(days.map((d) => d.date), ['2026-03-10', '2026-03-09', '2026-03-08', '2026-03-07', '2026-03-06', '2026-03-05', '2026-03-04']);
  assert.equal(days[0].me.items[0].text, '今天的事');
  assert.equal(days[1].me, null);
  assert.equal(days[2].me.items[0].text, '前天的事');
  assert.ok(!('prompt' in days[0]));
});

// ---------- 保存计划 / 复盘 ----------
test('保存计划：盖时间戳、发给对方；再次保存不改 planAt', (t) => {
  const { sync, sent } = makeSync(t);
  const r = sync.save('plan', { ...plan('写论文', '', '跑步'), planAt: 1, reviewAt: 1 }, 5000);
  assert.equal(r.ok, true);
  assert.equal(r.journal.planAt, 5000);
  assert.equal(r.journal.reviewAt, null); // 界面传来的时间戳不算数
  assert.equal(r.journal.items.length, 2);
  assert.deepEqual(sent.at(-1), { type: 'journal', journal: r.journal });
  const r2 = sync.save('plan', { items: [{ text: '写论文', done: true }, { text: '跑步', done: false }] }, 9000);
  assert.equal(r2.journal.planAt, 5000);
  assert.deepEqual(J.progress(r2.journal), { total: 2, done: 1, reviewed: false });
  assert.equal(sent.length, 2);
});

test('保存计划：一条都没有会被拒绝，也不会发出去', (t) => {
  const { sync, sent } = makeSync(t);
  assert.deepEqual(sync.save('plan', plan('', '   ')), { ok: false, error: '至少要有一条要做的事' });
  assert.equal(sent.length, 0);
  assert.equal(J.progress(sync.mine()), null);
});

test('复盘：没完成的必须写原因；完成的不留原因；可选的改进点', (t) => {
  const { sync, sent } = makeSync(t);
  sync.save('plan', plan('写论文', '跑步'), 1000);
  const bad = sync.save('review', { items: [{ text: '写论文', done: true }, { text: '跑步', done: false, reason: '  ' }] }, 2000);
  assert.deepEqual(bad, { ok: false, error: '没完成的事要写一下原因' });
  assert.equal(sync.mine().reviewAt, null);
  assert.equal(sent.length, 1);
  const ok = sync.save('review', { items: [{ text: '写论文', done: true, reason: '多余的' }, { text: '跑步', done: false, reason: '下雨了' }], improve: '早点开始' }, 3000);
  assert.equal(ok.ok, true);
  assert.equal(ok.journal.planAt, 1000);
  assert.equal(ok.journal.reviewAt, 3000);
  assert.deepEqual(ok.journal.items.map((it) => it.reason), ['', '下雨了']);
  assert.equal(ok.journal.improve, '早点开始');
  assert.deepEqual(J.progress(ok.journal), { total: 2, done: 1, reviewed: true });
  // 复盘之后再存计划，不会把复盘抹掉
  assert.equal(sync.save('plan', { items: ok.journal.items }, 4000).journal.reviewAt, 3000);
});

test('只能改今天的；过了零点可以补交昨天的复盘，别的日期一律当成今天', (t) => {
  const { sync, store, env, sent } = makeSync(t);
  sync.save('plan', plan('写论文'), 1000);
  env.today = '2026-03-11';
  sync.tick();
  const r = sync.save('review', { date: '2026-03-10', items: [{ text: '写论文', done: true }] }, 2000);
  assert.equal(r.journal.date, '2026-03-10');
  assert.equal(store.load('2026-03-10').me.reviewAt, 2000);
  assert.equal(sent.at(-1).journal.date, '2026-03-10');
  assert.equal(sync.save('plan', { date: '2026-03-10', ...plan('x') }).journal.date, '2026-03-11');
  assert.equal(sync.save('review', { date: '2020-01-01', items: [{ text: 'x', done: true }] }).journal.date, '2026-03-11');
});

test('忘了复盘：第二天写新计划之前，「今日复盘」补的是昨天的', (t) => {
  const { sync, env } = makeSync(t);
  assert.equal(sync.reviewDate(), '2026-03-10'); // 昨天什么都没写
  sync.save('plan', plan('写论文'), 1000);
  assert.equal(sync.reviewDate(), '2026-03-10');
  env.today = '2026-03-11';
  sync.tick();
  assert.equal(sync.reviewDate(), '2026-03-10');
  sync.save('review', { date: '2026-03-10', items: [{ text: '写论文', done: true }] }, 2000);
  assert.equal(sync.reviewDate(), '2026-03-11'); // 补完了
  env.today = '2026-03-12';
  sync.save('plan', plan('新的一天'), 3000);
  assert.equal(sync.reviewDate(), '2026-03-12'); // 今天已经写了新计划，就不再翻旧账
});

// ---------- 同步：暂停分享、重连、跨天 ----------
test('暂停分享期间不发任何 journal；恢复后补发最新的一份', (t) => {
  const { sync, sent, env } = makeSync(t);
  sync.save('plan', plan('写论文', '跑步'), 1000);
  assert.equal(sent.length, 1);
  env.paused = true;
  sync.save('plan', { items: [{ text: '写论文', done: true }, { text: '跑步', done: true }] }, 2000);
  sync.flush(); // 暂停期间断线重连，也不能发
  assert.equal(sent.length, 1, '暂停期间对方不该收到进度变化');
  env.paused = false;
  sync.flush();
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[1].journal.items.map((it) => it.done), [true, true]);
});

test('每次重连成功都重发今天的 journal（还没写计划也发一份空的）', (t) => {
  const { sync, sent } = makeSync(t);
  sync.flush();
  assert.deepEqual(sent[0], { type: 'journal', journal: J.emptyJournal('2026-03-10') });
  sync.save('plan', plan('写论文'), 1000);
  sync.flush();
  sync.flush();
  assert.equal(sent.length, 4);
  assert.equal(sent[3].journal.planAt, 1000);
});

test('离线时改的内容，连上之后补发', (t) => {
  const { sync, sent, env } = makeSync(t, { online: false });
  sync.save('plan', plan('写论文'), 1000);
  assert.equal(sent.length, 0);
  env.online = true;
  sync.flush();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].journal.items[0].text, '写论文');
});

test('跨天：tick 发现日期变了，今天变成空的，并通知对方', (t) => {
  const { sync, sent, env } = makeSync(t);
  sync.save('plan', plan('写论文'), 1000);
  assert.equal(sync.tick(), false);
  env.today = '2026-03-11';
  assert.equal(sync.tick(), true);
  assert.equal(sync.tick(), false);
  assert.deepEqual(sync.mine(), J.emptyJournal('2026-03-11'));
  assert.deepEqual(sent.at(-1).journal, J.emptyJournal('2026-03-11'));
  assert.equal(sync.mine('2026-03-10').items[0].text, '写论文'); // 昨天的还在
});

// ---------- 收到对方的 ----------
test('收到对方的 journal：存副本；刚写好计划 / 复盘时各提示一次', (t) => {
  const { sync, store } = makeSync(t);
  const base = { date: '2026-03-10', items: [{ text: '刷题', done: false }] };
  assert.equal(sync.onFriend('Tom', { ...base, planAt: null }), null);
  assert.equal(sync.friendToday('Tom', true).planAt, null);
  assert.equal(sync.onFriend('Tom', { ...base, planAt: 100 }), 'plan');
  assert.equal(sync.onFriend('Tom', { ...base, planAt: 100 }), null, '重连时服务器会重发缓存，不能重复提示');
  assert.equal(sync.onFriend('Tom', { ...base, items: [{ text: '刷题', done: true }], planAt: 100 }), null);
  assert.deepEqual(J.progress(sync.friendToday('Tom', true)), { total: 1, done: 1, reviewed: false });
  assert.equal(sync.onFriend('Tom', { ...base, planAt: 100, reviewAt: 200 }), 'review');
  assert.equal(sync.onFriend('Tom', { ...base, planAt: 100, reviewAt: 300 }), null);
  assert.equal(store.load('2026-03-10').friend.journal.reviewAt, 300);
  assert.equal(sync.onFriend('Tom', { date: 'bad' }), null);
  assert.equal(sync.onFriend('', base), null);
});

test('对方的副本重启后还在；换了搭子不会张冠李戴', (t) => {
  const { sync, store } = makeSync(t);
  sync.onFriend('Tom', { date: '2026-03-10', items: [{ text: '刷题', done: true }], planAt: 100 });
  const again = new J.JournalSync({ store, send: () => true, isPaused: () => false, today: () => '2026-03-10' });
  assert.equal(again.friendToday('Tom', false).items[0].text, '刷题');
  assert.equal(again.friendToday('Jerry', true), null);
});

test('对方「今天」的判定：离线只认同一天；在线允许差一天（时区不同）；很久以前的缓存不提示', (t) => {
  const { sync, env } = makeSync(t);
  sync.onFriend('Tom', { date: '2026-03-10', items: [{ text: '刷题' }], planAt: 100 });
  env.today = '2026-03-11';
  assert.equal(sync.friendToday('Tom', false), null);
  assert.equal(sync.friendToday('Tom', true).date, '2026-03-10');
  env.today = '2026-03-12';
  assert.equal(sync.friendToday('Tom', true), null);
  assert.equal(sync.onFriend('Tom', { date: '2026-03-01', items: [{ text: '旧的' }], planAt: 1 }), null);
  assert.equal(sync.friend.journal.date, '2026-03-10', '旧日期的不会盖掉新的');
});

// ---------- 提醒时机 ----------
const day = (me = null, prompt = {}) => ({ date: '2026-03-10', me, friend: null, prompt });
const planned = { date: '2026-03-10', items: [{ text: 'a', done: false, reason: '' }], planAt: 1, reviewAt: null, improve: '' };

test('计划提醒：到了计划时间就弹，不管人在不在', () => {
  assert.equal(J.duePrompt(at(8, 59), CFG, day(), false), null);
  assert.equal(J.duePrompt(at(9, 0), CFG, day(), false), 'plan');
  assert.equal(J.duePrompt(at(14, 0), CFG, day(), false), 'plan'); // 下午才开机
});

test('计划提醒：05:00 之后第一次发现在用电脑就弹；05:00 之前不弹', () => {
  assert.equal(J.duePrompt(at(4, 59), CFG, day(), true), null);
  assert.equal(J.duePrompt(at(5, 0), CFG, day(), true), 'plan');
  assert.equal(J.duePrompt(at(7, 30), CFG, day(), false), null);
});

test('计划提醒：早上关掉之后，到计划时间再提醒一次，之后不再打扰', () => {
  const d = day();
  J.markPrompted(d, 'plan', at(7, 30), CFG);
  assert.equal(J.duePrompt(at(7, 31), CFG, d, true), null);
  assert.equal(J.duePrompt(at(9, 0), CFG, d, true), 'plan');
  J.markPrompted(d, 'plan', at(9, 0), CFG);
  assert.equal(J.duePrompt(at(9, 1), CFG, d, true), null);
  assert.equal(J.duePrompt(at(23, 0), CFG, d, true), null);
});

test('计划提醒：写过计划就不再弹', () => {
  assert.equal(J.duePrompt(at(9, 0), CFG, day(planned), true), null);
});

test('15 分钟后再提醒：最多推迟 3 次', () => {
  const d = day();
  let now = at(9, 0);
  for (let i = 0; i < J.MAX_SNOOZES; i++) {
    assert.equal(J.duePrompt(now, CFG, d, true), 'plan');
    J.markPrompted(d, 'plan', now, CFG);
    assert.equal(J.snoozesLeft(d), J.MAX_SNOOZES - i);
    assert.equal(J.snooze(d, now.getTime()), true);
    assert.equal(J.duePrompt(new Date(now.getTime() + 14 * 60_000), CFG, d, true), null);
    now = new Date(now.getTime() + 15 * 60_000);
  }
  assert.equal(J.duePrompt(now, CFG, d, true), 'plan'); // 第 4 次弹出
  J.markPrompted(d, 'plan', now, CFG);
  assert.equal(J.snoozesLeft(d), 0);
  assert.equal(J.snooze(d, now.getTime()), false);
  assert.equal(J.duePrompt(new Date(now.getTime() + 60 * 60_000), CFG, d, true), null);
});

test('复盘提醒：到点、写过计划、还没复盘才弹，只弹一次', () => {
  assert.equal(J.duePrompt(at(21, 59), CFG, day(planned), true), null);
  assert.equal(J.duePrompt(at(22, 0), CFG, day(planned), false), 'review');
  assert.equal(J.duePrompt(at(22, 0), CFG, day({ ...planned, reviewAt: 5 }), true), null);
  const d = day(planned);
  J.markPrompted(d, 'review', at(22, 0), CFG);
  assert.equal(J.duePrompt(at(22, 30), CFG, d, true), null);
  // 没写计划：晚上弹的是计划（已经弹过就什么都不弹），不会弹复盘
  assert.equal(J.duePrompt(at(22, 0), CFG, day(null, { planTimeFired: true, activeFired: true }), true), null);
});

test('提醒状态存在当天的文件里，重启不会重新计数；第二天是新的', (t) => {
  const store = tmpStore(t);
  const d = store.load('2026-03-10');
  J.markPrompted(d, 'plan', at(9, 0), CFG);
  J.snooze(d, at(9, 0).getTime());
  store.save(d);
  assert.equal(J.snoozesLeft(store.load('2026-03-10')), 2);
  assert.equal(J.duePrompt(at(9, 5), CFG, store.load('2026-03-10'), true), null);
  assert.equal(J.duePrompt(new Date(2026, 2, 11, 9, 0), CFG, store.load('2026-03-11'), true), 'plan');
});
