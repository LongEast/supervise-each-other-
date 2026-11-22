// 每天一份记录（学习 / 摸鱼时长、按小时的分布、花在哪些应用和网站上、完成了几个番茄、搭子那天的时长），
// 存在 userData/history/YYYY-MM-DD.json；面板的「统计」页从这里读。
// 今天的那一份在 activity.js 的 tracker 手里（today.json），跨天时才归档到这里。
// 不依赖 Electron，方便测试。
const fs = require('fs');
const path = require('path');

const NAME_MAX = 64;
const FRIEND_TOP = 30; // 搭子的明细最多留这么多项（和对方发来的上限一致）
const zeros = () => Array(24).fill(0);
const num = (x) => (Number.isFinite(x) && x > 0 ? x : 0);
const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);

const emptyDay = (date) => ({
  date,
  sec: { study: 0, slack: 0, neutral: 0 },
  by: { study: {}, slack: {} }, // 'a:进程名' / 'd:域名' → 秒
  hours: { study: zeros(), slack: zeros() }, // 每个小时里学习 / 摸鱼了多少秒
  pomo: { count: 0, focusMin: 0 }, // 完整专注完的番茄数、这些番茄一共多少分钟
  friend: null, // 搭子这一天最后发来的时长：{ name, sec: {study, slack}, by: {study, slack} }
});

// ---------- 清洗：文件可能是旧版本存的，搭子那部分是对方发来的 ----------
function cleanBy(by, limit = Infinity) {
  const out = {};
  const entries = Object.entries(by && typeof by === 'object' ? by : {})
    .filter(([k, v]) => /^[ad]:./.test(k) && num(v) > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit);
  for (const [k, v] of entries) out[k.slice(0, 2 + NAME_MAX)] = num(v);
  return out;
}
const cleanHours = (h) => zeros().map((_, i) => num(Array.isArray(h) ? h[i] : 0));

function cleanFriend(f) {
  if (!f || typeof f !== 'object' || typeof f.name !== 'string' || !f.name) return null;
  return {
    name: f.name.slice(0, 24),
    sec: { study: num(f.sec?.study), slack: num(f.sec?.slack) },
    by: { study: cleanBy(f.by?.study, FRIEND_TOP), slack: cleanBy(f.by?.slack, FRIEND_TOP) },
  };
}

/** 把读到的记录补全成现在的格式；日期不对返回 null */
function cleanDay(raw) {
  if (!raw || typeof raw !== 'object' || !isDate(raw.date)) return null;
  return {
    date: raw.date,
    sec: { study: num(raw.sec?.study), slack: num(raw.sec?.slack), neutral: num(raw.sec?.neutral) },
    by: { study: cleanBy(raw.by?.study), slack: cleanBy(raw.by?.slack) },
    hours: { study: cleanHours(raw.hours?.study), slack: cleanHours(raw.hours?.slack) },
    pomo: { count: Math.floor(num(raw.pomo?.count)), focusMin: Math.floor(num(raw.pomo?.focusMin)) },
    friend: cleanFriend(raw.friend),
  };
}

/** 对方状态里的 todaySec + breakdown（[{domain|app, sec}]）→ 记录里 friend 的样子 */
function friendSnapshot(name, todaySec, breakdown) {
  const toBy = (list) => {
    const by = {};
    for (const e of Array.isArray(list) ? list.slice(0, FRIEND_TOP) : []) {
      const key = typeof e?.domain === 'string' && e.domain ? `d:${e.domain}` : typeof e?.app === 'string' && e.app ? `a:${e.app}` : null;
      if (key && num(e.sec) > 0) by[key] = num(e.sec);
    }
    return by;
  };
  return cleanFriend({ name, sec: todaySec, by: { study: toBy(breakdown?.study), slack: toBy(breakdown?.slack) } });
}

const hasData = (d) => !!d && (d.sec.study > 0 || d.sec.slack > 0 || d.sec.neutral > 0 || d.pomo.count > 0 || !!d.friend);

// ---------- 存储 ----------
class HistoryStore {
  constructor(dir) {
    this.dir = dir;
  }

  _file(date) {
    return path.join(this.dir, `${date}.json`);
  }

  /** 没有这一天的记录返回 null */
  load(date) {
    if (!isDate(date)) return null;
    try {
      return cleanDay(JSON.parse(fs.readFileSync(this._file(date), 'utf8')));
    } catch {
      return null;
    }
  }

  /** 什么都没记到的一天不存 */
  save(day) {
    const d = cleanDay(day);
    if (!hasData(d)) return false;
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      fs.writeFileSync(this._file(d.date), JSON.stringify(d));
      return true;
    } catch (e) {
      console.warn('[history] 保存失败', e.message);
      return false;
    }
  }
}

// ---------- 日期 ----------
const fmtDate = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
function shiftDate(date, n) {
  const [y, m, d] = date.split('-').map(Number);
  return fmtDate(new Date(y, m - 1, d + n));
}
/** 这一天所在那周的周一 */
function weekStart(date) {
  const [y, m, d] = date.split('-').map(Number);
  const dow = new Date(y, m - 1, d).getDay(); // 0 = 周日
  return shiftDate(date, -((dow + 6) % 7));
}

