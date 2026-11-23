// 验证「每月 10 分钟盘点」核心逻辑（分类分拣、上月快照基准、月报对比、走势柱状图）
const calc = require('../utils/calc.js');
const CK = require('../utils/checkin.js');

let fail = 0;
function ok(cond, label) {
  console.log((cond ? '  ✓ ' : '  ✗ ') + label);
  if (!cond) fail++;
}

const NOW = new Date(2026, 10, 22); // 2026-11-22
const PRICES = { gold_au9999: 95000 };
const ASSETS = [
  // 临期存单（15 天后到期 → todo #1）
  { _id: 'cd_due', name: '1年期存单', institution: '建行', layer: 'liquid', mode: 'accrual', status: 'active',
    principal: 10000000, rate: 2.0, startDate: '2025-12-07', maturityDate: '2026-12-07' },
  // 远期存单（auto）
  { _id: 'cd_far', name: '3年期存单', institution: '招行', layer: 'liquid', mode: 'accrual', status: 'active',
    principal: 20000000, rate: 3.0, startDate: '2024-06-01', maturityDate: '2027-06-01' },
  // 余额型（todo #2）
  { _id: 'ali', name: '余额宝', institution: '支付宝', layer: 'liquid', mode: 'balance', status: 'active',
    balance: 3500000, valueUpdatedAt: '2026-11-01' },
  // 截图证券（todo #3）
  { _id: 'mkt_shot', name: '中信证券', institution: '中信证券', layer: 'liquid', mode: 'market', status: 'active',
    marketValue: 9000000, totalCost: 8500000, valueUpdatedAt: '2026-10-28' },
  // 持仓证券（todo #4）
  { _id: 'mkt_hold', name: '华泰证券', institution: '华泰证券', layer: 'liquid', mode: 'market', status: 'active',
    marketValue: 12000000, holdings: [{ code: 'sh600036', shares: 1000, price: 4000 }], valueUpdatedAt: '2026-11-20' },
  // 金条（auto）
  { _id: 'gold', name: '实物金条', layer: 'liquid', mode: 'quantity', status: 'active',
    quantity: 100, unit: 'g', priceKey: 'gold_au9999' },
  // 超期未估自住房（todo #5）
  { _id: 'house', name: '自住房', layer: 'fixed', mode: 'appraisal', status: 'active',
    appraisedValue: 300000000, appraiseDate: '2026-01-10' },
  // 自动折旧家用车（auto）
  { _id: 'car', name: '家用车', layer: 'fixed', mode: 'appraisal', status: 'active',
    purchasePrice: 20000000, purchaseDate: '2024-01-01', depreciationRate: 12 }
];

console.log('=== 1. 盘点清单分拣与优先级 ===');
const sum = calc.summarize(ASSETS, { now: NOW, prices: PRICES });
const cls = CK.classifyForCheckin(sum, NOW);
ok(cls.todo.length === 5, '待核对 5 项（临期存单/余额/截图券商/持仓券商/超期房产），实际 ' + cls.todo.length);
ok(cls.auto.length === 3, '自动追踪 3 项（远期存单/金条/自动折旧车），实际 ' + cls.auto.length);
ok(cls.todo[0].kind === 'due_cd', '第 1 位是临期存单');
ok(cls.todo[1].kind === 'balance', '第 2 位是余额型');
ok(cls.todo[2].kind === 'market_shot', '第 3 位是截图券商');
ok(cls.todo[3].kind === 'market_hold', '第 4 位是持仓券商');
ok(cls.todo[4].kind === 'appraisal', '第 5 位是超期房产');

console.log('\n=== 2. 上月基准快照选择 ===');
const snaps = [
  { date: '2026-09-30', liquid: 50000000, net: 350000000, byMode: { accrual: 30000000, market: 15000000, balance: 5000000 } },
  { date: '2026-10-15', liquid: 51000000, net: 351000000, checkin: true, checkinMonth: '2026-10',
    byMode: { accrual: 30000000, market: 16000000, balance: 5000000 } },
  { date: '2026-10-31', liquid: 51500000, net: 351500000,
    byMode: { accrual: 30000000, market: 16500000, balance: 5000000 } },
  { date: '2026-11-20', liquid: 53000000, net: 353000000,
    byMode: { accrual: 30500000, market: 17500000, balance: 5000000 } }
];
const prev = CK.pickPrevSnapshot(snaps, '2026-11');
ok(prev && prev.date === '2026-10-15', '优先取上月带 checkin 标记的快照（2026-10-15）');

const prevNoCheckin = CK.pickPrevSnapshot([snaps[0], snaps[2]], '2026-11');
ok(prevNoCheckin && prevNoCheckin.date === '2026-10-31', '无 checkin 标记时取上月最后一条日常快照');

console.log('\n=== 3. 月报对比与走势柱状图 ===');
const curSnap = {
  date: '2026-11-22', checkin: true, checkinMonth: '2026-11', checkinNote: '年终奖提前发了',
  liquid: 55000000, net: 355000000,
  byMode: { accrual: 31000000, market: 18000000, balance: 6000000 }
};
const rpt = CK.buildReport(curSnap, prev, snaps.concat([curSnap]));
ok(rpt.deltaLiquid === 4000000, '可动用较上月 +40,000 元');
ok(rpt.deltaNet === 4000000, '净资产较上月 +40,000 元');
ok(rpt.byModeDiff.length === 3, '包含 3 类可动用分项对比');
ok(rpt.byModeDiff.some((x) => x.mode === 'market' && x.delta === 2000000), '股票较上月 +20,000 元');
ok(rpt.monthlyBars.length === 3, '按月聚合出 9/10/11 三个月走势柱');
ok(rpt.monthlyBars[2].isCurrent === true && rpt.monthlyBars[2].pct === 100, '本月最高且占比 100%');

console.log('\n=== 4. 首次盘点（无历史快照）===');
const firstRpt = CK.buildReport(curSnap, null, [curSnap]);
ok(firstRpt.deltaLiquid === null && firstRpt.monthlyBars.length === 1, '首次盘点不报错且 deltaLiquid=null');

console.log('\n=== 5. 自动转存/自动结清的临期存单静默归入自动追踪 ===');
const autoAssets = [
  { _id: 'cd_auto', name: '1年定存', layer: 'liquid', mode: 'accrual', status: 'active',
    principal: 200000, rate: 1.95, startDate: '2025-12-01', maturityDate: '2026-12-01', planId: 'pl_1' },
  { _id: 'cd_self_auto', name: '大额存单', layer: 'liquid', mode: 'accrual', status: 'active',
    principal: 10000000, rate: 2.5, startDate: '2025-12-05', maturityDate: '2026-12-05', autoRenew: true }
];
const autoSum = calc.summarize(autoAssets, { now: NOW, prices: PRICES });
const autoCls = CK.classifyForCheckin(autoSum, NOW, [{ id: 'pl_1', onMature: 'renew' }]);
ok(autoCls.todo.length === 0 && autoCls.auto.length === 2, '自动转存的临期存单不进待核对清单');

console.log(fail === 0 ? '\n全部通过 ✓' : '\n有 ' + fail + ' 项没过 ✗');
process.exit(fail === 0 ? 0 : 1);
