'use strict';
// 工具預算核心的單元測試（純 Node）：node renderer/src/tools/tool_budget_core.test.js
const assert = require('assert'); const B = require('./tool_budget_core.js');
let ok = 0; const bad = []; const t = (n, f) => { try { f(); ok++; } catch (e) { bad.push(n); console.log('FAIL', n, String(e.stack || e).slice(0, 400)); } };

t('短說明：取第一句、去掉括號補充、限長、明確的 short 優先', () => {
  assert.strictEqual(B.shortOf('a', '列出使用者目前已授權給AI讀寫的File Access Point（真實磁碟資料夾，不含系統資料夾）。回傳清單。'), '列出使用者目前已授權給AI讀寫的File Access Point');
  assert.strictEqual(B.shortOf('a', '把圖片合成一份PDF：可以指定順序，每一頁可以縮放、旋轉、做影像處理。純本地。').startsWith('把圖片合成一份PDF'), true);
  assert.ok(B.shortOf('x', 'x'.repeat(400)).length <= B.LIMITS.shortChars); assert.strictEqual(B.shortOf('tool_name', ''), 'tool_name'); assert.strictEqual(B.shortOf('a', '很長很長的說明', '明確的短說明'), '明確的短說明');
  assert.ok(!/\*\*/.test(B.shortOf('a', '**改程式最簡單的方式：「找這段、換成那段」**。其餘說明')));
  assert.ok(B.shortOf('a', 'Validate a deck description (YAML). Returns errors.').startsWith('Validate a deck description'));
});
t('精簡參數 schema：結構與型別、必填、列舉不變；欄位說明縮成第一小句；default 與 examples 拿掉', () => {
  const full = { type: 'object', required: ['files'], properties: { files: { type: 'array', items: { type: 'string', description: '圖片 file_id 或檔名，照這個順序一張一頁（留空＝附件）' }, description: '（選填）要轉的圖片，依序一張一頁；留空＝這個對話附加的全部圖片' }, fit: { type: 'string', enum: ['contain', 'cover'], default: 'contain', description: 'contain（預設）整張放進頁面，等比置中，cover 填滿裁切' } }, additionalProperties: false };
  const c = B.compactSchema(full); assert.deepStrictEqual(c.required, ['files']); assert.deepStrictEqual(c.properties.fit.enum, ['contain', 'cover']); assert.strictEqual(c.properties.fit.default, undefined); assert.strictEqual(c.properties.files.type, 'array'); assert.strictEqual(c.properties.files.items.type, 'string');
  assert.ok(c.properties.files.description.length <= 40, c.properties.files.description); assert.ok(JSON.stringify(c).length < JSON.stringify(full).length); assert.strictEqual(c.additionalProperties, false);
  assert.strictEqual(B.compactSchema(undefined), undefined); assert.deepStrictEqual(B.compactSchema({ type: 'object', properties: {}, additionalProperties: true }), { type: 'object', properties: {}, additionalProperties: true });
});
t('精簡參數 schema：巢狀太深（陣列裡物件的欄位）只留型別，必填與頂層結構不受影響', () => {
  const s = { type: 'object', required: ['pages'], properties: { pages: { type: 'array', items: { type: 'object', properties: { file: { type: 'string', description: '來源' }, ops: { type: 'array', items: { type: 'object', properties: { op: { type: 'string', enum: ['a', 'b'] } } } } } } } } };
  const c = B.compactSchema(s); assert.deepStrictEqual(c.required, ['pages']); assert.strictEqual(c.properties.pages.items.type, 'object'); assert.deepStrictEqual(c.properties.pages.items.properties.file, { type: 'string' }); assert.deepStrictEqual(c.properties.pages.items.properties.ops, { type: 'array' });
});
t('檢索：中文／英文詞命中、稀有詞加權、名稱命中加倍、沒有明顯對應就空陣列', () => {
  const idx = B.buildIndex([{ id: 'images_to_pdf', text: '把圖片合成一份PDF 可以指定順序 縮放 旋轉', nameText: 'images to pdf images_to_pdf' }, { id: 'merge_pdfs', text: '把多個檔案合併成一份PDF 圖片 文字檔 docx xlsx', nameText: 'merge pdfs merge_pdfs' }, { id: 'render_drawing', text: '畫一張通用向量圖 流程圖 示意圖', nameText: 'render drawing' }, { id: 'git_commit', text: '把變更加入 staging 並 commit', nameText: 'git commit' }, { id: 'fap_read_file', text: '讀取授權資料夾裡的文字檔', nameText: 'fap read file' }, { id: 'weather', text: '查詢天氣預報', nameText: 'weather' }]);
  const r = B.rank(idx, '先把圖片縮放旋轉，再合併成一個pdf'); assert.ok(r.length >= 1 && ['images_to_pdf', 'merge_pdfs'].includes(r[0].id), JSON.stringify(r));
  assert.deepStrictEqual(B.rank(idx, '今天的股價怎麼樣'), []); assert.deepStrictEqual(B.rank(idx, 'x'), []); assert.ok(B.rank(idx, '畫一張流程圖', { minHit: 2, minScore: 4 }).some((x) => x.id === 'render_drawing'));
  assert.strictEqual(B.rank(idx, '合併 pdf 檔案', { minKeep: 2, minHit: 99 }).length, 2); assert.ok(B.rank(idx, '合併 pdf 圖片', { exclude: new Set(['merge_pdfs']), minHit: 2, minScore: 3 }).every((x) => x.id !== 'merge_pdfs'));
});
const mkProg = (extra) => ({ own: ['playbook_state', 'programming_domains', 'sandbox_capabilities', 'sandbox_html', 'sandbox_worker', 'sandbox_mock', 'sandbox_py_app', 'language_explore', 'list_file_access_points', 'fap_list_files', 'fap_find_file', 'repo_map', 'repo_ask', 'repo_sql', 'repo_read_doc', 'repo_wiki', 'explain_code', 'behavior_define', 'coding_workspace', 'coding_read_file', 'apply_git_patch', 'git_inspect', 'git_commit', 'coding_run_check', 'coding_run_tests', 'terminal_create', 'terminal_list', 'terminal_run', 'terminal_get_text', 'browser_search', 'fetch_web_page', 'python_execute', 'bash_execute'].concat(extra || []) });
t('切割：prog_* 的共用 28 工具被分到階段群組，協調者只剩狀態工具與專屬工具；聯集＝原本的工具集', () => {
  const input = { prog_bmc: mkProg(['render_uml_diagram', 'programming_knowledge']), prog_graphics: mkProg(['render_drawing', 'render_2d_animation', 'render_3d_scene', 'render_uml_diagram']), small: { own: ['a', 'b'] } };
  const plan = B.planSplit(input);
  for (const k of ['prog_bmc', 'prog_graphics']) {
    const d = plan.domains[k]; assert.ok(d, k); const union = new Set(d.own); for (const c of d.children) for (const x of c.tools) union.add(x);
    assert.deepStrictEqual(Array.from(union).sort(), input[k].own.slice().sort()); assert.ok(d.own.length <= 20, k + ' own=' + d.own.length); assert.ok(d.own.includes('playbook_state') && d.own.includes('programming_domains'));
    assert.ok(d.children.length >= 5 && d.children.length <= B.LIMITS.mixerChildren, 'children=' + d.children.length); for (const c of d.children) assert.ok(c.tools.length <= 12);
    const ph = d.children.map((c) => plan.groups[c.group].phase); const order = ph.map((p) => B.PHASE_ORDER.indexOf(p)); assert.deepStrictEqual(order, order.slice().sort((a, b) => a - b));
  }
  assert.ok(!plan.domains.small); assert.ok(plan.groups.ph_repo && plan.groups.ph_sandbox);
  assert.ok(plan.domains.prog_graphics.own.includes('render_3d_scene') && plan.domains.prog_graphics.own.includes('render_drawing'));
});
t('切割：不超標的不動、noSplit 不動、沒有符合群組的記為略過並建議', () => {
  const big = { own: Array.from({ length: 30 }, (_, i) => 'zz_tool_' + i) }; const p = B.planSplit({ big, deck: { own: mkProg().own, noSplit: true }, ok: { own: ['a'] } });
  assert.ok(!p.domains.big && !p.domains.deck && !p.domains.ok); assert.ok(p.skipped.some((s) => s.key === 'big') && p.skipped.some((s) => s.key === 'deck'));
  const cl = B.autoClusters(big.own.concat(['git_log', 'git_commit', 'git_push', 'lonely']), 12); assert.ok(cl.every((g) => g.tools.length <= 12)); assert.strictEqual(cl.reduce((a, g) => a + g.tools.length, 0), 34);
});
t('切割：coding（44 個工具）切完協調者自己 ≤ 20，且 CI／設計／日誌各成群組', () => {
  const own = ['fs_read_file', 'fs_list_files', 'fs_find_file', 'fs_grep', 'fs_stat', 'batch_process_items', 'analyze_large_file', 'get_large_file_analysis_chunk', 'run_command', 'browser_search', 'fetch_web_page', 'repo_map', 'repo_ask', 'repo_sql', 'repo_read_doc', 'repo_wiki', 'explain_code', 'language_explore', 'programming_knowledge', 'apply_git_patch', 'git_inspect', 'coding_task_state', 'coding_workspace', 'coding_edit', 'coding_patch_tool', 'ci_connections', 'gerrit', 'github_ci', 'jenkins', 'ci_triage', 'pipeline_inspect', 'ci_guide', 'uml_to_code', 'design_choices', 'uml_design', 'uml_guide', 'ask_user_card', 'log_learn', 'log_ask', 'mix_understand', 'mix_highlight', 'glue_list', 'glue_define', 'glue_report'];
  assert.strictEqual(own.length, 44); const p = B.planSplit({ coding: { own } }); const d = p.domains.coding; assert.ok(d && d.own.length <= 6, JSON.stringify(d && d.own)); assert.ok(d.own.includes('coding_task_state'));
  const ph = d.children.map((c) => p.groups[c.group].phase); for (const need of ['explore', 'understand', 'implement', 'ci', 'design', 'logs']) assert.ok(ph.includes(need), need + ' ' + ph.join());
});
t('預算報告：太長的短說明、太肥的 schema、工具太多的領域、太寬的協調者都要抓到並給建議', () => {
  const r = B.budgetReport({ tools: [{ name: 'a', short: 'x'.repeat(200), schemaTokens: 100 }, { name: 'b', short: 'ok', schemaTokens: 1500 }, { name: 'c', short: 'ok', schemaTokens: 50 }], domains: [{ key: 'many', tools: Array.from({ length: 25 }, () => 'c') }, { key: 'mix', tools: ['c'], mixer: true, children: 12 }, { key: 'fine', tools: ['c'] }] });
  assert.ok(!r.ok); const kinds = r.violations.map((v) => v.kind + ':' + v.key).sort(); assert.deepStrictEqual(kinds, ['domain_too_many_tools:many', 'mixer_too_wide:mix', 'schema_too_big:b', 'short_too_long:a']); assert.ok(r.violations.every((v) => v.suggest));
  assert.ok(B.budgetReport({ tools: [{ name: 'a', short: 'ok', schemaTokens: 100 }], domains: [{ key: 'd', tools: ['a'] }] }).ok);
});
t('照預算收斂：太大的 schema 逐級收緊，欄位名／型別／必填／列舉保留', () => {
  const props = {}; for (let i = 0; i < 30; i++) props['p' + i] = { type: 'string', description: '這是第' + i + '個欄位的說明，寫得相當長相當長相當長相當長相當長相當長' };
  props.mode = { type: 'string', enum: ['a', 'b'], description: '模式說明很長很長很長很長很長很長很長很長' };
  props.pages = { type: 'array', items: { type: 'object', properties: { file: { type: 'string', description: '檔案說明很長很長很長很長很長很長很長很長很長' }, rotate: { type: 'number' } }, required: ['file'] } };
  const schema = { type: 'object', properties: props, required: ['p0'] };
  const loose = B.estimateTokens(JSON.stringify(B.compactSchema(schema))); const tight = B.compactToBudget(schema, Math.floor(loose * 0.6));
  assert.ok(B.estimateTokens(JSON.stringify(tight)) < loose);
  assert.deepStrictEqual(Object.keys(tight.properties), Object.keys(props)); assert.deepStrictEqual(tight.required, ['p0']); assert.deepStrictEqual(tight.properties.mode.enum, ['a', 'b']);
  assert.strictEqual(tight.properties.pages.type, 'array');
  assert.strictEqual(JSON.stringify(B.compactToBudget(schema, 1e9)), JSON.stringify(B.compactSchema(schema)));
});
console.log(ok + ' passed, ' + bad.length + ' failed', bad); process.exit(bad.length ? 1 : 0);
