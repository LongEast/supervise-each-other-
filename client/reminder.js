// 「该学习啦」提醒：连续摸鱼每满 N 分钟提醒一次（设 20 就是 20、40、60 分钟…）。
// 纯函数，方便测试；弹窗在 main.js 里，窗口是 renderer/remind.html。

const REMIND_DEFAULT = 20; // 默认连续摸鱼 20 分钟提醒
const REMIND_MAX = 240;

/** 把设置里填的分钟数变成合法的：1–240 的整数，乱七八糟的输入当默认值 */
function clampRemindMinutes(v) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n) || n < 1) return REMIND_DEFAULT;
  return Math.min(REMIND_MAX, n);
}

/** 连续摸鱼这么久，该是第几次提醒了：0 = 还没到；数字变大的那一刻就是该提醒的时候 */
function remindLevel(streakSec, everyMin) {
  const sec = Number(streakSec);
  if (!Number.isFinite(sec) || sec <= 0) return 0;
  return Math.floor(sec / 60 / clampRemindMinutes(everyMin));
}

module.exports = { clampRemindMinutes, remindLevel, REMIND_DEFAULT, REMIND_MAX };
