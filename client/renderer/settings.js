/* global buddy, journalView, journalProgress */
const $ = (id) => document.getElementById(id);
const toText = (arr) => (arr || []).join('\n');
const toList = (text) =>
  String(text || '')
    .split(/[\n,，]/)
    .map((s) => s.trim())
    .filter(Boolean);

let current = null;

function fillRules(rules) {
  $('studyDomains').value = toText(rules.study?.domains);
  $('slackDomains').value = toText(rules.slack?.domains);
  $('studyApps').value = toText(rules.study?.apps);
  $('slackApps').value = toText(rules.slack?.apps);
  $('privateDomains').value = toText(rules.private?.domains);
  $('privateApps').value = toText(rules.private?.apps);
}

async function load() {
  current = await buddy.getConfig();
  $('serverUrl').value = current.serverUrl || '';
  $('room').value = current.room || '';
  $('secret').value = current.secret || '';
  $('name').value = current.name || '';
  $('idleMinutes').value = current.idleMinutes || 5;
  $('slackIdleMinutes').value = current.slackIdleMinutes || 20;
  $('slackRemind').checked = current.slackRemind !== false;
  $('slackRemindMinutes').value = current.slackRemindMinutes || 20;
  $('openAtLogin').checked = !!current.openAtLogin;
  $('planTime').value = current.planTime || '09:00';
  $('reviewTime').value = current.reviewTime || '22:00';
  fillRules(current.rules || {});
}

$('resetRules').addEventListener('click', async () => {
  fillRules(await buddy.defaultRules());
});

$('form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const rules = {
    study: { ...(current.rules?.study || {}), domains: toList($('studyDomains').value), apps: toList($('studyApps').value) },
    slack: { ...(current.rules?.slack || {}), domains: toList($('slackDomains').value), apps: toList($('slackApps').value) },
    private: { domains: toList($('privateDomains').value), apps: toList($('privateApps').value) },
  };
  if ($('planTime').value >= $('reviewTime').value) {
    $('saved').className = 'bad';
    $('saved').textContent = '复盘提醒时间要晚于计划提醒时间';
    return;
  }
  $('saved').className = '';
  await buddy.saveConfig({
    serverUrl: $('serverUrl').value,
    room: $('room').value,
    secret: $('secret').value,
    name: $('name').value,
    idleMinutes: $('idleMinutes').value,
    slackIdleMinutes: $('slackIdleMinutes').value,
    slackRemind: $('slackRemind').checked,
    slackRemindMinutes: $('slackRemindMinutes').value,
    openAtLogin: $('openAtLogin').checked,
    planTime: $('planTime').value,
    reviewTime: $('reviewTime').value,
    rules,
  });
  current = await buddy.getConfig();
  // 主进程会把不合法的数字改掉（比如摸鱼时的空闲时间填得比平时短），把实际存下的显示出来
  $('slackIdleMinutes').value = current.slackIdleMinutes;
  $('slackRemindMinutes').value = current.slackRemindMinutes;
  $('saved').textContent = '已保存 ✓';
  setTimeout(() => ($('saved').textContent = ''), 2500);
});

buddy.onState((s) => {
  const c = s.connection || {};
  const conn = $('connPill');
  conn.textContent = '服务器：' + ({ online: '已连接', connecting: '连接中…' }[c.state] || (c.error ? '未连接（' + c.error + '）' : '未连接'));
  conn.className = 'pill ' + (c.state === 'online' ? 'ok' : c.state === 'connecting' ? '' : 'bad');
  const f = $('friendPill');
  f.textContent = '搭子：' + (s.friend ? `${s.friend.name}（${s.friend.online ? '在线' : '离线'}）` : '还没加入');
  f.className = 'pill ' + (s.friend?.online ? 'ok' : '');
  const x = $('extPill');
  x.textContent = '浏览器插件：' + (s.extConnected ? '已连接' : '未检测到');
  x.className = 'pill ' + (s.extConnected ? 'ok' : 'bad');
});

// ---------- 最近 7 天的计划和复盘 ----------
const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
function el(tag, className, text = '') {
  const e = document.createElement(tag);
  e.className = className;
  e.textContent = text;
  return e;
}
function ratePill(who, j) {
  const p = journalProgress(j);
  return el('span', 'pill' + (p ? (p.pct === 100 ? ' ok' : '') : ''), p ? `${who} ${p.text}（${p.pct}%）` : `${who} 没写`);
}
async function loadHistory() {
  const { today, days } = await buddy.journalHistory();
  const opened = new Set([...document.querySelectorAll('details.day[open]')].map((d) => d.dataset.date));
  $('history').replaceChildren(
    ...days.map((day) => {
      const [y, m, d] = day.date.split('-').map(Number);
      const future = day.date > today;
      const friendName = day.friend?.name || '搭子';
      const summary = el('summary', '');
      const rate = el('span', 'rate');
      const cols = el('div', 'cols');
      if (future) {
        // 明天：还谈不上完成率，只显示写没写；对方的要到明天才看得到
        const n = journalProgress(day.me)?.total;
        rate.append(el('span', 'pill' + (n ? ' ok' : ''), n ? `我 已写 ${n} 条` : '我 还没写'));
        const col = el('div', '');
        const btn = el('button', 'ghost', n ? '修改明天的计划' : '提前写明天的计划');
        btn.type = 'button';
        btn.addEventListener('click', () => buddy.openJournal('tomorrow'));
        if (n) col.append(journalView(day.me));
        col.append(btn);
        cols.append(col);
      } else {
        rate.append(ratePill('我', day.me), ratePill(friendName, day.friend?.journal));
        for (const [who, j] of [['我', day.me], [friendName, day.friend?.journal]]) {
          const col = el('div', '');
          col.append(el('div', 'who', who), journalView(j));
          cols.append(col);
        }
      }
      const label = future ? '明天' : day.date === today ? '今天' : WEEKDAYS[new Date(y, m - 1, d).getDay()];
      summary.append(el('span', 'date', `${m} 月 ${d} 日 ${label}`), rate);
      const details = el('details', 'day');
      details.dataset.date = day.date;
      details.open = opened.has(day.date);
      details.append(summary, cols);
      return details;
    })
  );
}
buddy.onJournalChanged(loadHistory);

load();
loadHistory();
