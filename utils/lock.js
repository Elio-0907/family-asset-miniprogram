// 生物解锁（苹果面容 ID / 指纹）封装。
// 原则：
//   1. 默认关闭，开启前必须先实测通过一次硬件验证，确保不会把不支持的设备锁死。
//   2. 从相册选图等短时切后台（< 60 秒）不重复弹窗，真正切走再回来或冷启动才验。

const KEY = 'bioLock';
const REAUTH_MS = 60 * 1000;

function isEnabled() {
  try { return !!wx.getStorageSync(KEY); } catch (e) { return false; }
}

function setEnabled(on) {
  try { wx.setStorageSync(KEY, !!on); } catch (e) { /* ignore */ }
}

function checkSupport() {
  return new Promise(function (resolve) {
    if (!wx.checkIsSupportSoterAuthentication) {
      return resolve({ supported: false, mode: '', label: '生物识别' });
    }
    wx.checkIsSupportSoterAuthentication({
      success(res) {
        const modes = (res && res.supportMode) || [];
        if (modes.indexOf('facial') >= 0) {
          return resolve({ supported: true, mode: 'facial', label: '面容 ID' });
        }
        if (modes.indexOf('fingerPrint') >= 0) {
          return resolve({ supported: true, mode: 'fingerPrint', label: '指纹' });
        }
        resolve({ supported: false, mode: '', label: '生物识别' });
      },
      fail() {
        resolve({ supported: false, mode: '', label: '生物识别' });
      }
    });
  });
}

function authenticate(mode, reason) {
  return new Promise(function (resolve, reject) {
    if (!wx.startSoterAuthentication || !mode) {
      return reject(new Error('当前设备不支持面容或指纹解锁'));
    }
    wx.startSoterAuthentication({
      requestAuthModes: [mode],
      challenge: 'jiadi_' + Date.now(),
      authContent: reason || '验证身份以查看家底',
      success() { resolve(true); },
      fail(err) { reject(err || new Error('验证取消或失败')); }
    });
  });
}

module.exports = {
  REAUTH_MS: REAUTH_MS,
  isEnabled: isEnabled,
  setEnabled: setEnabled,
  checkSupport: checkSupport,
  authenticate: authenticate
};
