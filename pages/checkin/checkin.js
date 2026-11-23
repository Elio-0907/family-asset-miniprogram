const load = require('../../utils/load.js');
const db = require('../../utils/db.js');
const M = require('../../utils/money.js');
const calc = require('../../utils/calc.js');
const CK = require('../../utils/checkin.js');
const AL = require('../../utils/allocation.js');

const TONE = { accrual: 1, quantity: 2, market: 3, balance: 4, appraisal: 4 };

function shortWan(fen) {
  const y = fen / 100;
  if (Math.abs(y) >= 10000) return (y / 10000).toFixed(1) + '万';
  return Math.round(y).toString();
}

function monthLabel(ym) {
  if (!ym || ym.length < 7) return '';
  return Number(ym.slice(5, 7)) + ' 月';
}

function deltaCls(val) {
  if (val === null || val === undefined || val === 0) return 'flat';
  return val > 0 ? 'up' : 'down';
}

function formatReport(r, byName) {
  if (!r) return null;
  const hasPrev = r.deltaLiquid !== null && r.deltaLiquid !== undefined;
  return {
    month: r.month,
    monthLabel: monthLabel(r.month),
    prevMonthLabel: monthLabel(r.prevMonth),
    date: r.date || '',
    byName: byName || '',
    hasPrev: hasPrev,
    liquidText: M.cny(r.liquid),
    netText: M.cny(r.net),
    deltaLiquidText: hasPrev ? M.signed(r.deltaLiquid) : '',
    deltaLiquidCls: deltaCls(r.deltaLiquid),
    deltaLiquidPctText: (r.deltaLiquidPct !== null && r.deltaLiquidPct !== undefined)
      ? M.pct(r.deltaLiquidPct, 1) : '',
    deltaNetText: (r.deltaNet !== null && r.deltaNet !== undefined) ? M.signed(r.deltaNet) : '',
    deltaNetCls: deltaCls(r.deltaNet),
    hasLiability: (r.liability || 0) > 0 || (r.prevLiability || 0) > 0,
    liabilityText: '−' + M.cny(r.liability || 0),
    deltaLiabilityText: (r.deltaLiability !== null && r.deltaLiability !== undefined && r.deltaLiability !== 0)
      ? (r.deltaLiability < 0 ? ('减少 ' + M.cny(-r.deltaLiability)) : ('增加 ' + M.cny(r.deltaLiability)))
      : '',
    deltaLiabilityCls: (r.deltaLiability !== null && r.deltaLiability !== undefined)
      ? (r.deltaLiability < 0 ? 'down' : (r.deltaLiability > 0 ? 'up' : 'flat'))
      : 'flat',
    note: r.note || '',
    byModeDiff: (r.byModeDiff || []).map(function (it) {
      return {
        mode: it.mode,
        tone: TONE[it.mode] || 4,
        name: it.name,
        valueText: M.cny(it.value),
        deltaText: (it.delta !== null && it.delta !== undefined) ? M.signed(it.delta) : '',
        deltaCls: deltaCls(it.delta)
      };
    }),
    monthlyBars: (r.monthlyBars || []).map(function (b) {
      return Object.assign({}, b, { shortVal: shortWan(b.liquid) });
    })
  };
}

