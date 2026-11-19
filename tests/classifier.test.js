const test = require('node:test');
const assert = require('node:assert/strict');
const { classify, isBrowser, domainMatches, DEFAULT_RULES } = require('../client/classifier');

test('域名匹配：子域名、www、通配前缀', () => {
  assert.ok(domainMatches('www.bilibili.com', 'bilibili.com'));
  assert.ok(domainMatches('live.bilibili.com', '*.bilibili.com'));
  assert.ok(domainMatches('cs.stanford.edu', 'edu'));
  assert.ok(!domainMatches('notbilibili.com', 'bilibili.com'));
  assert.ok(!domainMatches('', 'bilibili.com'));
});

test('浏览器识别不区分大小写和 .exe', () => {
  assert.ok(isBrowser('chrome'));
  assert.ok(isBrowser('MSEDGE.EXE'));
  assert.ok(!isBrowser('Code'));
});

test('有域名时按域名分类', () => {
  assert.equal(classify({ proc: 'chrome', domain: 'www.bilibili.com' }), 'slack');
  assert.equal(classify({ proc: 'msedge', domain: 'claude.ai' }), 'study');
  assert.equal(classify({ proc: 'chrome', domain: 'example.com' }), 'neutral');
});

test('应用按进程名分类', () => {
  assert.equal(classify({ proc: 'Code', title: 'main.py' }), 'study');
  assert.equal(classify({ proc: 'steam' }), 'slack');
  assert.equal(classify({ proc: 'WeChat', title: '微信' }), 'neutral');
});

test('没有插件时靠窗口标题兜底；有域名时不看标题', () => {
  assert.equal(classify({ proc: 'chrome', title: '哔哩哔哩 (゜-゜)つロ 干杯~-bilibili', domain: null }), 'slack');
  assert.equal(classify({ proc: 'chrome', title: 'GitHub - foo/bar' }), 'study');
  assert.equal(classify({ proc: 'chrome', title: '哔哩哔哩', domain: 'example.com' }), 'neutral');
});

test('隐私规则优先于其他规则', () => {
  const rules = { ...DEFAULT_RULES, private: { domains: ['bilibili.com'], apps: ['steam'] } };
  assert.equal(classify({ proc: 'chrome', domain: 'www.bilibili.com' }, rules), 'private');
  assert.equal(classify({ proc: 'Steam.exe' }, rules), 'private');
});
