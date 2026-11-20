const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { clampScale, petSize, rescaleBounds, SCALE_MIN, SCALE_MAX, SCALE_STEP } = require('../client/pet-geometry');

test('clampScale：限制在范围内，0.05 一档，乱七八糟的输入当 100%', () => {
  assert.equal(clampScale(1), 1);
  assert.equal(clampScale(0.1), SCALE_MIN);
  assert.equal(clampScale(99), SCALE_MAX);
  assert.equal(clampScale(1.1 + SCALE_STEP), 1.2); // 浮点误差不会存下来
  assert.equal(clampScale(1.23), 1.25);
  for (const bad of [undefined, null, NaN, 'abc', -1, 0]) assert.equal(clampScale(bad), 1);
});

test('连续滚滚轮：每格 10%，到头就停，来回滚能回到原来的大小', () => {
  let s = 1;
  for (let i = 0; i < 40; i++) s = clampScale(s + SCALE_STEP);
  assert.equal(s, SCALE_MAX);
  for (let i = 0; i < 15; i++) s = clampScale(s - SCALE_STEP);
  assert.equal(s, 1);
  for (let i = 0; i < 40; i++) s = clampScale(s - SCALE_STEP);
  assert.equal(s, SCALE_MIN);
});

test('petSize：100% 时是原来的 280×380；小狗变大窗口跟着变大，卡片的空间不变', () => {
  assert.deepEqual(petSize(1), { width: 280, height: 380 });
  assert.deepEqual(petSize(2), { width: 320, height: 511 });
  assert.equal(petSize(SCALE_MIN).width, 280); // 再小也要放得下卡片
  assert.equal(petSize(2).height - Math.round(131 * 2), petSize(1).height - 131);
});

test('rescaleBounds：缩放前后小狗的脚（窗口底边中点）在屏幕上不动', () => {
  const foot = (b) => ({ x: b.x + b.width / 2, y: b.y + b.height });
  const from = { x: 1000, y: 500, ...petSize(1) };
  for (const s of [0.6, 0.75, 1.5, 2, 2.5]) {
    const to = rescaleBounds(from, 1, s);
    assert.deepEqual({ width: to.width, height: to.height }, petSize(s));
    assert.equal(foot(to).y, foot(from).y);
    assert.ok(Math.abs(foot(to).x - foot(from).x) <= 0.5, `s=${s}`);
    const back = rescaleBounds(to, s, 1); // 缩回去回到原位，不会越调越偏
    assert.ok(Math.abs(back.x - from.x) <= 1 && back.y === from.y, `s=${s}`);
  }
});

test('pet.css 里小狗的基准尺寸和 pet-geometry.js 一致（窗口大小是照着这些数算的）', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'client', 'renderer', 'pet.css'), 'utf8');
  assert.match(css, /--pet-w:\s*calc\(150px \* var\(--pet-scale\)\)/);
  assert.match(css, /--pet-h:\s*calc\(131px \* var\(--pet-scale\)\)/);
  assert.match(css, /bottom:\s*calc\(var\(--pet-h\) \+ 21px\)/); // 卡片贴在小狗 + 名牌上面
  const geo = fs.readFileSync(path.join(__dirname, '..', 'client', 'pet-geometry.js'), 'utf8');
  assert.match(geo, /PET_BASE_W = 150;/);
  assert.match(geo, /PET_BASE_H = 131;/);
});
