// /edit-markdown、/edit-text（真實 Electron；LLM 用假的）：開起來、預覽、雙擊就地改、程式讀得懂的白話（不經過模型）、AI 動作、原始碼套用保留 id、匯出、/edit-file、遠端 ask
// 用法：FA_DEBUG_EVAL_FILE=scripts/eval/edit_docs.eval.js xvfb-run -a node_modules/electron/dist/electron . --no-sandbox --use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader --user-data-dir=$(mktemp -d)
const fa = window.fa; const R = { fail: [] }; const wait = (ms) => new Promise((r) => setTimeout(r, ms)); fa.advancedSettings.offlineMode = false; fa.messages = [];
const until = async (f, ms = 15000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { const v = f(); if (v) return v; } catch (_) { /* */ } await wait(50); } return null; };
const ok = (name, cond, extra) => { R[name] = !!cond; if (!cond) R.fail.push(name + (extra !== undefined ? ' ' + JSON.stringify(extra).slice(0, 200) : '')); };
const calls = { llm: 0, last: '' };
fa._getApiConfig = () => ({ apiKey: 'test', apiUrl: 'http://127.0.0.1:9', apiModel: 'fake' });
fa._kiLlm = async (user) => { calls.llm++; calls.last = String(user); return JSON.stringify({ say: 'AI 加了一段', edits: [{ op: 'add_block', after: 'end', block: { type: 'para', text: 'AI 寫的結尾' } }] }); };
const MD = '# 標題\r\n\r\n第一段 hello\r\n\r\n- 甲\r\n- 乙\r\n\r\n```js\r\nconst a = 1;\r\n```\r\n';
const seen = new Set(); const mount = async (kind, opts) => { const r = await fa._edOpen(kind, opts); fa._renderMessageHistory(); const ed = await until(() => [...document.querySelectorAll('.few')].filter((x) => !seen.has(x)).pop()); seen.add(ed); await wait(700); return { r, ed }; };   // 新開的編輯器下一個畫面會自己彈成視窗（pop），等它穩定再操作
// ── Markdown：開起來
const spec0 = FaEditText.parse(MD, 'md'); spec0.title = '測試';
let { r, ed } = await mount('edit-markdown', { spec: spec0 }); ok('md_opened', r && r.ok && ed);
const blocks = () => [...ed.querySelectorAll('.tdoc .blk')];
ok('md_preview_blocks', blocks().length === 4 && /<h1>標題<\/h1>/.test(blocks()[0].innerHTML) && blocks()[2].querySelector('ul li'), blocks().length);
ok('md_objects_tree', ed.querySelectorAll('.ol .ob').length === 4 && ed.querySelector('.ol .ob .nm').textContent.indexOf('標題') >= 0);
// 雙擊就地改（原樣語法）
blocks()[1].dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); await wait(100);
const ta = ed.querySelector('.tdoc textarea.ed'); ok('md_inline_editor', !!ta && ta.value === '第一段 hello', ta && ta.value);
ta.value = '第一段 **hello** world'; ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true })); await wait(150);
ok('md_inline_applied', FaEditText.serialize(ed._ed.getSpec()) === MD.replace('第一段 hello', '第一段 **hello** world'), FaEditText.serialize(ed._ed.getSpec()));
ok('md_crlf_kept', /\r\n/.test(FaEditText.serialize(ed._ed.getSpec())) && !/[^\r]\n/.test(FaEditText.serialize(ed._ed.getSpec())));
// 程式讀得懂的白話：不經過模型
const l0 = calls.llm; await ed._ed.send('在最後加一段：結尾；刪掉第 3 段'); await wait(300);
ok('md_program_commands_no_llm', calls.llm === l0 && /結尾\r\n$/.test(FaEditText.serialize(ed._ed.getSpec())) && !/甲/.test(FaEditText.serialize(ed._ed.getSpec())), FaEditText.serialize(ed._ed.getSpec()));
// 程式讀不懂：走 AI，AI 回封閉動作
await ed._ed.send('把整份文件寫得更專業一點'); await wait(500);
ok('md_ai_called_with_ids', calls.llm === l0 + 1 && /\[b1\]/.test(calls.last) && /Request: /.test(calls.last), calls.last.slice(0, 120));
ok('md_ai_applied', /AI 寫的結尾/.test(FaEditText.serialize(ed._ed.getSpec())));
// 復原只退一步
const nb = ed._ed.getSpec().objects.length; ed._ed.undo(); await wait(100); ok('md_undo', ed._ed.getSpec().objects.length === nb - 1);
// 原始碼分頁：套用時沒變的區塊沿用 id
const idsBefore = ed._ed.getSpec().objects.map((b) => b.id); const tabSrc = [...ed.querySelectorAll('.mid .tabs span')].find((s) => /原始碼/.test(s.textContent)); tabSrc.click(); await wait(100);
const sta = ed.querySelector('.pane.on textarea.code'); ok('md_source_shown', !!sta && sta.value === FaEditText.serialize(ed._ed.getSpec()).replace(/\r\n/g, '\n'));
sta.value = sta.value.replace('第一段 **hello** world', '第一段 changed'); [...ed.querySelectorAll('.pane.on button')].find((b) => /套用原始碼/.test(b.textContent)).click(); await wait(150);
const idsAfter = ed._ed.getSpec().objects.map((b) => b.id); ok('md_source_ids_kept', idsAfter.length === idsBefore.length && idsAfter.join() === idsBefore.join(), { idsBefore, idsAfter });   // 改的那一段在同一個位置，也沿用 id
ok('md_source_text', /第一段 changed/.test(FaEditText.serialize(ed._ed.getSpec())));
// 匯出：隱藏的區塊不輸出
ed._ed.ctx.apply([{ op: 'set_visible', id: idsAfter[0], visible: false }], '隱藏標題'); await wait(80);
const ex = await (async () => { const sp = ed._ed.getSpec(); return FaEditTextUI.visibleOnly(sp); })(); ok('md_export_hides', !/^# 標題/.test(FaEditText.serialize(ex)));
// 重新載入（專案還原）：跟剛剛一樣
const pid = [...fa._edEditors.keys()].pop().split(':')[1]; await wait(600); const proj = await FaEditStore.loadProject('edit-markdown', pid); ok('md_saved', proj && proj.spec && proj.spec.objects.length === ed._ed.getSpec().objects.length);
// ── 純文字
({ r, ed } = await mount('edit-text', { spec: FaEditText.parse('line1\nline2\n\nline4', 'txt') })); ok('txt_opened', r && r.ok && ed && ed.querySelectorAll('.tdoc .blk').length === 4, ed && ed.querySelectorAll('.tdoc .blk').length);
await ed._ed.send('把 line2 全部換成 second'); await wait(200); ok('txt_replace_exact', FaEditText.serialize(ed._ed.getSpec()) === 'line1\nsecond\n\nline4', FaEditText.serialize(ed._ed.getSpec()));
await ed._ed.send('刪掉第 3 行'); await wait(200); ok('txt_delete_line', FaEditText.serialize(ed._ed.getSpec()) === 'line1\nsecond\nline4', FaEditText.serialize(ed._ed.getSpec()));
ok('txt_no_heading_convert', !([...ed.querySelectorAll('.prop select')].some((s) => /轉成/.test(s.textContent))));
// ── /edit-file：附檔（用 fileCache）
const blob = new Blob(['# 從檔案\n\n內容\n'], { type: 'text/markdown' }); const fid = 'edocs-test-file';
try { await fa.fileCache.put('notes.md', 'text/markdown', blob, 'upload', fid); } catch (_) { /* 下面看有沒有 */ }
const got = await fa.fileCache.get(fid).catch(() => null);
if (got) { fa.messages = []; await fa._editFileSlash('notes.md'); fa._renderMessageHistory(); const e2 = await until(() => [...document.querySelectorAll('.few')].filter((x) => !seen.has(x)).pop()); ok('editfile_md', !!e2 && FaEditText.serialize(e2._ed.getSpec()) === '# 從檔案\n\n內容\n' && e2._ed.getSpec().title === 'notes', e2 && FaEditText.serialize(e2._ed.getSpec())); }
else R.editfile_skipped = 'fileCache.put 不存在或失敗';
// ── 指令都登記了（含別名與 /edit-file）
ok('commands', ['/edit-markdown', '/edit-md', '/edit-text', '/edit-txt', '/edit-file'].every((c) => fa.slashCommands.has(c)));
ok('kinds_registered', !!FaEditHost.KINDS['edit-markdown'] && !!FaEditHost.KINDS['edit-text'] && FaEditHost.KINDS['edit-markdown'].remote.sync === 'edits');
ok('remote_not_dispatchable', !fa._rgSlashRemotable || ['/edit-markdown', '/edit-md', '/edit-text', '/edit-txt', '/edit-file'].every((c) => !fa._rgSlashRemotable(c)));
R.ok = R.fail.length === 0; console.log('EDIT_DOCS ' + JSON.stringify(R)); return R;
