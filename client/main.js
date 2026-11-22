// Buddy Pet — Electron 主进程
const { app, BrowserWindow, Tray, Menu, ipcMain, Notification, screen, nativeImage, shell, dialog } = require('electron');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { ActivityTracker, localDate } = require('./activity');
const { RelayClient } = require('./relay');
const { DEFAULT_RULES } = require('./classifier');
const { clampScale, petSize, rescaleBounds, SCALE_STEP } = require('./pet-geometry');
const { SlackReminder, clampRemindMinutes, remindOptions, REMIND_DEFAULT, REMIND_OPTIONS } = require('./reminder');
const { Pomodoro, clampFocusMinutes, clampBreakMinutes, POMO_FOCUS_DEFAULT, POMO_BREAK_DEFAULT } = require('./pomodoro');
const { JournalStore, JournalSync, duePrompt, markPrompted, snooze, snoozesLeft, progress, toMinutes, isDate, addDays } = require('./journal');

const APP_ID = 'com.buddypet.app'; // 要和 package.json 里的 build.appId 一致
const EXT_PORT = 17321;
const STATUS_HEARTBEAT_MS = 30_000;
const SLACK_IDLE_MAX = 120;
const UPDATE_CHECK_MS = 6 * 3600_000; // 小狗常常一开好几天，隔几个小时查一次更新
const RELEASES_URL = 'https://github.com/LongEast/supervise-each-other-/releases/latest'; // 要和 package.json 里的 build.publish 一致
const JOURNAL_CHECK_MS = 20_000;

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}
app.setAppUserModelId(APP_ID);

// Windows 靠「开始菜单里带 AppUserModelID 的快捷方式」认通知是谁发的。安装版由安装程序创建；
// 便携版没有，通知标题会显示成 com.buddypet.app、没有图标（Win10 上干脆不显示），所以启动时自己补一个。
function ensurePortableShortcut() {
  const exe = process.env.PORTABLE_EXECUTABLE_FILE; // electron-builder 的便携版启动器会设置这个变量
  if (process.platform !== 'win32' || !exe) return;
  const lnk = path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', `${app.getName()}.lnk`);
  try {
    let old = null;
    try {
      old = shell.readShortcutLink(lnk);
    } catch {
      /* 还没有 */
    }
    if (old && old.appUserModelId === APP_ID && fs.existsSync(old.target)) return; // 已经有能用的了（比如同时装了安装版）
    shell.writeShortcutLink(lnk, old ? 'replace' : 'create', { target: exe, appUserModelId: APP_ID, description: 'Buddy Pet' });
  } catch (e) {
    console.warn('[shortcut]', e.message);
  }
}

// ---------------- 配置 ----------------
const dataDir = app.getPath('userData');
const configFile = path.join(dataDir, 'config.json');
const DEFAULT_CONFIG = {
  serverUrl: '',
  room: '',
  secret: '',
  name: '',
  idleMinutes: 5,
  slackIdleMinutes: 20, // 摸鱼时（常常是在看视频）空闲多久才算离开
  slackRemind: true, // 连续摸鱼太久时弹窗提醒自己
  slackRemindMinutes: REMIND_DEFAULT, // 每连续摸鱼这么多分钟提醒一次
  slackRemindOptions: REMIND_OPTIONS, // 提醒窗口的下拉框里可以选的间隔（分钟）
  pomodoroFocusMinutes: POMO_FOCUS_DEFAULT, // 番茄钟：专注多少分钟
  pomodoroBreakMinutes: POMO_BREAK_DEFAULT, // 番茄钟：休息多少分钟
  pomodoroBreakCounts: false, // 番茄钟的休息时间算不算学习时间
  openAtLogin: false,
  planTime: '09:00', // 计划提醒时间
  reviewTime: '22:00', // 复盘提醒时间
  rules: DEFAULT_RULES,
  petPos: null,
  petScale: 1, // 小狗的大小，1 = 100%
  petView: 'friend', // 小狗演谁：'friend' 搭子 | 'me' 我自己（右键小狗切换）
};

function loadConfig() {
  try {
    const c = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    return {
      ...DEFAULT_CONFIG,
      ...c,
      petScale: clampScale(c.petScale),
      petView: c.petView === 'me' ? 'me' : 'friend',
      slackRemindMinutes: clampRemindMinutes(c.slackRemindMinutes),
      slackRemindOptions: remindOptions(c.slackRemindOptions, clampRemindMinutes(c.slackRemindMinutes)),
      pomodoroFocusMinutes: clampFocusMinutes(c.pomodoroFocusMinutes),
      pomodoroBreakMinutes: clampBreakMinutes(c.pomodoroBreakMinutes),
      pomodoroBreakCounts: c.pomodoroBreakCounts === true,
      rules: { ...DEFAULT_RULES, ...(c.rules || {}) },
    };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}
function saveConfig() {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
}
let config = loadConfig();
// 滚轮缩放时一格存一次太勤了，停下来再存
let saveTimer = null;
function saveConfigSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveConfig, 500);
}

