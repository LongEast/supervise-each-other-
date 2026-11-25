const test = require('node:test');
const assert = require('node:assert/strict');
const { Pomodoro, clampFocusMinutes, clampBreakMinutes, POMO_FOCUS_DEFAULT, POMO_BREAK_DEFAULT, POMO_FOCUS_MAX, POMO_BREAK_MAX, POMO_PAUSE_MINUTES } = require('../client/pomodoro');

const MIN = 60_000;
const T0 = 1_700_000_000_000;
const DEFAULTS = { focusMinutes: 25, breakMinutes: 5 };

/**
 * 每秒 tick 一次，从 from 到 to（毫秒，含两头）。activity 可以是固定的，也可以是 (now) => activity。
 * 返回发生的事：[[第几秒, 事件], …]，秒数从 T0 算
 */
function run(p, from, to, activity = {}, settings = DEFAULTS) {
  const out = [];
  for (let now = from; now <= to; now += 1000) {
    const a = typeof activity === 'function' ? activity(now) : activity;
    for (const e of p.tick(now, a, settings)) out.push([(now - T0) / 1000, e]);
  }
  return out;
}

test('默认专注 25 分钟、休息 5 分钟', () => {
  assert.equal(POMO_FOCUS_DEFAULT, 25);
  assert.equal(POMO_BREAK_DEFAULT, 5);
});

test('clampFocusMinutes / clampBreakMinutes：整数分钟，有上限，乱七八糟的输入当默认值', () => {
  assert.equal(clampFocusMinutes(50), 50);
  assert.equal(clampFocusMinutes('45'), 45); // 设置页传过来的是字符串
  assert.equal(clampFocusMinutes(12.6), 13);
  assert.equal(clampFocusMinutes(9999), POMO_FOCUS_MAX);
  assert.equal(clampBreakMinutes(10), 10);
  assert.equal(clampBreakMinutes(9999), POMO_BREAK_MAX);
  for (const bad of [undefined, null, NaN, '', 'abc', 0, -5, 0.2]) {
    assert.equal(clampFocusMinutes(bad), POMO_FOCUS_DEFAULT);
    assert.equal(clampBreakMinutes(bad), POMO_BREAK_DEFAULT);
  }
});

test('没开的时候什么都不发生', () => {
  const p = new Pomodoro();
  assert.equal(p.phase, null);
  assert.deepEqual(p.tick(T0, { category: 'slack' }, DEFAULTS), []);
  assert.equal(p.leftSec(T0), 0);
  assert.equal(p.skip(T0, DEFAULTS), null);
  assert.equal(p.resume(T0, DEFAULTS), null);
  assert.equal(p.restMore(T0, DEFAULTS), null);
});

test('专注 25 分钟 → 休息 5 分钟 → 停下来等着点「重新开始」，不会自己开始下一轮', () => {
  const p = new Pomodoro();
  p.start(T0, DEFAULTS);
  assert.equal(p.phase, 'focus');
  assert.equal(p.minutes, 25);
  assert.equal(p.leftSec(T0), 25 * 60);
  assert.equal(p.leftSec(T0 + 10 * MIN + 400), 15 * 60); // 不满一秒的往上取，倒计时不会提前跳
  // 休息结束后又过了 20 分钟也没点：一直停在 wait，只有一次 'wait' 事件
  const events = run(p, T0, T0 + 50 * MIN, (now) => ({ lastInputAt: now }));
  assert.deepEqual(events, [
    [25 * 60, 'break'],
    [30 * 60, 'wait'],
  ]);
  assert.equal(p.phase, 'wait');
  assert.equal(p.done, 1);
  assert.deepEqual([p.minutes, p.endsAt, p.leftSec(T0 + 50 * MIN)], [0, 0, 0]); // 没有倒计时
});

