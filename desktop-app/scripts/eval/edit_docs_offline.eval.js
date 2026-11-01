// 表格／文字／Word 編輯器的離線 AI（真實 Electron；不給任何模型）：程式讀不懂的句子走整套 harness（細切→推導→UML→CoLU 接線→封閉動作），讀不懂的明講、不猜；聊天 agent 工具作用在開著的編輯器
// 用法：FA_DEBUG_EVAL_FILE=scripts/eval/edit_docs_offline.eval.js xvfb-run -a node_modules/electron/dist/electron . --no-sandbox --use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader --user-data-dir=$(mktemp -d)
const fa = window.fa; const R = { fail: [] }; const wait = (ms) => new Promise((r) => setTimeout(r, ms)); fa.messages = [];
const until = async (f, ms = 15000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { const v = f(); if (v) return v; } catch (_) { /* */ } await wait(50); } return null; };
const ok = (name, cond, extra) => { R[name] = !!cond; if (!cond) R.fail.push(name + (extra !== undefined ? ' ' + JSON.stringify(extra).slice(0, 240) : '')); };
fa.advancedSettings.offlineMode = true; let llm = 0; fa._kiLlm = async () => { llm++; return '{"say":"不該被呼叫","edits":[]}'; };
const seen = new Set(); const mount = async (kind, opts) => { const r = await fa._edOpen(kind, opts); fa._renderMessageHistory(); const ed = await until(() => [...document.querySelectorAll('.few')].filter((x) => !seen.has(x)).pop()); seen.add(ed); await wait(800); return { r, ed }; };
const logText = (ed) => [...ed.querySelectorAll('.msg, .m')].map((x) => x.textContent).join('\n') + ed.textContent;
// ── CSV：欄名推導＋複合需求
const { ed } = await mount('edit-csv', { spec: FaEditSheet.parseCsv('name,qty,price\napple,3,1.5\nbanana,2,2\ncherry,10,0.5\n', '水果') });
const ser = () => FaEditSheet.serializeCsv(ed._ed.getSpec()); ok('mode_offline', fa._edIsOffline && fa._edIsOffline());
await ed._ed.send('刪掉 qty 小於 3 的列，然後依 price 由大到小排序'); await wait(1500);
ok('csv_compound_via_harness', ser() === 'name,qty,price\napple,3,1.5\ncherry,10,0.5\n', ser()); ok('no_model_called', llm === 0, llm);
ok('csv_shows_derivation_and_wiring', /CoLU/.test(logText(ed)) || /推導/.test(logText(ed)), logText(ed).slice(-200));
await ed._ed.send('把第 2 行拿掉'); await wait(900); ok('csv_remove_row_by_words', ser() === 'name,qty,price\ncherry,10,0.5\n', ser());
await ed._ed.send('把整份表格翻成英文'); await wait(900); ok('unreadable_is_said_not_guessed', ser() === 'name,qty,price\ncherry,10,0.5\n' && /沒有讀懂|沒讀懂/.test(logText(ed)), logText(ed).slice(-200));
await ed._ed.send('把價格排序'); await wait(900); ok('unknown_column_asks_with_choices', /A=name|欄位/.test(logText(ed)) && ser() === 'name,qty,price\ncherry,10,0.5\n');
// ── XLSX：用標題名字推導公式
const X = await mount('edit-xlsx', { spec: FaEditSheet.validate({ format: 'xlsx', title: '收支', objects: [FaEditSheet.newSheet('收支', [['日期', '單價', '數量'], ['1/1', 10, 3], ['1/2', 5, 4]], { id: 's1', header: true })] }).spec });
await X.ed._ed.send('在最後加一欄「總價」等於單價乘數量'); await wait(1500);
const xs = X.ed._ed.getSpec().objects[0]; const vals = FaEditSheet.computed(xs); ok('xlsx_formula_from_header_names', xs.cols.length === 4 && vals[0][3] === '總價' && vals[1][3] === 30 && vals[2][3] === 20, vals);
// ── Markdown：用標題文字找位置
const M = await mount('edit-markdown', { spec: FaEditText.parse('# 簡介\n\n第一段內容\n\n## 背景\n\n背景說明\n', 'md') });
await M.ed._ed.send('在「背景」後面加一段：補充說明'); await wait(1200); ok('md_add_after_heading', FaEditText.serialize(M.ed._ed.getSpec()).indexOf('## 背景\n\n補充說明') >= 0, FaEditText.serialize(M.ed._ed.getSpec()));
await M.ed._ed.send('把標題「背景」那一段改成三級標題'); await wait(1200); ok('md_heading_by_title_text', /### 背景/.test(FaEditText.serialize(M.ed._ed.getSpec())), FaEditText.serialize(M.ed._ed.getSpec()));
await M.ed._ed.send('把第二段改短一點'); await wait(900); ok('rewrite_needs_ai_said', /AI/.test(logText(M.ed)) && !/改短/.test(FaEditText.serialize(M.ed._ed.getSpec())));
// ── DOCX：樣式
const D = await mount('edit-docx', { starter: 'report' });
await D.ed._ed.send('把「重點一」變成粗體'); await wait(1200); const dd = D.ed._ed.getSpec(), li = dd.objects.find((b) => FaEditDocx.plain(b) === '重點一'); ok('docx_style_only_a_word_via_harness', li && li.runs.length === 1 && FaEditDocx.rprHas(li.runs[0].rpr, 'b'), li && li.runs);
await D.ed._ed.send('在第 3 段後面加分頁'); await wait(1000); ok('docx_page_break', D.ed._ed.getSpec().objects.some((b) => b.type === 'pagebreak'));
ok('no_model_called_at_all', llm === 0, llm);
// ── 聊天 agent 工具：作用在開著的編輯器；CoLU 單元目錄裡看得到
const call = async (name, args) => JSON.parse(await fa.tools[name].callback.call(fa, JSON.stringify(args)));
ok('tools_registered', ['sheet_sort', 'sheet_delete_rows', 'text_set_text', 'doc_set_style', 'doc_page_break'].every((n) => !!fa.tools[n]));
const r1 = await call('doc_set_style', { n: 1, italic: true }); await wait(300); ok('tool_doc_set_style', r1.ok && FaEditDocx.rprHas(D.ed._ed.getSpec().objects[0].runs[0].rpr, 'i'), r1);
const r2 = await call('text_set_text', { n: 1, text: '新簡介' }); await wait(300); ok('tool_text_set_text_by_n', r2.ok && /# 新簡介/.test(FaEditText.serialize(M.ed._ed.getSpec())), r2);
const r3 = await call('sheet_sort', { col: 'nope' }); ok('tool_rejects_bad_column', r3.ok === false && r3.rejected.length === 1, r3);
let cat = null; try { cat = fa._unitCatalogBuild(); } catch (_) { cat = null; } ok('units_in_catalog', !!cat && ['sheet_sort', 'text_set_text', 'doc_set_style'].every((n) => cat.units.some((u) => u.name === n)), cat && cat.units.length);
R.ok = R.fail.length === 0; console.log('EDIT_DOCS_OFFLINE ' + JSON.stringify(R)); return R;
