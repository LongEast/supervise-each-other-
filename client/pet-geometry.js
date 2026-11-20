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

module.exports = { clampScale, petSize, rescaleBounds, SCALE_MIN, SCALE_MAX, SCALE_STEP };
