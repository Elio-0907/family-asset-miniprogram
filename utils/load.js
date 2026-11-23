// 页面共用的数据装载：一次拿齐资产 + 金价，算好汇总。
const db = require('./db.js');
const calc = require('./calc.js');

const TONE = { accrual: 1, quantity: 2, market: 3, balance: 4, appraisal: 4, loan: 5 };

function tone(asset) { return TONE[asset.mode] || 4; }

function loadAll(force) {
  const app = getApp();
  const g = app.globalData;
  const fresh = g.assetsCache && (Date.now() - g.cacheAt < 30000);
  if (fresh && !force) {
    return Promise.resolve(build(g.assetsCache, g.prices));
  }
  return app.whenReady()
    .then(function () { return Promise.all([db.listAssets(), db.getPrices()]); })
    .then(function (r) {
      g.assetsCache = r[0];
      g.prices = r[1];
      g.cacheAt = Date.now();
      return build(r[0], r[1]);
    });
}

function build(assets, prices) {
  const ctx = { now: calc.startOfToday(), prices: prices || {} };
  const sum = calc.summarize(assets, ctx);
  try {
    const app = getApp();
    if (app && app.globalData) app.globalData.weightedRate = sum.weightedRate || 0;
  } catch (e) { /* non-miniprogram env */ }
  return {
    assets: assets,
    prices: prices || {},
    ctx: ctx,
    sum: sum
  };
}

/**
 * 同一个「每月存单」计划开出来的存单，在首页/资产页合成一行。
 * 返回 [{ group: true, planId, items:[...], value, count, earliest }] 和不需要合并的单条。
 */
function groupByPlan(items) {
  const groups = {}, out = [];
  items.forEach(function (it) {
    const pid = it.asset.planId;
    if (!pid) { out.push(it); return; }
    if (!groups[pid]) {
      groups[pid] = { group: true, planId: pid, asset: it.asset, items: [], value: 0, count: 0,
                      earliest: null, earliestDays: null };
      out.push(groups[pid]);
    }
    const g = groups[pid];
    g.items.push(it); g.value += it.val.value; g.count++;
    if (it.val.daysToDue !== null && (g.earliestDays === null || it.val.daysToDue < g.earliestDays)) {
      g.earliestDays = it.val.daysToDue; g.earliest = it.asset.maturityDate;
    }
  });
  return out;
}

module.exports = { loadAll: loadAll, build: build, tone: tone, groupByPlan: groupByPlan };