// ---------------- 状态 ----------------
const relay = new RelayClient();
const tracker = new ActivityTracker({
  dataDir,
  getRules: () => config.rules,
  getSettings: () => ({ idleMinutes: config.idleMinutes, slackIdleMinutes: config.slackIdleMinutes }),
  selfProcNames: [path.basename(process.execPath, '.exe'), 'electron', 'Buddy Pet'],
});

// 今日计划 / 复盘：暂停分享期间不发给对方
const journalStore = new JournalStore(path.join(dataDir, 'journal'));
const journal = new JournalSync({ store: journalStore, send: (msg) => relay.send(msg), isPaused: () => tracker.paused });

let friend = null; // { name, online, status }
let petWin = null;
let settingsWin = null;
const journalWins = {}; // 'plan:2026-01-02' 这样的 key → 窗口
let statsWin = null; // 「今日时长明细」窗口
let remindWin = null; // 「该学习啦」/「该专注啦」提醒窗口
let remindKind = null; // 窗口上现在显示的是哪种：'slack' 连续摸鱼 | 'focus' 番茄钟休息结束
let tray = null;
const reminder = new SlackReminder(); // 这一轮连续摸鱼提醒到哪了
const pomodoro = new Pomodoro(); // 番茄钟（右键小狗开始），重启后不接着跑
let pomoTimer = null;

// 发给搭子的状态；番茄钟开着的话带上现在是专注还是休息、还剩多久（暂停分享时不带）
function myStatus() {
  const s = tracker.getStatus();
  if (s.paused || !pomodoro.phase) return s;
  return { ...s, pomodoro: { phase: pomodoro.phase, leftSec: pomodoro.leftSec(Date.now()) } };
}

function viewState() {
  return {
    // todaySec / breakdown 是给自己看的，暂停分享时也有
    me: { name: config.name, status: myStatus(), todaySec: tracker.todaySec(), breakdown: tracker.breakdown() },
    friend,
    friendJournal: friend ? progress(journal.friendToday(friend.name, friend.online)) : null, // { total, done, reviewed }，没写计划是 null
    myJournal: progress(journal.mine()), // 小狗演自己时卡片上显示的计划进度
    connection: { state: relay.state, error: relay.lastError },
    extConnected: tracker.extConnected(),
    petScale: config.petScale,
    petView: config.petView,
    pomodoro: pomodoro.phase ? { phase: pomodoro.phase, endsAt: pomodoro.endsAt } : null, // 小狗头上的倒计时
  };
}
function pushState() {
  if (petWin && !petWin.isDestroyed()) petWin.webContents.send('state', viewState());
  if (settingsWin && !settingsWin.isDestroyed()) settingsWin.webContents.send('state', viewState());
}

// ---------------- 上报自己的状态 ----------------
let statusDebounce = null;
function sendStatusSoon() {
  clearTimeout(statusDebounce);
  statusDebounce = setTimeout(() => relay.send({ type: 'status', status: myStatus() }), 1500);
}
setInterval(() => relay.send({ type: 'status', status: myStatus() }), STATUS_HEARTBEAT_MS);

let wasPaused = false;
tracker.on('change', () => {
  if (wasPaused && !tracker.paused) journal.flush(); // 恢复分享：把暂停期间的计划变化补发给对方
  wasPaused = tracker.paused;
  sendStatusSoon();
  pushState();
});
tracker.on('tick', (s) => {
  // 自己连续摸鱼每满 N 分钟提醒一次；回去学习、离开或暂停分享后计时清零，提醒窗口也跟着关掉。
  // 开关关着也照样往下数，这样中途打开不会马上弹一个
  const streak = s.paused ? 0 : s.slackStreakSec || 0;
  const r = reminder.tick(streak, config.slackRemindMinutes);
  if (r === 'due' && config.slackRemind) showSlackReminder(Math.floor(streak / 60));
  else if (r === 'reset') closeSlackReminder();
});

// ---------------- 服务器消息 ----------------
relay.on('state', () => {
  if (relay.state === 'online') {
    relay.send({ type: 'status', status: myStatus() });
    journal.flush(); // 服务器不落盘，每次连上都重发自己今天的计划
  }
  pushState();
  updateTray();
});
relay.on('message', (msg) => {
  switch (msg.type) {
    case 'welcome': {
      const p = msg.peers?.[0];
      friend = p ? { name: p.name, online: p.online, status: p.status } : null;
      if (p?.journal) onFriendJournal(p.name, p.journal);
      break;
    }
    case 'journal':
      if (!friend || friend.name === msg.from) onFriendJournal(msg.from, msg.journal);
      break;
    case 'presence':
      if (!friend || friend.name === msg.name) friend = { ...(friend || { status: null }), name: msg.name, online: msg.online };
      break;
    case 'status':
      if (!friend || friend.name === msg.from) friend = { ...(friend || {}), name: msg.from, online: true, status: msg.status };
      break;
    case 'poke': {
      petWin?.webContents.send('poke', { from: msg.from, text: msg.text });
      if (Notification.isSupported()) {
        new Notification({ title: `${msg.from} 戳了你一下`, body: msg.text, silent: false }).show();
      }
      break;
    }
    case 'poke_ok':
      petWin?.webContents.send('poke-result', { ok: true });
      break;
    case 'poke_rejected':
      petWin?.webContents.send('poke-result', { ok: false, retryInMs: msg.retryInMs });
      break;
  }
  pushState();
});