test('resume：点了「重新开始番茄钟」，新一轮专注从点的那一刻算起', () => {
  const p = new Pomodoro();
  p.start(T0, DEFAULTS);
  run(p, T0, T0 + 33 * MIN, (now) => ({ lastInputAt: now }));
  assert.equal(p.phase, 'wait');
  const at = T0 + 33 * MIN;
  assert.equal(p.resume(at, DEFAULTS), 'focus');
  assert.equal(p.leftSec(at), 25 * 60); // 等的那 3 分钟不算在专注里
  assert.deepEqual(run(p, at, at + 31 * MIN, (now) => ({ lastInputAt: now })), [
    [(33 + 25) * 60, 'break'],
    [(33 + 30) * 60, 'wait'],
  ]);
  assert.equal(p.done, 2);
  // 只有 wait 时能点
  p.start(T0, DEFAULTS);
  assert.equal(p.resume(T0 + MIN, DEFAULTS), null);
  assert.equal(p.leftSec(T0 + MIN), 24 * 60);
});

test('restMore：点了「再休息一会」，按现在设置里的休息时长再休息一段，结束后还是等着点', () => {
  const p = new Pomodoro();
  p.start(T0, DEFAULTS);
  run(p, T0, T0 + 31 * MIN, (now) => ({ lastInputAt: now }));
  const at = T0 + 31 * MIN;
  assert.equal(p.restMore(at, { focusMinutes: 25, breakMinutes: 10 }), 'break'); // 中途把休息改成了 10 分钟
  assert.equal(p.phase, 'break');
  assert.equal(p.minutes, 10);
  assert.equal(p.leftSec(at), 10 * 60);
  assert.equal(p.done, 1); // 多休息一段不算番茄
  assert.deepEqual(run(p, at, at + 12 * MIN, (now) => ({ lastInputAt: now })), [[(31 + 10) * 60, 'wait']]);
  // 专注和休息的时候不能点
  p.start(T0, DEFAULTS);
  assert.equal(p.restMore(T0 + MIN, DEFAULTS), null);
  assert.equal(p.phase, 'focus');
});

test('等着点的时候在干什么都不影响：摸鱼、暂停分享（category 是 null）都一样停着', () => {
  for (const category of ['slack', 'study', null]) {
    const p = new Pomodoro();
    p.start(T0, DEFAULTS);
    assert.deepEqual(run(p, T0, T0 + 40 * MIN, (now) => ({ category, lastInputAt: now })), [
      [25 * 60, 'break'],
      [30 * 60, 'wait'],
    ]);
  }
});

test('弹窗一直没人点：一整轮没碰电脑，或者电脑睡了一觉，就自己停掉', () => {
  const p = new Pomodoro();
  p.start(T0, DEFAULTS);
  // 休息到一半走开了（第 28 分钟之后没再碰电脑）
  const act = (now) => ({ lastInputAt: Math.min(now, T0 + 28 * MIN) });
  assert.deepEqual(run(p, T0, T0 + 70 * MIN, act), [
    [25 * 60, 'break'],
    [30 * 60, 'wait'],
    [(28 + 30) * 60, 'idle'], // 28 分钟 + 一整轮 30 分钟
  ]);
  assert.equal(p.phase, null);

  // 等着的时候合上了电脑，3 小时后被按键叫醒（所以键鼠是刚动过的）
  p.start(T0, DEFAULTS);
  run(p, T0, T0 + 31 * MIN, (now) => ({ lastInputAt: now }));
  assert.equal(p.phase, 'wait');
  const wake = T0 + 211 * MIN;
  assert.deepEqual(p.tick(wake, { lastInputAt: wake }, DEFAULTS), ['idle']);
  assert.equal(p.phase, null);
});

