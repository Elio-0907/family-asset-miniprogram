// 截图解析工具（小程序端与 ocrAccount 云函数共用；改完后跑 scripts/sync-utils.sh）。
// 包含两部分：
//   1. parseAccount(blocks, scene) —— 腾讯云 OCR 坐标文本块解析（兼容券商 + 支付宝/余额截图）
//   2. normalizeAiResult(raw, scene) —— 多模态大模型返回 JSON 的清洗与校验

const MARKET_LABELS = {
  total:  ['总资产', '资产总值', '账户总资产', '总资产(元)', '资产总额', '资产总计'],
  pnl:    ['总盈亏', '累计盈亏', '持仓盈亏', '总收益', '浮动盈亏', '当日参考盈亏'],
  market: ['总市值', '证券市值', '持仓市值', '股票市值', '市值'],
  cash:   ['可用', '可用资金', '可用余额', '资金余额', '可用金额', '可取']
};

// 支付宝 / 微信 / 银行活期常见项目标签（按展示优先级排序）
const BALANCE_ITEMS = [
  { key: 'total',     label: '总资产', variants: ['总资产', '资产总额', '总资产(元)', '账户总资产', '资产总计', '总金额'] },
  { key: 'yuebao',    label: '余额宝', variants: ['余额宝'] },
  { key: 'balance',   label: '余额',   variants: ['账户余额', '可用余额', '余额', '零钱'] },
  { key: 'lingqiantong', label: '零钱通', variants: ['零钱通'] },
  { key: 'fund',      label: '基金',   variants: ['基金', '基金持仓'] },
  { key: 'wealth',    label: '理财',   variants: ['理财', '稳健理财', '定期', '理财产品'] },
  { key: 'yulibao',   label: '余利宝', variants: ['余利宝'] },
  { key: 'gold',      label: '黄金',   variants: ['黄金', '积存金'] }
];

const PLATFORM_KEYWORDS = [
  { name: '支付宝',   keys: ['支付宝', '余额宝', '蚂蚁财富', '余利宝', '花呗'] },
  { name: '微信',     keys: ['零钱通', '理财通', '微信支付', '零钱'] },
  { name: '中信证券', keys: ['中信证券', '信e投'] },
  { name: '华泰证券', keys: ['华泰证券', '涨乐财富通'] },
  { name: '东方财富', keys: ['东方财富'] },
  { name: '同花顺',   keys: ['同花顺'] },
  { name: '国泰君安', keys: ['国泰君安', '君弘'] },
  { name: '招商证券', keys: ['招商证券', '智远一户通'] },
  { name: '平安证券', keys: ['平安证券'] },
  { name: '广发证券', keys: ['广发证券', '易淘金'] },
  { name: '银河证券', keys: ['银河证券', '中国银河'] },
  { name: '富途牛牛', keys: ['富途', '牛牛'] },
  { name: '雪盈证券', keys: ['雪盈'] },
  { name: '招商银行', keys: ['招商银行', '朝朝宝'] },
  { name: '工商银行', keys: ['工商银行'] },
  { name: '建设银行', keys: ['建设银行'] },
  { name: '农业银行', keys: ['农业银行'] },
  { name: '中国银行', keys: ['中国银行'] }
];

const NUM_RE = /^[+\-−]?\s*[¥￥]?\s*\d{1,3}(,\d{3})*(\.\d+)?$|^[+\-−]?\s*[¥￥]?\s*\d+(\.\d+)?$/;

function clean(t) { return String(t || '').replace(/[\s:：]/g, ''); }

function toNumber(t) {
  if (typeof t === 'number') return isFinite(t) ? Math.round(t * 100) / 100 : null;
  if (t === null || t === undefined || t === '') return null;
  const s = String(t).replace(/[¥￥,\s元股份]/g, '').replace(/[−—–]/g, '-');
  if (!s || /^[*]+$/.test(s)) return null;
  const n = Number(s);
  return isFinite(n) ? Math.round(n * 100) / 100 : null;
}

function isNumeric(t) { return NUM_RE.test(String(t || '').trim()); }

function detectPlatform(blocks) {
  const joined = (blocks || []).map(function (b) { return b.text || ''; }).join(' ');
  for (let i = 0; i < PLATFORM_KEYWORDS.length; i++) {
    const p = PLATFORM_KEYWORDS[i];
    for (let j = 0; j < p.keys.length; j++) {
      if (joined.indexOf(p.keys[j]) >= 0) return p.name;
    }
  }
  return '';
}

