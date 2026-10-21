const fa = window.fa; const R = {}; fa.advancedSettings.offlineMode = false; fa.messages = [];
const call = async (name, args) => JSON.parse(await fa.tools[name].callback.call(fa, JSON.stringify(args || {})));
const wiki = '# 蜘蛛\n\n蜘蛛是節肢動物，身體分成頭胸部和腹部。\n\n## 習性\n\n多數蜘蛛會結網捕食昆蟲。\n部分蜘蛛不結網，直接獵捕。\n\n## 分類\n\n目前已知四萬多種蜘蛛。\n';
R.tools = ALL = ['knowledge_ask', 'knowledge_sources', 'knowledge_outline', 'knowledge_detail', 'knowledge_summary', 'knowledge_links', 'knowledge_add', 'knowledge_remove', 'knowledge_enable', 'knowledge_embed', 'knowledge_refresh', 'knowledge_organize', 'knowledge_location'].every((n) => !!fa.tools[n]);
R.slash = !!(fa.slashCommands && (fa.slashCommands['/knowledge'] || (fa.slashCommands.get && fa.slashCommands.get('/knowledge'))));
R.domain = !!(fa.domains && fa.domains.knowledge && fa.domains.knowledge.enabled);
// 乾淨開始（IndexedDB 預設位置）
await fa._kiClose(); try { await fa._kiIdbDel('default'); } catch (_) { /* */ }
fa.advancedSettings.knowledge = { location: { kind: 'idb', ref: 'default' }, maxMB: 0, embedConsent: false, autoEmbed: true }; try { localStorage.removeItem('fa.ki.has'); } catch (_) { /* */ } fa._kiHas = undefined;
R.empty_has = fa._kiHasSources();

// 1) 加入：文字、檔案（md／csv／json／jsonl）
const a1 = await call('knowledge_add', { text: wiki, name: '蜘蛛.md', kind: 'md' }); R.add_text = { ok: a1.ok, status: a1.status, sections: a1.sections, chunks: a1.chunks, embedding: a1.embedding && (a1.embedding.note || '').slice(0, 20) };
const put = async (name, mime, text) => fa.fileCache.put(name, mime, new Blob([text], { type: mime }), 'uploaded');
const fCsv = await put('銷售.csv', 'text/csv', 'name,qty\n蘋果,3\n香蕉,5\n'); const fJson = await put('設定.json', 'application/json', '{"owner":"Bob","items":[{"id":1,"title":"第一個"}]}'); const fJsonl = await put('事件.jsonl', 'application/x-ndjson', '{"e":"login","user":"amy"}\n{"e":"logout","user":"amy"}\n');
R.add_csv = (await call('knowledge_add', { file_id: fCsv })).kind; R.add_json = (await call('knowledge_add', { file_id: fJson })).kind; R.add_jsonl = (await call('knowledge_add', { file_id: fJsonl })).kind;
R.add_again = (await call('knowledge_add', { text: wiki, name: '蜘蛛.md', kind: 'md' })).status;
R.add_bad = (await call('knowledge_add', {})).error.slice(0, 20);
R.has_after_add = fa._kiHasSources();

// 2) 問：出處（來源、行、章節）
const q = await call('knowledge_ask', { question: '蜘蛛怎麼結網' }); const h = q.hits && q.hits[0];
R.ask = { found: q.found, source: h && h.source, lines: h && h.line_start + '-' + h.line_end, section: h && h.section, quote: h && h.quote, label: h && h.label, semantic: q.semantic };
R.ask_none = (await call('knowledge_ask', { question: '量子電腦的退火演算法' })).found;
R.ask_csv = ((await call('knowledge_ask', { question: '香蕉' })).hits || [])[0];
R.ask_json = ((await call('knowledge_ask', { question: 'Bob owner' })).hits || [])[0];
R.ask_limited = ((await call('knowledge_ask', { question: '蜘蛛', sources: ['銷售.csv'] })).found);

// 3) 目錄、細節、摘要、關聯、清單
const srcs = await call('knowledge_sources'); R.sources = { n: srcs.sources.length, loc: srcs.location, stats: srcs.stats };
R.outline = (await call('knowledge_outline', { source: '蜘蛛' })).sections.map((s) => s.title + '@' + s.line_start).join('|');
const dt = await call('knowledge_detail', { source: '蜘蛛', section: '習性' }); R.detail = { first: dt.lines[0], n: dt.lines.length };
const sm = await call('knowledge_summary', { source: '蜘蛛' }); R.summary = { n: sm.sentences.length, dropped: sm.dropped, allVerbatim: sm.sentences.every((x) => wiki.includes(x.quote)) };
R.links = (await call('knowledge_links')).links.length;

