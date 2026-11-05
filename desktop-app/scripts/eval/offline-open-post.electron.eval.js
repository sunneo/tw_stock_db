// 真桌面版走真的 _offlineRespond（規則 → 理解閘 → 執行）打幾句，工具換成假的：量 tool 路徑開啟後的剩餘目標（摘要／沒做到）、cache 重放確認、steps 步驟記錄。
// 用法同 offline-open-embed.electron.eval.js（不需要先接資料集）。回傳每句的卡片文字節錄與假工具被呼叫的順序。
const fa = window.fa; fa.advancedSettings.offlineMode = true; fa.requestUserForm = async () => null; fa._otGateNoProgress = true;
await fa._otLoad(); fa._ot.gateMemory = {};
const calls = []; const DOC = ['本合約由甲乙雙方於民國一百一十三年簽訂。', '甲方負責提供全部開發資料並於三十日內完成驗收。', '乙方應於驗收通過後十五日內支付尾款新台幣五十萬元。', '任何一方違約需賠償對方實際損失並負擔訴訟費用。'];
let pn = 0;
const fake = (name, fn) => { const old = fa.tools[name] || { description: name }; fa.tools[name] = Object.assign({}, old, { callback: async (s) => { const a = JSON.parse(s); calls.push(name); return JSON.stringify(fn(a)); } }); };
fake('edit_docx_open', () => ({ ok: true, id: 'w1' })); fake('edit_xlsx_open', () => ({ ok: true, id: 'x1' }));
fake('parse_uploaded_file', () => { pn++; return pn % 2 === 1 ? { ok: true, content: DOC.slice(0, 2).join('。'), has_more: true, next_offset: 50, total_chars: 100 } : { ok: true, content: DOC.slice(2).join('。'), has_more: false, total_chars: 100 }; });
fake('browser_create_tab', () => ({ ok: true, tab_id: 9 })); fake('browser_close', () => ({ ok: true }));
fake('browser_get_page_text', () => ({ ok: true, title: 'Y', url: 'https://example.com', text: '美國大選最新民調出爐 搖擺州變數成關鍵\n今日娛樂焦點新聞第一則報導內容\n今日娛樂焦點新聞第二則報導內容', has_more: false, total_chars: 120 }));
const out = [];
const run = async (label, text, setup) => { calls.length = 0; pn = 0; if (setup) setup(); let t = ''; try { t = String(await fa._offlineRespond(text, { capture: true }) || ''); } catch (e) { t = 'ERROR ' + String((e && e.message) || e); } out.push({ label, text: text.slice(0, 40), calls: calls.join('>'), card: t.replace(/\s+/g, ' ').slice(0, 520) }); };
await run('tool+摘要', '打開 合約.docx 並摘要 [附件：合約.docx（file_id=f1）]');
await run('tool+沒處理', '打開那個試算表然後告訴我哪個月最高 [附件：a.xlsx（file_id=f2）]');
await run('tool+沒有檔案內容', '打開Word文件編輯器並摘要');
await run('steps', '瀏覽器打開 https://example.com 並找美國選舉新聞');
// cache：換掉規劃結果，仍走真的 _offlineRespond → 理解閘 → _otExecute
const realPlan = fa._otPlan.bind(fa);
fa._otPlan = async (text) => ({ text, slots: {}, alternatives: [], decision: { status: 'cache', chosen: { kind: 'cache', domain: 'x', pattern: 'c', score: 1, calls: [{ tool: 'browser_get_page_text', args: { tab_id: 9 } }] } } });
await run('cache(讀網頁)', '重放那個讀網頁');
fake('terminal_run', () => ({ ok: true }));
fa._otPlan = async (text) => ({ text, slots: {}, alternatives: [], decision: { status: 'cache', chosen: { kind: 'cache', domain: 'x', pattern: 'c', score: 1, calls: [{ tool: 'terminal_run', args: { command: 'ls' } }] } } });
await run('cache(有副作用，使用者不回答)', '重放那個指令');
fa._otPlan = realPlan;
return { script: [...document.scripts].map((s) => s.src).filter((s) => /floating-assistant/.test(s)), out };
