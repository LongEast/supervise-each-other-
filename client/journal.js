// 早上计划 / 晚上复盘：字段清洗、本机存储、提醒时机、和对方同步。
// 不依赖 Electron，方便测试；窗口和托盘在 main.js 里。
const fs = require('fs');
const path = require('path');
const { localDate } = require('./activity');

const MAX_ITEMS = 8;
const MAX_SNOOZES = 3;
const SNOOZE_MS = 15 * 60_000;
const EARLIEST_ACTIVE_MIN = 5 * 60; // 05:00 之前不会因为「在用电脑」就弹计划（熬夜的人还没睡）
const LIMITS = { text: 60, reason: 120, improve: 200 }; // 和 server.js 保持一致

// ---------- 清洗 ----------
const cleanText = (s, max) =>
  String(s ?? '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .trim()
    .slice(0, max);
const cleanTs = (n) => (Number.isFinite(n) && n > 0 ? Math.floor(n) : null);
const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);

/** 只保留认识的字段，条数和长度都有上限；日期格式不对返回 null */
function cleanJournal(j) {
  if (!j || typeof j !== 'object' || !isDate(j.date)) return null;
  const items = (Array.isArray(j.items) ? j.items : [])
    .slice(0, MAX_ITEMS)
    .map((it) => ({ text: cleanText(it?.text, LIMITS.text), done: !!it?.done, reason: cleanText(it?.reason, LIMITS.reason) }))
    .filter((it) => it.text);
  return { date: j.date, items, planAt: cleanTs(j.planAt), reviewAt: cleanTs(j.reviewAt), improve: cleanText(j.improve, LIMITS.improve) };
}

const emptyJournal = (date) => ({ date, items: [], planAt: null, reviewAt: null, improve: '' });

/** 给卡片 / 托盘 / 历史用的进度；还没写计划返回 null */
function progress(j) {
  if (!j || !j.planAt) return null;
  return { total: j.items.length, done: j.items.filter((it) => it.done).length, reviewed: !!j.reviewAt };
}

// ---------- 日期和时间 ----------
function addDays(date, n) {
  const [y, m, d] = date.split('-').map(Number);
  return localDate(new Date(y, m - 1, d + n));
}
function dayDiff(a, b) {
  const utc = (s) => Date.UTC(...s.split('-').map((v, i) => (i === 1 ? Number(v) - 1 : Number(v))));
  return Math.round((utc(a) - utc(b)) / 86_400_000);
}
/** 'HH:MM' → 当天第几分钟；格式不对返回 NaN */
function toMinutes(hhmm) {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(hhmm || ''));
  return m ? Number(m[1]) * 60 + Number(m[2]) : NaN;
}

// ---------- 本机存储：userData/journal/YYYY-MM-DD.json ----------
// 每天一个文件：{ date, me: 自己的, friend: { name, journal: 对方的副本 }, prompt: 当天的提醒状态（只在本机用） }
class JournalStore {
  constructor(dir) {
    this.dir = dir;
  }

  _file(date) {
    return path.join(this.dir, `${date}.json`);
  }

  load(date) {
    const day = { date, me: null, friend: null, prompt: {} };
    try {
      const f = JSON.parse(fs.readFileSync(this._file(date), 'utf8'));
      day.me = cleanJournal(f.me);
      const fj = cleanJournal(f.friend?.journal);
      if (fj) day.friend = { name: cleanText(f.friend.name, 24), journal: fj };
      if (f.prompt && typeof f.prompt === 'object') day.prompt = f.prompt;
    } catch {
      /* 没有就是空的一天 */
    }
    return day;
  }

  save(day) {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      fs.writeFileSync(this._file(day.date), JSON.stringify(day, null, 2));
    } catch (e) {
      console.warn('[journal] 保存失败', e.message);
    }
  }

  /** 最近 n 天（含今天），新的在前 */
  recent(n, today = localDate()) {
    return Array.from({ length: n }, (_, i) => {
      const { date, me, friend } = this.load(addDays(today, -i));
      return { date, me, friend };
    });
  }
}

// ---------- 提醒时机 ----------
/**
 * 现在该不该弹窗。纯函数。
 * 计划：到了计划时间；或者 05:00 之后第一次发现用户在用电脑。写过了就不再弹。
 * 复盘：到了复盘时间，且今天写过计划、还没复盘。只弹一次。
 * @param {Date} now
 * @param {{planTime:string, reviewTime:string}} cfg
 * @param {{me:any, prompt:any}} day  当天的存档
 * @param {boolean} active  用户此刻是否在用电脑
 * @returns {'plan'|'review'|null}
 */
function duePrompt(now, cfg, day, active) {
  const mins = now.getHours() * 60 + now.getMinutes();
  const p = day.prompt || {};
  if (!day.me?.planAt) {
    if (p.snoozeUntil) return now.getTime() >= p.snoozeUntil ? 'plan' : null;
    if (!p.planTimeFired && mins >= toMinutes(cfg.planTime)) return 'plan';
    if (!p.planTimeFired && !p.activeFired && active && mins >= EARLIEST_ACTIVE_MIN) return 'plan';
    return null;
  }
  if (!day.me.reviewAt && !p.reviewFired && mins >= toMinutes(cfg.reviewTime)) return 'review';
  return null;
}

