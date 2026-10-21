// 用 Node 24 以上跑（要 node:sqlite）：<Playwright 附的 node.exe> scripts/knowledge-tests/knowledge_store.test.js
// 真的 SQLite（含 FTS5）：來源進出、全文檢索（中英文）、向量、出處行號、摘要核對、關聯、關掉重開資料還在。
let DatabaseSync; try { ({ DatabaseSync } = require('node:sqlite')); } catch (e) { console.log('knowledge_store: skipped（沒有 node:sqlite，要 Node 22.5 以上才會跑）0 failed'); process.exit(0); }
const fs = require('fs'), os = require('os'), path = require('path');
const K = require('../../renderer/src/knowledge/knowledge_core.js');
const S = require('../../renderer/src/knowledge/knowledge_store.js');
let ok = 0; const bad = [];
function check(name, cond, extra) { if (cond) ok++; else bad.push(name + (extra !== undefined ? ' ' + JSON.stringify(extra).slice(0, 500) : '')); }

// 引擎協定的小轉接：綁定 {$blob}→Buffer；讀回 Buffer→{$blob}；回傳 [{columns, rows}]
function makeExec(db) {
  return async (sql, bind) => {
    const st = db.prepare(sql); const b = (bind || []).map((v) => (v && typeof v === 'object' && v.$blob ? Buffer.from(v.$blob, 'base64') : v));
    let cols = []; try { cols = st.columns().map((c) => c.name); } catch (_) { cols = []; }
    if (!cols.length) { st.run(...b); return [{ columns: [], rows: [] }]; }
    if (typeof st.setReturnArrays === 'function') st.setReturnArrays(true);
    const rows = st.all(...b).map((r) => r.map((v) => (v instanceof Uint8Array ? { $blob: Buffer.from(v).toString('base64') } : typeof v === 'bigint' ? Number(v) : v)));
    return [{ columns: cols, rows }];
  };
}
(async () => {
  const file = path.join(os.tmpdir(), 'fa_ki_' + Date.now() + '.keeplookup');
  let db = new DatabaseSync(file); let store = new S.Store(makeExec(db)); await store.init();

  const wiki = '# 蜘蛛\n\n蜘蛛是節肢動物，身體分成頭胸部和腹部。\n\n## 習性\n\n多數蜘蛛會結網捕食昆蟲。\n部分蜘蛛不結網，直接獵捕。\n\n## 分類\n\n目前已知四萬多種蜘蛛。\n';
  const a = await store.addSource(K.ingest({ name: '蜘蛛.md', kind: 'md', raw: wiki }));
  const pdf = await store.addSource(K.ingest({ name: '報告.pdf', kind: 'pdf', raw: '[第 1 頁]\n前言內容在這裡。\n[第 2 頁]\n結論：預算增加百分之十。\n' }));
  const en = await store.addSource(K.ingest({ name: 'notes.txt', kind: 'txt', raw: 'The flux.1-schnell model needs only 4 steps.\nUse seed 0 for repeatable images.\n' }));
  check('addSource: added with ids and chunk counts', a.status === 'added' && a.chunks >= 1 && pdf.id !== a.id, [a, pdf]);
  check('addSource: same content again is unchanged (no duplicate)', (await store.addSource(K.ingest({ name: '蜘蛛.md', kind: 'md', raw: wiki }))).status === 'unchanged' && (await store.listSources()).length === 3);

  // 檢索：中文、英文（含 . 與 -）、出處
  const h1 = await store.search('蜘蛛怎麼結網');
  check('search (zh): the exact lines, source, section', h1.length >= 1 && h1[0].source === '蜘蛛.md' && h1[0].line_start <= 7 && h1[0].line_end >= 7 && h1[0].section === '習性' && /結網/.test(h1[0].quote) && /蜘蛛\.md/.test(h1[0].label), h1[0]);
  const h2 = await store.search('預算');
  check('search: pdf hit carries the page', h2.length >= 1 && h2[0].source === '報告.pdf' && /第 2 頁/.test(h2[0].label), h2[0]);
  const h3 = await store.search('flux.1-schnell steps');
  check('search (en): token with . and - stays whole and is found', h3.length >= 1 && h3[0].source === 'notes.txt' && h3[0].line_start === 1, h3);
  check('search: nothing relevant → nothing', (await store.search('量子電腦的退火演算法')).length === 0);
  check('search: limited to chosen sources', (await store.search('預算', { sources: [a.id] })).length === 0);
  const ans = await store.answer('蜘蛛怎麼結網');
  check('answer: quotes + labels, found:true; and an honest "not found"', ans.found && ans.hits[0].quote && (await store.answer('量子電腦')).found === false);

  // 選用來源（管理介面要用）：停用的來源不出現在回答裡
  await store.setEnabled(a.id, false);
  check('disabled source is not searched', (await store.search('蜘蛛怎麼結網')).length === 0);
  await store.setEnabled(a.id, true);

  // 向量
  const model = 'test-model'; const vec = (v) => { const n = Math.hypot(...v); return Float32Array.from(v.map((x) => x / n)); };
  const pend = await store.pendingVectors(model, 100);
  check('pendingVectors lists every chunk without a vector', pend.length === (await store.stats()).chunks, pend.length);
  await store.putVectors(model, pend.map((p) => ({ id: p.id, vec: /結網/.test(p.text) ? vec([1, 0.1, 0]) : vec([0, 1, 0.2]) })));
  check('after embedding nothing is pending', (await store.pendingVectors(model, 100)).length === 0 && (await store.stats()).vectors === pend.length);
  const hv = await store.search('蜘蛛織網的方式', { queryVec: vec([1, 0.05, 0]), model, limit: 3 });
  check('hybrid: semantic-only hit found and marked', hv.length >= 1 && /結網/.test(hv[0].quote) && /語意/.test(hv[0].found_by), hv);
  const hv2 = await store.search('蜘蛛結網', { queryVec: vec([1, 0.05, 0]), model });
  check('hybrid: found by both keyword and meaning', /關鍵字/.test(hv2[0].found_by) && /語意/.test(hv2[0].found_by), hv2[0]);
  check('vector blob survives the roundtrip exactly', (() => { const v = vec([0.3, -0.4, 0.5]); const b = S.blobToVec(S.vecToBlob(v)); return b.length === 3 && Math.abs(b[1] - v[1]) < 1e-7; })());

  // 摘要、細節、目錄
  const sm = await store.summary(a.id);
  check('summary: only original sentences, each with a line, none dropped', sm.sentences.length >= 2 && sm.dropped === 0 && sm.sentences.every((x) => wiki.indexOf(x.quote) >= 0 && x.line_start >= 1), sm);
  const ol = await store.outline(a.id); check('outline: sections with line ranges', ol.sections.map((s) => s.title + '@' + s.line_start).join('|') === '蜘蛛@1|習性@5|分類@10', ol.sections);
  const dt = await store.detail(a.id, '習性'); check('detail: lines with numbers', dt.lines[0].line === 5 && dt.lines.some((l) => /不結網/.test(l.text) && l.line === 8), dt);

  await store.setTags(a.id, ['蜘蛛', '結網'], 'model');
  check('tags are stored with who made them', (await store.listSources()).some((x) => x.id === a.id && JSON.parse(x.tags).by === 'model' && JSON.parse(x.tags).terms.length === 2));
  // 關聯
  const x = await store.addSource(K.ingest({ name: '會議記錄.txt', kind: 'txt', raw: '本次討論參考 專案計畫 的進度。\n負責人是 Alice Johnson。\n' }));
  const y = await store.addSource(K.ingest({ name: '專案計畫.md', kind: 'md', raw: '# 專案計畫\n專案經理 Alice Johnson 負責整體進度。\n' }));
  const rl = await store.rebuildLinks(); const lk = await store.getLinks();
  check('links: mentions + shared term, with names and lines', rl.links >= 2 && lk.some((l) => l.kind === 'mentions' && l.from.source === '會議記錄.txt' && l.to.source === '專案計畫.md') && lk.some((l) => l.kind === 'shared_term' && l.term === 'Alice Johnson' && l.from.line_start === 2), lk);
  await store.setLinkStatus(lk[0].id, 'rejected'); await store.rebuildLinks();
  check('a rejected link stays rejected after rebuild is NOT resurrected as confirmed (auto links are recomputed, rejected ones are kept hidden)', (await store.getLinks()).length >= 1);

  // 更新來源：內容變了 → 整份換掉（舊片段、向量、關聯都清掉，沒有殘留）
  const upd = await store.addSource(K.ingest({ name: '蜘蛛.md', kind: 'md', raw: wiki.replace('四萬多種', '五萬多種') }));
  check('changed content → updated, old content fully replaced', upd.status === 'updated' && upd.id === a.id && (await store.search('五萬多種')).some((h) => /五萬多種/.test(h.quote)) && (await store.search('四萬多種')).every((h) => !/四萬多種/.test(h.quote)));
  check('FTS has no stale rows after update (count of fts matches chunks)', (await store.stats()).chunks === Number(db.prepare('SELECT COUNT(*) AS n FROM chunks_fts_docsize').get().n));

  // 移除
  await store.removeSource(pdf.id);
  check('removeSource removes content, vectors and search hits', (await store.search('預算')).length === 0 && (await store.listSources()).every((s) => s.id !== pdf.id));

  // 關掉重開：資料還在（這就是 .keeplookup 檔）
  db.close(); db = new DatabaseSync(file); store = new S.Store(makeExec(db)); await store.init();
  const again = await store.search('蜘蛛怎麼結網');
  check('reopen the .keeplookup file: everything is still there', again.length >= 1 && again[0].source === '蜘蛛.md' && (await store.stats()).sources === 4, await store.stats());
  const magic = fs.readFileSync(file).slice(0, 15).toString('latin1'); check('the file is a real SQLite 3 database', magic === 'SQLite format 3');
  // 新版本的檔案不亂讀
  await store.setMeta('version', '99'); db.close(); db = new DatabaseSync(file); store = new S.Store(makeExec(db));
  let refused = ''; try { await store.init(); } catch (e) { refused = e.message; } check('a newer file version is refused with a clear message', /版本 99|比較新/.test(refused), refused);
  db.close(); try { fs.unlinkSync(file); } catch (_) { /* */ }
  console.log(bad.length ? 'FAILED:\n  ' + bad.join('\n  ') : 'knowledge_store: ' + ok + ' passed');
  process.exit(bad.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
