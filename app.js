const CONFIG = require('./config.js');
const lock = require('./utils/lock.js');

App({
  globalData: {
    openid: '',
    familyId: '',
    prices: {},
    me: null,
    assetsCache: null,
    cacheAt: 0,
    unlocked: false,
    hiddenAt: 0
  },

  onHide() {
    this.globalData.hiddenAt = Date.now();
  },

  onShow() {
    // 离开超过 60 秒后回来，若开了面容/指纹锁则重新要求验证；短时选截图不打扰
    if (lock.isEnabled() && this.globalData.hiddenAt &&
        Date.now() - this.globalData.hiddenAt > lock.REAUTH_MS) {
      this.globalData.unlocked = false;
    }
  },

  onLaunch() {
    if (!wx.cloud) {
      wx.showModal({
        title: '基础库版本过低',
        content: '请在开发者工具里把基础库调到 2.2.3 以上',
        showCancel: false
      });
      return;
    }
    if (CONFIG.ENV_ID === 'REPLACE_WITH_YOUR_CLOUD_ENV_ID') {
      wx.showModal({
        title: '还没配置云环境',
        content: '打开项目根目录的 config.js，把 ENV_ID 换成你自己的云开发环境 ID',
        showCancel: false
      });
      return;
    }
    wx.cloud.init({ env: CONFIG.ENV_ID, traceUser: true });
    this.ready = this.initIdentity();
  },

  initIdentity() {
    const g = this.globalData;
    // 先用缓存把页面撑起来，再问云端拿最新的（家人加入/退出后 familyId 会变）
    g.openid = wx.getStorageSync('openid') || '';
    g.familyId = wx.getStorageSync('familyId') || g.openid;
    return wx.cloud.callFunction({ name: 'api', data: { action: 'me' } })
      .then((r) => {
        const me = r.result || {};
        if (me.error) throw new Error(me.error);
        g.openid = me.openid;
        g.familyId = me.familyId;
        g.me = me;
        wx.setStorageSync('openid', g.openid);
        wx.setStorageSync('familyId', g.familyId);
        return g;
      })
      .catch(() => {
        // 拿不到身份也不该让页面白屏，用缓存或本地模式
        g.familyId = g.familyId || 'local';
        return g;
      });
  },

  whenReady() {
    return this.ready || this.initIdentity();
  },

  /** 资产列表带个短缓存，切 tab 时不用每次都打数据库 */
  invalidate() {
    this.globalData.assetsCache = null;
  }
});
