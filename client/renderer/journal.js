/* global buddy, journalView, journalProgress */
// 三种模式共用一个页面：plan 今日计划 / review 今日复盘 / view 只读查看对方的
const $ = (id) => document.getElementById(id);
const query = new URLSearchParams(location.search);
const mode = query.get('mode') || 'plan';
const reminder = query.get('reminder') === '1';
const MAX_ITEMS = 8;

let data = null; // 主进程给的 { date, today, me, friend, snoozesLeft }
let items = []; // 正在编辑的条目
let improveTouched = false;

function el(tag, props = {}, ...children) {
  const e = document.createElement(tag);
  Object.assign(e, props);
  e.append(...children);
  return e;
}
const show = (id, on) => $(id).classList.toggle('hidden', !on);
function setMsg(text, err = false) {
  const m = $('msg');
  m.textContent = text;
  m.className = err ? 'err' : '';
}
const shortDate = (d) => `${Number(d.slice(5, 7))} 月 ${Number(d.slice(8, 10))} 日`;

// ---------- 今日计划 ----------
function renderPlan() {
  const future = data.date > data.today; // 提前写明天的：只能编辑条目，不能勾选
  const planned = !!data.me?.planAt && !future;
  document.title = future ? '明日计划' : '今日计划';
  $('title').textContent = future ? '📝 明日计划' : '📝 今日计划';
  if (data.me?.reviewAt) {
    $('sub').textContent = `${shortDate(data.date)} · 今天已经复盘过了，计划不再修改。`;
    $('list').replaceChildren(journalView(data.me));
    for (const id of ['addBtn', 'saveBtn', 'snoozeBtn']) show(id, false);
    return;
  }
  const filled = items.filter((it) => it.text.trim());
  $('sub').textContent = planned
    ? `${shortDate(data.date)} · 已完成 ${filled.filter((it) => it.done).length}/${filled.length}，勾选和修改会自动保存，进度会同步给搭子。`
    : future
      ? `${shortDate(data.date)} · 提前写下明天要做的 1–8 件事。到了明天它就是今日计划，早上不会再弹窗提醒。`
      : `${shortDate(data.date)} · 写下今天要做的 1–8 件事。`;
  $('list').replaceChildren(...items.map((it, i) => planRow(it, i, planned)));
  show('addBtn', items.length < MAX_ITEMS);
  show('saveBtn', !planned);
  $('saveBtn').textContent = future ? '保存明日计划' : '保存计划';
  show('snoozeBtn', !planned && reminder && data.snoozesLeft > 0);
  $('snoozeBtn').textContent = `15 分钟后再提醒（还能推迟 ${data.snoozesLeft} 次）`;
}

function planRow(it, i, planned) {
  const input = el('input', { type: 'text', maxLength: 60, value: it.text, placeholder: `要做的事 ${i + 1}` });
  input.addEventListener('input', () => (it.text = input.value));
  input.addEventListener('change', () => planned && savePlan());
  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    if (i === items.length - 1) addItem();
    else $('list').querySelectorAll('input[type=text]')[i + 1]?.focus();
  });
  let lead = el('span', { className: 'num', textContent: `${i + 1}.` });
  if (planned) {
    lead = el('input', { type: 'checkbox', checked: it.done, title: '做完了就勾上' });
    lead.addEventListener('change', () => {
      it.done = lead.checked;
      savePlan();
      renderPlan();
    });
  }
  const x = el('button', { type: 'button', className: 'x', title: '删掉这一条', textContent: '✕' });
  x.addEventListener('click', () => {
    items.splice(i, 1);
    if (!items.length) items.push({ text: '', done: false });
    if (planned) savePlan();
    renderPlan();
  });
  return el('div', { className: 'item' + (it.done ? ' done' : '') }, lead, input, x);
}

function addItem() {
  if (items.length >= MAX_ITEMS) return;
  items.push({ text: '', done: false });
  renderPlan();
  const inputs = $('list').querySelectorAll('input[type=text]');
  inputs[inputs.length - 1]?.focus();
}

async function savePlan() {
  const first = !data.me?.planAt;
  const r = await buddy.saveJournal('plan', { date: data.date, items });
  if (!r.ok) return setMsg(r.error, true);
  data.me = r.journal;
  if (data.date > data.today) return setMsg('明日计划已保存 ✓ 明天搭子才会看到');
  setMsg(first ? '计划已保存 ✓ 搭子能看到你的进度了' : '已保存 ✓');
  if (first) {
    items = items.filter((it) => it.text.trim());
    renderPlan();
    if (reminder) setTimeout(() => window.close(), 1200);
  }
}

