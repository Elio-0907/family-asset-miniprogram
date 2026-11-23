// 每月自动存入。资产上存 recurring: { amount(分), day(1-28) }，
// recurringLast 记录上次执行的月份 'YYYY-MM'，保证一个月只加一次。
// 小程序打开时（api）和每晚定时任务（dailySnapshot）都会检查，谁先到谁执行，另一个看到已执行就跳过。

function monthKey(d) {
  const m = d.getMonth() + 1;
  return d.getFullYear() + '-' + (m < 10 ? '0' + m : m);
}

/** 这笔资产今天该不该执行；该的话返回本月 key，否则 null */
function dueMonth(asset, today) {
  const r = asset && asset.recurring;
  if (!r || !(r.amount > 0)) return null;
  if (asset.mode !== 'balance') return null;          // 目前只支持余额型
  const day = Math.max(1, Math.min(28, r.day || 1));
  if (today.getDate() < day) return null;
  const key = monthKey(today);
  if (asset.recurringLast === key) return null;
  return key;
}

/** 生成要写回数据库的补丁 */
function applyPatch(asset, today) {
  const key = dueMonth(asset, today);
  if (!key) return null;
  const amount = asset.recurring.amount;
  const log = (asset.recurringLog || []).slice(-23);
  log.push({ month: key, date: monthKey(today) + '-' + (today.getDate() < 10 ? '0' : '') + today.getDate(), amount: amount });
  return {
    balance: (asset.balance || 0) + amount,
    recurringLast: key,
    recurringLog: log,
    valueUpdatedAt: log[log.length - 1].date,
    updatedAt: new Date()
  };
}

/* ================= 每月自动开一张新存单（存单梯子） =================
   计划存在 family.plans[]：{ id, institution, amount(分), day, termMonths, rate, lastApplied, active }
   到日子就新建一笔 accrual 资产，起息日取当月的计划日，到期日 = 起息 + 期限。 */

const TERM_LABEL = { 3: '3个月', 6: '6个月', 12: '1年', 24: '2年', 36: '3年', 60: '5年' };

function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
function pad(n) { return n < 10 ? '0' + n : String(n); }
function fmtDate(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }

/** 加 n 个月，31 号遇到小月自动落到月末 */
function addMonths(d, n) {
  const first = new Date(d.getFullYear(), d.getMonth() + n, 1);
  const last = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
  return new Date(first.getFullYear(), first.getMonth(), Math.min(d.getDate(), last));
}

function duePlan(plan, today) {
  if (!plan || plan.active === false || !(plan.amount > 0)) return null;
  if (today.getDate() < clamp(plan.day || 1, 1, 28)) return null;
  const key = monthKey(today);
  return plan.lastApplied === key ? null : key;
}

/** 按计划生成这个月的存单文档 */
function buildCd(plan, today, familyId, openid) {
  const start = new Date(today.getFullYear(), today.getMonth(), clamp(plan.day || 1, 1, 28));
  const term = plan.termMonths || 12;
  return {
    familyId: familyId, _openid: openid, createdBy: openid,
    name: (TERM_LABEL[term] || term + '个月') + '定存',
    institution: plan.institution || '',
    layer: 'liquid', mode: 'accrual', status: 'active',
    principal: plan.amount, rate: plan.rate || 0,
    startDate: fmtDate(start), maturityDate: fmtDate(addMonths(start, term)),
    interestRule: 'atMaturity', planId: plan.id, autoCreated: true,
    sortOrder: 0, createdAt: new Date(), updatedAt: new Date()
  };
}

/** 下一次会在哪天开、哪天到期（给界面预览用） */
function nextRun(plan, today) {
  const day = clamp(plan.day || 1, 1, 28);
  let start = new Date(today.getFullYear(), today.getMonth(), day);
  // 本月已经开过（不管日子到没到），下一张就是下个月
  if (plan.lastApplied === monthKey(today)) start = addMonths(start, 1);
  return { start: fmtDate(start), maturity: fmtDate(addMonths(start, plan.termMonths || 12)) };
}

/**
 * 往期补录：从 startMonth('YYYY-MM') 起，到「上一个该开的月份」为止，每月一张。
 * 返回 [{start, maturity}]，最多 120 张。本月那张由 doneThisMonth 决定是否包含。
 */
function backfillMonths(plan, startMonth, today, includeThisMonth) {
  if (!startMonth || !/^\d{4}-\d{2}$/.test(startMonth)) return [];
  const day = clamp(plan.day || 1, 1, 28);
  let cur = new Date(Number(startMonth.slice(0, 4)), Number(startMonth.slice(5, 7)) - 1, day);
  const thisKey = monthKey(today);
  const out = [];
  while (out.length < 120) {
    const key = monthKey(cur);
    if (key > thisKey) break;
    if (key === thisKey && !includeThisMonth) break;
    if (key === thisKey && today.getDate() < day) break;     // 本月还没到日子，不算往期
    out.push({ start: fmtDate(cur), maturity: fmtDate(addMonths(cur, plan.termMonths || 12)) });
    cur = addMonths(cur, 1);
  }
  return out;
}

/* ================= 到期转存 ================= */

/** 一张存单的期限（月） */
function termMonthsOf(asset) {
  const p = function (str) { const f = String(str || '').split('-'); return f.length === 3 ? new Date(+f[0], +f[1] - 1, +f[2]) : null; };
  const s0 = p(asset.startDate), s1 = p(asset.maturityDate);
  if (!s0 || !s1) return 12;
  const m = Math.round((s1 - s0) / 86400000 / 30.4);
  return Math.max(1, m);
}

/**
 * 由旧存单生成转存后的新存单文档。
 * @param old        旧存单
 * @param atMaturity 旧存单到期本息（分），由调用方用 calc 算好传进来
 * @param o          { termMonths, rate, includeInterest, familyId, openid }
 */
function buildRollover(old, atMaturity, o) {
  const p = String(old.maturityDate || '').split('-');
  const start = p.length === 3 ? new Date(+p[0], +p[1] - 1, +p[2]) : new Date();
  const term = o.termMonths || termMonthsOf(old);
  const principal = o.includeInterest === false ? (old.principal || 0) : (atMaturity || old.principal || 0);
  return {
    familyId: o.familyId, _openid: o.openid, createdBy: o.openid,
    name: old.name, institution: old.institution || '',
    layer: old.layer || 'liquid', mode: 'accrual', status: 'active',
    principal: principal, rate: (o.rate === undefined || o.rate === null) ? (old.rate || 0) : o.rate,
    startDate: fmtDate(start), maturityDate: fmtDate(addMonths(start, term)),
    interestRule: old.interestRule || 'atMaturity',
    autoRenew: !!old.autoRenew, planId: old.planId || '',
    rolledFrom: old._id, rollCount: (old.rollCount || 0) + 1,
    sortOrder: old.sortOrder || 0, createdAt: new Date(), updatedAt: new Date()
  };
}

module.exports = { monthKey, dueMonth, applyPatch, TERM_LABEL, addMonths, duePlan, buildCd, nextRun, fmtDate,
                   backfillMonths, termMonthsOf, buildRollover };
