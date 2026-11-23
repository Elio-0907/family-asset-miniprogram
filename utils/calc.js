// 资产计价核心。五种计价方式覆盖全部资产类型。
// 页面和云函数共用这一份，保证「首页看到的」和「快照里存的」永远一致。

const DAY_MS = 86400000;
const CURRENT_RATE = 0.20;   // 活期年利率(%)，用于估算存单提前支取

const MODES = ['balance', 'accrual', 'quantity', 'market', 'appraisal', 'loan'];
const LAYERS = ['liquid', 'receivable', 'fixed', 'liability'];

const MODE_LABEL = {
  balance: '余额型', accrual: '计息型', quantity: '计量型',
  market: '市值型', appraisal: '估值型', loan: '负债'
};
const LAYER_LABEL = {
  liquid: '可动用金融资产', receivable: '应收外债', fixed: '固定资产', liability: '负债'
};

/** 'YYYY-MM-DD' → Date。不要用 new Date(str)，iOS 上行为不一致。 */
function parseDate(s) {
  if (!s) return null;
  const p = String(s).slice(0, 10).split('-');
  if (p.length !== 3) return null;
  const d = new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
  return isNaN(d.getTime()) ? null : d;
}

function fmtDate(d) {
  const p = (n) => (n < 10 ? '0' + n : String(n));
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

function startOfToday() {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function daysBetween(a, b) {
  if (!a || !b) return 0;
  return Math.round((b.getTime() - a.getTime()) / DAY_MS);
}

function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

/** 从 start 到 now 已经过了几个整月（过了同日才算多还了一期） */
function monthsElapsed(start, now) {
  if (!start || !now || now.getTime() < start.getTime()) return 0;
  let m = (now.getFullYear() - start.getFullYear()) * 12 + (now.getMonth() - start.getMonth());
  if (now.getDate() < start.getDate()) m -= 1;
  return Math.max(0, m);
}

/**
 * 计算一笔资产在 ctx.now 这一天的价值。
 * @param {object} a    资产文档
 * @param {object} ctx  { now: Date, prices: { gold_au9999: 分/克 } }
 * @returns {object} 计价结果，金额单位均为「分」
 */
function valuate(a, ctx) {
  const now = (ctx && ctx.now) || startOfToday();
  const prices = (ctx && ctx.prices) || {};
  const out = {
    value: 0, cost: null, gain: null, gainPct: null,
    accrued: 0, atMaturity: null, earlyWithdraw: null,
    daysToDue: null, staleDays: null, note: '',
    monthlyPayment: 0, monthlyPrincipal: 0, monthlyInterest: 0,
    remainingInterest: 0, remainingMonths: 0, paidPrincipal: 0
  };

  switch (a.mode) {
    case 'balance': {
      out.value = a.balance || 0;
      if (a.valueUpdatedAt) {
        out.staleDays = daysBetween(parseDate(a.valueUpdatedAt), now);
      }
      break;
    }

    case 'accrual': {
      const p = a.principal || 0;
      const rate = (a.rate || 0) / 100;
      const start = parseDate(a.startDate);
      const due = parseDate(a.maturityDate);
      const total = (start && due) ? Math.max(1, daysBetween(start, due)) : 365;
      const elapsed = start ? clamp(daysBetween(start, now), 0, total) : 0;

      out.accrued = Math.round(p * rate * elapsed / 365);
      out.value = p + out.accrued;
      out.cost = p;
      out.atMaturity = p + Math.round(p * rate * total / 365);
      out.daysToDue = due ? daysBetween(now, due) : null;

      // 提前支取按活期计息 —— 存单真正的流动性价值
      if (a.layer === 'liquid') {
        const cur = CURRENT_RATE / 100;
        out.earlyWithdraw = p + Math.round(p * cur * elapsed / 365);
      }
      break;
    }

    case 'quantity': {
      const price = prices[a.priceKey] || a.lastUnitPrice || 0;  // 分/单位
      out.value = Math.round((a.quantity || 0) * price);
      out.cost = a.costTotal || 0;
      if (a.priceUpdatedAt) {
        out.staleDays = daysBetween(parseDate(a.priceUpdatedAt), now);
      }
      break;
    }

    case 'market': {
      out.value = a.marketValue || 0;
      out.cost = a.totalCost || 0;
      if (a.valueUpdatedAt) {
        out.staleDays = daysBetween(parseDate(a.valueUpdatedAt), now);
      }
      break;
    }

    case 'appraisal': {
      if (a.depreciationRate > 0 && a.purchasePrice) {
        // 余额递减折旧，比直线折旧更贴近真实二手车价曲线
        const years = Math.max(0, daysBetween(parseDate(a.purchaseDate), now) / 365);
        const left = Math.pow(1 - a.depreciationRate / 100, years);
        out.value = Math.round(a.purchasePrice * left);
        out.cost = a.purchasePrice;
        out.note = '按年折旧 ' + a.depreciationRate + '%';
      } else {
        out.value = a.appraisedValue || 0;
        if (a.appraiseDate) {
          out.staleDays = daysBetween(parseDate(a.appraiseDate), now);
        }
      }
      break;
    }

    case 'loan': {
      // 负债 / 房贷车贷：value 存「当前剩余本金（正数，分）」，在 summarize 里从净资产扣除
      const P = Math.max(0, a.principal || 0);
      const N = Math.max(0, Math.round(Number(a.remainingMonths) || 0));
      const r = Math.max(0, Number(a.rate) || 0) / 100 / 12;
      const method = a.repayMethod || 'equalPayment';
      const start = parseDate(a.startDate);

      if (N <= 0 || P <= 0) {
        // 简单欠款（无固定期数，手动维护剩余金额）
        out.value = P;
        out.cost = P;
        const refDate = a.valueUpdatedAt || a.startDate;
        if (refDate) out.staleDays = daysBetween(parseDate(refDate), now);
        break;
      }

      const k = clamp(monthsElapsed(start, now), 0, N);
      const remM = N - k;
      out.remainingMonths = remM;

      if (remM <= 0) {
        out.value = 0;
        out.cost = P;
        out.paidPrincipal = P;
        out.note = '已按期还清';
        break;
      }

      let remP = P, pay = 0, curP = 0, curI = 0, remI = 0;
      if (method === 'equalPrincipal') {
        const perP = P / N;
        remP = P * remM / N;
        curP = perP;
        curI = remP * r;
        pay = curP + curI;
        remI = r * perP * remM * (remM + 1) / 2;
      } else if (method === 'interestOnly') {
        remP = P;
        curP = 0;
        curI = P * r;
        pay = curI;
        remI = P * r * remM;
      } else {
        // 等额本息（默认）
        if (r === 0) {
          pay = P / N;
          remP = P * remM / N;
          curP = pay;
          curI = 0;
          remI = 0;
        } else {
          const powN = Math.pow(1 + r, N);
          const powK = Math.pow(1 + r, k);
          pay = P * r * powN / (powN - 1);
          remP = P * (powN - powK) / (powN - 1);
          curI = remP * r;
          curP = Math.max(0, pay - curI);
          remI = Math.max(0, pay * remM - remP);
        }
      }

      out.value = Math.max(0, Math.round(remP));
      out.cost = P;
      out.paidPrincipal = Math.max(0, P - out.value);
      out.monthlyPayment = Math.round(pay);
      out.monthlyPrincipal = Math.round(curP);
      out.monthlyInterest = Math.round(curI);
      out.remainingInterest = Math.max(0, Math.round(remI));
      break;
    }
  }

  if (a.mode !== 'loan' && out.cost !== null && out.cost > 0) {
    out.gain = out.value - out.cost;
    out.gainPct = out.gain / out.cost * 100;
  }
  return out;
}

/** 一组资产按层汇总 */
function summarize(assets, ctx) {
  const res = {
    liquid: 0, receivable: 0, fixed: 0, liability: 0, monthlyDebt: 0, net: 0,
    accruedInterest: 0, weightedRate: 0,
    items: [], byLayer: { liquid: [], receivable: [], fixed: [], liability: [] }
  };
  let rateNum = 0, rateDen = 0;

  assets.forEach((a) => {
    if (a.status && a.status !== 'active') return;
    const v = valuate(a, ctx);
    const item = { asset: a, val: v };
    res.items.push(item);
    if (res.byLayer[a.layer]) res.byLayer[a.layer].push(item);
    if (a.layer === 'liquid') {
      res.liquid += v.value;
      res.accruedInterest += v.accrued;
      // 固收部分加权年化：只有明确有利率的才参与
      if (a.mode === 'accrual' && a.rate) {
        rateNum += (a.principal || 0) * a.rate; rateDen += (a.principal || 0);
      } else if (a.mode === 'balance' && a.refRate) {
        rateNum += (a.balance || 0) * a.refRate; rateDen += (a.balance || 0);
      }
    } else if (a.layer === 'receivable') {
      res.receivable += v.value;
    } else if (a.layer === 'fixed') {
      res.fixed += v.value;
    } else if (a.layer === 'liability') {
      res.liability += v.value;
      res.monthlyDebt += (v.monthlyPayment || 0);
    }
  });

  res.weightedRate = rateDen > 0 ? rateNum / rateDen : 0;
  res.net = res.liquid + res.receivable + res.fixed - res.liability;
  return res;
}

/** 需要关注的到期项。外债不进首页提醒，只在到期页出现。 */
function dueItems(assets, ctx, opts) {
  const now = (ctx && ctx.now) || startOfToday();
  const within = (opts && opts.within) || 90;
  const list = [];
  assets.forEach((a) => {
    if (a.status && a.status !== 'active') return;
    if (a.mode !== 'accrual' || !a.maturityDate) return;
    const days = daysBetween(now, parseDate(a.maturityDate));
    const v = valuate(a, ctx);
    list.push({ asset: a, val: v, days: days, overdue: days < 0 });
  });
  list.sort((x, y) => x.days - y.days);
  if (opts && opts.homeOnly) {
    // 首页只提醒你今天动手就能处理的事 —— 存单能去续，外债盯着也变不出钱。
    // 「每月存单」计划开出来的那些也不提醒：每月都有一张到期，月月提醒就是噪音。
    return list.filter((i) => i.asset.layer === 'liquid' && !i.asset.planId && i.days >= 0 && i.days <= within);
  }
  return list;
}

module.exports = {
  MODES, LAYERS, MODE_LABEL, LAYER_LABEL, CURRENT_RATE,
  parseDate, fmtDate, startOfToday, daysBetween,
  valuate, summarize, dueItems
};
