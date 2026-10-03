
    // ================= 呼叫圖（callgraph_tools）：直接呼叫、函式指標回呼、vtable／struct 欄位綁定 =================
    function buildCallGraph(files) {
        // files：[{path, language, functions:[{name, line, all_calls, _node, _src}]}]
        const defs = {}; const edges = {}; const reverse = {}; const indirect = [];
        for (const f of files) for (const fn of f.functions) { (defs[fn.name] = defs[fn.name] || []).push({ path: f.path, line: fn.line }); }
        for (const f of files) {
            for (const fn of f.functions) {
                const key = f.path + '::' + fn.name; const set = new Set();
                for (const c of fn.all_calls || []) { const nm = c.replace(/^.*[.:>]/, ''); if (defs[nm]) set.add(nm); }
                // 函式指標／回呼：函式名稱以「非呼叫」方式出現在引數或欄位指派（identifier 節點、父節點不是 call 的函式位置）
                if (fn._node && f.language === 'c') {
                    const stack = [fn._node];
                    while (stack.length) {
                        const n = stack.pop(); for (const ch of kids(n)) stack.push(ch);
                        if (n.type === 'identifier' && defs[T(n, f._src)] && n.parent) {
                            const p = n.parent; const nm = T(n, f._src);
                            if (p.type === 'call_expression' && p.childForFieldName('function') === n) continue;
                            if (p.type === 'function_declarator' || p.type === 'function_definition') continue;
                            if (p.type === 'argument_list') { indirect.push({ via: 'callback', from: fn.name, target: nm, line: row(n) + 1, path: f.path }); set.add(nm); }
                            else if (p.type === 'init_declarator' || p.type === 'assignment_expression' || p.type === 'initializer_pair') { const lhs = p.type === 'initializer_pair' ? (p.childForFieldName('designator') ? T(p.childForFieldName('designator'), f._src) : '') : (p.childForFieldName('left') ? T(p.childForFieldName('left'), f._src) : ''); indirect.push({ via: p.type === 'initializer_pair' ? 'vtable-field' : 'function-pointer', from: fn.name, target: nm, field: lhs, line: row(n) + 1, path: f.path }); set.add(nm); }
                        }
                    }
                }
                edges[key] = Array.from(set).sort();
                for (const t of set) (reverse[t] = reverse[t] || new Set()).add(fn.name);
            }
        }
        // 檔案層級的 struct 初始化器（vtable）：{ .open = my_open, ... }
        for (const f of files) if (f.root && f.language === 'c') {
            const stack = [f.root];
            while (stack.length) { const n = stack.pop(); for (const ch of kids(n)) stack.push(ch);
                if (n.type === 'initializer_pair') { const val = n.childForFieldName('value'); if (val && val.type === 'identifier' && defs[T(val, f._src)]) { let up = n.parent, inFn = false; while (up) { if (up.type === 'function_definition') { inFn = true; break; } up = up.parent; } if (!inFn) { const d = n.childForFieldName('designator'); indirect.push({ via: 'vtable-field', from: '(file scope)', target: T(val, f._src), field: d ? T(d, f._src) : '', line: row(n) + 1, path: f.path }); } } }
            }
        }
        const roots = []; for (const f of files) for (const fn of f.functions) if (!reverse[fn.name]) roots.push(fn.name);
        return { defs, edges, callers: Object.fromEntries(Object.entries(reverse).map(([k, v]) => [k, Array.from(v).sort()])), indirect, roots: Array.from(new Set(roots)).sort() };
    }
    // ================= 資料流（dataflow_tools）：來源→匯點的污染追蹤（單一函式內） =================
    const TAINT_SOURCES = { c: S(['recv', 'recvfrom', 'read', 'fread', 'fgets', 'getenv', 'scanf', 'gets', 'getline', 'recvmsg', 'accept']), javascript: S(['readFileSync', 'fetch', 'prompt', 'getItem']), python: S(['input', 'recv', 'read', 'readline', 'getenv']), java: S(['readLine', 'getParameter', 'getenv', 'read']), shell: S(['read']) };
    const TAINT_SINKS = { c: { system: '以 shell 執行（命令注入風險）', popen: '以 shell 執行（命令注入風險）', execve: '執行程式', execv: '執行程式', execl: '執行程式', strcpy: '字串複製（無長度檢查，緩衝區溢位風險）', strcat: '字串串接（無長度檢查）', sprintf: '格式化寫入（無長度檢查）', memcpy: '記憶體複製（長度由輸入決定時有溢位風險）', printf: '格式字串（格式字串漏洞風險）', fopen: '開檔（路徑由輸入決定）', open: '開檔（路徑由輸入決定）' }, javascript: { eval: '動態執行程式碼', Function: '動態執行程式碼', exec: '執行命令', execSync: '執行命令', spawn: '執行命令', innerHTML: '寫入 HTML（XSS 風險）', writeFileSync: '寫檔', readFileSync: '讀檔（路徑由輸入決定）' }, python: { eval: '動態執行程式碼', exec: '動態執行程式碼', system: '以 shell 執行', popen: '以 shell 執行', open: '開檔（路徑由輸入決定）', loads: '反序列化' }, java: { exec: '執行命令', forName: '動態載入類別', readObject: '反序列化', executeQuery: '資料庫查詢（SQL 注入風險）', executeUpdate: '資料庫更新（SQL 注入風險）' }, shell: { eval: '動態執行', bash: '執行命令', sh: '執行命令' } };
    function dataFlowOfTrace(trace, language) {
        const srcs = TAINT_SOURCES[language] || S([]); const sinks = TAINT_SINKS[language] || {}; const tainted = {}; const findings = [];
        const idents = (t) => (t.match(/[A-Za-z_$][\w$]*/g) || []);
        for (const e of trace.lines) {
            const t = e.text || ''; const m = /^(?:[A-Za-z_][\w\s\*<>\[\],:]*?\s+)?(\*?[A-Za-z_$][\w$]*)\s*=(?!=)\s*(.+)$/.exec(t); const rhsNames = new Set(idents(m ? m[2] : t));
            const fromSource = (e.calls || []).filter((c) => srcs.has(c.replace(/^.*[.:>]/, '')));
            if (m && (fromSource.length || Array.from(rhsNames).some((x) => tainted[x]))) { const origin = fromSource.length ? fromSource[0] + '()' : Array.from(rhsNames).find((x) => tainted[x]); tainted[m[1].replace(/^\*+/, '')] = { origin: fromSource.length ? fromSource[0] + '()' : tainted[origin].origin, line: e.line }; }
            else if (fromSource.length) { // 傳出參數（recv(fd, buf, ...)）：第二個以後的識別字視為被寫入
                const args = (/\((.*)\)/.exec(t) || [])[1]; if (args) args.split(',').slice(1).forEach((a) => { const id = (a.match(/[A-Za-z_]\w*/) || [])[0]; if (id) tainted[id] = { origin: fromSource[0] + '()', line: e.line }; });
            }
            for (const c of e.calls || []) { const nm = c.replace(/^.*[.:>]/, ''); if (sinks[nm]) { const hit = Array.from(rhsNames).filter((x) => tainted[x]); if (hit.length) findings.push({ line: e.line, sink: nm, meaning: sinks[nm], variables: hit, origin: tainted[hit[0]].origin, origin_line: tainted[hit[0]].line }); } }
        }
        return findings;
    }
    // ================= 文字格式的底層程式（組語／LLVM IR／PTX／WASM）=================
    const ASM_FN_PATTERNS = [
        [/^\s*define\s+[^@]*@([\w.$]+)\s*\(/, 'llvm'], [/^\s*\.(?:visible\s+)?\.?entry\s+([\w$.]+)/, 'ptx'], [/^\s*\.func\s+(?:\([^)]*\)\s*)?([\w$.]+)/, 'ptx'],
        [/^\s*\(func\s+\$?([\w.$]+)/, 'wasm'], [/^\s*([A-Za-z_.$][\w.$]*)\s*:\s*(?:[;#].*)?$/, 'asm'],
    ];
    function detectLowLevelKind(path, src) {
        const p = (path || '').toLowerCase(); if (/\.(ll)$/.test(p)) return 'llvm'; if (/\.ptx$/.test(p)) return 'ptx'; if (/\.(wat|wast)$/.test(p)) return 'wasm'; if (/\.(s|asm|nasm|masm)$/.test(p)) return 'asm';
        if (/^\s*define\s+.*@[\w.$]+\s*\(/m.test(src) && /\n\s*ret\b|\n\s*%\w+\s*=\s*/.test(src)) return 'llvm'; if (/^\s*\.version\s|\.visible\s+\.entry/m.test(src)) return 'ptx'; if (/^\s*\(module/m.test(src)) return 'wasm';
        return null;
    }
    function scanLowLevelText(path, src, tx, kind) {
        const lines = src.split('\n'); const fns = []; let cur = null; const aLk = asmLookup(tx);
        const commentOf = (i) => { const c = []; for (let j = i - 1; j >= 0; j--) { const t = lines[j].trim(); if (/^(;|#|\/\/)/.test(t)) c.unshift(t.replace(/^(;+|#+|\/\/+)\s?/, '')); else break; } return c.join(' ') || null; };
        const startNew = (name, i) => { if (cur) { cur.end_line = i; fns.push(cur); } cur = { name, line: i + 1, end_line: lines.length, body: [], comment: commentOf(i), blocks: [], labels: [] }; };
        for (let i = 0; i < lines.length; i++) {
            const ln = lines[i]; let hit = false;
            for (const [re, k] of ASM_FN_PATTERNS) { if ((kind === 'asm' && k !== 'asm') || (kind === 'llvm' && k !== 'llvm') || (kind === 'ptx' && k !== 'ptx') || (kind === 'wasm' && k !== 'wasm')) continue; const m = re.exec(ln); if (m) { if (k === 'asm' && cur && /^\.?L/.test(m[1])) { cur.labels.push({ name: m[1], line: i + 1, comment: commentOf(i) }); hit = true; break; } startNew(m[1], i); hit = true; break; } }
            if (hit) continue; if (!cur) continue;
            const lm = /^\s*([A-Za-z_.$%][\w.$%-]*):\s*(?:[;#].*)?$/.exec(ln); if (lm) cur.labels.push({ name: lm[1], line: i + 1, comment: commentOf(i) }); else cur.body.push({ line: i + 1, text: ln });
        }
        if (cur) fns.push(cur);
        const idiomArchs = Object.keys(tx.assembly_idioms || {});
        return fns.map((f) => {
            const mnemonics = []; const lineOf = [];
            for (const b of f.body) { const t = b.text.replace(/[;#].*$/, '').replace(/\/\/.*$/, '').trim(); if (!t || /^[.}{)]/.test(t) && kind === 'asm') continue; const w = /^(?:%[\w.]+\s*=\s*)?(?:[A-Za-z_.][\w.]*:\s*)?([A-Za-z_][\w.]*)/.exec(t); if (w) { const w1 = w[1].toLowerCase(); mnemonics.push(w1); lineOf.push(b.line); if (/^(rep|repe|repz|repne|repnz|lock)$/.test(w1)) { const rest = t.slice(t.toLowerCase().indexOf(w1) + w1.length).trim(); const w2 = /^([A-Za-z_][\w.]*)/.exec(rest); if (w2) { mnemonics.push(w2[1].toLowerCase()); lineOf.push(b.line); } } } }
            const matchedCats = {}, matchedArchs = {}; for (const m of mnemonics) for (const [arch, cat] of lookupAsmMnemonic(aLk, m)) { (matchedCats[cat] = matchedCats[cat] || new Set()).add(m); matchedArchs[arch] = (matchedArchs[arch] || 0) + 1; }
            const idioms = []; for (const arch of idiomArchs) { if (!(arch in matchedArchs)) continue; for (const id of recognizeIdioms(mnemonics, tx.assembly_idioms[arch])) idioms.push(Object.assign({ arch }, id)); }
            const behaviors = {}; for (const [c, ms] of Object.entries(matchedCats)) behaviors[c] = sorted(ms);
            return { name: f.name, line: f.line, end_line: f.end_line, line_count: f.end_line - f.line + 1, behaviors, call_count: 0, branch_count: 0, loop_count: 0, complexity: 1, inline_asm: [], preprocessor_guards: [], device_paths: [], env_vars: [], embedded_shell_commands: [], structural_signals: {}, has_leading_comment: !!f.comment, leading_comment_text: f.comment, all_calls: [], low_level: { kind, mnemonics, idioms, labels: f.labels, archs: matchedArchs, line_of: lineOf } };
        });
    }
    function lowLevelMarkdown(fn, tx) {
        const ll = fn.low_level; const out = []; const L = ll.labels; const m = ll.mnemonics; const idiomLines = ll.idioms || [];
        if (idiomLines.length) { out.push('<details open><summary>認得的 idiom（多指令組合的真正意圖）</summary>', ''); for (const id of idiomLines) out.push('- `' + id.name + '`：' + (id.template || id.description || '') + (id.arch ? '（' + id.arch + '）' : '')); out.push('', '</details>', ''); }
        const cats = Object.entries(fn.behaviors); if (cats.length) { out.push('<details open><summary>指令的行為分類</summary>', ''); for (const [c, ms] of cats) out.push('- ' + ((tx.categories[c] || {}).label || c) + '：' + ms.slice(0, 12).map((x) => '`' + x + '`').join(' ')); out.push('', '</details>', ''); }
        if (L.length) { out.push('<details><summary>基本區塊（' + L.length + ' 個標籤）</summary>', ''); for (const l of L.slice(0, 40)) out.push('- `' + l.name + '`（第 ' + l.line + ' 行）' + (l.comment ? '：' + rerank(l.comment, [], 2) : '')); out.push('', '</details>', ''); }
        if (!idiomLines.length && !cats.length) out.push('（沒有認得的指令；可用 behavior_define 補組語定義）');
        return out.join('\n');
    }
    // ================= JVM／Python byte code 文字（bytecode_tools）：javap -c 與 dis 輸出 =================
    const JVM_OPS = { invokestatic: '呼叫靜態方法', invokevirtual: '呼叫方法', invokespecial: '呼叫建構子／父類別方法', invokeinterface: '呼叫介面方法', invokedynamic: '動態呼叫（lambda／字串串接）', new: '建立物件', getfield: '讀欄位', putfield: '寫欄位', getstatic: '讀靜態欄位', putstatic: '寫靜態欄位', athrow: '丟出例外', monitorenter: '取得鎖', monitorexit: '釋放鎖', ifeq: '等於 0 則跳', ifne: '不等於 0 則跳', if_icmpeq: '整數相等則跳', if_icmpne: '整數不等則跳', goto: '無條件跳躍', ireturn: '回傳整數', areturn: '回傳物件', return: '回傳（void）', checkcast: '型別轉換檢查', instanceof: '型別判斷' };
    function parseJavap(text) {
        const methods = []; let cur = null;
        for (const ln of text.split('\n')) {
            const hm = /^\s{2,4}((?:public|private|protected|static|final|synchronized|native|abstract)\s[^;{]*?\)|[\w.<>\[\]]+\s+[\w<>$]+\([^)]*\))[^;]*;\s*$/.exec(ln);
            if (hm && !/^\s*\d+:/.test(ln)) { cur = { signature: hm[1].trim(), name: (/([\w<>$]+)\(/.exec(hm[1]) || [])[1] || hm[1], ops: [], calls: [] }; methods.push(cur); continue; }
            const om = /^\s*(\d+):\s+(\w+)\s*(.*)$/.exec(ln); if (om && cur) { cur.ops.push({ offset: +om[1], op: om[2], arg: om[3] }); const cm = /\/\/\s*(?:Method|InterfaceMethod)\s+(.+)$/.exec(om[3]); if (cm) cur.calls.push(cm[1].trim()); }
        }
        return methods;
    }
    function bytecodeMarkdown(methods, tx) {
        const lookup = lookupFor(tx, 'java'); const out = [];
        for (const m of methods) {
            out.push('<details><summary>`' + m.name + '`（' + m.ops.length + ' 個指令）</summary>', '');
            const cats = new Set(); for (const c of m.calls) { const cn = (c.split('.').pop() || '').split(':')[0].replace(/"?<init>"?/, 'new'); if (lookup[cn]) cats.add(lookup[cn]); }
            if (m.calls.length) out.push('- 呼叫：' + Array.from(new Set(m.calls)).slice(0, 12).map((c) => '`' + c + '`').join('、'));
            if (cats.size) out.push('- 行為：' + Array.from(cats).map((c) => (tx.categories[c] || {}).label || c).join('、'));
            const notable = Array.from(new Set(m.ops.map((o) => o.op))).filter((o) => JVM_OPS[o]).slice(0, 8); if (notable.length) out.push('- 指令：' + notable.map((o) => '`' + o + '`＝' + JVM_OPS[o]).join('；'));
            out.push('', '</details>', '');
        }
        return out.join('\n');
    }
    // ================= Java 設計模式（designpattern_tools）：以語法樹的類別結構判斷 =================
    function detectJavaDesignPatterns(root, src) {
        const out = []; const classes = []; collectTypes(root, S(['class_declaration', 'interface_declaration']), classes);
        for (const c of classes) {
            const nm = firstKid(c, 'identifier'); const name = nm ? T(nm, src) : '?'; const body = c.childForFieldName ? c.childForFieldName('body') : null; const text = T(c, src);
            const ctors = []; collectTypes(c, S(['constructor_declaration']), ctors); const privCtor = ctors.some((k) => /\bprivate\b/.test(T(k, src).split('{')[0]));
            const hasStaticInst = new RegExp('static\\s+(?:volatile\\s+)?' + name + '\\s+\\w+').test(text) || /\bstatic\b[^;(]*\b(instance|INSTANCE)\b/.test(text);
            if (privCtor && (hasStaticInst || /getInstance\s*\(/.test(text))) out.push({ pattern: 'Singleton', class: name, line: row(c) + 1, evidence: '私有建構子＋靜態實例' });
            if (/\bBuilder\b/.test(name) || (/return\s+this\s*;/.test(text) && /\bbuild\s*\(/.test(text))) out.push({ pattern: 'Builder', class: name, line: row(c) + 1, evidence: '鏈式 setter＋build()' });
            if (/List<\w*(Observer|Listener)\w*>|\b(addObserver|addListener|notifyObservers|fire\w+)\s*\(/.test(text)) out.push({ pattern: 'Observer', class: name, line: row(c) + 1, evidence: '觀察者清單／通知方法' });
            if (/static\s+\w[\w<>]*\s+create\w*\s*\(/.test(text) && /return\s+new\s+/.test(text) && /Factory/.test(name + text.slice(0, 200))) out.push({ pattern: 'Factory', class: name, line: row(c) + 1, evidence: 'create* 靜態方法回傳 new' });
            const impl = /\b(?:implements|extends)\s+(\w+)/.exec(text.split('{')[0]); if (impl && /\bprivate\s+(?:final\s+)?(\w+)\s+\w+\s*;/.test(text) && new RegExp('private\\s+(?:final\\s+)?' + impl[1] + '\\s+\\w+\\s*;').test(text)) out.push({ pattern: 'Decorator／Proxy', class: name, line: row(c) + 1, evidence: '實作 ' + impl[1] + ' 又持有一個 ' + impl[1] });
        }
        return out;
    }
    // ================= 總協調：把一份原始碼解釋成可折疊的 markdown =================
    const EXT_LANG = { c: 'c', h: 'c', cc: 'c', cpp: 'c', cxx: 'c', hpp: 'c', cu: 'c', cuh: 'c', glsl: 'c', frag: 'c', vert: 'c', hlsl: 'c', java: 'java', py: 'python', js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript', ts: 'javascript', tsx: 'javascript', sh: 'shell', bash: 'shell' };
    function languageOfPath(path) { const m = /\.([A-Za-z0-9]+)$/.exec(path || ''); return m ? (EXT_LANG[m[1].toLowerCase()] || null) : null; }
    const FileCommentRe = /^\s*(?:\/\*[\s\S]*?\*\/|(?:\/\/[^\n]*\n?)+|(?:#[^\n]*\n?)+)/;
    function fileHeaderComment(src) { const m = FileCommentRe.exec(src.replace(/^#!.*\n/, '')); if (!m) return null; return m[0].split('\n').map((l) => l.replace(/^\s*(\/\*+|\*+\/|\*+|\/\/+|#+)\s?/, '').replace(/\*\/\s*$/, '').trim()).filter(Boolean).join(' ') || null; }
    const NOTE_LABEL = { user: 'aidoc 補充', comment: '原始碼註解', auto: '自動分析' };
    // deps.parse(language, src) → tree.rootNode（呼叫端提供 web-tree-sitter）；deps.notes[path|path::fn] 是 aidoc 的說明
    async function explainSource(path, src, opts) {
        opts = opts || {}; const tx = opts.taxonomy; const deps = opts.deps || {}; const target = opts.fn || null; const notes = Object.assign({}, tx.__notes || {}, opts.notes || {});
        const out = []; const meta = { path, language: null, functions: 0, unclassified: [], sources: {} };
        const lowKind = detectLowLevelKind(path, src); const language = languageOfPath(path);
        const fileNote = notes[path] || notes['file::' + path]; const header = fileHeaderComment(src);
        out.push('# ' + path); out.push('');
        if (fileNote) { out.push('> **' + NOTE_LABEL.user + '**：' + fileNote); out.push(''); meta.sources.file = 'user'; }
        else if (header) { out.push('> **' + NOTE_LABEL.comment + '**：' + rerank(header, [], 3)); out.push(''); meta.sources.file = 'comment'; }
        // 組語系
        if (lowKind) {
            meta.language = lowKind; let fns = scanLowLevelText(path, src, tx, lowKind); if (target) fns = fns.filter((f) => f.name === target); meta.functions = fns.length;
            for (const f of fns) {
                const note = notes[path + '::' + f.name] || notes[f.name]; out.push('## `' + f.name + '`（' + lowKind + '，第 ' + f.line + '–' + f.end_line + ' 行）', '');
                if (note) { out.push('**' + NOTE_LABEL.user + '**：' + note, ''); meta.sources[f.name] = 'user'; } else if (f.leading_comment_text) { out.push('**' + NOTE_LABEL.comment + '**：' + rerank(f.leading_comment_text, f.low_level.mnemonics, 2), ''); meta.sources[f.name] = 'comment'; } else meta.sources[f.name] = 'auto';
                out.push(lowLevelMarkdown(f, tx), '');
            }
            return { markdown: out.join('\n'), meta, functions: fns };
        }
        if (/\.(javap|jvm)$/i.test(path) || /^Compiled from "|^\s*(public|private|protected)?\s*(static\s+)?class\s+[\w.]+\s*\{[\s\S]*\n\s+Code:/m.test(src)) {
            const methods = parseJavap(src); meta.language = 'jvm-bytecode'; meta.functions = methods.length; out.push(bytecodeMarkdown(methods, tx)); return { markdown: out.join('\n'), meta, functions: methods };
        }
        if (!language) return { markdown: out.join('\n') + '\n（不認得的檔案類型，無法分析）', meta, functions: [] };
        meta.language = language;
        if (!deps.parse) throw new Error('沒有可用的語法樹剖析器（deps.parse）');
        const root = await deps.parse(language, src); if (!root) throw new Error('語法樹剖析失敗：' + language);
        const profile = PROFILES[language]; const scan = scanTree(root, src, profile, tx, { path, wholeFile: !!opts.wholeFile });
        let fns = scan.functions.filter((f) => !(/^<anonymous/.test(f.name) && scan.functions.some((o) => o !== f && o.line <= f.line && o.end_line >= f.end_line && !/^<anonymous/.test(o.name)))); meta.unclassified = scan.unclassified.slice(0, 40).map((u) => u.name); meta.functions = fns.length;
        const jp = language === 'java' ? detectJavaDesignPatterns(root, src) : []; const fileObj = { path, language, functions: fns, root, _src: src };
        const cg = buildCallGraph([fileObj]);
        const resolveCache = {};
        const resolveCallee = (cn) => { // 本檔內的呼叫端：取該函式自己的一句話說明（註解優先，其次行為分類）
            const nm = String(cn).replace(/^.*[.:>]/, ''); if (resolveCache[nm] !== undefined) return resolveCache[nm]; const f = fns.find((x) => x.name === nm); let r = null;
            if (f && f.name !== (cur || {}).name) { const n = notes[path + '::' + f.name] || notes[f.name]; if (n) r = n; else if (f.leading_comment_text) r = rerank(f.leading_comment_text, f.all_calls, 1); } resolveCache[nm] = r; return r;
        }; let cur = null;
        if (target) fns = fns.filter((f) => f.name === target);
        if (jp.length && !target) { out.push('<details><summary>設計模式（' + jp.length + '）</summary>', ''); for (const p of jp) out.push('- **' + p.pattern + '**：`' + p.class + '`（第 ' + p.line + ' 行；' + p.evidence + '）'); out.push('', '</details>', ''); }
        // 函式之間的關係：回呼、vtable
        if (cg.indirect.length && !target) { out.push('<details><summary>間接呼叫（函式指標／回呼／vtable，' + cg.indirect.length + '）</summary>', ''); for (const i of cg.indirect.slice(0, 30)) out.push('- 第 ' + i.line + ' 行：`' + i.target + '` 以' + ({ callback: '回呼', 'function-pointer': '函式指標', 'vtable-field': 'vtable 欄位' }[i.via]) + '被綁定' + (i.field ? '到 `' + i.field + '`' : '') + (i.from !== '(file scope)' ? '（在 `' + i.from + '`）' : '')); out.push('', '</details>', ''); }
        if (!target && fns.length > 1) { const sums = fns.map((f) => (notes[path + '::' + f.name] || f.leading_comment_text || '')).filter(Boolean); if (sums.length > 3) { const s = summarizeBlocks(sums, 3); out.push('**檔案重點**：' + s.summary.map((x) => rerank(x, [], 1)).join(' ／ '), ''); } }
        for (const f of fns) {
            cur = f; const note = notes[path + '::' + f.name] || notes[f.name]; const trace = traceFunction(f._node, src, profile, tx, f.name, path);
            out.push('## `' + f.name + '`（第 ' + f.line + '–' + f.end_line + ' 行，複雜度 ' + f.complexity + '）', '');
            if (note) { out.push('**' + NOTE_LABEL.user + '**：' + note, ''); meta.sources[f.name] = 'user'; }
            else if (f.leading_comment_text) { out.push('**' + NOTE_LABEL.comment + '**：' + rerank(f.leading_comment_text, f.all_calls.concat(Object.keys(f.behaviors)), 2), ''); meta.sources[f.name] = 'comment'; }
            else meta.sources[f.name] = 'auto';
            const cats = Object.keys(f.behaviors).filter((c) => tx.categories[c]); if (cats.length) out.push('行為分類：' + cats.map((c) => tx.categories[c].label || c).join('、'), '');
            if (f.preprocessor_guards.length) out.push('編譯條件：' + f.preprocessor_guards.map((g) => '`' + g + '`').join('、'), '');
            const bodyMd = renderFunctionNarrativeMarkdown(trace, resolveCallee, { useComments: true });
            out.push('<details open><summary>由下而上的行為敘事（正向路徑為主，防呆分支已折疊）</summary>', '', bodyMd, '', '</details>', '');
            for (const a of f.inline_asm) if (a.idioms && a.idioms.length) { out.push('<details><summary>內嵌組合語言（第 ' + a.line + ' 行）</summary>', ''); for (const id of a.idioms) out.push('- `' + id.name + '`：' + (id.template || id.description || '')); out.push('', '</details>', ''); }
            const flows = dataFlowOfTrace(trace, language); if (flows.length) { out.push('<details><summary>資料流警示（' + flows.length + '）</summary>', ''); for (const x of flows) out.push('- 第 ' + x.origin_line + ' 行 `' + x.origin + '` 的資料，經 `' + x.variables.join('、') + '`，到第 ' + x.line + ' 行 `' + x.sink + '()`：' + x.meaning); out.push('', '</details>', ''); f.dataflow = flows; }
            const callers = (cg.callers[f.name] || []); if (callers.length) out.push('被呼叫：' + callers.map((c) => '`' + c + '`').join('、'), '');
        }
        for (const f of scan.functions) delete f._node; delete fileObj.root;
        return { markdown: out.join('\n'), meta, functions: scan.functions.map((f) => { const c = Object.assign({}, f); delete c._node; return c; }), callgraph: cg, design_patterns: jp };
    }
    // 把 AI／使用者學到的說明寫回：notes 的鍵是 path::函式名稱 或 函式名稱
    function suggestNotes(result) { return (result.meta.unclassified || []).slice(0, 20); }
