// 本機檔案綁定（真實 Electron 桌面版：desktopAPI.rawfs）：/edit-file 路徑開檔並綁定、改了顯示未存、Ctrl+S 存回（沒動到的部分位元組不變）、外部修改衝突、覆蓋、重新載入、自動存檔、docx 存回、解除綁定
// 用法：FA_DEBUG_EVAL_FILE=scripts/eval/edit_localfile.eval.js xvfb-run -a node_modules/electron/dist/electron . --no-sandbox --use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader --user-data-dir=$(mktemp -d)
const fa = window.fa; const R = { fail: [] }; const wait = (ms) => new Promise((r) => setTimeout(r, ms)); fa.advancedSettings.offlineMode = false; fa.messages = [];
const until = async (f, ms = 15000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { const v = f(); if (v) return v; } catch (_) { /* */ } await wait(50); } return null; };
const ok = (name, cond, extra) => { R[name] = !!cond; if (!cond) R.fail.push(name + (extra !== undefined ? ' ' + JSON.stringify(extra).slice(0, 200) : '')); };
const raw = window.desktopAPI && window.desktopAPI.rawfs; ok('has_rawfs', !!raw); if (!raw) { R.ok = false; return R; }
const b64 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); };
const putText = (p, t) => raw.writeFile(p, { text: t }); const putBytes = (p, u8) => raw.writeFile(p, { base64: b64(u8) });
const getText = async (p) => (await raw.readFile(p, 'utf8')).text; const getBytes = async (p) => { const r = await raw.readFile(p); const bin = atob(r.base64), u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; };
const dir = '/tmp/fa-lf-' + Math.random().toString(36).slice(2, 8); await raw.mkdir(dir);
const seen = new Set(); const open = async (path) => { fa.messages = []; await fa._editFileSlash(path); fa._renderMessageHistory(); const ed = await until(() => [...document.querySelectorAll('.few')].filter((x) => !seen.has(x)).pop()); if (ed) seen.add(ed); await wait(900); return ed; };
const ctrlS = (ed) => ed.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true }));
const fileBtn = (ed) => [...document.querySelectorAll('button')].find((b) => ed.contains(b) || true ? false : false) || [...(ed._win && ed._win.bar ? ed._win.bar.querySelectorAll('button') : []), ...ed.querySelectorAll('button')].find((b) => /💾/.test(b.textContent));
const allText = (ed) => ed.textContent + ((ed._win && ed._win.bar && ed._win.bar.textContent) || '');
// ── CSV
const CSV = 'name,qty\r\napple,3\r\n"banana, ripe",2\r\n'; const pcsv = dir + '/a.csv'; await putText(pcsv, CSV);
const ed = await open(pcsv); ok('csv_opened_by_path', !!ed && ed._ed.getSpec().format === 'csv' && FaEditSheet.serializeCsv(ed._ed.getSpec()) === CSV);
ok('bound_label_shown', /a\.csv/.test(allText(ed)) && /已存回檔案/.test(allText(ed)), allText(ed).slice(0, 200));
ed._ed.ctx.apply([{ op: 'set_cell', row: 2, col: 'qty', v: '30' }], '改', '', 'panel'); await wait(200); ok('dirty_marker', /還沒存回檔案/.test(allText(ed)));
ctrlS(ed); await wait(700); const t1 = await getText(pcsv); ok('ctrl_s_saves_untouched_rest_same', t1 === CSV.replace('apple,3', 'apple,30'), t1); ok('saved_marker', /已存回檔案/.test(allText(ed)));
// 外部修改 → 衝突，不覆蓋
await putText(pcsv, 'name,qty\r\nexternal,1\r\n'); ed._ed.ctx.apply([{ op: 'set_cell', row: 3, col: 'qty', v: '99' }], '改', '', 'panel'); await wait(150); ctrlS(ed); await wait(700);
ok('conflict_not_overwritten', (await getText(pcsv)) === 'name,qty\r\nexternal,1\r\n' && /被改過/.test(allText(ed)), await getText(pcsv));
// 開選單 → 覆蓋存回
const btn = [...ed.querySelectorAll('button'), ...(ed._win && ed._win.bar ? ed._win.bar.querySelectorAll('button') : [])].find((b) => /💾/.test(b.textContent)); ok('file_button_found', !!btn); btn.click(); await wait(200);
const force = [...ed.querySelectorAll('.filepanel button')].find((b) => /覆蓋存回/.test(b.textContent)); ok('force_button_shown', !!force); force.click(); await wait(700); ok('force_overwrites', /apple,30/.test(await getText(pcsv)) && /99/.test(await getText(pcsv)), await getText(pcsv));
// 重新載入
await putText(pcsv, 'name,qty\r\nreloaded,7\r\n'); const rl = [...ed.querySelectorAll('.filepanel button')].find((b) => /重新從檔案載入/.test(b.textContent)); rl.click(); await wait(600); ok('reload_from_file', FaEditSheet.serializeCsv(ed._ed.getSpec()) === 'name,qty\r\nreloaded,7\r\n', FaEditSheet.serializeCsv(ed._ed.getSpec()));
ed._ed.undo(); await wait(150); ok('reload_is_undoable', /apple/.test(FaEditSheet.serializeCsv(ed._ed.getSpec())));
// 自動存檔
const au = ed.querySelector('.filepanel input[type=checkbox]'); au.checked = true; au.dispatchEvent(new Event('change', { bubbles: true })); await wait(100);
ed._ed.ctx.apply([{ op: 'set_cell', row: 2, col: 'name', v: 'AUTO' }], '改', '', 'panel'); await wait(2800); ok('auto_save_after_change', /AUTO/.test(await getText(pcsv)), await getText(pcsv));
// 綁定資訊有存在專案裡（重開後還在）
const pid = [...fa._edEditors.keys()].filter((k) => /^edit-csv:/.test(k)).pop().split(':')[1]; await wait(600); const proj = await FaEditStore.loadProject('edit-csv', pid); ok('binding_persisted', proj.origin && proj.origin.file && proj.origin.file.via === 'desktop' && proj.origin.file.path === pcsv && proj.origin.file.auto === true && proj.origin.file.enc === 'utf-8', proj.origin);
// 解除綁定
const un = [...ed.querySelectorAll('.filepanel button')].find((b) => /解除綁定/.test(b.textContent)); un.click(); await wait(300); ok('unbound', !allText(ed).match(/已存回檔案|還沒存回檔案/) && !fa._edFileB.get('edit-csv:' + pid));
// ── Markdown（含 BOM、CRLF）：沒動到的區塊原樣
const MD = '﻿# 標題\r\n\r\n第一段\r\n'; const pmd = dir + '/n.md'; await putText(pmd, MD); const em = await open(pmd); ok('md_opened', !!em && FaEditText.serialize(em._ed.getSpec()) === MD);
em._ed.ctx.apply([{ op: 'add_block', after: 'end', block: { type: 'para', text: '新增' } }], '改', '', 'panel'); await wait(150); ctrlS(em); await wait(700); const mt = await getText(pmd); ok('md_saved_bom_crlf_kept', mt.startsWith('﻿# 標題\r\n\r\n第一段\r\n') && /新增/.test(mt), JSON.stringify(mt));
// ── DOCX：二進位存回，其他 part 保留
let Z = null; try { await fa._ensureJSZipLoaded(); Z = window.JSZip; } catch (_) { Z = null; }
if (Z) {
  const base = await FaEditDocx.build(FaEditDocx.starter('letter'), Z); const z0 = await Z.loadAsync(base); z0.file('word/header1.xml', '<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:r><w:t>頁首ABC</w:t></w:r></w:p></w:hdr>'); const pdoc = dir + '/l.docx'; await putBytes(pdoc, await z0.generateAsync({ type: 'uint8array' }));
  const dd = await open(pdoc); ok('docx_opened_by_path', !!dd && dd._ed.getSpec().format === 'docx' && FaEditDocx.plain(dd._ed.getSpec().objects[1]) === '敬啟者：');
  dd._ed.ctx.apply([{ op: 'set_text', id: dd._ed.getSpec().objects[2].id, text: '改過的內文' }], '改', '', 'panel'); await wait(150); ctrlS(dd); await wait(1500);
  const saved = await getBytes(pdoc), zs = await Z.loadAsync(saved), back = await FaEditDocx.read(saved, Z, 'x'); ok('docx_saved_back', FaEditDocx.plain(back.objects[2]) === '改過的內文' && FaEditDocx.plain(back.objects[1]) === '敬啟者：', back.objects.map(FaEditDocx.plain));
  ok('docx_other_parts_kept', !!zs.file('word/header1.xml') && /頁首ABC/.test(await zs.file('word/header1.xml').async('string')));
} else { R.docx_skipped = 'no JSZip'; }
ok('slash_path_helper', fa._edIsLocalPath('/a/b.csv') && !fa._edIsLocalPath('b.csv'));
await raw.remove(dir, true);
R.ok = R.fail.length === 0; console.log('EDIT_LOCALFILE ' + JSON.stringify(R)); return R;
