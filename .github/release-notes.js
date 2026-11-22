// 生成 GitHub Release 的说明：固定的下载说明 + CHANGELOG.md 里这一版的那一节。
// 用法：node .github/release-notes.js 0.1.2 > release-notes.md
const fs = require('fs');
const path = require('path');

/** 从更新记录里取出某一版（「## 0.1.2」到下一个「## 」之间）的内容；没有返回空串 */
function changelogSection(changelog, version) {
  const out = [];
  let on = false;
  for (const line of String(changelog).split(/\r?\n/)) {
    const m = /^##\s+v?(\S+)/.exec(line);
    if (m) on = m[1] === version;
    else if (on) out.push(line);
  }
  return out.join('\n').trim();
}

function releaseNotes(version, changelog) {
  const changes = changelogSection(changelog, version) || '见[提交记录](https://github.com/LongEast/supervise-each-other-/commits/main)。';
  return `桌面小狗 Buddy Pet 的 Windows 客户端，两个人都要装。

## 下载哪个

- **Buddy-Pet-Setup-${version}.exe**：安装版，推荐。已经装了安装版的不用下载，小狗会自己更新（托盘菜单里的「检查更新」可以手动查）。
- **Buddy-Pet-${version}-portable.exe**：便携版，双击直接运行，不用安装。它不能自动更新，有新版本时只会提示你来这里重新下载。

\`latest.yml\` 和 \`.blockmap\` 是自动更新用的，不用下载。

安装包没有代码签名，第一次运行时 Windows 可能提示「Windows 已保护你的电脑」，点「更多信息」→「仍要运行」。

## 这一版的变化

${changes}

完整说明见 [README](https://github.com/LongEast/supervise-each-other-#readme)。
`;
}

if (require.main === module) {
  const version = process.argv[2];
  if (!/^\d+\.\d+\.\d+/.test(version || '')) {
    console.error('用法：node .github/release-notes.js <版本号>');
    process.exit(1);
  }
  process.stdout.write(releaseNotes(version, fs.readFileSync(path.join(__dirname, '..', 'CHANGELOG.md'), 'utf8')));
}

module.exports = { changelogSection, releaseNotes };