// ---------------- 今日计划 / 复盘 ----------------
function onFriendJournal(name, raw) {
  const kind = journal.onFriend(name, raw); // 对方刚写好计划 / 复盘时返回 'plan' / 'review'
  if (kind) petWin?.webContents.send('journal-event', { from: name, kind });
  journalChanged();
}
function journalChanged() {
  for (const w of [...Object.values(journalWins), settingsWin]) {
    if (w && !w.isDestroyed()) w.webContents.send('journal-changed');
  }
  pushState();
  updateTray();
}

function openJournal(mode, { reminder = false, date = localDate() } = {}) {
  const key = `${mode}:${date}`; // 今日计划和明日计划可以同时开着
  const old = journalWins[key];
  if (old && !old.isDestroyed()) {
    if (old.isMinimized()) old.restore();
    return old.focus();
  }
  const win = new BrowserWindow({
    width: 460,
    height: 600,
    title: { plan: date > localDate() ? '明日计划' : '今日计划', review: '今日复盘', view: 'TA 的今日计划' }[mode],
    autoHideMenuBar: true,
    maximizable: false,
    alwaysOnTop: reminder, // 到点弹出来的要盖在别的窗口上面，不然容易被忽略
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'journal.html'), { query: { mode, date, reminder: reminder ? '1' : '' } });
  win.on('closed', () => delete journalWins[key]);
  journalWins[key] = win;
}