test('skip：手动跳到下一段，不算完成一个番茄；跳过休息是自己点的，直接开始专注不用再确认', () => {
  const p = new Pomodoro();
  p.start(T0, DEFAULTS);
  assert.equal(p.skip(T0 + 10 * MIN, DEFAULTS), 'break'); // 现在就休息
  assert.equal(p.done, 0);
  assert.equal(p.leftSec(T0 + 10 * MIN), 5 * 60);
  assert.equal(p.skip(T0 + 11 * MIN, DEFAULTS), 'focus'); // 跳过休息
  assert.equal(p.leftSec(T0 + 11 * MIN), 25 * 60);
  assert.deepEqual(run(p, T0 + 11 * MIN, T0 + 20 * MIN, { category: 'slack' }), []);
  // 等着点的时候 skip 也是开始专注
  run(p, T0 + 11 * MIN, T0 + 42 * MIN, (now) => ({ lastInputAt: now }));
  assert.equal(p.phase, 'wait');
  assert.equal(p.skip(T0 + 42 * MIN, DEFAULTS), 'focus');
});

test('改了设置里的时长：正在进行的这一段不变，从下一段开始用新的', () => {
  const p = new Pomodoro();
  p.start(T0, DEFAULTS);
  const next = { focusMinutes: 50, breakMinutes: 10 };
  const events = run(p, T0 + 1000, T0 + 36 * MIN, { category: 'study' }, next);
  assert.deepEqual(events, [
    [25 * 60, 'break'],
    [35 * 60, 'wait'],
  ]);
  assert.equal(p.resume(T0 + 36 * MIN, next), 'focus');
  assert.equal(p.minutes, 50);
});

test('一整轮（专注 + 休息）没碰电脑：到点自己停掉，不会空转一整晚', () => {
  const p = new Pomodoro();
  p.start(T0, DEFAULTS);
  // 专注时在看纸质书，25 分钟没碰电脑：还不到一整轮，照常进入休息
  const act = { category: 'away', lastInputAt: T0 };
  assert.deepEqual(run(p, T0, T0 + 26 * MIN, act), [[25 * 60, 'break']]);
  // 休息完了还是没回来
  assert.deepEqual(run(p, T0 + 26 * MIN, T0 + 31 * MIN, act), [[30 * 60, 'idle']]);
  assert.equal(p.phase, null);
  assert.deepEqual(p.tick(T0 + 32 * MIN, act, DEFAULTS), []);
});

test('没有键鼠记录（lastInputAt 是 0，比如采集还没启动）不会被当成人不在', () => {
  const p = new Pomodoro();
  p.start(T0, DEFAULTS);
  assert.deepEqual(run(p, T0, T0 + 90 * MIN, { category: 'study', lastInputAt: 0 }).map((e) => e[1]), ['break', 'wait']);
});

test('电脑睡了一觉，醒来时早就过点了：直接停掉', () => {
  const p = new Pomodoro();
  p.start(T0, DEFAULTS);
  run(p, T0, T0 + 10 * MIN, { category: 'study', lastInputAt: T0 + 10 * MIN });
  // 睡了 3 个小时，被按键叫醒（所以键鼠是刚动过的）
  const wake = T0 + 190 * MIN;
  assert.deepEqual(p.tick(wake, { category: 'study', lastInputAt: wake }, DEFAULTS), ['idle']);
  assert.equal(p.phase, null);
  // 只晚了一小会儿（卡了一下）不算
  p.start(T0, DEFAULTS);
  assert.deepEqual(p.tick(T0 + 26 * MIN, { category: 'study', lastInputAt: T0 + 26 * MIN }, DEFAULTS), ['break']);
  assert.equal(p.leftSec(T0 + 26 * MIN), 5 * 60); // 休息从现在算起，不会少一分钟
});

test('stop 之后回到没开的样子，重新开始从第一个番茄数', () => {
  const p = new Pomodoro();
  p.start(T0, DEFAULTS);
  run(p, T0, T0 + 26 * MIN, { category: 'study' });
  assert.equal(p.done, 1);
  p.stop();
  assert.deepEqual([p.phase, p.done, p.endsAt], [null, 0, 0]);
  p.start(T0 + 40 * MIN, DEFAULTS);
  assert.equal(p.done, 0);
  assert.equal(p.leftSec(T0 + 40 * MIN), 25 * 60);
});

// ---------------- 严格模式 ----------------
const STRICT = { ...DEFAULTS, strict: true };

