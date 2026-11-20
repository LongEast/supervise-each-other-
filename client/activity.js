// 采集本机活动 → 分类 → 累计今日时长 → 产出要分享给对方的状态
const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { classify, isBrowser } = require('./classifier');

const MAX_TICK_SEC = 10; // 睡眠/卡顿时最多算 10 秒，避免一下子加很多
const EXT_FRESH_MS = 90_000; // 插件每 30 秒心跳一次；超过 90 秒没消息就当作插件不在了
const ACTIVE_IDLE_MS = 60_000; // 一分钟内动过键鼠就算「正在用电脑」
const BREAKDOWN_TOP = 8; // 明细里每类最多列几项（会跟着状态发给对方，不能太长）
const BREAKDOWN_NAME_MAX = 64;

const emptyToday = (date) => ({ date, sec: { study: 0, slack: 0, neutral: 0 }, by: { study: {}, slack: {} } });

// 进程名 → 浏览器插件上报时用的 key
function browserKey(proc) {
  const p = String(proc || '').toLowerCase();
  if (p === 'msedge') return 'edge';
  if (p === 'chrome' || p === 'brave' || p === 'vivaldi' || p === 'opera' || p === 'arc') return 'chrome';
  return p;
}

/** 解析 win-activity.ps1 输出的一行；坏行返回 null */
function parseSampleLine(line) {
  try {
    const s = JSON.parse(line);
    const b64 = (v) => (v ? Buffer.from(String(v), 'base64').toString('utf8') : '');
    return { proc: s.proc64 ? b64(s.proc64) : String(s.proc || ''), title: b64(s.title64), idleMs: Number(s.idleMs) || 0 };
  } catch {
    return null; // 忽略坏行
  }
}

