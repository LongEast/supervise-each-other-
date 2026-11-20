// Buddy Pet — Electron 主进程
const { app, BrowserWindow, Tray, Menu, ipcMain, Notification, screen, nativeImage, shell } = require('electron');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { ActivityTracker, localDate } = require('./activity');
const { RelayClient } = require('./relay');
const { DEFAULT_RULES } = require('./classifier');
const { JournalStore, JournalSync, duePrompt, markPrompted, snooze, snoozesLeft, progress, toMinutes, isDate, addDays } = require('./journal');

const APP_ID = 'com.buddypet.app'; // 要和 package.json 里的 build.appId 一致
const EXT_PORT = 17321;
const STATUS_HEARTBEAT_MS = 30_000;
const SELF_ALERT_MINUTES = [20, 40, 60, 90, 120];
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
  openAtLogin: false,
  planTime: '09:00', // 计划提醒时间
  reviewTime: '22:00', // 复盘提醒时间
  rules: DEFAULT_RULES,
  petPos: null,
};

function loadConfig() {
  try {
    const c = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    return { ...DEFAULT_CONFIG, ...c, rules: { ...DEFAULT_RULES, ...(c.rules || {}) } };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}
function saveConfig() {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
}
let config = loadConfig();

// ---------------- 状态 ----------------
const relay = new RelayClient();
const tracker = new ActivityTracker({
  dataDir,
  getRules: () => config.rules,
  getSettings: () => ({ idleMinutes: config.idleMinutes }),
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
let tray = null;
let selfAlertIdx = 0;

function viewState() {
  return {
    // todaySec / breakdown 是给自己看的，暂停分享时也有
    me: { name: config.name, status: tracker.getStatus(), todaySec: tracker.todaySec(), breakdown: tracker.breakdown() },
    friend,
    friendJournal: friend ? progress(journal.friendToday(friend.name, friend.online)) : null, // { total, done, reviewed }，没写计划是 null
    connection: { state: relay.state, error: relay.lastError },
    extConnected: tracker.extConnected(),
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
  statusDebounce = setTimeout(() => relay.send({ type: 'status', status: tracker.getStatus() }), 1500);
}
setInterval(() => relay.send({ type: 'status', status: tracker.getStatus() }), STATUS_HEARTBEAT_MS);

let wasPaused = false;
tracker.on('change', () => {
  if (wasPaused && !tracker.paused) journal.flush(); // 恢复分享：把暂停期间的计划变化补发给对方
  wasPaused = tracker.paused;
  sendStatusSoon();
  pushState();
});
tracker.on('tick', (s) => {
  // 自己摸鱼太久，小狗先提醒一下
  if (s.paused) return;
  const min = (s.slackStreakSec || 0) / 60;
  if (min < SELF_ALERT_MINUTES[0]) selfAlertIdx = 0;
  else if (selfAlertIdx < SELF_ALERT_MINUTES.length && min >= SELF_ALERT_MINUTES[selfAlertIdx]) {
    petWin?.webContents.send('self-alert', { minutes: SELF_ALERT_MINUTES[selfAlertIdx], friend: friend?.name || '' });
    selfAlertIdx++;
  }
});

// ---------------- 服务器消息 ----------------
relay.on('state', () => {
  if (relay.state === 'online') {
    relay.send({ type: 'status', status: tracker.getStatus() });
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
const PET_W = 280;
const PET_H = 380;

function createPetWindow() {
  const wa = screen.getPrimaryDisplay().workArea;
  const pos = config.petPos || { x: wa.x + wa.width - PET_W - 24, y: wa.y + wa.height - PET_H };
  petWin = new BrowserWindow({
    width: PET_W,
    height: PET_H,
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
        click: () => {
          tracker.setPaused(!tracker.paused);
          updateTray();
        },
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
      { type: 'separator' },
      { label: `今日计划${planLabel}`, click: () => openJournal('plan') },
      { label: `明日计划${tomorrowLabel}`, click: openTomorrowPlan },
      { label: '今日复盘', click: () => openJournal('review', { date: journal.reviewDate() }) },
      { label: '今日时长明细', click: () => openStats() },
      { type: 'separator' },
      { label: '设置…', click: openSettings },
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
  // 带上固定宽高：缩放不是 100% 时反复 setPosition 会让窗口越拖越大
  petWin.setBounds({ x: dragFrom.x + cur.x - dragFrom.cx, y: dragFrom.y + cur.y - dragFrom.cy, width: PET_W, height: PET_H });
  if (phase === 'end') {
    dragFrom = null;
    const [x, y] = petWin.getPosition();
    config.petPos = { x, y };
    saveConfig();
  }
});
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
    openAtLogin: !!next.openAtLogin,
    rules: next.rules || config.rules,
  };
  // 复盘时间要晚于计划时间，否则保持原来的
  if (toMinutes(next.planTime) < toMinutes(next.reviewTime)) Object.assign(config, { planTime: next.planTime, reviewTime: next.reviewTime });
  saveConfig();
  if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: config.openAtLogin });
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
ipcMain.on('toggle-pause', () => {
  tracker.setPaused(!tracker.paused);
  updateTray();
});

// ---------------- 启动 ----------------
app.on('second-instance', () => {
  if (petWin) petWin.show();
  openSettings();
});
app.on('window-all-closed', (e) => e.preventDefault()); // 托盘常驻
app.on('before-quit', () => tracker.stop());

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
});
