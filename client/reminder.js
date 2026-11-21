// 「该学习啦」提醒：连续摸鱼每满 N 分钟提醒一次；每次的提醒窗口里可以临时改「下一次隔多久」。
// 纯逻辑，方便测试。主进程 require，设置页用 <script> 加载（要用同一套规则整理输入）；
// 弹窗在 main.js 里，窗口是 renderer/remind.html。
/* eslint-disable no-unused-vars */

const REMIND_DEFAULT = 5; // 默认每连续摸鱼 5 分钟提醒一次
const REMIND_OPTIONS = [5, 10, 20, 40]; // 默认可以选的间隔（分钟），设置里能改
const REMIND_MAX = 240;
const REMIND_OPTIONS_MAX = 8; // 下拉框里最多几项

/** 把一个分钟数变成合法的：1–240 的整数，乱七八糟的输入当默认值 */
function clampRemindMinutes(v) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n) || n < 1) return REMIND_DEFAULT;
  return Math.min(REMIND_MAX, n);
}

/**
 * 可以选的间隔：接受数组，或者「5, 10，20 40」这样的文字。去掉不合法的和重复的，从小到大排。
 * 给了 every（设置里选中的那个）的话保证它在里面。一个合法的都没有就用默认的。
 */
function remindOptions(input, every) {
  const raw = Array.isArray(input) ? input : String(input ?? '').split(/[,，、;；\s]+/);
  const set = new Set();
  for (const v of raw) {
    const n = Number(v);
    const ok = typeof v === 'number' || (typeof v === 'string' && v.trim() !== '');
    if (ok && Number.isInteger(n) && n >= 1 && n <= REMIND_MAX) set.add(n);
  }
  let list = [...set].sort((a, b) => a - b).slice(0, REMIND_OPTIONS_MAX);
  if (!list.length) list = [...REMIND_OPTIONS];
  if (every !== undefined) {
    const e = clampRemindMinutes(every);
    if (!list.includes(e)) list = [...list, e].sort((a, b) => a - b);
  }
  return list;
}

/**
 * 一轮连续摸鱼里什么时候该提醒。每次采样调一次 tick()。
 * 「一轮」= 连续摸鱼时长一直在涨；它变小了（回去学习、离开、暂停分享、跨天）就是新的一轮。
 */
class SlackReminder {
  constructor() {
    this.base = 0; // 从连续摸鱼的第几秒开始数下一次（上次提醒的时刻；新的一轮是 0）
    this.override = null; // 提醒窗口里临时选的间隔（分钟），只管下一次
    this.last = 0; // 上次采样时的连续摸鱼秒数
  }

  /**
   * @param {number} streakSec 现在已经连续摸鱼多少秒
   * @param {number} everyMin 设置里的间隔（分钟）
   * @returns {'due'|'reset'|null} 'due' 该提醒了；'reset' 这一轮结束了（提醒窗口可以收起来）
   */
  tick(streakSec, everyMin) {
    const streak = Number.isFinite(streakSec) && streakSec > 0 ? streakSec : 0;
    const ended = streak < this.last;
    this.last = streak;
    if (ended) {
      this.base = 0;
      this.override = null;
    }
    const target = this.base + clampRemindMinutes(this.override ?? everyMin) * 60;
    if (streak < target) return ended ? 'reset' : null;
    // 正常是刚好到点，从整点接着数（5 → 10 → 15，不会越数越偏）；
    // 一下子超出很多（比如中途把间隔改短了）就从现在数，免得接连弹好几次
    this.base = streak - target < 60 ? target : streak;
    this.override = null;
    return 'due';
  }

  /** 提醒窗口里选了「再过 X 分钟提醒我」：从现在起再连续摸鱼这么久才提醒，只管这一次 */
  snooze(minutes, streakSec) {
    this.base = Number.isFinite(streakSec) && streakSec > 0 ? streakSec : 0;
    this.override = clampRemindMinutes(minutes);
  }
}

if (typeof module !== 'undefined') module.exports = { SlackReminder, clampRemindMinutes, remindOptions, REMIND_DEFAULT, REMIND_OPTIONS, REMIND_MAX };
