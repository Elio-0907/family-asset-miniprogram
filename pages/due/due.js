const load = require('../../utils/load.js');
const calc = require('../../utils/calc.js');
const M = require('../../utils/money.js');
const R = require('../../utils/recurring.js');

Page({
  data: { loaded: false },

  onShow() {
    try { this.setData({ masked: !!wx.getStorageSync('masked') }); } catch (e) { /* ignore */ }
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({ selected: 1 });
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
    const items = calc.dueItems(d.assets, d.ctx, {});
    const now = d.ctx.now;

    // A. 按半年分格
    const half = function (d) { return d.getFullYear() + (d.getMonth() < 6 ? 'H1' : 'H2'); };
    const halfLabel = function (k) { return k.slice(2, 4) + (k.endsWith('H1') ? '上' : '下'); };
    const nextHalf = function (k) {
      const y = Number(k.slice(0, 4));
      return k.endsWith('H1') ? y + 'H2' : (y + 1) + 'H1';
    };
    const nowKey = half(now);
    let lastKey = nowKey;
    for (let q = 0; q < 5; q++) lastKey = nextHalf(lastKey);   // 至少铺 3 年
    const map = {};
    let hasOverdue = false;
    items.forEach(function (i) {
      const p = i.asset.principal || i.val.value;
      let k;
      if (i.overdue) { k = 'OVER'; hasOverdue = true; }
      else {
        k = half(calc.parseDate(i.asset.maturityDate));
        while (k > lastKey) lastKey = nextHalf(lastKey);
      }
      if (!map[k]) map[k] = { cd: 0, rc: 0 };
      if (i.asset.layer === 'receivable') map[k].rc += p; else map[k].cd += p;
    });
    const keys = [];
    if (hasOverdue) keys.push('OVER');
    for (let k = nowKey; ; k = nextHalf(k)) { keys.push(k); if (k === lastKey) break; }
    let maxSum = 1, topKey = '';
    keys.forEach(function (k) {
      const v = map[k] || { cd: 0, rc: 0 };
      if (v.cd + v.rc > maxSum) { maxSum = v.cd + v.rc; topKey = k; }
    });
    const buckets = keys.map(function (k) {
      const v = map[k] || { cd: 0, rc: 0 };
      const sum = v.cd + v.rc;
      return {
        key: k === 'OVER' ? '已过' : halfLabel(k),
        label: sum ? M.wan(sum) : '',
        cdPct: v.cd / maxSum * 100, rcPct: v.rc / maxSum * 100,
        top: k === topKey && sum > 0, now: k === nowKey
      };
    });

    // B. 梯子：从最早起息日到最晚到期日
    let t0 = now.getTime(), t1 = now.getTime() + 365 * 86400000;
    items.forEach(function (i) {
      const s0 = calc.parseDate(i.asset.startDate), s1 = calc.parseDate(i.asset.maturityDate);
      if (s0 && s0.getTime() < t0) t0 = s0.getTime();
      if (s1 && s1.getTime() > t1) t1 = s1.getTime();
    });
    const span = Math.max(1, t1 - t0);
    const px = function (t) { return Math.max(0, Math.min(100, (t - t0) / span * 100)); };
    const todayPct = px(now.getTime());
    const termOf = function (a) {
      const s0 = calc.parseDate(a.startDate), s1 = calc.parseDate(a.maturityDate);
      const days = s0 && s1 ? Math.round((s1 - s0) / 86400000) : 365;
      return days >= 360 ? Math.round(days / 365) + '年' : Math.round(days / 30) + '个月';
    };
    // 同一个「每月存单」计划的合成一条：从第一张起息到最后一张到期，条上打刻度标每张到期点
    const planGroups = {};
    const ladder = [];
    items.forEach(function (i) {
      const a = i.asset;
      const s0 = calc.parseDate(a.startDate) || now, s1 = calc.parseDate(a.maturityDate) || now;
      if (a.planId) {
        let g = planGroups[a.planId];
        if (!g) {
          g = planGroups[a.planId] = { plan: true, id: 'plan:' + a.planId, tone: 'cd',
                name: a.institution || a.name, termBase: termOf(a), rate: a.rate ? a.rate.toFixed(2) + '%' : '',
                t0: s0.getTime(), t1: s1.getTime(), count: 0, mats: [] };
          ladder.push(g);
        }
        g.count++;
        if (s0.getTime() < g.t0) g.t0 = s0.getTime();
        if (s1.getTime() > g.t1) g.t1 = s1.getTime();
        g.mats.push(s1.getTime());
        return;
      }
      const total = Math.max(1, s1.getTime() - s0.getTime());
      const done = Math.max(0, Math.min(1, (now.getTime() - s0.getTime()) / total));
      ladder.push({
        id: a._id, tone: a.layer === 'receivable' ? 'rc' : 'cd',
        name: a.layer === 'receivable' ? (a.debtor || a.name) : (a.institution || a.name),
        term: termOf(a), rate: a.rate ? a.rate.toFixed(2) + '%' : '',
        x0: px(s0.getTime()), w: Math.max(1.5, px(s1.getTime()) - px(s0.getTime())),
        donePct: done * 100, notches: []
      });
    });
    Object.keys(planGroups).forEach(function (k) {
      const g = planGroups[k];
      const x0 = px(g.t0), w = Math.max(1.5, px(g.t1) - x0);
      g.term = g.termBase + ' × ' + g.count;
      g.x0 = x0; g.w = w;
      g.donePct = Math.max(0, Math.min(100, (now.getTime() - g.t0) / Math.max(1, g.t1 - g.t0) * 100));
      g.notches = g.mats.map(function (t) { return Math.max(0, Math.min(100, (px(t) - x0) / w * 100)); });
    });
    ladder.sort(function (a, b) { return a.x0 - b.x0; });
    const axisTicks = [{ label: '今天', x: todayPct, today: true }];
    const y0 = now.getFullYear();
    for (let k = 1; k <= 6; k++) {
      const jan = new Date(y0 + k, 0, 1).getTime();
      if (jan > t1) break;
      if (Math.abs(px(jan) - todayPct) > 8) axisTicks.push({ label: String(y0 + k), x: px(jan) });
    }

    // 分组：已过约定日 / 各年份
    const groupMap = {};
    const order = [];
    items.forEach(function (i) {
      const a = i.asset;
      const title = i.overdue ? '已过约定日' : String(calc.parseDate(a.maturityDate).getFullYear()) + ' 年';
      if (!groupMap[title]) { groupMap[title] = []; order.push(title); }
      let cls = 'flat', days;
      if (i.overdue) { cls = 'od'; days = '已过 ' + (-i.days) + ' 天'; }
      else if (i.days <= 30) { cls = 'warnc'; days = i.days + ' 天'; }
      else { days = i.days + ' 天'; }
      groupMap[title].push({
        id: a._id, tone: load.tone(a), planId: a.planId || '',
        name: a.layer === 'receivable' ? (a.debtor || a.name) + ' 借款'
                                       : (a.institution ? a.institution + ' · ' + a.name : a.name),
        sub: a.maturityDate + (a.rate ? ' · ' + a.rate.toFixed(2) + '%' : ' · 无息') +
             (i.val.atMaturity ? ' · 到期本息 ' + M.cny(i.val.atMaturity) : ''),
        rawValue: i.val.value || 0,
        value: M.cny(i.val.value), days: days, cls: cls
      });
    });
    const groups = order.map(function (t) {
      // 同一计划的存单在这一年里合成一行，默认收起
      const rows = [], byPlan = {};
      groupMap[t].forEach(function (r) {
        if (!r.planId) { rows.push(r); return; }
        let g = byPlan[r.planId];
        if (!g) {
          g = byPlan[r.planId] = { id: 'plan:' + r.planId + ':' + t, group: true, expanded: false,
                                   tone: r.tone, name: '', children: [], first: r, count: 0, totalVal: 0 };
          rows.push(g);
        }
        g.children.push(r); g.count++; g.totalVal += (r.rawValue || 0);
      });
      rows.forEach(function (g) {
        if (!g.group) return;
        const f = g.first;
        g.name = f.name + ' × ' + g.count;
        g.sub = g.children[0].sub.split(' · ')[0] + ' ~ ' + g.children[g.count - 1].sub.split(' · ')[0] + ' 到期';
        g.days = g.children[0].days;
        g.cls = g.children[0].cls;
        g.value = M.cny(g.totalVal);
      });
      return { title: t, items: rows };
    });

    const me = getApp().globalData.me || {};
    const plans = (me.plans || []).map(function (p) {
      const nx = R.nextRun(p, now);
      return { id: p.id, day: p.day || 1, institution: p.institution || '',
               termLabel: R.TERM_LABEL[p.termMonths] || (p.termMonths + '个月'),
               amountText: M.cny(p.amount), rateText: (p.rate || 0).toFixed(2) + '%',
               next: nx.start.slice(5) };
    });

    this.setData({
      loaded: true, groups: groups, plans: plans,
      buckets: buckets, ladder: ladder, todayPct: todayPct, axisTicks: axisTicks,
      insight: this.buildInsight(items)
    });
  },

  /** 找出「钱挤在同一段时间到期」这件事 —— 这张图存在的唯一理由 */
  buildInsight(items) {
    const cds = items.filter(function (i) {
      return i.asset.layer === 'liquid' && !i.overdue && !i.asset.planId;   // 每月存单本来就是错开的，不算
    });
    if (cds.length < 2) return '';
    const total = cds.reduce(function (s, i) { return s + (i.asset.principal || 0); }, 0);
    if (!total) return '';

    const half = {};
    cds.forEach(function (i) {
      const d = calc.parseDate(i.asset.maturityDate);
      const key = d.getFullYear() + (d.getMonth() < 6 ? ' 上半年' : ' 下半年');
      half[key] = (half[key] || 0) + (i.asset.principal || 0);
    });
    let topKey = '', topVal = 0;
    Object.keys(half).forEach(function (k) { if (half[k] > topVal) { topVal = half[k]; topKey = k; } });

    const pct = topVal / total * 100;
    if (pct < 50) return '';
    return topKey + '有 ' + M.wan(topVal) + '集中到期，占存单总额的 ' +
           Math.round(pct) + '%。届时若正逢降息，这笔钱只能一起接受低利率——' +
           '可以考虑把其中一笔换成更长的期限错开。';
  },

  openDetail(e) {
    const id = String(e.currentTarget.dataset.id || '');
    if (id.indexOf('plan:') === 0) {
      if (e.currentTarget.dataset.g !== undefined) {
        // 列表里的合并行：点一下展开/收起
        const gi = Number(e.currentTarget.dataset.g), ri = Number(e.currentTarget.dataset.r);
        const key = 'groups[' + gi + '].items[' + ri + '].expanded';
        this.setData({ [key]: !this.data.groups[gi].items[ri].expanded });
      } else {
        wx.navigateTo({ url: '/pages/edit/edit?plan=' + id.split(':')[1] });   // 梯子里的合并条 → 计划页
      }
      return;
    }
    wx.navigateTo({ url: '/pages/edit/edit?id=' + id });
  }
});
