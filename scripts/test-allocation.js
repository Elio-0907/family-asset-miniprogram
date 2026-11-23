// 验证「目标配比与偏离提醒」计算引擎与不损息建议逻辑
const calc = require('../utils/calc.js');
const AL = require('../utils/allocation.js');

let fail = 0;
function ok(cond, label) {
  console.log((cond ? '  ✓ ' : '  ✗ ') + label);
  if (!cond) fail++;
}

const NOW = new Date(2026, 10, 22);
const PRICES = { gold_au9999: 100000 }; // 1000 元/g，方便心算

const ASSETS = [
  { _id: 'cd', name: '存单', layer: 'liquid', mode: 'accrual', status: 'active',
    principal: 60000000, rate: 0, startDate: '2026-01-01', maturityDate: '2027-01-01' }, // 60 万
  { _id: 'eq', name: '券商', layer: 'liquid', mode: 'market', status: 'active',
    marketValue: 15000000 }, // 15 万 (15%)
  { _id: 'au', name: '金条', layer: 'liquid', mode: 'quantity', status: 'active',
    quantity: 100, unit: 'g', priceKey: 'gold_au9999' }, // 10 万 (10%)
  { _id: 'cash', name: '余额宝', layer: 'liquid', mode: 'balance', status: 'active',
    balance: 15000000 }, // 15 万 (15%)
  { _id: 'house', name: '自住房', layer: 'fixed', mode: 'appraisal', status: 'active',
    appraisedValue: 300000000 } // 不进可动用配比
];
// 可动用总计 = 100 万：存单 60% / 股票 15% / 黄金 10% / 活期 15%
const sum = calc.summarize(ASSETS, { now: NOW, prices: PRICES });

console.log('=== 1. 未配置目标配比 ===');
const r0 = AL.analyze(sum, null);
ok(r0.configured === false && r0.balanced === true, '未配置时安全返回 configured=false');

console.log('\n=== 2. 达利欧全天候 (55/30/10/5)，阈值 ±5% ===');
const cfgAW = {
  enabled: true,
  targets: { accrual: 55, market: 30, quantity: 10, balance: 5 },
  threshold: 5
};
const r1 = AL.analyze(sum, cfgAW, { dueSoon90: 20000000, monthlySave: 1000000 });
ok(r1.configured === true && r1.balanced === false, '检测出存在偏离');
ok(r1.maxDrift && r1.maxDrift.key === 'market' && r1.maxDrift.status === 'alert', '股票低配 15% 触发 alert');
ok(r1.maxDrift.diffFen === -15000000, '股票欠配正好 -150,000 元');
ok(r1.advice.some((t) => t.indexOf('活期') >= 0 && t.indexOf('不损存单利息') >= 0), '优先建议用超配活期补进股票');
ok(r1.advice.some((t) => t.indexOf('90 天') >= 0), '联动 90 天内到期存单给出调仓建议');
ok(r1.advice.some((t) => t.indexOf('每月存入') >= 0), '给出增量定投回正所需月数');
ok(r1.stressText.indexOf('9.0%') >= 0, '压力测试算出 30% 股票 × 30% 暴跌 = 9.0% 总回撤');

console.log('\n=== 3. 稳健家庭 (60/20/10/10)，阈值 ±5%（股票 15% 差 5%、活期 15% 差 5%）===');
const r2 = AL.analyze(sum, { targets: { accrual: 60, market: 20, quantity: 10, balance: 10 }, threshold: 6 });
ok(r2.balanced === true, '阈值 ±6% 时 5% 偏离判定为均衡');

console.log('\n=== 4. 股票大涨超配时提示止盈 ===');
const hotAssets = ASSETS.map((a) => a._id === 'eq' ? Object.assign({}, a, { marketValue: 50000000 }) : a);
const hotSum = calc.summarize(hotAssets, { now: NOW, prices: PRICES });
const r3 = AL.analyze(hotSum, { targets: { accrual: 60, market: 20, quantity: 10, balance: 10 }, threshold: 5 });
ok(!r3.balanced && r3.advice.some((t) => t.indexOf('落袋') >= 0), '股票大幅超配时提示分批落袋');

console.log('\n=== 5. 非法配置（总和不等于 100%）自动忽略 ===');
const rBad = AL.analyze(sum, { targets: { accrual: 50, market: 20, quantity: 10, balance: 10 }, threshold: 5 });
ok(rBad.configured === false, '总和 90% 不被当作有效配置');

console.log(fail === 0 ? '\n全部通过 ✓' : '\n有 ' + fail + ' 项没过 ✗');
process.exit(fail === 0 ? 0 : 1);
