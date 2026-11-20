/* global buddy, siteName, appName, entryName */
const $ = (id) => document.getElementById(id);

const STATE_LABEL = {
  study: '学习中', slack: '摸鱼中', neutral: '在电脑前', away: '离开了', private: '隐私模式',
  paused: '暂停分享', offline: '离线',
};

let state = null;
let menuOpen = false;
let hovering = false; // 鼠标在小狗 / 卡片 / 明细上
let detail = null; // 正在看谁的哪类明细：{ who: 'me' | 'friend', cat: 'study' | 'slack' }
let bubbleTimer = null;
let cooldownUntil = 0;

// ---------- 鼠标穿透：只有鼠标在可交互元素上时才接收点击 ----------
let ignoring = true;
document.addEventListener('mousemove', (e) => {
  if (dragging) return buddy.dragPet('move');
  if (pressAt && Math.hypot(e.screenX - pressAt.x, e.screenY - pressAt.y) > DRAG_THRESHOLD) return startDrag();
  const over = !!e.target.closest('.hit');
  if (over === !ignoring) return;
  ignoring = !over;
  buddy.setIgnoreMouse(ignoring);
});
document.addEventListener('mouseleave', () => {
  if (!ignoring && !dragging) {
    ignoring = true;
    buddy.setIgnoreMouse(true);
  }
});

// ---------- 拖动：按住小狗或名牌就能拖 ----------
// 不能用 -webkit-app-region: drag：Windows 上鼠标进入拖动区会触发 mouseleave，窗口立刻变回穿透，根本抓不住
const DRAG_THRESHOLD = 4; // 按住小狗移动超过这么多像素才算拖动，不然还是点击（打开菜单）
let dragging = false;
let pressAt = null; // 在小狗身上按下了，还不知道是点击还是拖动
let dragJustEnded = false; // 拖完松手时浏览器还会补一个 click，要忽略掉
function startDrag() {
  pressAt = null;
  dragging = true;
  document.body.classList.add('dragging');
  buddy.dragPet('start');
  updateOverlays(); // 拖的时候先把卡片收起来
}
$('nametag').addEventListener('mousedown', (e) => {
  if (e.button === 0) startDrag();
});
$('pet').addEventListener('mousedown', (e) => {
  if (e.button === 0) pressAt = { x: e.screenX, y: e.screenY };
});
function endDrag() {
  pressAt = null;
  if (!dragging) return;
  dragging = false;
  document.body.classList.remove('dragging');
  buddy.dragPet('end');
  dragJustEnded = true;
  setTimeout(() => (dragJustEnded = false), 50);
  updateOverlays();
}
window.addEventListener('mouseup', endDrag);
window.addEventListener('blur', endDrag);

// ---------- 缩放：在小狗身上滚滚轮 ----------
$('pet').addEventListener(
  'wheel',
  (e) => {
    e.preventDefault();
    if (e.deltaY) buddy.scalePet(e.deltaY < 0 ? 1 : -1); // 往上滚放大
  },
  { passive: false }
);

// ---------- 工具 ----------
function fmtDur(sec) {
  sec = Math.max(0, Math.round(sec || 0));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (h) return `${h}h${String(m).padStart(2, '0')}m`;
  return `${m}m`;
}
function friendView() {
  const f = state?.friend;
  if (!f) return { key: 'offline', name: null };
  if (!f.online) return { key: 'offline', name: f.name, status: f.status };
  const s = f.status;
  if (!s) return { key: 'neutral', name: f.name, status: null };
  if (s.paused) return { key: 'paused', name: f.name, status: s };
  return { key: s.category || 'neutral', name: f.name, status: s };
}
function whatText(v) {
  const s = v.status;
  if (v.key === 'offline') return '不在线';
  if (v.key === 'paused') return 'TA 暂时关闭了状态分享';
  if (v.key === 'private') return '正在用一个隐私应用';
  if (!s) return '还没收到状态';
  const a = appName(s.app);
  const site = siteName(s.domain);
  if (v.key === 'away') return '键盘鼠标好一会儿没动了';
  if (site) return `正在看 ${site}${site !== s.domain ? `（${s.domain}）` : ''}`;
  if (a) return `正在用 ${a}`;
  return '在电脑前';
}