/** 弹窗之后记一笔，避免重复弹 */
function markPrompted(day, kind, now, cfg) {
  const p = (day.prompt = day.prompt || {});
  if (kind === 'review') {
    p.reviewFired = true;
    return;
  }
  delete p.snoozeUntil;
  p.activeFired = true;
  if (now.getHours() * 60 + now.getMinutes() >= toMinutes(cfg.planTime)) p.planTimeFired = true;
}

/** 「15 分钟后再提醒」，最多 MAX_SNOOZES 次。返回是否成功 */
function snooze(day, now = Date.now()) {
  const p = (day.prompt = day.prompt || {});
  if ((p.snoozes || 0) >= MAX_SNOOZES) return false;
  p.snoozes = (p.snoozes || 0) + 1;
  p.snoozeUntil = now + SNOOZE_MS;
  return true;
}
const snoozesLeft = (day) => Math.max(0, MAX_SNOOZES - (day.prompt?.snoozes || 0));

// ---------- 和对方同步 ----------
class JournalSync {
  /**
   * @param {{store:JournalStore, send:(msg:any)=>boolean, isPaused:()=>boolean, today?:()=>string}} o
   * send 返回 false 表示没发出去（没连上）；isPaused 为 true 时不发（暂停分享期间对方看不到任何变化）
   */
  constructor(o) {
    this.store = o.store;
    this.send = o.send;
    this.isPaused = o.isPaused;
    this.today = o.today || (() => localDate());
    this.date = this.today();
    this.pending = new Set(); // 改了但还没发出去的日期
    this.friend = this.store.load(this.date).friend; // 对方最新的一份 { name, journal }
  }

  mine(date = this.today()) {
    return this.store.load(date).me || emptyJournal(date);
  }

  _send(date) {
    if (this.isPaused() || !this.send({ type: 'journal', journal: this.mine(date) })) {
      this.pending.add(date);
      return false;
    }
    this.pending.delete(date);
    return true;
  }

  /** 重连成功、恢复分享、跨天之后调用：重发今天的，并补发之前没发出去的 */
  flush() {
    for (const date of new Set([...this.pending, this.today()])) this._send(date);
  }

  /** 定时调用；跨天了返回 true（并把新一天的空计划发给对方，对方的卡片会变回「还没写」） */
  tick() {
    const d = this.today();
    if (d === this.date) return false;
    this.date = d;
    this.flush();
    return true;
  }

  /** 「今日复盘」该复盘哪一天：昨天写了计划却没复盘、今天又还没写新计划时，先补昨天的 */
  reviewDate() {
    const today = this.today();
    const yesterday = addDays(today, -1);
    const y = this.store.load(yesterday).me;
    return y?.planAt && !y.reviewAt && !this.store.load(today).me?.planAt ? yesterday : today;
  }

  /**
   * 保存自己的计划或复盘。planAt / reviewAt 由这里盖时间戳，不信任界面传来的值。
   * @param {'plan'|'review'} kind
   * @returns {{ok:true, journal:any}|{ok:false, error:string}}
   */
  save(kind, input, now = Date.now()) {
    const today = this.today();
    // 只允许改今天的；过了零点还可以补交昨天的复盘
    const date = kind === 'review' && input?.date === addDays(today, -1) ? input.date : today;
    const j = cleanJournal({ ...input, date });
    if (!j || !j.items.length) return { ok: false, error: '至少要有一条要做的事' };
    const day = this.store.load(date);
    const prev = day.me;
    j.planAt = prev?.planAt || now;
    if (kind === 'review') {
      if (j.items.some((it) => !it.done && !it.reason)) return { ok: false, error: '没完成的事要写一下原因' };
      j.reviewAt = now;
    } else {
      j.reviewAt = prev?.reviewAt || null;
      j.improve = prev?.improve || '';
    }
    for (const it of j.items) if (it.done) it.reason = '';
    day.me = j;
    this.store.save(day);
    this._send(date);
    return { ok: true, journal: j };
  }

  /**
   * 收到对方的 journal：存一份本机副本。
   * @returns {'plan'|'review'|null} 对方刚写好了计划 / 复盘（用来让小狗冒气泡）
   */
  onFriend(name, raw) {
    const j = cleanJournal(raw);
    if (!j || !name) return null;
    const day = this.store.load(j.date);
    const prev = day.friend && day.friend.name === name ? day.friend.journal : null;
    day.friend = { name, journal: j };
    this.store.save(day);
    if (!this.friend || this.friend.name !== name || j.date >= this.friend.journal.date) this.friend = { name, journal: j };
    if (Math.abs(dayDiff(j.date, this.today())) > 1) return null; // 很久以前的缓存，不提示
    if (j.reviewAt && !prev?.reviewAt) return 'review';
    if (j.planAt && !prev?.planAt) return 'plan';
    return null;
  }

  /**
   * 对方「今天」的那一份，没有返回 null。
   * 两个人可能不在同一个时区：对方在线时以对方客户端发来的最新一份为准（日期差一天也算），离线时只认和自己同一天的。
   */
  friendToday(name, online) {
    const f = this.friend;
    if (!f || f.name !== name) return null;
    const diff = Math.abs(dayDiff(f.journal.date, this.today()));
    return diff === 0 || (online && diff === 1) ? f.journal : null;
  }
}

module.exports = {
  MAX_ITEMS, MAX_SNOOZES, SNOOZE_MS, LIMITS,
  cleanJournal, emptyJournal, progress, addDays, dayDiff, toMinutes, isDate,
  JournalStore, JournalSync, duePrompt, markPrompted, snooze, snoozesLeft,
};
