const test = require('node:test');
const assert = require('node:assert/strict');
const { SlackReminder, clampRemindMinutes, remindOptions, REMIND_DEFAULT, REMIND_OPTIONS, REMIND_MAX } = require('../client/reminder');

const MIN = 60;
/** 模拟每 2 秒采样一次，从 from 分钟连续摸鱼到 to 分钟；返回提醒发生在第几分钟 */
function run(r, every, from, to, onDue) {
  const fired = [];
  for (let sec = from * MIN; sec <= to * MIN; sec += 2) {
    if (r.tick(sec, every) === 'due') {
      fired.push(Math.floor(sec / MIN));
      onDue?.(sec);
    }
  }
  return fired;
}

test('默认每 5 分钟提醒一次，可以选 5 / 10 / 20 / 40', () => {
  assert.equal(REMIND_DEFAULT, 5);
  assert.deepEqual(REMIND_OPTIONS, [5, 10, 20, 40]);
  assert.ok(REMIND_OPTIONS.includes(REMIND_DEFAULT));
});

test('clampRemindMinutes：1–240 的整数，乱七八糟的输入当默认值', () => {
  assert.equal(clampRemindMinutes(30), 30);
  assert.equal(clampRemindMinutes('45'), 45); // 设置页传过来的是字符串
  assert.equal(clampRemindMinutes(12.6), 13);
  assert.equal(clampRemindMinutes(9999), REMIND_MAX);
  for (const bad of [undefined, null, NaN, '', 'abc', 0, -5, 0.2]) assert.equal(clampRemindMinutes(bad), REMIND_DEFAULT);
});

test('remindOptions：设置里填的文字或存下的数组 → 去重、排序、去掉不合法的', () => {
  assert.deepEqual(remindOptions('5, 10, 20, 40'), [5, 10, 20, 40]);
  assert.deepEqual(remindOptions('40，10、5 20;10'), [5, 10, 20, 40]); // 中文逗号、顿号、空格都行
  assert.deepEqual(remindOptions([30, 10, 10, 60]), [10, 30, 60]);
  assert.deepEqual(remindOptions('10, abc, 0, -5, 2.5, 999, 30'), [10, 30]);
  assert.deepEqual(remindOptions('1 2 3 4 5 6 7 8 9 10'), [1, 2, 3, 4, 5, 6, 7, 8]); // 下拉框最多 8 项
  for (const empty of ['', '   ', 'abc', undefined, null, [], [null, true, {}]]) assert.deepEqual(remindOptions(empty), REMIND_OPTIONS);
  assert.notEqual(remindOptions(''), REMIND_OPTIONS); // 给的是副本，改了不会动到默认值
});

test('remindOptions：设置里选中的那个间隔一定在可选的里面', () => {
  assert.deepEqual(remindOptions('5, 10, 20, 40', 20), [5, 10, 20, 40]);
  assert.deepEqual(remindOptions('10, 30', 15), [10, 15, 30]);
  assert.deepEqual(remindOptions('10, 30', '15'), [10, 15, 30]);
  assert.deepEqual(remindOptions('10, 30', 'abc'), [5, 10, 30]); // 不合法的当默认的 5
});

test('选 5 分钟：连续摸鱼 5、10、15、20…各提醒一次，不会越数越偏', () => {
  assert.deepEqual(run(new SlackReminder(), 5, 0, 31), [5, 10, 15, 20, 25, 30]);
  assert.deepEqual(run(new SlackReminder(), 20, 0, 65), [20, 40, 60]);
  assert.deepEqual(run(new SlackReminder(), 40, 0, 125), [40, 80, 120]);
});

test('采样不是刚好落在整分钟上也不会漏、不会偏', () => {
  const r = new SlackReminder();
  const fired = [];
  for (let sec = 1; sec <= 16 * MIN; sec += 7) if (r.tick(sec, 5) === 'due') fired.push(sec);
  assert.equal(fired.length, 3);
  fired.forEach((sec, i) => assert.ok(sec >= (i + 1) * 5 * MIN && sec < (i + 1) * 5 * MIN + 7, `第 ${i + 1} 次在 ${sec}s`));
});

test('回去学习后重新算：tick 返回 reset，下一轮从头数', () => {
  const r = new SlackReminder();
  assert.deepEqual(run(r, 5, 0, 12), [5, 10]);
  assert.equal(r.tick(0, 5), 'reset'); // 连续摸鱼清零 → 提醒窗口可以收起来
  assert.equal(r.tick(0, 5), null); // 只报一次
  assert.deepEqual(run(r, 5, 0, 6), [5]);
});

test('提醒窗口里临时选「再过 40 分钟」：只管下一次，之后回到设置里的 5 分钟', () => {
  const r = new SlackReminder();
  // 第 5 分钟弹窗，过了 30 秒在下拉框里选了 40
  assert.deepEqual(run(r, 5, 0, 5), [5]);
  r.tick(5 * MIN + 30, 5);
  r.snooze(40, 5 * MIN + 30);
  const later = run(r, 5, 6, 56);
  assert.deepEqual(later, [45, 50, 55]); // 5.5 + 40 = 45.5 分钟那次，然后又是每 5 分钟
});

test('临时选的间隔比设置的短也行；这一轮结束后临时选的作废', () => {
  const r = new SlackReminder();
  assert.deepEqual(run(r, 20, 0, 20), [20]);
  r.snooze(5, 20 * MIN);
  assert.deepEqual(run(r, 20, 20, 50), [25, 45]); // 25 是临时选的，之后回到每 20 分钟
  r.snooze(40, 50 * MIN);
  assert.equal(r.tick(0, 20), 'reset'); // 回去学习了
  assert.deepEqual(run(r, 20, 0, 41), [20, 40]); // 新的一轮不受上次选的 40 影响
});

test('中途在设置里改间隔：马上生效，改短了也只补一次，不会连着弹', () => {
  const r = new SlackReminder();
  assert.deepEqual(run(r, 40, 0, 17), []);
  // 已经连续摸鱼 17 分钟，把间隔从 40 改成 5：马上提醒一次，然后从现在起每 5 分钟
  assert.deepEqual(run(r, 5, 17, 30), [17, 22, 27]);
  // 改长：从上次提醒的时刻数
  assert.deepEqual(run(r, 20, 30, 50), [47]);
});

test('暂停分享、离开时连续摸鱼是 0：不提醒；乱七八糟的输入当 0', () => {
  const r = new SlackReminder();
  for (const bad of [0, undefined, null, NaN, -30]) assert.equal(r.tick(bad, 5), null);
  assert.equal(r.tick(4 * MIN, 5), null);
  assert.equal(r.tick(5 * MIN, 'abc'), 'due'); // 间隔不合法按默认的 5 分钟算
});
