// 进程名 / 域名 → 给人看的名字。小狗卡片和「今日时长明细」窗口共用。
/* eslint-disable no-unused-vars */
const APP_NAMES = {
  chrome: 'Chrome', msedge: 'Edge', firefox: 'Firefox', code: 'VS Code', cursor: 'Cursor',
  winword: 'Word', excel: 'Excel', powerpnt: 'PowerPoint', onenote: 'OneNote', wechat: '微信',
  weixin: '微信', qq: 'QQ', explorer: '文件资源管理器', steam: 'Steam', steamwebhelper: 'Steam',
  notion: 'Notion', obsidian: 'Obsidian', windowsterminal: '终端', cmd: '命令行', powershell: 'PowerShell',
  idea64: 'IntelliJ IDEA', pycharm64: 'PyCharm', devenv: 'Visual Studio', cloudmusic: '网易云音乐',
  qqmusic: 'QQ音乐', feishu: '飞书', lark: '飞书', dingtalk: '钉钉', acrobat: 'Acrobat', zotero: 'Zotero',
  typora: 'Typora', spotify: 'Spotify', discord: 'Discord', yuanshen: '原神', leagueclient: '英雄联盟',
};
const SITE_NAMES = {
  'bilibili.com': '哔哩哔哩', 'claude.ai': 'Claude', 'chatgpt.com': 'ChatGPT', 'github.com': 'GitHub',
  'youtube.com': 'YouTube', 'douyin.com': '抖音', 'xiaohongshu.com': '小红书', 'weibo.com': '微博',
  'zhihu.com': '知乎', 'leetcode.cn': '力扣', 'leetcode.com': 'LeetCode', 'taobao.com': '淘宝',
  'stackoverflow.com': 'Stack Overflow', 'notion.so': 'Notion', 'overleaf.com': 'Overleaf',
};
function siteName(domain) {
  if (!domain) return '';
  for (const k of Object.keys(SITE_NAMES)) if (domain === k || domain.endsWith('.' + k)) return SITE_NAMES[k];
  return domain;
}
function appName(proc) {
  if (!proc) return '';
  return APP_NAMES[proc.toLowerCase()] || proc;
}
/** 明细里的一项（{ domain } 或 { app }）叫什么；认不出来返回空串 */
function entryName(e) {
  if (typeof e?.domain === 'string' && e.domain) return SITE_NAMES[e.domain] || e.domain;
  if (typeof e?.app === 'string' && e.app) return appName(e.app);
  return '';
}
