// 股票 / ETF / 港股行情。两种用法：
//   1. 定时触发（每个交易日 15:40）：扫所有录了持仓的市值型资产，按收盘价更新市值
//   2. 前端调用 { codes: ['sh600036'] }：录入时查名字和现价，不写库
//   3. 前端调用 { assetId }：保存后立刻刷新这一笔，不用等到 15:40
//
// 不接券商账户、不存任何密码。只拿公开行情，你告诉它持有多少，它算值多少。

const cloud = require('wx-server-sdk');
const https = require('https');
const iconv = require('iconv-lite');
const S = require('./lib/stock.js');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

function fetchSina(codes) {
  return new Promise((resolve, reject) => {
    const req = https.get({
      hostname: 'hq.sinajs.cn',
      path: '/list=' + codes.join(','),
      headers: { 'Referer': 'https://finance.sina.com.cn', 'User-Agent': 'Mozilla/5.0' },
      timeout: 8000
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(iconv.decode(Buffer.concat(chunks), 'gbk')));   // 名字是中文，得正经解码
    });
    req.on('timeout', () => req.destroy(new Error('请求超时')));
    req.on('error', reject);
  });
}

/** 查一批代码，返回人民币计价的行情（分） */
async function getQuotes(codes) {
  const uniq = Array.from(new Set(codes.filter(Boolean)));
  if (!uniq.length) return { quotes: {}, fx: {} };
  const needFx = uniq.some((c) => S.marketOf(c) === 'HK');
  const list = needFx ? uniq.concat(['HKDCNY']) : uniq;
  const parsed = S.parseSina(await fetchSina(list));
  const fx = parsed.fx.HKDCNY || 0;
  const out = {};
  Object.keys(parsed.quotes).forEach((code) => {
    const q = parsed.quotes[code];
    const rate = q.currency === 'HKD' ? fx : 1;
    if (!rate) return;
    out[code] = {
      name: q.name,
      currency: q.currency,
      priceLocal: q.price,                              // 原币，元
      price: Math.round(q.price * rate * 100),          // 人民币，分
      prevClose: Math.round(q.prevClose * rate * 100),
      date: q.date
    };
  });
  return { quotes: out, fx: parsed.fx };
}

/** 用行情刷新一笔资产的持仓价格和市值，写回数据库 */
async function refreshAsset(a, quotes) {
  const holdings = (a.holdings || []).map((h) => {
    const q = quotes[h.code];
    return q ? Object.assign({}, h, { name: q.name, price: q.price, priceLocal: q.priceLocal,
                                       currency: q.currency, quoteDate: q.date })
             : h;                                        // 没查到就保留上次的价
  });
  const marketValue = S.holdingsValue(holdings, a.cash || 0);
  const dates = holdings.map((h) => h.quoteDate).filter(Boolean).sort();
  const valueUpdatedAt = dates.length ? dates[dates.length - 1] : a.valueUpdatedAt;

  await db.collection('asset').doc(a._id).update({
    data: { holdings, marketValue, valueUpdatedAt, priceRefreshedAt: new Date() }
  });
  return { id: a._id, name: a.name, marketValue, holdings: holdings.length };
}

async function fetchAllMarketAssets() {
  const out = [];
  for (let skip = 0; skip < 2000; skip += 100) {
    const r = await db.collection('asset')
      .where({ status: 'active', mode: 'market' }).skip(skip).limit(100).get();
    out.push(...r.data);
    if (r.data.length < 100) break;
  }
  return out.filter((a) => Array.isArray(a.holdings) && a.holdings.length);
}

exports.main = async (event) => {
  event = event || {};

  // 用法 2：只查行情
  if (Array.isArray(event.codes)) {
    const codes = event.codes.map(S.normalizeCode).filter(Boolean);
    return await getQuotes(codes);
  }

  // 用法 3：刷新指定的一笔
  let assets;
  if (event.assetId) {
    const r = await db.collection('asset').doc(event.assetId).get();
    assets = r.data && Array.isArray(r.data.holdings) ? [r.data] : [];
  } else {
    assets = await fetchAllMarketAssets();          // 用法 1：定时刷新全部
  }
  if (!assets.length) return { refreshed: 0, note: '没有录了持仓的市值型资产' };

  const codes = [];
  assets.forEach((a) => a.holdings.forEach((h) => codes.push(h.code)));
  const { quotes, fx } = await getQuotes(codes);

  const results = [];
  for (const a of assets) {
    try { results.push(await refreshAsset(a, quotes)); }
    catch (e) { results.push({ id: a._id, error: String(e.message || e) }); }
  }
  return { refreshed: results.length, fx, results };
};
