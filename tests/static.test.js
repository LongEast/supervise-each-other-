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
