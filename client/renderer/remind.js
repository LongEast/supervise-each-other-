/* global buddy */
// 提醒窗口，置顶、要自己点掉。三种提醒共用（kind）：
// - 'slack' 该学习啦：连续摸鱼到了设置的时间。下拉框选「再过多久提醒我」，默认是设置里的间隔，改了只管下一次。
// - 'focus' 休息结束啦：番茄钟的休息结束了。下一轮不会自己开始，要在这里选：
//   「重新开始番茄钟」→ 新一轮专注开始计时；小箭头点开 →「再休息一会」（设置里的休息时长）；
//   「恢复默认模式」→ 结束番茄钟。直接关掉窗口的话番茄钟停在原地，右键小狗还能选。
// - 'pause' 暂停时间到啦：严格模式下「暂停 5 分钟」到点了。倒计时不会自己接着走，要在这里选：
//   「继续专注」→ 从暂停时剩下的时间接着走；「5 分钟后再提醒」→ 接着暂停，到点再弹；「退出番茄钟」→ 结束番茄钟。
//   直接关掉窗口的话还是暂停着，右键小狗还能选。
// 还没点掉又来了下一次，主进程会发新的内容过来，原地更新。
const $ = (id) => document.getElementById(id);
const query = new URLSearchParams(location.search);

function fmt(min) {
  const m = Math.max(0, Math.round(Number(min) || 0));
  return m >= 60 ? `${Math.floor(m / 60)} 小时${m % 60 ? ` ${m % 60} 分钟` : ''}` : `${m} 分钟`;
}
// 小箭头：收起 / 展开「再休息一会」
function setMore(open) {
  $('more').setAttribute('aria-expanded', String(open));
  $('restMore').hidden = !open;
}
function show({ kind, minutes, every, options, friend, focusMinutes, breakMinutes, leftSec, pauseMinutes }) {
  const focus = kind === 'focus';
  const pause = kind === 'pause';
  const title = pause ? '暂停时间到啦' : focus ? '休息结束啦' : '该学习啦';
  document.title = title;
  $('icon').textContent = focus || pause ? '🍅' : '🐶';
  $('title').textContent = `${title}！`;
  for (const id of ['whatSlack', 'footSlack', 'ok', 'friend']) $(id).hidden = focus || pause;
  for (const id of ['whatFocus', 'footFocus', 'resume', 'more']) $(id).hidden = !focus;
  for (const id of ['whatPause', 'footPause', 'continue', 'pauseMore']) $(id).hidden = !pause;
  setMore(false);
  if (pause) {
    $('pauseLeft').textContent = fmt(Math.max(1, Math.ceil((Number(leftSec) || 0) / 60)));
    $('pauseMore').textContent = `${fmt(pauseMinutes || 5)}后再提醒`;
    return;
  }
  if (focus) {
    $('focusMinutes').textContent = fmt(focusMinutes);
    $('restMore').textContent = `再休息一会（${fmt(breakMinutes)}）`;
    return;
  }
  // 名字是对方发来的，只当文本
  $('friend').textContent = friend ? `${friend} 能看到哦 👀` : '';
  $('minutes').textContent = fmt(minutes);
  // 每次弹出来都回到设置里的那个间隔
  const list = (Array.isArray(options) ? options : String(options || '').split(',')).map(Number).filter((n) => n > 0);
  const def = Number(every) || list[0];
  if (def && !list.includes(def)) list.push(def);
  $('next').replaceChildren(...list.sort((a, b) => a - b).map((n) => new Option(fmt(n), String(n), n === def, n === def)));
}

show(Object.fromEntries(query));
buddy.onRemind(show);

$('next').addEventListener('change', () => buddy.remindNext(Number($('next').value)));
$('ok').addEventListener('click', () => window.close());
// 下面这些选完，主进程换到下一段（或者接着专注、结束番茄钟）时会顺手把这个窗口关掉
$('resume').addEventListener('click', () => buddy.resumePomodoro());
$('more').addEventListener('click', () => setMore($('restMore').hidden));
$('restMore').addEventListener('click', () => buddy.restMorePomodoro());
$('continue').addEventListener('click', () => buddy.continuePomodoro());
$('pauseMore').addEventListener('click', () => buddy.pauseMorePomodoro());
for (const id of ['stopPomodoro', 'quitPomodoro']) {
  $(id).addEventListener('click', (e) => {
    e.preventDefault();
    buddy.stopPomodoro();
  });
}
for (const a of document.querySelectorAll('.settings')) {
  a.addEventListener('click', (e) => {
    e.preventDefault();
    buddy.openSettings();
    window.close();
  });
}
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') window.close();
});
