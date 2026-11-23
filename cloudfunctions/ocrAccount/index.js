// 账户截图智能识别（支持支付宝/余额截图 + 券商总览/持仓截图）。
//
// 双引擎：
//   1. 多模态 AI 识图（推荐）：在云函数环境变量配 AI_API_KEY 即可启用，
//      兼容通义千问 Qwen-VL / 智谱 GLM-4V / 豆包视觉 / OpenAI 等任意 OpenAI 兼容接口。
//      不仅认支付宝各子项（总资产/余额宝/基金/理财），还能认券商持仓明细（代码+股数）。
//   2. 腾讯云 OCR（兜底）：未配 AI_API_KEY 时自动使用 TENCENT_SECRET_ID / TENCENT_SECRET_KEY。
//
// 隐私：截图从你自己的云存储读出后立即删除，无论成功或失败都不留原图，只返回数字。

const cloud = require('wx-server-sdk');
const https = require('https');
const http = require('http');
const { URL } = require('url');
const P = require('./lib/ocrparse.js');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const DEFAULT_AI_BASE = 'https://dashscope.aliyuncs.com/compatible-mode/v1';
const DEFAULT_AI_MODEL = 'qwen-vl-plus';

function detectMime(buf) {
  if (!buf || buf.length < 12) return 'image/jpeg';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return 'image/jpeg';
}

function buildPrompt(scene) {
  if (scene === 'balance') {
    return [
      '你是个人家庭资产台账的识图助手。请读取这张手机截屏（通常是支付宝总资产/余额宝、微信零钱/零钱通或银行活期页面）。',
      '请严格只输出一个 JSON 对象，不要输出任何额外文字或解释，字段定义如下：',
      '{',
      '  "platform": "平台或银行名称，如 支付宝 / 微信 / 招商银行，看不出就留空字符串",',
      '  "total": 页面主金额或总资产的数字（人民币元，不要引号和逗号；如果被星号隐藏或看不出就填 null）,',
      '  "items": [',
      '    { "label": "项目名称（如 总资产 / 余额宝 / 余额 / 基金 / 理财 / 定期 / 余利宝 / 黄金 / 零钱通）", "amount": 数字 }',
      '  ]',
      '}',
      '要求：',
      '1. 如果截屏里同时有「总资产」和下面的分项（如余额宝、基金、理财、余额），请全部放进 items，把总资产放第一位。',
      '2. 不要把收益、涨跌幅、百分比或昨日收益当成资产余额。',
      '3. 被 **** 遮住的数字不要猜测，直接跳过。'
    ].join('\n');
  }

  return [
    '你是个人家庭资产台账的识图助手。请读取这张券商 App 资产总览或持仓列表截屏。',
    '请严格只输出一个 JSON 对象，不要输出任何额外文字或解释，字段定义如下：',
    '{',
    '  "platform": "券商或App名称，如 中信证券 / 华泰证券 / 东方财富 / 同花顺，看不出留空字符串",',
    '  "total": 账户总资产数字（元，看不出填 null）,',
    '  "pnl": 总盈亏/持仓盈亏/累计盈亏数字（元，亏损为负数，看不出填 null；不要把当日盈亏当总盈亏，除非图上只有当日盈亏）,',
    '  "market": 总市值/持仓市值数字（元，看不出填 null）,',
    '  "cash": 可用/可用资金数字（元，看不出填 null）,',
    '  "holdings": [',
    '    { "code": "6位A股/ETF代码或5位港股代码，若图上没写代码但你能明确确定该名称对应的标准代码请补全，不确定则留空字符串", "name": "股票或ETF名称", "shares": 持仓股数（正数，取持仓数不是可用数） }',
    '  ]',
    '}',
    '要求：',
    '1. 所有金额和股数均为纯数字，不要带逗号、元或引号。',
    '2. 如果截屏里没有个股持仓列表，holdings 返回空数组 []。',
    '3. 被 **** 遮住的数字不要猜测，填 null。'
  ].join('\n');
}