// ---------- 渲染 ----------
const CAT_LABEL = { study: '学习', slack: '摸鱼' };
const DETAIL_ROWS = 6; // 明细最多列几项，剩下的并成「其他」
const num = (x) => (Number.isFinite(x) && x > 0 ? x : 0); // 对方发来的数字不一定靠谱
const el = (cls, text = '') => {
  const d = document.createElement('span');
  d.className = cls;
  d.textContent = text; // 名字、域名都可能是对方发来的，只当文本
  return d;
};

// 今日学习 / 摸鱼：自己那行一直有（没连上、暂停分享时也有）；搭子在线且在分享状态时再加一行。
function statRows(v) {
  const row = (id, who, t, breakdown) => ({ id, who, t: { study: num(t?.study), slack: num(t?.slack) }, breakdown });
  const rows = [row('me', '我', state?.me?.todaySec, state?.me?.breakdown)];
  if (v.name && v.key !== 'offline' && v.status?.todaySec) rows.push(row('friend', v.name, v.status.todaySec, v.status.breakdown));
  return rows;
}

// 两行的进度条用同一个刻度，谁长谁短一眼能比出来。时长可以点，点了看明细。
let statsSig = '';
function renderStats(v) {
  const rows = statRows(v);
  const scale = Math.max(1, ...rows.map((r) => r.t.study + r.t.slack));
  const pct = (sec) => Math.round((sec / scale) * 100);
  // 显示出来的内容没变就不重建：正在点的时候把元素换掉，这次点击会丢
  const sig = JSON.stringify(rows.map((r) => [r.who, fmtDur(r.t.study), fmtDur(r.t.slack), pct(r.t.study), pct(r.t.slack)]));
  if (sig === statsSig) return;
  statsSig = sig;
  const box = $('cardStats');
  box.replaceChildren(el('stats-head tip', '今日 · 点时长看明细'), el('stats-head num', '学习'), el('stats-head num', '摸鱼'));
  for (const r of rows) {
    const bar = el('bar');
    const who = el('stats-who', r.who);
    who.title = r.who;
    box.append(who, bar);
    for (const cat of ['study', 'slack']) {
      const seg = el(`seg ${cat}`);
      seg.style.width = `${pct(r.t[cat])}%`;
      bar.append(seg);
      const n = el(`stats-num ${cat}`, fmtDur(r.t[cat]));
      n.dataset.who = r.id;
      n.dataset.cat = cat;
      box.append(n);
    }
  }
}

// 明细：这个人今天的学习 / 摸鱼时间花在了哪些网站（域名）和应用上
let detailSig = '';
function renderDetail(v) {
  if (!detail) return;
  const row = statRows(v).find((r) => r.id === detail.who);
  if (!row) return void (detail = null); // 搭子下线了，那一行已经没有了
  const { cat } = detail;
  const total = row.t[cat];
  $('detailWho').textContent = row.who;
  $('detailTotal').textContent = ` · 今日${CAT_LABEL[cat]} ${fmtDur(total)}`;
  $('detailTotal').className = `detail-total ${cat}`;

  const raw = row.breakdown?.[cat];
  const items = (Array.isArray(raw) ? raw : [])
    .map((e) => ({ name: entryName(e), tip: e?.domain || e?.app || '', sec: num(e?.sec) }))
    .filter((e) => e.name && e.sec > 0)
    .sort((a, b) => b.sec - a.sec)
    .slice(0, DETAIL_ROWS);
  const rest = total - items.reduce((s, e) => s + e.sec, 0);
  // 列不下的并成「其他」，点它在单独的窗口里看全部
  if (items.length && rest >= 60) items.push({ name: '其他 · 看全部 ›', tip: '', sec: rest, other: true });

  const max = Math.max(1, ...items.map((e) => e.sec));
  for (const e of items) Object.assign(e, { pct: Math.round((e.sec / max) * 100), dur: e.sec < 60 ? '<1m' : fmtDur(e.sec) });
  // 和卡片一样：显示的内容没变就不重建，免得正要点「其他」时元素被换掉
  const sig = JSON.stringify([detail.who, cat, items.map((e) => [e.name, e.pct, e.dur])]);
  if (sig !== detailSig) {
    detailSig = sig;
    const list = $('detailList');
    list.replaceChildren();
    for (const e of items) {
      const name = el(`detail-name${e.other ? ' other' : ''}`, e.name);
      name.title = String(e.tip);
      const bar = el('bar');
      const seg = el(`seg ${cat}`);
      seg.style.width = `${e.pct}%`;
      bar.append(seg);
      list.append(name, bar, el('detail-dur', e.dur));
    }
  }

  let note = '';
  if (!items.length) {
    if (total < 1) note = `今天还没有${CAT_LABEL[cat]}记录`;
    else if (row.id === 'friend' && !row.breakdown) note = 'TA 的 Buddy Pet 还是旧版本，更新之后才能看到明细';
    else note = '这段时间是更新到新版本之前记的，没有明细';
  }
  $('detailNote').textContent = note;
  $('detailNote').classList.toggle('hidden', !note);
}

