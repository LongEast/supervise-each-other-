const test = require('node:test');
const assert = require('node:assert/strict');
const { clampRemindMinutes, remindLevel, REMIND_DEFAULT, REMIND_MAX } = require('../client/reminder');

test('clampRemindMinutes：1–240 的整数，乱七八糟的输入当默认的 20 分钟', () => {
  assert.equal(REMIND_DEFAULT, 20);
  assert.equal(clampRemindMinutes(30), 30);
  assert.equal(clampRemindMinutes('45'), 45); // 设置页传过来的是字符串
  assert.equal(clampRemindMinutes(12.6), 13);
  assert.equal(clampRemindMinutes(9999), REMIND_MAX);
  for (const bad of [undefined, null, NaN, '', 'abc', 0, -5, 0.2]) assert.equal(clampRemindMinutes(bad), REMIND_DEFAULT);
});

test('remindLevel：每满 N 分钟升一级，没到第一次是 0', () => {
  assert.equal(remindLevel(0, 20), 0);
  assert.equal(remindLevel(19 * 60 + 59, 20), 0);
  assert.equal(remindLevel(20 * 60, 20), 1);
  assert.equal(remindLevel(39 * 60, 20), 1);
  assert.equal(remindLevel(40 * 60, 20), 2);
  assert.equal(remindLevel(125 * 60, 20), 6);
  assert.equal(remindLevel(10 * 60, 5), 2); // 间隔可以自己设
  for (const bad of [undefined, null, NaN, -30]) assert.equal(remindLevel(bad, 20), 0);
  assert.equal(remindLevel(20 * 60, 'abc'), 1); // 间隔不合法按默认的 20 分钟算
});

test('一轮连续摸鱼里：设 20 分钟就在 20、40、60 分钟各提醒一次，回去学习后重新算', () => {
  // 和 main.js 里 tick 的写法一样：级别比上次见到的高就提醒
  let seen = 0;
  const fired = [];
  const tick = (streakSec) => {
    const level = remindLevel(streakSec, 20);
    if (level > seen) fired.push(Math.floor(streakSec / 60));
    seen = level;
  };
  for (let sec = 0; sec <= 65 * 60; sec += 2) tick(sec); // 每 2 秒采样一次，连续摸鱼 65 分钟
  assert.deepEqual(fired, [20, 40, 60]);
  tick(0); // 回去学习，连续摸鱼清零
  for (let sec = 0; sec <= 21 * 60; sec += 2) tick(sec);
  assert.deepEqual(fired, [20, 40, 60, 20]);
});