function postJson(endpoint, apiKey, payload, timeoutMs) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(endpoint); } catch (e) { return reject(new Error('AI_BASE_URL 格式无效：' + endpoint)); }
    const mod = u.protocol === 'http:' ? http : https;
    const body = Buffer.from(JSON.stringify(payload), 'utf8');
    const req = mod.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'http:' ? 80 : 443),
      path: u.pathname + u.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + apiKey,
        'Content-Length': body.length
      },
      timeout: timeoutMs || 25000
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch (e) { /* keep text */ }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const msg = (json && json.error && (json.error.message || json.error.code)) || text.slice(0, 180);
          return reject(new Error('AI 接口返回 ' + res.statusCode + '：' + msg));
        }
        resolve(json || text);
      });
    });
    req.on('timeout', () => req.destroy(new Error('AI 识图超时，请重试或换一张更小的截图')));
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function recognizeByAi(buf, scene) {
  const apiKey = (process.env.AI_API_KEY || '').trim();
  const baseUrl = (process.env.AI_BASE_URL || DEFAULT_AI_BASE).trim().replace(/\/+$/, '');
  const model = (process.env.AI_MODEL || DEFAULT_AI_MODEL).trim();
  const endpoint = /\/chat\/completions$/i.test(baseUrl) ? baseUrl : baseUrl + '/chat/completions';

  const mime = detectMime(buf);
  const dataUrl = 'data:' + mime + ';base64,' + buf.toString('base64');

  const resp = await postJson(endpoint, apiKey, {
    model: model,
    temperature: 0,
    max_tokens: 1500,
    messages: [{
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: dataUrl } },
        { type: 'text', text: buildPrompt(scene) }
      ]
    }]
  }, 24000);

  const choice = resp && resp.choices && resp.choices[0];
  let content = choice && choice.message && choice.message.content;
  if (Array.isArray(content)) {
    content = content.map((c) => (typeof c === 'string' ? c : (c && c.text) || '')).join('\n');
  }
  const parsed = P.normalizeAiResult(content, scene);
  return Object.assign({}, parsed, { engine: 'ai', model: model });
}

async function recognizeByTencentOcr(buf, scene) {
  const secretId = (process.env.TENCENT_SECRET_ID || '').trim();
  const secretKey = (process.env.TENCENT_SECRET_KEY || '').trim();
  const tencentcloud = require('tencentcloud-sdk-nodejs-ocr');
  const OcrClient = tencentcloud.ocr.v20181119.Client;
  const client = new OcrClient({
    credential: { secretId, secretKey },
    region: process.env.TENCENT_REGION || 'ap-shanghai',
    profile: { httpProfile: { endpoint: 'ocr.tencentcloudapi.com', reqTimeout: 15 } }
  });
  const res = await client.GeneralBasicOCR({
    ImageBase64: buf.toString('base64'),
    LanguageType: 'zh'
  });
  const blocks = (res.TextDetections || []).map((d) => ({
    text: d.DetectedText,
    x: d.ItemPolygon.X, y: d.ItemPolygon.Y, w: d.ItemPolygon.Width, h: d.ItemPolygon.Height
  }));
  const parsed = P.parseAccount(blocks, scene);
  const ok = scene === 'balance'
    ? (parsed.total !== null || (parsed.items && parsed.items.length > 0))
    : parsed.total !== null;
  return {
    ok: ok,
    engine: 'ocr',
    platform: parsed.platform || '',
    total: parsed.total,
    pnl: parsed.pnl,
    market: parsed.market,
    cash: parsed.cash,
    netIn: parsed.netIn,
    items: parsed.items || [],
    holdings: [],
    hits: parsed.hits,
    lines: blocks.length,
    sample: !ok ? blocks.slice(0, 25).map((b) => b.text) : undefined
  };
}

exports.main = async (event) => {
  event = event || {};
  const fileID = event.fileID;
  const scene = event.scene === 'balance' ? 'balance' : 'market';
  if (!fileID) return { ok: false, error: '缺 fileID' };

  const hasAi = !!(process.env.AI_API_KEY && process.env.AI_API_KEY.trim());
  const hasOcr = !!(process.env.TENCENT_SECRET_ID && process.env.TENCENT_SECRET_KEY);

  let result;
  try {
    if (!hasAi && !hasOcr) {
      throw new Error(
        '还没配识图密钥：云函数 ocrAccount → 配置 → 环境变量，' +
        '推荐配 AI_API_KEY（支持通义千问/智谱GLM-4V/豆包视觉），或配 TENCENT_SECRET_ID + TENCENT_SECRET_KEY'
      );
    }

    const dl = await cloud.downloadFile({ fileID });
    const buf = dl.fileContent;

    if (hasAi) {
      try {
        result = await recognizeByAi(buf, scene);
      } catch (aiErr) {
        // 如果同时配了腾讯云 OCR，AI 异常时自动兜底，不耽误使用
        if (hasOcr) {
          result = await recognizeByTencentOcr(buf, scene);
          result.fallbackNote = 'AI 识图暂不可用，已自动改用 OCR';
        } else {
          throw aiErr;
        }
      }
    } else {
      result = await recognizeByTencentOcr(buf, scene);
    }
  } catch (e) {
    result = { ok: false, error: String(e.message || e) };
  } finally {
    // 不管成功失败，图片都删掉
    try { await cloud.deleteFile({ fileList: [fileID] }); } catch (e) { /* ignore */ }
  }
  return result;
};