function render() {
  document.documentElement.style.setProperty('--pet-scale', String(state?.petScale || 1));
  const v = friendView();
  const wrap = $('petWrap');
  wrap.className = `state-${v.key === 'private' || v.key === 'neutral' ? 'neutral' : v.key}`;

  const conn = state?.connection?.state;
  const nameText = $('nameText');
  const dot = $('dot');
  if (conn !== 'online') {
    nameText.textContent = conn === 'connecting' ? '连接中…' : '未连接';
    dot.className = 'dot offline';
  } else if (!v.name) {
    nameText.textContent = '等搭子上线…';
    dot.className = 'dot offline';
  } else {
    nameText.textContent = `${v.name} · ${STATE_LABEL[v.key] || ''}`;
    dot.className = `dot ${v.key}`;
  }

  // 卡片
  $('cardName').textContent = v.name || '还没有搭子';
  const badge = $('cardBadge');
  badge.textContent = STATE_LABEL[v.key] || '—';
  badge.className = `badge ${v.key}`;
  if (conn !== 'online') {
    $('cardWhat').textContent = state?.connection?.error || '没有连上服务器';
    $('cardHint').textContent = '点我打开设置';
  } else {
    $('cardWhat').textContent = v.name ? whatText(v) : '把房间号和密码发给你的朋友吧';
    $('cardHint').textContent = v.name && v.key !== 'offline' ? '点我戳 TA 一下' : '';
  }
  renderStats(v);
  renderDetail(v);
  const streak = v.status?.slackStreakSec || 0;
  const streakEl = $('cardStreak');
  if (v.key === 'slack' && streak >= 300) {
    streakEl.textContent = `已经连续摸鱼 ${fmtDur(streak)} 了 🐟`;
    streakEl.classList.remove('hidden');
  } else streakEl.classList.add('hidden');

  // 对方的今日计划进度
  const plan = $('cardPlan');
  const fj = state?.friendJournal;
  plan.classList.toggle('hidden', !v.name || conn !== 'online');
  plan.classList.toggle('has', !!fj);
  plan.textContent = fj ? `计划 ${fj.done}/${fj.total}${fj.reviewed ? ' · 已复盘' : ''}` : '还没写今日计划';

  $('menuName').textContent = v.name || 'TA';
  $('pauseLink').textContent = state?.me?.status?.paused ? '恢复分享我的状态' : '暂停分享我的状态';
  updateOverlays();
}

function updateOverlays() {
  const bubbleShown = !$('bubble').classList.contains('hidden');
  $('menu').classList.toggle('hidden', !menuOpen);
  const overlay = hovering && !menuOpen && !bubbleShown && !dragging;
  $('card').classList.toggle('hidden', !(overlay && !detail));
  $('detail').classList.toggle('hidden', !(overlay && detail));
}

