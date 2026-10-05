
    // ================= 對外介面 =================
    // 剖析器載入：web-tree-sitter 與各語言的 wasm 由宿主提供（桌面：本機快取／CDN；網頁：CDN）。
    // host = { loadTreeSitter: async () => Parser, loadLanguageWasm: async (name) => Uint8Array|url }
    const WASM_NAME = { c: 'c', cpp: 'cpp', rust: 'rust', go: 'go', java: 'java', python: 'python', javascript: 'javascript', shell: 'bash' };
    function makeParser(host) {
        let ParserCls = null; const langs = {}; let parserByLang = {};
        return async function parse(language, src) {
            if (!ParserCls) { ParserCls = await host.loadTreeSitter(); }
            if (!langs[language]) { const wasm = await host.loadLanguageWasm(WASM_NAME[language] || language); langs[language] = await ParserCls.Language.load(wasm); }
            const p = parserByLang[language] || (parserByLang[language] = new ParserCls()); p.setLanguage(langs[language]);
            return p.parse(src).rootNode;
        };
    }
    function create(data, host, user) {
        let tx = makeTaxonomy(data, user); const parse = host ? makeParser(host) : null;
        return {
            setUser(u) { tx = makeTaxonomy(data, u); },
            taxonomy() { return tx; },
            languageOfPath, detectLowLevelKind,
            async explain(path, src, opts) { return explainSource(path, src, Object.assign({ taxonomy: tx, deps: { parse } }, opts || {})); },
            // 純文字工具（不需要剖析器）
            rerank, splitSentences, extractKeywords, summarizeBlocks, clusterBlocks, rankBlocks, selectWithinBudget,
            parseJavap, scanLowLevelText: (path, src, kind) => scanLowLevelText(path, src, tx, kind || detectLowLevelKind(path, src)),
        };
    }
    return { create, makeTaxonomy, languageOfPath, rerank, splitSentences, summarizeBlocks, clusterBlocks, extractKeywords, parseJavap, detectLowLevelKind };
