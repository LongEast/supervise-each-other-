/* global buddy, entryName, SITE_NAMES */
// 「今日时长明细」窗口：小狗卡片上列不下的，在这里看全部。
// 上面两组按钮选「看谁的」和「学习 / 摸鱼」，下面按时间从长到短列出网站和应用。
const $ = (id) => document.getElementById(id);
const query = new URLSearchParams(location.search);
const CAT_LABEL = { study: '学习', slack: '摸鱼' };

let who = query.get('who') === 'friend' ? 'friend' : 'me';
let cat = query.get('cat') === 'slack' ? 'slack' : 'study';
let data = null; // 主进程给的 { me: { todaySec, breakdown }, friend: { name, todaySec, breakdown } | null }
let sig = '';

const num = (x) => (Number.isFinite(x) && x > 0 ? x : 0); // 对方发来的数字不一定靠谱
function el(tag, cls = '', text = '') {
  const e = document.createElement(tag);
  e.className = cls;
  e.textContent = text; // 名字、域名都可能是对方发来的，只当文本
  return e;
}
function fmt(sec) {
  sec = Math.round(num(sec));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (h) return `${h}h${String(m).padStart(2, '0')}m`;
  if (m) return `${m}m`;
  return `${sec}s`;
}

function tabs(box, options, current, onPick) {
  box.replaceChildren(
    ...options.map((o) => {
      const b = el('button', `${o.cls || ''}${o.id === current ? ' on' : ''}`, o.label);
      b.type = 'button';
      b.title = o.label;
      b.addEventListener('click', () => onPick(o.id));
      return b;
    })
  );
}

function render() {
  if (!data) return;
  if (who === 'friend' && !data.friend) who = 'me'; // 搭子下线或暂停分享了
  const person = data[who];
  const total = num(person.todaySec?.[cat]);
  const raw = person.breakdown?.[cat];
  const items = (Array.isArray(raw) ? raw : [])
    .map((e) => ({ name: entryName(e), domain: typeof e?.domain === 'string' && SITE_NAMES[e.domain] ? e.domain : '', sec: num(e?.sec) }))
    .filter((e) => e.name && e.sec > 0)
    .sort((a, b) => b.sec - a.sec);
  const rest = total - items.reduce((s, e) => s + e.sec, 0);
  const hasRest = items.length > 0 && rest >= 60;
  if (hasRest) items.push({ name: '其他', domain: '', sec: rest, other: true });

  let note = '';
  if (who === 'friend' && !person.breakdown) note = 'TA 的 Buddy Pet 还是旧版本，更新之后才能看到明细。';
  else if (!items.length && total >= 1) note = '这段时间是更新到新版本之前记的，没有明细。';
  else if (hasRest && who === 'friend') note = '「其他」：对方只会发来时间最长的 30 项，剩下的合在一起。';
  else if (hasRest) note = '「其他」：更新到新版本之前记的时间，没有明细。';

  const whoOpts = [{ id: 'me', label: '我' }, ...(data.friend ? [{ id: 'friend', label: String(data.friend.name || '搭子') }] : [])];
  const catOpts = ['study', 'slack'].map((c) => ({ id: c, cls: c, label: `${CAT_LABEL[c]} ${fmt(person.todaySec?.[c])}` }));

  // 每几秒刷新一次；显示的内容没变就不动页面，免得滚动位置和鼠标悬停被打断
  const next = JSON.stringify([who, cat, whoOpts, catOpts, items.map((e) => [e.name, e.domain, fmt(e.sec)]), fmt(total), note]);
  if (next === sig) return;
  sig = next;

  tabs($('whoTabs'), whoOpts, who, (id) => ((who = id), render()));
  tabs($('catTabs'), catOpts, cat, (id) => ((cat = id), render()));

  const max = Math.max(1, ...items.map((e) => e.sec));
  const list = $('list');
  list.replaceChildren();
  if (!items.length) list.append(el('div', 'empty', total < 1 ? `今天还没有${CAT_LABEL[cat]}记录` : '没有明细'));
  for (const e of items) {
    const name = el('div', 'name', e.name);
    if (e.domain) name.append(el('span', 'domain', e.domain));
    name.title = e.domain || e.name;
    const bar = el('div', 'bar');
    const fill = el('span', `fill ${cat}`);
    fill.style.width = `${(e.sec / max) * 100}%`;
    bar.append(fill);
    const row = el('div', `row${e.other ? ' other' : ''}`);
    row.append(name, bar, el('div', 'dur', fmt(e.sec)), el('div', 'pct', total > 0 ? `${Math.round((e.sec / total) * 100)}%` : ''));
    list.append(row);
  }
  $('note').textContent = note;
  $('note').classList.toggle('hidden', !note);
}

async function refresh() {
  data = await buddy.getStats();
  render();
}
// 窗口已经开着时又从小狗那边点了一次：切到要看的那一页
buddy.onStatsSelect((sel) => {
  who = sel.who === 'friend' ? 'friend' : 'me';
  cat = sel.cat === 'slack' ? 'slack' : 'study';
  refresh();
});
refresh();
setInterval(refresh, 5000);