/**
 * 找与标签配对的数字块：
 *   1. 标签和数字在同一文本块（如 "总资产 844,986.74"）
 *   2. 标签正下方最近的数字（券商总览、支付宝顶部总资产）
 *   3. 标签同一行右侧最近的数字（支付宝列表行，如 "余额宝    52,300.12"）
 */
function matchLabelValue(blocks, nums, variants, allowRight) {
  let label = null;
  for (let vi = 0; vi < variants.length && !label; vi++) {
    const v = variants[vi];
    label = blocks.find(function (b) { return clean(b.text) === v; }) ||
            blocks.find(function (b) { return clean(b.text).indexOf(v) === 0 && !isNumeric(b.text); });
  }

  if (!label) {
    for (let vi = 0; vi < variants.length; vi++) {
      const v = variants[vi];
      const inline = blocks.find(function (b) {
        const c = clean(b.text);
        return c.indexOf(v) === 0 && isNumeric(c.slice(v.length));
      });
      if (inline) {
        return { value: toNumber(clean(inline.text).slice(v.length)), label: v, text: inline.text, mode: 'inline' };
      }
    }
    return null;
  }

  // 先找正下方最近的数字
  const lx0 = label.x, lx1 = label.x + Math.max(label.w || 0, 40);
  const ly = label.y + (label.h || 20);
  const lh = Math.max(label.h || 20, 14);
  let best = null, bestDy = Infinity;
  nums.forEach(function (n) {
    const nx0 = n.x, nx1 = n.x + (n.w || 0);
    const overlap = Math.min(lx1, nx1) - Math.max(lx0, nx0);
    const dy = n.y - ly;
    if (dy < -5 || dy > lh * 4) return;
    if (overlap < -lh) return;
    if (dy < bestDy) { bestDy = dy; best = n; }
  });
  if (best) {
    return { value: toNumber(best.text), label: label.text, text: best.text, mode: 'below' };
  }

  // 支付宝/银行列表常见排版：左边是标签，同一行最右侧是金额
  if (allowRight) {
    const lcy = label.y + lh / 2;
    let bestR = null, bestDx = Infinity;
    nums.forEach(function (n) {
      const ncy = n.y + Math.max(n.h || 20, 14) / 2;
      const dx = n.x - lx1;
      if (Math.abs(ncy - lcy) > lh * 1.1) return;
      if (dx < -10) return;
      if (dx < bestDx) { bestDx = dx; bestR = n; }
    });
    if (bestR) {
      return { value: toNumber(bestR.text), label: label.text, text: bestR.text, mode: 'right' };
    }
  }

  return null;
}

/**
 * 腾讯云 OCR 文本块解析
 * @param {Array<{text, x, y, w, h}>} blocks
 * @param {'market'|'balance'} [scene='market']
 */
function parseAccount(blocks, scene) {
  blocks = Array.isArray(blocks) ? blocks : [];
  scene = scene === 'balance' ? 'balance' : 'market';
  const nums = blocks.filter(function (b) { return isNumeric(b.text); });
  const platform = detectPlatform(blocks);

  if (scene === 'balance') {
    const items = [];
    const hits = [];
    let total = null;
    BALANCE_ITEMS.forEach(function (def) {
      const m = matchLabelValue(blocks, nums, def.variants, true);
      if (m && m.value !== null && m.value >= 0) {
        items.push({ key: def.key, label: def.label, amount: m.value });
        hits.push({ key: def.key, label: m.label, text: m.text, mode: m.mode });
        if (def.key === 'total' && total === null) total = m.value;
      }
    });
    if (total === null && items.length) total = items[0].amount;
    return {
      total: total, pnl: null, market: null, cash: null, netIn: null,
      platform: platform, items: items, holdings: [], hits: hits
    };
  }

  // 默认：券商市值型
  const out = {
    total: null, pnl: null, market: null, cash: null, netIn: null,
    platform: platform, items: [], holdings: [], hits: []
  };
  Object.keys(MARKET_LABELS).forEach(function (key) {
    const m = matchLabelValue(blocks, nums, MARKET_LABELS[key], false);
    if (m && m.value !== null) {
      out[key] = m.value;
      out.hits.push({ key: key, label: m.label, text: m.text, mode: m.mode });
    }
  });
  if (out.total !== null && out.pnl !== null) {
    out.netIn = Math.round((out.total - out.pnl) * 100) / 100;
  }
  return out;
}

