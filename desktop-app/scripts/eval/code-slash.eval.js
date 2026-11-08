// /code 指令實機驗證（真的 Electron，工作目錄實作）。用法：node scripts/eval/code-slash.run.js（它會建暫存資料夾、換埠、啟動，並印出結果）
const fa = window.fa; const R = {}; fa.messages = [];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
R.loaded = { scripts: Array.from(document.scripts).map((s) => s.src).filter((s) => /floating-assistant/.test(s)), hasCodeSlashModule: typeof FaCodeSlash !== 'undefined' };
R.registered = !!fa.slashCommands.get('/code');
const calls = []; const wrap = (name, fake) => { const t = fa.tools[name]; const orig = t.callback; t.callback = async function (raw) { calls.push({ name, args: JSON.parse(raw) }); return fake ? fake(JSON.parse(raw)) : orig.call(this, raw); }; return () => { t.callback = orig; }; };
const lastText = () => { const m = fa.messages.filter((x) => x.role === 'assistant').pop(); return m ? String(m.content || '').slice(0, 400) : null; };
const run = async (txt) => { const n0 = calls.length; await fa.slashCommands.get('/code').handler(txt, fa); await wait(300); return { calls: calls.slice(n0), reply: lastText() }; };
// 1) 沒有參數 → 用法（不呼叫任何工具）
R.help = await run('');
// 2) 寫：換成假的 write_code（只證明路由與欄位；不是真的寫）
const un1 = wrap('write_code', (a) => JSON.stringify({ ok: true, report: '（假的 write_code 回覆）收到 task=' + a.task, source: 'print(1)' }));
R.write = await run('寫一個函式，輸入兩個整數印出總和 ```in\n1 2\n``` ```out\n3\n```'); un1();
// 3) 解釋：真的 explain_code（程式負責，不問模型）
const un2 = wrap('explain_code'); R.explain = await run('解釋 ```python\ndef add(a, b):\n    return a + b\n\nprint(add(1, 2))\n```'); un2();
// 4) 合併：真的 merge_patch（合併後驗證語法）
const un3 = wrap('merge_patch'); R.merge = await run('合併 ```python\nx = 1\nprint(x)\n``` ```diff\n--- a/m.py\n+++ b/m.py\n@@ -1,2 +1,2 @@\n-x = 1\n+x = 2\n print(x)\n```'); un3();
// 5) 優化缺測資 → 說缺什麼、不呼叫工具
R.optMissing = await run('優化 ```python\nprint(1)\n```');
// 6) 離線訓練器對「一般說法」會選到哪個工具（不加 /code；不執行，只看計畫）
R.trainer = {}; for (const q of ['寫一個函式，輸入兩個整數印出總和', '幫我用python寫程式計算費氏數列', '這段程式碼有bug幫我修', '幫我把這段程式優化', '設計一個購物車系統的UML']) { try { const p = await fa._otPlan(q); R.trainer[q] = { status: p && p.decision && p.decision.status, tool: p && p.decision && p.decision.chosen && p.decision.chosen.tool, alts: ((p && p.alternatives) || []).slice(0, 3).map((a) => a.tool + ':' + a.score) }; } catch (e) { R.trainer[q] = 'ERR ' + e.message; } }
return R;
