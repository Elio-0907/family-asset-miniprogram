// 股票代码规范化 + 新浪行情解析。小程序端和云函数共用（改完跑 scripts/sync-utils.sh）。

/**
 * 用户随手输的代码 → 新浪行情代码
 *   600036 → sh600036   000001 → sz000001   00700 → hk00700
 *   510300 → sh510300   159915 → sz159915   688981 → sh688981
 */
function normalizeCode(input) {
  const s = String(input || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!s) return '';
  if (/^(sh|sz|bj|hk)\d+$/.test(s)) return s;
  if (/^\d{5}$/.test(s)) return 'hk' + s;
  if (/^\d{6}$/.test(s)) {
    const c = s[0];
    if (c === '6' || c === '5' || c === '9') return 'sh' + s;   // 沪市主板/科创板/沪市 ETF
    if (c === '0' || c === '3' || c === '1' || c === '2') return 'sz' + s;  // 深市/创业板/深市 ETF
    if (c === '4' || c === '8') return 'bj' + s;               // 北交所
  }
  return '';
}

function marketOf(code) {
  if (/^hk/.test(code)) return 'HK';
  if (/^(sh|sz|bj)/.test(code)) return 'CN';
  return '';
}

/**
 * 解析新浪返回的整段文本（已解码为 UTF-8）
 * @returns {{ quotes: {code: {name, price, prevClose, date, currency}}, fx: {HKDCNY: number} }}
 *   price 单位：元（原币），由调用方换算成人民币分
 */
function parseSina(text) {
  const quotes = {}, fx = {};
  const re = /hq_str_([A-Za-z0-9_]+)="([^"]*)"/g;
  let m;
  while ((m = re.exec(text))) {
    const code = m[1], f = m[2].split(',');
    if (!m[2]) continue;
    if (code === 'HKDCNY' || code === 'USDCNY') {
      const r = Number(f[1]);
      if (r > 0) fx[code] = r;
    } else if (/^hk/.test(code)) {
      const price = Number(f[6]);
      if (price > 0) quotes[code] = {
        name: f[1], price: price, prevClose: Number(f[3]),
        date: (f[17] || '').replace(/\//g, '-'), currency: 'HKD'
      };
    } else if (/^(sh|sz|bj)/.test(code)) {
      const price = Number(f[3]);
      if (price > 0) quotes[code] = {
        name: f[0], price: price, prevClose: Number(f[2]),
        date: f[30] || '', currency: 'CNY'
      };
    }
  }
  return { quotes: quotes, fx: fx };
}

/** 一笔市值型资产：Σ 股数 × 人民币价 + 现金，单位分 */
function holdingsValue(holdings, cash) {
  let v = 0;
  (holdings || []).forEach(function (h) {
    if (h.price > 0 && h.shares > 0) v += Math.round(h.shares * h.price);   // h.price 已是人民币分
  });
  return v + (cash || 0);
}

module.exports = { normalizeCode, marketOf, parseSina, holdingsValue };
