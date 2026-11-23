const S = require('./schema.js');
const calc = require('../../utils/calc.js');
const db = require('../../utils/db.js');
const M = require('../../utils/money.js');
const CONFIG = require('../../config.js');
const ST = require('../../utils/stock.js');
const R = require('../../utils/recurring.js');

const TERMS = [3, 6, 12, 24, 36, 60];

Page({
  data: {
    isNew: true, id: '', mode: 'accrual', layer: 'liquid',
    form: {}, fields: [], optIndex: {}, calc: [], earlyNote: '',
    holdings: [], holdSumText: '', fxText: '', ocr: null, updateMode: 'shot',
    modes: S.ORDER.map(function (k) { return { k: k, label: S.SCHEMA[k].label }; })
           .concat([{ k: 'plan', label: '每月存单' }]),
    plan: { id: '', institution: '', amount: '', day: '1', termIndex: 2, rate: '', doneThisMonth: false,
            startMonth: '', dayPassed: true },
    backfillText: '', backfillFirst: '', backfillDue: '', planCds: [], planCdsTotal: '',
    planRuleOpen: false, planListOpen: false,
    onMatureLabels: ['我手动处理', '自动转存（同期限）', '自动结清（取出）'],
    canRoll: false, rollOpen: false, roll: { termIndex: 2, rate: '', includeInterest: true },
    rollStart: '', rollPrincipal: '', rollMaturity: '', rollAtMaturity: '',
    termLabels: TERMS.map(function (m) { return R.TERM_LABEL[m]; }),
    planPreview: []
  },

  onLoad(q) {
    if (q && q.plan) {
      this.loadPlan(q.plan);
    } else if (q && q.id) {
      this.loadExisting(q.id);
    } else {
      this.setData({ isNew: true, form: { name: '' } });
      this.applyMode('accrual');
    }
  },

  loadExisting(id) {
    const self = this;
    wx.showLoading({ title: '读取中' });
    db.getAsset(id).then(function (a) {
      wx.hideLoading();
      const form = {};
      // 分 → 元，日期原样，其余原样
      Object.keys(a).forEach(function (k) {
        if (S.MONEY_KEYS.indexOf(k) >= 0) form[k] = M.toYuanInput(a[k]);
        else if (typeof a[k] === 'number') form[k] = String(a[k]);
        else if (typeof a[k] === 'string') form[k] = a[k];
        else if (typeof a[k] === 'boolean') form[k] = a[k];
      });
      // 存单离到期 30 天内或已到期：可以转存
      if (a.mode === 'accrual' && a.layer === 'liquid' && a.maturityDate) {
        const dd = calc.daysBetween(calc.startOfToday(), calc.parseDate(a.maturityDate));
        self.setData({ canRoll: dd <= 30, roll: { termIndex: Math.max(0, TERMS.indexOf(R.termMonthsOf(a))),
                                                   rate: a.rate ? String(a.rate) : '', includeInterest: true } });
      }
      if (a.recurring && a.recurring.amount) {
        form.recurringAmount = M.toYuanInput(a.recurring.amount);
        form.recurringDay = String(a.recurring.day || 1);
      }
      // 老数据只有总成本的，反推出单价给表单用
      if (a.mode === 'quantity' && !a.costPrice && a.costTotal && a.quantity) {
        form.costPrice = M.toYuanInput(Math.round(a.costTotal / a.quantity));
      }
      self.raw = a;
      self.setData({ fromPlan: !!a.planId });
      wx.setNavigationBarTitle({ title: a.name || '资产详情' });
      const holdings = (a.holdings || []).map(function (h, i) {
        return self.toHoldRow(h, i);
      });
      self.setData({
        isNew: false, id: id, mode: a.mode, layer: a.layer, form: form,
        holdings: holdings, updateMode: holdings.length ? 'hold' : 'shot'
      });
      self.applyMode(a.mode, true);
    }).catch(function () {
      wx.hideLoading();
      wx.showToast({ title: '读不到这笔资产', icon: 'none' });
    });
  },

  applyMode(mode, keepForm) {
    const def = S.SCHEMA[mode];
    const layer = keepForm ? this.data.layer : def.layers[0].v;
    const form = keepForm ? this.data.form : Object.assign({}, this.data.form);

    if (!keepForm) {
      // 换计价方式时给几个合理默认值，少填几下
      if (mode === 'accrual') {
        form.interestRule = form.interestRule || 'atMaturity';
        form.startDate = form.startDate || calc.fmtDate(new Date());
        form.confidence = form.confidence || 'mid';
      }
      if (mode === 'quantity') form.priceKey = CONFIG.GOLD_KEY;
      if (mode === 'market') this.setData({ updateMode: 'shot' });
      if (mode === 'appraisal') form.appraiseDate = form.appraiseDate || calc.fmtDate(new Date());
      if (mode === 'loan') {
        form.repayMethod = form.repayMethod || 'equalPayment';
        form.startDate = form.startDate || calc.fmtDate(new Date());
      }
    }

    this.setData({ mode: mode, layer: layer, form: form, hint: def.hint, layers: def.layers,
                   modeLabel: def.label, layerLabel: calc.LAYER_LABEL[layer], ocr: null });
    this.refreshFields();
  },

  refreshFields() {
    const def = S.SCHEMA[this.data.mode];
    const layer = this.data.layer;
    const fields = def.fields.filter(function (f) { return !f.when || f.when === layer; });

    const form = this.data.form;
    const optIndex = {};
    fields.forEach(function (f) {
      if (f.type === 'select') {
        const cur = form[f.k];
        optIndex[f.k] = Math.max(0, f.values.indexOf(cur));
      }
    });

    this.setData({ fields: fields, optIndex: optIndex,
                   layerLabel: calc.LAYER_LABEL[layer] });
    this.recompute();
  },

  /** 把表单实时算成钱，边填边看结果 */
  recompute() {
    const a = this.buildDoc();
    const ctx = { now: calc.startOfToday(),
                  prices: (getApp().globalData && getApp().globalData.prices) || {} };
    const v = calc.valuate(a, ctx);
    const rows = [];
    let early = '';

    if (this.data.mode === 'accrual') {
      rows.push({ k: '今日价值', v: M.cny(v.value) });
      rows.push({ k: '其中已计利息', v: M.cny(v.accrued) });
      if (v.atMaturity) rows.push({ k: '到期本息', v: M.cny(v.atMaturity) });
      if (v.daysToDue !== null) {
        rows.push({ k: v.daysToDue >= 0 ? '距到期' : '已过约定日',
                    v: Math.abs(v.daysToDue) + ' 天',
                    cls: v.daysToDue < 0 ? 'od' : '' });
      }
      if (this.data.layer === 'liquid' && v.earlyWithdraw && v.atMaturity) {
        const loss = v.atMaturity - v.earlyWithdraw;
        early = '提前支取按活期 ' + calc.CURRENT_RATE.toFixed(2) + '% 计息，' +
                '现在支取只能拿到 ' + M.cny(v.earlyWithdraw) +
                '，比持有到期少 ' + M.cny(loss) + '。';
      }
    } else if (this.data.mode === 'quantity') {
      const p = ctx.prices[a.priceKey];
      if (p) rows.push({ k: '当前单价', v: '¥' + (p / 100).toFixed(2) + ' / ' + (a.unit || 'g') });
      rows.push({ k: '今日价值', v: M.cny(v.value) });
      if (a.costPrice > 0 && p) {
        rows.push({ k: '买入 → 现价', v: '¥' + (a.costPrice / 100).toFixed(2) + ' → ¥' + (p / 100).toFixed(2) + ' /g' });
      }
      if (v.gain !== null) {
        rows.push({ k: '浮动盈亏', v: M.signed(v.gain) + '（' + M.pct(v.gainPct, 1) + '）',
                    cls: v.gain >= 0 ? 'up' : 'down' });
      }
    } else if (this.data.mode === 'market') {
      rows.push({ k: '今日价值', v: M.cny(v.value) });
      if (v.gain !== null) {
        rows.push({ k: '浮动盈亏', v: M.signed(v.gain) + '（' + M.pct(v.gainPct, 1) + '）',
                    cls: v.gain >= 0 ? 'up' : 'down' });
      }
    } else if (this.data.mode === 'appraisal') {
      rows.push({ k: '今日估值', v: M.cny(v.value) });
      if (v.gain !== null && a.depreciationRate > 0) {
        rows.push({ k: '累计折旧', v: M.signed(v.gain) + '（' + M.pct(v.gainPct, 1) + '）', cls: 'down' });
      }
    } else if (this.data.mode === 'loan') {
      rows.push({ k: '当前剩余本金', v: '−' + M.cny(v.value) });
      if (v.paidPrincipal > 0) {
        rows.push({ k: '基准日以来已还本金', v: M.cny(v.paidPrincipal) });
      }
      if (v.monthlyPayment > 0) {
        rows.push({ k: '本月月供', v: M.cny(v.monthlyPayment) });
        rows.push({
          k: '其中本金 / 利息',
          v: M.cny(v.monthlyPrincipal) + ' / ' + M.cny(v.monthlyInterest)
        });
      }
      if (v.remainingMonths > 0) {
        const yrs = Math.floor(v.remainingMonths / 12), mos = v.remainingMonths % 12;
        const span = (yrs ? yrs + ' 年' : '') + (mos ? (yrs ? ' ' : '') + mos + ' 个月' : '');
        rows.push({ k: '剩余期数', v: v.remainingMonths + ' 期（' + span + '）' });
      }
      if (v.remainingInterest > 0) {
        rows.push({ k: '剩余总利息', v: M.cny(v.remainingInterest), cls: 'warnc' });
        const cdRate = (getApp().globalData && getApp().globalData.weightedRate) || 0;
        early = '按现有利率还完剩余 ' + v.remainingMonths + ' 期，还需支付利息 ' + M.cny(v.remainingInterest) + '。';
        if (a.rate > 0 && cdRate > 0 && a.rate > cdRate + 0.2) {
          early += ' 你家里存单加权年化约 ' + cdRate.toFixed(2) + '%，闲钱提前还这笔贷款相当于无风险赚 ' + a.rate.toFixed(2) + '%。';
        }
      } else if (v.note) {
        rows.push({ k: '状态', v: v.note });
      }
    } else {
      rows.push({ k: '今日价值', v: M.cny(v.value) });
      const amt = M.toFen(this.data.form.recurringAmount);
      if (amt > 0) {
        const day = Math.max(1, Math.min(28, Number(this.data.form.recurringDay) || 1));
        rows.push({ k: '每月 ' + day + ' 日自动存入', v: M.cny(amt) });
        const log = (this.raw && this.raw.recurringLog) || [];
        if (log.length) {
          const last = log[log.length - 1];
          const sum = log.reduce(function (t, x) { return t + (x.amount || 0); }, 0);
          rows.push({ k: '上次自动存入', v: last.date + ' · ' + M.cny(last.amount) });
          rows.push({ k: '已自动存入', v: log.length + ' 次 · 共 ' + M.cny(sum) });
        }
      }
    }

    this.setData({ calc: rows, earlyNote: early });
  },

  /** 表单 → 数据库文档（元转分） */
  buildDoc() {
    const f = this.data.form;
    const doc = { mode: this.data.mode, layer: this.data.layer, name: f.name || '' };
    const def = S.SCHEMA[this.data.mode];
    def.fields.forEach(function (fd) {
      const raw = f[fd.k];
      if (fd.type === 'switch') { doc[fd.k] = raw === true || raw === 'true'; return; }
      if (raw === undefined || raw === '') return;
      if (S.MONEY_KEYS.indexOf(fd.k) >= 0) doc[fd.k] = M.toFen(raw);
      else if (S.NUMBER_KEYS.indexOf(fd.k) >= 0) doc[fd.k] = Number(raw) || 0;
      else doc[fd.k] = raw;
    });
    if (this.data.mode === 'quantity') {
      doc.priceKey = CONFIG.GOLD_KEY;
      doc.unit = 'g';
      // 表单填的是单价，库里存总成本（计价引擎按总成本算盈亏）
      doc.costTotal = (doc.costPrice > 0 && doc.quantity > 0) ? Math.round(doc.costPrice * doc.quantity) : 0;
    }
    if (this.data.mode === 'balance') {
      const amt = doc.recurringAmount || 0;
      const day = Math.max(1, Math.min(28, Number(doc.recurringDay) || 1));
      delete doc.recurringAmount; delete doc.recurringDay;
      if (amt > 0) {
        doc.recurring = { amount: amt, day: day };
        // 第一次设置时把本月标记为已执行：你填的余额里通常已经包含了这个月存的那笔
        const had = this.raw && this.raw.recurring && this.raw.recurring.amount;
        if (!had) {
          const d = new Date(), m = d.getMonth() + 1;
          doc.recurringLast = d.getFullYear() + '-' + (m < 10 ? '0' + m : m);
        }
      } else {
        doc.recurring = null;
      }
    }
    if (this.data.mode === 'market') {
      const hs = (this.data.updateMode === 'hold' ? this.data.holdings : [])
        .map(function (h) {
          return { code: ST.normalizeCode(h.code), name: h.name || '', shares: Number(h.shares) || 0,
                   price: h.price || 0, priceLocal: h.priceLocal || 0,
                   currency: h.currency || 'CNY', quoteDate: h.quoteDate || '' };
        })
        .filter(function (h) { return h.code && h.shares > 0; });
      doc.holdings = hs;
      if (hs.length) {
        doc.marketValue = ST.holdingsValue(hs, doc.cash || 0);
        const dates = hs.map(function (h) { return h.quoteDate; }).filter(Boolean).sort();
        doc.valueUpdatedAt = dates.length ? dates[dates.length - 1] : calc.fmtDate(new Date());
      } else if (doc.marketValue) {
        doc.valueUpdatedAt = calc.fmtDate(new Date());
      }
    }
    return doc;
  },

  pickMode(e) {
    const k = e.currentTarget.dataset.k;
    if (k === 'plan') {
      const passed = calc.startOfToday().getDate() >= (Number(this.data.plan.day) || 1);
      this.setData({ mode: 'plan', 'plan.dayPassed': passed, 'plan.doneThisMonth': passed });
      this.previewPlan(); return;
    }
    this.applyMode(k);
  },

  goPlan() {
    if (this.raw && this.raw.planId) wx.redirectTo({ url: '/pages/edit/edit?plan=' + this.raw.planId });
  },

  /* ---------- 到期转存 ---------- */
  openRoll() { this.setData({ rollOpen: true }); this.previewRoll(); },
  closeRoll() { this.setData({ rollOpen: false }); },
  onRollTerm(e) { this.setData({ 'roll.termIndex': Number(e.detail.value) }); this.previewRoll(); },
  onRollRate(e) { this.setData({ 'roll.rate': e.detail.value }); this.previewRoll(); },
  onRollInterest(e) { this.setData({ 'roll.includeInterest': e.detail.value }); this.previewRoll(); },

  previewRoll() {
    const a = this.raw; if (!a) return;
    const r = this.data.roll;
    const v = calc.valuate(a, { now: calc.parseDate(a.maturityDate), prices: {} });
    const doc = R.buildRollover(a, v.atMaturity, {
      termMonths: TERMS[r.termIndex] || 12, rate: Number(r.rate) || 0,
      includeInterest: r.includeInterest, familyId: 'x', openid: 'x'
    });
    const nv = calc.valuate(doc, { now: calc.parseDate(doc.maturityDate), prices: {} });
    this.setData({ rollStart: doc.startDate, rollPrincipal: M.cny(doc.principal),
                   rollMaturity: doc.maturityDate, rollAtMaturity: M.cny(nv.atMaturity) });
  },

  doRoll() {
    const self = this, r = this.data.roll;
    wx.showLoading({ title: '转存中' });
    db.rollover(this.data.id, { termMonths: TERMS[r.termIndex] || 12, rate: Number(r.rate) || 0,
                                includeInterest: r.includeInterest })
      .then(function (res) {
        wx.hideLoading();
        getApp().invalidate();
        wx.showToast({ title: '已转存', icon: 'none' });
        setTimeout(function () { wx.redirectTo({ url: '/pages/edit/edit?id=' + res._id }); }, 500);
      })
      .catch(function (e) { wx.hideLoading(); wx.showModal({ title: '没转成', content: String(e.message || e), showCancel: false }); });
  },

  /* ---------- 每月存单计划 ---------- */
  loadPlan(id) {
    const me = getApp().globalData.me || {};
    const p = (me.plans || []).filter(function (x) { return x.id === id; })[0];
    if (!p) { wx.showToast({ title: '找不到这个计划', icon: 'none' }); return; }
    wx.setNavigationBarTitle({ title: '每月存单' });
    this.setData({
      mode: 'plan', isNew: false,
      plan: { id: p.id, institution: p.institution || '', amount: M.toYuanInput(p.amount),
              day: String(p.day || 1), termIndex: Math.max(0, TERMS.indexOf(p.termMonths || 12)),
              rate: p.rate ? String(p.rate) : '', doneThisMonth: true, lastApplied: p.lastApplied,
              onMatureIndex: Math.max(0, ['manual', 'renew', 'close'].indexOf(p.onMature || 'manual')) }
    });
    this.previewPlan();
    this.loadPlanCds(id);
  },

  /** 这个计划开出来的每一张存单 */
  loadPlanCds(planId) {
    const self = this;
    const load = require('../../utils/load.js');
    load.loadAll(true).then(function (d) {
      const cds = d.sum.byLayer.liquid.filter(function (it) { return it.asset.planId === planId; })
        .sort(function (x, y) { return x.asset.maturityDate < y.asset.maturityDate ? -1 : 1; });
      let total = 0;
      const rows = cds.map(function (it) {
        total += it.val.value;
        const dd = it.val.daysToDue;
        return { id: it.asset._id, start: it.asset.startDate, maturity: it.asset.maturityDate,
                 value: M.cny(it.val.value),
                 days: dd === null ? '' : (dd >= 0 ? '还有 ' + dd + ' 天' : '已到期'),
                 cls: (dd !== null && dd >= 0 && dd <= 30) ? 'warnc' : 'flat' };
      });
      self.setData({ planCds: rows, planCdsTotal: M.cny(total) });
    }).catch(function () {});
  },

  openCd(e) { wx.navigateTo({ url: '/pages/edit/edit?id=' + e.currentTarget.dataset.id }); },
  togglePlanRule() { this.setData({ planRuleOpen: !this.data.planRuleOpen }); },
  togglePlanList() { this.setData({ planListOpen: !this.data.planListOpen }); },

  adjustPlan(e) {
    const self = this, d = Number(e.currentTarget.dataset.d);
    if (d < 0 && !this.data.planCds.length) return;
    wx.showLoading({ title: d > 0 ? '补一张' : '去一张', mask: true });
    db.planAdjust(this.data.plan.id, d).then(function () {
      wx.hideLoading();
      getApp().invalidate();
      self.loadPlanCds(self.data.plan.id);
    }).catch(function (err) {
      wx.hideLoading();
      wx.showToast({ title: String(err.message || err), icon: 'none' });
    });
  },

  onPlanInput(e) {
    const k = e.currentTarget.dataset.k;
    const patch = { ['plan.' + k]: e.detail.value };
    if (k === 'day') {
      // 日子还没到的话，"这个月已经存过了"这个问题没意义，隐藏并默认关
      const passed = calc.startOfToday().getDate() >= (Number(e.detail.value) || 1);
      patch['plan.dayPassed'] = passed;
      if (!passed) patch['plan.doneThisMonth'] = false;
    }
    this.setData(patch);
    this.previewPlan();
  },
  onPlanStart(e) { this.setData({ 'plan.startMonth': e.detail.value }); this.previewPlan(); },
  onPlanMature(e) { this.setData({ 'plan.onMatureIndex': Number(e.detail.value) }); },
  onPlanTerm(e) { this.setData({ 'plan.termIndex': Number(e.detail.value) }); this.previewPlan(); },
  onPlanDone(e) { this.setData({ 'plan.doneThisMonth': e.detail.value }); this.previewPlan(); },

  previewPlan() {
    const p = this.data.plan;
    const amount = M.toFen(p.amount);
    if (!amount) { this.setData({ planPreview: [] }); return; }
    const today = calc.startOfToday();
    const plan = { amount: amount, day: Number(p.day) || 1, termMonths: TERMS[p.termIndex] || 12,
                   rate: Number(p.rate) || 0,
                   lastApplied: p.id ? p.lastApplied : (p.doneThisMonth ? R.monthKey(today) : null) };
    // 往期补录预览
    let bf = [];
    if (!p.id && p.startMonth) bf = R.backfillMonths(plan, p.startMonth, today, !!p.doneThisMonth);
    if (bf.length && bf[bf.length - 1].start.slice(0, 7) === R.monthKey(today)) plan.lastApplied = R.monthKey(today);
    this.setData({
      backfillText: bf.length ? bf.length + ' 张 · 本金共 ' + M.cny(amount * bf.length) : '',
      backfillFirst: bf.length ? bf[0].start : '',
      backfillDue: bf.length ? bf[0].maturity : ''
    });

    const nx = R.nextRun(plan, today);
    const cd = R.buildCd(plan, calc.parseDate(nx.start), 'x', 'x');
    const v = calc.valuate(cd, { now: calc.parseDate(nx.maturity), prices: {} });
    this.setData({ planPreview: [
      { k: '起息日', v: nx.start },
      { k: '到期日', v: nx.maturity },
      { k: '到期本息', v: M.cny(v.atMaturity || amount) },
      { k: '一年后手里的存单', v: '12 张 · 本金共 ' + M.cny(amount * 12) }
    ] });
  },

  savePlan() {
    const p = this.data.plan;
    const amount = M.toFen(p.amount);
    if (!amount) { wx.showToast({ title: '每月金额要填', icon: 'none' }); return; }
    const plan = { id: p.id || undefined, institution: p.institution, amount: amount,
                   day: Number(p.day) || 1, termMonths: TERMS[p.termIndex] || 12,
                   rate: Number(p.rate) || 0, doneThisMonth: !!p.doneThisMonth,
                   startMonth: p.startMonth || '',
                   onMature: ['manual', 'renew', 'close'][p.onMatureIndex || 0] };
    wx.showLoading({ title: '保存中' });
    db.savePlan(plan).then(function (me) {
      wx.hideLoading();
      getApp().globalData.me = me;
      getApp().invalidate();
      wx.showToast({ title: me.backfilled ? '补录了 ' + me.backfilled + ' 张' : '记好了', icon: 'none' });
      setTimeout(function () { wx.navigateBack(); }, 500);
    }).catch(function (e) {
      wx.hideLoading();
      wx.showModal({ title: '没存上', content: String(e.message || e), showCancel: false });
    });
  },

  stopPlan() {
    const self = this;
    wx.showModal({
      title: '停止自动开单？', content: '已经开出来的存单都还在，只是以后不再自动开新的。',
      success(r) {
        if (!r.confirm) return;
        db.deletePlan(self.data.plan.id).then(function (me) {
          getApp().globalData.me = me;
          wx.navigateBack();
        });
      }
    });
  },

  pickLayer(e) {
    this.setData({ layer: e.currentTarget.dataset.v });
    this.refreshFields();
  },

  onInput(e) {
    const k = e.currentTarget.dataset.k;
    this.setData({ ['form.' + k]: e.detail.value });
    if (k === 'cash' && this.data.mode === 'market') this.computeHold();
    else this.recompute();
  },

  onPickDate(e) {
    const k = e.currentTarget.dataset.k;
    this.setData({ ['form.' + k]: e.detail.value });
    this.recompute();
  },

  onPickSelect(e) {
    const k = e.currentTarget.dataset.k;
    const i = Number(e.detail.value);
    const fd = this.data.fields.filter(function (f) { return f.k === k; })[0];
    if (!fd) return;
    this.setData({ ['form.' + k]: fd.values[i], ['optIndex.' + k]: i });
    this.recompute();
  },

  onSwitch(e) {
    this.setData({ ['form.' + e.currentTarget.dataset.k]: e.detail.value });
  },

  pickUpdateMode(e) {
    const m = e.currentTarget.dataset.m;
    if (m === this.data.updateMode) return;
    const patch = { updateMode: m, ocr: null };
    if (m === 'hold' && !this.data.holdings.length) patch.holdings = [this.toHoldRow({}, 0)];
    this.setData(patch);
    if (m === 'hold') this.computeHold();
  },

  /* ---------- 从支付宝 / 券商截图 AI 识图更新 ---------- */
  pickShot() {
    const self = this;
    wx.chooseMedia({
      count: 1, mediaType: ['image'], sourceType: ['album', 'camera'], sizeType: ['compressed'],
      success(res) {
        const f = res.tempFiles && res.tempFiles[0];
        if (!f) return;
        self.runOcr(f.tempFilePath);
      }
    });
  },

  runOcr(path) {
    const self = this;
    const g = getApp().globalData || {};
    const scene = this.data.mode === 'balance' ? 'balance' : 'market';
    const cloudPath = 'ocr/' + (g.openid || 'anon') + '/' + Date.now() + '.jpg';
    wx.showLoading({ title: 'AI 识别中', mask: true });
    wx.cloud.uploadFile({ cloudPath: cloudPath, filePath: path })
      .then(function (up) {
        return wx.cloud.callFunction({ name: 'ocrAccount', data: { fileID: up.fileID, scene: scene } });
      })
      .then(function (r) {
        wx.hideLoading();
        const d = r.result || {};
        if (!d.ok) {
          const fallbackHint = scene === 'balance' ? '没认出可用余额或总资产。' : '没认出「总资产」或持仓明细。';
          const why = d.error ? d.error :
            fallbackHint + (d.sample ? '识别到的开头几行：' + d.sample.slice(0, 8).join(' / ') : '');
          wx.showModal({ title: '识别失败', content: why, showCancel: false });
          return;
        }
        const items = (d.items || []).map(function (it) {
          return {
            label: it.label,
            amount: it.amount,
            amountText: '¥' + M.group(Number(it.amount).toFixed(2))
          };
        });
        // 如果当前资产已经起了名字（如「余额宝」），优先自动选中同名分项
        let pickIdx = 0;
        const curName = String((self.data.form && self.data.form.name) || '').trim();
        if (curName && items.length > 1) {
          const hit = items.findIndex(function (it) {
            return it.label === curName || curName.indexOf(it.label) >= 0 || it.label.indexOf(curName) >= 0;
          });
          if (hit >= 0) pickIdx = hit;
        }
        const picked = items[pickIdx] || null;
        const holdings = (d.holdings || []).map(function (h, idx) {
          return {
            key: 'oh_' + idx + '_' + (h.code || h.name),
            code: h.code || '',
            name: h.name || '',
            shares: h.shares
          };
        });
        const prefix = d.engine === 'ai' ? 'AI 识别到' : '从截图识别到';
        const title = d.platform ? prefix + ' · ' + d.platform : prefix;

        self.setData({ ocr: {
          raw: d,
          scene: scene,
          title: title,
          fallbackNote: d.fallbackNote || '',
          items: items,
          pickIdx: pickIdx,
          selectedLabel: picked ? picked.label : '总资产',
          selectedText: picked ? picked.amountText : (d.total !== null && d.total !== undefined ? '¥' + M.group(Number(d.total).toFixed(2)) : ''),
          totalText: d.total === null || d.total === undefined ? '' : '¥' + M.group(Number(d.total).toFixed(2)),
          pnlText: d.pnl === null || d.pnl === undefined ? '' : (d.pnl >= 0 ? '+¥' : '−¥') + M.group(Math.abs(Number(d.pnl)).toFixed(2)),
          pnlCls: d.pnl === null || d.pnl === undefined ? '' : (d.pnl >= 0 ? 'up' : 'down'),
          marketText: d.market === null || d.market === undefined ? '' : '¥' + M.group(Number(d.market).toFixed(2)),
          cashText: d.cash === null || d.cash === undefined ? '' : '¥' + M.group(Number(d.cash).toFixed(2)),
          netInText: d.netIn === null || d.netIn === undefined ? '' : '¥' + M.group(Number(d.netIn).toFixed(2)),
          holdings: holdings
        } });
      })
      .catch(function (e) {
        wx.hideLoading();
        wx.showModal({ title: '识别失败', content: String(e.errMsg || e.message || e), showCancel: false });
      });
  },

  pickOcrItem(e) {
    const idx = Number(e.currentTarget.dataset.i);
    const items = (this.data.ocr && this.data.ocr.items) || [];
    const picked = items[idx];
    if (!picked) return;
    this.setData({
      'ocr.pickIdx': idx,
      'ocr.selectedLabel': picked.label,
      'ocr.selectedText': picked.amountText
    });
  },

  ocrCancel() { this.setData({ ocr: null }); },

  ocrApply() {
    const ocr = this.data.ocr;
    const d = ocr && ocr.raw;
    if (!d) return;
    const f = this.data.form || {};

    if (this.data.mode === 'balance') {
      const picked = (ocr.items && ocr.items[ocr.pickIdx]) || null;
      const val = picked ? picked.amount : d.total;
      if (val === null || val === undefined) return;
      const patch = { ocr: null, 'form.balance': String(val) };
      if (!f.institution && d.platform) patch['form.institution'] = d.platform;
      if (!f.name) {
        if (picked && picked.label && picked.label !== '总资产') patch['form.name'] = picked.label;
        else if (d.platform) patch['form.name'] = d.platform + '总资产';
      }
      this.setData(patch);
      this.recompute();
      wx.showToast({ title: '已填入余额，记得保存', icon: 'none' });
      return;
    }

    const patch = {
      ocr: null,
      updateMode: 'shot',
      'form.marketValue': String(d.total),
      'form.valueUpdatedAt': calc.fmtDate(new Date())
    };
    if (d.netIn !== null && d.netIn !== undefined) patch['form.totalCost'] = String(d.netIn);
    if (d.cash !== null && d.cash !== undefined) patch['form.cash'] = String(d.cash);
    if (!f.institution && d.platform) patch['form.institution'] = d.platform;
    if (!f.name && d.platform) patch['form.name'] = d.platform;
    this.setData(patch);
    this.recompute();
    wx.showToast({ title: '已填入，记得保存', icon: 'none' });
  },

  ocrApplyHoldings() {
    const ocr = this.data.ocr;
    const d = ocr && ocr.raw;
    if (!d || !d.holdings || !d.holdings.length) return;
    const f = this.data.form || {};
    const self = this;

    const rows = d.holdings.map(function (h, i) {
      const row = self.toHoldRow({ code: h.code || '', name: h.name || '', shares: h.shares }, i);
      row.status = '';
      return row;
    });
    const patch = {
      ocr: null,
      updateMode: 'hold',
      holdings: rows
    };
    if (d.cash !== null && d.cash !== undefined) patch['form.cash'] = String(d.cash);
    if (d.netIn !== null && d.netIn !== undefined && !f.totalCost) patch['form.totalCost'] = String(d.netIn);
    if (!f.institution && d.platform) patch['form.institution'] = d.platform;
    if (!f.name && d.platform) patch['form.name'] = d.platform;
    this.setData(patch);
    this.batchLookupHoldings();
  },

  batchLookupHoldings() {
    const self = this;
    const hs = this.data.holdings || [];
    const normMap = {};
    const codes = [];
    let missingCode = 0;

    hs.forEach(function (h, i) {
      const norm = ST.normalizeCode(h.code);
      if (norm) {
        if (!normMap[norm]) { normMap[norm] = []; codes.push(norm); }
        normMap[norm].push(i);
      } else {
        missingCode++;
      }
    });

    if (!codes.length) {
      this.computeHold();
      wx.showToast({ title: '已导入 ' + hs.length + ' 只，请补填代码', icon: 'none' });
      return;
    }

    const loadingPatch = {};
    codes.forEach(function (norm) {
      normMap[norm].forEach(function (i) { loadingPatch['holdings[' + i + '].status'] = 'loading'; });
    });
    this.setData(loadingPatch);

    wx.cloud.callFunction({ name: 'stockPrice', data: { codes: codes } })
      .then(function (r) {
        const quotes = (r.result && r.result.quotes) || {};
        const patch = {};
        let matched = 0;
        codes.forEach(function (norm) {
          const q = quotes[norm];
          normMap[norm].forEach(function (i) {
            if (q) {
              matched++;
              patch['holdings[' + i + '].name'] = q.name;
              patch['holdings[' + i + '].price'] = q.price;
              patch['holdings[' + i + '].priceLocal'] = q.priceLocal;
              patch['holdings[' + i + '].currency'] = q.currency;
              patch['holdings[' + i + '].quoteDate'] = q.date;
              patch['holdings[' + i + '].status'] = 'ok';
              patch['holdings[' + i + '].priceText'] = self.priceText(q);
              patch['holdings[' + i + ']._lastCode'] = norm;
            } else {
              patch['holdings[' + i + '].status'] = 'error';
            }
          });
        });
        if (r.result && r.result.fx && r.result.fx.HKDCNY) {
          patch.fxText = '港币汇率 ' + r.result.fx.HKDCNY.toFixed(4);
        }
        self.setData(patch);
        self.computeHold();
        const tip = missingCode > 0
          ? '已刷新 ' + matched + ' 只，另有 ' + missingCode + ' 只请补代码'
          : '已导入 ' + matched + ' 只持仓，记得保存';
        wx.showToast({ title: tip, icon: 'none' });
      })
      .catch(function () {
        const errPatch = {};
        codes.forEach(function (norm) {
          normMap[norm].forEach(function (i) { errPatch['holdings[' + i + '].status'] = 'error'; });
        });
        self.setData(errPatch);
        self.computeHold();
        wx.showToast({ title: '持仓已填入，行情查询稍后重试', icon: 'none' });
      });
  },

  /* ---------- 持仓编辑器 ---------- */
  toHoldRow(h, i) {
    return {
      key: 'h' + i + '_' + Date.now(),
      code: h.code ? h.code.replace(/^(sh|sz|bj|hk)/, '') : '',
      name: h.name || '', shares: h.shares ? String(h.shares) : '',
      price: h.price || 0, priceLocal: h.priceLocal || 0, currency: h.currency || 'CNY',
      quoteDate: h.quoteDate || '', status: h.name ? 'ok' : '',
      priceText: h.price ? this.priceText(h) : ''
    };
  },

  priceText(h) {
    if (!h.price) return '';
    const cny = '¥' + (h.price / 100).toFixed(2);
    return h.currency === 'HKD' ? 'HK$' + Number(h.priceLocal).toFixed(2) + ' ≈ ' + cny : cny;
  },

  addHold() {
    const hs = this.data.holdings.slice();
    hs.push(this.toHoldRow({}, hs.length));
    this.setData({ holdings: hs });
  },

  delHold(e) {
    const hs = this.data.holdings.slice();
    hs.splice(Number(e.currentTarget.dataset.i), 1);
    this.setData({ holdings: hs });
    this.computeHold();
  },

  onHoldCode(e) {
    const i = Number(e.currentTarget.dataset.i);
    this.setData({ ['holdings[' + i + '].code']: e.detail.value,
                   ['holdings[' + i + '].status']: '' });
  },

  onHoldBlur(e) {
    const i = Number(e.currentTarget.dataset.i);
    const h = this.data.holdings[i];
    if (!h) return;
    const norm = ST.normalizeCode(h.code);
    if (!norm) {
      if (h.code) this.setData({ ['holdings[' + i + '].status']: 'error', ['holdings[' + i + '].name']: '' });
      return;
    }
    if (h.status === 'ok' && norm === ST.normalizeCode(h._lastCode || '')) return;
    this.lookup(i, norm);
  },

  lookup(i, norm) {
    const self = this;
    this.setData({ ['holdings[' + i + '].status']: 'loading', ['holdings[' + i + '].name']: '' });
    wx.cloud.callFunction({ name: 'stockPrice', data: { codes: [norm] } })
      .then(function (r) {
        const q = r.result && r.result.quotes && r.result.quotes[norm];
        if (!q) throw new Error('no quote');
        const patch = {};
        patch['holdings[' + i + '].name'] = q.name;
        patch['holdings[' + i + '].price'] = q.price;
        patch['holdings[' + i + '].priceLocal'] = q.priceLocal;
        patch['holdings[' + i + '].currency'] = q.currency;
        patch['holdings[' + i + '].quoteDate'] = q.date;
        patch['holdings[' + i + '].status'] = 'ok';
        patch['holdings[' + i + '].priceText'] = self.priceText(q);
        patch['holdings[' + i + ']._lastCode'] = norm;
        if (r.result.fx && r.result.fx.HKDCNY) patch.fxText = '港币汇率 ' + r.result.fx.HKDCNY.toFixed(4);
        self.setData(patch);
        self.computeHold();
      })
      .catch(function () {
        self.setData({ ['holdings[' + i + '].status']: 'error' });
      });
  },

  onHoldShares(e) {
    const i = Number(e.currentTarget.dataset.i);
    this.setData({ ['holdings[' + i + '].shares']: e.detail.value });
    this.computeHold();
  },

  /** 持仓合计 → 写回 form.marketValue，让下面的实时计算框跟着动 */
  computeHold() {
    const hs = this.data.holdings.map(function (h) {
      return { price: h.price, shares: Number(h.shares) || 0 };
    });
    const sum = ST.holdingsValue(hs, 0);
    const cash = M.toFen(this.data.form.cash);
    const any = hs.some(function (h) { return h.price > 0 && h.shares > 0; });
    this.setData({
      holdSumText: any ? M.cny(sum) : '',
      'form.marketValue': any ? M.toYuanInput(sum + cash) : this.data.form.marketValue
    });
    this.recompute();
  },

  save() {
    const doc = this.buildDoc();
    if (!doc.name) { wx.showToast({ title: '起个名字吧', icon: 'none' }); return; }

    if (doc.mode === 'accrual' && (!doc.principal || !doc.maturityDate)) {
      wx.showToast({ title: '本金和到期日要填', icon: 'none' }); return;
    }
    if (doc.mode === 'quantity' && !doc.quantity) {
      wx.showToast({ title: '填一下克数', icon: 'none' }); return;
    }
    if (doc.mode === 'loan' && !doc.principal) {
      wx.showToast({ title: '填一下剩余本金', icon: 'none' }); return;
    }

    const self = this;
    wx.showLoading({ title: '保存中' });
    const p = this.data.isNew ? db.addAsset(doc) : db.updateAsset(this.data.id, doc);
    p.then(function (r) {
      const id = self.data.isNew ? (r && r._id) : self.data.id;
      if (doc.mode === 'market' && doc.holdings && doc.holdings.length && id) {
        wx.cloud.callFunction({ name: 'stockPrice', data: { assetId: id } }).catch(function () {});
      }
      wx.hideLoading();
      getApp().invalidate();
      wx.showToast({ title: '记好了' });
      setTimeout(function () { wx.navigateBack(); }, 500);
    }).catch(function (e) {
      wx.hideLoading();
      console.error(e);
      wx.showModal({ title: '没存上', content: String(e.errMsg || e), showCancel: false });
    });
  },

  close() {
    const self = this;
    wx.showModal({
      title: '标记为已结清？',
      content: '不会真的删掉，只是不再计入总额。历史快照里的记录保持不变。',
      success(r) {
        if (!r.confirm) return;
        db.closeAsset(self.data.id).then(function () {
          getApp().invalidate();
          wx.navigateBack();
        });
      }
    });
  }
});
