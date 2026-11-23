// 录入表单的字段定义。加新资产类型时，只要它能归进这五种计价方式之一，
// 就只用改这个文件，不用碰页面逻辑。

const RULE_OPTIONS = ['到期一次性还本付息', '按年付息'];
const RULE_VALUES = ['atMaturity', 'annual'];
const CONF_OPTIONS = ['高', '中', '低'];
const CONF_VALUES = ['high', 'mid', 'low'];
const REPAY_OPTIONS = ['等额本息', '等额本金', '先息后本'];
const REPAY_VALUES = ['equalPayment', 'equalPrincipal', 'interestOnly'];
const COMMON = [
  { k: 'name', label: '名称', type: 'text', ph: '给它起个你认得出的名字' }
];

const SCHEMA = {
  accrual: {
    label: '计息型',
    hint: '本金 + 利率 + 起止日期。录一次就不用再碰——价值和已赚利息每天自动往前推。' +
          '大额存单和借出去的钱都走这套，区别只在归属层级。',
    layers: [
      { v: 'liquid', t: '可动用（存单、国债）' },
      { v: 'receivable', t: '应收（借出去的钱）' }
    ],
    fields: [
      { k: 'institution', label: '机构', type: 'text', ph: '招商银行', when: 'liquid' },
      { k: 'debtor', label: '借款人', type: 'text', ph: '张三', when: 'receivable' },
      { k: 'principal', label: '本金', type: 'money', unit: '元' },
      { k: 'rate', label: '年利率', type: 'rate', unit: '%', ph: '无息填 0' },
      { k: 'startDate', label: '起息日', type: 'date' },
      { k: 'maturityDate', label: '到期日', type: 'date' },
      { k: 'interestRule', label: '计息方式', type: 'select',
        options: RULE_OPTIONS, values: RULE_VALUES, when: 'liquid' },
      { k: 'autoRenew', label: '到期自动转存', type: 'switch', when: 'liquid',
        hint: '银行设了自动转存就打开，到期当天程序自动续同期限' },
      { k: 'evidence', label: '凭证', type: 'text', ph: '借条 / 转账记录', when: 'receivable' },
      { k: 'confidence', label: '收回把握', type: 'select',
        options: CONF_OPTIONS, values: CONF_VALUES, when: 'receivable' }
    ]
  },

  balance: {
    label: '余额型',
    hint: '只有一个当前余额，想起来改一次就行。适合余额宝、活期、公积金——本来也没有精确记账的必要。',
    layers: [{ v: 'liquid', t: '可动用' }],
    fields: [
      { k: 'institution', label: '机构', type: 'text', ph: '支付宝' },
      { k: 'balance', label: '当前余额', type: 'money', unit: '元' },
      { k: 'refRate', label: '参考年化', type: 'rate', unit: '%', ph: '选填' },
      { k: 'recurringAmount', label: '每月自动存入', type: 'money', unit: '元', ph: '不需要就空着' },
      { k: 'recurringDay', label: '每月几号', type: 'number', unit: '日', ph: '1' }
    ]
  },

  quantity: {
    label: '计量型',
    hint: '数量 × 单价。你只需要维护克数（几乎不变），单价由云函数每天自动更新。' +
          '将来记外币现金也是同一套。',
    layers: [{ v: 'liquid', t: '可动用' }],
    fields: [
      { k: 'quantity', label: '持有数量', type: 'number', unit: 'g' },
      { k: 'priceKey', label: '单价来源', type: 'readonly', ph: '上金所 Au99.99（自动）' },
      { k: 'costPrice', label: '买入单价', type: 'money', unit: '元/g', ph: '当时多少钱一克' }
    ]
  },

  market: {
    label: '市值型',
    hint: '录持仓（代码 + 股数），每个交易日 15:40 自动按收盘价算市值，你只在买卖后改股数。' +
          '不看逐只盈亏——看盘交给券商 App，这里只回答「我一共有多少钱」。',
    layers: [{ v: 'liquid', t: '可动用' }],
    fields: [
      { k: 'institution', label: '券商', type: 'text', ph: '中信证券' },
      { k: 'cash', label: '账户现金', type: 'money', unit: '元', ph: '买卖后记得改' },
      { k: 'totalCost', label: '累计净转入', type: 'money', unit: '元', ph: '转入减转出，买卖不用改' },
      { k: 'marketValue', label: '账户市值', type: 'money', unit: '元', ph: '录了持仓会自动算' }
    ]
  },

  appraisal: {
    label: '估值型',
    hint: '房子手填估值、一年更新一次；车子只填买入价和折旧率，之后自动往下走——' +
          '手动填的话，人是舍不得把自己的车往下调的。',
    layers: [{ v: 'fixed', t: '固定资产' }],
    fields: [
      { k: 'appraisedValue', label: '当前估值', type: 'money', unit: '元', ph: '房子填这个' },
      { k: 'appraiseDate', label: '估值日期', type: 'date' },
      { k: 'purchasePrice', label: '购入价', type: 'money', unit: '元', ph: '车子填这两个' },
      { k: 'purchaseDate', label: '购入日期', type: 'date' },
      { k: 'depreciationRate', label: '年折旧率', type: 'rate', unit: '%', ph: '填了就自动折旧' }
    ]
  },

  loan: {
    label: '负债',
    hint: '房贷、车贷填剩余本金 + 利率 + 剩余期数，每月自动递减剩余本金、算出月供和剩余利息；' +
          '简单欠款把期数留空即可。负债会从净资产扣除，不影响首页可动用金融资产。',
    layers: [{ v: 'liability', t: '负债' }],
    fields: [
      { k: 'institution', label: '机构', type: 'text', ph: '招商银行 / 公积金' },
      { k: 'principal', label: '剩余本金', type: 'money', unit: '元', ph: '看银行 App 贷款详情' },
      { k: 'rate', label: '年利率', type: 'rate', unit: '%', ph: '3.30（无息填 0）' },
      { k: 'remainingMonths', label: '剩余期数', type: 'number', unit: '月', ph: '如 240（简单欠款留空）' },
      { k: 'repayMethod', label: '还款方式', type: 'select', options: REPAY_OPTIONS, values: REPAY_VALUES },
      { k: 'startDate', label: '基准日期', type: 'date' }
    ]
  }
};

const MONEY_KEYS = ['principal', 'balance', 'costTotal', 'costPrice', 'marketValue', 'totalCost', 'cash', 'recurringAmount',
                    'appraisedValue', 'purchasePrice'];
const NUMBER_KEYS = ['rate', 'refRate', 'quantity', 'depreciationRate', 'recurringDay', 'remainingMonths'];

module.exports = {
  SCHEMA: SCHEMA, COMMON: COMMON,
  MONEY_KEYS: MONEY_KEYS, NUMBER_KEYS: NUMBER_KEYS,
  ORDER: ['accrual', 'balance', 'quantity', 'market', 'appraisal', 'loan']
};
