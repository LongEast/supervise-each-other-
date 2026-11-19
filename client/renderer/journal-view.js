// 只读地展示一份计划 / 复盘：「查看 TA 的计划」窗口和设置页的历史共用。
// 全部用 textContent 填内容，对方写什么都不会被当成 HTML。
// eslint-disable-next-line no-unused-vars
function journalView(j) {
  const div = (cls, text = '') => {
    const d = document.createElement('div');
    d.className = cls;
    d.textContent = text;
    return d;
  };
  const box = div('jv');
  if (!j || !j.planAt || !j.items.length) {
    box.append(div('jv-empty', '没有写计划'));
    return box;
  }
  for (const it of j.items) {
    // 复盘之前没勾的只是「还没做」，复盘之后才算「没完成」
    const mark = document.createElement('span');
    mark.className = 'jv-mark' + (it.done ? ' yes' : j.reviewAt ? ' no' : '');
    mark.textContent = it.done ? '✓' : j.reviewAt ? '✗' : '○';
    const body = div('jv-body');
    body.append(div('jv-text', it.text));
    if (!it.done && it.reason) body.append(div('jv-reason', '原因：' + it.reason));
    const row = div('jv-item');
    row.append(mark, body);
    box.append(row);
  }
  if (j.improve) box.append(div('jv-improve', '明天想改进：' + j.improve));
  return box;
}

/** 「3/4」这样的完成进度；没写计划返回 null */
// eslint-disable-next-line no-unused-vars
function journalProgress(j) {
  if (!j || !j.planAt) return null;
  const done = j.items.filter((it) => it.done).length;
  return { done, total: j.items.length, text: `${done}/${j.items.length}`, pct: j.items.length ? Math.round((done / j.items.length) * 100) : 0 };
}
