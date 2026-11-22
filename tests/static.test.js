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

test('页面里用到的共享脚本都在它前面加载（names.js 给小狗和明细窗口提供应用 / 网站的名字）', () => {
  for (const [page, script] of [['pet.html', 'pet.js'], ['stats.html', 'stats.js']]) {
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
  assert.match(main, /submenu: petViewItems\(\)/); // 托盘菜单里也有入口，小狗隐藏时也能切
});

test('右键小狗的菜单里能隐藏和退出：不用去找托盘图标', () => {
  const main = read('main.js');
  const menu = main.slice(main.indexOf('function showPetMenu()'), main.indexOf('function openSettings()'));
  assert.match(menu, /label: '隐藏小狗[^']*', click: hidePet/);
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
  const html = read('renderer/settings.html');
  for (const id of ['slackRemind', 'slackRemindMinutes', 'slackRemindOptions', 'slackIdleMinutes']) {
    assert.match(html, new RegExp(`id="${id}"`));
    assert.match(read('renderer/settings.js'), new RegExp(`${id}: \\$\\('${id}'\\)`), `${id} 要随设置一起保存`);
  }
  assert.match(read('renderer/remind.html'), /<script src="remind\.js">/);
  assert.match(read('renderer/remind.js'), /buddy\.onRemind\(show\)/);
  assert.match(read('renderer/remind.js'), /buddy\.remindNext\(Number\(\$\('next'\)\.value\)\)/);
  // 设置页和主进程用同一份规则整理「可以选的时间」，reminder.js 要在 settings.js 前面加载
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

test('番茄钟：右键小狗开始，时长和「休息算不算学习」在设置里，到休息只冒气泡，休息结束还在摸鱼才弹窗', () => {
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
  // 弹窗只在 nudge（休息结束了还在摸鱼）时出现；到休息时间（break）走的是小狗气泡
  assert.match(main, /if \(events\.includes\('nudge'\)\) showRemindWindow\(\{ kind: 'focus',/);
  assert.equal(main.match(/showRemindWindow\(\{/g).length, 2); // 另一个是连续摸鱼提醒
  assert.match(main, /petWin\.webContents\.send\('pomodoro-event',/);
  // 休息时间怎么计时：勾了整段算学习，没勾的话休息时摸鱼不算摸鱼
  assert.match(main, /tracker\.setRest\(pomodoro\.phase === 'break' \? \(config\.pomodoroBreakCounts \? 'study' : 'free'\) : null\)/);
  assert.match(main, /saveConfig\(\);[\s\S]*?syncRest\(\);/); // 休息中途改了设置马上生效
  // 发给搭子的状态都带番茄钟（暂停分享时不带）
  assert.doesNotMatch(main, /status: tracker\.getStatus\(\)/);
  assert.match(main, /if \(s\.paused \|\| !pomodoro\.phase\) return s;/);

  const html = read('renderer/settings.html');
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

  // 「该专注啦」和「该学习啦」共用一个窗口
  const remind = read('renderer/remind.js');
  assert.match(remind, /const focus = kind === 'focus';/);
  assert.match(remind, /buddy\.stopPomodoro\(\)/);
  assert.match(read('renderer/remind.html'), /id="whatFocus"[^>]* hidden>/);
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
