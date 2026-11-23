// 每月 10 分钟盘点：分拣「需要核对的项」与「系统自动追踪的项」，并生成月度对比报告。
const calc = require('./calc.js');

const MODE_LABEL = {
  accrual: '大额存单',
  quantity: '实物金条',
  market: '股票账户',
  balance: '活期与余额宝',
  appraisal: '固定资产'
};

function pad(n) { return n < 10 ? '0' + n : String(n); }

function monthKey(d) {
  d = d || new Date();
  return d.getFullYear() + '-' + pad(d.getMonth() + 1);
}

function daysSince(dateVal, now) {
  if (!dateVal) return null;
  let d = null;
  if (typeof dateVal === 'string') {
    d = calc.parseDate(dateVal.slice(0, 10));
    if (!d) {
      const t = new Date(dateVal);
      if (!isNaN(t.getTime())) d = new Date(t.getFullYear(), t.getMonth(), t.getDate());
    }
  } else if (dateVal instanceof Date && !isNaN(dateVal.getTime())) {
    d = new Date(dateVal.getFullYear(), dateVal.getMonth(), dateVal.getDate());
  }
  if (!d) return null;
  return calc.daysBetween(d, now);
}

/**
 * 把全部活跃资产分成两组：
 *   todo: 本月盘点时需要用户看一眼或更新的项（按紧迫度排序）
 *   auto: 系统每天自动算息/抓金价/折旧，无需人工干预的项
 */
function classifyForCheckin(sum, now, plans) {
  now = now || calc.startOfToday();
  const planMap = {};
  (plans || []).forEach(function (p) { if (p && p.id) planMap[p.id] = p; });
  const todo = [];
  const auto = [];

  (sum.items || []).forEach(function (it) {
    const a = it.asset;
    const v = it.val;
    const updatedDays = daysSince(a.valueUpdatedAt || a.updatedAt || a.appraiseDate, now);

    // 1. 临期/已到期存单（可动用层，30 天内到期；已设自动转存或自动结清的静默归入自动追踪）
    if (a.mode === 'accrual' && a.layer === 'liquid' && v.daysToDue !== null && v.daysToDue <= 30) {
      const pl = a.planId ? planMap[a.planId] : null;
      const autoAction = a.autoRenew ? 'renew' : (pl && pl.onMature) || 'manual';
      if (autoAction !== 'manual') {
        auto.push({
          asset: a,
          val: v,
          autoNote: autoAction === 'close' ? '到期自动结清' : '到期自动转存'
        });
        return;
      }
      todo.push({
        priority: 1,
        kind: 'due_cd',
        asset: a,
        val: v,
        updatedDays: updatedDays,
        reason: v.daysToDue < 0 ? ('已到期 ' + (-v.daysToDue) + ' 天，记得处理或转存')
                                : ('还有 ' + v.daysToDue + ' 天到期，提前看一眼')
      });
      return;
    }

    // 2. 余额型（支付宝、余额宝、活期等）
    if (a.mode === 'balance') {
      todo.push({
        priority: 2,
        kind: 'balance',
        asset: a,
        val: v,
        updatedDays: updatedDays,
        reason: updatedDays === null ? '核对当前余额'
              : (updatedDays === 0 ? '今天刚更新过' : updatedDays + ' 天前更新')
      });
      return;
    }

    // 3. 市值型（证券账户）
    if (a.mode === 'market') {
      const hasHold = Array.isArray(a.holdings) && a.holdings.length > 0;
      todo.push({
        priority: hasHold ? 4 : 3,
        kind: hasHold ? 'market_hold' : 'market_shot',
        asset: a,
        val: v,
        updatedDays: updatedDays,
        reason: hasHold
          ? (a.holdings.length + ' 只持仓自动跟收盘价 · 确认近期有无买卖或转账')
          : (updatedDays === null ? '截图更新最新总资产'
            : (updatedDays === 0 ? '今天刚更新过' : updatedDays + ' 天前截图'))
      });
      return;
    }

    // 4. 简单负债（没有固定期数的欠款，每月顺手核一下余额）
    if (a.mode === 'loan' && !(a.remainingMonths > 0)) {
      todo.push({
        priority: 4,
        kind: 'loan_simple',
        asset: a,
        val: v,
        updatedDays: updatedDays,
        reason: updatedDays === null ? '核对当前剩余欠款'
              : (updatedDays === 0 ? '今天刚更新过' : updatedDays + ' 天前更新')
      });
      return;
    }

    // 5. 超过 180 天未更新的手动估值固定资产（如房子）
    if (a.mode === 'appraisal' && !(a.depreciationRate > 0) && v.staleDays !== null && v.staleDays > 180) {
      todo.push({
        priority: 5,
        kind: 'appraisal',
        asset: a,
        val: v,
        updatedDays: v.staleDays,
        reason: v.staleDays + ' 天前估值，可按需微调'
      });
      return;
    }

    // 其余全部由系统自动追踪
    let autoNote = '系统自动追踪';
    if (a.mode === 'accrual' && a.layer === 'liquid') autoNote = '每日自动计息';
    else if (a.mode === 'accrual' && a.layer === 'receivable') autoNote = '外债按约计息';
    else if (a.mode === 'quantity') autoNote = '每日自动更新金价';
    else if (a.mode === 'loan') autoNote = '按月自动递减剩余本金';
    else if (a.mode === 'appraisal' && a.depreciationRate > 0) autoNote = '按折旧率自动计算';
    else if (a.mode === 'appraisal') autoNote = '近期已估值';

    auto.push({ asset: a, val: v, autoNote: autoNote });
  });

  todo.sort(function (x, y) {
    if (x.priority !== y.priority) return x.priority - y.priority;
    return (y.val.value || 0) - (x.val.value || 0);
  });

  return { todo: todo, auto: auto };
}

