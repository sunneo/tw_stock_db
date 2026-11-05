// 對話上下文（純函式）：純指代才用上下文、有內容的句子不被蓋過、衝突不猜、打破平手只限前兩名。真 Electron 的前後量測見 scripts/eval/offline-open-context.electron.eval.js。
const G = require('../renderer/src/offline/intent_gate.js');
const items = require('./eval/offline-open-context.data.js');
let pass = 0, fail = 0; const ok = (c, m) => { if (c) pass++; else fail++; console.log((c ? 'ok   ' : 'FAIL ') + m); };
ok(G.isAnaphoric('把它打開') && G.isAnaphoric('再開一次') && !G.isAnaphoric('叫出那份企劃書') && !G.isAnaphoric('叫出那首民謠'), '只有純指代句才算指代（有內容的句子不是）');
let n = 0, good = 0;
for (const [grp, hist, rec, text, exp] of items) {
    if (grp === 'tie' || grp === 'counter') continue; n++;
    const r = G.contextResolve(text, { history: hist.filter((m) => m.content !== text), recentKinds: rec });
    const got = r && r.kind ? r.kind : 'ask'; if (got === exp) good++; else console.log('  不符：' + text + ' 期望 ' + exp + ' 實際 ' + got);
}
ok(good === n, '純指代／再開一次／衝突／沒線索：' + good + '/' + n + ' 與期望相同');
ok(items.filter((x) => x[0] === 'counter').every((x) => G.contextResolve(x[3], { history: x[1], recentKinds: x[2] }) === null || !G.isAnaphoric(x[3])), '反例：句子自己有內容時，上下文不介入');
const rk = [{ kind: 'xlsx', label: '試算表', z: 2.0 }, { kind: 'docx', label: 'Word', z: 1.7 }, { kind: 'pdf', label: 'PDF', z: 1.0 }];
const hd = [{ role: 'user', content: '看 [附件：a.docx（file_id=1）]' }];
ok((G.contextBreakTie(rk, { history: hd }) || {}).kind === 'docx', '前兩名很接近且線索種類在其中：用線索打破平手');
ok(G.contextBreakTie(rk, { history: [{ role: 'user', content: '看 [附件：a.pdf（file_id=1）]' }] }) === null, '線索種類不在前兩名：不碰');
ok(G.contextBreakTie([{ kind: 'xlsx', label: 'x', z: 3 }, { kind: 'docx', label: 'd', z: 1 }], { history: hd }) === null, '第 1 名明顯領先：不碰');
console.log(pass + ' passed, ' + fail + ' failed'); process.exit(fail ? 1 : 0);
