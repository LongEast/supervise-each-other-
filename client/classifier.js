// 把「当前前台应用 + 网址」归类为：study / slack / neutral / private
// 纯函数，方便测试和以后扩展。
// neutral = 哪个名单都不在。计时的时候它按学习算（见 activity.js），和 study 的区别只是不会清零连续摸鱼。

const BROWSERS = new Set([
  'chrome', 'msedge', 'firefox', 'brave', 'opera', 'vivaldi', 'arc',
  '360se', '360chrome', 'qqbrowser', 'sogouexplorer', 'liebao',
]);

const DEFAULT_RULES = {
  study: {
    domains: [
      'claude.ai', 'chatgpt.com', 'gemini.google.com', 'chat.deepseek.com', 'kimi.com',
      'github.com', 'gitlab.com', 'stackoverflow.com', 'leetcode.com', 'leetcode.cn',
      'notion.so', 'docs.google.com', 'overleaf.com', 'arxiv.org', 'scholar.google.com',
      'developer.mozilla.org', 'docs.python.org', 'coursera.org', 'edu', 'edu.au', 'edu.cn',
    ],
    apps: [
      'code', 'cursor', 'devenv', 'idea64', 'pycharm64', 'webstorm64', 'clion64',
      'winword', 'excel', 'powerpnt', 'onenote', 'notion', 'obsidian', 'typora',
      'acrobat', 'acrord32', 'zotero', 'windowsterminal', 'cmd', 'powershell', 'pwsh',
    ],
    keywords: ['Claude', 'ChatGPT', 'GitHub', 'Stack Overflow', 'LeetCode', '力扣', 'Overleaf', 'Notion'],
  },
  slack: {
    domains: [
      'bilibili.com', 'douyin.com', 'xiaohongshu.com', 'weibo.com', 'zhihu.com',
      'youtube.com', 'tiktok.com', 'x.com', 'twitter.com', 'instagram.com', 'reddit.com',
      'netflix.com', 'iqiyi.com', 'v.qq.com', 'youku.com', 'huya.com', 'douyu.com',
      'twitch.tv', 'taobao.com', 'tmall.com', 'jd.com',
    ],
    apps: ['steam', 'steamwebhelper', 'yuanshen', 'genshinimpact', 'leagueclient', 'league of legends', 'douyin', 'bilibili'],
    keywords: ['哔哩哔哩', 'bilibili', 'YouTube', '抖音', '小红书', '微博', '知乎', 'Netflix', '淘宝'],
  },
  // 这里列出的网站/应用不会上报具体名字，只显示「隐私」
  private: {
    domains: [],
    apps: [],
  },
};

const norm = (s) => String(s || '').trim().toLowerCase();

function domainMatches(domain, rule) {
  const d = norm(domain).replace(/^www\./, '');
  const r = norm(rule).replace(/^\*\./, '').replace(/^www\./, '');
  if (!d || !r) return false;
  return d === r || d.endsWith('.' + r);
}

function listHasDomain(list, domain) {
  return (list || []).some((r) => domainMatches(domain, r));
}

function listHasApp(list, proc) {
  const p = norm(proc).replace(/\.exe$/, '');
  return (list || []).some((a) => norm(a).replace(/\.exe$/, '') === p);
}

function listHasKeyword(list, title) {
  const t = String(title || '').toLowerCase();
  return (list || []).some((k) => k && t.includes(String(k).toLowerCase()));
}

function isBrowser(proc) {
  return BROWSERS.has(norm(proc).replace(/\.exe$/, ''));
}

/**
 * @param {{proc:string, title?:string, domain?:string|null}} a
 * @param {typeof DEFAULT_RULES} rules
 * @returns {'study'|'slack'|'neutral'|'private'}
 */
function classify(a, rules = DEFAULT_RULES) {
  const browser = isBrowser(a.proc);
  const domain = browser ? a.domain : null;

  if (listHasApp(rules.private?.apps, a.proc)) return 'private';
  if (domain && listHasDomain(rules.private?.domains, domain)) return 'private';

  if (domain) {
    if (listHasDomain(rules.slack?.domains, domain)) return 'slack';
    if (listHasDomain(rules.study?.domains, domain)) return 'study';
  }
  if (!browser) {
    if (listHasApp(rules.slack?.apps, a.proc)) return 'slack';
    if (listHasApp(rules.study?.apps, a.proc)) return 'study';
  }
  // 没有插件时，靠窗口标题兜底（标题只在本地用，不上报）
  if (!domain) {
    if (listHasKeyword(rules.slack?.keywords, a.title)) return 'slack';
    if (listHasKeyword(rules.study?.keywords, a.title)) return 'study';
  }
  return 'neutral';
}

module.exports = { classify, isBrowser, domainMatches, DEFAULT_RULES };
