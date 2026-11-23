const db = require('../../utils/db.js');
const lock = require('../../utils/lock.js');

Page({
  data: {
    me: null, joinCode: '', joinName: '', fromCard: false,
    bioLock: false, bioSupported: false, bioLabel: '面容 / 指纹'
  },

  onLoad(q) {
    if (q && q.code) {
      this.setData({ joinCode: String(q.code).toUpperCase(), fromCard: true });
    }
    this.authMode = '';
    this.initBio();
    this.refresh();
  },

  initBio() {
    const self = this;
    const enabled = lock.isEnabled();
    this.setData({ bioLock: enabled });
    lock.checkSupport().then(function (info) {
      self.authMode = info.mode;
      self.setData({
        bioSupported: info.supported,
        bioLabel: info.supported ? info.label : '面容 / 指纹'
      });
    });
  },

  onToggleBio(e) {
    const want = !!e.detail.value;
    if (!want) {
      lock.setEnabled(false);
      getApp().globalData.unlocked = true;
      this.setData({ bioLock: false });
      wx.showToast({ title: '已关闭生物解锁', icon: 'none' });
      return;
    }
    const self = this;
    lock.authenticate(this.authMode, '验证一次以开启' + this.data.bioLabel + '解锁')
      .then(function () {
        lock.setEnabled(true);
        getApp().globalData.unlocked = true;
        self.setData({ bioLock: true });
        wx.showToast({ title: '已开启' + self.data.bioLabel + '解锁', icon: 'none' });
      })
      .catch(function () {
        self.setData({ bioLock: false });
        wx.showToast({ title: '验证未通过，未开启', icon: 'none' });
      });
  },

  refresh() {
    const self = this;
    return db.me().then(function (me) {
      self.apply(me);
    }).catch(function (e) {
      wx.showToast({ title: String(e.message || e), icon: 'none' });
    });
  },

  apply(me) {
    const app = getApp();
    app.globalData.me = me;
    app.globalData.familyId = me.familyId;
    wx.setStorageSync('familyId', me.familyId);
    this.setData({ me: me });
  },

  /* 分享卡片：家人点开直接进这一页并带上邀请码 */
  onShareAppMessage() {
    const code = this.data.me && this.data.me.inviteCode;
    return {
      title: '来看看我们家的账本',
      path: '/pages/family/family' + (code ? '?code=' + code : ''),
      imageUrl: ''
    };
  },

  onInvite() {
    const self = this;
    wx.showLoading({ title: '生成中' });
    db.invite().then(function (me) {
      wx.hideLoading();
      self.apply(me);
    }).catch(function (e) {
      wx.hideLoading();
      wx.showToast({ title: String(e.message || e), icon: 'none' });
    });
  },

  onRename() {
    const self = this;
    const cur = (this.data.me.members.filter(function (m) { return m.isMe; })[0] || {}).name || '';
    wx.showModal({
      title: '你在家里叫什么', editable: true, placeholderText: '老公 / 老婆 / 名字', content: cur,
      success(r) {
        if (!r.confirm || !r.content) return;
        db.rename(r.content).then(function (me) { self.apply(me); })
          .catch(function (e) { wx.showToast({ title: String(e.message || e), icon: 'none' }); });
      }
    });
  },

  onJoinCode(e) { this.setData({ joinCode: e.detail.value.toUpperCase() }); },
  onJoinName(e) { this.setData({ joinName: e.detail.value }); },

  onJoin() {
    const self = this;
    const code = this.data.joinCode.trim(), name = this.data.joinName.trim();
    if (code.length !== 6) { wx.showToast({ title: '邀请码是 6 位', icon: 'none' }); return; }
    if (!name) { wx.showToast({ title: '填个称呼', icon: 'none' }); return; }
    wx.showLoading({ title: '加入中' });
    db.join(code, name).then(function (me) {
      wx.hideLoading();
      self.apply(me);
      getApp().invalidate();
      self.setData({ fromCard: false, joinCode: '', joinName: '' });
      wx.showModal({
        title: '加入成功', content: '现在你看到的就是这个家庭的账本了', showCancel: false,
        success() { wx.switchTab({ url: '/pages/home/home' }); }
      });
    }).catch(function (e) {
      wx.hideLoading();
      wx.showModal({ title: '没加进去', content: String(e.message || e), showCancel: false });
    });
  },

  onRemove(e) {
    const me = this.data.me;
    if (!me || !me.isOwner) return;
    const i = Number(e.currentTarget.dataset.i);
    const m = me.members[i];
    if (!m || m.isMe) return;
    const self = this;
    wx.showModal({
      title: '移除 ' + m.name + '？', content: '对方将看不到这份账本。已经录的数据保留。',
      success(r) {
        if (!r.confirm) return;
        db.removeMember(i).then(function (me2) { self.apply(me2); })
          .catch(function (e2) { wx.showToast({ title: String(e2.message || e2), icon: 'none' }); });
      }
    });
  },

  onLeave() {
    const self = this;
    wx.showModal({
      title: '退出这个家庭？', content: '退出后你会回到自己的空账本。',
      success(r) {
        if (!r.confirm) return;
        db.leave().then(function (me) {
          self.apply(me);
          getApp().invalidate();
          wx.switchTab({ url: '/pages/home/home' });
        }).catch(function (e) { wx.showToast({ title: String(e.message || e), icon: 'none' }); });
      }
    });
  }
});
