// 数据网关：小程序端所有资产 / 家庭 / 配置的读写都走这里。
//
// 为什么不让前端直接读数据库：数据库权限只能按「创建者」隔离，家人读你的记录会被拒。
// 这里用 openid 查出调用者所在的家庭，再按 familyId 放行——家庭内共享，家庭外一律看不见。
// 云函数本身有管理员权限，数据库集合的权限可以保持「仅创建者可读写」甚至更严。

const cloud = require('wx-server-sdk');
const R = require('./lib/recurring.js');
const calc = require('./lib/calc.js');
const CK = require('./lib/checkin.js');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

/** 云函数跑在 UTC，换成东八区的"今天" */
function todayCN() {
  const t = new Date(Date.now() + 8 * 3600 * 1000);
  return new Date(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate());
}

/** 到日子的存单计划：新建存单，标记本月已开 */
async function applyPlans(fam, fid, openid) {
  const plans = fam.plans || [];
  if (!plans.length) return 0;
  const today = todayCN();
  let n = 0, changed = false;
  for (const pl of plans) {
    const key = R.duePlan(pl, today);
    if (!key) continue;
    try {
      await db.collection('asset').add({ data: R.buildCd(pl, today, fid, pl.createdBy || openid) });
      pl.lastApplied = key; changed = true; n++;
    } catch (e) { /* 下次再试 */ }
  }
  if (changed) await db.collection('family').doc(fid).update({ data: { plans } });
  return n;
}

/** 到日子的每月自动存入，执行并写回；返回改过的记录 */
async function applyRecurring(list) {
  const today = todayCN();
  for (const a of list) {
    const patch = R.applyPatch(a, today);
    if (!patch) continue;
    try {
      await db.collection('asset').doc(a._id).update({ data: patch });
      Object.assign(a, patch);
    } catch (e) { /* 下次再试 */ }
  }
  return list;
}

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // 去掉 0/O/1/I，念出来不会错
const CODE_TTL = 24 * 3600 * 1000;

function genCode() {
  let s = '';
  for (let i = 0; i < 6; i++) s += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  return s;
}

async function fetchAll(coll, where, order) {
  const out = [];
  for (let skip = 0; skip < 2000; skip += 100) {
    let q = db.collection(coll).where(where);
    if (order) q = q.orderBy(order[0], order[1]);
    const r = await q.skip(skip).limit(100).get();
    out.push(...r.data);
    if (r.data.length < 100) break;
  }
  return out;
}

/** 调用者所在的家庭；没有就以自己为创建者建一个（_id = openid，和历史数据的 familyId 一致） */
async function getFamily(openid) {
  const r = await db.collection('family').where({ memberIds: openid }).limit(1).get();
  if (r.data.length) return r.data[0];
  const doc = {
    ownerOpenid: openid,
    memberIds: [openid],
    members: [{ openid, name: '我', joinedAt: new Date() }],
    createdAt: new Date()
  };
  try {
    await db.collection('family').doc(openid).set({ data: doc });
  } catch (e) { /* 并发时可能已建，忽略 */ }
  return Object.assign({ _id: openid }, doc);
}

/**
 * 早期录入的记录可能没有 familyId（身份还没拿到就保存了）。
 * 自己创建的、familyId 为空/local/缺失的，归到自己现在的家庭。只修自己的，不碰别人的。
 */
async function repairOrphans(openid, fid) {
  const bad = [];
  try {
    const a = await db.collection('asset').where({ _openid: openid, familyId: _.in(['', 'local', null]) }).limit(100).get();
    bad.push(...a.data);
    const b = await db.collection('asset').where({ _openid: openid, familyId: _.exists(false) }).limit(100).get();
    bad.push(...b.data);
  } catch (e) { return 0; }
  for (const doc of bad) {
    try { await db.collection('asset').doc(doc._id).update({ data: { familyId: fid, repairedAt: new Date() } }); }
    catch (e) { /* ignore */ }
  }
  return bad.length;
}

