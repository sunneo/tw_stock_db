// Graph RAG 移除的實機驗證：node scripts/eval/code-slash.run.js rag-removed
const fa = window.fa; const R = {};
R.domains = { rag_lookup: !!fa.domains.rag_lookup, rag_management: !!fa.domains.rag_management, n: Object.keys(fa.domains).length };
R.langExplorerTools = fa.domains.lang_explorer && fa.domains.lang_explorer.toolNames;
R.ragToolsStillRegistered = ['rag_store_graph_node', 'rag_query_graph', 'rag_chunk_document', 'rag_delete'].every((n) => !!fa.tools[n]);
R.rootHasRag = (fa._getRootToolNames ? fa._getRootToolNames() : []).filter((n) => /^rag_/.test(n));
R.systemPrompt = String(fa.baseSystemPrompt).slice(0, 60); R.promptHasGraphRag = /Graph RAG/.test(fa.baseSystemPrompt) || /Graph RAG/.test(JSON.stringify((fa.messages || []).filter((m) => m.role === 'system')));
R.titleBadge = (document.body.textContent.match(/Graph RAG/g) || []).length;
R.ragSystem = !!fa.ragSystem;
try { const p = await fa._otPlan('你好'); R.trainerOk = !!p && !!p.decision; } catch (e) { R.trainerOk = 'ERR ' + e.message; }
try { R.ragQuery = fa.ragSystem ? (await fa.ragSystem.query('測試', 3)).length : null; } catch (e) { R.ragQuery = 'ERR ' + e.message; }
return R;