test('严格模式：专注时摸鱼的时间不算，倒计时停着，回去学习才接着走', () => {
  const p = new Pomodoro();
  p.start(T0, STRICT);
  // 学 10 分钟 → 摸鱼 7 分钟 → 接着学：专注一共要 25 分钟，所以第 32 分钟才结束
  const slacking = (now) => ({ slacking: now > T0 + 10 * MIN && now <= T0 + 17 * MIN });
  const events = run(p, T0, T0 + 33 * MIN, slacking, STRICT);
  assert.deepEqual(events, [
    [10 * 60 + 1, 'freeze'],
    [17 * 60 + 1, 'unfreeze'],
    [32 * 60, 'break'],
  ]);
  assert.equal(p.done, 1);
});

test('严格模式：摸鱼的时候倒计时一秒都不走，hold 是 slack；不摸鱼了 hold 回到 null', () => {
  const p = new Pomodoro();
  p.start(T0, STRICT);
  run(p, T0, T0 + 10 * MIN, {}, STRICT);
  assert.equal(p.hold, null);
  run(p, T0 + 10 * MIN + 1000, T0 + 15 * MIN, { slacking: true }, STRICT);
  assert.equal(p.hold, 'slack');
  assert.equal(p.leftSec(T0 + 15 * MIN), 15 * 60);
  run(p, T0 + 15 * MIN + 1000, T0 + 16 * MIN, {}, STRICT);
  assert.equal(p.hold, null);
  assert.equal(p.leftSec(T0 + 16 * MIN), 14 * 60); // 停了 5 分钟整，之后照常走
});

test('没开严格模式：摸鱼照样往下走；休息时摸鱼也不停', () => {
  const p = new Pomodoro();
  p.start(T0, DEFAULTS);
  assert.deepEqual(run(p, T0, T0 + 26 * MIN, { slacking: true }, DEFAULTS), [[25 * 60, 'break']]);
  // 严格模式只管专注：休息时摸鱼，休息的倒计时照常走
  const q = new Pomodoro();
  q.start(T0, STRICT);
  q.skip(T0, STRICT);
  assert.deepEqual(run(q, T0, T0 + 6 * MIN, { slacking: true }, STRICT), [[5 * 60, 'wait']]);
});

test('严格模式中途关掉：马上接着走', () => {
  const p = new Pomodoro();
  p.start(T0, STRICT);
  run(p, T0, T0 + 5 * MIN, { slacking: true }, STRICT);
  assert.equal(p.hold, 'slack');
  assert.deepEqual(p.tick(T0 + 5 * MIN + 1000, { slacking: true }, DEFAULTS), ['unfreeze']);
  assert.equal(p.hold, null);
});

test('严格模式：停在摸鱼的页面上电脑睡了一觉，醒来直接停掉，不会一直挂着', () => {
  const p = new Pomodoro();
  p.start(T0, STRICT);
  run(p, T0, T0 + 5 * MIN, { slacking: true, lastInputAt: T0 + 5 * MIN }, STRICT);
  const wake = T0 + 200 * MIN;
  assert.deepEqual(p.tick(wake, { slacking: true, lastInputAt: wake }, STRICT), ['idle']);
  assert.equal(p.phase, null);
});

test('pause：暂停 5 分钟，专注的倒计时停住；到点了不会自己接着走，等着选', () => {
  const p = new Pomodoro();
  p.start(T0, STRICT);
  run(p, T0, T0 + 10 * MIN, {}, STRICT);
  assert.equal(p.pause(T0 + 10 * MIN), true);
  assert.equal(p.pause(T0 + 10 * MIN), false); // 已经暂停着
  assert.equal(p.hold, 'pause');
  assert.equal(p.pauseLeftSec(T0 + 10 * MIN), POMO_PAUSE_MINUTES * 60);
  // 暂停的时候在干什么都一样（摸鱼也不会再报 freeze）
  const events = run(p, T0 + 10 * MIN + 1000, T0 + 40 * MIN, (now) => ({ slacking: true, lastInputAt: now }), STRICT);
  assert.deepEqual(events, [[15 * 60, 'pause-over']]); // 只提醒一次，之后一直等着
  assert.equal(p.hold, 'over');
  assert.equal(p.phase, 'focus');
  assert.equal(p.leftSec(T0 + 40 * MIN), 15 * 60); // 专注还是暂停那一刻剩下的 15 分钟
  assert.equal(p.pauseLeftSec(T0 + 40 * MIN), 0);
});