/** 从大模型回复文本里抽出 JSON 对象（兼容 ```json 代码块或前后夹带说明文字） */
function extractJsonObject(raw) {
  if (raw && typeof raw === 'object') return raw;
  const s = String(raw || '').trim();
  if (!s) return null;
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : s;
  try { return JSON.parse(candidate); } catch (e) { /* try brace slice */ }
  const i = candidate.indexOf('{');
  const j = candidate.lastIndexOf('}');
  if (i >= 0 && j > i) {
    try { return JSON.parse(candidate.slice(i, j + 1)); } catch (e) { return null; }
  }
  return null;
}

function cleanStockCode(code) {
  const s = String(code || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!s) return '';
  if (/^(sh|sz|bj)\d{6}$/.test(s)) return s.slice(2);
  if (/^hk\d{5}$/.test(s)) return s.slice(2);
  if (/^\d{5,6}$/.test(s)) return s;
  return '';
}

/**
 * 清洗并标准化多模态 AI 识图结果
 * @param {string|object} raw
 * @param {'market'|'balance'} [scene='market']
 */
function normalizeAiResult(raw, scene) {
  scene = scene === 'balance' ? 'balance' : 'market';
  const obj = extractJsonObject(raw);
  if (!obj || typeof obj !== 'object') {
    return {
      ok: false, platform: '', total: null, pnl: null, market: null, cash: null, netIn: null,
      items: [], holdings: [], error: 'AI 返回格式无法解析'
    };
  }

  const platform = typeof obj.platform === 'string' ? obj.platform.trim().slice(0, 24) : '';
  let total = toNumber(obj.total);
  const pnl = toNumber(obj.pnl);
  const market = toNumber(obj.market);
  const cash = toNumber(obj.cash);
  let netIn = toNumber(obj.netIn);

  // 余额型：子项目列表（支付宝总资产、余额宝、基金、理财、余额等）
  const items = [];
  const seenLabel = {};
  if (Array.isArray(obj.items)) {
    obj.items.forEach(function (it) {
      if (!it || typeof it !== 'object') return;
      const label = String(it.label || it.name || '').trim().slice(0, 20);
      const amount = toNumber(it.amount !== undefined ? it.amount : it.value);
      if (!label || amount === null || amount < 0) return;
      if (seenLabel[label]) return;
      seenLabel[label] = true;
      items.push({ label: label, amount: amount });
    });
  }
  if (scene === 'balance') {
    if (total !== null && total >= 0 && !seenLabel['总资产'] && items.length > 0) {
      items.unshift({ label: '总资产', amount: total });
    } else if (total !== null && total >= 0 && items.length === 0) {
      items.push({ label: platform ? platform + '总资产' : '总资产', amount: total });
    } else if (total === null && items.length > 0) {
      total = items[0].amount;
    }
  }

  // 市值型：持仓明细列表
  const holdings = [];
  const seenHold = {};
  if (Array.isArray(obj.holdings)) {
    obj.holdings.forEach(function (h) {
      if (!h || typeof h !== 'object') return;
      const code = cleanStockCode(h.code);
      const name = String(h.name || '').trim().slice(0, 24);
      const shares = toNumber(h.shares !== undefined ? h.shares : h.quantity);
      if ((!code && !name) || shares === null || shares <= 0) return;
      const dedupKey = code || name;
      if (seenHold[dedupKey]) return;
      seenHold[dedupKey] = true;
      holdings.push({ code: code, name: name, shares: shares });
    });
  }

  if (scene === 'market') {
    if (total === null && market !== null && cash !== null) {
      total = Math.round((market + cash) * 100) / 100;
    }
    if (netIn === null && total !== null && pnl !== null) {
      netIn = Math.round((total - pnl) * 100) / 100;
    }
  }

  const ok = scene === 'balance'
    ? (total !== null || items.length > 0)
    : (total !== null || holdings.length > 0);

  return {
    ok: ok,
    platform: platform,
    total: total,
    pnl: pnl,
    market: market,
    cash: cash,
    netIn: netIn,
    items: items,
    holdings: holdings
  };
}

module.exports = {
  parseAccount,
  normalizeAiResult,
  extractJsonObject,
  LABELS: MARKET_LABELS,
  BALANCE_ITEMS
};
