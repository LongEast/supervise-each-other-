// 小狗现在演的是谁、处在什么状态。纯函数：小狗窗口用 <script> 加载，测试里直接 require。
// 默认演搭子；右键小狗可以换成演自己，这时看到的就是搭子眼里的你。
/* eslint-disable no-unused-vars */

/** 搭子：{ key, name, status }。key 是 study / slack / neutral / away / private / paused / offline */
function friendView(state) {
  const f = state?.friend;
  if (!f) return { key: 'offline', name: null };
  if (!f.online) return { key: 'offline', name: f.name, status: f.status };
  const s = f.status;
  if (!s) return { key: 'neutral', name: f.name, status: null };
  if (s.paused) return { key: 'paused', name: f.name, status: s };
  return { key: s.category || 'neutral', name: f.name, status: s };
}

/** 自己：用的是发给搭子的那份状态，所以没连上服务器时也有，也不会是 offline */
function meView(state) {
  const s = state?.me?.status;
  const name = state?.me?.name || '';
  if (!s) return { me: true, key: 'neutral', name, status: null };
  if (s.paused) return { me: true, key: 'paused', name, status: s };
  return { me: true, key: s.category || 'neutral', name, status: s };
}

/** 小狗现在该演的那个人 */
function petView(state) {
  return state?.petView === 'me' ? meView(state) : friendView(state);
}

if (typeof module !== 'undefined') module.exports = { friendView, meView, petView };
