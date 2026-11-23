const load = require('../../utils/load.js');
const calc = require('../../utils/calc.js');
const M = require('../../utils/money.js');
const db = require('../../utils/db.js');
const F = require('../../utils/forecast.js');
const CK = require('../../utils/checkin.js');
const AL = require('../../utils/allocation.js');
const lock = require('../../utils/lock.js');

const GROUP_NAME = {
  accrual: '大额存单', quantity: '实物金条', market: '股票账户',
  balance: '活期与余额宝', appraisal: '其他'
};

const MODE_SUB = {
  accrual: function (a, v) {
    const due = a.maturityDate ? a.maturityDate + ' 到期' : '';
    return (a.rate ? a.rate.toFixed(2) + '% · ' : '') + due +
           (a.autoRenew ? ' · 自动转存' : '') + (a.rollCount ? ' · 已转 ' + a.rollCount + ' 次' : '');
  },
  balance: function (a) {
    const r = a.recurring && a.recurring.amount ? '每月 ' + (a.recurring.day || 1) + ' 日 +' + M.cny(a.recurring.amount) : '';
    const base = a.refRate ? '七日年化 ' + a.refRate.toFixed(2) + '%' : '活期';
    return r ? r + ' · ' + base : base;
  },
  quantity: function (a, v, prices) {
    const p = prices[a.priceKey];
    return (a.quantity || 0) + (a.unit || 'g') +
      (p ? ' · ¥' + (p / 100).toFixed(2) + '/' + (a.unit || 'g') : ' · 金价待更新');
  },
  market: function (a) {
    const n = (a.holdings || []).length;
    const d = a.valueUpdatedAt ? a.valueUpdatedAt.slice(5) : '';
    if (n) return n + ' 只持仓' + (d ? ' · ' + d + ' 收盘' : '');
    // 截图更新的账户：告诉你这个数是哪天截的，过了两周心里有数
    return (a.totalCost ? '成本 ' + M.cny(a.totalCost) : '') + (d ? ' · ' + d + ' 截图' : '');
  },
  appraisal: function (a) { return a.appraiseDate ? '估值于 ' + a.appraiseDate : ''; }
};

