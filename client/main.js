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
const { Pomodoro, clampFocusMinutes, clampBreakMinutes, POMO_FOCUS_DEFAULT, POMO_BREAK_DEFAULT, POMO_PAUSE_MINUTES } = require('./pomodoro');
const { JournalStore, JournalSync, duePrompt, markPrompted, snooze, snoozesLeft, progress, toMinutes, isDate, addDays } = require('./journal');
const { buildDay, buildWeek } = require('./history');

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
  pomodoroStrict: false, // 番茄钟严格模式：专注时摸鱼的时间不算，倒计时停着；可以自己暂停 5 分钟
  openAtLogin: false,
  planTime: '09:00', // 计划提醒时间
  reviewTime: '22:00', // 复盘提醒时间
  rules: DEFAULT_RULES,
  petPos: null,
  petScale: 1, // 小狗的大小，1 = 100%
  petView: 'friend', // 小狗演谁：'friend' 搭子 | 'me' 我自己（右键小狗切换）
  petSkin: 'dog', // 形象：见 PET_SKINS（右键小狗 →「换个形象」）
};
// 可以换的形象：[配置里存的名字, 菜单上显示的名字]。画在 renderer/pet.html 里，一套一个 <g class="skin skin-名字">
const PET_SKINS = [
  ['dog', '🐶 小狗'],
  ['cat', '🐱 小猫'],
];
const validSkin = (s) => (PET_SKINS.some(([id]) => id === s) ? s : 'dog');
// 菜单、气泡、通知里怎么称呼它：「小狗」或「小猫」，跟着现在的形象走（就是上面的名字去掉开头的表情）
const petName = () => PET_SKINS.find(([id]) => id === config.petSkin)[1].replace(/^\S+ /, '');

