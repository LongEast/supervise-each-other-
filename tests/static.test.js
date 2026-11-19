// 静态检查：这些问题只在真实 Windows 上才会暴露（主进程离不开 Electron，没法直接单测），用文本断言防止改回去
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'client', f), 'utf8');

test('小狗窗口不使用 -webkit-app-region: drag（会和鼠标穿透冲突，名牌抓不住）', () => {
  assert.doesNotMatch(read('renderer/pet.css'), /-webkit-app-region\s*:\s*drag/);
  assert.match(read('renderer/pet.js'), /buddy\.dragPet\('start'\)/);
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
