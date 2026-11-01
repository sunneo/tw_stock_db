// /edit-docx（真實 Electron；LLM 用假的）：開起來、預覽、雙擊改字、格式列（整段／只改選到的字）、程式白話（不經過模型）、AI 動作、表格儲存格、匯出 docx（有 JSZip 才測）、/edit-file 分派
// 用法：FA_DEBUG_EVAL_FILE=scripts/eval/edit_docx.eval.js xvfb-run -a node_modules/electron/dist/electron . --no-sandbox --use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader --user-data-dir=$(mktemp -d)
const fa = window.fa; const R = { fail: [] }; const wait = (ms) => new Promise((r) => setTimeout(r, ms)); fa.advancedSettings.offlineMode = false; fa.messages = [];
const until = async (f, ms = 15000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { const v = f(); if (v) return v; } catch (_) { /* */ } await wait(50); } return null; };
const ok = (name, cond, extra) => { R[name] = !!cond; if (!cond) R.fail.push(name + (extra !== undefined ? ' ' + JSON.stringify(extra).slice(0, 200) : '')); };
const calls = { llm: 0, last: '' };
fa._getApiConfig = () => ({ apiKey: 'test', apiUrl: 'http://127.0.0.1:9', apiModel: 'fake' });
fa._kiLlm = async (user) => { calls.llm++; calls.last = String(user); return JSON.stringify({ say: 'AI 加了一段', edits: [{ op: 'add_block', after: 'end', block: { type: 'para', text: 'AI 寫的結尾' } }] }); };
const seen = new Set(); const mount = async (kind, opts) => { const r = await fa._edOpen(kind, opts); fa._renderMessageHistory(); const ed = await until(() => [...document.querySelectorAll('.few')].filter((x) => !seen.has(x)).pop()); seen.add(ed); await wait(800); return { r, ed }; };
const { r, ed } = await mount('edit-docx', { starter: 'report' }); ok('opened', r && r.ok && ed);
const blocks = () => [...ed.querySelectorAll('.ddoc .blk')]; const spec = () => ed._ed.getSpec(); const T = (b) => FaEditDocx.plain(b);
ok('preview_blocks', blocks().length === 7 && /<h1>報告標題<\/h1>/.test(blocks()[0].innerHTML) && blocks()[4].querySelector('ul li') && blocks()[6].querySelector('table'), blocks().length);
ok('objects_tree', ed.querySelectorAll('.ol .ob').length === 7);
// 雙擊就地改字
blocks()[2].dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); await wait(100); const ta = ed.querySelector('.ddoc textarea.ed'); ok('inline_editor', !!ta && ta.value === '一兩句話說明重點。', ta && ta.value);
ta.value = '新的摘要'; ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true })); await wait(150); ok('inline_applied', T(spec().objects[2]) === '新的摘要', T(spec().objects[2]));
// 格式列：選一個區塊 → B（整段）
ed._ed.select(spec().objects[2].id); await wait(100); const B = [...ed.querySelectorAll('.dfmt button')].find((b) => b.textContent === 'B'); B.click(); await wait(150); ok('bold_whole_block', FaEditDocx.rprHas(spec().objects[2].runs[0].rpr, 'b') && /<strong>/.test(blocks()[2].innerHTML), spec().objects[2].runs);
B.click(); await wait(150); ok('bold_toggles_off', !FaEditDocx.rprHas((spec().objects[2].runs[0] || {}).rpr || '', 'b'));
// 只改選到的字：用 Selection 選「摘要」兩字
const w2 = blocks()[2]; const tn = w2.querySelector('p').firstChild; const range = document.createRange(); range.setStart(tn, 1); range.setEnd(tn, 3); const sl = window.getSelection(); sl.removeAllRanges(); sl.addRange(range);
const cs = ed.querySelector('.dfmt select'); cs.value = 'C00000'; cs.dispatchEvent(new Event('change', { bubbles: true })); await wait(200);
const rr = spec().objects[2].runs; ok('color_only_selected_text', rr.length === 3 && rr[1].t === '的摘' && FaEditDocx.rprColor(rr[1].rpr) === '#C00000' && !rr[0].rpr, rr);
// 程式白話：不經過模型
const l0 = calls.llm; await ed._ed.send('把第 1 段改成：期末報告；把第 3 段改成斜體；在最後加一段：結語'); await wait(300);
const sp = spec(); ok('program_commands_no_llm', calls.llm === l0 && T(sp.objects[0]) === '期末報告' && FaEditDocx.rprHas(sp.objects[2].runs[0].rpr, 'i') && T(sp.objects[sp.objects.length - 1]) === '結語', [calls.llm, l0, sp.objects.map(T)]);
// AI（讀不懂的）：prompt 有 id 與格式標記，回封閉動作
await ed._ed.send('把整份文件寫得更專業'); await wait(500); ok('ai_called_with_ids', calls.llm === l0 + 1 && /\[o\d+\] heading H1/.test(calls.last) && /Request: /.test(calls.last), calls.last.slice(0, 120)); ok('ai_applied', T(spec().objects[spec().objects.length - 1]) === 'AI 寫的結尾');
ed._ed.undo(); await wait(100); ok('undo_one_step', T(spec().objects[spec().objects.length - 1]) === '結語');
// 表格儲存格：雙擊 td 改字
const td = blocks().find((b) => b.querySelector('table')).querySelectorAll('td')[3]; td.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); await wait(100); const ti = ed.querySelector('.ddoc td input'); ok('cell_input', !!ti); ti.value = '儲存格新值'; ti.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await wait(150);
ok('cell_applied', spec().objects.find((b) => b.type === 'table').rows[1][1] === '儲存格新值');
// 加區塊
const addSel = [...document.querySelectorAll('select')].filter((s) => ed.contains(s) || (ed._win && ed._win.el && ed._win.el.contains && ed._win.el.contains(s)) || true).find((s) => [...s.options].some((o) => /＋ 區塊/.test(o.textContent))); addSel.value = 'pagebreak'; addSel.dispatchEvent(new Event('change', { bubbles: true })); await wait(150); ok('add_pagebreak', spec().objects.some((b) => b.type === 'pagebreak'));
// 匯出 docx（有 JSZip 才測：離線時載不到就略過）
let Z = null; try { await fa._ensureJSZipLoaded(); Z = window.JSZip; } catch (_) { Z = null; }
if (Z) { const bytes = await FaEditDocx.build(spec(), Z); const back = await FaEditDocx.read(bytes, Z, 'x'); ok('export_docx_roundtrip', back.objects.length >= spec().objects.length && T(back.objects[0]) === '期末報告', back.objects.map(T)); } else { R.export_skipped = 'no JSZip'; }
// /edit-file 分派（.docx 需要 JSZip 才讀得出來；沒有就只測指令登記）
ok('commands', ['/edit-docx', '/edit-word', '/edit-file'].every((c) => fa.slashCommands.has(c)));
ok('kind_registered', !!FaEditHost.KINDS['edit-docx'] && FaEditHost.KINDS['edit-docx'].remote.sync === 'edits');
R.ok = R.fail.length === 0; console.log('EDIT_DOCX ' + JSON.stringify(R)); return R;
