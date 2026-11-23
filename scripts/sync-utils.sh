#!/usr/bin/env bash
# 云函数不能 require 小程序目录里的文件，只能拷一份过去。
# 改完 utils/ 里的共用文件之后跑这个脚本，别手动去改云函数里的副本。
set -e
cd "$(dirname "$0")/.."
mkdir -p cloudfunctions/dailySnapshot/lib cloudfunctions/stockPrice/lib cloudfunctions/ocrAccount/lib cloudfunctions/api/lib
cp utils/calc.js     cloudfunctions/dailySnapshot/lib/calc.js
cp utils/recurring.js cloudfunctions/dailySnapshot/lib/recurring.js
cp utils/recurring.js cloudfunctions/api/lib/recurring.js
cp utils/calc.js      cloudfunctions/api/lib/calc.js
cp utils/checkin.js   cloudfunctions/api/lib/checkin.js
cp utils/stock.js    cloudfunctions/stockPrice/lib/stock.js
cp utils/ocrparse.js cloudfunctions/ocrAccount/lib/ocrparse.js
echo "✓ utils/calc.js     → cloudfunctions/dailySnapshot/lib/"
echo "✓ utils/recurring.js → cloudfunctions/dailySnapshot/lib/, cloudfunctions/api/lib/"
echo "✓ utils/checkin.js  → cloudfunctions/api/lib/"
echo "✓ utils/stock.js    → cloudfunctions/stockPrice/lib/"
echo "✓ utils/ocrparse.js → cloudfunctions/ocrAccount/lib/"
