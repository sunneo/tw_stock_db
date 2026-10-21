const fa = window.fa; const R = {}; fa.advancedSettings.offlineMode = false;
const call = async (name, args) => JSON.parse(await fa.tools[name].callback.call(fa, JSON.stringify(args || {})));
await fa._kiClose(); try { await fa._kiIdbDel('default'); } catch (_) { /* */ }
fa.advancedSettings.knowledge = { location: { kind: 'idb', ref: 'default' }, maxMB: 0, embedConsent: true, autoEmbed: true };
const t0 = Date.now(); const prog = [];
const wiki = '# 蜘蛛\n\n蜘蛛是節肢動物，身體分成頭胸部和腹部。\n\n## 習性\n\n多數蜘蛛會結網捕食昆蟲。\n部分蜘蛛不結網，直接獵捕。\n\n## 分類\n\n目前已知四萬多種蜘蛛。\n';
const a = await call('knowledge_add', { text: wiki, name: '蜘蛛.md', kind: 'md' });
R.add = { ok: a.ok, embedding: a.embedding && { embedded: a.embedding.embedded, error: a.embedding.error, ms: a.embedding.ms } };
R.add_ms = Date.now() - t0;
R.vendor_error = fa._unitCatalogEmbedVendorError || null; R.hf_error = fa._unitCatalogEmbedError || null;
const cacheKeys = await (async () => { try { const c = await caches.open('fa-vendor-models'); return (await c.keys()).map((r) => r.url.split('/vendor/')[1].split('#')[0]); } catch (e) { return String(e); } })(); R.vendor_cache = cacheKeys;
const st = await call('knowledge_sources'); R.stats = st.stats;
const sem = await call('knowledge_ask', { question: '蜘蛛是用什麼方式織網來抓獵物的' }); R.semantic = { semantic: sem.semantic, found: sem.found, first: sem.hits && sem.hits[0] && { label: sem.hits[0].label, found_by: sem.hits[0].found_by, quote: sem.hits[0].quote.slice(0, 40) }, note: sem.semantic_note };
const sem2 = await call('knowledge_ask', { question: 'how do arachnids catch insects with webs' }); R.cross_language = { found: sem2.found, first: sem2.hits && sem2.hits[0] && { label: sem2.hits[0].label, found_by: sem2.hits[0].found_by } };
const none = await call('knowledge_ask', { question: '股票市場的本益比' }); R.unrelated = none.found;
const org = await (async () => { const o = fa._callSimpleCompletion; fa._callSimpleCompletion = async () => '蜘蛛\n結網\n恐龍\n節肢動物'; try { return await call('knowledge_organize', { source: '蜘蛛' }); } finally { fa._callSimpleCompletion = o; } })(); R.organize = { ok: org.ok, tags: org.organized && org.organized[0].tags, rejected: org.rejected_terms };
R.cap = await (async () => { fa._kiSaveSettings({ maxMB: 0.00001 }); const r = await call('knowledge_add', { text: '這是很長的內容。'.repeat(200), name: '大.txt' }); fa._kiSaveSettings({ maxMB: 0 }); return (r.error || '').slice(0, 24); })();
await fa._kiClose(); return R;