function showBubble(html, { self = false, ms = 9000 } = {}) {
  const b = $('bubble');
  b.innerHTML = html;
  b.classList.toggle('self', self);
  b.classList.remove('hidden');
  clearTimeout(bubbleTimer);
  bubbleTimer = setTimeout(hideBubble, ms);
  updateOverlays();
}
function hideBubble() {
  $('bubble').classList.add('hidden');
  updateOverlays();
}
function animate(cls) {
  const w = $('petWrap');
  w.classList.remove(cls);
  void w.offsetWidth;
  w.classList.add(cls);
  setTimeout(() => w.classList.remove(cls), 1100);
}
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// ---------- 交互 ----------
// 鼠标在小狗、卡片、明细之间移动都算「还在看」；全都离开一小会儿才收起来，明细也跟着关掉
let leaveTimer = null;
for (const id of ['pet', 'card', 'detail']) {
  $(id).addEventListener('mouseenter', () => {
    clearTimeout(leaveTimer);
    hovering = true;
    updateOverlays();
  });
  $(id).addEventListener('mouseleave', () => {
    clearTimeout(leaveTimer);
    leaveTimer = setTimeout(() => {
      hovering = false;
      detail = null;
      updateOverlays();
    }, 250);
  });
}
// 点卡片上的时长 → 看明细
$('cardStats').addEventListener('click', (e) => {
  const n = e.target.closest('.stats-num');
  if (!n) return;
  detail = { who: n.dataset.who, cat: n.dataset.cat };
  render();
});
$('detailList').addEventListener('click', (e) => {
  if (detail && e.target.closest('.detail-name.other')) buddy.openStats(detail.who, detail.cat);
});
$('detailBack').addEventListener('click', (e) => {
  e.preventDefault();
  detail = null;
  updateOverlays();
});
$('pet').addEventListener('click', () => {
  if (dragJustEnded) return; // 刚才是拖动，不是点击
  hideBubble();
  detail = null;
  if (state?.connection?.state !== 'online') return buddy.openSettings();
  menuOpen = !menuOpen;
  setMenuMsg('');
  refreshCooldown();
  updateOverlays();
  if (menuOpen) setTimeout(() => $('customText').focus(), 50);
});
$('bubble').addEventListener('click', hideBubble);
$('closeLink').addEventListener('click', (e) => {
  e.preventDefault();
  menuOpen = false;
  updateOverlays();
});
$('settingsLink').addEventListener('click', (e) => {
  e.preventDefault();
  buddy.openSettings();
});
$('journalLink').addEventListener('click', (e) => {
  e.preventDefault();
  buddy.openJournal('view');
});
$('pauseLink').addEventListener('click', (e) => {
  e.preventDefault();
  buddy.togglePause();
});
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || !(menuOpen || detail)) return;
  menuOpen = false;
  detail = null;
  updateOverlays();
});

function setMenuMsg(text, kind = '') {
  const m = $('menuMsg');
  m.textContent = text;
  m.className = `menu-msg ${kind}`;
}

async function sendPoke(text) {
  if (!text || Date.now() < cooldownUntil) return;
  const r = await buddy.poke(text);
  if (!r.sent) return setMenuMsg(r.reason || '发送失败', 'err');
  setMenuMsg('发送中…');
}
document.querySelectorAll('.presets button').forEach((b) => b.addEventListener('click', () => sendPoke(b.dataset.text)));
$('customForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const t = $('customText').value.trim();
  if (t) sendPoke(t);
});

function refreshCooldown() {
  const left = Math.ceil((cooldownUntil - Date.now()) / 1000);
  const disabled = left > 0;
  document.querySelectorAll('.menu button').forEach((b) => (b.disabled = disabled));
  if (disabled) setMenuMsg(`${lastPokeOk ? '已送达 ✓  ' : ''}${left}s 后可以再戳`, lastPokeOk ? 'ok' : '');
  return disabled;
}
let lastPokeOk = false;
setInterval(() => {
  if (!cooldownUntil) return;
  if (!refreshCooldown()) {
    cooldownUntil = 0;
    setMenuMsg('');
  }
}, 1000);

// ---------- 来自主进程 ----------
buddy.onState((s) => {
  state = s;
  render();
});
buddy.onPokeResult((r) => {
  lastPokeOk = !!r.ok;
  if (r.ok) {
    cooldownUntil = Date.now() + 30_000;
    $('customText').value = '';
    animate('jump');
    refreshCooldown();
    setTimeout(() => {
      menuOpen = false;
      updateOverlays();
    }, 1200);
  } else {
    cooldownUntil = Date.now() + (r.retryInMs || 0);
    refreshCooldown();
  }
});
buddy.onPoke(({ from, text }) => {
  animate('shake');
  showBubble(`<b>${esc(from)}</b>：${esc(text)}<span class="sub">点击关闭</span>`, { ms: 15000 });
});
buddy.onJournalEvent(({ from, kind }) => {
  animate('jump');
  const what = kind === 'review' ? '今日复盘 🌙' : '今日计划 📝';
  showBubble(`<b>${esc(from)}</b> 写好了${what}<span class="sub">点小狗可以查看 TA 的计划</span>`, { ms: 12000 });
});
buddy.onSelfAlert(({ minutes, friend }) => {
  animate('shake');
  const who = friend ? esc(friend) : '你的搭子';
  showBubble(`你已经连续摸鱼 <b>${minutes} 分钟</b>啦 🐟<span class="sub">${who} 能看到哦，回去干活吧～</span>`, { self: true, ms: 12000 });
});

render();
