/* global buddy */
// 提醒窗口，置顶、要自己点掉。两种提醒共用（kind）：
// - 'slack' 该学习啦：连续摸鱼到了设置的时间。下拉框选「再过多久提醒我」，默认是设置里的间隔，改了只管下一次。
// - 'focus' 该专注啦：番茄钟的休息结束了，却还在摸鱼。
// 还没点掉又来了下一次，主进程会发新的内容过来，原地更新。
const $ = (id) => document.getElementById(id);
const query = new URLSearchParams(location.search);

function fmt(min) {
  const m = Math.max(0, Math.round(Number(min) || 0));
  return m >= 60 ? `${Math.floor(m / 60)} 小时${m % 60 ? ` ${m % 60} 分钟` : ''}` : `${m} 分钟`;
}
function show({ kind, minutes, every, options, friend }) {
  const focus = kind === 'focus';
  document.title = focus ? '该专注啦' : '该学习啦';
  $('icon').textContent = focus ? '🍅' : '🐶';
  $('title').textContent = focus ? '该专注啦！' : '该学习啦！';
  $('ok').textContent = focus ? '这就去专注 💪' : '这就去学习 💪';
  for (const id of ['whatSlack', 'footSlack']) $(id).hidden = focus;
  for (const id of ['whatFocus', 'footFocus']) $(id).hidden = !focus;
  // 名字是对方发来的，只当文本
  $('friend').textContent = friend ? (focus ? `${friend} 能看到你还在摸鱼哦 👀` : `${friend} 能看到哦 👀`) : focus ? '别摸鱼啦，回去干活吧～' : '';
  if (focus) return void ($('focusMinutes').textContent = fmt(minutes));
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
$('stopPomodoro').addEventListener('click', (e) => {
  e.preventDefault();
  buddy.stopPomodoro(); // 主进程结束番茄钟时会顺手把这个窗口关掉
});
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