/**
 * 从历史快照里挑出「上月对照基准」：
 *   找到早于 currentMonth 的最近一个月份，优先取该月标记 checkin=true 的记录，否则取该月最后一天。
 */
function pickPrevSnapshot(snapshots, currentMonth) {
  const earlier = (snapshots || []).filter(function (s) {
    const m = s.checkinMonth || (s.date ? s.date.slice(0, 7) : '');
    return m && m < currentMonth;
  });
  if (!earlier.length) return null;

  // 按月份分组，取最新的那个历史月份
  const byMonth = {};
  earlier.forEach(function (s) {
    const m = s.checkinMonth || s.date.slice(0, 7);
    if (!byMonth[m]) byMonth[m] = [];
    byMonth[m].push(s);
  });
  const months = Object.keys(byMonth).sort();
  const prevMonth = months[months.length - 1];
  const list = byMonth[prevMonth].slice().sort(function (a, b) {
    return (a.date || '') < (b.date || '') ? -1 : 1;
  });
  const checkins = list.filter(function (s) { return !!s.checkin; });
  return checkins.length ? checkins[checkins.length - 1] : list[list.length - 1];
}

/**
 * 生成月度盘点报告 + 近 6 个月趋势条数据
 */
function buildReport(currentSnap, prevSnap, allSnapshots) {
  const curLiquid = (currentSnap && currentSnap.liquid) || 0;
  const curNet = (currentSnap && currentSnap.net) || 0;
  const curDebt = (currentSnap && currentSnap.liability) || 0;
  const curMonth = (currentSnap && (currentSnap.checkinMonth || (currentSnap.date || '').slice(0, 7))) || '';

  const hasPrev = !!prevSnap;
  const prevLiquid = hasPrev ? (prevSnap.liquid || 0) : null;
  const prevNet = hasPrev ? (prevSnap.net || 0) : null;
  const prevDebt = hasPrev ? (prevSnap.liability || 0) : null;
  const deltaLiquid = hasPrev ? (curLiquid - prevLiquid) : null;
  const deltaNet = hasPrev ? (curNet - prevNet) : null;
  const deltaDebt = hasPrev ? (curDebt - prevDebt) : null;
  const deltaLiquidPct = (hasPrev && prevLiquid > 0) ? (deltaLiquid / prevLiquid * 100) : null;

  // 分资产类型增减
  const curModes = (currentSnap && currentSnap.byMode) || {};
  const prevModes = (prevSnap && prevSnap.byMode) || {};
  const modeKeys = ['accrual', 'market', 'quantity', 'balance'];
  const byModeDiff = [];
  modeKeys.forEach(function (k) {
    const cv = curModes[k] || 0;
    const pv = hasPrev ? (prevModes[k] || 0) : null;
    if (cv === 0 && (!hasPrev || pv === 0)) return;
    byModeDiff.push({
      mode: k,
      name: MODE_LABEL[k] || k,
      value: cv,
      delta: hasPrev ? (cv - pv) : null
    });
  });
  byModeDiff.sort(function (a, b) { return b.value - a.value; });

  // 按月聚合最近 6 个月的走势条（含本月）
  const monthMap = {};
  (allSnapshots || []).forEach(function (s) {
    if (!s || !s.date) return;
    const m = s.checkinMonth || s.date.slice(0, 7);
    const old = monthMap[m];
    if (!old || (s.checkin && !old.checkin) || s.date >= old.date) {
      monthMap[m] = s;
    }
  });
  if (currentSnap && curMonth) monthMap[curMonth] = currentSnap;

  const months = Object.keys(monthMap).sort().slice(-6);
  const maxLiquid = months.reduce(function (mx, m) {
    return Math.max(mx, monthMap[m].liquid || 0);
  }, 0);

  const monthlyBars = months.map(function (m) {
    const s = monthMap[m];
    const v = s.liquid || 0;
    const pct = maxLiquid > 0 ? Math.max(12, Math.round(v / maxLiquid * 100)) : 12;
    return {
      month: m,
      shortMonth: Number(m.slice(5)) + '月',
      liquid: v,
      net: s.net || 0,
      pct: pct,
      isCurrent: m === curMonth,
      isCheckin: !!s.checkin
    };
  });

  return {
    month: curMonth,
    date: (currentSnap && currentSnap.date) || '',
    liquid: curLiquid,
    net: curNet,
    liability: curDebt,
    prevMonth: prevSnap ? (prevSnap.checkinMonth || (prevSnap.date || '').slice(0, 7)) : '',
    prevLiquid: prevLiquid,
    prevNet: prevNet,
    prevLiability: prevDebt,
    deltaLiquid: deltaLiquid,
    deltaNet: deltaNet,
    deltaLiability: deltaDebt,
    deltaLiquidPct: deltaLiquidPct,
    byModeDiff: byModeDiff,
    monthlyBars: monthlyBars,
    note: (currentSnap && currentSnap.checkinNote) || ''
  };
}

module.exports = {
  monthKey: monthKey,
  classifyForCheckin: classifyForCheckin,
  pickPrevSnapshot: pickPrevSnapshot,
  buildReport: buildReport,
  MODE_LABEL: MODE_LABEL
};
