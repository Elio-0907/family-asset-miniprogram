// 验证支付宝 / 券商截图解析（传统 OCR 坐标解析 + AI 多模态 JSON 清洗）
const P = require('../utils/ocrparse.js');

let fail = 0;
function ok(cond, label) {
  console.log((cond ? '  ✓ ' : '  ✗ ') + label);
  if (!cond) fail++;
}

console.log('=== 1. 支付宝 OCR 坐标解析（上方总资产 + 左右排版分项）===');
const alipayBlocks = [
  { text: '我的总资产', x: 40, y: 80, w: 120, h: 28 },
  { text: '总资产(元)', x: 40, y: 130, w: 120, h: 26 },
  { text: '128,500.50', x: 40, y: 170, w: 220, h: 46 },
  { text: '余额宝', x: 40, y: 300, w: 90, h: 28 },
  { text: '52,300.12', x: 460, y: 300, w: 160, h: 28 },
  { text: '基金', x: 40, y: 380, w: 60, h: 28 },
  { text: '45,200.00', x: 460, y: 380, w: 160, h: 28 },
  { text: '理财', x: 40, y: 460, w: 60, h: 28 },
  { text: '30,000.00', x: 460, y: 460, w: 160, h: 28 },
  { text: '余额', x: 40, y: 540, w: 60, h: 28 },
  { text: '1,000.38', x: 460, y: 540, w: 150, h: 28 }
];
const ali = P.parseAccount(alipayBlocks, 'balance');
ok(ali.platform === '支付宝', '识别出平台=支付宝');
ok(ali.total === 128500.5, '识别出总资产=128500.5');
ok(ali.items.length === 5, '识别出 5 个支付宝分项（实际 ' + ali.items.length + '）');
ok(ali.items.some((x) => x.label === '余额宝' && x.amount === 52300.12), '余额宝=52300.12');
ok(ali.items.some((x) => x.label === '基金' && x.amount === 45200), '基金=45200');
ok(ali.items.some((x) => x.label === '余额' && x.amount === 1000.38), '余额=1000.38');

console.log('\n=== 2. 券商 OCR 坐标解析（回归测试）===');
const brokerBlocks = [
  { text: '中信证券', x: 40, y: 20, w: 120, h: 28 },
  { text: '总资产', x: 40, y: 100, w: 90, h: 26 },
  { text: '844,986.74', x: 40, y: 136, w: 200, h: 40 },
  { text: '总盈亏', x: 380, y: 100, w: 90, h: 26 },
  { text: '−12,345.67', x: 380, y: 136, w: 180, h: 40 },
  { text: '总市值', x: 40, y: 230, w: 90, h: 26 },
  { text: '790,000.00', x: 40, y: 266, w: 180, h: 32 },
  { text: '可用 逆回购▸', x: 380, y: 230, w: 140, h: 26 },
  { text: '54,986.74', x: 380, y: 266, w: 150, h: 32 }
];
const brk = P.parseAccount(brokerBlocks, 'market');
ok(brk.platform === '中信证券', '识别出券商=中信证券');
ok(brk.total === 844986.74, '总资产=844986.74');
ok(brk.pnl === -12345.67, '总盈亏=-12345.67（支持 Unicode 负号）');
ok(brk.market === 790000, '总市值=790000');
ok(brk.cash === 54986.74, '可用资金=54986.74');
ok(brk.netIn === 857332.41, '反推净转入=857332.41');

console.log('\n=== 3. AI 多模态 JSON 解析（支付宝 + Markdown 代码块）===');
const aiAlipayText = '```json\n{"platform":"支付宝","total":"128,500.50","items":[{"label":"余额宝","amount":"52,300.12"},{"label":"基金","amount":45200},{"label":"被隐藏","amount":"****"}]}\n```';
const aiAli = P.normalizeAiResult(aiAlipayText, 'balance');
ok(aiAli.ok === true, '支付宝 AI 结果 ok=true');
ok(aiAli.platform === '支付宝', 'platform=支付宝');
ok(aiAli.total === 128500.5, 'total=128500.5');
ok(aiAli.items.length === 3 && aiAli.items[0].label === '总资产', '自动将总资产置顶并过滤掉 **** 项');

console.log('\n=== 4. AI 多模态 JSON 解析（券商汇总 + 持仓明细）===');
const aiBrokerText = '识别结果如下：\n{"platform":"华泰证券","total":312450.8,"pnl":-8549.2,"market":298000,"cash":14450.8,"holdings":[{"code":"SH600036","name":"招商银行","shares":"1,200"},{"code":"00700","name":"腾讯控股","shares":200},{"code":"","name":"中国海油","shares":500},{"code":"invalid","name":"","shares":100}]}';
const aiBrk = P.normalizeAiResult(aiBrokerText, 'market');
ok(aiBrk.ok === true, '券商 AI 结果 ok=true');
ok(aiBrk.netIn === 321000, '自动反推净转入=321000');
ok(aiBrk.holdings.length === 3, '清洗出 3 只有效持仓');
ok(aiBrk.holdings[0].code === '600036' && aiBrk.holdings[0].shares === 1200, '标准化 SH600036 → 600036 且去逗号');
ok(aiBrk.holdings[1].code === '00700', '保留 5 位港股代码 00700');
ok(aiBrk.holdings[2].code === '' && aiBrk.holdings[2].name === '中国海油', '保留无代码但有名称的持仓');

console.log('\n=== 5. AI 仅持仓列表截图（无总资产头部）===');
const aiHoldOnly = P.normalizeAiResult('{"platform":"东方财富","total":null,"holdings":[{"code":"510300","name":"沪深300ETF","shares":10000}]}', 'market');
ok(aiHoldOnly.ok === true && aiHoldOnly.total === null && aiHoldOnly.holdings.length === 1, '仅有持仓明细也判定 ok=true');

console.log('\n=== 6. 异常/空返回不崩溃 ===');
const aiBad = P.normalizeAiResult('抱歉，图片太模糊看不清', 'balance');
ok(aiBad.ok === false, '非 JSON 文本安全返回 ok=false');

console.log(fail === 0 ? '\n全部通过 ✓' : '\n有 ' + fail + ' 项没过 ✗');
process.exit(fail === 0 ? 0 : 1);
