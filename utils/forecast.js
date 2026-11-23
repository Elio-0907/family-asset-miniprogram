// 预测引擎：按月迭代真实资产，得出未来 N 年的可动用金融资产。
//
// 刻意把结果拆成四段，因为它们的确定性差着量级：
//   base    今天已有的钱
//   locked  存单在合同期内的利息 —— 白纸黑字，几乎 100% 确定
//   contrib 你未来存进去的 减去 计划支出 —— 你自己说了算
//   assumed 再投利息 + 股票金条涨跌 —— 纯假设
// 糊成一个数字会让人对「假设」产生虚假的确定感。

const calc = require('./calc.js');

const DEFAULT_CFG = {
  monthly: 1000000,          // 分/月
  annual: 3000000,           // 分/年（年终奖等，按每年 1 月计入）
  rate: 1.5,                 // 存单到期后再投利率 %
  goldGrowth: 0,             // 金条不做涨跌假设，固定 0
  eqGrowth: 0,               // 股票年化收益率 %
  recoverReceivable: false,  // 外债是否按约定日收回并计入
  outflows: []               // [{ name, date:'YYYY-MM', amount(分), on:true }]
};

/** 目标月份距今多少个月（同月为 0） */
function monthsFromNow(now, s) {
  if (!s) return -1;
  const str = String(s).length === 7 ? s + '-01' : s;
  const d = calc.parseDate(str);
  if (!d) return -1;
  return (d.getFullYear() - now.getFullYear()) * 12 + (d.getMonth() - now.getMonth());
}

function simulate(assets, cfg, ctx, months, step) {
  const M = months || 60;
  const STEP = step || 12;
  const now = (ctx && ctx.now) || calc.startOfToday();
  const c = Object.assign({}, DEFAULT_CFG, cfg || {});
  const sum = calc.summarize(assets, ctx);
  const base = sum.liquid;

  const cds = [];
  let reinvest = 0, gold = 0, eq = 0;

  sum.byLayer.liquid.forEach(function (it) {
    const a = it.asset, v = it.val;
    if (a.mode === 'accrual') {
      const m = monthsFromNow(now, a.maturityDate);
      if (m <= 0) {
        reinvest += v.value;                       // 已到期还没处理的，当作现金
      } else {
        cds.push({
          m: m,
          perMonth: (a.principal || 0) * (a.rate || 0) / 100 / 12,  // 合同期内每月利息
          atMaturity: v.atMaturity || v.value
        });
      }
    } else if (a.mode === 'quantity') {
      gold += v.value;
    } else if (a.mode === 'market') {
      eq += v.value;
    } else {
      reinvest += v.value;                          // 余额型直接进现金池
    }
  });

  const recv = [];
  if (c.recoverReceivable) {
    sum.byLayer.receivable.forEach(function (it) {
      const m = Math.max(1, monthsFromNow(now, it.asset.maturityDate));
      recv.push({ m: m, amount: it.val.atMaturity || it.val.value });
    });
  }

  const outs = (c.outflows || [])
    .filter(function (o) { return o.on !== false; })
    .map(function (o) { return { m: monthsFromNow(now, o.date), amount: o.amount || 0, name: o.name }; })
    .filter(function (o) { return o.m >= 1 && o.m <= M; });

  // 年终奖按每年 1 月计入
  let bonusMonth = (12 - now.getMonth()) % 12;
  if (bonusMonth === 0) bonusMonth = 12;

  const rate = c.rate / 100, gGrow = c.goldGrowth / 100, eGrow = c.eqGrowth / 100;
  let locked = 0, contrib = 0, recovered = 0, aInt = 0, aMkt = 0, gin = 0, gout = 0;

  const point = function (m) {
    return {
      m: m, year: m / 12,
      locked: locked, contrib: contrib, recovered: recovered,
      aInt: aInt, aMkt: aMkt, assumed: aInt + aMkt,
      gin: gin, gout: gout, gold: gold, eq: eq,
      total: base + locked + contrib + recovered + aInt + aMkt
    };
  };
  const series = [point(0)];

  for (let m = 1; m <= M; m++) {
    for (let i = 0; i < cds.length; i++) {
      const cd = cds[i];
      if (m <= cd.m) locked += cd.perMonth;
      if (m === cd.m) reinvest += cd.atMaturity;
    }
    for (let j = 0; j < recv.length; j++) {
      if (m === recv[j].m) { reinvest += recv[j].amount; recovered += recv[j].amount; }
    }

    contrib += c.monthly; reinvest += c.monthly; gin += c.monthly;
    if (m >= bonusMonth && (m - bonusMonth) % 12 === 0) {
      contrib += c.annual; reinvest += c.annual; gin += c.annual;
    }
    for (let k = 0; k < outs.length; k++) {
      if (outs[k].m === m) { contrib -= outs[k].amount; reinvest -= outs[k].amount; gout += outs[k].amount; }
    }

    const it = Math.max(0, reinvest) * rate / 12; aInt += it; reinvest += it;
    const dg = gold * gGrow / 12; gold += dg; aMkt += dg;
    const de = eq * eGrow / 12; eq += de; aMkt += de;

    if (m % STEP === 0) series.push(point(m));
  }

  return { base: base, series: series, years: Math.floor(M / 12), step: STEP };
}

/* ================= 目标：什么时候到 ================= */

/**
 * 按月模拟直到可动用资产 >= target。返回 { months, date:'YYYY-MM-DD', reached, series }
 * 到达日精确到天：在跨过目标的那个月里按比例插值。
 */
function reachGoal(assets, cfg, ctx, target, maxMonths) {
  const MAX = maxMonths || 480;
  const now = (ctx && ctx.now) || calc.startOfToday();
  const res = simulate(assets, cfg, ctx, MAX, 1);
  const s = res.series;
  if (s[0].total >= target) {
    return { months: 0, date: calc.fmtDate(now), reached: true, series: s, base: res.base };
  }
  for (let i = 1; i < s.length; i++) {
    if (s[i].total >= target) {
      const prev = s[i - 1].total, cur = s[i].total;
      const frac = cur > prev ? (target - prev) / (cur - prev) : 0;
      const d = new Date(now.getFullYear(), now.getMonth() + i - 1, now.getDate());
      d.setDate(d.getDate() + Math.round(frac * 30));
      return { months: i - 1 + frac, date: calc.fmtDate(d), reached: false, series: s, base: res.base };
    }
  }
  return { months: null, date: null, reached: false, series: s, base: res.base };
}

/** 距离：{years, months, text} */
function spanText(fromDate, toDateStr) {
  const t = calc.parseDate(toDateStr); if (!t) return { years: 0, months: 0, text: '' };
  let months = (t.getFullYear() - fromDate.getFullYear()) * 12 + (t.getMonth() - fromDate.getMonth());
  if (t.getDate() < fromDate.getDate()) months -= 1;
  if (months < 0) months = 0;
  const y = Math.floor(months / 12), mo = months % 12;
  return { years: y, months: mo, text: (y ? y + ' 年 ' : '') + (mo || !y ? mo + ' 个月' : '') };
}

/** 边际敏感度：再投利率提高 delta 个百分点，第 year 年多多少钱 */
function sensitivity(assets, cfg, ctx, year, delta) {
  const d = delta === undefined ? 0.5 : delta;
  const a = simulate(assets, cfg, ctx, year * 12);
  const b = simulate(assets, Object.assign({}, cfg, { rate: (cfg.rate || 0) + d }), ctx, year * 12);
  return b.series[year].total - a.series[year].total;
}

module.exports = { DEFAULT_CFG, simulate, sensitivity, monthsFromNow, reachGoal, spanText };
