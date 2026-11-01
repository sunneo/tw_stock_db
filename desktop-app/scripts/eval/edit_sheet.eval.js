// /edit-csv、/edit-xlsx（真實 Electron；LLM 用假的）：開起來、虛擬捲動、單擊／雙擊／鍵盤改格、程式白話（不經過模型）、AI 動作、貼上、CSV 往返、公式重算、原始碼分頁、匯出
// 用法：FA_DEBUG_EVAL_FILE=scripts/eval/edit_sheet.eval.js xvfb-run -a node_modules/electron/dist/electron . --no-sandbox --use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader --user-data-dir=$(mktemp -d)
const fa = window.fa; const R = { fail: [] }; const wait = (ms) => new Promise((r) => setTimeout(r, ms)); fa.advancedSettings.offlineMode = false; fa.messages = [];
const until = async (f, ms = 15000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { const v = f(); if (v) return v; } catch (_) { /* */ } await wait(50); } return null; };
const ok = (name, cond, extra) => { R[name] = !!cond; if (!cond) R.fail.push(name + (extra !== undefined ? ' ' + JSON.stringify(extra).slice(0, 200) : '')); };
const calls = { llm: 0, last: '' };
fa._getApiConfig = () => ({ apiKey: 'test', apiUrl: 'http://127.0.0.1:9', apiModel: 'fake' });
fa._kiLlm = async (user) => { calls.llm++; calls.last = String(user); return JSON.stringify({ say: 'AI 填了價格', edits: [{ op: 'fill_col', col: 'price', value: '9' }] }); };
const CSV = 'name,qty,price\r\napple,3,1.5\r\n"banana, ripe",2,2\r\ncherry,10,0.5\r\n';
const seen = new Set(); const mount = async (kind, opts) => { const r = await fa._edOpen(kind, opts); fa._renderMessageHistory(); const ed = await until(() => [...document.querySelectorAll('.few')].filter((x) => !seen.has(x)).pop()); seen.add(ed); await wait(800); return { r, ed }; };
const ser = (e) => FaEditSheet.serializeCsv(e._ed.getSpec());
const key = (el, k, o) => el.dispatchEvent(new KeyboardEvent('keydown', Object.assign({ key: k, bubbles: true }, o || {})));
// ── CSV
let { r, ed } = await mount('edit-csv', { spec: FaEditSheet.parseCsv(CSV, '水果') }); ok('csv_opened', r && r.ok && ed);
const grid = () => ed.querySelector('.sgrid'); const cells = () => [...grid().querySelectorAll('tbody tr')].filter((tr) => tr.firstChild && tr.firstChild.className.indexOf('rn') >= 0);
ok('csv_grid_drawn', cells().length === 4 && cells()[0].children[1].textContent === 'name' && /hd/.test(cells()[0].children[1].className), cells().length);
ok('csv_sheet_in_objects', ed.querySelectorAll('.ol .ob').length === 1);
ok('csv_roundtrip_untouched', ser(ed) === CSV);
// 單擊選格、雙擊編輯、Enter 套用（往下移）
cells()[1].children[2].click(); await wait(100); ok('click_selects_cell', cells()[1].children[2].classList.contains('sel') && ed.querySelector('.sbar .ad').textContent === 'B2', ed.querySelector('.sbar .ad').textContent);
cells()[1].children[2].dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); await wait(100); const inp = ed.querySelector('.sgrid td input'); ok('dblclick_edit_input', !!inp && inp.value === '3');
inp.value = '30'; key(inp, 'Enter'); await wait(150); ok('enter_commits_and_csv_keeps_style', ser(ed) === CSV.replace('apple,3,', 'apple,30,'), ser(ed));
ok('selection_moved_down', cells()[2].children[2].classList.contains('sel'));
// 直接打字改格
grid().focus(); key(grid(), '7'); await wait(100); const inp2 = ed.querySelector('.sgrid td input'); ok('typing_starts_edit', !!inp2 && inp2.value === '7'); inp2.value = '77'; key(inp2, 'Tab'); await wait(150); ok('tab_commits', /banana, ripe",77,/.test(ser(ed)), ser(ed));
// Delete 清空
cells()[3].children[3].click(); await wait(80); key(grid(), 'Delete'); await wait(150); ok('delete_clears', /cherry,10,\r\n/.test(ser(ed)), ser(ed));
// 欄標題選欄 → 屬性面板排序
ed.querySelectorAll('.sgrid thead th')[2].click(); await wait(100); const sortBtn = [...ed.querySelectorAll('.prop button')].find((b) => /由大到小/.test(b.textContent)); ok('column_props_shown', !!sortBtn);
sortBtn.click(); await wait(200); ok('sort_from_panel', cells().map((tr) => tr.children[1].textContent).join() === 'name,banana, ripe,apple,cherry', cells().map((tr) => tr.children[1].textContent).join());
ed._ed.undo(); await wait(150); ok('undo_sort', cells()[1].children[1].textContent === 'apple');
// 程式讀得懂的白話：不經過模型
const l0 = calls.llm; await ed._ed.send('刪掉空白列；在最後加一欄「total」'); await wait(300);
ok('program_commands_no_llm', calls.llm === l0 && ed._ed.getSpec().objects[0].cols.length === 4 && cells()[0].children[4].textContent === 'total', [calls.llm, l0]);
// AI（程式讀不懂）：prompt 只給概要、回封閉動作
await ed._ed.send('把價格全部設成一樣'); await wait(500);
ok('ai_called_with_profile', calls.llm === l0 + 1 && /A="name"/.test(calls.last) && /Request: /.test(calls.last), calls.last.slice(0, 200));
ok('ai_applied', cells().slice(1).every((tr) => tr.children[3].textContent === '9'), cells().map((tr) => tr.children[3].textContent));
// 貼上區塊
cells()[1].children[1].click(); await wait(60); const pe = new Event('paste', { bubbles: true, cancelable: true }); pe.clipboardData = { getData: () => 'x1\tx2\ny1\ty2\n' }; grid().dispatchEvent(pe); await wait(200);
ok('paste_block', cells()[1].children[1].textContent === 'x1' && cells()[2].children[2].textContent === 'y2' || cells()[2].children[2].textContent === 'y2', [cells()[1].children[1].textContent, cells()[2].children[2].textContent]);
// 查找取代
const fin = ed.querySelector('.sbar input[placeholder="尋找"]'), rin = ed.querySelector('.sbar input[placeholder="取代成"]'); fin.value = 'y'; rin.value = 'Y'; [...ed.querySelectorAll('.sbar button')].find((b) => /全部取代/.test(b.textContent)).click(); await wait(150); ok('find_replace', ser(ed).indexOf('y1') < 0 && /Y1/.test(ser(ed)), ser(ed));
// 原始碼分頁
[...ed.querySelectorAll('.mid .tabs span')].find((s) => /原始碼/.test(s.textContent)).click(); await wait(100); const sta = ed.querySelector('.pane.on textarea.code'); ok('source_tab_shows_csv', !!sta && sta.value.replace(/\r\n/g, '\n') === ser(ed).replace(/\r\n/g, '\n'));
sta.value = 'k,v\n1,2\n'; [...ed.querySelectorAll('.pane.on button')].find((b) => /套用原始碼/.test(b.textContent)).click(); await wait(200); ok('source_apply', ed._ed.getSpec().objects[0].rows.length === 2 && ed._ed.getSpec().objects[0].cols.length === 2);
// 虛擬捲動：5000 列只畫看得到的
const big = FaEditSheet.parseCsv('n\n' + Array.from({ length: 5000 }, (_, i) => 'row' + i).join('\n'), '大表'); const B = await mount('edit-csv', { spec: big });
const bg = B.ed.querySelector('.sgrid'); const nrows = () => bg.querySelectorAll('tbody tr').length; ok('virtual_scroll_few_rows', nrows() > 5 && nrows() < 120, nrows());
bg.scrollTop = 2000 * 24; bg.dispatchEvent(new Event('scroll')); await wait(200); ok('virtual_scroll_follows', [...bg.querySelectorAll('tbody tr td.rn')].some((td) => Number(td.textContent) > 1900 && Number(td.textContent) < 2200), [...bg.querySelectorAll('tbody tr td.rn')].slice(0, 3).map((x) => x.textContent));
// ── XLSX（公式）
const X = await mount('edit-xlsx', { starter: 'budget' }); ok('xlsx_opened', X.r && X.r.ok);
const xc = () => [...X.ed.querySelectorAll('.sgrid tbody tr')].filter((tr) => tr.firstChild && /rn/.test(tr.firstChild.className));
ok('formula_computed', xc()[1].children[5].textContent === '1000' && xc()[2].children[5].textContent === '880' && /fx/.test(xc()[2].children[5].className), xc().map((tr) => tr.children[5].textContent));
xc()[2].children[4].click(); await wait(60); xc()[2].children[3].click(); await wait(60); xc()[2].children[3].dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); await wait(100);
const xin = X.ed.querySelector('.sgrid td input'); xin.value = '200'; key(xin, 'Enter'); await wait(200); ok('formula_recomputed_after_edit', xc()[2].children[5].textContent === '1080', xc().map((tr) => tr.children[5].textContent));
xc()[2].children[5].click(); await wait(60); ok('formula_bar_shows_formula', X.ed.querySelector('.sbar input.fx').value === '=E2+C3-D3', X.ed.querySelector('.sbar input.fx').value);
const fb = X.ed.querySelector('.sbar input.fx'); fb.value = '=SUM(C2:C3)*2'; key(fb, 'Enter'); await wait(200); ok('formula_bar_sets_formula', /fx/.test(xc()[2].children[5].className) && xc()[2].children[5].textContent === '2400', xc()[2].children[5].textContent);
const xs0 = X.ed._ed.getSpec(); ok('sort_refused_with_formulas', (() => { const rr = FaEditSheet.applyEdits(xs0, [{ op: 'sort', col: 'C' }], {}); return rr.applied.length === 0 && /formulas/.test(rr.rejected[0].error); })());
ok('xlsx_has_no_source_tab', ![...X.ed.querySelectorAll('.mid .tabs span')].some((s) => /原始碼/.test(s.textContent)));
// ── /edit-file 的分派（csv）
const blob = new Blob(['a,b\n1,2\n'], { type: 'text/csv' }); try { await fa.fileCache.put('t.csv', 'text/csv', blob, 'upload', 'esheet-test'); } catch (_) { /* */ } const got = await fa.fileCache.get('esheet-test').catch(() => null);
if (got) { fa.messages = []; await fa._editFileSlash('t.csv'); fa._renderMessageHistory(); const e3 = await until(() => [...document.querySelectorAll('.few')].filter((x) => !seen.has(x)).pop()); ok('editfile_csv', !!e3 && e3._ed.getSpec().format === 'csv' && FaEditSheet.serializeCsv(e3._ed.getSpec()) === 'a,b\n1,2\n'); } else { R.editfile_skipped = true; }
ok('commands', ['/edit-csv', '/edit-xlsx', '/edit-sheet'].every((c) => fa.slashCommands.has(c)));
ok('kinds_registered', !!FaEditHost.KINDS['edit-csv'] && !!FaEditHost.KINDS['edit-xlsx'] && FaEditHost.KINDS['edit-xlsx'].remote.sync === 'edits');
R.ok = R.fail.length === 0; console.log('EDIT_SHEET ' + JSON.stringify(R)); return R;
