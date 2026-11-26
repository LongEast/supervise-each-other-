const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { clampScale, petSize, rescaleBounds, fitOnScreen, SCALE_MIN, SCALE_MAX, SCALE_STEP } = require('../client/pet-geometry');

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

test('fitOnScreen：位置本来就看得见的不动', () => {
  const wa = [{ x: 0, y: 0, width: 1920, height: 1040 }];
  for (const s of [0.6, 1, 2]) {
    const pos = { x: 1500, y: 1040 - petSize(s).height };
    const b = fitOnScreen(pos, s, wa);
    assert.deepEqual({ x: b.x, y: b.y }, pos, `s=${s}`);
    assert.deepEqual({ width: b.width, height: b.height }, petSize(s));
  }
  // 小狗贴着屏幕上沿时，窗口上面透明的那截伸到屏幕外是正常的，也不动
  const top = { x: 100, y: -200 };
  assert.deepEqual(fitOnScreen(top, 1, wa).y, top.y);
});

test('fitOnScreen：跑到屏幕上面去了（副屏拔掉后存下的 y=-458）拉回来，小狗和名牌整个看得见', () => {
  const wa = { x: 0, y: 0, width: 1280, height: 752 };
  const b = fitOnScreen({ x: 1060, y: -458 }, 0.6, [wa]);
  const petBottom = b.y + b.height; // 名牌底边就是窗口底边
  const petTop = petBottom - (Math.round(131 * 0.6) + 24);
  assert.ok(petTop >= wa.y && petBottom <= wa.y + wa.height, JSON.stringify(b));
  const cx = b.x + b.width / 2;
  assert.ok(cx - 75 >= wa.x && cx + 75 <= wa.x + wa.width, JSON.stringify(b));
});

test('fitOnScreen：拔掉右边的副屏后挪到主屏；还在副屏上的留在副屏', () => {
  const main = { x: 0, y: 0, width: 1920, height: 1040 };
  const side = { x: 1920, y: 0, width: 1920, height: 1040 };
  const onSide = { x: 3000, y: 600 };
  assert.deepEqual(fitOnScreen(onSide, 1, [main, side]).x, onSide.x);
  const b = fitOnScreen(onSide, 1, [main]);
  assert.ok(b.x + b.width / 2 + 75 <= main.width && b.y === onSide.y, JSON.stringify(b));
  // 屏幕在左边、坐标是负的也行
  const left = { x: -1920, y: 0, width: 1920, height: 1040 };
  assert.ok(fitOnScreen({ x: -5000, y: 600 }, 1, [left, main]).x >= -1920 - 65);
});

test('fitOnScreen：拿不到屏幕信息时原样返回', () => {
  assert.deepEqual(fitOnScreen({ x: 5, y: 6 }, 1, []), { x: 5, y: 6, ...petSize(1) });
});
