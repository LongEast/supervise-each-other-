const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ActivityTracker, localDate, parseSampleLine } = require('../client/activity');
const { DEFAULT_RULES } = require('../client/classifier');

function makeTracker(t, rules = DEFAULT_RULES) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-test-'));
  const tracker = new ActivityTracker({
    dataDir,
    getRules: () => rules,
    getSettings: () => ({ idleMinutes: 5 }),
    selfProcNames: ['electron', 'Buddy Pet'],
  });
  t.after(() => {
    tracker.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  return tracker;
}

test('localDate 用本地时区，补零', () => {
  assert.equal(localDate(new Date(2026, 0, 5, 23, 59)), '2026-01-05');
});

test('时长记到上一个状态上，单次最多算 10 秒', (t) => {
  const tr = makeTracker(t);
  const t0 = Date.now();
  tr.onSample({ proc: 'Code', title: 'a.js', idleMs: 0 }, t0);
  tr.onSample({ proc: 'steam', title: '', idleMs: 0 }, t0 + 4000);
  tr.onSample({ proc: 'steam', title: '', idleMs: 0 }, t0 + 4000 + 3_600_000); // 睡眠了一小时
  const s = tr.getStatus();
  assert.equal(s.todaySec.study, 4);
  assert.equal(s.todaySec.slack, 10);
  assert.equal(s.slackStreakSec, 10);
  assert.equal(s.category, 'slack');
});

test('状态里不包含窗口标题', (t) => {
  const tr = makeTracker(t);
  tr.onSample({ proc: 'chrome', title: '我的秘密日记 - Google Docs', idleMs: 0 });
  assert.ok(!JSON.stringify(tr.getStatus()).includes('秘密'));
});

test('浏览器域名来自插件，去掉 www；过期的插件数据不用', (t) => {
  const tr = makeTracker(t);
  tr.setBrowserTab({ browser: 'chrome', domain: 'www.bilibili.com' });
  tr.onSample({ proc: 'chrome', title: '', idleMs: 0 });
  assert.equal(tr.getStatus().domain, 'bilibili.com');
  assert.equal(tr.getStatus().category, 'slack');
  assert.ok(tr.extConnected());
  tr.onSample({ proc: 'chrome', title: '', idleMs: 0 }, Date.now() + 91_000);
  assert.equal(tr.getStatus().domain, null);
  // Edge 的标签页不会被算到 Chrome 头上
  tr.setBrowserTab({ browser: 'edge', domain: 'claude.ai' });
  tr.onSample({ proc: 'msedge', title: '', idleMs: 0 });
  assert.equal(tr.getStatus().domain, 'claude.ai');
});

test('空闲判定：普通应用 5 分钟，摸鱼网站放宽到 20 分钟', (t) => {
  const tr = makeTracker(t);
  tr.onSample({ proc: 'Code', title: '', idleMs: 5 * 60_000 });
  assert.equal(tr.getStatus().category, 'away');
  tr.onSample({ proc: 'steam', title: '', idleMs: 19 * 60_000 });
  assert.equal(tr.getStatus().category, 'slack');
  tr.onSample({ proc: 'steam', title: '', idleMs: 20 * 60_000 });
  assert.equal(tr.getStatus().category, 'away');
});

test('前台是小狗自己时沿用上一个状态', (t) => {
  const tr = makeTracker(t);
  tr.onSample({ proc: 'Code', title: '', idleMs: 0 });
  tr.onSample({ proc: 'electron', title: 'Buddy Pet', idleMs: 0 });
  tr.onSample({ proc: 'Buddy Pet', title: '', idleMs: 0 });
  assert.equal(tr.getStatus().app, 'Code');
});

test('隐私应用不上报名字和域名', (t) => {
  const rules = { ...DEFAULT_RULES, private: { domains: ['bank.example.com'], apps: ['wechat'] } };
  const tr = makeTracker(t, rules);
  tr.onSample({ proc: 'WeChat', title: '和某人的聊天', idleMs: 0 });
  assert.deepEqual([tr.getStatus().category, tr.getStatus().app, tr.getStatus().domain], ['private', '', null]);
  tr.setBrowserTab({ browser: 'chrome', domain: 'bank.example.com' });
  tr.onSample({ proc: 'chrome', title: '', idleMs: 0 });
  assert.deepEqual([tr.getStatus().category, tr.getStatus().app, tr.getStatus().domain], ['private', '', null]);
});

test('明细：学习 / 摸鱼时间按网站域名或应用累计，时间长的排前面', (t) => {
  const tr = makeTracker(t);
  const t0 = Date.now();
  let now = t0;
  const step = (sample, sec) => tr.onSample({ title: '', idleMs: 0, ...sample }, (now += sec * 1000));
  tr.onSample({ proc: 'Code', title: '', idleMs: 0 }, t0);
  step({ proc: 'Code' }, 6); // Code 6s
  tr.setBrowserTab({ browser: 'chrome', domain: 'www.bilibili.com' });
  step({ proc: 'chrome' }, 4); // Code 再 4s，然后切到 B 站
  step({ proc: 'chrome' }, 8); // bilibili 8s
  tr.setBrowserTab({ browser: 'chrome', domain: 'github.com' });
  step({ proc: 'chrome' }, 2); // bilibili 再 2s，然后切到 GitHub
  step({ proc: 'explorer' }, 3); // github 3s，然后是不算学习也不算摸鱼的应用
  step({ proc: 'explorer' }, 5); // 这 5s 不进明细
  assert.deepEqual(tr.breakdown(), {
    study: [{ app: 'Code', sec: 10 }, { domain: 'github.com', sec: 3 }],
    slack: [{ domain: 'bilibili.com', sec: 10 }],
  });
  assert.deepEqual(tr.getStatus().breakdown, tr.breakdown()); // 跟着状态发给对方
  assert.deepEqual(tr.breakdown(1).study, [{ app: 'Code', sec: 10 }]);
});

test('明细：隐私应用和暂停分享期间的活动不会进明细，暂停时也不发给对方', (t) => {
  const rules = { ...DEFAULT_RULES, private: { domains: ['bilibili.com'], apps: ['wechat'] } };
  const tr = makeTracker(t, rules);
  let now = Date.now();
  const step = (sample, sec) => tr.onSample({ title: '', idleMs: 0, ...sample }, (now += sec * 1000));
  tr.onSample({ proc: 'WeChat', title: '', idleMs: 0 }, now);
  step({ proc: 'WeChat' }, 5);
  tr.setBrowserTab({ browser: 'chrome', domain: 'www.bilibili.com' });
  step({ proc: 'chrome' }, 5);
  step({ proc: 'steam' }, 5);
  tr.setPaused(true);
  step({ proc: 'steam' }, 5); // 暂停期间在玩游戏
  step({ proc: 'steam' }, 5);
  assert.deepEqual(tr.getStatus(), { paused: true });
  tr.setPaused(false);
  assert.deepEqual(tr.breakdown(), { study: [], slack: [] });
  assert.ok(!JSON.stringify(tr.getStatus()).toLowerCase().includes('wechat'));
});

test('明细：能读旧版本存的 today.json（没有 by），重启后明细还在', (t) => {
  const tr = makeTracker(t);
  fs.writeFileSync(path.join(tr.dataDir, 'today.json'), JSON.stringify({ date: localDate(), sec: { study: 100, slack: 20, neutral: 0 } }));
  tr.today = tr._loadToday();
  assert.deepEqual(tr.breakdown(), { study: [], slack: [] });
  assert.equal(tr.todaySec().study, 100);
  const t0 = Date.now();
  tr.onSample({ proc: 'Code', title: '', idleMs: 0 }, t0);
  tr.onSample({ proc: 'Code', title: '', idleMs: 0 }, t0 + 5000);
  tr._saveToday();
  assert.deepEqual(tr._loadToday().by, { study: { 'a:Code': 5 }, slack: {} });
});

test('明细：发给对方的最多 30 项、不超过 5KB（服务器单条消息限 8KB）；本机可以拿到全部', (t) => {
  const tr = makeTracker(t);
  for (let i = 0; i < 40; i++) tr.today.by.study[`d:site${i}.edu`] = 100 + i;
  assert.equal(tr.breakdown().study.length, 8); // 小狗卡片用的默认只要前几项
  assert.equal(tr.breakdown(Infinity).study.length, 40); // 「今日时长明细」窗口看自己的：全部
  const wire = tr.getStatus().breakdown;
  assert.equal(wire.study.length, 30);
  assert.deepEqual(wire.study[0], { domain: 'site39.edu', sec: 139 });

  // 名字特别长（中文一个字 3 字节）：先截到 64 个字，还超就从时间最短的开始丢
  for (let i = 0; i < 40; i++) {
    tr.today.by.study[`a:${'学'.repeat(200)}${i}`] = 1000 + i;
    tr.today.by.slack[`a:${'摸'.repeat(200)}${i}`] = 2000 + i;
  }
  const big = tr.getStatus();
  assert.ok(Buffer.byteLength(JSON.stringify({ type: 'status', status: big })) < 6000);
  const all = [...big.breakdown.study, ...big.breakdown.slack];
  assert.ok(all.length >= 10 && all.length < 60);
  assert.ok(all.every((e) => (e.app || e.domain).length <= 64));
  assert.deepEqual(big.breakdown.slack[0].sec, 2039); // 留下来的是时间最长的
  assert.ok(big.breakdown.slack.length > big.breakdown.study.length);
});

test('暂停分享时自己仍然看得到今天的累计（todaySec 不依赖分享状态）', (t) => {
  const tr = makeTracker(t);
  const t0 = Date.now();
  tr.onSample({ proc: 'Code', title: '', idleMs: 0 }, t0);
  tr.onSample({ proc: 'Code', title: '', idleMs: 0 }, t0 + 4000);
  tr.setPaused(true);
  assert.deepEqual(tr.getStatus(), { paused: true });
  assert.deepEqual(tr.todaySec(), { study: 4, slack: 0, neutral: 0 });
  tr.setPaused(false);
  assert.deepEqual(tr.getStatus().todaySec, tr.todaySec());
});

test('暂停分享：只发 paused，不计时；状态变化触发 change', (t) => {
  const tr = makeTracker(t);
  const changes = [];
  tr.on('change', (s) => changes.push(s));
  const t0 = Date.now();
  tr.onSample({ proc: 'Code', title: '', idleMs: 0 }, t0);
  tr.setPaused(true);
  assert.deepEqual(tr.getStatus(), { paused: true });
  tr.onSample({ proc: 'steam', title: '', idleMs: 0 }, t0 + 5000);
  tr.onSample({ proc: 'steam', title: '', idleMs: 0 }, t0 + 9000);
  tr.setPaused(false);
  assert.deepEqual(tr.getStatus().todaySec, { study: 0, slack: 0, neutral: 0 });
  assert.ok(changes.length >= 3);
});

test('今日时长存盘后能读回；跨天自动清零', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date(2026, 2, 10, 23, 59, 50) });
  const tr = makeTracker(t);
  tr.onSample({ proc: 'Code', title: '', idleMs: 0 }, Date.now());
  t.mock.timers.tick(6000);
  tr.onSample({ proc: 'Code', title: '', idleMs: 0 }, Date.now());
  assert.equal(tr.getStatus().todaySec.study, 6);
  tr._saveToday();
  const saved = JSON.parse(fs.readFileSync(path.join(tr.dataDir, 'today.json'), 'utf8'));
  assert.equal(saved.date, '2026-03-10');
  assert.equal(tr._loadToday().sec.study, 6);
  t.mock.timers.tick(8000); // 过了零点
  tr.onSample({ proc: 'Code', title: '', idleMs: 0 }, Date.now());
  assert.equal(tr.today.date, '2026-03-11');
  assert.ok(tr.getStatus().todaySec.study <= 8);
  assert.equal(tr._loadToday().sec.study, 0); // 昨天的存盘不会被当成今天的
});

