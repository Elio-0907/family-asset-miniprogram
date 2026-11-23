// ⚠️ 用之前必须改这里：填你自己的云开发环境 ID
// 微信开发者工具 → 云开发 → 设置 → 环境 ID，形如 'cloud1-xxxxxxxx'
module.exports = {
  ENV_ID: 'REPLACE_WITH_YOUR_CLOUD_ENV_ID',

  // 金价数据源的 key，和 market_data 集合里的 _id 对应
  GOLD_KEY: 'gold_au9999',

  // 活期年利率(%)，用于估算存单提前支取能拿多少
  CURRENT_RATE: 0.20
};