// ---------- 今日复盘 ----------
function renderReview() {
  const today = data.date === data.today;
  document.title = today ? '今日复盘' : `${shortDate(data.date)}的复盘`;
  $('title').textContent = today ? '🌙 今日复盘' : `🌙 ${shortDate(data.date)}的复盘`;
  show('addBtn', false);
  show('snoozeBtn', false);
  show('saveBtn', true);
  if (!data.me?.planAt) {
    $('sub').textContent = '今天还没写计划，没有可以复盘的内容。';
    show('list', false);
    show('improveBox', false);
    $('saveBtn').textContent = '去写今日计划';
    return;
  }
  $('sub').textContent = `${shortDate(data.date)} · 逐条标记完成情况，没完成的要写一下原因。`;
  $('list').replaceChildren(...items.map(reviewRow));
  show('improveBox', true);
  if (!improveTouched) $('improve').value = data.me.improve || '';
  $('saveBtn').textContent = data.me.reviewAt ? '重新提交复盘' : '提交复盘';
}

function reviewRow(it) {
  const yes = el('button', { type: 'button', className: 'yes' + (it.done ? ' on' : ''), textContent: '完成' });
  const no = el('button', { type: 'button', className: 'no' + (it.done ? '' : ' on'), textContent: '没完成' });
  yes.addEventListener('click', () => {
    it.done = true;
    renderReview();
  });
  no.addEventListener('click', () => {
    it.done = false;
    renderReview();
  });
  const row = el('div', { className: 'item' }, el('div', { className: 'text', textContent: it.text }), el('div', { className: 'seg' }, yes, no));
  if (!it.done) {
    const reason = el('input', { type: 'text', className: 'reason' + (it.missing ? ' err' : ''), maxLength: 120, value: it.reason || '', placeholder: '没完成的原因（必填）' });
    reason.addEventListener('input', () => {
      it.reason = reason.value;
      it.missing = false;
      reason.classList.remove('err');
    });
    row.append(reason);
  }
  return row;
}

async function submitReview() {
  if (!data.me?.planAt) {
    buddy.openJournal('plan');
    return window.close();
  }
  for (const it of items) it.missing = !it.done && !String(it.reason || '').trim();
  if (items.some((it) => it.missing)) {
    renderReview();
    $('list').querySelector('input.err')?.focus();
    return setMsg('没完成的事要写一下原因', true);
  }
  const r = await buddy.saveJournal('review', { date: data.date, items, improve: $('improve').value });
  if (!r.ok) return setMsg(r.error, true);
  data.me = r.journal;
  setMsg('复盘已提交 ✓ 辛苦啦');
  setTimeout(() => window.close(), 1200);
}

// ---------- 查看 TA 的 ----------
function renderView() {
  const f = data.friend;
  const name = f?.name || 'TA';
  const p = journalProgress(f?.journal);
  document.title = `${name} 的今日计划`;
  $('title').textContent = `📋 ${name} 的今日计划 / 复盘`;
  $('sub').textContent = !f
    ? '还没有搭子加入房间。'
    : !p
      ? `${name} 还没写今日计划。`
      : `${shortDate(f.journal.date)} · 已完成 ${p.text} · ${f.journal.reviewAt ? '已复盘' : '还没复盘'}`;
  show('list', !!p);
  if (p) $('list').replaceChildren(journalView(f.journal));
  for (const id of ['addBtn', 'saveBtn', 'snoozeBtn', 'improveBox']) show(id, false);
}

// ---------- 启动 ----------
const render = () => ({ plan: renderPlan, review: renderReview, view: renderView })[mode]?.();

async function load() {
  data = await buddy.getJournal(query.get('date') || undefined);
  items = (data.me?.items || []).map((it) => ({ ...it }));
  if (mode === 'plan' && (!data.me?.planAt || data.date > data.today)) while (items.length < 3) items.push({ text: '', done: false });
  render();
}

$('addBtn').addEventListener('click', addItem);
$('saveBtn').addEventListener('click', () => (mode === 'review' ? submitReview() : savePlan()));
$('snoozeBtn').addEventListener('click', () => buddy.snoozeJournal());
$('improve').addEventListener('input', () => (improveTouched = true));
// 对方的计划有更新时刷新只读窗口；自己正在编辑的窗口不动，免得把没保存的字冲掉
buddy.onJournalChanged(() => mode === 'view' && load());

load().then(() => {
  if (mode === 'plan' && !data.me?.planAt) $('list').querySelector('input[type=text]')?.focus();
});
