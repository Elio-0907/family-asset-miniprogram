// 用你那七类资产建一份样本，验证计价与预测引擎。
// 这不是单元测试框架，就是把数字打出来自己看对不对。
const calc = require('../utils/calc.js');
const F = require('../utils/forecast.js');
const M = require('../utils/money.js');

const NOW = new Date(2026, 8, 10);            // 2026-09-10
const PRICES = { gold_au9999: 94699 };        // 分/克，实测当日上金所 Au99.99

const A = [
  { _id:'1', name:'3年期大额存单', institution:'招商银行', layer:'liquid', mode:'accrual', status:'active',
    principal:20000000, rate:3.10, startDate:'2024-03-15', maturityDate:'2027-03-15' },
  { _id:'2', name:'3年期大额存单', institution:'中国银行', layer:'liquid', mode:'accrual', status:'active',
    principal:15000000, rate:2.90, startDate:'2023-10-08', maturityDate:'2026-10-08' },
  { _id:'3', name:'2年期大额存单', institution:'农业银行', layer:'liquid', mode:'accrual', status:'active',
    principal:12000000, rate:2.55, startDate:'2025-06-20', maturityDate:'2027-06-20' },
  { _id:'4', name:'1年期大额存单', institution:'建设银行', layer:'liquid', mode:'accrual', status:'active',
    principal:8000000, rate:1.95, startDate:'2026-01-12', maturityDate:'2027-01-12' },
  { _id:'5', name:'余额宝', institution:'支付宝', layer:'liquid', mode:'balance', status:'active',
    balance:2800000, refRate:1.32 },
  { _id:'6', name:'实物金条', layer:'liquid', mode:'quantity', status:'active',
    quantity:152.3, unit:'g', priceKey:'gold_au9999', costTotal:9840000 },
  { _id:'7', name:'中信证券', institution:'中信证券', layer:'liquid', mode:'market', status:'active',
    marketValue:8630000, totalCost:9200000, valueUpdatedAt:'2026-08-24' },
  { _id:'8', name:'借款', debtor:'张三', layer:'receivable', mode:'accrual', status:'active',
    principal:5000000, rate:0, startDate:'2025-03-12', maturityDate:'2026-08-30',
    evidence:'借条', confidence:'mid' },
  { _id:'9', name:'借款', debtor:'李伟', layer:'receivable', mode:'accrual', status:'active',
    principal:2000000, rate:3.0, startDate:'2026-02-01', maturityDate:'2026-12-01',
    evidence:'转账记录', confidence:'high' },
  { _id:'10', name:'自住房', layer:'fixed', mode:'appraisal', status:'active',
    appraisedValue:315000000, appraiseDate:'2026-03-02' },
  { _id:'11', name:'家用车', layer:'fixed', mode:'appraisal', status:'active',
    purchasePrice:23800000, purchaseDate:'2023-08-14', depreciationRate:12 }
];

const ctx = { now: NOW, prices: PRICES };
let fail = 0;
function ok(cond, label, extra) {
  console.log((cond ? '  ✓ ' : '  ✗ ') + label + (extra ? '   ' + extra : ''));
  if (!cond) fail++;
}

console.log('=== 1. 单笔计价 ===');
A.forEach(function (a) {
  const v = calc.valuate(a, ctx);
  const name = (a.debtor || a.institution || '') + ' ' + a.name;
  let extra = '';
  if (a.mode === 'accrual') extra = '已计息 ' + M.cny(v.accrued) + ' / 到期 ' + M.cny(v.atMaturity) +
                                    ' / 剩 ' + v.daysToDue + '天';
  if (v.gainPct !== null) extra = '盈亏 ' + M.pct(v.gainPct, 1);
  console.log('  ' + name.padEnd(22) + M.cny(v.value).padStart(14) + '   ' + extra);
});

console.log('\n=== 2. 汇总 ===');
const sum = calc.summarize(A, ctx);
console.log('  可动用      ' + M.cny(sum.liquid));
console.log('  应收外债    ' + M.cny(sum.receivable));
console.log('  固定资产    ' + M.cny(sum.fixed));
console.log('  净资产      ' + M.cny(sum.net));
console.log('  已计利息    ' + M.cny(sum.accruedInterest));
console.log('  固收加权    ' + sum.weightedRate.toFixed(2) + '%');
ok(sum.liquid > 0 && sum.net === sum.liquid + sum.receivable + sum.fixed, '三层相加等于净资产');
ok(sum.weightedRate > 1 && sum.weightedRate < 4, '加权年化落在合理区间');