// 4) 停用、移除
await call('knowledge_enable', { source: '蜘蛛', enabled: false }); R.disabled_hides = (await call('knowledge_ask', { question: '蜘蛛怎麼結網' })).found === false;
await call('knowledge_enable', { source: '蜘蛛', enabled: true });
R.remove = (await call('knowledge_remove', { source: '事件' })).removed; R.remove_missing = (await call('knowledge_remove', { source: '不存在' })).ok;

// 5) 容量上限（可設無限）
fa._kiSaveSettings({ maxMB: 0.00001 }); const big = await call('knowledge_add', { text: '這是很長的內容。'.repeat(200), name: '大.txt' }); R.cap_refused = (big.error || '').slice(0, 20);
fa._kiSaveSettings({ maxMB: 0 }); R.cap_unlimited = (await call('knowledge_add', { text: '這是很長的內容。'.repeat(200), name: '大.txt' })).ok;

// 6) 關掉重開：IndexedDB 裡的 .keeplookup 還在
await fa._kiClose(); const again = await call('knowledge_ask', { question: '蜘蛛怎麼結網' }); R.reopen_idb = { found: again.found, label: again.hits && again.hits[0].label };

// 7) 搬家：IndexedDB → 磁碟檔案 → IndexedDB（數量要一致）
const before = (await call('knowledge_sources')).stats; const tmp = 'C:/Users/sunneo/AppData/Local/Temp/fa_ki_' + Date.now() + '.keeplookup';
const m1 = await call('knowledge_location', { action: 'migrate', to: 'file', path: tmp }); R.migrate_file = { ok: m1.ok, error: m1.error, to: m1.to, verified: m1.verified && m1.verified.chunks === before.chunks };
const f2 = await call('knowledge_ask', { question: '蜘蛛怎麼結網' }); R.after_file = { found: f2.found, loc: (await call('knowledge_location', {})).location };
const st = await window.desktopAPI.rawfs.stat(tmp).catch(() => null); R.file_exists = !!st;
const m2 = await call('knowledge_location', { action: 'migrate', to: 'idb' }); R.migrate_back = { ok: m2.ok, error: m2.error, verified: m2.verified && m2.verified.chunks === before.chunks };
R.migrate_same = (await call('knowledge_location', { action: 'migrate', to: 'idb' })).error;
R.migrate_nopath = (await call('knowledge_location', { action: 'migrate', to: 'file' })).error.slice(0, 16);

// 8) 領域與子代理：有來源時唯讀查詢工具會出現在每個領域
const dom = fa.domains.webedit || Object.values(fa.domains)[0]; const names = fa._resolveDomainToolNames(dom); R.shared_read_tools = ['knowledge_ask', 'knowledge_outline', 'knowledge_detail', 'knowledge_sources'].every((n) => names.includes(n)); R.write_tools_not_shared = !names.includes('knowledge_remove');
R.hint = _faTaskToolHints('根據我放進知識庫的資料，蜘蛛怎麼結網').map((x) => x.id).join();

// 9) /knowledge 指令
const cmd = fa.slashCommands['/knowledge'] || (fa.slashCommands.get && fa.slashCommands.get('/knowledge')); const run = cmd.handler || cmd.run || cmd; const last = () => String((fa.messages[fa.messages.length - 1] || {}).content || '');
await run('蜘蛛怎麼結網', fa); R.slash_ask = last().slice(0, 140);
await run('list', fa); R.slash_list = last().includes('蜘蛛.md');
await run('outline 蜘蛛', fa); R.slash_outline = /習性/.test(last());
await run('capacity 無限', fa); R.slash_cap = last();
await run('where', fa); R.slash_where = last().slice(0, 40);
await run('', fa); R.slash_help = /用法/.test(last());

// 10) 模型整理（橋接）：模型只挑詞，程式核對——換成固定的假模型來驗證核對邏輯
const origCS = fa._callSimpleCompletion; fa._callSimpleCompletion = async () => '蜘蛛\n結網\n恐龍\n節肢動物\n- 腹部';
const org = await call('knowledge_organize', { source: '蜘蛛' }); R.organize = { ok: org.ok, tags: org.organized && org.organized[0].tags, rejected: org.rejected_terms };
fa._callSimpleCompletion = async () => { throw new Error('offline and online both down'); }; const org2 = await call('knowledge_organize', { source: '蜘蛛' }); R.organize_fail = org2.organized && org2.organized[0].error && org2.organized[0].error.slice(0, 30);
fa._callSimpleCompletion = origCS;
await fa._kiClose(); return R;