// ---------- win-activity.ps1 的输出 ----------
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');

test('解析采集脚本的输出：进程名和标题都是 base64(UTF-8)，中文不乱码', () => {
  const line = `{"proc64":"${b64('测试进程')}","title64":"${b64('测试窗口：哔哩哔哩 ✓ にほんご')}","idleMs":1234}`;
  assert.deepEqual(parseSampleLine(line), { proc: '测试进程', title: '测试窗口：哔哩哔哩 ✓ にほんご', idleMs: 1234 });
});

test('解析采集脚本的输出：兼容旧格式，坏行返回 null', () => {
  assert.deepEqual(parseSampleLine('{"proc":"Code","title64":"","idleMs":0}'), { proc: 'Code', title: '', idleMs: 0 });
  assert.equal(parseSampleLine('#< CLIXML'), null);
  assert.equal(parseSampleLine(''), null);
});

test('win-activity.ps1：非注释行必须是纯 ASCII，输出里不直接拼进程名', () => {
  // PowerShell 5.1 按系统代码页（中文系统是 GBK）读没有 BOM 的脚本，代码行里有中文会被读坏
  const ps1 = fs.readFileSync(path.join(__dirname, '..', 'client', 'win-activity.ps1'), 'utf8');
  for (const line of ps1.split(/\r?\n/)) {
    if (line.trimStart().startsWith('#')) continue;
    assert.ok(/^[\x00-\x7f]*$/.test(line), '代码行含非 ASCII 字符: ' + line);
  }
  assert.match(ps1, /"proc64":"/);
  assert.doesNotMatch(ps1, /"proc":"/);
});

test('lastInputAt：一分钟内动过键鼠才算在用电脑；前台是小狗自己的窗口也算', (t) => {
  const tr = makeTracker(t);
  assert.equal(tr.lastInputAt, 0);
  tr.onSample({ proc: 'Code', title: '', idleMs: 3 * 60_000 }, 1000);
  assert.equal(tr.lastInputAt, 0);
  tr.onSample({ proc: 'Code', title: '', idleMs: 500 }, 2000);
  assert.equal(tr.lastInputAt, 2000);
  tr.onSample({ proc: 'electron', title: '今日计划', idleMs: 0 }, 4000);
  assert.equal(tr.lastInputAt, 4000);
  tr.onSample({ proc: 'Code', title: '', idleMs: 90_000 }, 6000);
  assert.equal(tr.lastInputAt, 4000);
});
