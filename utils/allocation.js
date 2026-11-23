// 家庭可动用金融资产「目标配比与偏离提醒」引擎。
// 按 4 个大类分配：大额存单(accrual) / 股票账户(market) / 实物金条(quantity) / 活期与余额宝(balance)。
// 结合中国家庭以存单为主的特点，优先给出「不损存单利息」的增量再平衡建议。
const M = require('./money.js');

const BUCKETS = [
  { key: 'accrual',  name: '大额存单',     short: '存单', tone: 1, desc: '固收压舱石，锁住基本盘' },
  { key: 'market',   name: '股票账户',     short: '股票', tone: 3, desc: '权益进攻，长期跑赢通胀' },
  { key: 'quantity', name: '实物金条',     short: '黄金', tone: 2, desc: '避险对冲，抗极端风险' },
  { key: 'balance',  name: '活期与余额宝', short: '活期', tone: 4, desc: '应急安全垫，随时可动' }
];

const PRESETS = [
  {
    id: 'allweather',
    name: '达利欧全天候',
    desc: '回撤小、攻守均衡',
    targets: { accrual: 55, market: 30, quantity: 10, balance: 5 }
  },
  {
    id: 'steady',
    name: '稳健家庭版',
    desc: 'A 股本土化舒适区',
    targets: { accrual: 60, market: 20, quantity: 10, balance: 10 }
  },
  {
    id: 'permanent',
    name: '永久组合',
    desc: '四分天下，极低波动',
    targets: { accrual: 25, market: 25, quantity: 25, balance: 25 }
  }
];

const DEFAULT_THRESHOLD = 5;

function sumTargets(targets) {
  targets = targets || {};
  return BUCKETS.reduce(function (s, b) {
    return s + Math.max(0, Math.round(Number(targets[b.key]) || 0));
  }, 0);
}

function normalizeConfig(raw) {
  if (!raw || !raw.targets) return null;
  const targets = {};
  BUCKETS.forEach(function (b) {
    targets[b.key] = Math.max(0, Math.min(100, Math.round(Number(raw.targets[b.key]) || 0)));
  });
  if (sumTargets(targets) !== 100) return null;
  const th = Number(raw.threshold);
  return {
    enabled: raw.enabled !== false,
    targets: targets,
    threshold: (isFinite(th) && th >= 1 && th <= 20) ? Math.round(th) : DEFAULT_THRESHOLD,
    note: String(raw.note || '').trim().slice(0, 60),
    updatedAt: String(raw.updatedAt || '')
  };
}

/**
 * 对比当前可动用金融资产与目标配比，计算偏离状态并生成不损息的再平衡建议。
 * @param {object} sum - calc.summarize 的结果
 * @param {object|null} rawCfg - forecast_config.allocation
 * @param {object} [extra] - { dueSoon90: 分, monthlySave: 分 }
 */
