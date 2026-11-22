// 番茄钟：专注 N 分钟 → 休息 M 分钟 → 等你点「重新开始」→ 专注 …，一直循环到手动结束。右键小狗开始。
// 休息结束后不会自己开始下一轮：停在 wait，弹窗里点「重新开始番茄钟」才接着计时（也可以「再休息一会」或者结束）。
// 纯逻辑，方便测试。计时器、气泡和弹窗在 main.js 里；休息时间怎么计时在 activity.js 的 setRest()。

const POMO_FOCUS_DEFAULT = 25; // 默认专注 25 分钟
const POMO_BREAK_DEFAULT = 5; // 默认休息 5 分钟
const POMO_FOCUS_MAX = 180;
const POMO_BREAK_MAX = 60;
const ASLEEP_MS = 5 * 60_000; // 到点了却晚了这么久才发现（或者两次 tick 隔了这么久）：电脑睡了一觉

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
    this.phase = null; // 'focus' 专注 | 'break' 休息 | 'wait' 休息结束了，等着点「重新开始」 | null 没开
    this.minutes = 0; // 现在这一段总共多少分钟（wait 时是 0）
    this.endsAt = 0; // 现在这一段什么时候结束（毫秒时间戳；wait 时是 0，没有倒计时）
    this.done = 0; // 这次开着期间完整专注完了几个番茄
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
  }

  /** 现在这一段还剩多少秒（wait 时是 0） */
  leftSec(now) {
    return this.endsAt ? Math.max(0, Math.ceil((this.endsAt - now) / 1000)) : 0;
  }

  /** 手动跳到下一段（「现在就休息」「跳过休息，开始专注」）。自己点的，不算完成一个番茄，也不用再确认一次 */
  skip(now, settings) {
    if (!this.phase) return null;
    this._enter(this.phase === 'focus' ? 'break' : 'focus', now, settings);
    return this.phase;
  }

  /** 休息结束后点了「重新开始番茄钟」：新一轮专注从现在算起。不在 wait 时返回 null */
  resume(now, settings) {
    if (this.phase !== 'wait') return null;
    this._enter('focus', now, settings);
    return this.phase;
  }

  /** 休息结束后点了「再休息一会」：按设置里的休息时长再休息一段，结束后还是等着点。不在 wait 时返回 null */
  restMore(now, settings) {
    if (this.phase !== 'wait') return null;
    this._enter('break', now, settings);
    return this.phase;
  }

  /**
   * 每秒调一次。
   * @param {number} now
   * @param {{lastInputAt?: number}} activity 最近一次动键鼠的时间
   * @returns {string[]} 这一下发生了什么：
   *   'break'   专注结束，开始休息
   *   'wait'    休息结束，该弹窗问要不要开始下一轮了（点了才接着计时）
   *   'idle'    一整轮没碰电脑（或者电脑睡了一觉），番茄钟自己停了
   */
  tick(now, activity = {}, settings = {}) {
    if (!this.phase) return [];
    const gap = now - this.lastAt;
    this.lastAt = now;
    const cycleMs = (clampFocusMinutes(settings.focusMinutes) + clampBreakMinutes(settings.breakMinutes)) * 60_000;
    const gone = activity.lastInputAt > 0 && now - activity.lastInputAt >= cycleMs;

    if (this.phase === 'wait') {
      // 弹窗一直没人点：人走了或者电脑睡了就停掉，不然会一直挂着
      if (gone || gap >= ASLEEP_MS) {
        this.stop();
        return ['idle'];
      }
      return [];
    }

    if (now < this.endsAt) return [];
    if (gone || now - this.endsAt >= ASLEEP_MS) {
      // 人不在：不停下来的话会空转一整晚，勾了「休息算学习」还会一直往上加时间
      this.stop();
      return ['idle'];
    }
    if (this.phase === 'focus') {
      this.done += 1;
      this._enter('break', now, settings);
      return ['break'];
    }
    this.phase = 'wait';
    this.minutes = 0;
    this.endsAt = 0;
    return ['wait'];
  }
}

module.exports = { Pomodoro, clampFocusMinutes, clampBreakMinutes, POMO_FOCUS_DEFAULT, POMO_BREAK_DEFAULT, POMO_FOCUS_MAX, POMO_BREAK_MAX };