// ---------------- 今日时长明细 ----------------
// 小狗卡片上列不下的，在这个窗口里看全部。who: 'me' | 'friend'，cat: 'study' | 'slack'
function openStats({ who, cat } = {}) {
  const query = { who: who === 'friend' ? 'friend' : 'me', cat: cat === 'slack' ? 'slack' : 'study' };
  if (statsWin && !statsWin.isDestroyed()) {
    if (statsWin.isMinimized()) statsWin.restore();
    statsWin.webContents.send('stats-select', query); // 已经开着：切到要看的那一页
    return statsWin.focus();
  }
  statsWin = new BrowserWindow({
    width: 440,
    height: 600,
    title: '今日时长明细',
    autoHideMenuBar: true,
    maximizable: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  statsWin.loadFile(path.join(__dirname, 'renderer', 'stats.html'), { query });
  statsWin.on('closed', () => (statsWin = null));
}

// ---------------- 「该学习啦」/「该专注啦」提醒 ----------------
// 置顶的小窗口，要自己点掉；小狗同时抖一下、冒个气泡。只提醒自己，不发给搭子。
// 两种提醒共用一个窗口（renderer/remind.html），info.kind 决定显示哪种。
const watchingFriend = () => (relay.state === 'online' && friend?.online ? friend.name : ''); // 搭子这会儿真的看得到才提

function showRemindWindow(info) {
  remindKind = info.kind;
  if (remindWin && !remindWin.isDestroyed()) {
    // 上一次的还没点掉：原地换成新的内容，不叠第二个窗口
    remindWin.webContents.send('remind', info);
    return remindWin.showInactive();
  }
  const size = { width: 380, height: 300 };
  const wa = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea; // 弹在正在用的那块屏幕上
  remindWin = new BrowserWindow({
    ...size,
    x: Math.round(wa.x + (wa.width - size.width) / 2),
    y: Math.round(wa.y + (wa.height - size.height) / 3),
    title: info.kind === 'focus' ? '该专注啦' : '该学习啦',
    show: false,
    autoHideMenuBar: true,
    resizable: false,
    maximizable: false,
    minimizable: false,
    alwaysOnTop: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  remindWin.setAlwaysOnTop(true, 'screen-saver');
  remindWin.loadFile(path.join(__dirname, 'renderer', 'remind.html'), {
    query: Object.fromEntries(Object.entries(info).map(([k, v]) => [k, Array.isArray(v) ? v.join(',') : String(v)])),
  });
  // 不抢焦点：正在打字的话，按键不会落到这个窗口上
  remindWin.once('ready-to-show', () => remindWin?.showInactive());
  remindWin.on('closed', () => (remindWin = null));
}
/** 把提醒窗口收起来；给了 kind 的话，只在窗口上显示的是这一种时才收 */
function closeRemindWindow(kind) {
  if (remindWin && !remindWin.isDestroyed() && (!kind || remindKind === kind)) remindWin.close();
}

// 连续摸鱼太久
function showSlackReminder(minutes) {
  petWin?.webContents.send('self-alert', { minutes, friend: friend?.name || '' });
  showRemindWindow({
    kind: 'slack',
    minutes,
    every: clampRemindMinutes(config.slackRemindMinutes), // 下拉框默认选这个
    options: remindOptions(config.slackRemindOptions, config.slackRemindMinutes),
    friend: watchingFriend(),
  });
}
// 回去学习（或者离开、开始番茄钟的休息）了：不管窗口上是哪种提醒都收起来
function closeSlackReminder() {
  closeRemindWindow();
}

// ---------------- 番茄钟 ----------------
// 专注 → 休息 → 专注 … 一直循环，右键小狗开始 / 结束。到休息时间只冒气泡；
// 休息结束时还在摸鱼才弹「该专注啦」的窗口。计时规则在 pomodoro.js。
const pomoSettings = () => ({ focusMinutes: config.pomodoroFocusMinutes, breakMinutes: config.pomodoroBreakMinutes });

// 休息时间怎么计时交给 tracker：设置里勾了就整段算学习；没勾的话休息时摸鱼不算摸鱼
function syncRest() {
  tracker.setRest(pomodoro.phase === 'break' ? (config.pomodoroBreakCounts ? 'study' : 'free') : null);
}

// 小狗隐藏着的时候气泡看不到，换成系统通知
const POMO_NOTICE = {
  break: (m) => ['🍅 专注结束，休息一下吧', `休息 ${m} 分钟，结束时会再叫你`],
  focus: (m) => ['🍅 休息结束，该专注啦', `新一轮 ${m} 分钟专注开始了`],
  idle: () => ['🍅 番茄钟已结束', '好一阵没碰电脑，先停了。右键小狗可以重新开始'],
};

/** 番茄钟有变化（开始 / 换到下一段 / 结束）：同步计时方式，让小狗冒气泡，告诉搭子 */
function pomodoroChanged(kind, extra = {}) {
  syncRest();
  if (!pomodoro.phase) {
    clearInterval(pomoTimer);
    pomoTimer = null;
  }
  if (kind !== 'nudge') closeRemindWindow('focus'); // 换了一段或者结束了，上一次的「该专注啦」不用留着
  const minutes = pomodoro.minutes;
  if (petWin && !petWin.isDestroyed() && petWin.isVisible()) {
    petWin.webContents.send('pomodoro-event', { kind, minutes, done: pomodoro.done, ...extra });
  } else if (POMO_NOTICE[kind] && Notification.isSupported()) {
    const [title, body] = POMO_NOTICE[kind](minutes);
    new Notification({ title, body, silent: false }).show();
  }
  relay.send({ type: 'status', status: myStatus() });
  pushState();
  updateTray();
}

function startPomodoro() {
  pomodoro.start(Date.now(), pomoSettings());
  clearInterval(pomoTimer);
  pomoTimer = setInterval(tickPomodoro, 1000);
  pomodoroChanged('start');
}
function stopPomodoro() {
  if (!pomodoro.phase) return;
  pomodoro.stop();
  pomodoroChanged('stop');
}
function skipPomodoro() {
  const phase = pomodoro.skip(Date.now(), pomoSettings());
  if (phase) pomodoroChanged(phase, { skipped: true });
}
function tickPomodoro() {
  // 暂停分享（处理私事）时不看在干什么，和连续摸鱼提醒一样
  const activity = { category: tracker.paused ? null : tracker.current.category, lastInputAt: tracker.lastInputAt };
  const events = pomodoro.tick(Date.now(), activity, pomoSettings());
  if (events.includes('settled')) closeRemindWindow('focus');
  if (events.includes('nudge')) showRemindWindow({ kind: 'focus', minutes: pomodoro.minutes, friend: watchingFriend() });
  // 休息结束时正好在摸鱼：弹窗和气泡说的是一回事，不用再冒一个「开始专注」
  const kind = ['idle', 'break', 'nudge', 'focus'].find((k) => events.includes(k));
  if (kind) pomodoroChanged(kind);
}

// 右键菜单和托盘菜单共用。托盘菜单不是每秒重建，所以那边不显示还剩多久
function pomodoroItems(withTime) {
  const { focusMinutes, breakMinutes } = pomoSettings();
  if (!pomodoro.phase) return [{ label: `🍅 开始番茄钟（专注 ${focusMinutes} 分钟 / 休息 ${breakMinutes} 分钟）`, click: startPomodoro }];
  const focus = pomodoro.phase === 'focus';
  const left = withTime ? ` · 还剩 ${Math.max(1, Math.ceil(pomodoro.leftSec(Date.now()) / 60))} 分钟` : '';
  return [
    { label: `🍅 番茄钟${focus ? '专注中' : '休息中'}${left}`, enabled: false },
    { label: focus ? '现在就休息' : '跳过休息，开始专注', click: skipPomodoro },
    { label: '结束番茄钟', click: stopPomodoro },
  ];
}

const openTomorrowPlan = () => openJournal('plan', { date: addDays(localDate(), 1) });

// 定时检查：跨天了没有、该不该弹计划 / 复盘
function checkJournal() {
  if (journal.tick()) journalChanged();
  if (!config.name) return; // 第一次打开还在填设置，先不打扰
  const now = new Date();
  const day = journalStore.load(localDate(now));
  const kind = duePrompt(now, config, day, Date.now() - tracker.lastInputAt < 2 * JOURNAL_CHECK_MS);
  if (!kind) return;
  markPrompted(day, kind, now, config);
  journalStore.save(day);
  openJournal(kind, { reminder: true });
}

// ---------------- 浏览器插件的本地接口 ----------------
function startExtServer() {
  const srv = http.createServer((req, res) => {
    // 只接受带自定义头的请求：普通网页跨域发不出这个头（会被预检拦下），插件可以
    if (req.method === 'POST' && req.url === '/tab' && req.headers['x-buddy-ext'] === '1') {
      let body = '';
      req.on('data', (c) => {
        body += c;
        if (body.length > 4096) req.destroy();
      });
      req.on('end', () => {
        try {
          const j = JSON.parse(body);
          tracker.setBrowserTab({ browser: j.browser, domain: typeof j.domain === 'string' ? j.domain.slice(0, 253) : null });
          res.writeHead(204).end();
        } catch {
          res.writeHead(400).end();
        }
      });
      return;
    }
    if (req.method === 'GET' && req.url === '/ping') return res.writeHead(200).end('buddy-pet');
    res.writeHead(404).end();
  });
  srv.on('error', (e) => console.warn('[ext-server]', e.message));
  srv.listen(EXT_PORT, '127.0.0.1');
}

// ---------------- 窗口 ----------------
// 窗口大小跟着小狗的缩放变，见 pet-geometry.js
function createPetWindow() {
  const wa = screen.getPrimaryDisplay().workArea;
  const size = petSize(config.petScale);
  const pos = config.petPos || { x: wa.x + wa.width - size.width - 24, y: wa.y + wa.height - size.height };
  petWin = new BrowserWindow({
    width: size.width,
    height: size.height,
    x: pos.x,
    y: pos.y,
    frame: false,
    transparent: true,
    resizable: false,
    skipTaskbar: true,
    hasShadow: false,
    alwaysOnTop: true,
    focusable: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  petWin.setAlwaysOnTop(true, 'screen-saver');
  petWin.setIgnoreMouseEvents(true, { forward: true });
  petWin.loadFile(path.join(__dirname, 'renderer', 'pet.html'));
  petWin.webContents.on('did-finish-load', pushState);
  petWin.on('closed', () => (petWin = null));
}

// 调小狗的大小：窗口跟着变，小狗的脚留在原地
function setPetScale(next) {
  const scale = clampScale(next);
  if (scale === config.petScale) return;
  if (petWin && !petWin.isDestroyed()) {
    const [x, y] = petWin.getPosition();
    const b = rescaleBounds({ x, y }, config.petScale, scale);
    petWin.setBounds(b);
    config.petPos = { x: b.x, y: b.y };
  }
  config.petScale = scale;
  saveConfigSoon();
  pushState();
  updateTray();
}

const togglePause = () => {
  tracker.setPaused(!tracker.paused);
  updateTray();
};

// 小狗演谁：搭子（默认）还是我自己。演自己时看到的是发给搭子的那份状态
function setPetView(view) {
  const next = view === 'me' ? 'me' : 'friend';
  if (next === config.petView) return;
  config.petView = next;
  saveConfig();
  pushState();
  updateTray();
}
// 右键菜单和托盘菜单共用的两个单选项。托盘菜单不是每次收到消息都重建，所以那边不带搭子的名字
function petViewItems(who = '搭子') {
  return [
    { label: `显示${who}的状态`, type: 'radio', checked: config.petView !== 'me', click: () => setPetView('friend') },
    { label: '显示我自己的状态', type: 'radio', checked: config.petView === 'me', click: () => setPetView('me') },
  ];
}
// 右键小狗弹出来的菜单
function showPetMenu() {
  if (!petWin || petWin.isDestroyed()) return;
  // 菜单里单个 & 会被当成快捷键标记
  const who = friend?.name ? ` ${friend.name.replace(/&/g, '&&')} ` : '搭子';
  Menu.buildFromTemplate([
    ...petViewItems(who),
    { type: 'separator' },
    ...pomodoroItems(true),
    { type: 'separator' },
    { label: tracker.paused ? '▶ 恢复分享' : '⏸ 暂停分享（处理私事）', click: togglePause },
    { label: '今日时长明细', click: () => openStats() },
    { label: '设置…', click: openSettings },
    { type: 'separator' },
    // 托盘图标在 Win11 上默认收在「^」里不好找，任务栏图标的「关闭窗口」又只关设置之类的窗口，所以这里也要能关
    { label: '隐藏小狗（点托盘图标再叫出来）', click: hidePet },
    { label: '退出 Buddy Pet', click: () => app.quit() },
  ]).popup({ window: petWin });
}
function hidePet() {
  if (petWin && !petWin.isDestroyed()) petWin.hide();
  updateTray(); // 托盘菜单里的「隐藏小狗」要换成「显示小狗」
}

function openSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) {
    if (settingsWin.isMinimized()) settingsWin.restore();
    return settingsWin.focus();
  }
  settingsWin = new BrowserWindow({
    width: 560,
    height: 760,
    title: 'Buddy Pet 设置',
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  settingsWin.loadFile(path.join(__dirname, 'renderer', 'settings.html'));
  settingsWin.webContents.on('did-finish-load', pushState);
  settingsWin.on('closed', () => (settingsWin = null));
}

function updateTray() {
  if (!tray) return;
  const label = { online: '已连接', connecting: '连接中…', error: '未连接', idle: '未连接' }[relay.state] || '';
  tray.setToolTip(`Buddy Pet · ${label}${tracker.paused ? ' · 已暂停分享' : ''}`);
  const mine = progress(journal.mine());
  const planLabel = mine ? `（${mine.done}/${mine.total}${mine.reviewed ? '，已复盘' : ''}）` : '（还没写）';
  const next = progress(journal.mine(addDays(localDate(), 1)));
  const tomorrowLabel = next ? `（已写 ${next.total} 条）` : '';
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: `状态：${label}${relay.state === 'error' && relay.lastError ? '（' + relay.lastError + '）' : ''}`, enabled: false },
      { type: 'separator' },
      {
        label: tracker.paused ? '▶ 恢复分享' : '⏸ 暂停分享（处理私事）',
        click: togglePause,
      },
      {
        label: petWin?.isVisible() ? '隐藏小狗' : '显示小狗',
        click: () => {
          if (!petWin) createPetWindow();
          else if (petWin.isVisible()) petWin.hide();
          else petWin.showInactive();
          updateTray();
        },
      },
      {
        label: '小狗大小（也可以在小狗身上滚滚轮）',
        submenu: [['小', 0.75], ['标准', 1], ['大', 1.5], ['特大', 2]].map(([name, s]) => ({
          label: `${name} ${Math.round(s * 100)}%`,
          type: 'radio',
          checked: config.petScale === s,
          click: () => setPetScale(s),
        })),
      },
      { label: '小狗显示谁（也可以右键小狗）', submenu: petViewItems() },
      { type: 'separator' },
      ...pomodoroItems(false),
      { type: 'separator' },
      { label: `今日计划${planLabel}`, click: () => openJournal('plan') },
      { label: `明日计划${tomorrowLabel}`, click: openTomorrowPlan },
      { label: '今日复盘', click: () => openJournal('review', { date: journal.reviewDate() }) },
      { label: '今日时长明细', click: () => openStats() },
      { type: 'separator' },
      { label: '设置…', click: openSettings },
      updateReady
        ? { label: `重启并更新到 ${updateReady}`, click: () => promptInstall(updateReady) }
        : { label: `检查更新（当前 ${app.getVersion()}）`, click: () => checkForUpdates(true) },
      { type: 'separator' },
      { label: '退出', click: () => app.quit() },
    ])
  );
}

function createTray() {
  const img = nativeImage.createFromPath(path.join(__dirname, 'assets', 'tray.png'));
  tray = new Tray(img.isEmpty() ? nativeImage.createEmpty() : img);
  tray.on('click', () => {
    if (petWin) petWin.isVisible() ? petWin.hide() : petWin.showInactive();
    updateTray();
  });
  updateTray();
}

// ---------------- 自动更新 ----------------
// 安装版：发现 GitHub Release 上有新版本就在后台下载，下好了弹窗，点一下重启就装上。
// 便携版每次是解压到临时目录运行的，没法替换自己，只提示去下载页。
const isPortable = !!process.env.PORTABLE_EXECUTABLE_FILE;
let updater = null; // 没打包（npm start）时不检查更新，一直是 null
let updateReady = null; // 已经下载好、等着安装的版本号
let manualCheck = false; // 这次是不是从托盘菜单手动点的：手动的要把「已是最新」「检查失败」也说出来
let offeredVersion = null; // 便携版：这次启动已经主动提示过的版本
let updatePromptOpen = false;

const updateBox = (message, detail, buttons = ['好']) =>
  dialog.showMessageBox({ type: 'info', title: 'Buddy Pet 更新', message, detail, buttons, defaultId: 0, cancelId: buttons.length - 1, noLink: true });

async function promptInstall(version) {
  if (updatePromptOpen) return;
  updatePromptOpen = true;
  const { response } = await updateBox(
    `新版本 ${version} 已经下载好了`,
    `现在重启小狗就能用上（当前是 ${app.getVersion()}），设置和计划记录都会保留。\n选「稍后」的话，下次退出小狗时会自动装上。`,
    ['现在重启更新', '稍后']
  );
  updatePromptOpen = false;
  if (response === 0) updater.quitAndInstall(true, true); // 静默安装，装完自动重新打开
}

async function offerDownload(version) {
  if (!manualCheck && offeredVersion === version) return;
  offeredVersion = version;
  const { response } = await updateBox(
    `有新版本 ${version} 可以下载`,
    `当前是 ${app.getVersion()}。便携版不能自动更新，要到下载页重新下载；换成安装版以后就能自动更新了。`,
    ['打开下载页', '以后再说']
  );
  if (response === 0) shell.openExternal(RELEASES_URL);
}

async function checkForUpdates(manual) {
  if (!updater) return manual && updateBox('现在是开发模式，不检查更新', '打包后的安装版和便携版才会检查。');
  if (updateReady) return manual && promptInstall(updateReady);
  manualCheck = manual;
  try {
    await updater.checkForUpdates();
  } catch {
    /* 断网之类的，在 error 事件里处理 */
  }
}

function setupUpdater() {
  if (!app.isPackaged) return;
  updater = require('electron-updater').autoUpdater;
  updater.autoDownload = !isPortable;
  updater.autoInstallOnAppQuit = !isPortable;
  updater.on('update-available', (info) => {
    if (isPortable) offerDownload(info.version);
    else if (manualCheck) updateBox(`发现新版本 ${info.version}`, '正在后台下载，下好了会再提示你。');
    manualCheck = false;
  });
  updater.on('update-not-available', () => {
    if (manualCheck) updateBox('已经是最新版本', `当前版本 ${app.getVersion()}。`);
    manualCheck = false;
  });
  updater.on('update-downloaded', (info) => {
    updateReady = info.version;
    updateTray();
    promptInstall(info.version);
  });
  updater.on('error', (e) => {
    console.warn('[update]', e?.message);
    if (manualCheck) updateBox('检查更新失败', '可能是网络连不上 GitHub，过一会儿再试。');
    manualCheck = false;
  });
  setTimeout(() => checkForUpdates(false), 15_000);
  setInterval(() => checkForUpdates(false), UPDATE_CHECK_MS);
}

// ---------------- IPC ----------------
ipcMain.on('pet:ignore', (_e, ignore) => {
  if (petWin && !petWin.isDestroyed()) petWin.setIgnoreMouseEvents(!!ignore, { forward: true });
});
// 拖动名牌：位置由主进程按光标位置算，窗口再卡也不会和鼠标错位
let dragFrom = null;
ipcMain.on('pet:drag', (_e, phase) => {
  if (!petWin || petWin.isDestroyed()) return;
  const cur = screen.getCursorScreenPoint();
  if (phase === 'start') {
    const [x, y] = petWin.getPosition();
    dragFrom = { cx: cur.x, cy: cur.y, x, y };
    return;
  }
  if (!dragFrom) return;
  // 带上固定宽高：系统缩放不是 100% 时反复 setPosition 会让窗口越拖越大
  petWin.setBounds({ x: dragFrom.x + cur.x - dragFrom.cx, y: dragFrom.y + cur.y - dragFrom.cy, ...petSize(config.petScale) });
  if (phase === 'end') {
    dragFrom = null;
    const [x, y] = petWin.getPosition();
    config.petPos = { x, y };
    saveConfig();
  }
});
// 在小狗身上滚滚轮：dir > 0 放大一格，< 0 缩小一格
ipcMain.on('pet:scale', (_e, dir) => setPetScale(config.petScale + (dir > 0 ? SCALE_STEP : -SCALE_STEP)));
ipcMain.on('pet:menu', showPetMenu);
// 提醒窗口里改了「再过 X 分钟提醒我」：只管下一次，从现在的连续摸鱼时长往后数
ipcMain.on('remind:next', (_e, minutes) => reminder.snooze(minutes, tracker.paused ? 0 : tracker.slackStreakSec));
ipcMain.on('pomodoro:stop', stopPomodoro); // 「该专注啦」窗口里的「结束番茄钟」
ipcMain.handle('poke', (_e, text) => {
  const ok = relay.send({ type: 'poke', text: String(text || '').slice(0, 140) });
  return { sent: ok, reason: ok ? '' : '还没连上服务器' };
});
ipcMain.handle('config:get', () => ({ ...config, rules: config.rules }));
ipcMain.handle('config:save', (_e, next) => {
  const oldConn = [config.serverUrl, config.room, config.secret, config.name].join('|');
  config = {
    ...config,
    serverUrl: String(next.serverUrl || '').trim(),
    room: String(next.room || '').trim(),
    secret: String(next.secret || ''),
    name: String(next.name || '').trim(),
    idleMinutes: Math.max(1, Math.min(60, Number(next.idleMinutes) || 5)),
    slackRemind: next.slackRemind === undefined ? config.slackRemind : !!next.slackRemind,
    slackRemindMinutes: clampRemindMinutes(next.slackRemindMinutes ?? config.slackRemindMinutes),
    pomodoroFocusMinutes: clampFocusMinutes(next.pomodoroFocusMinutes ?? config.pomodoroFocusMinutes),
    pomodoroBreakMinutes: clampBreakMinutes(next.pomodoroBreakMinutes ?? config.pomodoroBreakMinutes),
    pomodoroBreakCounts: next.pomodoroBreakCounts === undefined ? config.pomodoroBreakCounts : !!next.pomodoroBreakCounts,
    openAtLogin: !!next.openAtLogin,
    rules: next.rules || config.rules,
  };
  // 可以选的间隔里一定有选中的那个
  config.slackRemindOptions = remindOptions(next.slackRemindOptions ?? config.slackRemindOptions, config.slackRemindMinutes);
  // 摸鱼时的空闲时间不能比平时的短
  config.slackIdleMinutes = Math.max(config.idleMinutes, Math.min(SLACK_IDLE_MAX, Number(next.slackIdleMinutes) || config.slackIdleMinutes || 20));
  // 复盘时间要晚于计划时间，否则保持原来的
  if (toMinutes(next.planTime) < toMinutes(next.reviewTime)) Object.assign(config, { planTime: next.planTime, reviewTime: next.reviewTime });
  saveConfig();
  if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: config.openAtLogin });
  syncRest(); // 正在休息时改了「休息算不算学习」，马上生效；时长从下一段开始生效
  updateTray(); // 菜单上写着番茄钟的时长
  const newConn = [config.serverUrl, config.room, config.secret, config.name].join('|');
  if (newConn !== oldConn || relay.state !== 'online') {
    friend = null;
    relay.connect(config);
  }
  pushState();
  return { ok: true };
});
ipcMain.handle('config:resetRules', () => DEFAULT_RULES);
ipcMain.on('open-settings', openSettings);

