// 小狗窗口的大小和位置怎么跟着缩放变。纯函数，方便测试。
// 缩放的只有小狗本身；卡片 / 菜单 / 气泡保持原来的大小（缩小了字就看不清了），
// 所以窗口 = 上面留给卡片的固定空间 + 下面随缩放变的小狗。数字要和 renderer/pet.css 里的一致。

const PET_BASE_W = 150; // 缩放 100% 时小狗的宽高（pet.css 里 #pet 的尺寸）
const PET_BASE_H = 131;
const WIN_MIN_W = 280; // 卡片宽 248，两边留点阴影的位置
const OVERLAY_H = 249; // 小狗上方留给卡片的高度 + 名牌的高度
const SCALE_MIN = 0.6;
const SCALE_MAX = 2.5;
const SCALE_STEP = 0.1; // 滚轮滚一格
const NAMETAG_H = 24; // 小狗下面的名牌（pet.css 里 .nametag）大约多高

/** 把任意输入变成合法的缩放比例（0.05 一档，免得存下 1.2000000000000002 这种数） */
function clampScale(s) {
  const n = Number(s);
  if (!Number.isFinite(n) || n <= 0) return 1;
  return Math.min(SCALE_MAX, Math.max(SCALE_MIN, Math.round(n * 20) / 20));
}

/** 这个缩放比例下窗口多大 */
function petSize(scale) {
  const s = clampScale(scale);
  return { width: Math.max(WIN_MIN_W, Math.round(PET_BASE_W * s) + 20), height: Math.round(PET_BASE_H * s) + OVERLAY_H };
}

/** 换缩放比例后窗口放哪：小狗的脚（窗口底边的中点）留在屏幕上原来的位置 */
function rescaleBounds(pos, oldScale, newScale) {
  const a = petSize(oldScale);
  const b = petSize(newScale);
  return { x: pos.x + Math.round((a.width - b.width) / 2), y: pos.y + a.height - b.height, width: b.width, height: b.height };
}

/** 窗口里看得见、点得到的那块（小狗 + 下面的名牌）相对窗口左上角在哪。窗口上面一大截平时是透明的 */
function bodyRect(scale) {
  const s = clampScale(scale);
  const size = petSize(s);
  const width = Math.max(PET_BASE_W, Math.round(PET_BASE_W * s));
  const height = Math.round(PET_BASE_H * s) + NAMETAG_H;
  return { dx: Math.round((size.width - width) / 2), dy: size.height - height, width, height };
}

const overlap = (a, b) =>
  Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) *
  Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
const centerDist = (a, b) => Math.hypot(a.x + a.width / 2 - (b.x + b.width / 2), a.y + a.height / 2 - (b.y + b.height / 2));

/**
 * 小狗窗口放在 pos 时，保证小狗和名牌整个在某块屏幕的工作区里（不挡任务栏、不跑到屏幕外）。
 * 拔掉副屏、改分辨率 / 缩放、拖出屏幕之后，存下来的位置可能已经看不见了，这时挪进离它最近的那块屏幕。
 * workAreas: 各块屏幕的工作区 [{ x, y, width, height }]。返回窗口该放的 { x, y, width, height }。
 */
function fitOnScreen(pos, scale, workAreas) {
  const size = petSize(scale);
  const r = bodyRect(scale);
  const areas = (workAreas || []).filter((a) => a && a.width > 0 && a.height > 0);
  if (!areas.length) return { x: pos.x, y: pos.y, ...size };
  const body = { x: pos.x + r.dx, y: pos.y + r.dy, width: r.width, height: r.height };
  // 先挑和小狗重叠最多的那块屏幕；一点都不重叠就挑中心离得最近的
  const wa = areas.reduce((best, a) => {
    const d = overlap(body, a) - overlap(body, best);
    return d > 0 || (d === 0 && centerDist(body, a) < centerDist(body, best)) ? a : best;
  });
  const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), Math.max(lo, hi));
  const bx = clamp(body.x, wa.x, wa.x + wa.width - r.width);
  const by = clamp(body.y, wa.y, wa.y + wa.height - r.height);
  return { x: bx - r.dx, y: by - r.dy, ...size };
}

module.exports = { clampScale, petSize, rescaleBounds, fitOnScreen, SCALE_MIN, SCALE_MAX, SCALE_STEP };
