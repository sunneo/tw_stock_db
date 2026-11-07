import { _electron as electron } from 'playwright-core';
import fs from 'node:fs';
const U = process.env.FA_USERDATA; // 真 Electron：optimize_code 的宿主接線（在 desktop-app 目錄執行，FA_USERDATA 指到暫存目錄）
 fs.writeFileSync(U + '/desktop-settings.json', '{"execEnabled":true,"execConfirmRequired":false}');
const app = await electron.launch({ executablePath: '/home/hungfu.lee/下載/SRC/tw_stock_db/desktop-app/node_modules/electron/dist/electron', args: ['--no-sandbox', '--user-data-dir=' + U, '.'], cwd: process.cwd(), timeout: 60000 });
const page = await app.firstWindow(); await page.waitForFunction('window.__faBootstrapReady === true && window.fa', { timeout: 60000 }); await new Promise((r) => setTimeout(r, 3000));
const r = await page.evaluate(async () => {
  const src = 'n = int(input())\nq = list(range(n))\ntot = 0\nwhile q:\n    x = q.pop(0)\n    tot += x % 7\nprint(tot)\n';
  const exp = (n) => { let t = 0; for (let i = 0; i < n; i++) t += i % 7; return t + '\n'; };
  return await window.fa._codeOptimize({ source: src, tests: [{ in: '10\n', out: exp(10) }, { in: '25\n', out: exp(25) }], hidden: [{ in: '1\n', out: exp(1) }, { in: '100\n', out: exp(100) }], perf: { in: '30000\n', out: exp(30000) } });
});
console.log(JSON.stringify({ ok: r.ok, changed: r.changed, applied: r.applied, skipped: r.skipped, src: (r.source || '').slice(0, 120) })); console.log(r.report); await app.close();