// ---------- 汇总：给「统计」页用 ----------
const round = (n) => Math.round(num(n));
/** 明细按时间从长到短排：[{ domain | app, sec }] */
function topList(by, limit = Infinity) {
  return Object.entries(by || {})
    .map(([k, sec]) => ({ [k.startsWith('d:') ? 'domain' : 'app']: k.slice(2), sec: round(sec) }))
    .filter((e) => e.sec > 0)
    .sort((a, b) => b.sec - a.sec)
    .slice(0, limit);
}
function mergeBy(list) {
  const out = {};
  for (const by of list) for (const [k, v] of Object.entries(by || {})) out[k] = (out[k] || 0) + num(v);
  return out;
}
/** 计划进度；没写计划返回 null */
function planProgress(j) {
  if (!j || !j.planAt || !Array.isArray(j.items)) return null;
  return { total: j.items.length, done: j.items.filter((it) => it.done).length, reviewed: !!j.reviewAt };
}
const planItems = (j) => (planProgress(j) ? j.items.map((it) => ({ text: String(it.text || ''), done: !!it.done })) : []);

/**
 * 某一天的统计。
 * @param {{date:string, today:string, loadRecord:(date:string)=>any, loadJournal:(date:string)=>{me:any, friend:any}}} o
 *   loadRecord 返回那一天的记录（没有返回 null）；loadJournal 返回那一天的计划存档
 */
function buildDay({ date, today, loadRecord, loadJournal }) {
  const rec = cleanDay(loadRecord(date));
  const prev = cleanDay(loadRecord(shiftDate(date, -1)));
  const j = loadJournal(date) || {};
  const f = rec?.friend;
  return {
    date,
    today,
    me: {
      recorded: !!rec, // 这一天有没有时长记录（装上这个版本之前的日子没有）
      sec: { study: round(rec?.sec.study), slack: round(rec?.sec.slack) },
      hours: { study: (rec?.hours.study || zeros()).map(round), slack: (rec?.hours.slack || zeros()).map(round) },
      top: { study: topList(rec?.by.study), slack: topList(rec?.by.slack) },
      pomo: rec ? { ...rec.pomo } : { count: 0, focusMin: 0 },
      plan: planProgress(j.me),
      items: planItems(j.me),
    },
    // 和前一天比：前一天没有记录就没得比
    prev: prev ? { study: round(prev.sec.study), slack: round(prev.sec.slack) } : null,
    friend:
      f || j.friend
        ? {
            name: f?.name || j.friend?.name || '',
            recorded: !!f,
            sec: { study: round(f?.sec.study), slack: round(f?.sec.slack) },
            top: { study: topList(f?.by.study), slack: topList(f?.by.slack) },
            plan: planProgress(j.friend?.journal),
            items: planItems(j.friend?.journal),
          }
        : null,
  };
}

/** date 所在那一周（周一到周日）的统计，外加上一周的总时长用来比较 */
function buildWeek({ date, today, loadRecord, loadJournal, topN = 4 }) {
  const from = weekStart(date);
  const dates = Array.from({ length: 7 }, (_, i) => shiftDate(from, i));
  const recs = dates.map((d) => (d > today ? null : cleanDay(loadRecord(d))));
  const journals = dates.map((d) => (d > today ? {} : loadJournal(d) || {}));
  const sum = (list, pick) => list.reduce((s, x) => s + num(x ? pick(x) : 0), 0);
  const planTotals = (plans) => {
    const got = plans.filter(Boolean);
    return { done: sum(got, (p) => p.done), total: sum(got, (p) => p.total), reviewedDays: got.filter((p) => p.reviewed).length, days: got.length };
  };
  const prevRecs = Array.from({ length: 7 }, (_, i) => cleanDay(loadRecord(shiftDate(from, i - 7))));
  const mePlans = journals.map((j) => planProgress(j.me));
  const friendPlans = journals.map((j) => planProgress(j.friend?.journal));
  const friendRecs = recs.map((r) => r?.friend || null);
  const friendName = [...friendRecs].reverse().find(Boolean)?.name || [...journals].reverse().find((j) => j.friend)?.friend.name || '';

  return {
    from,
    to: dates[6],
    today,
    days: dates.map((d, i) => ({
      date: d,
      future: d > today,
      me: {
        recorded: !!recs[i],
        sec: { study: round(recs[i]?.sec.study), slack: round(recs[i]?.sec.slack) },
        pomo: recs[i]?.pomo.count || 0,
        plan: mePlans[i],
      },
      friend: { recorded: !!friendRecs[i], sec: { study: round(friendRecs[i]?.sec.study), slack: round(friendRecs[i]?.sec.slack) }, plan: friendPlans[i] },
    })),
    me: {
      recordedDays: recs.filter(Boolean).length,
      sec: { study: round(sum(recs, (r) => r.sec.study)), slack: round(sum(recs, (r) => r.sec.slack)) },
      pomo: { count: sum(recs, (r) => r.pomo.count), focusMin: sum(recs, (r) => r.pomo.focusMin) },
      plan: planTotals(mePlans),
      top: { study: topList(mergeBy(recs.map((r) => r?.by.study)), topN), slack: topList(mergeBy(recs.map((r) => r?.by.slack)), topN) },
    },
    // 上一周一天记录都没有（刚装上）就没得比
    prev: prevRecs.some(Boolean) ? { study: round(sum(prevRecs, (r) => r.sec.study)), slack: round(sum(prevRecs, (r) => r.sec.slack)) } : null,
    friend: friendName
      ? {
          name: friendName,
          recordedDays: friendRecs.filter(Boolean).length,
          sec: { study: round(sum(friendRecs, (f) => f.sec.study)), slack: round(sum(friendRecs, (f) => f.sec.slack)) },
          plan: planTotals(friendPlans),
          top: { study: topList(mergeBy(friendRecs.map((f) => f?.by.study)), topN), slack: topList(mergeBy(friendRecs.map((f) => f?.by.slack)), topN) },
        }
      : null,
  };
}

module.exports = { HistoryStore, emptyDay, cleanDay, friendSnapshot, hasData, shiftDate, weekStart, topList, planProgress, buildDay, buildWeek };
