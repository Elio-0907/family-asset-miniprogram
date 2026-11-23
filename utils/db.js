// 所有数据读写都走 api 云函数。云函数按「你所在的家庭」放行，
// 家人看到同一份账本，外人一律看不见。数据库集合权限可以保持最严。
//
// 页面调用的函数名和以前一样，页面代码不用改。

const ASSET = 'asset';
const MARKET = 'market_data';
const SNAPSHOT = 'snapshot';
const CONFIG = 'forecast_config';

function call(action, data) {
  return wx.cloud.callFunction({ name: 'api', data: Object.assign({ action: action }, data || {}) })
    .then(function (r) {
      const res = r && r.result;
      if (!res) throw new Error('云函数没有返回');
      if (res.error) throw new Error(res.error);
      return res;
    });
}

function familyId() {
  const app = getApp();
  return (app && app.globalData && app.globalData.familyId) || '';
}

/* ---------- 身份与家庭 ---------- */
function me() { return call('me'); }
function rename(name) { return call('rename', { name: name }); }
function invite() { return call('invite'); }
function join(code, name) { return call('join', { code: code, name: name }); }
function removeMember(index) { return call('remove', { index: index }); }
function leave() { return call('leave'); }
function setHeaderImage(fileID) { return call('setHeaderImage', { fileID: fileID }); }
function savePlan(plan) { return call('savePlan', { plan: plan }); }
function deletePlan(id) { return call('deletePlan', { id: id }); }
function planAdjust(id, delta) { return call('planAdjust', { id: id, delta: delta }); }

/* ---------- 资产 ---------- */
function listAssets() { return call('listAssets').then(function (r) { return r.list; }); }
function getAsset(id) { return call('getAsset', { id: id }).then(function (r) { return r.asset; }); }
function addAsset(doc) { return call('addAsset', { doc: doc }); }
function updateAsset(id, doc) { return call('updateAsset', { id: id, doc: doc }); }
/** 不做物理删除，改状态。账本里的东西删了就找不回来了。 */
function closeAsset(id) { return call('closeAsset', { id: id }); }
function rollover(id, o) { return call('rollover', Object.assign({ id: id }, o || {})); }

/* ---------- 配置 / 快照 / 行情 ---------- */
function getPrices() {
  return call('getPrices').then(function (r) { return r.prices || {}; }).catch(function () { return {}; });
}
function getConfig() {
  return call('getConfig').then(function (r) { return r.config; }).catch(function () { return null; });
}
function saveConfig(cfg) { return call('saveConfig', { config: cfg }); }
function saveAllocation(allocation) { return call('saveAllocation', { allocation: allocation }); }
function listSnapshots(limit) {
  return call('listSnapshots', { limit: limit || 365 })
    .then(function (r) { return r.list; }).catch(function () { return []; });
}
function finishCheckin(note) { return call('finishCheckin', { note: note || '' }); }

module.exports = {
  ASSET: ASSET, MARKET: MARKET, SNAPSHOT: SNAPSHOT, CONFIG: CONFIG,
  call: call, familyId: familyId,
  me: me, rename: rename, invite: invite, join: join, removeMember: removeMember, leave: leave, setHeaderImage: setHeaderImage, savePlan: savePlan, deletePlan: deletePlan, planAdjust: planAdjust,
  listAssets: listAssets, getAsset: getAsset, addAsset: addAsset, updateAsset: updateAsset, closeAsset: closeAsset, rollover: rollover,
  getPrices: getPrices, getConfig: getConfig, saveConfig: saveConfig, saveAllocation: saveAllocation, listSnapshots: listSnapshots, finishCheckin: finishCheckin
};
