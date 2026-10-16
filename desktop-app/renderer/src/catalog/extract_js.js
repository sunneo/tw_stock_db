/* JavaScript 單元抽取器（UMD，純函式）：讀一份 JavaScript 原始碼，找出它「對外提供」的函式／類別方法（ES module 的 export、CommonJS 的
 * module.exports／exports.x、UMD 工廠函式回傳的物件、瀏覽器全域的頂層函式與類別、Foo.prototype.bar），轉成跟 Python 單元同一格式的單元
 * （id 為 js:套件.名稱）：參數（含預設值、JSDoc 的 @param 型別）、回傳（@returns）、說明（JSDoc 第一段）、副作用（函式本體的靜態分析，
 * 順著同一份檔案裡的呼叫鏈合併）。不執行任何程式碼。
 * 語法樹由呼叫端提供（opts.parse(src, onComment)，Node 用 acorn，瀏覽器用 CDN 的 acorn 或 web-tree-sitter 轉出的 ESTree），這個檔案不綁解析器。
 * 信任等級一律 0：靜態分析沒辦法保證純度，也還沒有 JavaScript 的探測環境；規劃時要用 includeUntrusted。 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory(require('./catalog_core.js'));
    else root.FaCatalogExtractJs = factory(root.FaCatalog || (typeof FaCatalog !== 'undefined' ? FaCatalog : undefined));
})(typeof self !== 'undefined' ? self : this, function (Cat) {
    'use strict';
    const MAX_UNITS = 200, MAX_CHAIN = 4;

    // ===== JSDoc =====
    function parseJsDoc(text) {
        const body = String(text || '').replace(/^\*+/, '').replace(/[ \t]+@(param|arg|argument|returns?|private|internal|access|deprecated)\b/g, '\n@$1').split('\n').map((l) => l.replace(/^\s*\*\s?/, '')).join('\n').trim(); const tags = [];
        const main = []; let cur = null;
        for (const line of body.split('\n')) { const m = /^@(\w+)\s*(.*)$/.exec(line.trim()); if (m) { cur = { tag: m[1], text: m[2] }; tags.push(cur); } else if (cur) cur.text += ' ' + line.trim(); else main.push(line); }
        const summary = main.join(' ').replace(/\s+/g, ' ').trim(); const params = {}; let returns = null; const deprecated = tags.some((t) => t.tag === 'deprecated'); const isPrivate = tags.some((t) => t.tag === 'private' || t.tag === 'internal' || (t.tag === 'access' && /private/.test(t.text)));
        for (const t of tags) {
            if (t.tag === 'param' || t.tag === 'arg' || t.tag === 'argument') { const m = /^(?:\{([^}]*)\}\s*)?(\[)?([\w$.]+)(?:=([^\]\s]+))?\]?(?:\s*-?\s*(.*))?$/.exec(t.text.trim()); if (m) params[m[3]] = { type: m[1] || null, optional: !!m[2] || m[4] !== undefined, desc: (m[5] || '').trim() }; }
            else if ((t.tag === 'returns' || t.tag === 'return') && !returns) { const m = /^(?:\{([^}]*)\}\s*)?(.*)$/.exec(t.text.trim()); returns = { type: m[1] || null, desc: (m[2] || '').trim() }; }
        }
        return { summary, params, returns, deprecated, isPrivate };
    }
    const DOM_ANY = /^(HTML\w*Element|Element|Node|Event|ImageData|ImageBitmap|CanvasRenderingContext2D|WebGL\w*|MediaStream|Blob|File|Response|Request|Window|Document)$/;
    function jsDocType(t) {
        if (t == null) return null; let s = String(t).trim().replace(/^[?!]/, '').replace(/=$/, ''); if (!s) return null;
        if (/^\.\.\./.test(s)) return null;
        const un = splitTop(s, '|').map((x) => x.trim()).filter((x) => x && !/^(null|undefined|void)$/.test(x)); if (un.length > 1) { const ms = un.map(jsDocType); if (ms.some((x) => !x)) return 'any'; const u = Array.from(new Set(ms)); return u.length === 1 ? u[0] : (u.length <= 3 ? 'union<' + u.join('|') + '>' : 'any'); }
        s = un[0] || s; let m;
        if ((m = /^(?:Array|Set)\s*<(.+)>$/.exec(s)) || (m = /^(.+)\[\]$/.exec(s))) { const e = jsDocType(m[1]); return 'list<' + (e || 'any') + '>'; }
        if ((m = /^Promise\s*<(.+)>$/.exec(s))) return jsDocType(m[1]) || 'any';
        if (/^(Map|Object|object|Record\b.*|\{.*\})$/.test(s)) return 'dict';
        const k = s.toLowerCase(); if (k === 'number' || k === 'float' || k === 'double') return 'number'; if (k === 'int' || k === 'integer') return 'int'; if (k === 'string') return 'text'; if (k === 'boolean' || k === 'bool') return 'bool';
        if (k === 'function' || /^\(.*\)\s*=>/.test(s) || k === 'callback') return 'callable'; if (s === '*' || k === 'any' || k === 'mixed') return 'any';
        if (/^(ArrayBuffer|Uint8Array|Uint8ClampedArray|Buffer|Float32Array|Int16Array)$/.test(s)) return 'bytes'; if (DOM_ANY.test(s)) return 'any'; if (k === 'url') return 'url'; if (k === 'array') return 'list<any>';
        return 'any';
    }
    function splitTop(s, ch) { const out = []; let d = 0, cur = ''; for (const c of s) { if ('<([{'.includes(c)) d++; else if ('>)]}'.includes(c)) d--; if (c === ch && d === 0) { out.push(cur); cur = ''; } else cur += c; } out.push(cur); return out; }

    // ===== AST 小工具 =====
    const isFn = (n) => n && (n.type === 'FunctionDeclaration' || n.type === 'FunctionExpression' || n.type === 'ArrowFunctionExpression');
    function walk(node, fn, skipFns) { if (!node || typeof node.type !== 'string') return; if (fn(node) === false) return; for (const k of Object.keys(node)) { if (k === 'loc' || k === 'range') continue; const v = node[k]; if (Array.isArray(v)) { for (const c of v) if (c && typeof c.type === 'string') { if (skipFns && isFn(c)) continue; walk(c, fn, skipFns); } } else if (v && typeof v.type === 'string') { if (skipFns && isFn(v)) continue; walk(v, fn, skipFns); } } }
    const keyName = (n) => (!n ? null : (n.type === 'Identifier' ? n.name : (n.type === 'Literal' ? String(n.value) : null)));
    const memberPath = (n) => { const parts = []; let c = n; while (c && c.type === 'MemberExpression') { const p = c.computed ? (c.property.type === 'Literal' ? String(c.property.value) : '*') : c.property.name; parts.unshift(p); c = c.object; } if (c && c.type === 'Identifier') parts.unshift(c.name); else if (c && c.type === 'ThisExpression') parts.unshift('this'); else return null; return parts.join('.'); };

    // ===== 副作用（函式本體靜態分析）=====
    const FS_READ = /^(readFile|readFileSync|readdir|readdirSync|stat|statSync|existsSync|exists|createReadStream|readlink|access|accessSync)$/, FS_WRITE = /^(writeFile|writeFileSync|appendFile|appendFileSync|unlink|unlinkSync|rm|rmSync|mkdir|mkdirSync|rename|renameSync|copyFile|copyFileSync|createWriteStream|rmdir|rmdirSync)$/;
    function directEffects(fnNode) {
        const eff = new Set(); const ev = []; const add = (e, why) => { eff.add(e); if (ev.length < 6) ev.push(e + '：' + why); }; const callees = new Set();
        walk(fnNode.body || fnNode, (n) => {
            if (n.type === 'CallExpression' || n.type === 'NewExpression') {
                const c = n.callee; const name = c.type === 'Identifier' ? c.name : memberPath(c); const last = name ? name.split('.').pop() : '';
                if (c.type === 'Identifier') callees.add(c.name);
                if (name === 'fetch' || /^(XMLHttpRequest|WebSocket|EventSource)$/.test(name || '') || /(^|\.)sendBeacon$/.test(name || '') || /^(axios|got|request)(\.|$)/.test(name || '')) add('net', name);
                else if (/^(http|https|net|dgram)\.(request|get|connect|createServer|createConnection)$/.test(name || '')) add('net', name);
                if (name === 'require' && n.arguments[0] && n.arguments[0].type === 'Literal') { const m = String(n.arguments[0].value).replace(/^node:/, ''); if (/^(http|https|net|dgram|tls|http2)$/.test(m)) add('net', 'require ' + m); else if (m === 'child_process') add('proc', 'require child_process'); }
                if (/^(alert|confirm|prompt)$/.test(name || '') || /(^|\.)(createElement|getContext|appendChild|querySelector|querySelectorAll|getElementById|insertAdjacentHTML|drawImage|fillRect|putImageData|toDataURL)$/.test(name || '') || name === 'Image' || name === 'Audio') add('ui', name);
                if (/(^|\.)(getUserMedia|getDisplayMedia|requestFullscreen|showOpenFilePicker|showSaveFilePicker)$/.test(name || '')) add('desktop', name);
                if (/^(localStorage|sessionStorage)\.(setItem|removeItem|clear)$/.test(name || '') || /^indexedDB\./.test(name || '')) add('state.write', name); else if (/^(localStorage|sessionStorage)\.getItem$/.test(name || '')) add('state.read', name);
                if (/^(child_process\.)?(spawn|exec|execSync|execFile|spawnSync|fork)$/.test(name || '') || /^process\.(exit|kill|abort)$/.test(name || '')) add('proc', name);
                if (/^(fs|fsp|fs\.promises)\./.test(name || '')) { if (FS_READ.test(last)) add('fs.read', name); else if (FS_WRITE.test(last)) add('fs.write', name); else add('fs.read', name + '（不認得的 fs 函式，當成讀）'); }
                if (name === 'Math.random' || /(^|\.)getRandomValues$/.test(name || '') || /^crypto\.random/.test(name || '')) add('random', name);
                if (name === 'Date.now' || name === 'performance.now' || (n.type === 'NewExpression' && c.type === 'Identifier' && c.name === 'Date') || /^(setTimeout|setInterval|requestAnimationFrame)$/.test(name || '')) add('time', name || 'Date');
                if (name === 'eval' || (c.type === 'Identifier' && c.name === 'Function' && n.type !== 'FunctionDeclaration') || (n.type === 'NewExpression' && c.type === 'Identifier' && c.name === 'Function')) add('unknown', 'eval／new Function');
                if (/^(importScripts|require)$/.test(name || '') && n.arguments[0] && n.arguments[0].type !== 'Literal') add('unknown', '動態載入 ' + name);
            } else if (n.type === 'MemberExpression') {
                const p = memberPath(n); if (p && /^(document\.(cookie|body|title|location)|window\.(location|open|innerWidth|innerHeight|scrollTo)|location\.href)/.test(p)) add('ui', p); if (p && /^document\.cookie/.test(p)) add('state.read', p);
            } else if (n.type === 'AssignmentExpression') {
                const p = memberPath(n.left); if (p && /^(document\.cookie|localStorage|sessionStorage)/.test(p)) add('state.write', p); if (p && /\.(innerHTML|outerHTML|textContent|src|href|style)(\.|$)/.test(p) && !/^this\./.test(p)) add('ui', p);
            }
        });
        return { eff, ev, callees };
    }

    // ===== 單元 =====
    function paramsOf(fnNode, doc) {
        const out = []; (fnNode.params || []).forEach((p, i) => {
            let name = null, dflt, optional = false, variadic = false, shape = null;
            if (p.type === 'Identifier') name = p.name;
            else if (p.type === 'AssignmentPattern') { optional = true; if (p.left.type === 'Identifier') name = p.left.name; else if (p.left.type === 'ObjectPattern') { name = 'options'; shape = p.left; } else name = 'arg' + (i + 1); dflt = p.right; }
            else if (p.type === 'RestElement') { variadic = true; name = p.argument && p.argument.type === 'Identifier' ? p.argument.name : 'rest'; }
            else if (p.type === 'ObjectPattern') { name = 'options'; shape = p; } else if (p.type === 'ArrayPattern') name = 'arg' + (i + 1); else name = 'arg' + (i + 1);
            if (variadic) return; // 可變長度參數不進單元參數（跟 Python 的 *args 一樣）
            const jd = doc && doc.params && doc.params[name]; let ty = null, src = null;
            if (jd && jd.type) { ty = jsDocType(jd.type); if (ty) src = 'doc'; } if (jd && jd.optional) optional = true;
            if (!ty && dflt && dflt.type === 'Literal') { const v = dflt.value; ty = typeof v === 'boolean' ? 'bool' : (typeof v === 'number' ? (Number.isInteger(v) ? 'int' : 'number') : (typeof v === 'string' ? 'text' : null)); if (ty) src = 'default'; }
            if (!ty && shape) { ty = 'dict'; src = 'default'; }
            if (!ty) { const t = Cat.fieldType(name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase()); if (t && t !== 'any' && !/^list<any>$/.test(t)) { ty = t; src = 'name'; } }
            if (!ty) { ty = 'any'; src = 'none'; }
            const o = { name, kind: 'named', type: ty, type_src: src, required: !optional }; if (dflt && dflt.type === 'Literal') o.default = dflt.raw; const d = jd && jd.desc; if (d) o.description = d.slice(0, 120); out.push(o);
        });
        // 最後一個選填之前的必填都留著；JavaScript 沒有關鍵字參數，位置固定
        out.forEach((o) => { o.kind = 'positional'; }); return out;
    }
    const clip = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
    function firstSentence(s) { const m = /^(.{2,160}?(?:[。！？]|[.!?](?=\s|$)))/.exec(String(s || '')); return clip(m ? m[1] : s, 160); }

    function extract(src, opts) {
        opts = opts || {}; if (typeof opts.parse !== 'function') throw new Error('extract 需要 opts.parse（回傳 ESTree）'); const pkg = String(opts.pkg || 'lib').replace(/[^\w.-]/g, '_'); const warnings = []; const comments = [];
        let ast; try { ast = opts.parse(String(src), (block, text, start, end) => comments.push({ block, text, start, end })); } catch (e) { return { ok: false, error: '語法解析失敗：' + String((e && e.message) || e), units: [], exports: [], warnings }; }
        const body = ast.body || []; const srcS = String(src);
        const docBefore = (node) => { // 緊貼在節點前面的 /** … */
            let best = null; for (const c of comments) { if (!c.block || c.text[0] !== '*') continue; if (c.end <= node.start && /^\s*$/.test(srcS.slice(c.end, node.start))) best = c; else if (c.end <= node.start && /^\s*(export\s+(default\s+)?|var\s+|let\s+|const\s+|static\s+|async\s+)*\s*$/.test(srcS.slice(c.end, node.start))) best = c; } return best ? parseJsDoc(best.text) : null;
        };
        // 範圍：頂層，加上 UMD／IIFE 工廠函式的本體
        const scopes = [{ name: 'top', body }]; (function findFactories(stmts, depth) {
            if (depth > 2) return; for (const st of stmts) {
                const exprs = []; if (st.type === 'ExpressionStatement') exprs.push(st.expression); if (st.type === 'VariableDeclaration') st.declarations.forEach((d) => d.init && exprs.push(d.init));
                for (const ex0 of exprs) { let ex = ex0; if (ex.type === 'UnaryExpression' || ex.type === 'SequenceExpression') ex = ex.argument || ex.expressions[0]; if (ex && ex.type === 'AssignmentExpression') ex = ex.right; if (ex && ex.type === 'CallExpression') { const callee = ex.callee.type === 'MemberExpression' && ex.callee.object && isFn(ex.callee.object) && /^(call|apply)$/.test(keyName(ex.callee.property) || '') ? ex.callee.object : ex.callee; // (function(){…}).call(this) 也是 IIFE
                        const fns = [callee].concat(ex.arguments).filter((a) => a && (a.type === 'FunctionExpression' || a.type === 'ArrowFunctionExpression') && a.body && a.body.type === 'BlockStatement'); for (const f of fns) { if (f.body.body.length > 1) { scopes.push({ name: 'factory', body: f.body.body, fn: f }); findFactories(f.body.body, depth + 1); } } } }
            }
        })(body, 0);
        const decls = new Map(); // 名稱 → { node, doc, scope }
        const addDecl = (name, node, doc, scopeName) => { const key = scopeName + ':' + name; if (!decls.has(key)) decls.set(key, { name, node, doc, scope: scopeName }); };
        const exportsList = []; // { qual, fn, doc, kind, via, cls }
        const resolve = (id, scopeName) => decls.get(scopeName + ':' + id) || decls.get('top:' + id) || Array.from(decls.values()).find((d) => d.name === id);
        for (const sc of scopes) {
            for (const st of sc.body) {
                let node = st, exported = false, exportDefault = false; if (st.type === 'ExportNamedDeclaration' && st.declaration) { node = st.declaration; exported = true; } else if (st.type === 'ExportDefaultDeclaration') { node = st.declaration; exportDefault = true; exported = true; }
                const doc = docBefore(st) || docBefore(node);
                if (node.type === 'FunctionDeclaration' && node.id) { addDecl(node.id.name, node, doc, sc.name); if (exported) exportsList.push({ qual: exportDefault ? 'default' : node.id.name, fn: node, doc, via: 'esm' }); }
                else if (node.type === 'ClassDeclaration' && node.id) { addDecl(node.id.name, node, doc, sc.name); if (exported) exportsList.push({ qual: exportDefault ? 'default' : node.id.name, cls: node, doc, via: 'esm' }); }
                else if (node.type === 'VariableDeclaration') { for (const d of node.declarations) { if (d.id.type !== 'Identifier' || !d.init) continue; const dd = docBefore(st) || docBefore(d); if (isFn(d.init) || d.init.type === 'ClassExpression' || d.init.type === 'ObjectExpression') { addDecl(d.id.name, d.init, dd, sc.name); if (exported) exportsList.push({ qual: d.id.name, fn: isFn(d.init) ? d.init : null, cls: d.init.type === 'ClassExpression' ? d.init : null, obj: d.init.type === 'ObjectExpression' ? d.init : null, doc: dd, via: 'esm' }); } } }
                else if (node.type === 'ExportNamedDeclaration' || st.type === 'ExportNamedDeclaration') { for (const sp of (st.specifiers || [])) { exportsList.push({ qual: sp.exported.name, ref: sp.local.name, via: 'esm' }); } }
                else if (st.type === 'ExportDefaultDeclaration' && node.type === 'Identifier') exportsList.push({ qual: 'default', ref: node.name, via: 'esm' });
                // CommonJS／UMD 賦值
                if (st.type === 'ExpressionStatement' && st.expression.type === 'AssignmentExpression') {
                    const a = st.expression; const lp = memberPath(a.left); const rhs = a.right;
                    if (lp === 'module.exports') { if (rhs.type === 'ObjectExpression') for (const pr of rhs.properties) { if (pr.type !== 'Property') continue; const k = keyName(pr.key); if (!k) continue; if (pr.value.type === 'Identifier') exportsList.push({ qual: k, ref: pr.value.name, via: 'cjs' }); else if (isFn(pr.value)) exportsList.push({ qual: k, fn: pr.value, doc: docBefore(pr), via: 'cjs' }); }
                        else if (rhs.type === 'Identifier') exportsList.push({ qual: 'default', ref: rhs.name, via: 'cjs' }); else if (isFn(rhs)) exportsList.push({ qual: 'default', fn: rhs, doc, via: 'cjs' }); else if (rhs.type === 'ClassExpression') exportsList.push({ qual: 'default', cls: rhs, doc, via: 'cjs' }); }
                    else if (lp && /^(module\.)?exports\.[\w$]+$/.test(lp)) { const k = lp.split('.').pop(); if (isFn(rhs)) exportsList.push({ qual: k, fn: rhs, doc, via: 'cjs' }); else if (rhs.type === 'Identifier') exportsList.push({ qual: k, ref: rhs.name, via: 'cjs' }); else if (rhs.type === 'ClassExpression') exportsList.push({ qual: k, cls: rhs, doc, via: 'cjs' }); }
                    else if (lp && /^(window|self|globalThis|root|global)\.[\w$]+$/.test(lp)) { const k = lp.split('.').pop(); if (isFn(rhs)) exportsList.push({ qual: k, fn: rhs, doc, via: 'global' }); else if (rhs.type === 'Identifier') exportsList.push({ qual: k, ref: rhs.name, via: 'global' }); else if (rhs.type === 'ObjectExpression') exportsList.push({ qual: k, obj: rhs, doc, via: 'global' }); }
                    else if (lp && /\.prototype\.[\w$]+$/.test(lp) && isFn(rhs)) { const parts = lp.split('.'); exportsList.push({ qual: parts[0] + '.' + parts[parts.length - 1], fn: rhs, doc, via: 'prototype', cls: null }); }
                    else if (lp && /^[A-Z][\w$]*\.[\w$]+$/.test(lp) && isFn(rhs)) exportsList.push({ qual: lp, fn: rhs, doc, via: 'static' });
                }
                // 工廠函式 return { a, b }
                if (sc.name === 'factory' && st.type === 'ReturnStatement' && st.argument) { const r = st.argument; if (r.type === 'ObjectExpression') for (const pr of r.properties) { if (pr.type !== 'Property') continue; const k = keyName(pr.key); if (!k) continue; if (pr.value.type === 'Identifier') exportsList.push({ qual: k, ref: pr.value.name, via: 'umd', scope: sc.name }); else if (isFn(pr.value)) exportsList.push({ qual: k, fn: pr.value, doc: docBefore(pr), via: 'umd' }); } else if (r.type === 'Identifier') exportsList.push({ qual: 'default', ref: r.name, via: 'umd', scope: sc.name }); }
            }
        }
        // 都沒有明確匯出：瀏覽器全域指令稿，頂層函式與類別就是對外的
        if (!exportsList.some((e) => ['esm', 'cjs', 'umd', 'global'].includes(e.via))) for (const d of decls.values()) if ((d.scope === 'top' || /^[A-Z]/.test(d.name)) && (d.node.type === 'FunctionDeclaration' || d.node.type === 'ClassDeclaration' || d.node.type === 'ObjectExpression') && !/^_/.test(d.name)) exportsList.push({ qual: d.name, ref: d.name, via: 'global' });
        // 解開 ref
        const resolved = []; const seenQ = new Set();
        for (const ex of exportsList) {
            let e = ex; if (ex.ref) { const d = resolve(ex.ref, ex.scope || 'top'); if (!d) { warnings.push('匯出 ' + ex.qual + ' 指向 ' + ex.ref + '，但在這份檔案裡找不到宣告（可能來自別的檔案）'); continue; } e = Object.assign({}, ex, { fn: isFn(d.node) ? d.node : null, cls: (d.node.type === 'ClassDeclaration' || d.node.type === 'ClassExpression') ? d.node : null, obj: d.node.type === 'ObjectExpression' ? d.node : null, doc: ex.doc || d.doc }); }
            if (seenQ.has(e.qual)) continue; seenQ.add(e.qual); resolved.push(e);
        }
        // 展開成『可呼叫的東西』：函式、類別（建構子＋方法）、物件的函式成員、已知類別上的 prototype 方法
        const callables = []; const push = (qual, fn, doc, extra) => { if (callables.length < MAX_UNITS && fn) callables.push(Object.assign({ qual, fn, doc: doc || null }, extra || {})); };
        const classByName = new Map(resolved.filter((e) => e.cls).map((e) => [e.qual, e]));
        for (const e of resolved) {
            if (e.via === 'prototype') { push(e.qual, e.fn, e.doc, { method: true }); continue; }
            if (e.fn) push(e.qual, e.fn, e.doc);
            if (e.cls) { const ctor = (e.cls.body.body || []).find((m) => m.type === 'MethodDefinition' && m.kind === 'constructor'); push(e.qual + '.new', ctor ? ctor.value : { type: 'FunctionExpression', params: [], body: { type: 'BlockStatement', body: [] } }, e.doc, { ctor: true }); for (const m of e.cls.body.body || []) { if (m.type !== 'MethodDefinition' || m.kind === 'constructor') continue; const mk = keyName(m.key); if (!mk || /^[_#]/.test(mk) || m.key.type === 'PrivateIdentifier') continue; push(e.qual + '.' + mk, m.value, docBefore(m), { method: !m.static, static: !!m.static }); } }
            if (e.obj) for (const pr of e.obj.properties) { if (pr.type !== 'Property') continue; const k = keyName(pr.key); if (!k || /^_/.test(k)) continue; if (isFn(pr.value)) push(e.qual + '.' + k, pr.value, docBefore(pr)); }
        }
        // 副作用：順著同一份檔案的呼叫鏈合併
        const nameToFn = new Map(); for (const d of decls.values()) if (isFn(d.node)) nameToFn.set(d.name, d.node);
        const effCache = new Map();
        function effectsOf(fn, chain) { if (effCache.has(fn)) return effCache.get(fn); const de = directEffects(fn); const eff = new Set(de.eff); const ev = de.ev.slice(); let unresolved = 0;
            if (chain.length < MAX_CHAIN) for (const c of de.callees) { const t = nameToFn.get(c); if (!t || chain.includes(t) || t === fn) continue; const r = effectsOf(t, chain.concat([fn])); r.eff.forEach((x) => eff.add(x)); r.ev.forEach((x) => { if (ev.length < 6) ev.push(x + '（經由 ' + c + '）'); }); }
            const out = { eff, ev, unresolved }; if (!chain.length) effCache.set(fn, out); return out; }
        const stateTouch = (fn) => { let read = false, write = false; walk(fn.body || fn, (n) => { if (n.type === 'ThisExpression') read = true; if (n.type === 'AssignmentExpression' || n.type === 'UpdateExpression') { const tgt = n.left || n.argument; const p = memberPath(tgt); if (p && /^this\./.test(p)) write = true; } }); return { read, write }; }; // 方法用到 this＝跟實例狀態有關，不是純的
        const units = []; const state = opts.state || 'needs-network';
        for (const c of callables) {
            const doc = c.doc; if (doc && doc.isPrivate) continue; const params = paramsOf(c.fn, doc); const r = effectsOf(c.fn, []); const effects = Array.from(r.eff).filter((e) => Cat.EFFECTS.includes(e));
            const tdoc = doc && doc.returns && doc.returns.type ? jsDocType(doc.returns.type) : null; const returns = tdoc ? { type: tdoc, type_src: 'doc' } : { type: 'any', type_src: 'none' };
            const isMethod = !!c.method && !c.ctor; const st = isMethod ? stateTouch(c.fn) : { read: false, write: false }; const touches = st.read || st.write; const pure = !effects.length && !touches && !c.ctor;
            const u = { id: 'js:' + pkg + '.' + c.qual, runtime: 'js', name: pkg + '.' + c.qual, summary: firstSentence(doc && doc.summary), params, returns, effects: pure ? [] : (effects.length ? effects : (c.ctor || st.write ? ['state.write'] : (st.read ? ['state.read'] : ['unknown']))), pure, avail: { state, needs: [] }, domains: [], tests: [], tier: 0,
                call: { runtime: 'js', module: pkg, import: pkg, qualname: c.qual, via: opts.via || 'unloaded', async: !!c.fn.async, ctor: !!c.ctor, method: isMethod || undefined }, sig_src: 'ast' };
            if (doc && doc.deprecated) u.deprecated = true; if (r.ev.length) u.effect_evidence = r.ev; if (pure) u.pure_src = 'static'; if (opts.version) u.version = opts.version; units.push(u);
        }
        const typed = units.reduce((a, u) => a + u.params.filter((p) => p.type_src !== 'none').length, 0), all = units.reduce((a, u) => a + u.params.length, 0);
        return { ok: true, units, exports: resolved.map((e) => e.qual), via: Array.from(new Set(resolved.map((e) => e.via))), warnings, stats: { exports: resolved.length, units: units.length, params: all, typed_params: typed, documented: units.filter((u) => u.summary).length, effects_known: units.filter((u) => !u.effects.includes('unknown')).length } };
    }
    return { extract, parseJsDoc, jsDocType, directEffects };
});
