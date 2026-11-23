const load = require('../../utils/load.js');
const F = require('../../utils/forecast.js');
const db = require('../../utils/db.js');
const M = require('../../utils/money.js');
const calc = require('../../utils/calc.js');

const DEFAULT_GOAL = { name: '家庭退休计划', amount: 500000000, metric: 'liquid' };   // 分

// canvas 拿不到 CSS 变量，配色单列一份
const PALETTE = {
  light: { c1: '#E4E8E2', c1s: '#A9B2AC', c3: '#EBDFC3', c3s: '#C8AE78',
           c2: '#F6F0E3', c2s: '#B89A5E', line: '#ECEDE8', text3: '#9BA39E', text: '#1A2420', goal: '#B89A5E' },
  dark:  { c1: '#2A322D', c1s: '#6E7873', c3: '#3A3222', c3s: '#A08A58',
           c2: '#2B2415', c2s: '#C6A464', line: '#2B3430', text3: '#6E7873', text: '#E5E9E2', goal: '#C6A464' }
};
function theme() {
  try { const i = wx.getAppBaseInfo ? wx.getAppBaseInfo() : wx.getSystemInfoSync(); return i.theme === 'dark' ? 'dark' : 'light'; }
  catch (e) { return 'light'; }
}

Page({
  data: { loaded: false, adding: false, newOut: { name: '', date: '', amount: '' }, cfgView: {},
          goal: DEFAULT_GOAL, milestones: [] },

  onShow() {
    try { this.setData({ masked: !!wx.getStorageSync('masked') }); } catch (e) { /* ignore */ }
    if (typeof this.getTabBar === 'function' && this.getTabBar()) this.getTabBar().setData({ selected: 3 });
    this.refresh();
  },
  onPullDownRefresh() { this.refresh(true).then(function () { wx.stopPullDownRefresh(); }); },

  refresh(force) {
    const self = this;
    return Promise.all([load.loadAll(force), db.getConfig(), db.listSnapshots(3650)])
      .then(function (r) {
        self.d = r[0];
        const saved = r[1] || {};
        self.snaps = r[2] || [];
        self.cfg = Object.assign({}, F.DEFAULT_CFG);
        ['monthly', 'annual', 'rate', 'eqGrowth', 'recoverReceivable', 'outflows'].forEach(function (k) {
          if (saved[k] !== undefined) self.cfg[k] = saved[k];
        });
        self.cfg.goldGrowth = 0;                                   // 黄金不做假设
        if (!Array.isArray(self.cfg.outflows)) self.cfg.outflows = [];
        self.goal = Object.assign({}, DEFAULT_GOAL, saved.goal || {});
        self.setData({ goal: self.goal });
        self.compute();
        if (!saved.goal) self.save();     // 第一次打开就把目标存下来，首页那行才会出现
      })
      .catch(function (e) { console.error(e); self.setData({ loaded: true }); });
  },

  compute() {
    const d = this.d, cfg = this.cfg, goal = this.goal;
    const now = d.ctx.now;
    const liquid = d.sum.liquid;
    const r = F.reachGoal(d.assets, cfg, d.ctx, goal.amount, 480);

    // 到目标那一天的构成
    let p = null, goalTotalText = '', summary = '';
    if (r.months !== null) {
      p = r.series[Math.min(r.series.length - 1, Math.ceil(r.months))];
      goalTotalText = M.cny(p.total);
      const yrs = F.spanText(now, r.date);
      summary = '从现在到那天的 ' + yrs.text + '里，你会存入 ' + M.cny(p.gin) +
                (p.gout ? '、计划支出 ' + M.cny(p.gout) : '') + '，利息与收益合计 ' + M.cny(p.assumed) + '。' +
                (p.assumed > 1 && p.gin / p.assumed > 1
                  ? '存进去的是赚到的 ' + (p.gin / p.assumed).toFixed(1) + ' 倍——决定那一天早晚的，主要是存钱本身。'
                  : '');
    }

    // 里程碑：每 100 万一个，走过的从快照里找日期，没走的用预测
    const step = 10000000 * Math.max(1, Math.round(goal.amount / 50000000));  // 500万→每100万；更大目标按比例
    const milestones = [];
    const snaps = this.snaps;
    for (let a = step; a <= goal.amount; a += step) {
      const done = liquid >= a;
      let when = '';
      if (done) {
        const hit = snaps.filter(function (s) { return (s.liquid || 0) >= a; })[0];
        when = hit ? (snaps[0] && snaps[0]._id === hit._id ? '已达成' : hit.date.slice(0, 7).replace('-', '.')) : '已达成';
      } else if (r.months !== null) {
        const idx = r.series.findIndex(function (x) { return x.total >= a; });
        if (idx > 0) {
          const dd = new Date(now.getFullYear(), now.getMonth() + idx, 1);
          when = '预计 ' + dd.getFullYear() + '.' + (dd.getMonth() + 1 < 10 ? '0' : '') + (dd.getMonth() + 1);
        }
      }
      milestones.push({ amount: a, label: M.wan(a), done: done, when: when });
    }

    const eqNow = d.sum.byLayer.liquid.filter(function (i) { return i.asset.mode === 'market'; })
      .reduce(function (s, i) { return s + i.val.value; }, 0);
    const cdRates = d.sum.byLayer.liquid
      .filter(function (i) { return i.asset.mode === 'accrual' && i.asset.rate > 0; })
      .map(function (i) { return i.asset.rate; })
      .sort(function (a, b) { return a - b; });
    let rateNote = '到期后新存单的预期年利率，默认按 1.5% 保守估';
    if (cdRates.length) {
      const lo = cdRates[0], hi = cdRates[cdRates.length - 1];
      rateNote = Math.abs(hi - lo) >= 0.05
        ? ('你现有存单 ' + hi.toFixed(2) + '% ～ ' + lo.toFixed(2) + '%，加权 ' + d.sum.weightedRate.toFixed(2) + '%，默认按 1.5% 保守估')
        : ('你现有存单利率 ' + hi.toFixed(2) + '%，默认按 1.5% 保守估');
    }

    const gd = r.date ? calc.parseDate(r.date) : null;
    this.setData({
      loaded: true,
      liquidText: M.cny(liquid),
      goalAmountText: M.wan(goal.amount),
      goalPct: Math.min(100, liquid / goal.amount * 100).toFixed(1),
      goalDateText: gd ? gd.getFullYear() + ' 年 ' + (gd.getMonth() + 1) + ' 月' : '',
      goalLeft: r.months === null || r.reached ? '' : F.spanText(now, r.date).text,
      milestones: milestones,
      goalTotalText: goalTotalText,
      lockedText: p ? M.cny(r.base + p.locked) : '',
      contribText: p ? M.cny(p.contrib + p.recovered) : '',
      assumedText: p ? M.cny(p.assumed) : '',
      aIntText: p ? M.cny(p.aInt) : '',
      aMktText: p ? M.cny(p.aMkt) : '',
      summary: summary,
      hotRate: cfg.rate > 3.2,
      rateNote: rateNote,
      monthlyDebtText: d.sum.monthlyDebt > 0 ? M.cny(d.sum.monthlyDebt) : '',
      hotEq: cfg.eqGrowth >= 10,
      eqNote: eqNow ? '现在股票 ' + M.cny(eqNow) + (cfg.eqGrowth >= 10 ? ' · 连续多年年化 ' + cfg.eqGrowth.toFixed(1) + '% 是很强的假设' : ' · 不知道会怎么走，默认 0')
                    : '还没记股票账户',
      hasReceivable: d.sum.byLayer.receivable.length > 0,
      recoverReceivable: !!cfg.recoverReceivable,
      cfgView: {
        monthly: M.group(Math.round(cfg.monthly / 100)), monthlyRaw: Math.round(cfg.monthly / 100),
        annual: M.group(Math.round(cfg.annual / 100)), annualRaw: Math.round(cfg.annual / 100),
        rate: cfg.rate.toFixed(2), rateRaw: Math.round(cfg.rate * 100),
        eq: cfg.eqGrowth.toFixed(1), eqRaw: Math.round(cfg.eqGrowth * 100)
      },
      outflowsView: cfg.outflows.map(function (o) { return { name: o.name, sub: o.date, amount: M.cny(o.amount), on: o.on !== false }; }),
      outTotal: '−' + M.cny(cfg.outflows.reduce(function (s, o) { return s + (o.on !== false ? o.amount : 0); }, 0))
    });

    this.draw(r, goal.amount);
  },

  /** 画到目标那年为止（至少 5 年、最多 30 年），一条虚线标目标 */
  draw(r, target) {
    const self = this;
    const years = Math.min(30, Math.max(5, r.months === null ? 30 : Math.ceil(r.months / 12) + 1));
    const yearly = F.simulate(this.d.assets, this.cfg, this.d.ctx, years * 12, 12);
    wx.createSelectorQuery().in(this).select('#fc').fields({ node: true, size: true }).exec(function (q) {
      if (!q || !q[0] || !q[0].node) return;
      const cv = q[0].node, ctx = cv.getContext('2d');
      const dpr = (wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()).pixelRatio || 2;
      const W = q[0].width, H = q[0].height;
      cv.width = W * dpr; cv.height = H * dpr; ctx.scale(dpr, dpr); ctx.clearRect(0, 0, W, H);
      const P = PALETTE[theme()];
      const x0 = 38, x1 = W - 10, y0 = 14, y1 = H - 30, N = years;
      const a = [], b = [], c = [];
      let max = target;
      for (let i = 0; i <= N; i++) {
        const p = yearly.series[i];
        const A = yearly.base + p.locked, B = A + p.contrib + p.recovered, C = B + p.assumed;
        a.push(A); b.push(B); c.push(C); if (C > max) max = C;
      }
      max = Math.ceil(max * 1.08 / 50000000) * 50000000;
      const X = function (i) { return x0 + (x1 - x0) * i / N; };
      const Y = function (v) { return y1 - (y1 - y0) * (v / max); };

      ctx.strokeStyle = P.line; ctx.lineWidth = 1;
      [0.25, 0.5, 0.75].forEach(function (f) { ctx.beginPath(); ctx.moveTo(x0, Y(max * f)); ctx.lineTo(x1, Y(max * f)); ctx.stroke(); });

      const band = function (top, bot, fill, stroke, dashed) {
        ctx.beginPath(); ctx.moveTo(X(0), Y(top[0]));
        for (let i = 1; i <= N; i++) ctx.lineTo(X(i), Y(top[i]));
        for (let i = N; i >= 0; i--) ctx.lineTo(X(i), bot ? Y(bot[i]) : y1);
        ctx.closePath(); ctx.fillStyle = fill; ctx.fill();
        ctx.beginPath(); ctx.moveTo(X(0), Y(top[0]));
        for (let i = 1; i <= N; i++) ctx.lineTo(X(i), Y(top[i]));
        ctx.setLineDash(dashed ? [4, 3] : []); ctx.strokeStyle = stroke; ctx.lineWidth = dashed ? 1.5 : 1.2; ctx.stroke(); ctx.setLineDash([]);
      };
      band(a, null, P.c1, P.c1s, false);
      band(b, a, P.c3, P.c3s, false);
      band(c, b, P.c2, P.c2s, true);

      // 目标线
      ctx.setLineDash([6, 4]); ctx.strokeStyle = P.goal; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(x0, Y(target)); ctx.lineTo(x1, Y(target)); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = P.goal; ctx.font = '10px sans-serif'; ctx.textAlign = 'right';
      ctx.fillText(self.data.goal.name + ' ' + M.wan(target), x1 - 2, Y(target) - 5);

      // 到达点
      if (r.months !== null && r.months / 12 <= N) {
        const gx = x0 + (x1 - x0) * (r.months / 12) / N;
        ctx.beginPath(); ctx.arc(gx, Y(target), 5, 0, Math.PI * 2);
        ctx.fillStyle = '#FFFFFF'; ctx.fill(); ctx.lineWidth = 2; ctx.strokeStyle = P.goal; ctx.stroke();
      }

      ctx.beginPath(); ctx.moveTo(x0, y1); ctx.lineTo(x1, y1); ctx.strokeStyle = P.line; ctx.lineWidth = 1; ctx.stroke();
      ctx.fillStyle = P.text3; ctx.font = '10px sans-serif'; ctx.textAlign = 'right';
      ctx.fillText(M.wan(max), x0 - 5, Y(max) + 3); ctx.fillText('0', x0 - 5, y1 + 3);
      ctx.textAlign = 'center';
      const stepY = N <= 6 ? 1 : (N <= 12 ? 2 : 5);
      const y0year = self.d.ctx.now.getFullYear();
      for (let i = 0; i <= N; i += stepY) ctx.fillText(i === 0 ? '今天' : String(y0year + i), X(i), y1 + 16);
    });
  },

  editGoal() {
    const self = this;
    wx.showModal({
      title: '目标金额（万元）', editable: true, content: String(Math.round(this.goal.amount / 1000000)),
      placeholderText: '500',
      success(r) {
        if (!r.confirm) return;
        const wan = Number(r.content);
        if (!(wan > 0)) return;
        self.goal.amount = Math.round(wan * 1000000);
        self.setData({ goal: self.goal });
        self.compute(); self.save();
      }
    });
  },

  onSlide(e) {
    const k = e.currentTarget.dataset.k, v = e.detail.value;
    if (k === 'monthly' || k === 'annual') this.cfg[k] = v * 100; else this.cfg[k] = v / 100;
    this.compute();
  },
  onSlideEnd(e) { this.onSlide(e); this.save(); },
  toggleRecv(e) { this.cfg.recoverReceivable = e.detail.value; this.compute(); this.save(); },
  toggleOut(e) { const i = e.currentTarget.dataset.idx; this.cfg.outflows[i].on = this.cfg.outflows[i].on === false; this.compute(); this.save(); },
  removeOut(e) {
    const i = e.currentTarget.dataset.idx, self = this;
    wx.showModal({ title: '删掉这笔计划支出？', content: this.cfg.outflows[i].name,
      success(r) { if (!r.confirm) return; self.cfg.outflows.splice(i, 1); self.compute(); self.save(); } });
  },
  startAdd() { this.setData({ adding: true, newOut: { name: '', date: '', amount: '' } }); },
  cancelAdd() { this.setData({ adding: false }); },
  onNewName(e) { this.setData({ 'newOut.name': e.detail.value }); },
  onNewDate(e) { this.setData({ 'newOut.date': e.detail.value }); },
  onNewAmount(e) { this.setData({ 'newOut.amount': e.detail.value }); },
  confirmAdd() {
    const n = this.data.newOut;
    if (!n.name || !n.date || !n.amount) { wx.showToast({ title: '三项都要填', icon: 'none' }); return; }
    this.cfg.outflows.push({ name: n.name, date: n.date, amount: M.toFen(n.amount), on: true });
    this.cfg.outflows.sort(function (x, y) { return x.date < y.date ? -1 : 1; });
    this.setData({ adding: false }); this.compute(); this.save();
  },

  save() {
    const self = this;
    if (this._t) clearTimeout(this._t);
    this._t = setTimeout(function () {
      db.saveConfig(Object.assign({}, self.cfg, { goal: self.goal })).catch(function () {});
    }, 600);
  }
});
