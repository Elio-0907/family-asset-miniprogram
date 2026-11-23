const load = require('../../utils/load.js');
const db = require('../../utils/db.js');
const M = require('../../utils/money.js');
const calc = require('../../utils/calc.js');
const AL = require('../../utils/allocation.js');

const PRESETS_VIEW = AL.PRESETS.map(function (p) {
  return Object.assign({}, p, {
    ratioText: p.targets.accrual + '/' + p.targets.market + '/' + p.targets.quantity + '/' + p.targets.balance
  });
});

Page({
  data: {
    loaded: false,
    masked: false,
    configured: false,
    editing: false,
    presets: PRESETS_VIEW,
    activePreset: '',
    draft: { accrual: 55, market: 30, quantity: 10, balance: 5 },
    draftThreshold: AL.DEFAULT_THRESHOLD,
    draftNote: '',
    sumTotal: 100,
    canAutoFillCd: false,
    editRows: [],
    draftStressText: ''
  },

  onShow() {
    try { this.setData({ masked: !!wx.getStorageSync('masked') }); } catch (e) { /* ignore */ }
    this.refresh();
  },

  refresh(force) {
    const self = this;
    return Promise.all([load.loadAll(force), db.getConfig()]).then(function (r) {
      self.d = r[0];
      self.cfg = r[1] || {};
      self.renderAll();
    }).catch(function (e) {
      console.error(e);
      self.setData({ loaded: true });
    });
  },

  renderAll() {
    const d = this.d;
    const sum = d.sum;
    const allocCfg = this.cfg.allocation || null;

    // 算一下未来 90 天到期存单总额（用于生成不损息再平衡建议）
    const due90 = calc.dueItems(d.assets, d.ctx, { homeOnly: true, within: 90 })
      .reduce(function (s, i) { return s + (i.val.atMaturity || i.val.value || 0); }, 0);
    const monthlySave = this.cfg.monthly || 0;

    const res = AL.analyze(sum, allocCfg, { dueSoon90: due90, monthlySave: monthlySave });
    this.actualMap = { accrual: 0, market: 0, quantity: 0, balance: 0 };
    (sum.byLayer.liquid || []).forEach(function (it) {
      const m = it.asset.mode;
      if (this.actualMap[m] !== undefined) this.actualMap[m] += (it.val.value || 0);
      else this.actualMap.balance += (it.val.value || 0);
    }.bind(this));

    const patch = {
      loaded: true,
      liquid: res.liquid,
      liquidText: M.cny(res.liquid),
      configured: res.configured
    };

    if (res.configured) {
      let statusCls = 'ok', statusLabel = '配比均衡';
      if (!res.balanced && res.maxDrift) {
        statusCls = res.maxDrift.status === 'alert' ? 'alert' : 'warn';
        statusLabel = res.maxDrift.status === 'alert' ? '明显偏离' : '轻微偏离';
      }

      const actualSegs = res.rows.filter(function (x) { return x.actual > 0; }).map(function (x) {
        return { key: x.key, tone: x.tone, w: x.actualPct.toFixed(1) };
      });
      const targetSegs = res.rows.filter(function (x) { return x.targetPct > 0; }).map(function (x) {
        return { key: x.key, tone: x.tone, w: String(x.targetPct) };
      });

      const rows = res.rows.map(function (x) {
        let diffText = '均衡', diffCls = 'flat';
        if (x.direction === 'over') {
          diffText = '超配 ' + M.signed(x.diffFen);
          diffCls = x.status === 'alert' ? 'up' : 'warnc';
        } else if (x.direction === 'under') {
          diffText = '低配 ' + M.signed(x.diffFen);
          diffCls = x.status === 'alert' ? 'up' : 'warnc';
        } else if (res.liquid > 0 && Math.abs(x.diffPct) >= 0.5) {
          diffText = (x.diffPct > 0 ? '+' : '') + x.diffPct.toFixed(1) + '%';
        }
        return {
          key: x.key,
          tone: x.tone,
          name: x.name,
          actualPctText: x.actualPct.toFixed(1) + '%',
          targetPct: x.targetPct,
          actualText: M.cny(x.actual),
          diffText: diffText,
          diffCls: diffCls
        };
      });

      Object.assign(patch, {
        statusCls: statusCls,
        statusLabel: statusLabel,
        headline: res.headline,
        threshold: res.cfg.threshold,
        actualSegs: actualSegs,
        targetSegs: targetSegs,
        rows: rows,
        advice: res.advice,
        stressText: res.stressText,
        updatedAt: res.cfg.updatedAt || '',
        savedNote: res.cfg.note || ''
      });

      if (!this.data.editing) {
        patch.draft = Object.assign({}, res.cfg.targets);
        patch.draftThreshold = res.cfg.threshold;
        patch.draftNote = res.cfg.note || '';
      }
    } else {
      patch.editing = true;
    }

    this.setData(patch);
    this.refreshEditor();
  },

  refreshEditor() {
    const draft = this.data.draft;
    const liquid = this.data.liquid || 0;
    const actualMap = this.actualMap || {};
    const sumTotal = AL.sumTargets(draft);
    const others = (Number(draft.market) || 0) + (Number(draft.quantity) || 0) + (Number(draft.balance) || 0);

    let activePreset = '';
    AL.PRESETS.forEach(function (p) {
      const same = AL.BUCKETS.every(function (b) {
        return Math.round(Number(draft[b.key]) || 0) === p.targets[b.key];
      });
      if (same) activePreset = p.id;
    });

    const editRows = AL.BUCKETS.map(function (b) {
      const pctNum = Math.max(0, Math.min(100, Math.round(Number(draft[b.key]) || 0)));
      const act = actualMap[b.key] || 0;
      const actPct = liquid > 0 ? (act / liquid * 100).toFixed(1) + '%' : '0.0%';
      const targetFen = Math.round(liquid * pctNum / 100);
      return {
        key: b.key,
        name: b.name,
        desc: b.desc,
        tone: b.tone,
        pct: String(pctNum),
        pctNum: pctNum,
        actualPctText: actPct,
        targetMoneyText: M.cny(targetFen)
      };
    });

    const eqPct = Math.max(0, Math.min(100, Math.round(Number(draft.market) || 0)));
    const dropPct = (eqPct * 0.3).toFixed(1);
    const dropFen = Math.round(liquid * (eqPct / 100) * 0.3);
    const draftStressText = eqPct > 0
      ? ('按股票目标 ' + eqPct + '% 测算：若股市大跌 30%，可动用总资产约回撤 ' + dropPct + '%' +
         (liquid > 0 ? '（约 ' + M.cny(dropFen) + '）' : '') + '。')
      : '股票目标为 0%，几乎不受股市波动影响。';

    this.setData({
      activePreset: activePreset,
      sumTotal: sumTotal,
      canAutoFillCd: sumTotal !== 100 && others <= 100,
      editRows: editRows,
      draftStressText: draftStressText
    });
  },

  startEdit() {
    const cfg = (this.cfg && this.cfg.allocation) || null;
    if (cfg && cfg.targets) {
      this.setData({
        editing: true,
        draft: Object.assign({}, cfg.targets),
        draftThreshold: cfg.threshold || AL.DEFAULT_THRESHOLD,
        draftNote: cfg.note || ''
      });
    } else {
      this.setData({ editing: true });
    }
    this.refreshEditor();
  },

  cancelEdit() {
    this.setData({ editing: false });
    this.renderAll();
  },

  applyPreset(e) {
    const id = e.currentTarget.dataset.id;
    const p = AL.PRESETS.filter(function (x) { return x.id === id; })[0];
    if (!p) return;
    this.setData({ draft: Object.assign({}, p.targets) });
    this.refreshEditor();
  },

  onPctSlide(e) {
    const k = e.currentTarget.dataset.k;
    const v = Math.max(0, Math.min(100, Math.round(Number(e.detail.value) || 0)));
    this.setData({ ['draft.' + k]: v });
    this.refreshEditor();
  },

  onPctInput(e) {
    const k = e.currentTarget.dataset.k;
    const raw = String(e.detail.value || '').replace(/[^\d]/g, '');
    const v = raw === '' ? 0 : Math.max(0, Math.min(100, Number(raw)));
    this.setData({ ['draft.' + k]: v });
    this.refreshEditor();
  },

  autoFillCd() {
    const d = this.data.draft;
    const others = Math.round(Number(d.market) || 0) +
                   Math.round(Number(d.quantity) || 0) +
                   Math.round(Number(d.balance) || 0);
    if (others > 100) return;
    this.setData({ 'draft.accrual': 100 - others });
    this.refreshEditor();
  },

  onThresholdSlide(e) {
    this.setData({ draftThreshold: Math.max(2, Math.min(15, Math.round(Number(e.detail.value) || 5))) });
  },

  onNoteInput(e) {
    this.setData({ draftNote: e.detail.value });
  },

  save() {
    const sumTotal = AL.sumTargets(this.data.draft);
    if (sumTotal !== 100) {
      wx.showToast({ title: '4 项加起来要等于 100%（当前 ' + sumTotal + '%）', icon: 'none' });
      return;
    }
    const payload = {
      enabled: true,
      targets: {
        accrual: Math.round(Number(this.data.draft.accrual) || 0),
        market: Math.round(Number(this.data.draft.market) || 0),
        quantity: Math.round(Number(this.data.draft.quantity) || 0),
        balance: Math.round(Number(this.data.draft.balance) || 0)
      },
      threshold: this.data.draftThreshold,
      note: String(this.data.draftNote || '').trim().slice(0, 60),
      updatedAt: calc.fmtDate(calc.startOfToday())
    };
    const self = this;
    wx.showLoading({ title: '保存中', mask: true });
    db.saveAllocation(payload).then(function () {
      wx.hideLoading();
      self.cfg = Object.assign({}, self.cfg, { allocation: payload });
      self.setData({ editing: false });
      self.renderAll();
      wx.showToast({ title: '目标配比已保存', icon: 'none' });
    }).catch(function (err) {
      wx.hideLoading();
      wx.showModal({ title: '没存上', content: String(err.message || err), showCancel: false });
    });
  }
});
