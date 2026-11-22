const test = require('node:test');
const assert = require('node:assert/strict');
const { Pomodoro, clampFocusMinutes, clampBreakMinutes, POMO_FOCUS_DEFAULT, POMO_BREAK_DEFAULT, POMO_FOCUS_MAX, POMO_BREAK_MAX, SETTLE_SEC } = require('../client/pomodoro');

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
});

test('专注 25 分钟 → 休息 5 分钟 → 专注 …，一直循环', () => {
  const p = new Pomodoro();
  p.start(T0, DEFAULTS);
  assert.equal(p.phase, 'focus');
  assert.equal(p.minutes, 25);
  assert.equal(p.leftSec(T0), 25 * 60);
  assert.equal(p.leftSec(T0 + 10 * MIN + 400), 15 * 60); // 不满一秒的往上取，倒计时不会提前跳
  const events = run(p, T0, T0 + 61 * MIN, { category: 'study' });
  assert.deepEqual(events, [
    [25 * 60, 'break'],
    [30 * 60, 'focus'],
    [55 * 60, 'break'],
    [60 * 60, 'focus'],
  ]);
  assert.equal(p.phase, 'focus');
  assert.equal(p.done, 2); // 专注完了两个番茄
});

test('休息结束时正在摸鱼：马上要弹窗；一次休息最多弹一次', () => {
  const p = new Pomodoro();
  p.start(T0, DEFAULTS);
  const act = (now) => ({ category: now < T0 + 25 * MIN ? 'study' : 'slack' });
  const events = run(p, T0, T0 + 50 * MIN, act);
  assert.deepEqual(events, [
    [25 * 60, 'break'], // 到休息时间：只有这一个事件，不弹窗
    [30 * 60, 'focus'],
    [30 * 60, 'nudge'],
  ]);
});

test('休息的时候摸鱼不弹窗，第一段专注里摸鱼也不归番茄钟管（那是摸鱼提醒的事）', () => {
  const p = new Pomodoro();
  p.start(T0, DEFAULTS);
  assert.deepEqual(run(p, T0, T0 + 29 * MIN, { category: 'slack' }), [[25 * 60, 'break']]);
});

test('休息结束时不在电脑前，回来接着摸鱼：回来的时候弹窗', () => {
  const p = new Pomodoro();
  p.start(T0, DEFAULTS);
  const act = (now) => ({ category: now < T0 + 33 * MIN ? 'away' : 'slack' });
  assert.deepEqual(run(p, T0, T0 + 40 * MIN, act), [
    [25 * 60, 'break'],
    [30 * 60, 'focus'],
    [33 * 60, 'nudge'],
  ]);
});

test('休息结束后老实用了一会儿电脑就算回去专注了，之后再摸鱼不弹窗', () => {
  const p = new Pomodoro();
  p.start(T0, DEFAULTS);
  const back = T0 + 30 * MIN;
  // 切出去不到 30 秒不算回去专注了
  const brief = (now) => ({ category: now < back + (SETTLE_SEC - 10) * 1000 ? 'study' : 'slack' });
  assert.deepEqual(run(p, T0, T0 + 40 * MIN, brief).at(-1), [30 * 60 + SETTLE_SEC - 10, 'nudge']);

  p.start(T0, DEFAULTS);
  const settled = (now) => ({ category: now < back + 2 * MIN ? 'study' : 'slack' });
  assert.deepEqual(run(p, T0, T0 + 50 * MIN, settled), [
    [25 * 60, 'break'],
    [30 * 60, 'focus'],
  ]);
});

test('弹过窗之后回去学习满 30 秒：窗口可以收起来（settled）；中途又摸鱼要重新数', () => {
  const p = new Pomodoro();
  p.start(T0, DEFAULTS);
  const back = T0 + 30 * MIN;
  const act = (now) => {
    const sec = (now - back) / 1000;
    if (sec < 0) return { category: 'study' };
    if (sec < 60) return { category: 'slack' }; // 休息结束还在摸鱼
    if (sec < 80) return { category: 'study' }; // 回去 20 秒
    if (sec < 100) return { category: 'slack' }; // 又摸了一会儿
    return { category: 'study' };
  };
  const events = run(p, T0, T0 + 40 * MIN, act);
  assert.deepEqual(events.slice(1), [
    [30 * 60, 'focus'],
    [30 * 60, 'nudge'],
    [30 * 60 + 100 + SETTLE_SEC - 1, 'settled'], // 第 100 秒那一下记的是之前那 1 秒，所以是 100 + 29
  ]);
  assert.equal(p.nudge, null);
});

test('暂停分享时（category 是 null）不弹窗', () => {
  const p = new Pomodoro();
  p.start(T0, DEFAULTS);
  assert.deepEqual(run(p, T0, T0 + 40 * MIN, { category: null }), [
    [25 * 60, 'break'],
    [30 * 60, 'focus'],
  ]);
});

test('skip：手动跳到下一段，不算完成一个番茄，跳过休息后也不盯着弹窗', () => {
  const p = new Pomodoro();
  p.start(T0, DEFAULTS);
  assert.equal(p.skip(T0 + 10 * MIN, DEFAULTS), 'break'); // 现在就休息
  assert.equal(p.done, 0);
  assert.equal(p.leftSec(T0 + 10 * MIN), 5 * 60);
  assert.equal(p.skip(T0 + 11 * MIN, DEFAULTS), 'focus'); // 跳过休息
  assert.equal(p.leftSec(T0 + 11 * MIN), 25 * 60);
  assert.deepEqual(run(p, T0 + 11 * MIN, T0 + 20 * MIN, { category: 'slack' }), []);
});

test('改了设置里的时长：正在进行的这一段不变，从下一段开始用新的', () => {
  const p = new Pomodoro();
  p.start(T0, DEFAULTS);
  const next = { focusMinutes: 50, breakMinutes: 10 };
  const events = run(p, T0 + 1000, T0 + 36 * MIN, { category: 'study' }, next);
  assert.deepEqual(events, [
    [25 * 60, 'break'],
    [35 * 60, 'focus'],
  ]);
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
  assert.deepEqual(run(p, T0, T0 + 31 * MIN, { category: 'study', lastInputAt: 0 }).map((e) => e[1]), ['break', 'focus']);
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
  assert.deepEqual([p.phase, p.done, p.endsAt, p.nudge], [null, 0, 0, null]);
  p.start(T0 + 40 * MIN, DEFAULTS);
  assert.equal(p.done, 0);
  assert.equal(p.leftSec(T0 + 40 * MIN), 25 * 60);
});
