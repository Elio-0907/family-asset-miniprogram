// 每天存一条资产快照。
//
// 这个函数第一天就要跑起来 —— 历史数据是补不回来的。
// 现在攒下的每日快照，将来才能画出资产曲线，以及把「当初的预测」
// 和「后来的实际」画在同一张图上。

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

// 与小程序端 utils/calc.js 保持同源，改动请跑 scripts/sync-utils.sh
const calc = require('./lib/calc.js');
const R = require('./lib/recurring.js');

function pad(n) { return n < 10 ? '0' + n : String(n); }
function todayStr(d) {
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}

async function fetchAll(collection, where) {
  const out = [];
  const PAGE = 100;
  for (let skip = 0; skip < 2000; skip += PAGE) {
    const r = await db.collection(collection).where(where).skip(skip).limit(PAGE).get();
    out.push(...r.data);
    if (r.data.length < PAGE) break;
  }
  return out;
}

exports.main = async () => {
  const now = new Date();
  // 云函数时区是 UTC，换算成东八区再取日期，否则每天会差 8 小时
  const cn = new Date(now.getTime() + 8 * 3600 * 1000);
  const day = new Date(cn.getUTCFullYear(), cn.getUTCMonth(), cn.getUTCDate());
  const date = calc.fmtDate(day);

  // 金价
  const prices = {};
  try {
    const md = await db.collection('market_data').limit(20).get();
    md.data.forEach((d) => { prices[d._id] = d.price; });
  } catch (e) { /* 没有金价就按 lastUnitPrice 兜底 */ }

  // 先按每个家庭的存单计划开单，快照里才会有今天新开的那张
  let plansApplied = 0;
  const fams = await fetchAll('family', {});
  for (const fam of fams) {
    const plans = fam.plans || [];
    let changed = false;
    for (const pl of plans) {
      const key = R.duePlan(pl, day);
      if (!key) continue;
      try {
        await db.collection('asset').add({ data: R.buildCd(pl, day, fam._id, pl.createdBy || fam.ownerOpenid) });
        pl.lastApplied = key; changed = true; plansApplied++;
      } catch (e) { /* ignore */ }
    }
    if (changed) await db.collection('family').doc(fam._id).update({ data: { plans } });
  }

  let assets = await fetchAll('asset', { status: 'active' });

  // 到期的存单：开了自动转存的续上，计划里设了自动结清的关掉
  const planMap = {};
  fams.forEach((f) => (f.plans || []).forEach((pl) => { planMap[pl.id] = pl; }));
  let renewed = 0, autoClosed = 0;
  for (const a of assets) {
    if (a.mode !== 'accrual' || !a.maturityDate || a.maturityDate > date) continue;
    const pl = a.planId ? planMap[a.planId] : null;
    const action = a.autoRenew ? 'renew' : (pl && pl.onMature) || 'manual';
    if (action === 'manual') continue;
    try {
      if (action === 'renew') {
        const v = calc.valuate(a, { now: calc.parseDate(a.maturityDate), prices: {} });
        const doc = R.buildRollover(a, v.atMaturity, { familyId: a.familyId, openid: a._openid || a.createdBy });
        const added = await db.collection('asset').add({ data: doc });
        await db.collection('asset').doc(a._id).update({
          data: { status: 'closed', closedAt: new Date(), closeReason: 'auto-rollover', rolledTo: added._id }
        });
        renewed++;
      } else if (action === 'close') {
        await db.collection('asset').doc(a._id).update({
          data: { status: 'closed', closedAt: new Date(), closeReason: 'auto-close-on-maturity' }
        });
        autoClosed++;
      }
    } catch (e) { /* ignore */ }
  }
  if (renewed || autoClosed) assets = await fetchAll('asset', { status: 'active' });

  // 先把今天到日子的每月自动存入加上，快照里才是加过之后的数
  let recurringApplied = 0;
  for (const a of assets) {
    const patch = R.applyPatch(a, day);
    if (!patch) continue;
    try {
      await db.collection('asset').doc(a._id).update({ data: patch });
      Object.assign(a, patch);
      recurringApplied++;
    } catch (e) { /* ignore */ }
  }

  // 按家庭分组，一个云函数覆盖所有用户
  const families = {};
  assets.forEach((a) => {
    const fid = a.familyId || a._openid || 'unknown';
    if (!families[fid]) families[fid] = [];
    families[fid].push(a);
  });

  const ctx = { now: day, prices };
  const written = [];

  for (const fid of Object.keys(families)) {
    const sum = calc.summarize(families[fid], ctx);

    // 按计价方式拆一下，将来能看「存单占比是怎么变的」
    const byMode = {};
    sum.byLayer.liquid.forEach((it) => {
      byMode[it.asset.mode] = (byMode[it.asset.mode] || 0) + it.val.value;
    });

    const doc = {
      familyId: fid,
      date,
      liquid: sum.liquid,
      receivable: sum.receivable,
      fixed: sum.fixed,
      liability: sum.liability || 0,
      net: sum.net,
      accruedInterest: sum.accruedInterest,
      weightedRate: Number(sum.weightedRate.toFixed(4)),
      byMode,
      assetCount: families[fid].length,
      createdAt: new Date()
    };

    // 一天一条，重复跑就覆盖；如果今天已经做过月度盘点，保留盘点标记与备注
    const id = fid + '_' + date;
    try {
      const existing = await db.collection('snapshot').doc(id).get();
      if (existing.data && existing.data.checkin) {
        doc.checkin = true;
        doc.checkinMonth = existing.data.checkinMonth || date.slice(0, 7);
        doc.checkinNote = existing.data.checkinNote || '';
        doc.checkinBy = existing.data.checkinBy || '';
        doc.checkinByName = existing.data.checkinByName || '';
      }
    } catch (e) { /* 当天还没有快照 */ }
    try {
      await db.collection('snapshot').doc(id).set({ data: doc });
    } catch (e) {
      await db.collection('snapshot').add({ data: Object.assign({ _id: id }, doc) });
    }
    written.push({ familyId: fid, date, net: doc.net });
  }

  return { date, families: written.length, recurringApplied, plansApplied, renewed, autoClosed, written };
};
