/* global buddy, journalView, journalProgress, remindOptions, clampRemindMinutes */
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

// 摸鱼提醒：右边的输入框是可以选的间隔，左边的下拉框从里面选一个。规则和主进程用的是同一份（reminder.js）
function fillRemind(options, every) {
  const list = remindOptions(options, every);
  $('slackRemindOptions').value = list.join(', ');
  fillRemindSelect(list, clampRemindMinutes(every));
}
function fillRemindSelect(list, picked) {
  if (!list.includes(picked)) picked = list[0];
  $('slackRemindMinutes').replaceChildren(...list.map((n) => new Option(`${n} 分钟`, String(n), n === picked, n === picked)));
}

function fillPomodoro() {
  $('pomodoroFocusMinutes').value = current.pomodoroFocusMinutes || 25;
  $('pomodoroBreakMinutes').value = current.pomodoroBreakMinutes || 5;
  $('pomodoroBreakCounts').checked = !!current.pomodoroBreakCounts;
  $('pomodoroStrict').checked = !!current.pomodoroStrict;
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
  fillRemind(current.slackRemindOptions, current.slackRemindMinutes);
  fillPomodoro();
  $('openAtLogin').checked = !!current.openAtLogin;
  $('planTime').value = current.planTime || '09:00';
  $('reviewTime').value = current.reviewTime || '22:00';
  fillRules(current.rules || {});
}

// 改右边的时间点，左边的下拉框跟着变；原来选的还在就保留
$('slackRemindOptions').addEventListener('input', () => {
  fillRemindSelect(remindOptions($('slackRemindOptions').value), Number($('slackRemindMinutes').value));
});

// ---------- 保存 ----------
// 改完自动保存：开关、下拉框一点就存，输入框是改完离开（或者按回车）时存。页面下面浮一条「已保存」。
// 右上角的按钮只管连接：存一遍，然后重新连服务器。
let toastTimer = null;
function toast(text, bad = false) {
  const t = $('saved');
  t.textContent = text;
  t.className = `toast show${bad ? ' bad' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), bad ? 4000 : 1800);
}
/** 把主进程实际存下的值填回去；正在输入的那一格不动 */
function setValue(id, value) {
  if (document.activeElement !== $(id)) $(id).value = value;
}

const CONN = ['serverUrl', 'room', 'secret', 'name'];
function collect() {
  const rules = {
    study: { ...(current.rules?.study || {}), domains: toList($('studyDomains').value), apps: toList($('studyApps').value) },
    slack: { ...(current.rules?.slack || {}), domains: toList($('slackDomains').value), apps: toList($('slackApps').value) },
    private: { domains: toList($('privateDomains').value), apps: toList($('privateApps').value) },
  };
  // 连接的四项要填齐才存：填到一半（或者清空了准备重填）时先留着原来的，别的设置照常保存
  const connReady = CONN.every((id) => $(id).value.trim());
  const conn = Object.fromEntries(CONN.map((id) => [id, connReady ? $(id).value : current[id] || '']));
  return {
    ...conn,
    idleMinutes: $('idleMinutes').value,
    slackIdleMinutes: $('slackIdleMinutes').value,
    slackRemind: $('slackRemind').checked,
    slackRemindMinutes: $('slackRemindMinutes').value,
    slackRemindOptions: $('slackRemindOptions').value,
    pomodoroFocusMinutes: $('pomodoroFocusMinutes').value,
    pomodoroBreakMinutes: $('pomodoroBreakMinutes').value,
    pomodoroBreakCounts: $('pomodoroBreakCounts').checked,
    pomodoroStrict: $('pomodoroStrict').checked,
    openAtLogin: $('openAtLogin').checked,
    planTime: $('planTime').value,
    reviewTime: $('reviewTime').value,
    rules,
  };
}

let lastSaved = ''; // 上次存下的内容：没变就不再存一遍（按回车时 change 和 submit 会连着来）
let saving = Promise.resolve(); // 一个存完再存下一个
/** @param {boolean} reconnect 右上角的按钮点的：顺便重新连服务器 */
function save(reconnect = false) {
  saving = saving.then(async () => {
    if (!current) return;
    if ($('planTime').value >= $('reviewTime').value) return toast('复盘提醒时间要晚于计划提醒时间，这次没保存', true);
    const next = collect();
    // 连接的四项只填了一部分：这几项还没存，照实说（别的设置照常保存）
    const connPending = CONN.some((id) => $(id).value !== next[id]);
    const pendingText = '服务器、房间号、密码、昵称填齐后才会保存连接';
    if (JSON.stringify(next) === lastSaved && !reconnect) return connPending ? toast(pendingText) : undefined;
    await buddy.saveConfig({ ...next, reconnect });
    current = await buddy.getConfig();
    // 主进程会把不合法的数字改掉（比如摸鱼时的空闲时间填得比平时短），把实际存下的显示出来
    setValue('idleMinutes', current.idleMinutes);
    setValue('slackIdleMinutes', current.slackIdleMinutes);
    if (document.activeElement !== $('slackRemindOptions')) fillRemind(current.slackRemindOptions, current.slackRemindMinutes);
    setValue('pomodoroFocusMinutes', current.pomodoroFocusMinutes);
    setValue('pomodoroBreakMinutes', current.pomodoroBreakMinutes);
    lastSaved = JSON.stringify(collect()); // 填回去以后再记：不然被改掉的数字会让下一次白存一遍
    if (connPending) return toast(pendingText);
    toast(reconnect ? '已保存，正在连接…' : '已保存 ✓');
  });
  return saving;
}

$('form').addEventListener('change', () => save());
// 在输入框里按回车 = 这一格改完了：让它失去焦点（触发上面的 change），不当成点了右上角的「连接」
$('form').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.tagName === 'INPUT' && !e.isComposing) {
    e.preventDefault();
    e.target.blur();
  }
});
$('form').addEventListener('submit', (e) => {
  e.preventDefault();
  save(true);
});
$('resetRules').addEventListener('click', async () => {
  fillRules(await buddy.defaultRules());
  save();
});

buddy.onState((s) => {
  // 说明文字里的「小狗」跟着现在的形象改口
  for (const e of document.querySelectorAll('.pet-name')) e.textContent = s.petName || '小狗';
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
  $('connectBtn').textContent = c.state === 'online' ? '重新连接' : '连接';
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