function analyze(sum, rawCfg, extra) {
  extra = extra || {};
  const cfg = normalizeConfig(rawCfg);
  const liquid = (sum && sum.liquid) || 0;

  const actualMap = { accrual: 0, market: 0, quantity: 0, balance: 0 };
  ((sum && sum.byLayer && sum.byLayer.liquid) || []).forEach(function (it) {
    const m = it.asset.mode;
    if (actualMap[m] !== undefined) actualMap[m] += (it.val.value || 0);
    else actualMap.balance += (it.val.value || 0);
  });

  if (!cfg || !cfg.enabled) {
    return { configured: false, liquid: liquid, rows: [], balanced: true, maxDrift: null, headline: '', advice: [] };
  }

  const th = cfg.threshold;
  const rows = BUCKETS.map(function (b) {
    const actual = actualMap[b.key] || 0;
    const actualPct = liquid > 0 ? (actual / liquid * 100) : 0;
    const targetPct = cfg.targets[b.key] || 0;
    const targetFen = Math.round(liquid * targetPct / 100);
    const diffPct = actualPct - targetPct;
    const diffFen = actual - targetFen;
    const absPct = Math.abs(diffPct);

    let status = 'ok';
    if (absPct >= th * 2) status = 'alert';
    else if (absPct >= th) status = 'warn';

    const direction = status === 'ok' ? 'ok' : (diffPct > 0 ? 'over' : 'under');

    return {
      key: b.key,
      name: b.name,
      short: b.short,
      tone: b.tone,
      actual: actual,
      actualPct: Math.round(actualPct * 10) / 10,
      targetPct: targetPct,
      targetFen: targetFen,
      diffPct: Math.round(diffPct * 10) / 10,
      absPct: Math.round(absPct * 10) / 10,
      diffFen: diffFen,
      status: status,
      direction: direction
    };
  });

  const drifted = rows.filter(function (r) { return r.status !== 'ok'; })
    .sort(function (a, b) { return b.absPct - a.absPct; });
  const balanced = drifted.length === 0;
  const maxDrift = drifted[0] || null;

  let headline = '';
  if (liquid <= 0) {
    headline = '先录入可动用资产，系统会自动对比配比';
  } else if (balanced) {
    headline = '当前配比均衡，各项均在 ±' + th + '% 容忍区间内';
  } else {
    headline = maxDrift.short + (maxDrift.direction === 'over' ? '高于' : '低于') +
               '目标 ' + maxDrift.absPct.toFixed(1) + '%';
  }

  // 生成「尽量不提前支取存单」的实操建议
  const advice = [];
  if (liquid > 0 && balanced) {
    advice.push('各项资产都在 ±' + th + '% 容忍区间内，不需要频繁折腾，保持每月正常储蓄节奏即可。');
  } else if (liquid > 0) {
    const unders = rows.filter(function (r) { return r.direction === 'under'; })
      .sort(function (a, b) { return a.diffFen - b.diffFen; }); // 负得最多排前面
    const overs = rows.filter(function (r) { return r.direction === 'over'; })
      .sort(function (a, b) { return b.diffFen - a.diffFen; });

    const topUnder = unders[0] || null;
    const cashRow = rows.filter(function (r) { return r.key === 'balance'; })[0];
    const cashExcess = cashRow && cashRow.diffFen > 0 ? cashRow.diffFen : 0;
    const dueSoon90 = extra.dueSoon90 || 0;
    const monthlySave = extra.monthlySave || 0;

    // 1. 若活期明显多出，优先用活期补低配项（零损耗）
    if (cashExcess >= 100000 && topUnder && topUnder.key !== 'balance') {
      const move = Math.min(cashExcess, -topUnder.diffFen);
      advice.push('活期比目标多出 ' + M.cny(cashExcess) + '，可直接转出 ' + M.cny(move) +
                  ' 补进「' + topUnder.name + '」，不损存单利息。');
    }

    // 2. 若股票或黄金大幅超配，提示分批止盈锁定
    overs.forEach(function (ov) {
      if (ov.key === 'market' || ov.key === 'quantity') {
        advice.push('「' + ov.name + '」已超目标 +' + ov.absPct.toFixed(1) + '%（多出 ' + M.cny(ov.diffFen) +
                    '），可考虑分批落袋一部分，转去' + (topUnder ? '补齐「' + topUnder.name + '」' : '存单锁住收益') + '。');
      }
    });

    // 3. 若有低配项，且 90 天内有存单到期 → 顺手用即将到期的存单调仓
    if (topUnder && topUnder.key !== 'accrual' && dueSoon90 > 0) {
      const use = Math.min(dueSoon90, -topUnder.diffFen);
      advice.push('未来 90 天有 ' + M.cny(dueSoon90) + ' 存单到期，到期时拿出 ' + M.cny(use) +
                  ' 补进「' + topUnder.name + '」，其余正常续存，不用提前支取。');
    }

    // 4. 增量再平衡估算（用每月新攒的钱补齐）
    if (topUnder) {
      const stillNeed = Math.max(0, -topUnder.diffFen - (topUnder.key !== 'balance' ? cashExcess : 0));
      if (stillNeed > 0 && monthlySave > 0) {
        const months = Math.max(1, Math.ceil(stillNeed / monthlySave));
        advice.push('不用动未到期存单：按你每月存入 ' + M.cny(monthlySave) + ' 估算，接下来约 ' +
                    months + ' 个月的新增资金优先投向「' + topUnder.name + '」即可回到目标配比。');
      } else if (!advice.length) {
        advice.push('优先用后续新增存款或到期资金补齐「' + topUnder.name + '」（欠配 ' +
                    M.cny(-topUnder.diffFen) + '），尽量避免提前支取未到期存单。');
      }
    }
  }

  // 压力测试：按目标股票占比估算若股市大跌 30% 对家庭总金融资产的冲击
  const eqTarget = cfg.targets.market || 0;
  let stressText = '';
  if (eqTarget > 0) {
    const dropPct = (eqTarget * 0.3).toFixed(1);
    const dropFen = Math.round(liquid * (eqTarget / 100) * 0.3);
    stressText = '按目标股票 ' + eqTarget + '% 测算：若股市大跌 30%，可动用总资产约回撤 ' + dropPct + '%' +
                 (liquid > 0 ? '（约 ' + M.cny(dropFen) + '）' : '') + '。只要能睡得安稳，就是适合你们的仓位。';
  } else {
    stressText = '当前目标股票占比为 0%，几乎不受股市波动影响，重点关注存单利率与通胀变化即可。';
  }

  return {
    configured: true,
    cfg: cfg,
    liquid: liquid,
    rows: rows,
    balanced: balanced,
    maxDrift: maxDrift,
    headline: headline,
    advice: advice,
    stressText: stressText
  };
}

module.exports = {
  BUCKETS: BUCKETS,
  PRESETS: PRESETS,
  DEFAULT_THRESHOLD: DEFAULT_THRESHOLD,
  sumTargets: sumTargets,
  normalizeConfig: normalizeConfig,
  analyze: analyze
};
