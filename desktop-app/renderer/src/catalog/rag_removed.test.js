// 2026-11-08：AI 面向的 Graph RAG 移除——領域清單、提示詞、功能清冊不再有；底層工具與儲存層（離線訓練器、語言探索存檔用）仍在。
const fs = require('fs'); const path = require('path'); const assert = require('assert');
const src = fs.readFileSync(path.join(__dirname, '..', 'floating-assistant.js'), 'utf8').replace(/\r\n/g, '\n');
const yaml = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'features', 'ai-features.yaml'), 'utf8');
let n = 0; const t = (name, fn) => { fn(); n++; console.log('ok - ' + name); };
const registry = src.slice(src.indexOf('const SUBAGENT_DOMAIN_REGISTRY'), src.indexOf('SUBAGENT_DOMAIN_REGISTRY.lang_explorer'));
t('子任務領域清單不再有 rag_lookup、rag_management', () => { assert(registry.length > 1000); assert(!/\n    rag_lookup: \{/.test(registry)); assert(!/\n    rag_management: \{/.test(registry)); });
t('沒有任何領域的 toolNames 含 rag_ 工具（含語言探索）', () => { const all = [...src.matchAll(/toolNames: \[([^\]]*)\]/g)].map((m) => m[1]); assert(all.length > 20); const bad = all.filter((x) => /'rag_(query_graph|store_graph_node|chunk_document|delete)'/.test(x)); assert.strictEqual(bad.length, 0, bad.join('|').slice(0, 200)); });
t('基本系統提示不再自稱 Graph RAG，也不教 AI 用 rag_chunk_document', () => { const bp = src.slice(src.indexOf('this.baseSystemPrompt = `'), src.indexOf('`;', src.indexOf('this.baseSystemPrompt = `'))); assert(bp.length > 50 && !/Graph RAG|rag_chunk_document|記憶圖譜檢索/.test(bp)); });
t('功能清冊沒有 rag 功能，也沒有指向這兩個領域', () => { assert(!/- id: rag\n/.test(yaml)); assert(!/rag_lookup|rag_management/.test(yaml)); });
t('底層沒被刪：rag_* 四個工具仍註冊、訓練器的 RAG 查詢與語言探索存檔仍在、訓練器把它們列為元工具', () => {
    for (const tn of ['rag_store_graph_node', 'rag_query_graph', 'rag_chunk_document', 'rag_delete']) assert(src.includes("registerOptional('" + tn + "'"), tn);
    assert(/this\.ragSystem\.query\(/.test(src) && /this\.ragSystem\.add\(/.test(src) && /saved: 'rag'/.test(src));
    assert(/const FA_OT_META_TOOLS = new Set\([^)]*rag_query_graph/.test(src)); });
console.log(n + ' passed, 0 failed');
