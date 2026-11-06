// 真 Electron 端到端：擴充後的 /offline-trainer-by-ai（別名 /teacher-loop）——驗證、老師教完離線重做、回歸、回滾。
// 只替換會呼叫模型／動使用者資料的函式（離線訓練器試做、老師子任務、快照與還原、判題器），循環本身用真的。
// 執行：把 playwright-core 連結進 node_modules 後  xvfb-run -a node scripts/e2e/teacher_loop.e2e.mjs   （FA_USERDATA 指定暫時的 userData 目錄；預期輸出見 DESIGN.offline-trainer.md 5.1）
import { _electron as electron } from 'playwright-core';
import path from 'node:path'; import fs from 'node:fs'; import os from 'node:os'; import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..'); const USERDATA = process.env.FA_USERDATA || fs.mkdtempSync(path.join(os.tmpdir(), 'fa-e2e-')); fs.writeFileSync(path.join(USERDATA, 'desktop-settings.json'), '{"execEnabled":true,"execConfirmRequired":false}');
const app = await electron.launch({ executablePath: path.join(ROOT, 'node_modules/electron/dist/electron'), args: ['--no-sandbox', '--user-data-dir=' + USERDATA, '.'], cwd: ROOT, timeout: 60000 });
const page = await app.firstWindow(); const errs = []; page.on('pageerror', (e) => errs.push(String(e.message).slice(0, 160)));
await page.waitForFunction('window.__faBootstrapReady === true && window.fa', { timeout: 60000 }); await new Promise((r) => setTimeout(r, 3000));
const out = await page.evaluate(async () => {
  const fa = window.fa; const K = { E: 'right' }; const calls = {}; fa.advancedSettings = fa.advancedSettings || {}; fa.advancedSettings.offlineAutoTrain = 'auto';
  fa.requestUserForm = async () => ({ confirmed: true, answer: '開始' });
  fa._otTeacherTryOffline = async (text) => { const key = Object.keys({ A: 1, B: 1, C: 1, D: 1, E: 1, F: 1, G: 1 }).find((k) => text.includes('項目' + k) || text.includes('：' + k + '（') || text.endsWith('：' + k) || text.includes('：' + k)); const v = K[key]; if (!v) return { ok: false, why: '離線訓練器沒有對應的做法' }; return { ok: true, preview: 'p', output: key === 'G' ? '```python\nprint(' + (v === 'right' ? 3 : 4) + ')\n```' : 'ANSWER ' + (v === 'right' ? 42 : 41), by: 'stub' }; };
  fa._runSubAgentTask = async (msg) => { const key = (/項目：(\w+)/.exec(msg) || [])[1]; calls[key] = (calls[key] || 0) + 1; const fb = /重做的結果驗證沒過/.test(msg);
    if (key === 'A') K.A = 'right'; else if (key === 'B') K.B = fb ? 'right' : 'wrong'; else if (key === 'C') K.C = 'wrong'; else if (key === 'D') { K.D = 'right'; K.A = 'wrong'; } else if (key === 'F') K.F = 'right'; else if (key === 'G') K.G = 'right';
    return { text: '{"status":"solved","summary":"ok"}' }; };
  fa._otFingerprint = async () => ({ tools: 0, toolBytes: 0, states: 0, patterns: JSON.stringify(K).length + Object.keys(K).length * 1000, versions: 0, turns: 0 });
  fa._otTeacherSnapshot = async () => JSON.parse(JSON.stringify(K)); fa._otTeacherRestore = async (snap) => { for (const k of Object.keys(K)) delete K[k]; Object.assign(K, snap); return { ok: true }; };
  fa._otRecordTurn = async () => {}; fa._otTrainSchedule = () => {}; fa._codeJudgeBridge = () => ({ available: true, judge: async ({ source }) => ({ verdict: /print\(3\)/.test(source) ? 'AC' : 'WA', detail: 'stub' }) });
  K.F = 'wrong';
  const c = { kind: 'contains', value: 'ANSWER 42' }; const items = ['E', 'F', 'A', 'B', 'C', 'D'].map((k) => ({ key: k, check: c })).concat([{ key: 'G', check: { kind: 'judge', tests: [{ in: '', out: '3\n' }] } }]);
  const r = await fa._otTeacherStart({ goal: '測試', text: JSON.stringify(items), unattended: true, max_failures: 99, delay_ms: 0 }); if (!r.ok) return { start: r };
  const sess = () => Array.from(fa._otTeacherSessions().values()).pop(); const t0 = Date.now(); while (sess().state === 'running' && Date.now() - t0 < 90000) await new Promise((r2) => setTimeout(r2, 300));
  const s = sess(); const st = fa._otTeacherStats(s);
  return { state: s.state, items: s.items.map((x) => ({ key: x.key, status: x.status, offline: !!x.offline, verified: !!x.verified, relearned: !!x.relearned, rolledBack: x.rolledBack || false, summary: String(x.summary || '').slice(0, 70) })), stats: { checked_total: st.checked_total, verified_offline: st.verified_offline, relearned: st.relearned, regressions: st.regressions, rolled_back: st.rolled_back }, K: JSON.parse(JSON.stringify(K)), calls, text: fa._otTeacherText(s).split('\n').slice(0, 3).join(' ⏎ ') };
});
console.log(JSON.stringify(out, null, 1)); console.log('頁面錯誤：', errs.length, errs.slice(0, 3)); await app.close();
