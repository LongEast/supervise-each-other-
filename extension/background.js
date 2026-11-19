// 只把「当前激活标签页的域名」发给本机 Buddy Pet，不发完整网址、不发标题、不发到外网。
const ENDPOINT = 'http://127.0.0.1:17321/tab';
const BROWSER = navigator.userAgent.includes('Edg/') ? 'edge' : 'chrome';

function domainOf(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.hostname : null;
  } catch {
    return null;
  }
}

let last = { domain: undefined, at: 0 };

async function report(force = false) {
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    const domain = tab && !tab.incognito ? domainOf(tab.url || tab.pendingUrl || '') : null;
    if (!force && domain === last.domain && Date.now() - last.at < 25_000) return;
    last = { domain, at: Date.now() };
    await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Buddy-Ext': '1' },
      body: JSON.stringify({ browser: BROWSER, domain }),
    });
  } catch {
    // 小狗没开就算了
  }
}

chrome.tabs.onActivated.addListener(() => report(true));
chrome.tabs.onUpdated.addListener((_id, info, tab) => {
  if (tab.active && (info.url || info.status === 'complete')) report(true);
});
chrome.windows.onFocusChanged.addListener((wid) => {
  if (wid !== chrome.windows.WINDOW_ID_NONE) report(true);
});

// 心跳：MV3 的 service worker 会休眠，用 alarms 每 30 秒唤醒一次
chrome.alarms.create('buddy-heartbeat', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((a) => a.name === 'buddy-heartbeat' && report(true));
chrome.runtime.onStartup.addListener(() => report(true));
chrome.runtime.onInstalled.addListener(() => report(true));
