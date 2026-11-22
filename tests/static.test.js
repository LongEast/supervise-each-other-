// 静态检查：这些问题只在真实 Windows 上才会暴露（主进程离不开 Electron，没法直接单测），用文本断言防止改回去
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'client', f), 'utf8');

test('小狗窗口不使用 -webkit-app-region: drag（会和鼠标穿透冲突，名牌抓不住）', () => {
  assert.doesNotMatch(read('renderer/pet.css'), /-webkit-app-region\s*:\s*drag/);
  assert.match(read('renderer/pet.js'), /buddy\.dragPet\('start'\)/);
  assert.match(read('renderer/pet.js'), /\$\('pet'\)\.addEventListener\('mousedown'/); // 小狗身上也能拖，不只是名牌
  assert.match(read('preload.js'), /dragPet:/);
  assert.match(read('main.js'), /ipcMain\.on\('pet:drag'/);
});

test('preload 暴露的每个 IPC 通道，主进程都有对应的处理', () => {
  const preload = read('preload.js');
  const main = read('main.js');
  const used = [...preload.matchAll(/ipcRenderer\.(send|invoke)\('([^']+)'/g)].map((m) => [m[1], m[2]]);
  assert.ok(used.length > 5);
  for (const [kind, ch] of used) {
    const re = new RegExp(`ipcMain\\.${kind === 'send' ? 'on' : 'handle'}\\('${ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`);
    assert.match(main, re, `主进程缺少 ${ch} 的处理`);
  }
});

test('通知用的 AppUserModelID 和打包配置里的 appId 一致（不一致的话安装版的通知会认不出应用）', () => {
  const pkg = JSON.parse(read('package.json'));
  const m = /const APP_ID = '([^']+)'/.exec(read('main.js'));
  assert.ok(m, 'main.js 里要有 APP_ID');
  assert.equal(m[1], pkg.build.appId);
  assert.match(read('main.js'), /app\.setAppUserModelId\(APP_ID\)/);
});

test('便携版启动时会补一个带 AppUserModelID 的开始菜单快捷方式（否则系统通知不显示应用名）', () => {
  const main = read('main.js');
  assert.match(main, /PORTABLE_EXECUTABLE_FILE/);
  assert.match(main, /writeShortcutLink\([^)]*appUserModelId: APP_ID/);
  assert.match(main, /whenReady\(\)\.then\(\(\) => \{\s*ensurePortableShortcut\(\);/);
});

test('打包工具用 electron-builder 26 以上（25 在没有管理员权限的 Windows 上解压 winCodeSign 会失败）', () => {
  const v = JSON.parse(read('package.json')).devDependencies['electron-builder'];
  assert.ok(Number(/(\d+)/.exec(v)[1]) >= 26, v);
});

test('便携版每次启动解压到各自的临时目录（共用一个目录的话，重复启动会把正在运行的那份文件删掉重写，新开的窗口样式全乱）', () => {
  assert.equal(JSON.parse(read('package.json')).build.portable.unpackDirName, true);
});

test('页面里用到的共享脚本都在它前面加载（names.js 给小狗和面板提供应用 / 网站的名字）', () => {
  for (const [page, script] of [['pet.html', 'pet.js'], ['panel.html', 'panel.js']]) {
    const html = read(`renderer/${page}`);
    const names = html.indexOf('<script src="names.js">');
    assert.ok(names > 0 && names < html.indexOf(`<script src="${script}">`), page);
  }
  assert.match(read('renderer/names.js'), /function entryName\(/);
  assert.doesNotMatch(read('renderer/pet.js'), /const APP_NAMES/); // 只留一份
  // pet-view.js 决定小狗演谁，pet.js 一加载就要用
  const pet = read('renderer/pet.html');
  const view = pet.indexOf('<script src="pet-view.js">');
  assert.ok(view > 0 && view < pet.indexOf('<script src="pet.js">'));
  assert.doesNotMatch(read('renderer/pet.js'), /function friendView\(/);
});

test('右键小狗能换成显示自己的状态：小狗和名牌都接了右键，主进程弹菜单并记住选择', () => {
  const pet = read('renderer/pet.js');
  assert.match(pet, /for \(const id of \['pet', 'nametag'\]\) \{\s*\$\(id\)\.addEventListener\('contextmenu'/);
  assert.match(pet, /buddy\.petMenu\(\)/);
  const main = read('main.js');
  assert.match(main, /ipcMain\.on\('pet:menu', showPetMenu\)/);
  assert.match(main, /petView: c\.petView === 'me' \? 'me' : 'friend'/); // 配置文件里是别的值就当默认
  assert.match(main, /petView: config\.petView,/); // 要推给小狗窗口
  // 小狗隐藏时也能切：面板的设置页里有（从托盘菜单的「打开面板」进）
  assert.match(main, /ipcMain\.on\('pet:set-view', \(_e, view\) => setPetView\(view\)\)/);
  assert.match(read('renderer/panel.js'), /seg\(\$\('petViewSeg'\),[^\n]*buddy\.setPetView\(v\)\)/);
});

test('换形象：右键菜单和面板的设置页里能选，选择会记住；每套形象都画齐了各个状态要用的部件', () => {
  const main = read('main.js');
  assert.match(main, /petSkin: 'dog',/); // 默认还是小狗
  assert.match(main, /petSkin: validSkin\(c\.petSkin\),/); // 配置文件里是不认识的名字就当默认
  assert.match(main, /petSkin: config\.petSkin,/); // 要推给小狗窗口
  const menu = main.slice(main.indexOf('function showPetMenu()'), main.indexOf('function hidePet()'));
  assert.match(menu, /submenu: petSkinItems\(\)/);
  // 小狗隐藏时也能换：面板的设置页里有，选项来自主进程推过来的 PET_SKINS
  assert.match(main, /ipcMain\.on\('pet:set-skin', \(_e, skin\) => setPetSkin\(skin\)\)/);
  assert.match(main, /skins: PET_SKINS,/);
  assert.match(read('renderer/panel.js'), /seg\(\$\('petSkinSeg'\),[^\n]*buddy\.setPetSkin\(id\)\)/);

  const skins = [...main.slice(main.indexOf('const PET_SKINS = ['), main.indexOf('const validSkin')).matchAll(/\['(\w+)', '[^']+'\]/g)].map((m) => m[1]);
  assert.deepEqual(skins, ['dog', 'cat']);
  const html = read('renderer/pet.html');
  const css = read('renderer/pet.css');
  assert.match(read('renderer/pet.js'), /document\.documentElement\.dataset\.skin = state\?\.petSkin \|\| 'dog';/);
  const starts = skins.map((id) => html.indexOf(`<g class="skin skin-${id}">`));
  skins.forEach((id, i) => {
    assert.ok(starts[i] > 0, `pet.html 里没有 ${id} 的形象`);
    // 状态和动作的样式是按这些 class 写的，少一个那个状态就演不出来
    const part = html.slice(starts[i], starts[i + 1] > 0 ? starts[i + 1] : html.indexOf('class="prop prop-zzz"'));
    for (const cls of ['pup', 'tail', 'head', 'eyes-open', 'eye', 'lid', 'eyes-closed', 'prop prop-laptop', 'prop prop-phone']) {
      assert.match(part, new RegExp(`class="${cls}[ "]`), `${id} 缺少 ${cls}`);
    }
    // 默认形象不用写规则，其他的都要有「选中才显示」
    if (id !== 'dog') assert.ok(css.includes(`[data-skin="${id}"] .skin-${id} { display: inline; }`), `${id} 选中后要显示出来`);
  });
  assert.match(css, /\.skin-cat, \[data-skin="cat"\] \.skin-dog \{ display: none; \}/); // 一次只显示一套
  assert.equal(html.match(/<svg /g).length, 1); // 两套画在同一个 #pet 里：拖动、滚轮、右键、点击都只接了它
});

test('换了形象以后称呼和托盘图标跟着换：菜单、气泡、通知里不再写死「小狗」', () => {
  const main = read('main.js');
  // 称呼取自 PET_SKINS 里的名字（去掉开头的表情），推给小狗窗口和设置页
  const names = [...main.slice(main.indexOf('const PET_SKINS = ['), main.indexOf('const validSkin')).matchAll(/\['(\w+)', '([^']+)'\]/g)].map((m) => m[2].replace(/^\S+ /, ''));
  assert.deepEqual(names, ['小狗', '小猫']);
  assert.match(main, /const petName = \(\) => PET_SKINS\.find\(\(\[id\]\) => id === config\.petSkin\)\[1\]\.replace\(\/\^\\S\+ \/, ''\);/);
  assert.match(main, /petName: petName\(\),/);
  // 界面上的字都不能再写死「小狗」：去掉注释以后，还带「小狗」的行只剩形象名字本身和没给名字时的默认值
  const lines = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.replace(/\/\/.*$/, '').trim()).filter((l) => l.includes('小狗'));
  assert.deepEqual(lines(main), ["['dog', '🐶 小狗'],"]);
  assert.deepEqual(lines(read('renderer/pet.js')), ["const petName = () => state?.petName || '小狗';"]);
  assert.match(read('renderer/pet.js'), /const petName = \(\) => state\?\.petName \|\| '小狗';/);
  // 面板（设置页在里面）的说明文字：写「小狗」的地方都包在 .pet-name 里，收到状态后改口
  const settings = read('renderer/panel.html');
  assert.equal(settings.match(/小狗/g).length, settings.match(/<span class="pet-name">小狗<\/span>/g).length);
  assert.match(read('renderer/settings.js'), /querySelectorAll\('\.pet-name'\)\) e\.textContent = s\.petName \|\| '小狗';/);
  // 托盘图标：每个形象一张，换形象时托盘跟着换
  assert.match(main, /tray\.setImage\(trayImage\(\)\);/);
  assert.ok(fs.existsSync(path.join(__dirname, '..', 'client', 'assets', 'tray.png')));
  for (const id of ['cat']) assert.ok(fs.existsSync(path.join(__dirname, '..', 'client', 'assets', `tray-${id}.png`)), `缺少 ${id} 的托盘图标`);
});

test('右键小狗的菜单里能隐藏和退出：不用去找托盘图标', () => {
  const main = read('main.js');
  const menu = main.slice(main.indexOf('function showPetMenu()'), main.indexOf('function openSettings()'));
  assert.match(menu, /label: `隐藏\$\{petName\(\)\}[^`]*`, click: hidePet/);
  assert.match(menu, /label: '退出 Buddy Pet', click: \(\) => app\.quit\(\)/);
  assert.match(menu, /function hidePet\(\) \{[^}]*petWin\.hide\(\);\s*updateTray\(\);/); // 托盘菜单要跟着换成「显示小狗」
});

test('连续摸鱼提醒：开关和时间在设置里，到点弹置顶窗口，不抢焦点', () => {
  const main = read('main.js');
  assert.match(main, /slackRemind: true,/); // 默认开，和以前一直开着的气泡提醒接上
  assert.match(main, /if \(r === 'due' && config\.slackRemind\) showSlackReminder\(/);
  assert.match(main, /else if \(r === 'reset'\) closeSlackReminder\(\);/); // 回去学习了窗口自己关
  assert.match(main, /ipcMain\.on\('remind:next', \(_e, minutes\) => reminder\.snooze\(/); // 窗口里选的「再过多久」
  assert.match(main, /remindWin\.setAlwaysOnTop\(true, 'screen-saver'\)/);
  assert.match(main, /remindWin\?\.showInactive\(\)/); // 用 show() 的话，正在打的字会落到提醒窗口上
  assert.doesNotMatch(main, /SELF_ALERT_MINUTES/); // 旧的固定 20/40/60 档已经并进来了
  const html = read('renderer/panel.html');
  for (const id of ['slackRemind', 'slackRemindMinutes', 'slackRemindOptions', 'slackIdleMinutes']) {
    assert.match(html, new RegExp(`id="${id}"`));
    assert.match(read('renderer/settings.js'), new RegExp(`${id}: \\$\\('${id}'\\)`), `${id} 要随设置一起保存`);
  }
  assert.match(read('renderer/remind.html'), /<script src="remind\.js">/);
  assert.match(read('renderer/remind.js'), /buddy\.onRemind\(show\)/);
  assert.match(read('renderer/remind.js'), /buddy\.remindNext\(Number\(\$\('next'\)\.value\)\)/);
  // 设置页（在面板里）和主进程用同一份规则整理「可以选的时间」，reminder.js 要在 settings.js 前面加载
  const reminderAt = html.indexOf('<script src="../reminder.js">');
  assert.ok(reminderAt > 0 && reminderAt < html.indexOf('<script src="settings.js">'));
  assert.match(read('reminder.js'), /if \(typeof module !== 'undefined'\) module\.exports/); // 页面里没有 module
  assert.match(read('preload.js'), /onRemind: on\('remind'\)/);
});

test('自动更新：从 GitHub Release 查新版本，安装版自动下载，便携版只提示去下载页', () => {
  const pkg = JSON.parse(read('package.json'));
  const pub = pkg.build.publish[0];
  assert.equal(pub.provider, 'github');
  assert.ok(pkg.dependencies['electron-updater'], 'electron-updater 要在 dependencies 里，放 devDependencies 不会被打进安装包');
  assert.match(pkg.scripts.dist, /--publish never/); // 打包只出文件，上传 Release 是另一步
  // 文件名不能带空格：GitHub 会把空格换成点，和 latest.yml 里记的名字对不上，更新就找不到安装包
  assert.equal(pkg.build.nsis.artifactName, 'Buddy-Pet-Setup-${version}.${ext}');
  assert.equal(pkg.build.portable.artifactName, 'Buddy-Pet-${version}-portable.${ext}');
  const main = read('main.js');
  const m = /const RELEASES_URL = 'https:\/\/github\.com\/([^/]+)\/([^/]+)\/releases\/latest'/.exec(main);
  assert.ok(m, 'main.js 里要有 RELEASES_URL');
  assert.deepEqual([m[1], m[2]], [pub.owner, pub.repo]);
  assert.match(main, /if \(!app\.isPackaged\) return;\s*updater = require\('electron-updater'\)\.autoUpdater;/); // npm start 时不查
  assert.match(main, /updater\.autoDownload = !isPortable;/);
  assert.match(main, /setInterval\(checkJournal, JOURNAL_CHECK_MS\);\s*setupUpdater\(\);/);
});

test('番茄钟：右键小狗开始，时长和「休息算不算学习」在设置里，到休息只冒气泡，休息结束弹窗等着点「重新开始」', () => {
  const main = read('main.js');
  // 默认 25 + 5，休息默认不算学习时间
  assert.match(main, /pomodoroFocusMinutes: POMO_FOCUS_DEFAULT,/);
  assert.match(main, /pomodoroBreakMinutes: POMO_BREAK_DEFAULT,/);
  assert.match(main, /pomodoroBreakCounts: false,/);
  assert.match(main, /pomodoroBreakCounts: c\.pomodoroBreakCounts === true,/); // 配置文件里是别的值就当没勾
  // 右键菜单里能开始 / 结束，托盘菜单里也有（小狗隐藏时也能用）
  assert.match(main, /\.\.\.pomodoroItems\(true\),[\s\S]*\]\)\.popup\(\{ window: petWin \}\)/);
  assert.match(main, /\.\.\.pomodoroItems\(false\),/);
  assert.match(main, /label: `🍅 开始番茄钟[^`]*`, click: startPomodoro/);
  assert.match(main, /label: '结束番茄钟', click: stopPomodoro/);
  // 弹窗只在 wait（休息结束）时出现；到休息时间（break）走的是小狗气泡
  assert.match(main, /if \(events\.includes\('wait'\)\) showRemindWindow\(\{ kind: 'focus',/);
  assert.equal(main.match(/showRemindWindow\(\{/g).length, 2); // 另一个是连续摸鱼提醒
  // 休息结束后三个选择：重新开始 / 再休息一会 / 恢复默认模式。弹窗、右键菜单、托盘菜单里都能选
  assert.match(main, /ipcMain\.on\('pomodoro:resume', resumePomodoro\)/);
  assert.match(main, /ipcMain\.on\('pomodoro:rest', restMorePomodoro\)/);
  assert.match(main, /label: `重新开始番茄钟[^`]*`, click: resumePomodoro/);
  assert.match(main, /label: `再休息一会[^`]*`, click: restMorePomodoro/);
  assert.match(main, /if \(kind !== 'wait'\) closeRemindWindow\('focus'\);/); // 选完（或者番茄钟自己停了）窗口跟着关
  // 「休息结束啦」要等着选：回去学习不会把它关掉，摸鱼提醒也不会把它顶掉
  assert.match(main, /function closeSlackReminder\(\) \{\s*closeRemindWindow\('slack'\);/);
  assert.match(main, /if \(remindWin && !remindWin\.isDestroyed\(\) && remindKind === 'focus'\) return;\s*showRemindWindow\(\{/);
  assert.match(main, /petWin\.webContents\.send\('pomodoro-event',/);
  // 休息时间怎么计时：勾了整段算学习，没勾的话休息时摸鱼不算摸鱼
  assert.match(main, /tracker\.setRest\(pomodoro\.phase === 'break' \? \(config\.pomodoroBreakCounts \? 'study' : 'free'\) : null\)/);
  assert.match(main, /saveConfig\(\);[\s\S]*?syncRest\(\);/); // 休息中途改了设置马上生效
  // 发给搭子的状态都带番茄钟（暂停分享时不带）
  assert.doesNotMatch(main, /status: tracker\.getStatus\(\)/);
  assert.match(main, /if \(s\.paused \|\| !pomodoro\.phase\) return s;/);

  const html = read('renderer/panel.html');
  const js = read('renderer/settings.js');
  for (const id of ['pomodoroFocusMinutes', 'pomodoroBreakMinutes', 'pomodoroBreakCounts']) {
    assert.match(html, new RegExp(`id="${id}"`));
    assert.match(js, new RegExp(`${id}: \\$\\('${id}'\\)`), `${id} 要随设置一起保存`);
    assert.match(main, new RegExp(`${id}: [^\\n]*next\\.${id}`), `${id} 保存时主进程要收下`);
  }

  // 小狗窗口：倒计时、卡片上的一行、气泡
  const pet = read('renderer/pet.js');
  assert.match(read('renderer/pet.html'), /id="pomo"/);
  assert.match(read('renderer/pet.html'), /id="cardPomo"/);
  assert.match(pet, /buddy\.onPomodoro\(/);
  assert.match(pet, /setInterval\(renderPomo, 1000\)/);
  assert.match(read('renderer/pet.css'), /\.pomo \{[^}]*pointer-events: none;/); // 倒计时不挡鼠标，不然小狗那一角点不到
  assert.match(read('preload.js'), /onPomodoro: on\('pomodoro-event'\)/);

  // 「休息结束啦」和「该学习啦」共用一个窗口
  const remind = read('renderer/remind.js');
  const remindHtml = read('renderer/remind.html');
  assert.match(remind, /const focus = kind === 'focus';/);
  assert.match(remind, /buddy\.resumePomodoro\(\)/);
  assert.match(remind, /buddy\.restMorePomodoro\(\)/);
  assert.match(remind, /buddy\.stopPomodoro\(\)/);
  assert.match(remindHtml, /id="whatFocus"[^>]* hidden>/);
  // 「再休息一会」藏在小箭头后面，默认收着
  for (const id of ['resume', 'more', 'restMore']) assert.match(remindHtml, new RegExp(`<button id="${id}"[^>]* hidden>`));
  assert.match(remindHtml, /id="stopPomodoro">恢复默认模式</);
  // 小狗：等着点的时候倒计时那里显示「等你开始」，搭子的卡片上也有一行
  assert.match(pet, /if \(p\.phase === 'wait'\)/);
  assert.match(pet, /pomo\?\.phase === 'wait'/);
});

test('面板：一个窗口四页（今天 / 统计 / 计划 / 设置）；常用的入口在右键小狗的菜单里，托盘菜单留不常用的', () => {
  const main = read('main.js');
  const html = read('renderer/panel.html');
  const js = read('renderer/panel.js');
  // 原来单独的设置窗口和「今日时长明细」窗口都并进来了
  for (const f of ['settings.html', 'stats.html', 'stats.js', 'stats.css']) assert.ok(!fs.existsSync(path.join(__dirname, '..', 'client', 'renderer', f)), `${f} 应该已经删掉`);
  assert.doesNotMatch(main, /settingsWin|statsWin/);
  assert.match(main, /panelWin\.loadFile\(path\.join\(__dirname, 'renderer', 'panel\.html'\), \{ query: go \}\)/);
  assert.match(main, /useContentSize: true,/); // 960×620 说的是页面，不含标题栏
  assert.match(main, /panelWin\.webContents\.send\('panel-go', go\)/); // 已经开着就切页，不开第二个
  assert.match(main, /if \(panelWin && !panelWin\.isDestroyed\(\)\) panelWin\.webContents\.send\('state', viewState\(\)\);/);
  assert.match(main, /function openSettings\(\) \{\s*openPanel\('settings'\);/); // 第一次打开、小狗卡片上的「设置」
  for (const p of ['today', 'stats', 'plan', 'settings']) {
    assert.match(html, new RegExp(`<section id="page-${p}"`));
    assert.match(html, new RegExp(`class="nav[^"]*" data-page="${p}"`));
  }
  // 设置页的表单还是 settings.js 管，所以它要的元素都得在；panel.js 整个包在函数里，不和它的全局名字撞
  for (const id of ['form', 'saved', 'connPill', 'friendPill', 'extPill', 'history', 'resetRules', 'serverUrl', 'room', 'secret', 'name', 'openAtLogin', 'planTime', 'reviewTime']) {
    assert.match(html, new RegExp(`id="${id}"`), `面板里缺少 ${id}`);
  }
  assert.ok(html.indexOf('<script src="settings.js">') < html.indexOf('<script src="panel.js">'));
  assert.match(js, /^\(\(\) => \{$/m);
  assert.match(html, /<button type="submit" form="form"/); // 保存按钮在页面右上角，不在表单里面

  // 托盘菜单：状态、打开面板、番茄钟、暂停分享、隐藏 / 显示（小狗藏起来时只能从这里叫出来）、检查更新、退出
  const tray = main.slice(main.indexOf('function updateTray()'), main.indexOf('function trayImage()'));
  assert.match(tray, /label: `打开面板（今日计划 \$\{planLabel\(\)\}）`, click: \(\) => openPanel\(\)/);
  assert.match(tray, /updateReady\s*\? \{ label: `重启并更新到 \$\{updateReady\}`[^\n]*\n\s*: \{ label: `检查更新[^`]*`, click: \(\) => checkForUpdates\(true\) \},/);
  assert.doesNotMatch(tray, /submenu:|openJournal|设置…/);
  assert.equal(tray.match(/label:/g).length, 7); // 番茄钟那几项是 pomodoroItems() 给的，不算在里面
  // 搬走的几项在面板里都有地方点
  for (const [ch, fn] of [['pet:set-scale', 'setPetScale'], ['update:check', 'checkForUpdates'], ['pomodoro:start', 'startPomodoro'], ['pomodoro:skip', 'skipPomodoro']]) {
    assert.match(main, new RegExp(`ipcMain\\.on\\('${ch}',[^\\n]*${fn}`));
  }
  assert.match(js, /buddy\.checkUpdate\(\)/);
  // 右键小狗的菜单：计划、统计、设置各一项，点了直接到面板的那一页，不用去找托盘图标
  const menu = main.slice(main.indexOf('function showPetMenu()'), main.indexOf('function hidePet()'));
  assert.match(menu, /label: `今日计划（\$\{planLabel\(\)\}）`, click: \(\) => openPanel\('plan'\)/);
  assert.match(menu, /label: '统计', click: \(\) => openPanel\('stats'\)/);
  assert.match(menu, /label: '设置', click: openSettings/);
  assert.match(menu, /label: '打开面板', click: \(\) => openPanel\(\)/);
});

test('统计：每天的时长、按小时的分布、番茄数、搭子的时长都记下来，面板按天 / 按周看', () => {
  const main = read('main.js');
  const activity = read('activity.js');
  assert.match(activity, /this\.history\.save\(this\.today\); \/\/ 过完的这一天归档/);
  assert.match(activity, /if \(t\) this\.history\.save\(t\);/); // 上次退出后跨了天，启动时补归档
  assert.match(activity, /this\.today\.hours\[c\]\[hour\] \+= dt;/);
  // 完整专注完一个番茄才记；手动跳过的不经过 tick 的 'break' 事件
  assert.match(main, /if \(events\.includes\('break'\)\) tracker\.addPomodoro\(focusMinutes\);/);
  assert.match(main, /if \(st\?\.todaySec\) tracker\.setFriendDay\(friend\.name, st\.todaySec, st\.breakdown\);/);
  // 今天的从 tracker 拿（还在往上加），以前的从归档里读；日期乱填或者填了以后的日子都当今天
  assert.match(main, /date: isDate\(date\) && date <= today \? date : today,/);
  assert.match(main, /loadRecord: \(d\) => \(d === today \? tracker\.dayRecord\(\) : tracker\.history\.load\(d\)\),/);
  assert.match(main, /ipcMain\.handle\('stats:day', \(_e, date\) => buildDay\(statsSource\(date\)\)\)/);
  assert.match(main, /ipcMain\.handle\('stats:week', \(_e, date\) => buildWeek\(statsSource\(date\)\)\)/);
  const js = read('renderer/panel.js');
  assert.match(js, /buddy\.statsWeek\(stats\.date\) : buddy\.statsDay\(stats\.date\)/);
  // 对方发来的名字、域名、计划内容只当文本：面板里不拼 HTML
  assert.doesNotMatch(js, /innerHTML|insertAdjacentHTML|outerHTML/);
});

test('发版：推 v 开头的 tag 后由 GitHub Actions 打包并发 Release，自动更新要的四个文件都传上去', () => {
  const root = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
  const wf = root('.github/workflows/release.yml');
  assert.match(wf, /tags: \['v\*'\]/);
  assert.match(wf, /"v\$version" != "\$GITHUB_REF_NAME"/); // tag 和 package.json 的版本对不上就不发
  assert.match(wf, /needs: test/); // 测试没过不打包
  assert.match(wf, /runs-on: windows-latest/);
  assert.match(wf, /npm run dist/);
  for (const f of ['Buddy-Pet-Setup-$version.exe"', 'Buddy-Pet-Setup-$version.exe.blockmap"', 'Buddy-Pet-$version-portable.exe"', 'client/dist/latest.yml']) {
    assert.ok(wf.includes(f), `Release 里要有 ${f}`);
  }
  // 浏览器插件的 ZIP：装安装版的人没有源码，README 里的下载链接指向它，名字不能带版本号
  assert.match(wf, /Compress-Archive -Path extension\/\* -DestinationPath client\/dist\/Buddy-Pet-Extension\.zip/);
  assert.match(wf, /client\/dist\/latest\.yml \\\s+client\/dist\/Buddy-Pet-Extension\.zip/);
  assert.match(root('README.md'), /releases\/latest\/download\/Buddy-Pet-Extension\.zip/);
  assert.match(root('README.md'), /chrome:\/\/extensions[\s\S]*开发者模式[\s\S]*manifest\.json/);
  // Release 说明取自 CHANGELOG.md 里这一版的那一节；现在这一版要写了才算数
  const { changelogSection, releaseNotes } = require('../.github/release-notes');
  assert.equal(changelogSection('# 记录\n说明\n## 1.1.0\n- 新的\n\n## 1.0.0\n- 旧的\n', '1.1.0'), '- 新的');
  assert.equal(changelogSection('## v1.0.0\r\n- a\r\n', '1.0.0'), '- a');
  assert.equal(changelogSection('## 1.0.0\n- a', '1.0.1'), '');
  assert.match(releaseNotes('9.9.9', ''), /Buddy-Pet-Setup-9\.9\.9\.exe[\s\S]*提交记录/); // 忘了写也能发，只是没有具体内容
  const version = JSON.parse(read('package.json')).version;
  assert.ok(changelogSection(root('CHANGELOG.md'), version), `CHANGELOG.md 里还没有 ${version} 这一节`);
});
