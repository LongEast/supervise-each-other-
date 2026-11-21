/* global buddy */
// 「该学习啦」提醒窗口：连续摸鱼到了设置的时间弹出来，要自己点掉。
// 下拉框选「再过多久提醒我」：默认是设置里的间隔，改了只管下一次。
// 还没点掉又到了下一次，主进程会发新的时长过来，原地更新。
const $ = (id) => document.getElementById(id);
const query = new URLSearchParams(location.search);

function fmt(min) {
  const m = Math.max(0, Math.round(Number(min) || 0));
  return m >= 60 ? `${Math.floor(m / 60)} 小时${m % 60 ? ` ${m % 60} 分钟` : ''}` : `${m} 分钟`;
}
function show({ minutes, every, options, friend }) {
  $('minutes').textContent = fmt(minutes);
  $('friend').textContent = friend ? `${friend} 能看到哦 👀` : ''; // 名字是对方发来的，只当文本
  // 每次弹出来都回到设置里的那个间隔
  const list = (Array.isArray(options) ? options : String(options || '').split(',')).map(Number).filter((n) => n > 0);
  const def = Number(every) || list[0];
  if (def && !list.includes(def)) list.push(def);
  $('next').replaceChildren(...list.sort((a, b) => a - b).map((n) => new Option(fmt(n), String(n), n === def, n === def)));
}

show({ minutes: query.get('minutes'), every: query.get('every'), options: query.get('options'), friend: query.get('friend') });
buddy.onRemind(show);

$('next').addEventListener('change', () => buddy.remindNext(Number($('next').value)));
$('ok').addEventListener('click', () => window.close());
$('settings').addEventListener('click', (e) => {
  e.preventDefault();
  buddy.openSettings();
  window.close();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') window.close();
});
