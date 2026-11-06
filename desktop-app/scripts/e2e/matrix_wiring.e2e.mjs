// 真 Electron 端到端：宿主 _codeOffline 的矩陣層接線與「誠實標示」。
// 公式題只有可見範例 → matrix／L0／verified:false／onlyExamples:true；另有獨立隱藏測資 → verified:true；Blockly 解得掉的（範式、配方）照舊；讀不出又沒範例 → 明確失敗。
// 執行：把 playwright-core 連結進 node_modules 後  xvfb-run -a node scripts/e2e/matrix_wiring.e2e.mjs   （FA_USERDATA 指定暫時的 userData 目錄）
import { _electron as electron } from 'playwright-core';
import path from 'node:path'; import fs from 'node:fs'; import os from 'node:os'; import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..'); const USERDATA = process.env.FA_USERDATA || fs.mkdtempSync(path.join(os.tmpdir(), 'fa-e2e-')); fs.writeFileSync(path.join(USERDATA, 'desktop-settings.json'), '{"execEnabled":true,"execConfirmRequired":false}');
const app = await electron.launch({ executablePath: path.join(ROOT, 'node_modules/electron/dist/electron'), args: ['--no-sandbox', '--user-data-dir=' + USERDATA, '.'], cwd: ROOT, timeout: 60000 });
const page = await app.firstWindow(); const errs = []; page.on('pageerror', (e) => errs.push(String(e.message).slice(0, 160)));
await page.waitForFunction('window.__faBootstrapReady === true && window.fa', { timeout: 60000 }); await new Promise((r) => setTimeout(r, 3000));
const out = await page.evaluate(async () => {
  const fa = window.fa; const bridge = fa._codeJudgeBridge(); const res = { bridge: !!bridge.judge };
  const fm = (a, b) => a * a + b; const mkF = (ps) => ps.map(([a, b]) => ({ in: a + ' ' + b + '\n', out: fm(a, b) + '\n' }));
  const stF = '輸入兩個整數 a b（-50 到 50），輸出 a 的平方加 b。';
  const has = (s) => (s.includes('0110') ? 'yes' : 'no'); const mkD = (ss) => ss.map((x) => ({ in: x + '\n', out: has(x) + '\n' }));
  const stD = '輸入一個由 0、1 組成的字串（長度 1～30），若含有子字串 "0110" 印 yes，否則印 no。';
  const run = async (label, o) => { try { const r = await fa._codeOffline(o, bridge); return { label, ok: r.ok, by: r.by, matrix: r.matrix, verified: r.verified, onlyExamples: r.onlyExamples, verdict: r.verdict, reason: r.reason && String(r.reason).slice(0, 120) }; } catch (e) { return { label, error: String(e && e.message || e).slice(0, 160) }; } };
  res.r1 = await run('公式·只有可見範例', { text: stF, problem: { id: 'f', tests: mkF([[2, 3], [5, 1], [0, 4], [3, 3]]), checker: 'tokens' } });
  res.r2 = await run('公式·另有獨立隱藏測資', { text: stF, problem: { id: 'f', tests: mkF([[2, 3], [5, 1], [0, 4], [3, 3]]), hidden: mkF([[-7, 9], [10, -10], [1, 1], [-3, 0], [44, -2], [8, 8]]), checker: 'tokens' } });
  res.r2b = await run('自動機·有獨立隱藏測資', { text: stD, problem: { id: 'd', tests: mkD(['0110', '1111', '10110']), hidden: mkD(['0', '01101', '1001', '0000110', '101', '11110111', '0110110']), checker: 'tokens' } });
  res.r3 = await run('讀得出意圖（走配方，不該用矩陣）', { text: '輸入一行兩個整數 a b，輸出 a+b。', problem: { id: 'ab', tests: [{ in: '1 2\n', out: '3\n' }, { in: '5 7\n', out: '12\n' }], checker: 'tokens' } });
  res.r4 = await run('讀不出而且沒有範例', { text: '請幫我寫一個很複雜的東西', problem: { id: 'x', tests: [], checker: 'tokens' } });
  return res;
});
console.log(JSON.stringify(out, null, 1)); console.log('頁面錯誤：', errs.length, errs.slice(0, 3)); await app.close();
