/* global buddy, entryName, SITE_NAMES, friendView, meView, journalView, journalProgress */
// 面板：今天 / 统计 / 计划三页的显示和操作。设置页的表单（读取、保存、历史）还是 settings.js 管，
// 这里只管设置页上「点了马上生效」的那几项。整个包在函数里，免得和 settings.js 的全局名字撞上。
(() => {
  const $ = (id) => document.getElementById(id);
  const query = new URLSearchParams(location.search);
  const PAGES = ['today', 'stats', 'plan', 'settings'];
  const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  const STATE_LABEL = { study: '学习中', slack: '摸鱼中', neutral: '在电脑前', away: '离开了', private: '隐私模式', paused: '暂停分享', offline: '离线' };
  const CAT_LABEL = { study: '学习', slack: '摸鱼' };
  const MAX_ITEMS = 8;

  let state = null; // 主进程推过来的（和小狗窗口收到的是同一份）
  let page = 'today';

  // ---------- 小工具 ----------
  const num = (x) => (Number.isFinite(x) && x > 0 ? x : 0); // 对方发来的数字不一定靠谱
  /** 建一个元素。名字、域名、计划内容都可能是对方发来的，一律当文本 */
  function el(tag, cls = '', text = '', ...children) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== '') e.textContent = text;
    e.append(...children);
    return e;
  }
  function button(cls, text, onClick) {
    const b = el('button', cls, text);
    b.type = 'button';
    b.addEventListener('click', onClick);
    return b;
  }
  /** 3h10m / 35m / 0m */
  function fmt(sec) {
    const m = Math.floor(num(sec) / 60);
    return m >= 60 ? `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m` : `${m}m`;
  }
  const pad = (n) => String(n).padStart(2, '0');
  const dateOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const todayStr = () => dateOf(new Date());
  const parse = (date) => new Date(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)));
  function shift(date, n) {
    const d = parse(date);
    d.setDate(d.getDate() + n);
    return dateOf(d);
  }
  const md = (date) => `${Number(date.slice(5, 7))}月${Number(date.slice(8, 10))}日`;
  const dow = (date) => WEEKDAYS[parse(date).getDay()];

  /** 分段按钮。内容没变就不重画，免得点到一半按钮被换掉 */
  function seg(box, options, current, onPick) {
    const sig = JSON.stringify([options.map((o) => [o.id, o.label, o.cls]), current]);
    if (box.dataset.sig === sig) return;
    box.dataset.sig = sig;
    box.replaceChildren(
      ...options.map((o) => {
        const b = button(`${o.cls || ''}${o.id === current ? ' on' : ''}`, o.label, () => onPick(o.id));
        b.title = o.label;
        b.setAttribute('aria-pressed', String(o.id === current));
        return b;
      })
    );
  }

  // ---------- 导航 ----------
  function go(next, opts = {}) {
    page = PAGES.includes(next) ? next : 'today';
    for (const p of PAGES) $(`page-${p}`).classList.toggle('hidden', p !== page);
    for (const b of document.querySelectorAll('.nav')) {
      b.classList.toggle('on', b.dataset.page === page);
      if (b.dataset.page === page) b.setAttribute('aria-current', 'page');
      else b.removeAttribute('aria-current');
    }
    document.querySelector('main').scrollTop = 0;
    if (page === 'today') loadTodayJournal();
    if (page === 'stats') {
      if (opts.who === 'friend' || opts.who === 'me') Object.assign(stats, { who: opts.who, mode: 'day', date: todayStr() });
      loadStats();
    }
    if (page === 'plan') {
      if (opts.tab) plan.tab = opts.tab;
      loadPlan();
    }
  }
  for (const b of document.querySelectorAll('.nav')) b.addEventListener('click', () => go(b.dataset.page));
  $('pauseBtn').addEventListener('click', () => buddy.togglePause());

  function renderSide() {
    const c = state?.connection?.state;
    const f = state?.friend;
    $('connDot').className = `dot${c === 'online' ? ' ok' : ''}`;
    $('connText').textContent = c === 'online' ? `已连接${f ? (f.online ? ' · 搭子在线' : ' · 搭子离线') : ''}` : c === 'connecting' ? '连接中…' : '未连接';
    const paused = !!state?.me?.status?.paused;
    $('pauseBtn').textContent = paused ? '恢复分享' : '暂停分享';
    $('pauseBtn').classList.toggle('paused', paused);
    $('pauseBtn').title = paused ? '搭子现在看不到你的状态' : '处理私事时点一下，搭子就看不到你在干什么';
  }

  // =====================================================================
  // 今天
  // =====================================================================
  let heroSig = '';
  function heroButtons(phase, paused, strict) {
    if (!phase) return [button('btn solid', '开始番茄钟', () => buddy.startPomodoro())];
    const stop = button('btn', '结束', () => buddy.stopPomodoro());
    // 严格模式：专注时多一个「暂停 5 分钟」；暂停着的时候换成「继续专注 / 再暂停」
    // （三个按钮要排在一行里，右边是小狗，所以字少：完整的说法在 title 里）
    if (phase === 'focus' && paused) {
      const more = button('btn', '+5 分钟', () => buddy.pauseMorePomodoro());
      more.title = '再暂停 5 分钟，到点再提醒';
      return [button('btn solid', '继续专注', () => buddy.continuePomodoro()), more, stop];
    }
    if (phase === 'focus' && strict) {
      const pause = button('btn', '暂停', () => buddy.pausePomodoro());
      pause.title = '暂停 5 分钟，到点会问你要不要继续';
      return [button('btn solid', '现在就休息', () => buddy.skipPomodoro()), pause, stop];
    }
    if (phase === 'focus') return [button('btn solid', '现在就休息', () => buddy.skipPomodoro()), stop];
    if (phase === 'break') return [button('btn solid', '跳过休息', () => buddy.skipPomodoro()), stop];
    return [button('btn solid', '重新开始', () => buddy.resumePomodoro()), button('btn', '再休息一会', () => buddy.restMorePomodoro()), stop];
  }
  /** 番茄钟那一块；倒计时每秒走一下 */
  function renderHero() {
    if (!state) return;
    const p = state.pomodoro;
    const set = state.pomoSettings || { focusMinutes: 25, breakMinutes: 5 };
    const done = Math.round(num(state.pomoToday));
    const phase = p?.phase || null;
    const hold = phase === 'focus' ? p.hold || null : null; // 专注的倒计时停着：'slack' 在摸鱼 | 'pause' 暂停中 | 'over' 暂停到点了
    const paused = hold === 'pause' || hold === 'over';
    const sig = `${phase}|${paused}|${!!set.strict}`;
    if (heroSig !== sig) {
      heroSig = sig;
      $('heroBtns').replaceChildren(...heroButtons(phase, paused, !!set.strict));
    }
    $('hero').className = `hero ${phase || 'off'}${hold ? ' held' : ''}`;
    const total = num(p?.minutes) * 60;
    // 倒计时停着的时候 endsAt 不准（摸鱼时它一直在往后挪，暂停时还没定），用主进程给的 leftSec
    const left = hold ? Math.max(0, Math.round(num(p.leftSec))) : phase === 'focus' || phase === 'break' ? Math.max(0, Math.ceil((p.endsAt - Date.now()) / 1000)) : 0;
    const clock = (sec) => `${Math.floor(sec / 60)}:${pad(sec % 60)}`;
    let label = '番茄钟 · 没开';
    let time = clock(num(set.focusMinutes) * 60);
    let sub = `专注 ${set.focusMinutes} 分钟 / 休息 ${set.breakMinutes} 分钟${done ? ` · 今天完成 ${done} 个` : ''}`;
    let fill = 0;
    if (phase === 'focus') {
      label = '番茄钟 · 专注中';
      time = clock(left);
      sub = `第 ${done + 1} 个番茄 · 共 ${p.minutes} 分钟`;
      fill = total ? 1 - left / total : 0;
      if (hold === 'slack') {
        label = '番茄钟 · 停着';
        sub = '摸鱼的时间不算，回去学习接着走';
      } else if (hold === 'pause') {
        label = '番茄钟 · 暂停中';
        sub = `${clock(Math.max(0, Math.ceil((num(p.pauseEndsAt) - Date.now()) / 1000)))} 后叫你 · 也可以提前继续`;
      } else if (hold === 'over') {
        label = '番茄钟 · 暂停时间到了';
        sub = '点「继续专注」倒计时才接着走';
      }
    } else if (phase === 'break') {
      label = '番茄钟 · 休息中';
      time = clock(left);
      sub = `休息 ${p.minutes} 分钟 · 今天完成 ${done} 个`;
      fill = total ? 1 - left / total : 0;
    } else if (phase === 'wait') {
      label = '番茄钟 · 休息结束';
      time = '0:00';
      sub = '点「重新开始」才会开始下一轮';
      fill = 1;
    }
    $('heroLabel').textContent = label;
    $('heroTime').textContent = time;
    $('heroSub').textContent = sub;
    $('heroFill').style.width = `${Math.round(Math.min(1, Math.max(0, fill)) * 100)}%`;
    $('heroPet').classList.toggle('hidden', (state.petSkin || 'dog') !== 'dog');
  }
  setInterval(renderHero, 1000);

  /** 现在在干什么：应用或网站的名字 */
  function whatText(v) {
    const s = v.status;
    if (!s || v.key === 'offline' || v.key === 'paused' || v.key === 'private' || v.key === 'away') return '';
    const name = entryName({ domain: s.domain, app: s.domain ? '' : s.app });
    const streak = v.key === 'slack' && num(s.slackStreakSec) >= 300 ? ` · 已经 ${fmt(s.slackStreakSec)}` : '';
    return name + streak;
  }
  /** 一条学习 + 摸鱼的横条。scale 是两个人里总时长长的那个，这样两条能比 */
  function splitBar(box, sec, scale) {
    const study = num(sec?.study);
    const slack = num(sec?.slack);
    const total = study + slack;
    box.className = `split${total > 0 ? '' : ' empty'}`;
    box.style.width = total > 0 ? `${Math.max(6, (total / Math.max(scale, 1)) * 100)}%` : '100%';
    box.replaceChildren();
    for (const [cat, v] of [['study', study], ['slack', slack]]) {
      if (v <= 0) continue;
      const s = el('span', cat);
      s.style.flex = `${v} 1 0`;
      s.title = `${CAT_LABEL[cat]} ${fmt(v)}`;
      box.append(s);
    }
  }
  function numsRow(box, sec) {
    box.replaceChildren(
      ...['study', 'slack'].map((cat) => el('span', '', '', el('i', '', CAT_LABEL[cat]), el('b', '', sec ? fmt(sec[cat]) : '—')))
    );
  }
  function renderVersus() {
    const me = meView(state);
    const fv = friendView(state);
    const mySec = state.me?.todaySec || null;
    const friendSec = fv.key !== 'offline' && fv.key !== 'paused' ? fv.status?.todaySec || null : null;
    const scale = Math.max(num(mySec?.study) + num(mySec?.slack), num(friendSec?.study) + num(friendSec?.slack));

    $('meBadge').textContent = STATE_LABEL[me.key] || '';
    $('meBadge').className = `badge ${me.key}`;
    $('meWhat').textContent = whatText(me);
    splitBar($('meBar'), mySec, scale);
    numsRow($('meNums'), mySec);

    $('friendName').textContent = fv.name || '搭子';
    $('friendBadge').textContent = fv.name ? STATE_LABEL[fv.key] || '' : '还没加入';
    $('friendBadge').className = `badge ${fv.key}`;
    $('friendWhat').textContent = whatText(fv);
    splitBar($('friendBar'), friendSec, scale);
    numsRow($('friendNums'), friendSec);
    $('pokeBtn').disabled = !fv.name || fv.key === 'offline' || state.connection?.state !== 'online';
  }
  $('pokeBtn').addEventListener('click', async () => {
    const r = await buddy.poke('戳戳你，该学习啦～');
    // 地方窄，结果直接写在按钮上，过一会儿变回来。太频繁被服务器挡下的话，小狗那边会冒气泡说还要等多久
    $('pokeBtn').textContent = r.sent ? '已戳 ✓' : '没发出去';
    $('pokeBtn').title = r.sent ? '' : r.reason || '';
    setTimeout(() => ($('pokeBtn').textContent = '戳一下'), 2500);
  });

  // 两个人今天的计划
  let todayJournal = null; // { date, today, me, friend: { name, journal } }
  async function loadTodayJournal() {
    todayJournal = await buddy.getJournal();
    renderTodayPlans();
  }
  function renderTodayPlans() {
    const d = todayJournal;
    if (!d) return;
    const mine = journalProgress(d.me);
    const reviewed = !!d.me?.reviewAt;
    $('myPlanCount').textContent = mine ? `${mine.done} / ${mine.total}${reviewed ? ' · 已复盘' : ''}` : '';
    $('toReview').textContent = mine ? (reviewed ? '看复盘' : '写复盘') : '写计划';
    if (!mine) $('myPlan').replaceChildren(el('div', 'empty', '还没写今日计划'));
    else {
      $('myPlan').replaceChildren(
        ...d.me.items.map((it) => {
          const box = el('input');
          box.type = 'checkbox';
          box.checked = !!it.done;
          box.disabled = reviewed; // 复盘之后在「计划」页里改
          box.addEventListener('change', async () => {
            it.done = box.checked;
            const r = await buddy.saveJournal('plan', { date: d.date, items: d.me.items });
            if (r.ok) d.me = r.journal;
            renderTodayPlans();
          });
          return el('label', `todo${it.done ? ' done' : ''}`, '', box, el('span', '', it.text));
        })
      );
    }
    const f = d.friend;
    const theirs = journalProgress(f?.journal);
    $('friendPlanTitle').textContent = `${f?.name || '搭子'}的计划`;
    $('friendPlanCount').textContent = theirs ? `${theirs.done} / ${theirs.total}${f.journal.reviewAt ? ' · 已复盘' : ''}` : '';
    $('friendPlan').replaceChildren(theirs ? journalView(f.journal) : el('div', 'empty', f ? 'TA 还没写今日计划' : '还没有搭子加入房间'));
  }
  $('toReview').addEventListener('click', () => go('plan', { tab: 'today' }));
  $('toTomorrow').addEventListener('click', () => go('plan', { tab: 'tomorrow' }));

  function renderToday() {
    const t = todayStr();
    $('todayDate').textContent = `${md(t)} ${dow(t)}`;
    renderHero();
    renderVersus();
  }

  // =====================================================================
  // 统计
  // =====================================================================
  const stats = { mode: 'day', who: 'me', date: todayStr(), cat: 'study', all: false, data: null };
  let statsSeq = 0;

  async function loadStats() {
    const seq = ++statsSeq;
    const data = await (stats.mode === 'week' ? buddy.statsWeek(stats.date) : buddy.statsDay(stats.date));
    if (seq !== statsSeq) return; // 中途又切了一次，这份过时了
    stats.data = data;
    renderStats();
  }
  // 开着统计页、看的又是今天（这一周）时，隔一会儿刷新一下
  setInterval(() => {
    if (page !== 'stats' || document.hidden || !stats.data) return;
    const current = stats.mode === 'week' ? stats.data.to >= stats.data.today : stats.data.date === stats.data.today;
    if (current) loadStats();
  }, 30_000);

  function setStats(patch) {
    Object.assign(stats, patch, patch.cat || patch.all !== undefined ? {} : { all: false });
    if (patch.cat || patch.all !== undefined) return renderStats(); // 只是换了明细看哪一类，不用重新取数
    loadStats();
  }
  $('statsPrev').addEventListener('click', () => setStats({ date: shift(stats.date, stats.mode === 'week' ? -7 : -1) }));
  $('statsNext').addEventListener('click', () => setStats({ date: shift(stats.date, stats.mode === 'week' ? 7 : 1) }));

  function tile(k, v, d, main = false) {
    return el('div', `tile${main ? ' main' : ''}`, '', el('div', 'k', k), el('div', 'v', v), el('div', 'd', d));
  }
  /** 「比前一天多 1h35m」；差不到一分钟算差不多；没得比返回空 */
  function delta(cur, prev, than) {
    if (prev === null || prev === undefined) return '';
    const diff = Math.round(num(cur)) - Math.round(num(prev));
    if (Math.abs(diff) < 60) return `和${than}差不多`;
    return `比${than}${diff > 0 ? '多' : '少'} ${fmt(Math.abs(diff))}`;
  }
  /** 明细的几行：名字 + 条 + 时长。withDomain：认得出名字的网站后面再跟上域名（地方窄就不跟） */
  function topRows(list, cat, limit, withDomain = true) {
    const items = (Array.isArray(list) ? list : [])
      .map((e) => ({ name: entryName(e), domain: typeof e?.domain === 'string' && SITE_NAMES[e.domain] ? e.domain : '', sec: num(e?.sec) }))
      .filter((e) => e.name && e.sec > 0);
    const shown = items.slice(0, limit);
    const rest = items.slice(limit).reduce((s, e) => s + e.sec, 0);
    if (rest >= 60) shown.push({ name: '其他', domain: '', sec: rest, other: true });
    const max = Math.max(1, ...shown.map((e) => e.sec));
    return shown.map((e) => {
      const name = el('div', 'name', e.name);
      if (e.domain && withDomain) name.append(el('small', '', e.domain));
      name.title = e.domain || e.name;
      const fill = el('span', `fill ${cat}`);
      fill.style.width = `${(e.sec / max) * 100}%`;
      return el('div', `top-row${e.other ? ' other' : ''}`, '', name, el('div', 'track', '', fill), el('div', 'dur', fmt(e.sec)));
    });
  }
  function legend() {
    return el('div', 'legend', '', el('span', '', '', el('i', 'study'), '学习'), el('span', '', '', el('i', 'slack'), '摸鱼'));
  }
  /** 图的刻度和横线：ticks 是 [{ at: 0–1（从下往上）, label }] */
  function axisAndGrid(plot, ticks) {
    const axis = el('div', 'axis');
    const area = el('div', 'plot');
    for (const t of ticks) {
      const top = `calc(16px + ${(1 - t.at) * 100}% - ${(1 - t.at) * 16}px)`; // 上面留的 16px 不算在刻度里
      const label = el('span', '', t.label);
      label.style.top = top;
      axis.append(label);
      const line = el('div', `grid-line${t.at === 0 ? ' base' : ''}`);
      line.style.top = top;
      area.append(line);
    }
    area.append(plot);
    return [axis, area];
  }
  const gridCols = (n) => `repeat(${n}, minmax(0, 1fr))`;

  // ----- 某一天 -----
  function hoursChart(hours) {
    const total = hours.study.map((s, i) => num(s) + num(hours.slack[i]));
    const first = total.findIndex((s) => s >= 30);
    const start = Math.min(8, first < 0 ? 8 : first); // 平时从 8 点画起，更早就有记录的话往前挪
    const n = 24 - start;
    const cols = el('div', 'cols');
    cols.style.gridTemplateColumns = gridCols(n);
    const labels = el('div', 'x-labels');
    labels.style.gridTemplateColumns = gridCols(n);
    for (let h = start; h < 24; h++) {
      const col = el('div', 'stack');
      // 上面是摸鱼、下面是学习，中间留一条缝
      for (const cat of ['slack', 'study']) {
        const sec = Math.min(3600, num(hours[cat][h]));
        if (sec < 30) continue;
        const bar = el('div', `bar ${cat}`);
        bar.style.height = `calc((100% - 16px) * ${sec / 3600})`;
        bar.title = `${h} 点 ${CAT_LABEL[cat]} ${fmt(sec)}`;
        col.append(bar);
      }
      cols.append(col);
      labels.append(el('div', '', String(h)));
    }
    const [axis, area] = axisAndGrid(cols, [{ at: 1, label: '60m' }, { at: 0.5, label: '30m' }, { at: 0, label: '0' }]);
    return el('div', 'chart hours', '', axis, area, el('div'), labels);
  }
  function renderDay(d) {
    const person = stats.who === 'friend' && d.friend ? d.friend : d.me;
    const isFriend = person !== d.me;
    const isToday = d.date === d.today;
    const than = isToday ? '昨天' : '前一天';
    const prev = isFriend ? null : d.prev;
    $('statsRange').textContent = `${md(d.date)} ${dow(d.date)}${isToday ? ' · 今天' : ''}`;
    $('statsNext').disabled = d.date >= d.today;
    $('statsTiles').replaceChildren(
      tile('学习时长', fmt(person.sec.study), delta(person.sec.study, prev?.study, than), true),
      tile('摸鱼时长', fmt(person.sec.slack), delta(person.sec.slack, prev?.slack, than)),
      tile('计划完成', person.plan ? `${person.plan.done} / ${person.plan.total}` : '—', person.plan ? (person.plan.reviewed ? '已复盘' : '还没复盘') : '没写计划'),
      isFriend ? tile('番茄钟', '—', '只记自己的') : tile('番茄钟', `${d.me.pomo.count} 个`, d.me.pomo.count ? `专注 ${fmt(d.me.pomo.focusMin * 60)}` : '')
    );
    const note = !person.recorded
      ? isFriend
        ? '这一天没有收到 TA 的时长。搭子的时长是 TA 在线时发过来的，从装上这个版本开始才会存下来。'
        : '这一天没有时长记录：按天的时长是从装上这个版本开始存的。计划和复盘不受影响。'
      : '';
    $('statsNote').textContent = note;
    $('statsNote').classList.toggle('hidden', !note);

    const body = [];
    if (!isFriend) {
      body.push(
        el('div', 'card chart-card', '', el('div', 'chart-head', '', el('b', '', isToday ? '今天什么时候在学' : '这一天什么时候在学'), el('span', 'muted small', '每小时里的分钟数'), legend()), hoursChart(d.me.hours))
      );
    }
    // 计划
    const planCard = el('div', 'card list-card');
    planCard.append(el('div', 'card-head', '', el('b', '', isToday ? '今日计划' : '这一天的计划'), el('span', 'grow'), el('span', 'muted small', person.plan ? `完成 ${person.plan.done} / ${person.plan.total}` : '')));
    if (!person.items.length) planCard.append(el('div', 'empty', '没有写计划'));
    for (const it of person.items) planCard.append(el('div', `todo${it.done ? ' done' : ''}`, '', el('b', it.done ? 'mark yes' : 'mark', it.done ? '✓' : '○'), el('span', '', it.text)));
    // 明细
    const listCard = el('div', 'card list-card');
    const catSeg = el('div', 'seg mini');
    seg(catSeg, ['study', 'slack'].map((c) => ({ id: c, cls: c, label: CAT_LABEL[c] })), stats.cat, (c) => setStats({ cat: c, all: false }));
    const list = person.top[stats.cat] || [];
    const LIMIT = 4; // 平时列时间最长的 4 项，剩下的合成「其他」；点「全部」展开
    const more = el('a', 'small', stats.all ? '收起' : `全部 ${list.length} 项`);
    more.href = '#';
    more.addEventListener('click', (e) => {
      e.preventDefault();
      setStats({ all: !stats.all });
    });
    listCard.append(el('div', 'card-head', '', el('b', '', '时长明细'), ...(list.length > LIMIT ? [more] : []), el('span', 'grow'), catSeg));
    const rows = topRows(list, stats.cat, stats.all ? Infinity : LIMIT);
    if (!rows.length) listCard.append(el('div', 'empty', `没有${CAT_LABEL[stats.cat]}记录`));
    listCard.append(...rows);
    body.push(el('div', 'day-grid', '', planCard, listCard));
    $('statsBody').replaceChildren(...body);
  }

  // ----- 某一周 -----
  /** 纵轴的格子：每格多少小时，四格刚好装下最大的那一天 */
  function hourStep(maxSec) {
    const h = num(maxSec) / 3600;
    return [0.5, 1, 1.5, 2, 3, 4, 6].find((s) => s * 4 >= h) || 6;
  }
  const hourLabel = (h) => (h === 0 ? '0' : h < 1 ? `${h * 60}m` : `${h}h`);
  function weekChart(w, who) {
    const max = Math.max(...w.days.map((d) => Math.max(d[who].sec.study, d[who].sec.slack)));
    const step = hourStep(max);
    const top = step * 4 * 3600;
    const cols = el('div', 'cols');
    cols.style.gridTemplateColumns = gridCols(7);
    const labels = el('div', 'x-labels');
    labels.style.gridTemplateColumns = gridCols(7);
    for (const d of w.days) {
      const col = el('div');
      const sec = d[who].sec;
      for (const cat of ['study', 'slack']) {
        if (sec[cat] < 60) continue;
        const bar = el('div', `bar ${cat}`);
        bar.title = `${dow(d.date)} ${CAT_LABEL[cat]} ${fmt(sec[cat])}`;
        if (cat === 'study') {
          // 学习的那根顶上写着时长；柱子的高度要把这行字让出来
          const wrap = el('div', 'bar-wrap', '', el('em', '', fmt(sec.study)), bar);
          wrap.style.height = '100%';
          wrap.style.justifyContent = 'flex-end';
          bar.style.height = `calc((100% - 16px) * ${Math.min(1, sec.study / top)})`;
          bar.style.flex = 'none';
          col.append(wrap);
        } else {
          bar.style.height = `calc((100% - 16px) * ${Math.min(1, sec.slack / top)})`;
          col.append(bar);
        }
      }
      cols.append(col);
      labels.append(el('div', d.date === w.today ? 'now' : '', d.date === w.today ? '今天' : dow(d.date)));
    }
    const [axis, area] = axisAndGrid(cols, [4, 3, 2, 1, 0].map((k) => ({ at: k / 4, label: hourLabel(step * k) })));
    const chart = el('div', 'chart', '', axis, area, el('div'), labels);

    // 下面两行和柱子对齐：每天的计划完成、番茄数
    const planCells = el('div', 'row-cells tall');
    planCells.style.gridTemplateColumns = gridCols(7);
    for (const d of w.days) {
      const p = d[who].plan;
      if (!p) planCells.append(el('span', 'dim', d.future ? '' : '—'));
      else {
        const m = el('div');
        m.style.width = `${p.total ? (p.done / p.total) * 100 : 0}%`;
        planCells.append(el('div', 'meter-cell', '', el('span', '', `${p.done}/${p.total}`), el('div', 'meter', '', m)));
      }
    }
    chart.append(el('div', 'row-label tall', '计划'), planCells);
    if (who === 'me') {
      const pomoCells = el('div', 'row-cells short');
      pomoCells.style.gridTemplateColumns = gridCols(7);
      for (const d of w.days) pomoCells.append(el('span', d.me.pomo ? '' : 'dim', d.future ? '' : d.me.recorded ? String(d.me.pomo) : '—'));
      chart.append(el('div', 'row-label short', '番茄'), pomoCells);
    }
    return chart;
  }
  function renderWeek(w) {
    const who = stats.who === 'friend' && w.friend ? 'friend' : 'me';
    const person = w[who];
    const current = w.to >= w.today;
    $('statsRange').textContent = `${md(w.from)} – ${md(w.to)}`;
    $('statsNext').disabled = current;
    const rate = person.plan.total ? `完成率 ${Math.round((person.plan.done / person.plan.total) * 100)}% · 复盘 ${person.plan.reviewedDays} 天` : '没写计划';
    $('statsTiles').replaceChildren(
      tile('学习时长', fmt(person.sec.study), who === 'me' ? delta(person.sec.study, w.prev?.study, '上周') : '', true),
      tile('摸鱼时长', fmt(person.sec.slack), who === 'me' ? delta(person.sec.slack, w.prev?.slack, '上周') : ''),
      tile('计划完成', person.plan.total ? `${person.plan.done} / ${person.plan.total}` : '—', rate),
      who === 'me' ? tile('番茄钟', `${w.me.pomo.count} 个`, w.me.pomo.count ? `专注 ${fmt(w.me.pomo.focusMin * 60)}` : '') : tile('番茄钟', '—', '只记自己的')
    );
    const note = !person.recordedDays
      ? who === 'me'
        ? '这一周没有时长记录：按天的时长是从装上这个版本开始存的。计划和复盘不受影响。'
        : '这一周没有收到 TA 的时长。搭子的时长是 TA 在线时发过来的，从装上这个版本开始才会存下来。'
      : '';
    $('statsNote').textContent = note;
    $('statsNote').classList.toggle('hidden', !note);

    const chartCard = el('div', 'card chart-card', '', el('div', 'chart-head', '', el('b', '', '每天的学习和摸鱼'), legend()), weekChart(w, who));
    const tops = el('div', 'col');
    for (const cat of ['study', 'slack']) {
      const rows = topRows(person.top[cat], cat, 4, false);
      const card = el('div', 'card top-card', '', el('b', '', cat === 'study' ? '学得最多' : '摸鱼最多'));
      card.append(...(rows.length ? rows : [el('div', 'empty', '没有记录')]));
      tops.append(card);
    }
    $('statsBody').replaceChildren(el('div', 'week-grid', '', chartCard, tops));
  }

  function renderStats() {
    const d = stats.data;
    if (!d) return;
    const friendName = d.friend?.name;
    if (stats.who === 'friend' && !friendName) stats.who = 'me'; // 这段时间没有搭子的记录
    seg($('statsMode'), [{ id: 'day', label: '按天' }, { id: 'week', label: '按周' }], stats.mode, (m) => setStats({ mode: m, date: m === 'day' && stats.date > todayStr() ? todayStr() : stats.date }));
    seg($('statsWho'), [{ id: 'me', label: '我' }, ...(friendName ? [{ id: 'friend', label: String(friendName) }] : [])], stats.who, (id) => {
      stats.who = id;
      stats.all = false;
      renderStats();
    });
    if (stats.mode === 'week' && d.days) renderWeek(d);
    else if (stats.mode === 'day' && d.me) renderDay(d);
  }

  // =====================================================================
  // 计划
  // =====================================================================
  const plan = { tab: 'today', data: null, items: [], improveTouched: false };

  function planMsg(text, err = false) {
    $('planMsg').textContent = text;
    $('planMsg').className = err ? 'err' : '';
    if (text && !err) setTimeout(() => $('planMsg').textContent === text && ($('planMsg').textContent = ''), 2500);
  }
  async function loadPlan() {
    seg($('planTabs'), [{ id: 'today', label: '今天' }, { id: 'tomorrow', label: '明天' }, { id: 'history', label: '历史' }], plan.tab, (t) => {
      plan.tab = t;
      loadPlan();
    });
    const history = plan.tab === 'history';
    $('planEdit').classList.toggle('hidden', history);
    $('planHistory').classList.toggle('hidden', !history);
    $('planDate').textContent = history ? '明天和最近 7 天' : '';
    planMsg('');
    if (history) return;
    const today = todayStr();
    const d = await buddy.getJournal(plan.tab === 'tomorrow' ? shift(today, 1) : today);
    plan.data = d;
    plan.items = (d.me?.items || []).map((it) => ({ ...it }));
    plan.improveTouched = false;
    if (!d.me?.planAt || d.date > d.today) while (plan.items.length < 3) plan.items.push({ text: '', done: false, reason: '' });
    $('planDate').textContent = `${md(d.date)} ${dow(d.date)}`;
    renderPlan();
    renderPlanFriend();
    loadRecent();
  }

  function renderPlan() {
    const d = plan.data;
    if (!d) return;
    const future = d.date > d.today; // 提前写明天的：只能编辑条目，不能勾选
    const planned = !!d.me?.planAt && !future;
    const reviewed = planned && !!d.me.reviewAt;
    const filled = plan.items.filter((it) => String(it.text || '').trim());
    $('planTitle').textContent = future ? '明天要做的事' : '今天要做的事';
    $('planCount').textContent = planned ? `${filled.filter((it) => it.done).length} / ${filled.length}` : '';
    $('planHint').textContent = reviewed
      ? '今天已经复盘过了。完成情况和原因还可以改，改完点「重新提交复盘」。'
      : planned
        ? '勾选和修改会自动保存，进度会同步给搭子。没做完的事，复盘时要写一下原因。'
        : future
          ? '提前写下明天要做的 1–8 件事。到了明天它就是今日计划，早上不会再弹窗提醒；明天搭子才会看到。'
          : '写下今天要做的 1–8 件事，保存后搭子能看到你的进度。';

    const rows = [];
    plan.items.forEach((it, i) => {
      const text = el('input', 'text');
      Object.assign(text, { type: 'text', maxLength: 60, value: it.text || '', placeholder: `要做的事 ${i + 1}`, disabled: reviewed });
      text.setAttribute('aria-label', `第 ${i + 1} 条`);
      text.addEventListener('input', () => (it.text = text.value));
      text.addEventListener('change', () => planned && savePlan());
      text.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        if (i === plan.items.length - 1) addItem();
        else $('planList').querySelectorAll('input.text')[i + 1]?.focus();
      });
      let lead = el('span', 'num', `${i + 1}.`);
      if (planned) {
        lead = el('input');
        Object.assign(lead, { type: 'checkbox', checked: !!it.done, title: '做完了就勾上' });
        lead.addEventListener('change', () => {
          it.done = lead.checked;
          if (!reviewed) savePlan();
          renderPlan();
        });
      }
      const row = el('div', `plan-row${it.done && planned ? ' done' : ''}`, '', lead, text);
      if (!reviewed) {
        const x = button('x', '✕', () => {
          plan.items.splice(i, 1);
          if (!plan.items.length) plan.items.push({ text: '', done: false, reason: '' });
          if (planned) savePlan();
          renderPlan();
        });
        x.title = '删掉这一条';
        row.append(x);
      }
      rows.push(row);
      // 没做完的：下面一行写原因（复盘时必填）
      if (planned && !it.done && String(it.text || '').trim()) {
        const reason = el('input', it.missing ? 'err' : '');
        Object.assign(reason, { type: 'text', maxLength: 120, value: it.reason || '', placeholder: '没完成的原因（复盘时要写）' });
        reason.setAttribute('aria-label', `没完成的原因：${it.text}`);
        reason.addEventListener('input', () => {
          it.reason = reason.value;
          it.missing = false;
          reason.classList.remove('err');
        });
        reason.addEventListener('change', () => !reviewed && savePlan());
        rows.push(el('div', 'plan-row reason', '', reason));
      }
    });
    $('planList').replaceChildren(...rows);
    $('planAdd').classList.toggle('hidden', reviewed || plan.items.length >= MAX_ITEMS);
    $('reviewBox').classList.toggle('hidden', !planned);
    if (planned && !plan.improveTouched) $('improve').value = d.me.improve || '';
    $('planSave').classList.toggle('hidden', planned);
    $('planSave').textContent = future ? '保存明日计划' : '保存计划';
    $('reviewSave').classList.toggle('hidden', !planned);
    $('reviewSave').textContent = reviewed ? '重新提交复盘' : '完成复盘';
  }
  function addItem() {
    if (plan.items.length >= MAX_ITEMS) return;
    plan.items.push({ text: '', done: false, reason: '' });
    renderPlan();
    const inputs = $('planList').querySelectorAll('input.text');
    inputs[inputs.length - 1]?.focus();
  }
  async function savePlan() {
    const d = plan.data;
    const first = !d.me?.planAt;
    const r = await buddy.saveJournal('plan', { date: d.date, items: plan.items });
    if (!r.ok) return planMsg(r.error, true);
    d.me = r.journal;
    if (d.date > d.today) return planMsg('明日计划已保存 ✓ 明天搭子才会看到');
    planMsg(first ? '计划已保存 ✓ 搭子能看到你的进度了' : '已保存 ✓');
    if (first) {
      plan.items = plan.items.filter((it) => String(it.text || '').trim());
      renderPlan();
    } else $('planCount').textContent = `${d.me.items.filter((it) => it.done).length} / ${d.me.items.length}`;
  }
  async function submitReview() {
    const d = plan.data;
    plan.items = plan.items.filter((it) => String(it.text || '').trim());
    for (const it of plan.items) it.missing = !it.done && !String(it.reason || '').trim();
    if (plan.items.some((it) => it.missing)) {
      renderPlan();
      $('planList').querySelector('input.err')?.focus();
      return planMsg('没完成的事要写一下原因', true);
    }
    const r = await buddy.saveJournal('review', { date: d.date, items: plan.items, improve: $('improve').value });
    if (!r.ok) return planMsg(r.error, true);
    d.me = r.journal;
    plan.improveTouched = false;
    planMsg('复盘已提交 ✓ 辛苦啦');
    renderPlan();
  }
  $('planAdd').addEventListener('click', addItem);
  $('planSave').addEventListener('click', savePlan);
  $('reviewSave').addEventListener('click', submitReview);
  $('improve').addEventListener('input', () => (plan.improveTouched = true));
  $('planAll').addEventListener('click', (e) => {
    e.preventDefault();
    plan.tab = 'history';
    loadPlan();
  });

  function renderPlanFriend() {
    const f = plan.data?.friend;
    const p = journalProgress(f?.journal);
    $('planFriendTitle').textContent = `${f?.name || '搭子'}今天的计划`;
    $('planFriendCount').textContent = p ? `${p.done} / ${p.total}${f.journal.reviewAt ? ' · 已复盘' : ''}` : '';
    $('planFriend').replaceChildren(p ? journalView(f.journal) : el('div', 'empty', f ? 'TA 还没写今日计划' : '还没有搭子加入房间'));
  }
  /** 右下角那几行：前几天各完成了多少、复盘了没有。昨天的没复盘可以在这里补 */
  async function loadRecent() {
    const { today, days } = await buddy.journalHistory();
    const yesterday = shift(today, -1);
    const past = days.filter((d) => d.date < today);
    $('planRecent').replaceChildren(
      ...(past.length ? past : []).map((d) => {
        const p = journalProgress(d.me);
        const st = el('div', `st${p && !d.me.reviewAt ? ' miss' : ''}`, p ? (d.me.reviewAt ? '已复盘' : '没复盘') : '没写');
        if (p && !d.me.reviewAt && d.date === yesterday) st.replaceChildren(button('', '补复盘', () => buddy.openJournal('review-yesterday')));
        return el('div', 'recent-row', '', el('div', '', `${dow(d.date)} ${md(d.date)}`), el('div', 'rate', p ? p.text : '—'), st);
      })
    );
  }

  // =====================================================================
  // 设置页上点了马上生效的几项（表单本身在 settings.js）
  // =====================================================================
  function renderSettingsExtras() {
    const scales = [[0.75, '小'], [1, '标准'], [1.5, '大'], [2, '特大']];
    seg($('petScaleSeg'), scales.map(([s, name]) => ({ id: s, label: name })), state.petScale, (s) => buddy.setPetScale(s));
    seg($('petViewSeg'), [{ id: 'friend', label: '搭子的状态' }, { id: 'me', label: '我自己的状态' }], state.petView === 'me' ? 'me' : 'friend', (v) => buddy.setPetView(v));
    seg($('petSkinSeg'), (state.skins || []).map(([id, label]) => ({ id, label })), state.petSkin || 'dog', (id) => buddy.setPetSkin(id));
    $('versionText').textContent = `当前版本 ${state.version || '—'}`;
    $('updateBtn').textContent = state.updateReady ? `重启并更新到 ${state.updateReady}` : '检查更新';
  }
  $('updateBtn').addEventListener('click', () => buddy.checkUpdate());

  // ---------- 启动 ----------
  buddy.onState((s) => {
    state = s;
    renderSide();
    renderToday();
    renderSettingsExtras();
  });
  // 自己或搭子的计划变了：今天页重新取；计划页只刷新对方的那一栏，正在编辑的不动，免得把没保存的字冲掉
  buddy.onJournalChanged(async () => {
    loadTodayJournal();
    if (page !== 'plan' || plan.tab === 'history' || !plan.data) return;
    const fresh = await buddy.getJournal(plan.data.date);
    plan.data.friend = fresh.friend;
    renderPlanFriend();
    loadRecent();
  });
  buddy.onPanelGo((g) => go(g?.page, g || {}));
  go(query.get('page'), { who: query.get('who') });
})();