test('unpause：点了「继续专注」，从暂停时剩下的时间接着走（没到点也能提前继续）', () => {
  const p = new Pomodoro();
  p.start(T0, STRICT);
  run(p, T0, T0 + 10 * MIN, {}, STRICT);
  assert.equal(p.unpause(T0 + 10 * MIN), false); // 没暂停着
  p.pause(T0 + 10 * MIN);
  run(p, T0 + 10 * MIN + 1000, T0 + 12 * MIN, {}, STRICT);
  assert.equal(p.unpause(T0 + 12 * MIN), true);
  assert.equal(p.hold, null);
  assert.equal(p.leftSec(T0 + 12 * MIN), 15 * 60);
  assert.deepEqual(run(p, T0 + 12 * MIN + 1000, T0 + 28 * MIN, {}, STRICT), [[27 * 60, 'break']]);
  assert.equal(p.done, 1); // 暂停过的番茄照样算完成
});

test('pauseMore：「5 分钟后再提醒」，从点的那一刻起再暂停 5 分钟，到点再提醒', () => {
  const p = new Pomodoro();
  p.start(T0, STRICT);
  p.pause(T0);
  assert.equal(new Pomodoro().pauseMore(T0), false); // 没暂停着
  run(p, T0 + 1000, T0 + 8 * MIN, (now) => ({ lastInputAt: now }), STRICT);
  assert.equal(p.hold, 'over');
  assert.equal(p.pauseMore(T0 + 8 * MIN), true);
  assert.equal(p.hold, 'pause');
  assert.deepEqual(run(p, T0 + 8 * MIN + 1000, T0 + 20 * MIN, (now) => ({ lastInputAt: now }), STRICT), [[13 * 60, 'pause-over']]);
  assert.equal(p.leftSec(T0 + 20 * MIN), 25 * 60); // 专注一秒没走
});

test('只有专注时能暂停；暂停着点「现在就休息」或者结束，暂停跟着清掉', () => {
  const p = new Pomodoro();
  assert.equal(p.pause(T0), false); // 没开
  p.start(T0, STRICT);
  p.skip(T0, STRICT);
  assert.equal(p.pause(T0), false); // 休息中
  p.skip(T0, STRICT);
  assert.equal(p.pause(T0), true);
  assert.equal(p.skip(T0 + MIN, STRICT), 'break');
  assert.deepEqual([p.paused, p.hold, p.leftSec(T0 + MIN)], [false, null, 5 * 60]);
  p.skip(T0 + MIN, STRICT);
  p.pause(T0 + MIN);
  p.stop();
  assert.deepEqual([p.paused, p.hold, p.phase], [false, null, null]);
});

test('暂停着一直没人管：一整轮没碰电脑，或者电脑睡了一觉，就自己停掉', () => {
  const p = new Pomodoro();
  p.start(T0, STRICT);
  p.pause(T0);
  // 人走了：最后一次动键鼠是暂停的时候
  const events = run(p, T0 + 1000, T0 + 40 * MIN, { lastInputAt: T0 }, STRICT);
  assert.deepEqual(events.map((e) => e[1]), ['pause-over', 'idle']);
  assert.equal(events[1][0], 30 * 60);
  // 电脑睡了
  p.start(T0, STRICT);
  p.pause(T0);
  p.tick(T0 + 1000, { lastInputAt: T0 + 1000 }, STRICT);
  assert.deepEqual(p.tick(T0 + 60 * MIN, { lastInputAt: T0 + 60 * MIN }, STRICT), ['idle']);
});
