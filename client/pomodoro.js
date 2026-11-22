// 番茄钟：专注 N 分钟 → 休息 M 分钟 → 专注 …，一直循环到手动结束。右键小狗开始。
// 纯逻辑，方便测试。计时器、气泡和弹窗在 main.js 里；休息时间怎么计时在 activity.js 的 setRest()。

const POMO_FOCUS_DEFAULT = 25; // 默认专注 25 分钟
const POMO_BREAK_DEFAULT = 5; // 默认休息 5 分钟
const POMO_FOCUS_MAX = 180;
const POMO_BREAK_MAX = 60;
const SETTLE_SEC = 30; // 休息结束后老老实实用了这么久电脑，就算已经回去专注了
const ASLEEP_MS = 5 * 60_000; // 到点了却晚了这么久才发现：电脑睡了一觉
const MAX_TICK_SEC = 10; // 两次 tick 之间最多算 10 秒

function clampMinutes(v, def, max) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n) || n < 1) return def;
  return Math.min(max, n);
}
/** 专注时长：1–180 的整数分钟，乱七八糟的输入当默认值 */
const clampFocusMinutes = (v) => clampMinutes(v, POMO_FOCUS_DEFAULT, POMO_FOCUS_MAX);
/** 休息时长：1–60 的整数分钟 */
const clampBreakMinutes = (v) => clampMinutes(v, POMO_BREAK_DEFAULT, POMO_BREAK_MAX);

class Pomodoro {
  constructor() {
    this.stop();
  }

  stop() {
    this.phase = null; // 'focus' 专注 | 'break' 休息 | null 没开
    this.minutes = 0; // 现在这一段总共多少分钟
    this.endsAt = 0; // 现在这一段什么时候结束（毫秒时间戳）
    this.done = 0; // 这次开着期间完整专注完了几个番茄
    this.nudge = null; // 休息刚结束，还没确认回去专注：'armed' 盯着 | 'shown' 已经弹过窗 | null 不用管
    this.backSec = 0; // 休息结束后已经老实用了多久电脑
    this.lastAt = 0;
  }

  /** @param {{focusMinutes?: number, breakMinutes?: number}} settings 设置里的时长；改了设置从下一段开始生效 */
  start(now, settings) {
    this.stop();
    this.lastAt = now;
    this._enter('focus', now, settings);
  }

  _enter(phase, now, settings) {
    this.phase = phase;
    this.minutes = phase === 'focus' ? clampFocusMinutes(settings?.focusMinutes) : clampBreakMinutes(settings?.breakMinutes);
    this.endsAt = now + this.minutes * 60_000;
    this.nudge = null;
    this.backSec = 0;
  }

  /** 现在这一段还剩多少秒 */
  leftSec(now) {
    return this.phase ? Math.max(0, Math.ceil((this.endsAt - now) / 1000)) : 0;
  }

  /** 手动跳到下一段（「现在就休息」「跳过休息」）。自己点的，不算完成一个番茄，也不用盯着有没有回去专注 */
  skip(now, settings) {
    if (!this.phase) return null;
    this._enter(this.phase === 'focus' ? 'break' : 'focus', now, settings);
    return this.phase;
  }

  /**
   * 每秒调一次。
   * @param {number} now
   * @param {{category?: string|null, lastInputAt?: number}} activity 现在在干什么（study / slack / away …）、最近一次动键鼠的时间
   * @returns {string[]} 这一下发生了什么：
   *   'break'   专注结束，开始休息
   *   'focus'   休息结束，开始专注
   *   'nudge'   休息结束了却在摸鱼，该弹窗了（一次休息最多一次）
   *   'settled' 弹过窗之后回去专注了，窗口可以收起来
   *   'idle'    一整轮没碰电脑（或者电脑睡了一觉），番茄钟自己停了
   */
  tick(now, activity = {}, settings = {}) {
    if (!this.phase) return [];
    const dt = Math.min(Math.max(0, (now - this.lastAt) / 1000), MAX_TICK_SEC);
    this.lastAt = now;
    const events = [];

    if (now >= this.endsAt) {
      const cycleMs = (clampFocusMinutes(settings.focusMinutes) + clampBreakMinutes(settings.breakMinutes)) * 60_000;
      const asleep = now - this.endsAt >= ASLEEP_MS;
      const gone = activity.lastInputAt > 0 && now - activity.lastInputAt >= cycleMs;
      if (asleep || gone) {
        // 人不在：不停下来的话会空转一整晚，勾了「休息算学习」还会一直往上加时间
        this.stop();
        return ['idle'];
      }
      if (this.phase === 'focus') {
        this.done += 1;
        this._enter('break', now, settings);
        events.push('break');
      } else {
        this._enter('focus', now, settings);
        this.nudge = 'armed';
        events.push('focus');
      }
    }

    // 休息结束后盯一会儿：在摸鱼就弹窗（离开电脑的话等回来再看）；老实用了一会儿电脑就不盯了
    if (this.phase === 'focus' && this.nudge) {
      if (activity.category === 'slack') {
        this.backSec = 0;
        if (this.nudge === 'armed') {
          this.nudge = 'shown';
          events.push('nudge');
        }
      } else if (activity.category === 'study') {
        this.backSec += dt;
        if (this.backSec >= SETTLE_SEC) {
          if (this.nudge === 'shown') events.push('settled');
          this.nudge = null;
        }
      }
    }
    return events;
  }
}

module.exports = { Pomodoro, clampFocusMinutes, clampBreakMinutes, POMO_FOCUS_DEFAULT, POMO_BREAK_DEFAULT, POMO_FOCUS_MAX, POMO_BREAK_MAX, SETTLE_SEC };
