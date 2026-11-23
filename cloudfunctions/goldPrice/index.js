// 每天抓一次金价写进 market_data。
//
// 为什么放云函数而不是小程序前端：前端发 HTTP 请求要配「request 合法域名」，
// 需要备案域名，很烦；云函数跑在服务端，想请求谁请求谁。
// 将来要加任何外部数据（汇率、基金净值）都走这条路。

const cloud = require('wx-server-sdk');
const https = require('https');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

const SOURCES = [
  { key: 'gold_au9999', code: 'gds_AU9999', label: '上金所 Au99.99' }
];

function fetchSina(code) {
  return new Promise((resolve, reject) => {
    const req = https.get({
      hostname: 'hq.sinajs.cn',
      path: '/list=' + code,
      headers: {
        // 没有这个头新浪直接返回 Forbidden
        'Referer': 'https://finance.sina.com.cn',
        'User-Agent': 'Mozilla/5.0'
      },
      timeout: 8000
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        // 响应是 GBK，但我们要的价格和日期都是 ASCII，按 latin1 读不影响解析，
        // 这样就不用为了一个数字引入 iconv 依赖。
        resolve(Buffer.concat(chunks).toString('latin1'));
      });
    });
    req.on('timeout', () => req.destroy(new Error('请求超时')));
    req.on('error', reject);
  });
}

function parse(text) {
  const m = text.match(/="([^"]*)"/);
  if (!m || !m[1]) return null;
  const f = m[1].split(',');
  const price = Number(f[0]);            // 最新价，元/克
  const quoteDate = f[12] || '';         // 行情日期
  if (!isFinite(price) || price <= 0) return null;
  return { price: Math.round(price * 100), quoteDate };   // 存「分/克」
}

exports.main = async () => {
  const results = [];

  for (const s of SOURCES) {
    try {
      const text = await fetchSina(s.code);
      const p = parse(text);
      if (!p) throw new Error('解析不出价格：' + text.slice(0, 80));

      const doc = {
        price: p.price,
        unit: 'g',
        source: s.label,
        quoteDate: p.quoteDate,
        updatedAt: new Date(),
        error: null
      };

      // 留一点历史，将来画金价曲线用得上
      let history = [];
      try {
        const old = await db.collection('market_data').doc(s.key).get();
        history = (old.data && old.data.history) || [];
      } catch (e) { /* 第一次跑，文档还不存在 */ }

      if (!history.length || history[history.length - 1].date !== p.quoteDate) {
        history.push({ date: p.quoteDate, price: p.price });
      } else {
        history[history.length - 1].price = p.price;
      }
      doc.history = history.slice(-90);

      await db.collection('market_data').doc(s.key).set({ data: doc });
      results.push({ key: s.key, price: p.price / 100, quoteDate: p.quoteDate, ok: true });
    } catch (e) {
      // 抓不到就保留上一次的价格，只记下错误。
      // 宁可显示一个「3 天前」的旧价格，也不要把资产变成 0。
      try {
        await db.collection('market_data').doc(s.key).update({
          data: { error: String(e.message || e), errorAt: new Date() }
        });
      } catch (e2) { /* ignore */ }
      results.push({ key: s.key, ok: false, error: String(e.message || e) });
    }
  }

  return { results };
};
