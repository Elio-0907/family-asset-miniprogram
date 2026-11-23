// 校验 wxml 里 bind*/catch* 绑定的方法在对应的 js 里确实存在
const fs = require('fs'), path = require('path');
let bad = 0, total = 0;

function check(wxml, js, label) {
  const t = fs.readFileSync(wxml, 'utf8');
  const s = fs.readFileSync(js, 'utf8');
  const names = new Set();
  const re = /\b(?:bind|catch)(?::)?([a-zA-Z]+)\s*=\s*"([a-zA-Z_$][\w$]*)"/g;
  let m;
  while ((m = re.exec(t))) names.add(m[2]);
  names.forEach((n) => {
    total++;
    // 页面里写成 `n(` 或 `n:` 或 `n (` 都算定义了
    const defined = new RegExp('(^|[\\s,{])' + n + '\\s*[(:]').test(s);
    if (!defined) { console.log('  ✗ ' + label + ' → ' + n + ' 没有定义'); bad++; }
  });
}

[['pages/home/home', 'home'], ['pages/due/due', 'due'], ['pages/assets/assets', 'assets'],
 ['pages/forecast/forecast', 'forecast'], ['pages/edit/edit', 'edit'],
 ['pages/family/family', 'family'], ['pages/checkin/checkin', 'checkin'],
 ['pages/allocation/allocation', 'allocation']].forEach(([base, label]) => {
  check(base + '.wxml', base + '.js', label);
});
check('custom-tab-bar/index.wxml', 'custom-tab-bar/index.js', 'tabbar');

console.log(bad === 0 ? `  ✓ ${total} 个事件绑定全部有对应方法` : `  ${bad} 个绑定找不到方法`);

// 每个页面四件套是否齐全
console.log('\n=== 页面文件完整性 ===');
['home','due','assets','forecast','edit','family','checkin','allocation'].forEach((p) => {
  const miss = ['js','wxml','wxss','json'].filter(e => !fs.existsSync(`pages/${p}/${p}.${e}`));
  console.log(miss.length ? `  ✗ pages/${p} 缺 ${miss.join(', ')}` : `  ✓ pages/${p}`);
  if (miss.length) bad++;
});

// app.json 里列的页面都存在
console.log('\n=== app.json 页面路径 ===');
const app = JSON.parse(fs.readFileSync('app.json','utf8'));
app.pages.forEach((p) => {
  const ok = fs.existsSync(p + '.wxml');
  console.log((ok ? '  ✓ ' : '  ✗ ') + p);
  if (!ok) bad++;
});
app.tabBar.list.forEach((t) => {
  const ok = app.pages.indexOf(t.pagePath) >= 0;
  console.log((ok ? '  ✓ tabBar ' : '  ✗ tabBar ') + t.pagePath);
  if (!ok) bad++;
});

process.exit(bad === 0 ? 0 : 1);