Page({
  data: {
    loaded: false,
    masked: false,
    monthTitle: '',
    liquidText: '',
    todo: [],
    auto: [],
    autoOpen: false,
    doneCount: 0,
    progressPct: 0,
    expandedId: '',
    editingId: '',
    editingVal: '',
    ocr: null,
    note: '',
    alreadyDoneThisMonth: false,
    showReport: false,
    report: null
  },

  onLoad() {
    this.checkedMap = {};
    this.checkedTextMap = {};
    this.pendingAssetId = '';
    this.rawAssets = {};
    this.snapshots = [];
    this.initShownReport = false;
    const now = calc.startOfToday();
    this.curMonth = CK.monthKey(now);
    this.setData({
      masked: wx.getStorageSync('masked') || false,
      monthTitle: now.getFullYear() + ' 年 ' + (now.getMonth() + 1) + ' 月盘点'
    });
  },

  onShow() {
    if (this.pendingAssetId) {
      this.checkedMap[this.pendingAssetId] = true;
      this.checkedTextMap[this.pendingAssetId] = '已核对更新';
      this.pendingAssetId = '';
    }
    this.refresh(true);
  },

  refresh(force) {
    const self = this;
    return Promise.all([load.loadAll(force), db.listSnapshots(365), db.getConfig()]).then(function (r) {
      const d = r[0];
      const snaps = r[1] || [];
      const cfg = r[2] || {};
      self.snapshots = snaps;
      self.rawAssets = {};
      (d.assets || []).forEach(function (a) { self.rawAssets[a._id] = a; });

      const alRes = AL.analyze(d.sum, cfg.allocation || null);
      const allocBanner = alRes.configured
        ? { show: true, drifted: !alRes.balanced, text: alRes.headline }
        : { show: d.sum.liquid > 0, drifted: false, text: '还没设目标配比 · 点击设定 4 大类目标比例' };

      const mePlans = (getApp().globalData.me && getApp().globalData.me.plans) || [];
      const cls = CK.classifyForCheckin(d.sum, d.ctx.now, mePlans);
      const todo = cls.todo.map(function (it) {
        const a = it.asset;
        const checked = !!self.checkedMap[a._id];
        return {
          id: a._id,
          kind: it.kind,
          mode: a.mode,
          name: a.institution ? a.institution + ' · ' + a.name : a.name,
          rawName: a.name || '',
          reason: it.reason,
          value: it.val.value,
          valueText: a.mode === 'loan' ? ('−' + M.cny(it.val.value)) : M.cny(it.val.value),
          checked: checked,
          checkedText: checked ? (self.checkedTextMap[a._id] || '已核对') : ''
        };
      });
      const auto = cls.auto.map(function (it) {
        const a = it.asset;
        return {
          id: a._id,
          tone: load.tone(a),
          name: a.institution ? a.institution + ' · ' + a.name : a.name,
          autoNote: it.autoNote,
          valueText: a.mode === 'loan' ? ('−' + M.cny(it.val.value)) : M.cny(it.val.value)
        };
      });

      const doneCount = todo.filter(function (x) { return x.checked; }).length;
      const progressPct = todo.length ? Math.round(doneCount / todo.length * 100) : 100;

      // 检查本月是否已经完成过盘点
      const me = getApp().globalData.me || {};
      const last = me.lastCheckin || null;
      const monthSnap = snaps.filter(function (s) {
        return s.checkin && (s.checkinMonth === self.curMonth || (s.date || '').slice(0, 7) === self.curMonth);
      }).slice(-1)[0] || null;
      const already = !!(monthSnap || (last && last.month === self.curMonth));

      let report = self.data.report;
      if (monthSnap) {
        const prev = CK.pickPrevSnapshot(snaps, self.curMonth);
        report = formatReport(CK.buildReport(monthSnap, prev, snaps), monthSnap.checkinByName || (last && last.byName) || '');
      }

      const patch = {
        loaded: true,
        allocBanner: allocBanner,
        liquidText: M.cny(d.sum.liquid),
        todo: todo,
        auto: auto,
        doneCount: doneCount,
        progressPct: progressPct,
        alreadyDoneThisMonth: already,
        report: report
      };
      if (!self.initShownReport) {
        self.initShownReport = true;
        if (already && report) {
          patch.showReport = true;
          patch.note = report.note || '';
        }
      }
      self.setData(patch);
    }).catch(function (e) {
      console.error(e);
      self.setData({ loaded: true });
      wx.showToast({ title: '加载失败，稍后再试', icon: 'none' });
    });
  },

  toggleItemExpand(e) {
    const id = e.currentTarget.dataset.id;
    this.setData({ expandedId: this.data.expandedId === id ? '' : id });
  },

  toggleAuto() { this.setData({ autoOpen: !this.data.autoOpen }); },

  markNoChange(e) {
    const id = e.currentTarget.dataset.id;
    this.markDone(id, '本月无变动');
  },

  markAllDone() {
    const self = this;
    (this.data.todo || []).forEach(function (it) {
      if (!self.checkedMap[it.id]) {
        self.checkedMap[it.id] = true;
        self.checkedTextMap[it.id] = '本月无变动';
      }
    });
    this.syncDoneState();
    wx.showToast({ title: '已全部标为无变动', icon: 'none' });
  },

  markDone(id, text) {
    this.checkedMap[id] = true;
    this.checkedTextMap[id] = text || '已核对';
    const patch = { editingId: '', ocr: null };
    if (this.data.expandedId === id) patch.expandedId = '';
    this.setData(patch);
    this.syncDoneState();
  },

  syncDoneState() {
    const self = this;
    const todo = (this.data.todo || []).map(function (it) {
      const c = !!self.checkedMap[it.id];
      return Object.assign({}, it, {
        checked: c,
        checkedText: c ? (self.checkedTextMap[it.id] || '已核对') : ''
      });
    });
    const doneCount = todo.filter(function (x) { return x.checked; }).length;
    const progressPct = todo.length ? Math.round(doneCount / todo.length * 100) : 100;
    this.setData({ todo: todo, doneCount: doneCount, progressPct: progressPct });
  },

  /* ---------- 原地改余额 / 估值 ---------- */
  openInlineEdit(e) {
    const id = e.currentTarget.dataset.id;
    const a = this.rawAssets[id];
    if (!a) return;
    const curFen = a.mode === 'appraisal' ? (a.appraisedValue || 0)
                 : (a.mode === 'loan' ? (a.principal || 0) : (a.balance || 0));
    this.setData({
      editingId: id,
      editingVal: curFen ? M.toYuanInput(curFen) : '',
      ocr: null,
      expandedId: id
    });
  },

  onInlineInput(e) { this.setData({ editingVal: e.detail.value }); },
  cancelInlineEdit() { this.setData({ editingId: '', editingVal: '' }); },

  saveInlineEdit(e) {
    const id = e.currentTarget.dataset.id;
    const a = this.rawAssets[id];
    if (!a) return;
    const fen = M.toFen(this.data.editingVal);
    if (this.data.editingVal === '' || fen < 0) {
      wx.showToast({ title: '请输入有效金额', icon: 'none' });
      return;
    }
    const today = calc.fmtDate(calc.startOfToday());
    const doc = a.mode === 'appraisal'
      ? { appraisedValue: fen, appraiseDate: today }
      : (a.mode === 'loan' ? { principal: fen, valueUpdatedAt: today } : { balance: fen, valueUpdatedAt: today });

    const self = this;
    wx.showLoading({ title: '保存中', mask: true });
    db.updateAsset(id, doc).then(function () {
      wx.hideLoading();
      getApp().invalidate();
      self.markDone(id, '已更新为 ' + M.cny(fen));
      self.refresh(true);
      wx.showToast({ title: '已更新', icon: 'none' });
    }).catch(function (err) {
      wx.hideLoading();
      wx.showModal({ title: '没存上', content: String(err.message || err), showCancel: false });
    });
  },

  /* ---------- 原地 AI 截图更新 ---------- */
  startShot(e) {
    const id = e.currentTarget.dataset.id;
    const scene = e.currentTarget.dataset.scene === 'balance' ? 'balance' : 'market';
    const self = this;
    wx.chooseMedia({
      count: 1, mediaType: ['image'], sourceType: ['album', 'camera'], sizeType: ['compressed'],
      success(res) {
        const f = res.tempFiles && res.tempFiles[0];
        if (!f) return;
        self.runOcr(id, scene, f.tempFilePath);
      }
    });
  },

  runOcr(assetId, scene, path) {
    const self = this;
    const g = getApp().globalData || {};
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
          const why = d.error ? d.error : '没认出金额，可以点「改金额」手动输入';
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
        const a = self.rawAssets[assetId] || {};
        let pickIdx = 0;
        const curName = String(a.name || '').trim();
        if (curName && items.length > 1) {
          const hit = items.findIndex(function (it) {
            return it.label === curName || curName.indexOf(it.label) >= 0 || it.label.indexOf(curName) >= 0;
          });
          if (hit >= 0) pickIdx = hit;
        }
        const picked = items[pickIdx] || null;
        const prefix = d.engine === 'ai' ? 'AI 识别到' : '从截图识别到';
        const title = d.platform ? prefix + ' · ' + d.platform : prefix;

        self.setData({
          editingId: '',
          expandedId: assetId,
          ocr: {
            assetId: assetId,
            scene: scene,
            raw: d,
            title: title,
            fallbackNote: d.fallbackNote || '',
            items: items,
            pickIdx: pickIdx,
            selectedLabel: picked ? picked.label : '总资产',
            selectedText: picked ? picked.amountText : (d.total !== null && d.total !== undefined ? '¥' + M.group(Number(d.total).toFixed(2)) : ''),
            totalText: d.total === null || d.total === undefined ? '' : '¥' + M.group(Number(d.total).toFixed(2)),
            pnlText: d.pnl === null || d.pnl === undefined ? '' : (d.pnl >= 0 ? '+¥' : '−¥') + M.group(Math.abs(Number(d.pnl)).toFixed(2)),
            pnlCls: d.pnl === null || d.pnl === undefined ? '' : (d.pnl >= 0 ? 'up' : 'down'),
            cashText: d.cash === null || d.cash === undefined ? '' : '¥' + M.group(Number(d.cash).toFixed(2)),
            netInText: d.netIn === null || d.netIn === undefined ? '' : '¥' + M.group(Number(d.netIn).toFixed(2)),
            holdingsCount: (d.holdings || []).length
          }
        });
      })
      .catch(function (err) {
        wx.hideLoading();
        wx.showModal({ title: '识别失败', content: String(err.errMsg || err.message || err), showCancel: false });
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

  cancelOcr() { this.setData({ ocr: null }); },

  applyOcrSave() {
    const ocr = this.data.ocr;
    if (!ocr || !ocr.raw) return;
    const d = ocr.raw;
    const id = ocr.assetId;
    const today = calc.fmtDate(calc.startOfToday());
    let doc = null;
    let displayFen = 0;

    if (ocr.scene === 'balance') {
      const picked = (ocr.items && ocr.items[ocr.pickIdx]) || null;
      const val = picked ? picked.amount : d.total;
      if (val === null || val === undefined) return;
      displayFen = M.toFen(val);
      doc = { balance: displayFen, valueUpdatedAt: today };
    } else {
      if (d.total === null || d.total === undefined) {
        wx.showToast({ title: '没识别到总资产，请点「改详情」处理', icon: 'none' });
        return;
      }
      displayFen = M.toFen(d.total);
      doc = { marketValue: displayFen, valueUpdatedAt: today };
      if (d.netIn !== null && d.netIn !== undefined) doc.totalCost = M.toFen(d.netIn);
      if (d.cash !== null && d.cash !== undefined) doc.cash = M.toFen(d.cash);
    }

    const self = this;
    wx.showLoading({ title: '保存中', mask: true });
    db.updateAsset(id, doc).then(function () {
      wx.hideLoading();
      getApp().invalidate();
      self.markDone(id, '已识别更新为 ' + M.cny(displayFen));
      self.refresh(true);
      wx.showToast({ title: '已保存', icon: 'none' });
    }).catch(function (err) {
      wx.hideLoading();
      wx.showModal({ title: '没存上', content: String(err.message || err), showCancel: false });
    });
  },

  /* ---------- 跳转详情 ---------- */
  openAssetDetail(e) {
    const id = e.currentTarget.dataset.id;
    this.pendingAssetId = id;
    wx.navigateTo({ url: '/pages/edit/edit?id=' + id });
  },

  onNoteInput(e) { this.setData({ note: e.detail.value }); },

  /* ---------- 盘点结账 ---------- */
  finish() {
    const self = this;
    wx.showLoading({ title: '正在生成月报', mask: true });
    db.finishCheckin(this.data.note).then(function (res) {
      wx.hideLoading();
      if (res.me) getApp().globalData.me = res.me;
      getApp().invalidate();
      const byName = (res.me && res.me.lastCheckin && res.me.lastCheckin.byName) || '';
      const report = formatReport(res.report, byName);
      self.setData({
        alreadyDoneThisMonth: true,
        report: report,
        showReport: true
      });
      wx.pageScrollTo({ scrollTop: 0, duration: 250 });
      wx.showToast({ title: '本月盘点已存档', icon: 'none' });
    }).catch(function (err) {
      wx.hideLoading();
      wx.showModal({ title: '结账失败', content: String(err.message || err), showCancel: false });
    });
  },

  reopenChecklist() { this.setData({ showReport: false }); },
  viewExistingReport() { this.setData({ showReport: true }); },
  goAllocation() { wx.navigateTo({ url: '/pages/allocation/allocation' }); },
  goHome() { wx.navigateBack(); }
});
