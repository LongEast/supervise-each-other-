/* global buddy */
// 「该学习啦」提醒窗口：连续摸鱼到了设置的时间弹出来，要自己点掉。
// 还没点掉又到了下一次，主进程会发新的时长过来，原地更新。
const $ = (id) => document.getElementById(id);
const query = new URLSearchParams(location.search);

function fmt(min) {
  const m = Math.max(0, Math.round(Number(min) || 0));
  return m >= 60 ? `${Math.floor(m / 60)} 小时${m % 60 ? ` ${m % 60} 分钟` : ''}` : `${m} 分钟`;
}
function show({ minutes, every, friend }) {
  $('minutes').textContent = fmt(minutes);
  $('friend').textContent = friend ? `${friend} 能看到哦 👀` : ''; // 名字是对方发来的，只当文本
  $('every').textContent = every ? `还在摸鱼的话 ${fmt(every)}后再提醒 · ` : '';
}

show({ minutes: query.get('minutes'), every: query.get('every'), friend: query.get('friend') });
buddy.onRemind(show);

$('ok').addEventListener('click', () => window.close());
$('settings').addEventListener('click', (e) => {
  e.preventDefault();
  buddy.openSettings();
  window.close();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') window.close();
});
