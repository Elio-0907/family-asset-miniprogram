const load = require('../../utils/load.js');
const calc = require('../../utils/calc.js');
const M = require('../../utils/money.js');

const TITLES = {
  liquid: '第一层 · 可动用',
  receivable: '第二层 · 应收外债',
  fixed: '第三层 · 固定资产',
  liability: '第四层 · 负债（减项）'
};
const CONF = { high: '把握 高', mid: '把握 中', low: '把握 低' };
const REPAY_NAME = { equalPayment: '等额本息', equalPrincipal: '等额本金', interestOnly: '先息后本' };

Page({
  data: { loaded: false },

  onShow() {
    try { this.setData({ masked: !!wx.getStorageSync('masked') }); } catch (e) { /* ignore */ }
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({ selected: 2 });
    }
    this.refresh();
  },

  onPullDownRefresh() {
    this.refresh(true).then(function () { wx.stopPullDownRefresh(); });
  },

  refresh(force) {
    const self = this;
    return load.loadAll(force).then(function (d) { self.render(d); })
      .catch(function (e) { console.error(e); self.render(load.build([], {})); });
  },

  render(d) {
    const sum = d.sum, prices = d.prices;
    const self = this;
    const layers = ['liquid', 'receivable', 'fixed', 'liability'].map(function (key) {
      return {
        key: key,
        title: TITLES[key],
        total: key === 'liability' ? ('−' + M.cny(sum.liability)) : M.cny(sum[key]),
        rows: load.groupByPlan(sum.byLayer[key] || []).map(function (it) { return self.toRow(it, prices); })
      };
    });
    this.setData({
      loaded: true, layers: layers, netCny: M.cny(sum.net),
      hasAny: sum.items.length > 0
    });
  },

  toRow(it, prices) {
    if (it.group) {
      const a = it.asset;
      return {
        id: 'plan:' + it.planId, tone: load.tone(a),
        name: (a.institution ? a.institution + ' · ' : '') + a.name + ' × ' + it.count,
        sub: '每月自动开单 · ' + (a.rate ? a.rate.toFixed(2) + '%' : '') + (it.earliest ? ' · 最近 ' + it.earliest : ''),
        value: M.cny(it.value),
        delta: it.earliestDays === null ? '' : (it.earliestDays >= 0 ? it.earliestDays + ' 天后' : '已到期'),
        cls: (it.earliestDays !== null && it.earliestDays >= 0 && it.earliestDays <= 30) ? 'warnc' : 'flat'
      };
    }
    const a = it.asset, v = it.val;
    let sub = '', delta = '', cls = 'flat';

    if (a.mode === 'accrual') {
      sub = (a.rate ? a.rate.toFixed(2) + '%' : '无息') + ' · ' + (a.maturityDate || '');
      if (a.layer === 'receivable') {
        sub = (CONF[a.confidence] || '') + (a.evidence ? ' · ' + a.evidence : '') +
              (a.rate ? ' · 年息 ' + a.rate.toFixed(2) + '%' : ' · 无息');
      }
      if (v.daysToDue !== null) {
        if (v.daysToDue < 0) { delta = '已过 ' + (-v.daysToDue) + ' 天'; cls = 'od'; }
        else if (v.daysToDue <= 30) { delta = v.daysToDue + ' 天后'; cls = 'warnc'; }
        else { delta = a.maturityDate; }
      }
    } else if (a.mode === 'quantity') {
      const p = prices[a.priceKey];
      const cp = a.costPrice || (a.costTotal && a.quantity ? Math.round(a.costTotal / a.quantity) : 0);
      sub = (a.quantity || 0) + (a.unit || 'g') +
            (cp ? ' · 成本 ¥' + (cp / 100).toFixed(0) + '/g' : '') +
            (p ? ' · 现价 ¥' + (p / 100).toFixed(0) + '/g' : ' · 金价待更新');
      if (v.gainPct !== null) { delta = M.pct(v.gainPct, 1); cls = v.gain >= 0 ? 'up' : 'down'; }
    } else if (a.mode === 'market') {
      const n = (a.holdings || []).length;
      sub = (n ? n + ' 只持仓 · ' : '') + (a.totalCost ? '成本 ' + M.cny(a.totalCost) : '') +
            (a.valueUpdatedAt ? ' · ' + a.valueUpdatedAt.slice(5) : '');
      sub = sub.replace(/^ · /, '').replace(/ · $/, '');
      if (v.gainPct !== null) { delta = M.pct(v.gainPct, 1); cls = v.gain >= 0 ? 'up' : 'down'; }
    } else if (a.mode === 'balance') {
      sub = a.refRate ? '七日年化 ' + a.refRate.toFixed(2) + '%' : '活期';
      if (a.recurring && a.recurring.amount) sub = '每月 ' + (a.recurring.day || 1) + ' 日 +' + M.cny(a.recurring.amount) + ' · ' + sub;
      delta = '活期';
    } else if (a.mode === 'appraisal') {
      if (a.depreciationRate > 0) {
        sub = (a.purchaseDate || '') + ' 购入 ' + M.cny(a.purchasePrice) + ' · 自动折旧';
        if (v.gainPct !== null) { delta = M.pct(v.gainPct, 1); cls = 'down'; }
      } else {
        sub = '估值于 ' + (a.appraiseDate || '—');
        if (v.staleDays !== null && v.staleDays > 180) { delta = '该更新了'; cls = 'warnc'; }
      }
    } else if (a.mode === 'loan') {
      const parts = [];
      if (a.rate) parts.push(a.rate.toFixed(2) + '%');
      if (a.remainingMonths > 0) {
        parts.push(REPAY_NAME[a.repayMethod] || '等额本息');
        parts.push(v.remainingMonths > 0 ? ('剩 ' + v.remainingMonths + ' 期') : '已还清');
      } else {
        parts.push('手动维护');
      }
      sub = parts.join(' · ');
      if (v.monthlyPayment > 0) delta = '月供 ' + M.cny(v.monthlyPayment);
    }

    let name = a.name;
    if (a.layer === 'receivable') name = a.debtor || a.name;
    else if (a.institution) name = a.institution + ' · ' + a.name;

    return {
      id: a._id, tone: load.tone(a), name: name, sub: sub,
      value: a.mode === 'loan' ? ('−' + M.cny(v.value)) : M.cny(v.value), delta: delta, cls: cls
    };
  },

  openDetail(e) {
    const id = String(e.currentTarget.dataset.id || '');
    if (id.indexOf('plan:') === 0) { wx.navigateTo({ url: '/pages/edit/edit?plan=' + id.slice(5) }); return; }
    wx.navigateTo({ url: '/pages/edit/edit?id=' + id });
  },
  add() { wx.navigateTo({ url: '/pages/edit/edit' }); }
});