console.log('\n=== 3. 首页提醒（只该有存单，不该有外债）===');
const home = calc.dueItems(A, ctx, { homeOnly: true, within: 90 });
home.forEach(function (i) {
  console.log('  ' + i.asset.institution + ' ' + i.asset.name + '  ' + i.days + ' 天后');
});
ok(home.every(function (i) { return i.asset.layer === 'liquid'; }), '首页提醒里没有外债');
ok(home.every(function (i) { return i.days >= 0; }), '首页提醒里没有已过期项');

console.log('\n=== 4. 到期页（全部，含已过约定日）===');
calc.dueItems(A, ctx, {}).forEach(function (i) {
  console.log('  ' + String(i.days).padStart(6) + ' 天  ' +
              (i.asset.debtor || i.asset.institution) + ' ' + i.asset.name +
              (i.overdue ? '   ← 已过约定日' : ''));
});

console.log('\n=== 5. 提前支取的真相 ===');
[A[0], A[1]].forEach(function (a) {
  const v = calc.valuate(a, ctx);
  console.log('  ' + a.institution + '：账面 ' + M.cny(v.value) +
              ' / 提前支取 ' + M.cny(v.earlyWithdraw) +
              ' / 少拿 ' + M.cny(v.atMaturity - v.earlyWithdraw));
  ok(v.earlyWithdraw < v.value, a.institution + ' 提前支取确实少于账面价值');
});

console.log('\n=== 6. 五年预测（月存1万 年终奖3万 再投1.5% 股票金条0%）===');
const cfg = { monthly:1000000, annual:3000000, rate:1.5, goldGrowth:0, eqGrowth:0,
              recoverReceivable:false,
              outflows:[{name:'换车',date:'2028-06',amount:18000000,on:true},
                        {name:'装修',date:'2029-09',amount:25000000,on:true}] };
const res = F.simulate(A, cfg, ctx, 60);
console.log('  起点 ' + M.cny(res.base));
res.series.slice(1).forEach(function (p, i) {
  console.log('  ' + (i+1) + '年后  总额 ' + M.cny(p.total).padStart(14) +
              '  | 锁定 ' + M.cny(res.base + p.locked).padStart(13) +
              '  存入 ' + M.cny(p.contrib).padStart(12) +
              '  收益 ' + M.cny(p.assumed).padStart(10));
});
ok(res.base === sum.liquid, '预测起点等于可动用金融资产');
ok(res.series[3].contrib < res.series[2].contrib, '第3年因为装修出现下探（支出确实生效了）');

const p5 = res.series[5];
console.log('\n  5年累计存入 ' + M.cny(p5.gin) + ' / 计划支出 ' + M.cny(p5.gout) +
            ' / 收益 ' + M.cny(p5.assumed) + ' / 存赚比 ' + (p5.gin/p5.assumed).toFixed(1) + '倍');

console.log('\n=== 7. 敏感度 ===');
[['再投利率 +0.5%', F.sensitivity(A, cfg, ctx, 5, 0.5)],
 ['股票年化 0%→8%', F.simulate(A, Object.assign({}, cfg, {eqGrowth:8}), ctx, 60).series[5].total - p5.total],
 ['金条年涨 0%→5%', F.simulate(A, Object.assign({}, cfg, {goldGrowth:5}), ctx, 60).series[5].total - p5.total],
 ['月存 1万→1.5万', F.simulate(A, Object.assign({}, cfg, {monthly:1500000}), ctx, 60).series[5].total - p5.total],
 ['外债按时收回', F.simulate(A, Object.assign({}, cfg, {recoverReceivable:true}), ctx, 60).series[5].total - p5.total]
].forEach(function (r) { console.log('  ' + r[0].padEnd(20) + M.signed(r[1])); });

console.log('\n=== 8. 边界情况 ===');
ok(calc.summarize([], ctx).net === 0, '空资产列表不崩');
ok(calc.valuate({ mode:'accrual', layer:'liquid' }, ctx).value === 0, '缺字段的存单返回 0 而不是 NaN');
ok(!isNaN(calc.valuate({ mode:'quantity', quantity:10, priceKey:'nope' }, ctx).value), '金价缺失不产生 NaN');
ok(F.simulate([], cfg, ctx, 60).series[5].total > 0, '没有任何资产时预测仍能算出存入的钱');
const closed = calc.summarize(A.concat([{_id:'x',mode:'balance',layer:'liquid',status:'closed',balance:99999999}]), ctx);
ok(closed.liquid === sum.liquid, '已结清的资产不计入总额');

console.log('\n' + (fail === 0 ? '全部通过 ✓' : fail + ' 项没过 ✗'));
process.exit(fail === 0 ? 0 : 1);