function localDate(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

class ActivityTracker extends EventEmitter {
  /**
   * @param {{dataDir:string, getRules:()=>any, getSettings:()=>{idleMinutes:number}, selfProcNames?:string[]}} opts
   */
  constructor(opts) {
    super();
    this.dataDir = opts.dataDir;
    this.getRules = opts.getRules;
    this.getSettings = opts.getSettings;
    this.selfProcNames = new Set((opts.selfProcNames || []).map((s) => s.toLowerCase()));
    this.extTabs = {}; // { chrome: {domain, ts}, edge: {...} }
    this.paused = false;
    this.current = { category: 'neutral', app: '', domain: null };
    this.lastTickAt = null;
    this.lastInputAt = 0; // 最近一次确认用户在用电脑的时间（用来决定要不要弹今日计划）
    this.slackStreakSec = 0;
    this.today = this._loadToday();
    this.child = null;
    this._stopped = false;
    this._saveTimer = setInterval(() => this._saveToday(), 30_000);
  }

  // ---------- 采集 ----------
  start() {
    if (process.platform === 'win32') return this._startWindows();
    if (process.env.BUDDY_FAKE_ACTIVITY) return this._startFake();
    console.warn('[activity] 非 Windows 平台，未启动采集（可设置 BUDDY_FAKE_ACTIVITY=1 演示）');
  }

  _startWindows() {
    // 打包后 ps1 位于 asar 内，PowerShell 读不到，所以先复制到临时目录
    const src = path.join(__dirname, 'win-activity.ps1');
    const dst = path.join(os.tmpdir(), 'buddy-pet-activity.ps1');
    fs.writeFileSync(dst, fs.readFileSync(src));
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', dst, '2000'],
      { windowsHide: true }
    );
    this.child = child;
    readline.createInterface({ input: child.stdout }).on('line', (line) => {
      const s = parseSampleLine(line);
      if (s) this.onSample(s);
    });
    child.stderr.on('data', (d) => console.warn('[activity:ps]', d.toString().trim()));
    child.on('error', (e) => console.warn('[activity] 启动 PowerShell 失败', e.message));
    child.on('exit', (code) => {
      this.child = null;
      if (!this._stopped) {
        console.warn('[activity] PowerShell 退出，3 秒后重启', code);
        setTimeout(() => !this._stopped && this._startWindows(), 3000);
      }
    });
  }

  _startFake() {
    const script = [
      { proc: 'Code', title: 'main.py - Visual Studio Code', idleMs: 500 },
      { proc: 'chrome', title: 'Claude', idleMs: 800, domain: 'claude.ai' },
      { proc: 'chrome', title: '哔哩哔哩 (゜-゜)つロ 干杯~-bilibili', idleMs: 1000, domain: 'www.bilibili.com' },
    ];
    let i = 0;
    this._fakeTimer = setInterval(() => {
      const s = script[Math.floor(i++ / 5) % script.length];
      if (s.domain) this.setBrowserTab({ browser: 'chrome', domain: s.domain });
      this.onSample(s);
    }, 2000);
  }

  stop() {
    this._stopped = true;
    clearInterval(this._saveTimer);
    clearInterval(this._fakeTimer);
    if (this.child) this.child.kill();
    this._saveToday();
  }

  /** 浏览器插件上报当前标签页 */
  setBrowserTab({ browser, domain }) {
    const key = browser === 'edge' ? 'edge' : 'chrome';
    this.extTabs[key] = { domain: domain || null, ts: Date.now() };
    this.lastExtAt = Date.now();
  }

  extConnected() {
    return !!this.lastExtAt && Date.now() - this.lastExtAt < 60_000;
  }

  setPaused(p) {
    this.paused = !!p;
    this.slackStreakSec = 0;
    this.emit('change', this.getStatus());
  }

  // ---------- 核心逻辑 ----------
  onSample(sample, now = Date.now()) {
    this._rollDay();
    if ((sample.idleMs || 0) < ACTIVE_IDLE_MS) this.lastInputAt = now;
    const dt = this.lastTickAt ? Math.min((now - this.lastTickAt) / 1000, MAX_TICK_SEC) : 0;
    this.lastTickAt = now;

    // 先把这段时间记到「上一个」状态上
    if (!this.paused && dt > 0) {
      const c = this.current.category;
      if (c === 'study' || c === 'slack' || c === 'neutral') this.today.sec[c] += dt;
      else if (c === 'private') this.today.sec.neutral += dt;
      if (c === 'slack') this.slackStreakSec += dt;
      // 明细：学习 / 摸鱼的时间分别记到具体的网站（域名）或应用上。隐私应用不在这两类里，不会被记下来
      if (c === 'study' || c === 'slack') {
        const key = this.current.domain ? `d:${this.current.domain}` : this.current.app ? `a:${this.current.app}` : null;
        if (key) this.today.by[c][key] = (this.today.by[c][key] || 0) + dt;
      }
    }

    const proc = String(sample.proc || '');
    // 前台是小狗自己（比如刚点了它）→ 沿用上一个状态
    if (!proc || this.selfProcNames.has(proc.toLowerCase())) return;

    let domain = null;
    if (isBrowser(proc)) {
      const tab = this.extTabs[browserKey(proc)];
      if (tab && now - tab.ts < EXT_FRESH_MS) domain = tab.domain;
    }

    let category = classify({ proc, title: sample.title, domain }, this.getRules());

    // 空闲判定：看视频时常常不动鼠标，所以摸鱼类网站放宽到 20 分钟
    const idleMin = (sample.idleMs || 0) / 60_000;
    const idleLimit = this.getSettings().idleMinutes || 5;
    if ((category !== 'slack' && idleMin >= idleLimit) || idleMin >= 20) category = 'away';

    if (category === 'study' || category === 'away') this.slackStreakSec = 0;

    const next = {
      category,
      app: category === 'private' ? '' : proc,
      domain: category === 'private' ? null : domain ? domain.replace(/^www\./, '') : null,
    };
    const changed =
      next.category !== this.current.category || next.app !== this.current.app || next.domain !== this.current.domain;
    this.current = next;
    this.emit('tick', this.getStatus());
    if (changed) this.emit('change', this.getStatus());
  }

  /** 今天累计的学习 / 摸鱼 / 其他秒数。暂停分享时也拿得到：只在本机显示给自己看 */
  todaySec() {
    const r = (n) => Math.round(n);
    return { study: r(this.today.sec.study), slack: r(this.today.sec.slack), neutral: r(this.today.sec.neutral) };
  }

  /**
   * 今天的学习 / 摸鱼时间都花在了哪：每类取时间最长的几项，只有应用名和域名（没有网址和窗口标题）。
   * @returns {{study: {domain?:string, app?:string, sec:number}[], slack: {domain?:string, app?:string, sec:number}[]}}
   */
  breakdown(limit = BREAKDOWN_TOP) {
    const top = (by) =>
      Object.entries(by)
        .map(([k, sec]) => ({ [k.startsWith('d:') ? 'domain' : 'app']: k.slice(2, 2 + BREAKDOWN_NAME_MAX), sec: Math.round(sec) }))
        .filter((e) => e.sec > 0)
        .sort((a, b) => b.sec - a.sec)
        .slice(0, limit);
    return { study: top(this.today.by.study), slack: top(this.today.by.slack) };
  }

  /** 发给对方的状态（不含窗口标题） */
  getStatus() {
    if (this.paused) return { paused: true };
    return {
      paused: false,
      category: this.current.category,
      app: this.current.app,
      domain: this.current.domain,
      todaySec: this.todaySec(),
      breakdown: this.breakdown(),
      slackStreakSec: Math.round(this.slackStreakSec),
    };
  }

  // ---------- 今日统计持久化 ----------
  _file() {
    return path.join(this.dataDir, 'today.json');
  }

  _loadToday() {
    try {
      const t = JSON.parse(fs.readFileSync(this._file(), 'utf8'));
      // 旧版本存的文件里没有 by（明细），补上空的
      if (t.date === localDate()) return { ...t, by: { study: { ...t.by?.study }, slack: { ...t.by?.slack } } };
    } catch {
      /* 没有就新建 */
    }
    return emptyToday(localDate());
  }

  _saveToday() {
    try {
      fs.mkdirSync(this.dataDir, { recursive: true });
      fs.writeFileSync(this._file(), JSON.stringify(this.today));
    } catch (e) {
      console.warn('[activity] 保存失败', e.message);
    }
  }

  _rollDay() {
    const d = localDate();
    if (this.today.date !== d) {
      this.today = emptyToday(d);
      this.slackStreakSec = 0;
    }
  }
}

module.exports = { ActivityTracker, localDate, parseSampleLine };