function memberView(fam, me) {
  return (fam.members || []).map((m) => ({
    name: m.name || '家人', isMe: m.openid === me, isOwner: m.openid === fam.ownerOpenid,
    openid: m.openid === me ? m.openid : undefined      // 别人的 openid 不下发
  }));
}

function meView(fam, openid) {
  const live = fam.inviteCode && fam.inviteExpires && new Date(fam.inviteExpires).getTime() > Date.now();
  return {
    openid, familyId: fam._id, isOwner: fam.ownerOpenid === openid,
    members: memberView(fam, openid), memberCount: (fam.memberIds || []).length,
    inviteCode: live ? fam.inviteCode : null,
    inviteExpires: live ? fam.inviteExpires : null,
    headerImage: fam.headerImage || '',
    plans: (fam.plans || []).filter((p) => p.active !== false),
    lastCheckin: fam.lastCheckin || null
  };
}

exports.main = async (event) => {
  event = event || {};
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return { error: '拿不到身份' };
  const action = event.action;
  const fam = await getFamily(OPENID);
  const fid = fam._id;

  try {
    switch (action) {
      /* ---------- 身份与家庭 ---------- */
      case 'me':
        return meView(fam, OPENID);

      case 'rename': {
        const name = String(event.name || '').trim().slice(0, 12);
        if (!name) return { error: '称呼不能为空' };
        const members = (fam.members || []).map((m) => m.openid === OPENID ? Object.assign({}, m, { name }) : m);
        await db.collection('family').doc(fid).update({ data: { members } });
        return meView(Object.assign({}, fam, { members }), OPENID);
      }

      case 'savePlan': {
        const input = event.plan || {};
        const plans = (fam.plans || []).slice();
        const id = input.id || ('pl_' + Date.now().toString(36));
        const idx = plans.findIndex((p) => p.id === id);
        const prev = idx >= 0 ? plans[idx] : null;
        const plan = {
          id, active: true,
          institution: String(input.institution || '').slice(0, 20),
          amount: Math.max(0, Math.round(Number(input.amount) || 0)),
          day: Math.max(1, Math.min(28, Number(input.day) || 1)),
          termMonths: Number(input.termMonths) || 12,
          rate: Number(input.rate) || 0,
          onMature: ['manual', 'renew', 'close'].indexOf(input.onMature) >= 0 ? input.onMature : 'manual',
          createdBy: prev ? prev.createdBy : OPENID,
          createdAt: prev ? prev.createdAt : new Date(),
          // 新建时若本月那张已经手动存过，标记本月已执行，避免重复开单
          lastApplied: prev ? prev.lastApplied : (input.doneThisMonth ? R.monthKey(todayCN()) : null)
        };
        if (!plan.amount) return { error: '每月金额要填' };

        // 新建 + 给了开始月份：把过去每个月的那张都补出来，梯子才完整
        let backfilled = 0;
        if (!prev && input.startMonth) {
          const today = todayCN();
          const months = R.backfillMonths(plan, String(input.startMonth), today, !!input.doneThisMonth);
          for (const m of months) {
            const doc = R.buildCd(plan, todayCN(), fid, OPENID);
            doc.startDate = m.start; doc.maturityDate = m.maturity; doc.backfilled = true;
            try { await db.collection('asset').add({ data: doc }); backfilled++; } catch (e) { /* ignore */ }
          }
          if (months.length) {
            // 补录到了本月就标记本月已开，否则按 doneThisMonth
            const lastKey = months[months.length - 1].start.slice(0, 7);
            if (lastKey === R.monthKey(today)) plan.lastApplied = lastKey;
          }
        }

        if (idx >= 0) plans[idx] = plan; else plans.push(plan);
        await db.collection('family').doc(fid).update({ data: { plans } });
        const view = meView(Object.assign({}, fam, { plans }), OPENID);
        view.backfilled = backfilled;
        return view;
      }

      case 'planAdjust': {
        // 改「已存期数」：+1 往更早的月份补一张，-1 去掉最早的那张（补录补多了的情况）
        const pl = (fam.plans || []).filter((x) => x.id === event.id)[0];
        if (!pl) return { error: '找不到这个计划' };
        const cds = await fetchAll('asset', { familyId: fid, planId: pl.id, status: 'active' });
        cds.sort((a, b) => a.startDate < b.startDate ? -1 : 1);
        const delta = Number(event.delta) || 0;
        if (delta > 0) {
          // 往前补：最早那张的上一个月；一张都没有就从本月往前
          const today = todayCN();
          let anchor = cds.length ? calc.parseDate(cds[0].startDate) : new Date(today.getFullYear(), today.getMonth(), pl.day || 1);
          if (!cds.length && today.getDate() < (pl.day || 1)) anchor = R.addMonths(anchor, -1);
          for (let i = 0; i < delta; i++) {
            anchor = R.addMonths(anchor, -1);
            const doc = R.buildCd(pl, today, fid, pl.createdBy || OPENID);
            doc.startDate = R.fmtDate(anchor);
            doc.maturityDate = R.fmtDate(R.addMonths(anchor, pl.termMonths || 12));
            doc.backfilled = true;
            await db.collection('asset').add({ data: doc });
          }
        } else if (delta < 0) {
          const n = Math.min(-delta, cds.length);
          for (let i = 0; i < n; i++) {
            await db.collection('asset').doc(cds[i]._id).update({
              data: { status: 'closed', closedAt: new Date(), closeReason: 'plan-adjust', updatedAt: new Date() }
            });
          }
        }
        const after = await db.collection('asset').where({ familyId: fid, planId: pl.id, status: 'active' }).count();
        return { count: after.total };
      }

      case 'deletePlan': {
        const plans = (fam.plans || []).filter((p) => p.id !== event.id);
        await db.collection('family').doc(fid).update({ data: { plans } });
        return meView(Object.assign({}, fam, { plans }), OPENID);
      }

      case 'setHeaderImage': {
        // 换首页背景：存新图的 fileID，顺手删旧图；传空就恢复默认
        const fileID = String(event.fileID || '');
        const old = fam.headerImage || '';
        await db.collection('family').doc(fid).update({ data: { headerImage: fileID } });
        if (old && old !== fileID) {
          try { await cloud.deleteFile({ fileList: [old] }); } catch (e) { /* ignore */ }
        }
        return meView(Object.assign({}, fam, { headerImage: fileID }), OPENID);
      }

      case 'invite': {
        const code = genCode();
        const inviteExpires = new Date(Date.now() + CODE_TTL);
        await db.collection('family').doc(fid).update({ data: { inviteCode: code, inviteExpires } });
        return meView(Object.assign({}, fam, { inviteCode: code, inviteExpires }), OPENID);
      }

      case 'join': {
        const code = String(event.code || '').trim().toUpperCase();
        const name = String(event.name || '家人').trim().slice(0, 12) || '家人';
        if (code.length !== 6) return { error: '邀请码是 6 位' };

        const r = await db.collection('family').where({ inviteCode: code }).limit(1).get();
        const target = r.data[0];
        if (!target || !target.inviteExpires || new Date(target.inviteExpires).getTime() < Date.now()) {
          return { error: '邀请码不对或已过期，让家人重新生成一个' };
        }
        if (target._id === fid) return { error: '你已经在这个家庭里了' };

        // 自己名下已经录了资产的话，加入别人家会看不到它们——先拦住
        const mine = await db.collection('asset').where({ familyId: fid, status: 'active' }).count();
        if (mine.total > 0 && fam.ownerOpenid === OPENID) {
          return { error: '你自己已经录了 ' + mine.total + ' 笔资产，加入别人的家庭后会看不到它们。' +
                          '如果确定要加入，先把这些标记为已结清。' };
        }

        // 从旧家庭移除（自己是唯一成员的空家庭直接删）
        if (fam.ownerOpenid === OPENID && (fam.memberIds || []).length === 1) {
          try { await db.collection('family').doc(fid).remove(); } catch (e) { /* ignore */ }
        } else {
          await db.collection('family').doc(fid).update({
            data: { memberIds: _.pull(OPENID),
                    members: (fam.members || []).filter((m) => m.openid !== OPENID) }
          });
        }
        await db.collection('family').doc(target._id).update({
          data: { memberIds: _.addToSet(OPENID),
                  members: _.push([{ openid: OPENID, name, joinedAt: new Date() }]) }
        });
        const joined = (await db.collection('family').doc(target._id).get()).data;
        return meView(joined, OPENID);
      }

      case 'remove': {
        if (fam.ownerOpenid !== OPENID) return { error: '只有创建者能移除成员' };
        const idx = Number(event.index);
        const target = (fam.members || [])[idx];
        if (!target || target.openid === OPENID) return { error: '不能移除自己' };
        await db.collection('family').doc(fid).update({
          data: { memberIds: _.pull(target.openid),
                  members: (fam.members || []).filter((m) => m.openid !== target.openid) }
        });
        return meView((await db.collection('family').doc(fid).get()).data, OPENID);
      }

      case 'leave': {
        if (fam.ownerOpenid === OPENID) return { error: '创建者不能退出，可以移除其他成员' };
        await db.collection('family').doc(fid).update({
          data: { memberIds: _.pull(OPENID),
                  members: (fam.members || []).filter((m) => m.openid !== OPENID) }
        });
        return meView(await getFamily(OPENID), OPENID);
      }

      /* ---------- 资产 ---------- */
      case 'listAssets': {
        await repairOrphans(OPENID, fid);
        await applyPlans(fam, fid, OPENID);
        const list = await fetchAll('asset', { familyId: fid, status: 'active' });
        await applyRecurring(list);
        list.sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));
        return { list };
      }

      case 'getAsset': {
        const r = await db.collection('asset').doc(event.id).get();
        if (!r.data || r.data.familyId !== fid) return { error: '这笔资产不在你的家庭里' };
        return { asset: r.data };
      }

      case 'addAsset': {
        const now = new Date();
        const doc = Object.assign({}, event.doc || {}, {
          familyId: fid, _openid: OPENID, createdBy: OPENID,
          status: 'active', sortOrder: 0, createdAt: now, updatedAt: now
        });
        const r = await db.collection('asset').add({ data: doc });
        return { _id: r._id };
      }

      case 'rollover': {
        // 到期转存：新存单起息 = 旧存单到期日，旧的标记为已转存
        const r = await db.collection('asset').doc(event.id).get();
        const old = r.data;
        if (!old || old.familyId !== fid) return { error: '这笔资产不在你的家庭里' };
        if (old.mode !== 'accrual') return { error: '只有存单能转存' };
        const v = calc.valuate(old, { now: calc.parseDate(old.maturityDate) || todayCN(), prices: {} });
        const doc = R.buildRollover(old, v.atMaturity, {
          termMonths: Number(event.termMonths) || undefined,
          rate: event.rate === undefined ? undefined : Number(event.rate),
          includeInterest: event.includeInterest !== false,
          familyId: fid, openid: OPENID
        });
        const added = await db.collection('asset').add({ data: doc });
        await db.collection('asset').doc(old._id).update({
          data: { status: 'closed', closedAt: new Date(), closeReason: 'rollover', rolledTo: added._id, updatedAt: new Date() }
        });
        return { _id: added._id, principal: doc.principal, maturityDate: doc.maturityDate };
      }

      case 'updateAsset':
      case 'closeAsset': {
        const r = await db.collection('asset').doc(event.id).get();
        if (!r.data || r.data.familyId !== fid) return { error: '这笔资产不在你的家庭里' };
        const patch = action === 'closeAsset'
          ? { status: 'closed', closedAt: new Date(), updatedAt: new Date(), updatedBy: OPENID }
          : Object.assign({}, event.doc || {}, { updatedAt: new Date(), updatedBy: OPENID });
        delete patch._id; delete patch._openid; delete patch.familyId; delete patch.createdAt;
        await db.collection('asset').doc(event.id).update({ data: patch });
        return { ok: true };
      }

      /* ---------- 配置 / 快照 / 行情 ---------- */
      case 'getConfig': {
        try {
          const r = await db.collection('forecast_config').doc(fid).get();
          return { config: r.data || null };
        } catch (e) { return { config: null }; }
      }

      case 'saveConfig': {
        let prev = {};
        try {
          const r = await db.collection('forecast_config').doc(fid).get();
          if (r.data) prev = r.data;
        } catch (e) { /* 首次保存 */ }
        const data = Object.assign({}, prev, event.config || {}, { familyId: fid, updatedAt: new Date() });
        delete data._id;
        await db.collection('forecast_config').doc(fid).set({ data });
        return { ok: true };
      }

      case 'saveAllocation': {
        let prev = {};
        try {
          const r = await db.collection('forecast_config').doc(fid).get();
          if (r.data) prev = r.data;
        } catch (e) { /* 首次保存 */ }
        const data = Object.assign({}, prev, {
          familyId: fid,
          allocation: event.allocation || null,
          updatedAt: new Date()
        });
        delete data._id;
        await db.collection('forecast_config').doc(fid).set({ data });
        return { ok: true, allocation: data.allocation };
      }

      case 'listSnapshots': {
        const list = await fetchAll('snapshot', { familyId: fid }, ['date', 'asc']);
        return { list: list.slice(-(event.limit || 365)) };
      }

      case 'finishCheckin': {
        // 每月 10 分钟盘点结账：立刻以最新资产写一条带 checkin 标记的快照，并更新家庭 lastCheckin
        const today = todayCN();
        const date = calc.fmtDate(today);
        const month = CK.monthKey(today);
        const note = String(event.note || '').trim().slice(0, 80);

        const prices = {};
        try {
          const md = await db.collection('market_data').limit(20).get();
          md.data.forEach((d) => { prices[d._id] = d.price; });
        } catch (e) { /* ignore */ }

        const assets = await fetchAll('asset', { familyId: fid, status: 'active' });
        const sum = calc.summarize(assets, { now: today, prices });
        const byMode = {};
        sum.byLayer.liquid.forEach((it) => {
          byMode[it.asset.mode] = (byMode[it.asset.mode] || 0) + it.val.value;
        });

        const meMember = (fam.members || []).filter((m) => m.openid === OPENID)[0];
        const byName = (meMember && meMember.name) || '我';

        const snapDoc = {
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
          assetCount: assets.length,
          checkin: true,
          checkinMonth: month,
          checkinNote: note,
          checkinBy: OPENID,
          checkinByName: byName,
          createdAt: new Date()
        };

        const snapId = fid + '_' + date;
        try {
          await db.collection('snapshot').doc(snapId).set({ data: snapDoc });
        } catch (e) {
          await db.collection('snapshot').add({ data: Object.assign({ _id: snapId }, snapDoc) });
        }

        const snapshots = await fetchAll('snapshot', { familyId: fid }, ['date', 'asc']);
        const prev = CK.pickPrevSnapshot(snapshots, month);
        const report = CK.buildReport(snapDoc, prev, snapshots);

        const lastCheckin = {
          month,
          date,
          liquid: sum.liquid,
          net: sum.net,
          prevMonth: report.prevMonth,
          deltaLiquid: report.deltaLiquid,
          deltaNet: report.deltaNet,
          note,
          byName,
          updatedAt: new Date()
        };
        await db.collection('family').doc(fid).update({ data: { lastCheckin } });

        return {
          report,
          snapshots: snapshots.slice(-365),
          me: meView(Object.assign({}, fam, { lastCheckin }), OPENID)
        };
      }

      case 'getPrices': {
        const r = await db.collection('market_data').limit(20).get();
        const map = {};
        r.data.forEach((d) => { map[d._id] = d.price; map[d._id + '_updatedAt'] = d.updatedAt; });
        return { prices: map };
      }

      default:
        return { error: '未知操作: ' + action };
    }
  } catch (e) {
    return { error: String(e.message || e) };
  }
};
