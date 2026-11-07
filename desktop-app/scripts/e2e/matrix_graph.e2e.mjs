// 真 Electron 端到端：矩陣層 graph／grid 模組、graph2／twofile／fs／linuxsem 領域包在宿主 _codeOffline 真的有註冊（node 測試過不代表宿主有接上）。
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
  const run = async (label, o) => { try { const r = await fa._codeOffline(o, bridge); return { label, ok: r.ok, by: r.by, paradigm: r.paradigm || null, matrix: r.matrix, verified: r.verified, onlyExamples: r.onlyExamples, reason: r.reason && String(r.reason).slice(0, 100) }; } catch (e) { return { label, err: String(e.message || e).slice(0, 160) }; } };
  const T = (a) => a.map(([i, o]) => ({ in: i, out: o }));
  // 矩陣層 graph 模組：題敘述讀不出配方（沒有領域關鍵字），只靠範例＋獨立隱藏測資
  const stR = '有向圖，節點 0..n-1。第一行 n m，接著 m 行 a b 表示 a→b。從節點 0 出發，一共能走到幾個節點（包含 0 自己）？';
  res.m1 = await run('graph 模組·可達數', { text: stR, problem: { id: 'r', tests: T([['3 1\n0 1\n', '2\n'], ['4 2\n0 1\n1 2\n', '3\n']]), hidden: T([['2 0\n', '1\n'], ['4 3\n0 1\n2 3\n1 0\n', '2\n'], ['5 4\n0 1\n1 2\n2 3\n3 4\n', '5\n'], ['3 3\n1 2\n2 0\n0 0\n', '1\n']]), checker: 'tokens' } });
  // 領域包 graph2：最小生成樹（範式）
  const stM = '第一行 n m，接著 m 行每行 u v w 表示節點 u 和 v 之間有一條權重 w 的無向邊。求最小生成樹的總權重；如果圖不連通就輸出 -1。';
  res.p1 = await run('graph2 領域包·MST', { text: stM, problem: { id: 'm', tests: T([['3 3\n1 2 1\n2 3 2\n1 3 3\n', '3\n'], ['2 1\n1 2 5\n', '5\n'], ['4 4\n1 2 1\n2 3 1\n3 4 1\n1 4 9\n', '3\n'], ['3 1\n1 2 4\n', '-1\n']]), hidden: T([['4 5\n1 2 4\n2 3 1\n3 4 2\n1 4 7\n1 3 3\n', '6\n'], ['2 0\n', '-1\n']]), checker: 'tokens' } });
  // 領域包 fs：FAT 簇鏈長度
  const stF = '第一行 n，第二行 n 個整數 fat，fat[i] 是簇 i 的下一個簇，-1 表示檔案結束（簇編號從 0 開始）。第三行 s 是檔案的起始簇。輸出檔案的簇鏈長度。';
  res.p2 = await run('fs 領域包·FAT', { text: stF, problem: { id: 'f', tests: T([['3\n1 2 -1\n0\n', '3\n'], ['4\n-1 -1 3 -1\n2\n', '2\n']]), hidden: T([['5\n4 -1 0 -1 3\n2\n', '4\n'], ['2\n-1 -1\n1\n', '1\n']]), checker: 'tokens' } });
  // 領域包 linuxsem：TCP 最終狀態
  const stT = '第一行 q，之後 q 行事件：passive_open、active_open、syn、synack、ack、fin、close、timeout。TCP 連線從 CLOSED 開始，依標準狀態機換狀態（LISTEN、SYN_SENT、SYN_RCVD、ESTABLISHED、FIN_WAIT_1、FIN_WAIT_2、TIME_WAIT、CLOSE_WAIT、LAST_ACK、CLOSED）；目前狀態沒有定義的事件直接忽略。輸出最後的狀態。';
  res.p3 = await run('linuxsem 領域包·TCP', { text: stT, problem: { id: 't', tests: T([['3\npassive_open\nsyn\nack\n', 'ESTABLISHED\n'], ['2\nactive_open\nclose\n', 'CLOSED\n']]), hidden: T([['5\npassive_open\nsyn\nack\nclose\nack\n', 'FIN_WAIT_2\n'], ['1\nfin\n', 'CLOSED\n']]), checker: 'tokens' } });
  // 矩陣層 L0 補強（multi）：秒數換成時分秒（常數 3600／60 來自「秒」領域先驗，不在敘述數字裡）
  const stS = '輸入一個秒數 s（0 到 99999）。輸出對應的時、分、秒三個整數（分與秒都是 0 到 59），以空白分隔。'; const sec = (x) => Math.floor(x / 3600) + ' ' + Math.floor((x % 3600) / 60) + ' ' + (x % 60) + '\n'; const mkS = (xs) => xs.map((x) => ({ in: x + '\n', out: sec(x) }));
  res.m2 = await run('L0 multi·秒數換時分秒', { text: stS, problem: { id: 's', tests: mkS([3958, 10749]), hidden: mkS([0, 59, 60, 3599, 3600, 86399, 99999, 45296]), checker: 'tokens' } });
  // 領域包 linuxfmt：tar 區塊數；領域包 twofile：paste 逐行並排
  const stB = '輸入一行檔案大小 s（位元組）。tar 以 512 位元組為區塊：一個檔案佔 1 個標頭區塊，加上資料區塊（資料補 0 補到 512 的倍數，s=0 沒有資料區塊）。輸出這個檔案佔用的區塊數。';
  res.p4 = await run('linuxfmt 領域包·tar 區塊', { text: stB, problem: { id: 'b', tests: T([['511\n', '2\n'], ['0\n', '1\n'], ['513\n', '3\n']]), hidden: T([['512\n', '2\n'], ['1024\n', '3\n'], ['1\n', '2\n'], ['4096\n', '9\n']]), checker: 'tokens' } });
  const stP = '第一行 n，接著 n 行是檔案 A 的每一行文字；再來一行 m，接著 m 行是檔案 B 的每一行文字。仿 paste：把兩個檔案逐行並排，每行是 A 的第 i 行、一個 Tab、B 的第 i 行；較短的檔案用空字串補。';
  res.p5 = await run('twofile 領域包·paste', { text: stP, problem: { id: 'p', tests: T([['2\na\nb\n1\nc\n', 'a\tc\nb\t\n'], ['1\nx\n2\ny\nz\n', 'x\ty\n\tz\n']]), hidden: T([['3\na\nb\nc\n3\nd\ne\nf\n', 'a\td\nb\te\nc\tf\n'], ['1\nq\n1\nr\n', 'q\tr\n']]), checker: 'tokens' } });
  return res;
});
console.log(JSON.stringify(out, null, 1)); console.log('頁面錯誤：', errs.length, errs.slice(0, 3)); await app.close();