Page({
  data: {
    loaded: false, masked: false, liquidOpen: false, recvOpen: false, fixedOpen: false, debtOpen: false,
    headMode: 'liquid', locked: false, lockLabel: '面容 / 指纹'
  },

  onLoad() {
    this.authMode = '';
    const g = function (k) { try { return !!wx.getStorageSync(k); } catch (e) { return false; } };
    let hm = 'liquid';
    try { hm = wx.getStorageSync('headMode') === 'net' ? 'net' : 'liquid'; } catch (e) { /* ignore */ }
    const needLock = lock.isEnabled() && !getApp().globalData.unlocked;
    this.setData({
      masked: wx.getStorageSync('masked') || false,
      headMode: hm,
      locked: needLock,
      liquidOpen: g('liquidOpen'), recvOpen: g('recvOpen'), fixedOpen: g('fixedOpen'), debtOpen: g('debtOpen')
    });
  },

  /** 点大数字：可动用 ⇄ 净资产，占比条也跟着换成三层构成 */
  toggleHead() {
    const hm = this.data.headMode === 'net' ? 'liquid' : 'net';
    this.setData({ headMode: hm, curSegs: hm === 'net' ? this.data.layerSegs : this.data.segs });
    try { wx.setStorageSync('headMode', hm); } catch (e) { /* ignore */ }
  },

  toggle(key) {
    const open = !this.data[key];
    this.setData({ [key]: open });
    try { wx.setStorageSync(key, open); } catch (e) { /* ignore */ }
  },
  toggleLiquid() { this.toggle('liquidOpen'); },
  toggleRecv() { this.toggle('recvOpen'); },
  toggleFixed() { this.toggle('fixedOpen'); },
  toggleDebt() { this.toggle('debtOpen'); },

  onShow() {
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({ selected: 0 });
    }
    const app = getApp();
    if (lock.isEnabled() && !app.globalData.unlocked) {
      this.setData({ locked: true });
      this.checkAndPromptUnlock();
      return;
    }
    if (this.data.locked) this.setData({ locked: false });
    this.refresh();
  },

  checkAndPromptUnlock() {
    const self = this;
    if (this._unlocking) return;
    lock.checkSupport().then(function (info) {
      if (!info.supported) {
        // 换机或模拟器不支持生物识别时，不把用户锁在外面
        lock.setEnabled(false);
        getApp().globalData.unlocked = true;
        self.setData({ locked: false });
        self.refresh();
        return;
      }
      self.authMode = info.mode;
      self.setData({ lockLabel: info.label });
      self.doUnlock();
    });
  },

  doUnlock() {
    const self = this;
    if (this._unlocking) return;
    const go = function (mode) {
      self._unlocking = true;
      lock.authenticate(mode, '解锁查看家庭账本').then(function () {
        self._unlocking = false;
        getApp().globalData.unlocked = true;
        self.setData({ locked: false });
        self.refresh();
      }).catch(function () {
        self._unlocking = false;
      });
    };
    if (this.authMode) { go(this.authMode); return; }
    lock.checkSupport().then(function (info) {
      if (info.supported) {
        self.authMode = info.mode;
        self.setData({ lockLabel: info.label });
        go(info.mode);
      }
    });
  },

  onPullDownRefresh() {
    this.refresh(true).then(function () { wx.stopPullDownRefresh(); });
  },

  refresh(force) {
    const self = this;
    return Promise.all([load.loadAll(force), db.getConfig()]).then(function (r) {
      self.cfg = r[1] || {};
      self.render(r[0]);
    }).catch(function (e) {
      console.error(e);
      // 集合还没建、或者网络不通时，也要把页面画出来（全零），不能留一片空白
      self.render(load.build([], {}));
      wx.showToast({ title: '读不到数据库，先检查集合是否已建', icon: 'none', duration: 2500 });
    });
  },

  render(d) {
    const sum = d.sum, ctx = d.ctx, prices = d.prices;

    // 占比条：按计价方式归组，而不是按单笔资产，否则四张存单会切成四段
    const groups = {};
    sum.byLayer.liquid.forEach(function (it) {
      const t = load.tone(it.asset);
      if (!groups[t]) groups[t] = { tone: t, value: 0, name: GROUP_NAME[it.asset.mode] || '其他' };
      groups[t].value += it.val.value;
    });
    const segs = Object.keys(groups).map(function (k) { return groups[k]; })
      .filter(function (g) { return g.value > 0; })
      .sort(function (a, b) { return b.value - a.value; })
      .map(function (g) {
        const w = sum.liquid > 0 ? g.value / sum.liquid * 100 : 0;
        return { k: g.tone, tone: g.tone, name: g.name, w: w.toFixed(2), pc: Math.round(w) };
      });

    // 净资产模式下的占比条：三层构成
    const layerSegs = [
      { k: 'L', tone: 1, name: '可动用', v: sum.liquid },
      { k: 'R', tone: 3, name: '应收外债', v: sum.receivable },
      { k: 'F', tone: 4, name: '固定资产', v: sum.fixed }
    ].filter(function (x) { return x.v > 0; }).map(function (x) {
      const w = sum.net > 0 ? x.v / sum.net * 100 : 0;
      return { k: x.k, tone: x.tone, name: x.name, w: w.toFixed(2), pc: Math.round(w) };
    });

    // 首页提醒：90 天内到期存单（外债不进；已设自动转存/自动结清的静默；同一每月存单计划最多只显示最近 1 条）
    const mePlans = (getApp().globalData.me && getApp().globalData.me.plans) || [];
    const planMap = {};
    mePlans.forEach(function (p) { planMap[p.id] = p; });
    const rawDue = calc.dueItems(d.assets, ctx, { homeOnly: true, within: 90 });
    const planSeen = {};
    const alerts = [];
    rawDue.forEach(function (i) {
      const a = i.asset;
      const pl = a.planId ? planMap[a.planId] : null;
      const autoManaged = !!a.autoRenew || (pl && pl.onMature && pl.onMature !== 'manual');
      if (autoManaged) return;
      if (a.planId) {
        if (planSeen[a.planId]) { planSeen[a.planId].extraCount++; return; }
        const row = {
          id: a._id,
          name: (a.institution ? a.institution + ' · ' : '') + a.name,
          tag: i.days + ' 天后',
          dueDate: a.maturityDate,
          maturityText: M.cny(i.val.atMaturity),
          value: M.cny(i.val.value),
          extraCount: 0,
          extraSub: ''
        };
        planSeen[a.planId] = row;
        alerts.push(row);
        return;
      }
      alerts.push({
        id: a._id,
        name: a.name,
        tag: i.days + ' 天后',
        dueDate: a.maturityDate,
        maturityText: M.cny(i.val.atMaturity),
        value: M.cny(i.val.value),
        extraSub: ''
      });
    });
    alerts.forEach(function (row) {
      if (row.extraCount > 0) row.extraSub = '同计划近期还有 ' + row.extraCount + ' 张';
    });

    const liquidRows = load.groupByPlan(sum.byLayer.liquid).map(function (it) {
      if (it.group) {
        const a = it.asset;
        const soon = it.earliestDays !== null && it.earliestDays >= 0 && it.earliestDays <= 30;
        return {
          id: 'plan:' + it.planId, tone: load.tone(a),
          name: (a.institution ? a.institution + ' · ' : '') + a.name + ' × ' + it.count,
          sub: it.count + ' 张' + (it.earliest ? ' · 最近 ' + it.earliest + ' 到期' : ''),
          value: M.cny(it.value),
          delta: it.earliestDays === null ? '' : (it.earliestDays >= 0 ? '还有 ' + it.earliestDays + ' 天' : '已到期'),
          deltaClass: soon ? 'warnc' : 'flat'
        };
      }
      const a = it.asset, v = it.val;
      let delta = '', cls = 'flat';
      if (v.gainPct !== null && (a.mode === 'quantity' || a.mode === 'market')) {
        delta = M.pct(v.gainPct, 1);
        cls = v.gain > 0 ? 'up' : (v.gain < 0 ? 'down' : 'flat');   // 红涨绿跌
      } else if (a.mode === 'accrual' && v.daysToDue !== null) {
        delta = v.daysToDue >= 0 ? '还有 ' + v.daysToDue + ' 天' : '已到期';
        cls = (v.daysToDue >= 0 && v.daysToDue <= 30) ? 'warnc' : 'flat';
      } else if (a.mode === 'balance') {
        delta = '活期';
      }
      const subFn = MODE_SUB[a.mode];
      return {
        id: a._id, tone: load.tone(a),
        name: a.institution ? a.institution + ' · ' + a.name : a.name,
        sub: subFn ? subFn(a, v, prices) : '',
        value: M.cny(v.value), delta: delta, deltaClass: cls
      };
    }).sort(function (x, y) { return y.tone === x.tone ? 0 : x.tone - y.tone; });

    const CONF = { high: '把握 高', mid: '把握 中', low: '把握 低' };
    const recvRows = sum.byLayer.receivable.map(function (it) {
      const a = it.asset, v = it.val;
      let delta = '', cls = 'flat';
      if (v.daysToDue !== null) {
        if (v.daysToDue < 0) { delta = '已过 ' + (-v.daysToDue) + ' 天'; cls = 'od'; }
        else { delta = a.maturityDate; }
      }
      return { id: a._id, tone: 4, name: a.debtor || a.name,
               sub: (CONF[a.confidence] || '') + (a.evidence ? ' · ' + a.evidence : '') + (a.rate ? ' · 年息 ' + a.rate.toFixed(2) + '%' : ' · 无息'),
               value: M.cny(v.value), delta: delta, deltaClass: cls };
    });
    const fixedRows = sum.byLayer.fixed.map(function (it) {
      const a = it.asset, v = it.val;
      let sub = '', delta = '', cls = 'flat';
      if (a.depreciationRate > 0) {
        sub = (a.purchaseDate || '') + ' 购入 · 自动折旧';
        if (v.gainPct !== null) { delta = M.pct(v.gainPct, 1); cls = 'down'; }
      } else {
        sub = '估值于 ' + (a.appraiseDate || '—');
        if (v.staleDays !== null && v.staleDays > 180) { delta = '该更新了'; cls = 'warnc'; }
      }
      return { id: a._id, tone: 4, name: a.name, sub: sub, value: M.cny(v.value), delta: delta, deltaClass: cls };
    });

    const REPAY_NAME = { equalPayment: '等额本息', equalPrincipal: '等额本金', interestOnly: '先息后本' };
    const debtList = (sum.byLayer.liability || []);
    const debtRows = debtList.map(function (it) {
      const a = it.asset, v = it.val;
      const parts = [];
      if (a.rate) parts.push(a.rate.toFixed(2) + '%');
      if (a.remainingMonths > 0) {
        parts.push(REPAY_NAME[a.repayMethod] || '等额本息');
        parts.push(v.remainingMonths > 0 ? ('剩 ' + v.remainingMonths + ' 期') : '已还清');
      } else {
        parts.push('手动维护');
      }
      return {
        id: a._id, tone: 5,
        name: a.institution ? a.institution + ' · ' + a.name : a.name,
        sub: parts.join(' · '),
        value: '−' + M.cny(v.value),
        delta: v.monthlyPayment > 0 ? ('月供 ' + M.cny(v.monthlyPayment)) : ''
      };
    });

    const recvList = sum.byLayer.receivable;
    const overdue = recvList.filter(function (i) {
      return i.val.daysToDue !== null && i.val.daysToDue < 0;
    }).length;

    const stale = [];
    sum.items.forEach(function (it) {
      if (it.val.staleDays !== null && it.val.staleDays > 90) {
        stale.push(it.asset.name + '（' + it.val.staleDays + ' 天没更新）');
      }
    });

    // 退休计划一行：预计日期 + 还有多久
    let goalName = '', goalLine = '', goalPct = '';
    const saved = this.cfg || {};
    if (saved.goal && saved.goal.amount) {
      const cfg = Object.assign({}, F.DEFAULT_CFG, saved, { goldGrowth: 0 });
      const r = F.reachGoal(d.assets, cfg, ctx, saved.goal.amount, 480);
      goalName = saved.goal.name || '退休计划';
      goalPct = Math.min(100, sum.liquid / saved.goal.amount * 100).toFixed(1);
      if (r.reached) goalLine = '已经到了';
      else if (r.date) {
        const gd = calc.parseDate(r.date);
        goalLine = '预计 ' + gd.getFullYear() + ' 年 ' + (gd.getMonth() + 1) + ' 月 · 还有 ' + F.spanText(ctx.now, r.date).text;
      } else goalLine = '按现在的存法 40 年内到不了';
    }

    // 每月 10 分钟盘点入口
    const hasAssets = (d.assets || []).length > 0;
    const curMonth = CK.monthKey(ctx.now);
    const curMonthNum = ctx.now.getMonth() + 1;
    const me = getApp().globalData.me || {};
    const lastCk = me.lastCheckin || null;
    const ckDone = !!(lastCk && lastCk.month === curMonth);
    const ckCls = hasAssets ? CK.classifyForCheckin(sum, ctx.now, mePlans) : { todo: [] };
    let ckSub = '', ckDelta = '';
    if (ckDone) {
      if (lastCk.deltaLiquid !== null && lastCk.deltaLiquid !== undefined) {
        ckDelta = M.signed(lastCk.deltaLiquid);
        ckSub = (lastCk.date || '').slice(5) + ' 已存档';
      } else {
        ckSub = (lastCk.date || '').slice(5) + ' 已存档 · 点击查看月报';
      }
    } else {
      ckSub = ckCls.todo.length > 0
        ? ckCls.todo.length + ' 项待核对 · 花几分钟过一遍，生成本月报告'
        : '所有资产自动追踪中 · 点一下生成本月报告';
    }
    const checkin = {
      show: hasAssets,
      done: ckDone,
      title: ckDone ? (curMonthNum + ' 月已盘点') : (curMonthNum + ' 月家底盘点'),
      deltaText: ckDelta,
      sub: ckSub,
      badge: ckDone ? '看月报' : '去盘点'
    };

    // 目标配比状态条（仅在可动用视图下展示）
    const alRes = AL.analyze(sum, saved.allocation || null);
    let alloc = { show: false };
    if (sum.liquid > 0) {
      if (!alRes.configured) {
        alloc = { show: true, drifted: false, cls: 'quiet', text: '目标配比 · 还没设定', cta: '去设定' };
      } else if (alRes.balanced) {
        alloc = { show: true, drifted: false, cls: 'ok', text: '目标配比 · 均衡（±' + alRes.cfg.threshold + '% 内）', cta: '查看' };
      } else {
        alloc = {
          show: true,
          drifted: true,
          cls: alRes.maxDrift && alRes.maxDrift.status === 'alert' ? 'alert' : 'warn',
          text: alRes.headline,
          cta: '看配比'
        };
      }
    }

    this.setData({
      loaded: true,
      alloc: alloc,
      checkin: checkin,
      goalName: goalName, goalLine: goalLine, goalPct: goalPct,
      liquidText: M.yuan(sum.liquid),
      liquidCny: M.cny(sum.liquid),
      rateText: sum.weightedRate.toFixed(2) + '%',
      accruedText: M.cny(sum.accruedInterest),
      netCny: M.cny(sum.net),
      segs: segs,
      layerSegs: layerSegs,
      curSegs: this.data.headMode === 'net' ? layerSegs : segs,
      netText: M.yuan(sum.net),
      alerts: alerts,
      liquidRows: liquidRows,
      liquidSub: liquidRows.length + ' 项 · ' + segs.map(function (g) { return g.name + ' ' + g.pc + '%'; }).slice(0, 2).join(' · ')
                 + (segs.length > 2 ? ' …' : ''),
      recvRows: recvRows,
      fixedRows: fixedRows,
      debtRows: debtRows,
      recv: {
        show: recvList.length > 0,
        value: M.cny(sum.receivable),
        sub: recvList.length + ' 笔' + (overdue ? ' · 其中 ' + overdue + ' 笔已过约定日' : '')
      },
      fixed: {
        show: sum.byLayer.fixed.length > 0,
        value: M.cny(sum.fixed),
        sub: sum.byLayer.fixed.map(function (i) { return i.asset.name; }).join(' · ')
      },
      debt: {
        show: debtList.length > 0,
        value: '−' + M.cny(sum.liability),
        countText: debtList.length + ' 笔 · ' + debtList.map(function (i) { return i.asset.name; }).slice(0, 2).join('、'),
        monthlyText: sum.monthlyDebt > 0 ? M.cny(sum.monthlyDebt) : ''
      },
      staleNote: stale.length ? '这些该更新了：' + stale.join('，') : '',
      familyText: this.familyText(),
      bg: (getApp().globalData.me || {}).headerImage || ''
    });
  },

  /* ---------- 换背景 ---------- */
  pickBg() {
    const self = this;
    const items = ['从相册选一张', '拍一张'];
    if (this.data.bg) items.push('恢复默认');
    wx.showActionSheet({
      itemList: items,
      success(r) {
        if (r.tapIndex === 2) { self.applyBg(''); return; }
        wx.chooseMedia({
          count: 1, mediaType: ['image'], sizeType: ['compressed'],
          sourceType: [r.tapIndex === 0 ? 'album' : 'camera'],
          success(m) {
            const f = m.tempFiles && m.tempFiles[0];
            if (f) self.uploadBg(f.tempFilePath);
          }
        });
      }
    });
  },

  uploadBg(path) {
    const self = this;
    const fid = getApp().globalData.familyId || 'x';
    wx.showLoading({ title: '上传中', mask: true });
    wx.cloud.uploadFile({ cloudPath: 'bg/' + fid + '/' + Date.now() + '.jpg', filePath: path })
      .then(function (up) { return self.applyBg(up.fileID); })
      .catch(function (e) {
        wx.hideLoading();
        wx.showToast({ title: '没传上：' + String(e.errMsg || e), icon: 'none' });
      });
  },

  applyBg(fileID) {
    const self = this;
    if (!fileID) wx.showLoading({ title: '恢复中', mask: true });
    return db.setHeaderImage(fileID).then(function (me) {
      wx.hideLoading();
      getApp().globalData.me = me;
      self.setData({ bg: me.headerImage || '' });
    }).catch(function (e) {
      wx.hideLoading();
      wx.showToast({ title: String(e.message || e), icon: 'none' });
    });
  },

  familyText() {
    const me = getApp().globalData.me;
    const lockTag = lock.isEnabled() ? ' · 已开生物解锁' : '';
    if (!me) return '邀请家人一起看' + lockTag;
    if (me.memberCount > 1) return me.memberCount + ' 人共用 · ' + me.members.map(function (m) { return m.name; }).join('、') + lockTag;
    return '只有你一个人 · 邀请家人一起看' + lockTag;
  },

  toggleMask() {
    const m = !this.data.masked;
    this.setData({ masked: m });
    wx.setStorageSync('masked', m);
  },

  openDetail(e) {
    const id = String(e.currentTarget.dataset.id || '');
    if (id.indexOf('plan:') === 0) {
      wx.navigateTo({ url: '/pages/edit/edit?plan=' + id.slice(5) });   // 合并行 → 计划页
      return;
    }
    wx.navigateTo({ url: '/pages/edit/edit?id=' + id });
  },

  goForecast() { wx.switchTab({ url: '/pages/forecast/forecast' }); },
  goAdd() { wx.navigateTo({ url: '/pages/edit/edit' }); },
  goCheckin() { wx.navigateTo({ url: '/pages/checkin/checkin' }); },
  goAllocation() {
    if (this.data.headMode === 'net') return;
    wx.navigateTo({ url: '/pages/allocation/allocation' });
  },

  goFamily() {
    wx.navigateTo({ url: '/pages/family/family' });
  }
});
