// 验证「负债 / 房贷车贷」计价引擎（等额本息、等额本金、先息后本、免息分期、简单欠款、净资产扣除）
const calc = require('../utils/calc.js');
const CK = require('../utils/checkin.js');

let fail = 0;
function ok(cond, label) {
  console.log((cond ? '  ✓ ' : '  ✗ ') + label);
  if (!cond) fail++;
}

function near(a, b, tol) { return Math.abs(a - b) <= tol; }

console.log('=== 1. 等额本息（100 万，3.60%，240 期）===');
const loanEP = {
  _id: 'l1', name: '商贷', institution: '招行', layer: 'liability', mode: 'loan', status: 'active',
  principal: 100000000, rate: 3.60, remainingMonths: 240, repayMethod: 'equalPayment', startDate: '2026-01-15'
};
// 基准日当天：0 期已还，剩余本金 = 100 万，月供约 5,851.11 元（585111 分）
const v0 = calc.valuate(loanEP, { now: new Date(2026, 0, 15) });
ok(v0.value === 100000000, '基准日当天剩余本金 = 100 万');
ok(near(v0.monthlyPayment, 585111, 200), '等额本息月供 ≈ ¥5,851（实际 ' + (v0.monthlyPayment / 100).toFixed(2) + '）');
ok(v0.remainingMonths === 240, '剩余 240 期');
ok(near(v0.remainingInterest, v0.monthlyPayment * 240 - 100000000, 300), '剩余总利息 = 月供×240 − 本金');

// 12 个月后（2027-01-15）：自动还了 12 期，剩余 228 期，剩余本金减少约 3.48 万
const v12 = calc.valuate(loanEP, { now: new Date(2027, 0, 15) });
ok(v12.remainingMonths === 228, '12 个月后剩余 228 期');
ok(v12.value < 100000000 && v12.paidPrincipal > 3000000 && v12.paidPrincipal < 4000000,
   '12 个月后自动递减本金约 3.48 万（实际已还 ' + (v12.paidPrincipal / 100).toFixed(0) + ' 元）');
ok(v12.remainingInterest < v0.remainingInterest, '剩余总利息同步减少');

// 12 个月但还没到还款日（2027-01-10 < 15 日）：只算已还 11 期
const v11 = calc.valuate(loanEP, { now: new Date(2027, 0, 10) });
ok(v11.remainingMonths === 229, '未过当月还款日算 11 期（剩 229 期）');

console.log('\n=== 2. 等额本金（120 万，3.00%，120 期）===');
const loanEPr = {
  _id: 'l2', name: '公积金贷', layer: 'liability', mode: 'loan', status: 'active',
  principal: 120000000, rate: 3.00, remainingMonths: 120, repayMethod: 'equalPrincipal', startDate: '2026-01-01'
};
const ep0 = calc.valuate(loanEPr, { now: new Date(2026, 0, 1) });
ok(ep0.monthlyPrincipal === 1000000, '每月本金固定 10,000 元');
ok(ep0.monthlyInterest === 300000, '首月利息 3,000 元');
ok(ep0.monthlyPayment === 1300000, '首月月供 13,000 元');
// 总利息 = 120万 * 0.25% * 121 / 2 = 181,500 元
ok(ep0.remainingInterest === 18150000, '等额本金剩余总利息精确 = 181,500 元');
const ep10 = calc.valuate(loanEPr, { now: new Date(2026, 10, 1) });
ok(ep10.value === 110000000 && ep10.remainingMonths === 110, '10 个月后剩余本金精确 = 110 万');

console.log('\n=== 3. 免息车贷（0% 利率，24 万，24 期）===');
const carLoan = {
  _id: 'l3', name: '车贷', layer: 'liability', mode: 'loan', status: 'active',
  principal: 24000000, rate: 0, remainingMonths: 24, repayMethod: 'equalPayment', startDate: '2026-01-01'
};
const c6 = calc.valuate(carLoan, { now: new Date(2026, 6, 1) });
ok(c6.value === 18000000 && c6.monthlyPayment === 1000000 && c6.remainingInterest === 0,
   '0 利率车贷 6 期后剩 18 万、月供 1 万、利息 0');
const cDone = calc.valuate(carLoan, { now: new Date(2028, 2, 1) });
ok(cDone.value === 0 && cDone.remainingMonths === 0, '超过 24 期后自动归零');

console.log('\n=== 4. 先息后本 + 简单欠款 ===');
const ioLoan = {
  _id: 'l4', name: '经营贷', layer: 'liability', mode: 'loan', status: 'active',
  principal: 50000000, rate: 3.6, remainingMonths: 12, repayMethod: 'interestOnly', startDate: '2026-01-01'
};
const io3 = calc.valuate(ioLoan, { now: new Date(2026, 3, 1) });
ok(io3.value === 50000000 && io3.monthlyPayment === 150000 && io3.remainingInterest === 1350000,
   '先息后本第 3 期后本金仍 50 万、月供利息 1,500、剩 9 期利息 13,500');

const simpleDebt = {
  _id: 'l5', name: '亲友借款', layer: 'liability', mode: 'loan', status: 'active',
  principal: 3000000, startDate: '2026-10-01'
};
const sd = calc.valuate(simpleDebt, { now: new Date(2026, 10, 22) });
ok(sd.value === 3000000 && sd.monthlyPayment === 0, '简单欠款保留原额且无月供');

console.log('\n=== 5. 净资产扣除负债 + 不污染可动用资产 ===');
const mixed = [
  { _id: 'a1', name: '存单', layer: 'liquid', mode: 'accrual', status: 'active',
    principal: 50000000, rate: 0, startDate: '2026-01-01', maturityDate: '2027-01-01' },
  { _id: 'a2', name: '自住房', layer: 'fixed', mode: 'appraisal', status: 'active',
    appraisedValue: 300000000 },
  loanEP,
  simpleDebt
];
const sum = calc.summarize(mixed, { now: new Date(2026, 0, 15) });
ok(sum.liquid === 50000000, '可动用资产不受负债影响（50 万）');
ok(sum.liability === 103000000, '负债总额 = 103 万');
ok(sum.net === 50000000 + 300000000 - 103000000, '真实净资产 = 50万 + 300万 − 103万 = 247 万');
ok(sum.monthlyDebt === v0.monthlyPayment, '月供合计正确');

console.log('\n=== 6. 月度盘点对负债的分类与报告 ===');
const cls = CK.classifyForCheckin(sum, new Date(2026, 0, 15), []);
ok(cls.todo.some((x) => x.kind === 'loan_simple' && x.asset._id === 'l5'), '简单欠款进盘点待核对');
ok(cls.auto.some((x) => x.asset._id === 'l1'), '有期数房贷自动追踪，不打扰盘点');

const rpt = CK.buildReport(
  { date: '2026-11-22', liquid: 50000000, net: 247500000, liability: 102500000, byMode: { accrual: 50000000 } },
  { date: '2026-10-22', liquid: 50000000, net: 247000000, liability: 103000000, byMode: { accrual: 50000000 } },
  []
);
ok(rpt.deltaLiability === -500000 && rpt.deltaNet === 500000, '月报正确体现负债减少 5,000 元、净资产增加 5,000 元');

console.log(fail === 0 ? '\n全部通过 ✓' : '\n有 ' + fail + ' 项没过 ✗');
process.exit(fail === 0 ? 0 : 1);
