// node renderer/src/recipe/plan_log_filter.test.js
// 日誌第 0 層（純程式）：錯誤／警告行、堆疊續行只跟在留下的行後面、統計數字、沒有錯誤時明說。
const F = require('./plan_core.js');
let ok = 0, bad = 0; const check = (n, c, x) => { if (c) ok++; else { bad++; console.log('FAIL ' + n + (x === undefined ? '' : ' ' + JSON.stringify(x).slice(0, 240))); } };

const LOG = ['2026-11-17 10:00:01 INFO start', '2026-11-17 10:00:02 ERROR disk full on /dev/sda1', '  at io.write(x.java:12)', '  at main(x.java:3)',
    '2026-11-17 10:00:03 WARN retry 2 of 3', '2026-11-17 10:00:04 INFO ok', 'Caused by: timeout', '2026-11-17 10:00:05 錯誤：連線失敗'].join('\n');

// 1. 統計：8 行非空，錯誤 2、警告 1
{
    const f = F.filterLog(LOG);
    check('1 總行數', f.total === 8, f.total);
    check('1 錯誤數', f.errors === 2, f.errors);
    check('1 警告數', f.warns === 1, f.warns);
    check('1 統計行寫進 header', f.header.includes('日誌共 8 行') && f.header.includes('錯誤 2 行') && f.header.includes('警告 1 行'), f.header);
}
// 2. 留下的行：錯誤、其堆疊續行、警告、中文錯誤；INFO 行與它後面的 Caused by 不留
{
    const f = F.filterLog(LOG);
    check('2 留下的行順序與內容', JSON.stringify(f.kept) === JSON.stringify(['2026-11-17 10:00:02 ERROR disk full on /dev/sda1', '  at io.write(x.java:12)', '  at main(x.java:3)', '2026-11-17 10:00:03 WARN retry 2 of 3', '2026-11-17 10:00:05 錯誤：連線失敗']), f.kept);
    check('2 INFO 之後的續行不留', !f.kept.some((l) => l.includes('Caused by')), f.kept);
}
// 3. 沒有錯誤與警告：digest 明說沒有，不讓模型編
{
    const d = F.digestText('2026-11-17 INFO a\n2026-11-17 INFO b');
    check('3 沒有錯誤明說', d.includes('（沒有錯誤或警告行）'), d);
}
// 4. 空字串與 null 不丟錯
{
    let threw = false; try { F.filterLog(''); F.filterLog(null); } catch (_) { threw = true; }
    check('4 空輸入不丟錯', !threw);
}
// 5. 等級判斷：FATAL、Exception、警告 都算；一般的 info 不算
check('5 FATAL 是錯誤', F.levelOf('FATAL oom') === 'error');
check('5 Exception 是錯誤', F.levelOf('java.lang.NullPointerException') === 'error');
check('5 WARNING 是警告', F.levelOf('WARNING slow') === 'warn');
check('5 info 不算', F.levelOf('INFO fine') === null);

console.log('plan_log_filter.test.js: ' + ok + ' passed, ' + bad + ' failed');
if (bad) process.exit(1);
