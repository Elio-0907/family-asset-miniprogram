// 金额一律以「分」为单位的整数存储，显示时才转成元。
// 不要用浮点存钱，0.1 + 0.2 !== 0.3 这件事在账本里是致命的。

function group(n) {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** 分 → '1,234'（四舍五入到元，家庭账本不看分） */
function yuan(fen) {
  const n = Math.round((fen || 0) / 100);
  return (n < 0 ? '−' : '') + group(Math.abs(n));
}

/** 分 → '¥1,234' */
function cny(fen) {
  return '¥' + yuan(fen);
}

/** 分 → '12.3万'，用于图表坐标轴 */
function wan(fen) {
  const w = (fen || 0) / 1000000;
  return (Math.abs(w) >= 10 ? Math.round(w) : w.toFixed(1)) + '万';
}

/** 用户输入的元（字符串或数字）→ 分（整数） */
function toFen(input) {
  if (input === '' || input === null || input === undefined) return 0;
  const n = Number(String(input).replace(/[,，\s¥]/g, ''));
  if (!isFinite(n)) return 0;
  return Math.round(n * 100);
}

/** 分 → 输入框里显示的元（保留必要的小数） */
function toYuanInput(fen) {
  if (!fen) return '';
  const n = fen / 100;
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

/** 带正负号，用于盈亏 */
function signed(fen) {
  return (fen >= 0 ? '+¥' : '−¥') + group(Math.abs(Math.round(fen / 100)));
}

function pct(v, digits) {
  const d = digits === undefined ? 2 : digits;
  return (v >= 0 ? '' : '−') + Math.abs(v).toFixed(d) + '%';
}

module.exports = { yuan, cny, wan, toFen, toYuanInput, signed, pct, group };