ipcMain.on('journal:open', (_e, mode) => (mode === 'tomorrow' ? openTomorrowPlan() : openJournal(['plan', 'review', 'view'].includes(mode) ? mode : 'plan')));
ipcMain.handle('journal:get', (_e, date) => {
  const today = localDate();
  const day = journalStore.load(isDate(date) ? date : today);
  return {
    date: day.date,
    today,
    me: day.me,
    snoozesLeft: snoozesLeft(day),
    friend: friend ? { name: friend.name, journal: journal.friendToday(friend.name, friend.online) } : null,
  };
});
ipcMain.handle('journal:save', (_e, kind, input) => {
  const r = journal.save(kind === 'review' ? 'review' : 'plan', input || {});
  if (r.ok) journalChanged();
  return r;
});
ipcMain.handle('journal:snooze', (e) => {
  const day = journalStore.load(localDate());
  if (snooze(day)) journalStore.save(day);
  BrowserWindow.fromWebContents(e.sender)?.close();
});
ipcMain.handle('journal:history', () => {
  const today = localDate();
  const tomorrow = addDays(today, 1);
  // 明天的排在最前面，方便提前写；对方明天的计划要到那天才会收到
  return { today, days: [{ date: tomorrow, me: journalStore.load(tomorrow).me, friend: null }, ...journalStore.recent(7, today)] };
});
ipcMain.on('stats:open', (_e, sel) => openStats(sel || {}));
ipcMain.handle('stats:get', () => {
  // 自己的是本机的完整记录（暂停分享时也有）；对方的是 TA 发来的那部分，不在线或暂停分享时没有
  const st = friend?.online ? friend.status : null;
  return {
    me: { todaySec: tracker.todaySec(), breakdown: tracker.breakdown(Infinity) },
    friend: st?.todaySec ? { name: friend.name, todaySec: st.todaySec, breakdown: st.breakdown || null } : null,
  };
});
ipcMain.on('toggle-pause', togglePause);

// ---------------- 启动 ----------------
app.on('second-instance', () => {
  if (petWin) petWin.show();
  openSettings();
});
app.on('window-all-closed', (e) => e.preventDefault()); // 托盘常驻
app.on('before-quit', () => {
  tracker.stop();
  if (saveTimer) saveConfig(); // 还有没落盘的设置（刚调完大小就退出）
});

app.whenReady().then(() => {
  ensurePortableShortcut();
  startExtServer();
  createTray();
  createPetWindow();
  tracker.start();
  if (config.serverUrl && config.room && config.name && config.secret) relay.connect(config);
  else openSettings();
  setInterval(pushState, 5000); // 刷新「x 分钟前」之类的显示 & 插件连接状态
  setTimeout(checkJournal, 5000);
  setInterval(checkJournal, JOURNAL_CHECK_MS);
  setupUpdater();
});