function loadConfig() {
  try {
    const c = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    return {
      ...DEFAULT_CONFIG,
      ...c,
      petScale: clampScale(c.petScale),
      petView: c.petView === 'me' ? 'me' : 'friend',
      petSkin: validSkin(c.petSkin),
      slackRemindMinutes: clampRemindMinutes(c.slackRemindMinutes),
      slackRemindOptions: remindOptions(c.slackRemindOptions, clampRemindMinutes(c.slackRemindMinutes)),
      pomodoroFocusMinutes: clampFocusMinutes(c.pomodoroFocusMinutes),
      pomodoroBreakMinutes: clampBreakMinutes(c.pomodoroBreakMinutes),
      pomodoroBreakCounts: c.pomodoroBreakCounts === true,
      pomodoroStrict: c.pomodoroStrict === true,
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
let panelWin = null; // 面板：今天 / 统计 / 计划 / 设置
const journalWins = {}; // 'plan:2026-01-02' 这样的 key → 窗口
let remindWin = null; // 「该学习啦」/「休息结束啦」提醒窗口
let remindKind = null; // 窗口上现在显示的是哪种：'slack' 连续摸鱼 | 'focus' 番茄钟休息结束，等着点「重新开始」 | 'pause' 番茄钟暂停到点了
let tray = null;
const reminder = new SlackReminder(); // 这一轮连续摸鱼提醒到哪了
const pomodoro = new Pomodoro(); // 番茄钟（右键小狗开始），重启后不接着跑
let pomoTimer = null;

// 发给搭子的状态；番茄钟开着的话带上现在是专注、休息还是等着开始下一轮（wait），还剩多久（暂停分享时不带）。
// hold：专注的倒计时停着的原因（严格模式下在摸鱼 'slack' / 暂停中 'pause' / 暂停到点了还没选 'over'），在走就不带
function myStatus() {
  const s = tracker.getStatus();
  if (s.paused || !pomodoro.phase) return s;
  const hold = pomodoro.hold;
  return { ...s, pomodoro: { phase: pomodoro.phase, leftSec: pomodoro.leftSec(Date.now()), ...(hold ? { hold } : {}) } };
}
/** 给小狗和面板的：倒计时停着时（hold）用 leftSec，不能拿 endsAt 自己算；暂停中另外有一个暂停的倒计时（pauseEndsAt） */
function pomodoroView() {
  if (!pomodoro.phase) return null;
  const { phase, endsAt, minutes, hold, pauseEndsAt } = pomodoro;
  return { phase, endsAt, minutes, hold, leftSec: pomodoro.leftSec(Date.now()), pauseEndsAt };
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
    petSkin: config.petSkin,
    petName: petName(),
    pomodoro: pomodoroView(), // 小狗头上的倒计时
    // 下面几项是面板用的
    pomoSettings: pomoSettings(),
    pomoToday: tracker.dayRecord().pomo.count, // 今天完整专注完了几个番茄
    skins: PET_SKINS,
    version: app.getVersion(),
    updateReady, // 已经下载好、等着安装的版本号
  };
}
function pushState() {
  if (petWin && !petWin.isDestroyed()) petWin.webContents.send('state', viewState());
  if (panelWin && !panelWin.isDestroyed()) panelWin.webContents.send('state', viewState());
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
  // 搭子今天的时长跟着存一份，「统计」页以后能回看（TA 暂停分享或者是旧版本时状态里没有）
  const st = friend?.online ? friend.status : null;
  if (st?.todaySec) tracker.setFriendDay(friend.name, st.todaySec, st.breakdown);
  pushState();
});

// ---------------- 今日计划 / 复盘 ----------------
function onFriendJournal(name, raw) {
  const kind = journal.onFriend(name, raw); // 对方刚写好计划 / 复盘时返回 'plan' / 'review'
  if (kind) petWin?.webContents.send('journal-event', { from: name, kind });
  journalChanged();
}
function journalChanged() {
  for (const w of [...Object.values(journalWins), panelWin]) {
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

// ---------------- 面板 ----------------
// 一个带侧边栏的窗口，四页：今天 / 统计 / 计划 / 设置（renderer/panel.html）。
// 托盘菜单和右键菜单里的「打开面板」、小狗卡片上的「看全部」「设置」都到这里。
const PANEL_PAGES = ['today', 'stats', 'plan', 'settings'];
/** @param {string} [page] 打开哪一页；opts 里可以带 who（'me' | 'friend'）让统计页直接看谁的 */
function openPanel(page, opts = {}) {
  const go = { page: PANEL_PAGES.includes(page) ? page : 'today' };
  if (opts.who === 'friend' || opts.who === 'me') go.who = opts.who;
  if (panelWin && !panelWin.isDestroyed()) {
    if (panelWin.isMinimized()) panelWin.restore();
    panelWin.webContents.send('panel-go', go); // 已经开着：切到要看的那一页
    return panelWin.focus();
  }
  panelWin = new BrowserWindow({
    width: 960,
    height: 620,
    useContentSize: true, // 960×620 是页面的大小，不算标题栏
    minWidth: 900,
    minHeight: 560,
    title: 'Buddy Pet',
    autoHideMenuBar: true,
    backgroundColor: '#faf4ed', // 和 tokens.css 里的 --color-background-body 一致，窗口刚打开时不闪白
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  panelWin.loadFile(path.join(__dirname, 'renderer', 'panel.html'), { query: go });
  panelWin.webContents.on('did-finish-load', pushState);
  panelWin.on('closed', () => (panelWin = null));
}
// 小狗卡片上明细里的「看全部」：统计页的今天
const openStats = ({ who } = {}) => openPanel('stats', { who });

// ---------------- 「该学习啦」/「休息结束啦」提醒 ----------------
// 置顶的小窗口，要自己点掉；小狗同时抖一下、冒个气泡。只提醒自己，不发给搭子。
// 三种提醒共用一个窗口（renderer/remind.html），info.kind 决定显示哪种：
// 'slack' 连续摸鱼太久；'focus' 番茄钟的休息结束了，等着选「重新开始 / 再休息一会 / 恢复默认模式」；
// 'pause' 番茄钟暂停到点了，等着选「继续专注 / 5 分钟后再提醒 / 退出番茄钟」。
const REMIND_TITLE = { slack: '该学习啦', focus: '休息结束啦', pause: '暂停时间到啦' };
const watchingFriend = () => (relay.state === 'online' && friend?.online ? friend.name : ''); // 搭子这会儿真的看得到才提

function showRemindWindow(info) {
  if (remindWin && !remindWin.isDestroyed()) {
    if (remindKind === info.kind) {
      // 上一次的还没点掉：原地换成新的内容，不叠第二个窗口
      remindWin.webContents.send('remind', info);
      return remindWin.showInactive();
    }
    remindWin.destroy(); // 几种提醒的窗口不一样高，换一种就重开
  }
  remindKind = info.kind;
  const size = { width: 380, height: info.kind === 'slack' ? 300 : 320 }; // 番茄钟的两种多一排按钮
  const wa = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea; // 弹在正在用的那块屏幕上
  const win = (remindWin = new BrowserWindow({
    ...size,
    x: Math.round(wa.x + (wa.width - size.width) / 2),
    y: Math.round(wa.y + (wa.height - size.height) / 3),
    title: REMIND_TITLE[info.kind],
    show: false,
    autoHideMenuBar: true,
    resizable: false,
    maximizable: false,
    minimizable: false,
    alwaysOnTop: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  }));
  remindWin.setAlwaysOnTop(true, 'screen-saver');
  remindWin.loadFile(path.join(__dirname, 'renderer', 'remind.html'), {
    query: Object.fromEntries(Object.entries(info).map(([k, v]) => [k, Array.isArray(v) ? v.join(',') : String(v)])),
  });
  // 不抢焦点：正在打字的话，按键不会落到这个窗口上
  remindWin.once('ready-to-show', () => remindWin?.showInactive());
  // 换了一种提醒时旧窗口是先销毁再开新的：旧窗口的 closed 不能把新窗口的引用清掉
  win.on('closed', () => {
    if (remindWin === win) remindWin = null;
  });
}
/** 把提醒窗口收起来；给了 kind 的话，只在窗口上显示的是这一种时才收 */
function closeRemindWindow(kind) {
  if (remindWin && !remindWin.isDestroyed() && (!kind || remindKind === kind)) remindWin.close();
}

// 连续摸鱼太久
function showSlackReminder(minutes) {
  petWin?.webContents.send('self-alert', { minutes, friend: friend?.name || '' });
  // 番茄钟的「休息结束啦」「暂停时间到啦」还没点掉：那个窗口要留着等你选，这次只冒气泡。
  // 番茄钟暂停着也一样：到点了有它自己的弹窗，不叠两个
  if (remindWin && !remindWin.isDestroyed() && remindKind !== 'slack') return;
  if (pomodoro.paused) return;
  showRemindWindow({
    kind: 'slack',
    minutes,
    every: clampRemindMinutes(config.slackRemindMinutes), // 下拉框默认选这个
    options: remindOptions(config.slackRemindOptions, config.slackRemindMinutes),
    friend: watchingFriend(),
  });
}
// 回去学习（或者离开、开始番茄钟的休息）了：「该学习啦」收起来。番茄钟的那两种要等你选，不跟着关
function closeSlackReminder() {
  closeRemindWindow('slack');
}

// ---------------- 番茄钟 ----------------
// 专注 → 休息 → 等你点「重新开始」→ 专注 … 一直循环，右键小狗开始 / 结束。到休息时间只冒气泡；
// 休息结束时弹「休息结束啦」的窗口，点了「重新开始番茄钟」才接着计时。计时规则在 pomodoro.js。
// 严格模式（设置里勾）：专注时摸鱼的时间不算，倒计时停着；可以「暂停 5 分钟」，到点弹「暂停时间到啦」等着选。
const pomoSettings = () => ({ focusMinutes: config.pomodoroFocusMinutes, breakMinutes: config.pomodoroBreakMinutes, strict: config.pomodoroStrict });

// 休息时间怎么计时交给 tracker：设置里勾了就整段算学习；没勾的话休息时摸鱼不算摸鱼
function syncRest() {
  tracker.setRest(pomodoro.phase === 'break' ? (config.pomodoroBreakCounts ? 'study' : 'free') : null);
}

// 小狗隐藏着的时候气泡看不到，换成系统通知
const POMO_NOTICE = {
  break: (m, x) => [x.again ? '🍅 再休息一会' : '🍅 专注结束，休息一下吧', `休息 ${m} 分钟，结束时会再叫你`],
  wait: () => ['🍅 休息结束啦', '在弹出的窗口里点「重新开始番茄钟」，新一轮才开始计时'],
  idle: () => ['🍅 番茄钟已结束', `好一阵没碰电脑，先停了。右键${petName()}可以重新开始`],
  'pause-over': () => ['🍅 暂停时间到啦', '在弹出的窗口里选「继续专注」，倒计时才接着走'],
};
const POMO_SEGMENT = ['start', 'focus', 'break', 'wait', 'idle', 'stop']; // 换了一段（或者开始 / 结束）的那几种变化
let freezeTold = false; // 这一段专注里说过「摸鱼不算番茄钟时间」了：切来切去不用每次都冒气泡

/** 番茄钟有变化（开始 / 换到下一段 / 结束 / 倒计时停住或者接着走）：同步计时方式，让小狗冒气泡，告诉搭子 */
function pomodoroChanged(kind, extra = {}) {
  syncRest();
  if (!pomodoro.phase) {
    clearInterval(pomoTimer);
    pomoTimer = null;
  }
  if (kind !== 'wait') closeRemindWindow('focus'); // 换了一段或者结束了，「休息结束啦」不用留着
  if (kind !== 'pause-over') closeRemindWindow('pause'); // 「暂停时间到啦」也一样：选完或者番茄钟停了就收起来
  if (POMO_SEGMENT.includes(kind)) freezeTold = false;
  if (kind === 'freeze') {
    extra = { ...extra, quiet: freezeTold };
    freezeTold = true;
  }
  const minutes = pomodoro.minutes;
  if (petWin && !petWin.isDestroyed() && petWin.isVisible()) {
    petWin.webContents.send('pomodoro-event', { kind, minutes, done: pomodoro.done, leftSec: pomodoro.leftSec(Date.now()), ...extra });
  } else if (POMO_NOTICE[kind] && Notification.isSupported()) {
    const [title, body] = POMO_NOTICE[kind](minutes, extra);
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
// 休息结束后选的：重新开始专注 / 再休息一会（弹窗里点的，或者右键菜单、托盘菜单里点的）
function resumePomodoro() {
  if (pomodoro.resume(Date.now(), pomoSettings())) pomodoroChanged('focus');
}
function restMorePomodoro() {
  if (pomodoro.restMore(Date.now(), pomoSettings())) pomodoroChanged('break', { again: true });
}
// 严格模式下的暂停：专注时点「暂停 5 分钟」，到点弹窗里选「继续专注」或者「5 分钟后再提醒」（也可以右键菜单、面板里点）
function pausePomodoro() {
  if (pomodoro.pause(Date.now())) pomodoroChanged('pause');
}
function pauseMorePomodoro() {
  if (pomodoro.pauseMore(Date.now())) pomodoroChanged('pause', { again: true });
}
function continuePomodoro() {
  if (pomodoro.unpause(Date.now())) pomodoroChanged('continue');
}
function tickPomodoro() {
  const focusMinutes = pomodoro.phase === 'focus' ? pomodoro.minutes : 0;
  const activity = { lastInputAt: tracker.lastInputAt, slacking: tracker.current.category === 'slack' };
  const events = pomodoro.tick(Date.now(), activity, pomoSettings());
  if (events.includes('break')) tracker.addPomodoro(focusMinutes); // 完整专注完一个：记进今天的统计（手动跳过的不算）
  // 休息结束：不自己开始下一轮，弹窗等你选。窗口被直接关掉的话还停在这儿，右键小狗也能选
  if (events.includes('wait')) showRemindWindow({ kind: 'focus', ...pomoSettings() });
  // 暂停到点：也不自己接着走，弹窗等你选
  if (events.includes('pause-over')) showRemindWindow({ kind: 'pause', leftSec: pomodoro.leftSec(Date.now()), pauseMinutes: POMO_PAUSE_MINUTES });
  const kind = ['idle', 'break', 'wait', 'pause-over', 'freeze', 'unfreeze'].find((k) => events.includes(k));
  if (kind) pomodoroChanged(kind);
}

// 右键菜单和托盘菜单共用。托盘菜单不是每秒重建，所以那边不显示还剩多久
function pomodoroItems(withTime) {
  const { focusMinutes, breakMinutes } = pomoSettings();
  if (!pomodoro.phase) return [{ label: `🍅 开始番茄钟（专注 ${focusMinutes} 分钟 / 休息 ${breakMinutes} 分钟）`, click: startPomodoro }];
  if (pomodoro.phase === 'wait') {
    return [
      { label: '🍅 休息结束，等你开始下一轮', enabled: false },
      { label: `重新开始番茄钟（专注 ${focusMinutes} 分钟）`, click: resumePomodoro },
      { label: `再休息一会（${breakMinutes} 分钟）`, click: restMorePomodoro },
      { label: '结束番茄钟', click: stopPomodoro },
    ];
  }
  const focus = pomodoro.phase === 'focus';
  const mins = (sec) => Math.max(1, Math.ceil(sec / 60));
  const left = withTime ? ` · 还剩 ${mins(pomodoro.leftSec(Date.now()))} 分钟` : '';
  if (pomodoro.paused) {
    const pauseLeft = withTime && !pomodoro.pauseOver ? ` · ${mins(pomodoro.pauseLeftSec(Date.now()))} 分钟后叫你` : '';
    return [
      { label: pomodoro.pauseOver ? '🍅 暂停时间到了，等你继续' : `🍅 番茄钟暂停中${pauseLeft}`, enabled: false },
      { label: `继续专注${left}`, click: continuePomodoro },
      { label: `再暂停 ${POMO_PAUSE_MINUTES} 分钟`, click: pauseMorePomodoro },
      { label: '结束番茄钟', click: stopPomodoro },
    ];
  }
  return [
    { label: `🍅 番茄钟${focus ? (pomodoro.frozen ? '专注中（摸鱼时不走）' : '专注中') : '休息中'}${left}`, enabled: false },
    { label: focus ? '现在就休息' : '跳过休息，开始专注', click: skipPomodoro },
    ...(focus && config.pomodoroStrict ? [{ label: `暂停 ${POMO_PAUSE_MINUTES} 分钟`, click: pausePomodoro }] : []),
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
// 换形象：只改自己桌面上这只长什么样，演的还是同一个人，搭子那边不受影响
function setPetSkin(skin) {
  const next = validSkin(skin);
  if (next === config.petSkin) return;
  config.petSkin = next;
  saveConfig();
  pushState();
  updateTray();
}
// 右键菜单和托盘菜单共用
function petSkinItems() {
  return PET_SKINS.map(([id, label]) => ({ label, type: 'radio', checked: config.petSkin === id, click: () => setPetSkin(id) }));
}
// 菜单上「今日计划」后面括号里的进度
function planLabel() {
  const mine = progress(journal.mine());
  return mine ? `${mine.done}/${mine.total}${mine.reviewed ? '，已复盘' : ''}` : '还没写';
}
// 右键小狗弹出来的菜单：常用的都直接放在这里（计划、统计、设置各一项，点了直接到面板的那一页），不用去找托盘图标
function showPetMenu() {
  if (!petWin || petWin.isDestroyed()) return;
  // 菜单里单个 & 会被当成快捷键标记
  const who = friend?.name ? ` ${friend.name.replace(/&/g, '&&')} ` : '搭子';
  Menu.buildFromTemplate([
    ...petViewItems(who),
    { label: '换个形象', submenu: petSkinItems() },
    { type: 'separator' },
    ...pomodoroItems(true),
    { type: 'separator' },
    { label: `今日计划（${planLabel()}）`, click: () => openPanel('plan') },
    { label: '统计', click: () => openPanel('stats') },
    { label: '设置', click: openSettings },
    { label: '打开面板', click: () => openPanel() },
    { type: 'separator' },
    { label: tracker.paused ? '▶ 恢复分享' : '⏸ 暂停分享（处理私事）', click: togglePause },
    // 托盘图标在 Win11 上默认收在「^」里不好找，任务栏图标的「关闭窗口」又只关设置之类的窗口，所以这里也要能关
    { label: `隐藏${petName()}（点托盘图标再叫出来）`, click: hidePet },
    { label: '退出 Buddy Pet', click: () => app.quit() },
  ]).popup({ window: petWin });
}
function hidePet() {
  if (petWin && !petWin.isDestroyed()) petWin.hide();
  updateTray(); // 托盘菜单里的「隐藏小狗」要换成「显示小狗」
}

function openSettings() {
  openPanel('settings');
}

function updateTray() {
  if (!tray) return;
  const label = { online: '已连接', connecting: '连接中…', error: '未连接', idle: '未连接' }[relay.state] || '';
  tray.setToolTip(`Buddy Pet · ${label}${tracker.paused ? ' · 已暂停分享' : ''}`);
  const pet = petName();
  if (trayIconSkin !== config.petSkin) {
    tray.setImage(trayImage()); // 托盘图标也跟着形象换
    trayIconSkin = config.petSkin;
  }
  // 常用的在右键小狗的菜单里；这里留着小狗藏起来时也得能点的，再加上不常用的（查新版本）
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: `状态：${label}${relay.state === 'error' && relay.lastError ? '（' + relay.lastError + '）' : ''}`, enabled: false },
      { type: 'separator' },
      { label: `打开面板（今日计划 ${planLabel()}）`, click: () => openPanel() },
      { type: 'separator' },
      ...pomodoroItems(false),
      {
        label: tracker.paused ? '▶ 恢复分享' : '⏸ 暂停分享（处理私事）',
        click: togglePause,
      },
      {
        label: `${petWin?.isVisible() ? '隐藏' : '显示'}${pet}`,
        click: () => {
          if (!petWin) createPetWindow();
          else if (petWin.isVisible()) petWin.hide();
          else petWin.showInactive();
          updateTray();
        },
      },
      { type: 'separator' },
      updateReady
        ? { label: `重启并更新到 ${updateReady}`, click: () => promptInstall(updateReady) }
        : { label: `检查更新（当前 ${app.getVersion()}）`, click: () => checkForUpdates(true) },
      { label: '退出', click: () => app.quit() },
    ])
  );
}

// 托盘图标：小狗用 tray.png，其他形象用 tray-名字.png；文件找不到就退回小狗的
function trayImage() {
  const file = (name) => nativeImage.createFromPath(path.join(__dirname, 'assets', name));
  const img = config.petSkin === 'dog' ? file('tray.png') : file(`tray-${config.petSkin}.png`);
  return img.isEmpty() ? file('tray.png') : img;
}
let trayIconSkin = null; // 托盘上现在挂的是哪个形象的图标
function createTray() {
  const img = trayImage();
  trayIconSkin = config.petSkin;
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
    `现在重启${petName()}就能用上（当前是 ${app.getVersion()}），设置和计划记录都会保留。\n选「稍后」的话，下次退出${petName()}时会自动装上。`,
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
    pushState(); // 面板的设置页上也显示「重启并更新」
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
// 面板的设置页里调的：大小、显示谁、换形象（原来在托盘菜单里）
ipcMain.on('pet:set-scale', (_e, scale) => setPetScale(Number(scale)));
ipcMain.on('pet:set-view', (_e, view) => setPetView(view));
ipcMain.on('pet:set-skin', (_e, skin) => setPetSkin(skin));
ipcMain.on('update:check', () => (updateReady ? promptInstall(updateReady) : checkForUpdates(true)));
ipcMain.on('panel:open', (_e, page) => openPanel(page));
// 提醒窗口里改了「再过 X 分钟提醒我」：只管下一次，从现在的连续摸鱼时长往后数
ipcMain.on('remind:next', (_e, minutes) => reminder.snooze(minutes, tracker.paused ? 0 : tracker.slackStreakSec));
// 「休息结束啦」窗口里的三个选择
ipcMain.on('pomodoro:start', startPomodoro); // 面板「今天」页上的按钮
ipcMain.on('pomodoro:skip', skipPomodoro);
ipcMain.on('pomodoro:resume', resumePomodoro);
ipcMain.on('pomodoro:rest', restMorePomodoro);
ipcMain.on('pomodoro:stop', stopPomodoro); // 「恢复默认模式」：不再用番茄钟计时
ipcMain.on('pomodoro:pause', pausePomodoro); // 严格模式：暂停 5 分钟
ipcMain.on('pomodoro:pause-more', pauseMorePomodoro); // 「5 分钟后再提醒」
ipcMain.on('pomodoro:continue', continuePomodoro); // 「继续专注」
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
    pomodoroStrict: next.pomodoroStrict === undefined ? config.pomodoroStrict : !!next.pomodoroStrict,
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
  updateTray(); // 菜单上写着番茄钟的时长；严格模式开着才有「暂停 5 分钟」
  // 设置是改一项存一次的：只有连接的四项变了才重连；设置页右上角的「连接」按钮（next.reconnect）是手动重连
  const newConn = [config.serverUrl, config.room, config.secret, config.name].join('|');
  if (newConn !== oldConn || next.reconnect) {
    friend = null;
    relay.connect(config);
  }
  pushState();
  return { ok: true };
});
ipcMain.handle('config:resetRules', () => DEFAULT_RULES);
ipcMain.on('open-settings', openSettings);

ipcMain.on('journal:open', (_e, mode) => {
  if (mode === 'tomorrow') return openTomorrowPlan();
  // 面板「计划」页里补昨天的复盘
  if (mode === 'review-yesterday') return openJournal('review', { date: addDays(localDate(), -1) });
  openJournal(['plan', 'review', 'view'].includes(mode) ? mode : 'plan');
});
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
// 「统计」页：某一天 / 某一周。今天的记录在 tracker 手里（还在往上加），以前的从归档里读
const statsSource = (date) => {
  const today = localDate();
  return {
    date: isDate(date) && date <= today ? date : today,
    today,
    loadRecord: (d) => (d === today ? tracker.dayRecord() : tracker.history.load(d)),
    loadJournal: (d) => journalStore.load(d),
  };
};
ipcMain.handle('stats:day', (_e, date) => buildDay(statsSource(date)));
ipcMain.handle('stats:week', (_e, date) => buildWeek(statsSource(date)));
ipcMain.on('toggle-pause', togglePause);

// ---------------- 启动 ----------------
app.on('second-instance', () => {
  if (petWin) petWin.show();
  openPanel();
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
