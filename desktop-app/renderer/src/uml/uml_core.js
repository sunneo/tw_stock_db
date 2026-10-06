/* UML → 程式碼骨架（FaUml）：設計語意 → UML → framework。top-down，每一區都是一個 template，讓弱的小模型也能從設計一路走到程式骨架。
 *
 * 管線（每一段都有型別、都被驗證；程式能決定的就程式決定，模型只做封閉的小決策）：
 *   ① 情境（文字）  →  ② UML 模型（JSON／一行一件事的文字 DSL）  →  ③ 圖（Mermaid／PlantUML，程式產生）  →  ④ 程式碼骨架（template 展開）
 *   ①→②：模型一次只回答一個封閉的小問題（參與者與使用案例、有哪些類別、某個類別的屬性與操作、某個類別跟誰有什麼關係、某個使用案例的呼叫順序），
 *         每個回覆都被驗證（識別字格式、型別必須是基本型別或已知類別、關係種類與方向、呼叫的操作必須存在），不合格就退回、模型沒有前面步驟的記憶。
 *   ②→④：完全是程式——template 依區域由上而下展開：專案 → 類別檔 → 成員 → 測試；方法本體是有文件與「依使用案例會呼叫誰」註解的 stub。
 * 純函式（UMD）；模型（generate）是注入的，所以能用假模型完整測試，也能搬到別的宿主。語言可擴充：加一組 LANGS 條目（型別對照＋template）。
 */
(function (root, factory) {
    const R = (typeof FaRecipe !== 'undefined' && FaRecipe) || (root && root.FaRecipe) || (typeof require === 'function' ? require('../recipe/recipe_core.js') : null);
    if (typeof module === 'object' && module.exports) module.exports = factory(R);
    else root.FaUml = factory(R);
})(typeof self !== 'undefined' ? self : this, function (R) {
    'use strict';

    // ---------- 型別 ----------
    const PRIMS = ['int', 'float', 'str', 'bool', 'date', 'datetime', 'bytes', 'any', 'void', 'decimal'];
    const GENERICS = { List: 1, Set: 1, Map: 2, Optional: 1 };
    const SYN = { string: 'str', text: 'str', integer: 'int', long: 'int', number: 'float', double: 'float', boolean: 'bool', object: 'any', dict: 'Map', list: 'List', array: 'List', set: 'Set', map: 'Map', optional: 'Optional', datetime: 'datetime', date: 'date', time: 'datetime', money: 'decimal', float: 'float', int: 'int', str: 'str', bool: 'bool', void: 'void', bytes: 'bytes', any: 'any', decimal: 'decimal' };
    const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
    const CLASS_NAME = /^[A-Z][A-Za-z0-9]{0,40}$/;
    const MEMBER_NAME = /^[a-z_][A-Za-z0-9_]{0,40}$/;
    // 型別運算式：Name、List<T>、Map<K,V>、Optional<T>、T[]、T?；回傳 { base, args:[...] } 或 null
    function parseType(s) {
        s = String(s == null ? '' : s).trim(); if (!s) return null;
        if (/\?$/.test(s)) { const inner = parseType(s.slice(0, -1)); return inner && { base: 'Optional', args: [inner] }; }
        if (/\[\]$/.test(s)) { const inner = parseType(s.slice(0, -2)); return inner && { base: 'List', args: [inner] }; }
        const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*(?:<(.*)>)?$/.exec(s); if (!m) return null;
        const raw = m[1]; const low = raw.toLowerCase(); const base = SYN[low] && !/^[A-Z]/.test(raw) ? SYN[low] : (SYN[low] && GENERICS[SYN[low]] ? SYN[low] : raw);
        if (m[2] == null) return GENERICS[base] ? null : { base, args: [] };
        if (!GENERICS[base]) return null;
        const parts = []; let depth = 0, cur = ''; for (const c of m[2]) { if (c === '<') depth++; if (c === '>') depth--; if (c === ',' && depth === 0) { parts.push(cur); cur = ''; } else cur += c; } parts.push(cur);
        if (parts.length !== GENERICS[base]) return null; const args = parts.map(parseType); if (args.some((a) => !a)) return null; return { base, args };
    }
    function typeToString(t) { return !t ? 'any' : (t.args && t.args.length ? t.base + '<' + t.args.map(typeToString).join(', ') + '>' : t.base); }
    function typeRefs(t, out) { out = out || []; if (!t) return out; if (!PRIMS.includes(t.base) && !GENERICS[t.base]) out.push(t.base); (t.args || []).forEach((a) => typeRefs(a, out)); return out; }

    // ---------- 文字 DSL（一行一件事，弱模型友善）----------
    //   model: 名稱 / actor: A, B
    //   class Name [extends Base] [implements I1, I2] { +id:int; items:List<Item>; +total():float; add(item:Item):void }   （也可以多行）
    //   interface Name { pay(amount:float):bool }　　enum Name { NEW, PAID }　　abstract class Name {...}
    //   A *-- B（A 由 B 組成）　A o-- B（聚合）　A --> B : 標籤（關聯）　A ..> B（依賴）　Child --|> Parent（繼承）　Class ..|> Iface（實作）
    //   usecase 名稱: Actor -> Cls.op(args):ret -> Cls2.op2()　（鏈：每一步由上一個參與者呼叫）
    const REL_OPS = [['--|>', 'inherit'], ['..|>', 'implement'], ['*--', 'compose'], ['o--', 'aggregate'], ['-->', 'assoc'], ['..>', 'depend']];
    function parseParams(s) { const out = []; for (const p of String(s || '').split(',').map((x) => x.trim()).filter(Boolean)) { const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*(?::\s*(.+))?$/.exec(p); if (!m) return null; const t = m[2] ? parseType(m[2]) : { base: 'any', args: [] }; if (!t) return null; out.push({ name: m[1], type: t }); } return out; }
    function parseMember(raw) {
        let s = raw.trim(); if (!s) return null; let vis = '+'; if (/^[+\-#~]/.test(s)) { vis = s[0] === '~' ? '+' : s[0]; s = s.slice(1).trim(); } let isStatic = false; if (/^static\s+/.test(s)) { isStatic = true; s = s.replace(/^static\s+/, ''); }
        const op = /^([A-Za-z_][A-Za-z0-9_]*)\s*\((.*)\)\s*(?::\s*(.+))?$/.exec(s);
        if (op) { const params = parseParams(op[2]); if (!params) return { error: '參數格式不對：' + raw }; const ret = op[3] ? parseType(op[3]) : { base: 'void', args: [] }; if (!ret) return { error: '回傳型別不對：' + raw }; return { kind: 'op', op: { name: op[1], params, returns: ret, visibility: vis, static: isStatic } }; }
        const at = /^([A-Za-z_][A-Za-z0-9_]*)\s*(?::\s*([^=]+?))?\s*(?:=\s*(.+))?$/.exec(s); if (!at) return { error: '看不懂這個成員：' + raw };
        const t = at[2] ? parseType(at[2]) : { base: 'any', args: [] }; if (!t) return { error: '屬性型別不對：' + raw };
        return { kind: 'attr', attr: { name: at[1], type: t, visibility: vis, static: isStatic, default: at[3] ? at[3].trim() : undefined } };
    }
    function emptyModel() { return { name: 'Model', actors: [], classes: [], relations: [], usecases: [] }; }
    // 回傳 { model, errors:[{line,msg}] }
    function parseDsl(text) {
        const model = emptyModel(); const errors = []; const err = (line, msg) => errors.push({ line, msg });
        // 把大括號區塊（可能跨行）合併成一行
        const lines = []; const src = String(text || '').replace(/\r/g, '').split('\n'); let buf = null, startNo = 0;
        for (let i = 0; i < src.length; i++) {
            let l = src[i].replace(/(^|\s)(#|\/\/).*$/, '').trim(); if (!l && buf == null) continue;
            if (buf != null) { if (/^(abstract\s+class|class|interface|enum|usecase|actors?|model|title)\b/i.test(l) && !buf.includes('}')) { err(startNo, '大括號沒有結尾 }：' + buf.slice(0, 40)); buf = null; } else { buf += ' ; ' + l; if (l.includes('}')) { lines.push([startNo, buf]); buf = null; } continue; } }
            if (l.includes('{') && !l.includes('}')) { buf = l; startNo = i + 1; continue; }
            lines.push([i + 1, l]);
        }
        if (buf != null) err(startNo, '大括號沒有結尾 }');
        for (const [no, l0] of lines) {
            const l = l0.trim(); if (!l) continue; let m;
            if ((m = /^(?:model|title)\s*[:：]\s*(.+)$/i.exec(l))) { model.name = m[1].trim(); continue; }
            if ((m = /^actors?\s*[:：]?\s*(.+)$/i.exec(l))) { for (const a of m[1].split(/[,，、]/).map((x) => x.trim()).filter(Boolean)) { if (!IDENT.test(a)) err(no, '參與者名稱不是合法識別字：' + a); else if (!model.actors.includes(a)) model.actors.push(a); } continue; }
            if ((m = /^usecase\s+([^:：]+?)\s*[:：]\s*(.+)$/i.exec(l))) {
                const parts = m[2].split('->').map((x) => x.trim()).filter(Boolean); if (parts.length < 2) { err(no, '使用案例至少要有「參與者 -> 類別.操作」'); continue; }
                const actor = parts[0]; if (!IDENT.test(actor)) { err(no, '使用案例的第一個要是參與者／類別名稱：' + actor); continue; }
                const steps = []; let prev = actor, bad = false;
                for (const p of parts.slice(1)) { const sm = /^([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)\s*(?:\((.*)\))?\s*(?::\s*(.+))?$/.exec(p); if (!sm) { err(no, '呼叫格式要是 類別.操作(參數)：' + p); bad = true; break; } steps.push({ from: prev, to: sm[1], msg: sm[2], args: sm[3] ? sm[3].split(',').map((x) => x.trim()).filter(Boolean) : [], returns: sm[4] ? sm[4].trim() : '' }); prev = sm[1]; }
                if (!bad) model.usecases.push({ name: m[1].trim(), actor, steps }); continue;
            }
            if ((m = /^(abstract\s+class|class|interface|enum)\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?:(?:extends|:)\s*([A-Za-z_][A-Za-z0-9_]*))?\s*(?:implements\s+([A-Za-z0-9_,\s]+?))?\s*(?:\{(.*)\})?\s*$/.exec(l))) {
                const kind = m[1].replace(/\s+/g, ' '); const cls = { name: m[2], kind: kind === 'abstract class' ? 'abstract' : kind, attrs: [], ops: [], values: [] };
                if (!CLASS_NAME.test(cls.name)) err(no, '類別名稱要是英文 PascalCase：' + cls.name);
                if (model.classes.some((c) => c.name === cls.name)) { err(no, '類別重複定義：' + cls.name); continue; }
                if (m[3]) model.relations.push({ from: cls.name, to: m[3], kind: 'inherit' });
                if (m[4]) for (const i of m[4].split(',').map((x) => x.trim()).filter(Boolean)) model.relations.push({ from: cls.name, to: i, kind: 'implement' });
                const body = (m[5] || '').trim();
                if (body) { const items = body.split(/[;\n]/).map((x) => x.trim()).filter(Boolean); if (cls.kind === 'enum') cls.values = body.split(/[,;]/).map((x) => x.trim()).filter(Boolean); else for (const it of items) { const pm = parseMember(it); if (!pm) continue; if (pm.error) { err(no, pm.error); continue; } if (pm.kind === 'op') cls.ops.push(pm.op); else cls.attrs.push(pm.attr); } }
                model.classes.push(cls); continue;
            }
            let rel = null; for (const [op, kind] of REL_OPS) { const idx = l.indexOf(op); if (idx > 0) { rel = { op, kind, idx }; break; } }
            if (rel) {
                const left = l.slice(0, rel.idx).trim(); const rest = l.slice(rel.idx + rel.op.length).trim(); const rm = /^([A-Za-z_][A-Za-z0-9_]*)\s*(?:[:：]\s*(.*))?$/.exec(rest); if (!rm || !IDENT.test(left)) { err(no, '關係格式要是 A ' + rel.op + ' B [: 標籤]：' + l); continue; }
                const label = (rm[2] || '').trim(); const r = { from: left, to: rm[1], kind: rel.kind }; if (label) { const mm = /(\d+|\*)(?:\.\.(\d+|\*))?\s*$/.exec(label); if (mm && /^(\d+|\*)/.test(label.slice(label.length - mm[0].length))) { r.mult = mm[0].trim(); const lb = label.slice(0, label.length - mm[0].length).trim(); if (lb) r.label = lb; } else r.label = label; } model.relations.push(r); continue;
            }
            err(no, '看不懂這一行：' + l.slice(0, 60));
        }
        return { model, errors };
    }
    function memberToDsl(c, a) { return a; }
    function opToDsl(o) { return (o.visibility === '+' ? '+' : o.visibility || '') + (o.static ? 'static ' : '') + o.name + '(' + o.params.map((p) => p.name + ':' + typeToString(p.type)).join(', ') + '):' + typeToString(o.returns); }
    function attrToDsl(a) { return (a.visibility === '+' ? '+' : a.visibility || '') + (a.static ? 'static ' : '') + a.name + ':' + typeToString(a.type) + (a.default ? ' = ' + a.default : ''); }
    function toDsl(model) {
        const out = []; out.push('model: ' + model.name); if (model.actors.length) out.push('actor: ' + model.actors.join(', '));
        for (const c of model.classes) {
            const bases = model.relations.filter((r) => r.from === c.name && r.kind === 'inherit').map((r) => r.to); const impls = model.relations.filter((r) => r.from === c.name && r.kind === 'implement').map((r) => r.to);
            const kind = c.kind === 'abstract' ? 'abstract class' : c.kind; const head = kind + ' ' + c.name + (bases.length ? ' extends ' + bases[0] : '') + (impls.length ? ' implements ' + impls.join(', ') : '');
            const body = c.kind === 'enum' ? (c.values || []).join(', ') : c.attrs.map(attrToDsl).concat(c.ops.map(opToDsl)).join('; ');
            out.push(head + (body ? ' { ' + body + ' }' : ''));
        }
        const ro = Object.fromEntries(REL_OPS.map(([op, k]) => [k, op]));
        for (const r of model.relations) { if (r.kind === 'inherit' || r.kind === 'implement') continue; out.push(r.from + ' ' + ro[r.kind] + ' ' + r.to + (r.label || r.mult ? ' : ' + [r.label, r.mult].filter(Boolean).join(' ') : '')); }
        for (const u of model.usecases) out.push('usecase ' + u.name + ': ' + u.actor + ' -> ' + u.steps.map((s) => s.to + '.' + s.msg + '(' + (s.args || []).join(', ') + ')' + (s.returns ? ':' + s.returns : '')).join(' -> '));
        return out.join('\n');
    }

    // ---------- 驗證 ----------
    function validateModel(model) {
        const errs = []; const names = new Set(model.classes.map((c) => c.name)); const actors = new Set(model.actors);
        for (const c of model.classes) {
            if (!CLASS_NAME.test(c.name)) errs.push('類別名稱要是英文 PascalCase：' + c.name);
            const seen = new Set(); for (const a of c.attrs) { if (seen.has(a.name)) errs.push(c.name + ' 的屬性重複：' + a.name); seen.add(a.name); for (const ref of typeRefs(a.type)) if (!names.has(ref)) errs.push(c.name + '.' + a.name + ' 的型別「' + ref + '」不是基本型別也不是已知類別'); }
            const seenOps = new Set(); for (const o of c.ops) { if (seenOps.has(o.name)) errs.push(c.name + ' 的操作重複：' + o.name); seenOps.add(o.name); for (const t of [o.returns].concat(o.params.map((p) => p.type))) for (const ref of typeRefs(t)) if (!names.has(ref)) errs.push(c.name + '.' + o.name + ' 用到未知型別「' + ref + '」'); }
            if (c.kind === 'interface' && c.attrs.length) errs.push('interface ' + c.name + ' 不應該有屬性');
        }
        const kindOf = Object.fromEntries(model.classes.map((c) => [c.name, c.kind]));
        for (const r of model.relations) {
            if (!names.has(r.from)) errs.push('關係的起點不是已知類別：' + r.from); if (!names.has(r.to)) errs.push('關係的終點不是已知類別：' + r.to);
            if (r.from === r.to && r.kind !== 'assoc') errs.push(r.from + ' 不能對自己 ' + r.kind);
            if (r.kind === 'implement' && kindOf[r.to] && kindOf[r.to] !== 'interface') errs.push(r.from + ' 實作的 ' + r.to + ' 必須是 interface');
            if (r.kind === 'inherit' && kindOf[r.to] === 'interface') errs.push(r.from + ' 繼承的 ' + r.to + ' 是 interface，要用 implements');
        }
        // 繼承不能有環
        const parent = {}; model.relations.filter((r) => r.kind === 'inherit').forEach((r) => { parent[r.from] = r.to; }); for (const c of Object.keys(parent)) { let x = c, n = 0; while (parent[x] && n++ < 50) x = parent[x]; if (n >= 50) { errs.push('繼承有環：' + c); break; } }
        for (const u of model.usecases) {
            if (!actors.has(u.actor) && !names.has(u.actor)) errs.push('使用案例「' + u.name + '」的參與者 ' + u.actor + ' 沒有宣告（actor: 或類別）');
            for (const s of u.steps) { if (!names.has(s.to)) errs.push('使用案例「' + u.name + '」呼叫未知類別 ' + s.to); else { const c = model.classes.find((x) => x.name === s.to); if (c.kind !== 'enum' && !c.ops.some((o) => o.name === s.msg)) errs.push('使用案例「' + u.name + '」呼叫 ' + s.to + '.' + s.msg + '，但這個類別沒有這個操作'); } }
        }
        return errs;
    }
    // 讓模型的「新操作」自動補進類別（使用案例呼叫了還不存在的操作時）
    function ensureOps(model) { const added = []; for (const u of model.usecases) for (const s of u.steps) { const c = model.classes.find((x) => x.name === s.to); if (c && c.kind !== 'enum' && !c.ops.some((o) => o.name === s.msg)) { c.ops.push({ name: s.msg, params: (s.args || []).map((a, i) => ({ name: /^[A-Za-z_]\w*$/.test(a) ? a : 'arg' + (i + 1), type: { base: 'any', args: [] } })), returns: { base: 'void', args: [] }, visibility: '+', static: false }); added.push(s.to + '.' + s.msg); } } return added; }

    // ---------- 圖（程式產生）----------
    const MM_REL = { inherit: '--|>', implement: '..|>', compose: '*--', aggregate: 'o--', assoc: '-->', depend: '..>' };
    function mmType(t) { return typeToString(t).replace(/</g, '~').replace(/>/g, '~').replace(/, /g, ','); }
    function toMermaidClass(model) {
        const L = ['classDiagram'];
        for (const c of model.classes) {
            L.push('    class ' + c.name + ' {'); if (c.kind === 'interface') L.push('        <<interface>>'); else if (c.kind === 'enum') L.push('        <<enumeration>>'); else if (c.kind === 'abstract') L.push('        <<abstract>>');
            if (c.kind === 'enum') (c.values || []).forEach((v) => L.push('        ' + v)); else { c.attrs.forEach((a) => L.push('        ' + (a.visibility || '+') + mmType(a.type) + ' ' + a.name)); c.ops.forEach((o) => L.push('        ' + (o.visibility || '+') + o.name + '(' + o.params.map((p) => mmType(p.type) + ' ' + p.name).join(', ') + ') ' + mmType(o.returns))); }
            L.push('    }');
        }
        for (const r of model.relations) { const lab = [r.label, r.mult].filter(Boolean).join(' '); L.push('    ' + (r.kind === 'inherit' || r.kind === 'implement' ? r.to + ' ' + (r.kind === 'inherit' ? '<|--' : '<|..') + ' ' + r.from : r.from + ' ' + MM_REL[r.kind] + ' ' + r.to) + (lab ? ' : ' + lab : '')); }
        return L.join('\n');
    }
    function toMermaidSequence(model, uc) {
        const L = ['sequenceDiagram']; const parts = [uc.actor].concat(uc.steps.map((s) => s.to)).filter((x, i, a) => a.indexOf(x) === i);
        for (const p of parts) L.push('    ' + (model.actors.includes(p) ? 'actor ' : 'participant ') + p);
        for (const s of uc.steps) { L.push('    ' + s.from + '->>' + s.to + ': ' + s.msg + '(' + (s.args || []).join(', ') + ')'); if (s.returns) L.push('    ' + s.to + '-->>' + s.from + ': ' + s.returns); }
        return L.join('\n');
    }
    function toMermaidUseCase(model) { const L = ['flowchart LR']; for (const a of model.actors) L.push('    ' + a + '([' + a + '])'); model.usecases.forEach((u, i) => { L.push('    uc' + i + '(("' + u.name + '"))'); L.push('    ' + u.actor + ' --> uc' + i); }); return L.join('\n'); }
    function toPlantUml(model) {
        const L = ['@startuml']; for (const c of model.classes) { L.push((c.kind === 'abstract' ? 'abstract class' : c.kind) + ' ' + c.name + ' {'); if (c.kind === 'enum') (c.values || []).forEach((v) => L.push('  ' + v)); else { c.attrs.forEach((a) => L.push('  ' + (a.visibility || '+') + a.name + ' : ' + typeToString(a.type))); c.ops.forEach((o) => L.push('  ' + (o.visibility || '+') + o.name + '(' + o.params.map((p) => p.name + ' : ' + typeToString(p.type)).join(', ') + ') : ' + typeToString(o.returns))); } L.push('}'); }
        const pr = { inherit: '--|>', implement: '..|>', compose: '*--', aggregate: 'o--', assoc: '-->', depend: '..>' }; for (const r of model.relations) L.push(r.from + ' ' + pr[r.kind] + ' ' + r.to + (r.label ? ' : ' + r.label : ''));
        L.push('@enduml'); return L.join('\n');
    }

    // ---------- Template 引擎（極小：{{x}}、{{x|filter}}、{{#each}}、{{#if}}…{{else}}…{{/if}}）----------
    const FILTERS = {
        pascal: (s) => String(s).replace(/(^|[_\s-]+)([A-Za-z0-9])/g, (m, a, b) => b.toUpperCase()), camel: (s) => { const p = String(s).replace(/(^|[_\s-]+)([A-Za-z0-9])/g, (m, a, b) => b.toUpperCase()); return p.charAt(0).toLowerCase() + p.slice(1); },
        snake: (s) => String(s).replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/[\s-]+/g, '_').toLowerCase(), upper: (s) => String(s).toUpperCase(), lower: (s) => String(s).toLowerCase(), indent: (s) => String(s).split('\n').map((l) => (l ? '    ' + l : l)).join('\n'),
    };
    function lookup(stack, path) {
        const parts = path.split('.'); const first = parts[0]; let v;
        if (first === 'this') { const sc = stack[stack.length - 1]; v = sc && typeof sc === 'object' && 'this' in sc ? sc.this : sc; }
        else { for (let i = stack.length - 1; i >= 0; i--) { const sc = stack[i]; if (sc && typeof sc === 'object' && first in sc) { v = sc[first]; break; } } }
        for (const p of parts.slice(1)) v = v == null ? undefined : v[p];
        return v;
    }
    function renderTpl(tpl, ctx) {
        const toks = []; const re = /\{\{\s*([#/]?)\s*([^}]*?)\s*\}\}/g; let last = 0, m;
        while ((m = re.exec(tpl))) { if (m.index > last) toks.push({ t: 'text', v: tpl.slice(last, m.index) }); const body = m[2]; if (m[1] === '#') { const sp = body.split(/\s+/); toks.push({ t: 'open', kind: sp[0], arg: sp.slice(1).join(' ') }); } else if (m[1] === '/') toks.push({ t: 'close', kind: body }); else if (body === 'else') toks.push({ t: 'else' }); else toks.push({ t: 'var', v: body }); last = re.lastIndex; }
        if (last < tpl.length) toks.push({ t: 'text', v: tpl.slice(last) });
        function build(i, stopKinds) { const nodes = []; let elseNodes = null; let cur = nodes; while (i < toks.length) { const k = toks[i]; if (k.t === 'close') return { nodes, elseNodes, i: i + 1 }; if (k.t === 'else') { elseNodes = []; cur = elseNodes; i++; continue; } if (k.t === 'open') { const inner = build(i + 1); cur.push({ t: 'block', kind: k.kind, arg: k.arg, nodes: inner.nodes, elseNodes: inner.elseNodes }); i = inner.i; continue; } cur.push(k); i++; } return { nodes, elseNodes, i }; }
        const tree = build(0).nodes;
        function ev(nodes, stack) {
            let out = '';
            for (const n of nodes) {
                if (n.t === 'text') out += n.v;
                else if (n.t === 'var') { const [path, ...fl] = n.v.split('|').map((x) => x.trim()); let v = lookup(stack, path); if (v == null) v = ''; for (const f of fl) if (FILTERS[f]) v = FILTERS[f](v); out += String(v); }
                else if (n.t === 'block') {
                    const val = lookup(stack, n.arg);
                    if (n.kind === 'each') { const arr = Array.isArray(val) ? val : []; if (!arr.length && n.elseNodes) out += ev(n.elseNodes, stack); arr.forEach((it, idx) => { out += ev(n.nodes, stack.concat([typeof it === 'object' && it ? Object.assign({ '@index': idx, '@first': idx === 0, '@last': idx === arr.length - 1 }, it) : { this: it, '@index': idx }])); }); }
                    else if (n.kind === 'if') { const ok = Array.isArray(val) ? val.length > 0 : !!val; out += ok ? ev(n.nodes, stack) : (n.elseNodes ? ev(n.elseNodes, stack) : ''); }
                }
            }
            return out;
        }
        return ev(tree, [ctx]).replace(/\n{3,}/g, '\n\n');
    }

    // ---------- 語言：型別對照＋template（每個區域一個 template）----------
    const T = (lang, base) => ({ python: { int: 'int', float: 'float', str: 'str', bool: 'bool', date: 'date', datetime: 'datetime', bytes: 'bytes', any: 'Any', void: 'None', decimal: 'Decimal' }, typescript: { int: 'number', float: 'number', str: 'string', bool: 'boolean', date: 'Date', datetime: 'Date', bytes: 'Uint8Array', any: 'unknown', void: 'void', decimal: 'number' }, java: { int: 'int', float: 'double', str: 'String', bool: 'boolean', date: 'LocalDate', datetime: 'LocalDateTime', bytes: 'byte[]', any: 'Object', void: 'void', decimal: 'BigDecimal' } }[lang][base]);
    const BOXED = { int: 'Integer', double: 'Double', boolean: 'Boolean' };
    function langType(t, lang, ctxBoxed) {
        if (!t) return lang === 'python' ? 'Any' : (lang === 'java' ? 'Object' : 'unknown'); const b = t.base; const a = (t.args || []).map((x) => langType(x, lang, true));
        if (b === 'List') return lang === 'python' ? 'List[' + a[0] + ']' : (lang === 'typescript' ? a[0] + '[]' : 'List<' + a[0] + '>');
        if (b === 'Set') return lang === 'python' ? 'Set[' + a[0] + ']' : (lang === 'typescript' ? 'Set<' + a[0] + '>' : 'Set<' + a[0] + '>');
        if (b === 'Map') return lang === 'python' ? 'Dict[' + a[0] + ', ' + a[1] + ']' : (lang === 'typescript' ? 'Map<' + a[0] + ', ' + a[1] + '>' : 'Map<' + a[0] + ', ' + a[1] + '>');
        if (b === 'Optional') return lang === 'python' ? 'Optional[' + a[0] + ']' : (lang === 'typescript' ? a[0] + ' | undefined' : a[0]);
        const mapped = T(lang, b); if (mapped) return lang === 'java' && ctxBoxed && BOXED[mapped] ? BOXED[mapped] : mapped; return b;
    }
    const LANGS = {
        python: {
            ext: '.py', testDir: 'tests', srcDir: 'src', fileName: (c) => FILTERS.snake(c.name),
            tpl: {
                class: `{{#each imports}}{{this}}
{{/each}}

{{#if isEnum}}class {{name}}(Enum):
{{#each values}}    {{name}} = "{{name}}"
{{/each}}{{else}}{{#if isInterface}}class {{name}}(ABC):{{else}}{{#if isAbstract}}@dataclass
class {{name}}{{bases}}(ABC):{{else}}@dataclass
class {{name}}{{bases}}:{{/if}}{{/if}}
    """{{doc}}"""
{{#each attrs}}    {{name}}: {{type}}{{#if default}} = {{default}}{{/if}}
{{/each}}{{#each ops}}
{{#if static}}    @staticmethod
{{/if}}{{#if abstract}}    @abstractmethod
{{/if}}    def {{name}}({{#if static}}{{else}}self{{#if params}}, {{/if}}{{/if}}{{params}}) -> {{returns}}:
        """{{doc}}"""
{{#each steps}}        # {{this}}
{{/each}}        raise NotImplementedError
{{/each}}{{/if}}`,
                test: `import pytest
{{#each imports}}{{this}}
{{/each}}

def test_{{snake}}():
    """使用案例：{{name}}（參與者：{{actor}}）"""
{{#each steps}}    # {{@index}}. {{from}} -> {{to}}.{{msg}}({{args}})
{{/each}}    pytest.skip("TODO: 實作這個使用案例的測試")
`,
            },
        },
        typescript: {
            ext: '.ts', testDir: 'tests', srcDir: 'src', fileName: (c) => c.name,
            tpl: {
                class: `{{#each imports}}{{this}}
{{/each}}

{{#if isEnum}}export enum {{name}} {
{{#each values}}    {{name}} = "{{name}}",
{{/each}}}{{else}}{{#if isInterface}}export interface {{name}}{{bases}} {
{{#each ops}}    {{name}}({{params}}): {{returns}};
{{/each}}}{{else}}/** {{doc}} */
export {{#if isAbstract}}abstract {{/if}}class {{name}}{{bases}} {
{{#each attrs}}    {{visibility}}{{#if static}}static {{/if}}{{name}}: {{type}}{{#if default}} = {{default}}{{/if}};
{{/each}}{{#each ops}}
    /** {{doc}} */
{{#each steps}}    // {{this}}
{{/each}}    {{visibility}}{{#if static}}static {{/if}}{{name}}({{params}}): {{returns}} {
        throw new Error("not implemented");
    }
{{/each}}}{{/if}}{{/if}}
`,
                test: `{{#each imports}}{{this}}
{{/each}}
describe("{{name}}", () => {
    it("{{actor}}：{{name}}", () => {
{{#each steps}}        // {{@index}}. {{from}} -> {{to}}.{{msg}}({{args}})
{{/each}}        throw new Error("TODO: 實作這個使用案例的測試");
    });
});
`,
            },
        },
        java: {
            ext: '.java', testDir: 'src/test/java', srcDir: 'src/main/java', fileName: (c) => c.name, packageDirs: true,
            tpl: {
                class: `package {{package}};

{{#each imports}}{{this}}
{{/each}}

{{#if isEnum}}public enum {{name}} { {{valuesLine}} }{{else}}{{#if isInterface}}public interface {{name}}{{bases}} {
{{#each ops}}    {{returns}} {{name}}({{params}});
{{/each}}}{{else}}/** {{doc}} */
public {{#if isAbstract}}abstract {{/if}}class {{name}}{{bases}} {
{{#each attrs}}    {{visibility}}{{#if static}}static {{/if}}{{type}} {{name}}{{#if default}} = {{default}}{{/if}};
{{/each}}{{#each ops}}
    /** {{doc}} */
{{#each steps}}    // {{this}}
{{/each}}    {{visibility}}{{#if static}}static {{/if}}{{returns}} {{name}}({{params}}) {
        throw new UnsupportedOperationException("not implemented");
    }
{{/each}}}{{/if}}{{/if}}
`,
                test: `package {{package}};

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Disabled;

class {{className}}Test {
    @Test
    @Disabled("TODO: 實作這個使用案例的測試")
    void {{camel}}() {
{{#each steps}}        // {{@index}}. {{from}} -> {{to}}.{{msg}}({{args}})
{{/each}}    }
}
`,
            },
        },
    };

    // ---------- 由 UML 展開成檔案（由上而下：專案 → 類別檔 → 成員 → 測試）----------
    // 從關係推出隱含的欄位：compose／aggregate／assoc 的終點變成起點類別的欄位（多重性帶 * 或 n..* 就是 List）
    function derivedAttrs(model, c) {
        const out = []; for (const r of model.relations) { if (r.from !== c.name || !['compose', 'aggregate', 'assoc'].includes(r.kind)) continue; const many = r.mult && /\*|\.\.(\d+)/.test(r.mult) && !/^1$/.test(r.mult); const name = FILTERS.camel(r.to) + (many ? 's' : ''); if (c.attrs.some((a) => a.name === name || (typeRefs(a.type).includes(r.to)))) continue; out.push({ name, type: many ? { base: 'List', args: [{ base: r.to, args: [] }] } : { base: r.to, args: [] }, visibility: '-', derived: true }); }
        return out;
    }
    function stepsFor(model, cls, op) { // 這個操作在哪些使用案例裡被呼叫、它之後會呼叫誰
        const notes = []; for (const u of model.usecases) { u.steps.forEach((s, i) => { if (s.to === cls.name && s.msg === op.name) { const next = u.steps[i + 1]; notes.push('使用案例「' + u.name + '」：' + s.from + ' 呼叫此操作' + (next && next.from === cls.name ? '，接著呼叫 ' + next.to + '.' + next.msg + '()' : '')); } }); }
        return notes;
    }
    function genFiles(model, opts) {
        opts = opts || {}; const lang = LANGS[opts.language] ? opts.language : 'python'; const L = LANGS[lang]; const pkg0 = (opts.package || 'app').toLowerCase().replace(/[^a-z0-9_.]/g, ''); const sub = opts.subdir ? String(opts.subdir).replace(/[^a-z0-9_]/gi, '') : ''; const pkg = lang === 'java' && sub ? pkg0 + '.' + sub : pkg0; const files = []; const byName = Object.fromEntries(model.classes.map((c) => [c.name, c]));
        const importOf = (names, fromCls) => { const out = []; for (const n of Array.from(new Set(names)).sort()) { if (n === fromCls || !byName[n]) continue; out.push(lang === 'python' ? 'from .' + L.fileName(byName[n]) + ' import ' + n : (lang === 'typescript' ? 'import { ' + n + ' } from "./' + n + '";' : '')); } return out.filter(Boolean); };
        for (const c of model.classes) {
            const isIface = c.kind === 'interface', isEnum = c.kind === 'enum', isAbs = c.kind === 'abstract';
            const bases = model.relations.filter((r) => r.from === c.name && (r.kind === 'inherit' || r.kind === 'implement')); const baseNames = bases.map((r) => r.to);
            const attrs = (c.attrs.concat(derivedAttrs(model, c))).map((a) => ({ name: a.name, type: langType(a.type, lang), visibility: lang === 'python' ? '' : (a.visibility === '-' ? 'private ' : (a.visibility === '#' ? 'protected ' : (lang === 'java' ? 'public ' : ''))), static: !!a.static, default: a.default }));
            const ops = c.ops.map((o) => ({ name: lang === 'java' || lang === 'typescript' ? o.name : FILTERS.snake(o.name), params: o.params.map((p) => (lang === 'python' ? p.name + ': ' + langType(p.type, lang) : (lang === 'java' ? langType(p.type, lang) + ' ' + p.name : p.name + ': ' + langType(p.type, lang)))).join(', '), returns: langType(o.returns, lang), visibility: lang === 'python' ? '' : (o.visibility === '-' ? 'private ' : (o.visibility === '#' ? 'protected ' : (lang === 'java' && !isIface ? 'public ' : ''))), static: !!o.static, abstract: isAbs && false, doc: (c.doc ? '' : '') + o.name, steps: stepsFor(model, c, o) }));
            const refs = [].concat(...c.attrs.map((a) => typeRefs(a.type)), ...c.ops.map((o) => [].concat(typeRefs(o.returns), ...o.params.map((p) => typeRefs(p.type)))), baseNames, ...attrs.map((a) => []));
            for (const r of model.relations) if (r.from === c.name && ['compose', 'aggregate', 'assoc', 'depend'].includes(r.kind)) refs.push(r.to);
            const imports = lang === 'python' ? ['from __future__ import annotations', 'from dataclasses import dataclass', 'from abc import ABC, abstractmethod', 'from decimal import Decimal', 'from enum import Enum', 'from datetime import date, datetime', 'from typing import Any, Dict, List, Optional, Set'].concat(importOf(refs, c.name)) : (lang === 'typescript' ? importOf(refs, c.name) : ['import java.math.BigDecimal;', 'import java.time.*;', 'import java.util.*;']);
            const basesStr = lang === 'python' ? (baseNames.length ? '(' + baseNames.join(', ') + ')' : '') : (lang === 'typescript' ? (bases.length ? (isIface ? ' extends ' + baseNames.join(', ') : ' ' + [bases.filter((r) => r.kind === 'inherit').length ? 'extends ' + bases.filter((r) => r.kind === 'inherit').map((r) => r.to).join('') : '', bases.filter((r) => r.kind === 'implement').length ? 'implements ' + bases.filter((r) => r.kind === 'implement').map((r) => r.to).join(', ') : ''].filter(Boolean).join(' ')) : '') : (bases.length ? ' ' + [bases.filter((r) => r.kind === 'inherit').length ? 'extends ' + bases.filter((r) => r.kind === 'inherit').map((r) => r.to).join('') : '', bases.filter((r) => r.kind === 'implement').length ? (isIface ? 'extends ' : 'implements ') + bases.filter((r) => r.kind === 'implement').map((r) => r.to).join(', ') : ''].filter(Boolean).join(' ') : ''));
            const pyBases = lang === 'python' && isIface ? '' : basesStr;
            const ctx = { name: c.name, doc: c.label || c.name, isEnum, isInterface: isIface, isAbstract: isAbs, bases: lang === 'python' ? pyBases : basesStr, attrs, ops, imports, values: (c.values || []).map((v) => ({ name: v })), valuesLine: (c.values || []).join(', '), package: pkg };
            let content = renderTpl(L.tpl.class, ctx).replace(/^\s+\n/, '').replace(/[ \t]+$/gm, ''); if (!content.endsWith('\n')) content += '\n';
            const dir = lang === 'java' ? L.srcDir + '/' + pkg.replace(/\./g, '/') : L.srcDir + (lang === 'python' ? '/' + pkg0 + (sub ? '/' + sub : '') : (sub ? '/' + sub : ''));
            files.push({ path: dir + '/' + L.fileName(c) + L.ext, content, region: 'class:' + c.name });
        }
        if (lang === 'python') { files.push({ path: L.srcDir + '/' + pkg0 + '/__init__.py', content: '', region: 'package' }); if (sub) files.push({ path: L.srcDir + '/' + pkg0 + '/' + sub + '/__init__.py', content: '', region: 'package' }); }
        for (const u of model.usecases) {
            const names = Array.from(new Set(u.steps.map((s) => s.to).concat(byName[u.actor] ? [u.actor] : []))); const cname = FILTERS.pascal(u.name.replace(/[^A-Za-z0-9_ ]/g, ' ').trim() || 'UseCase');
            const imports = lang === 'python' ? names.filter((n) => byName[n]).map((n) => 'from ' + pkg0 + (sub ? '.' + sub : '') + '.' + L.fileName(byName[n]) + ' import ' + n) : (lang === 'typescript' ? names.filter((n) => byName[n]).map((n) => 'import { ' + n + ' } from "../src' + (sub ? '/' + sub : '') + '/' + n + '";') : []);
            const ctx = { name: u.name, actor: u.actor, snake: FILTERS.snake(cname) || 'use_case', camel: FILTERS.camel(cname) || 'useCase', className: cname, package: pkg, imports, steps: u.steps.map((s) => ({ from: s.from, to: s.to, msg: s.msg, args: (s.args || []).join(', ') })) };
            const fname = lang === 'python' ? 'test_' + (FILTERS.snake(cname) || 'use_case') : (lang === 'typescript' ? cname + '.test' : cname + 'Test'); const dir = lang === 'java' ? L.testDir + '/' + pkg.replace(/\./g, '/') : L.testDir;
            files.push({ path: dir + '/' + fname + L.ext, content: renderTpl(L.tpl.test, ctx).replace(/[ \t]+$/gm, ''), region: 'test:' + u.name });
        }
        files.unshift({ path: 'README.md', region: 'project', content: genReadme(model, lang, opts) }); files.push({ path: 'docs/model.uml.txt', content: toDsl(model) + '\n', region: 'project' });
        return files;
    }
    function genReadme(model, lang, opts) {
        const L = ['# ' + model.name, '', '由 UML 產生的 ' + lang + ' 程式骨架（方法本體是 stub，依使用案例的呼叫順序寫了註解）。', '', '## 類別圖', '', '```mermaid', toMermaidClass(model), '```', ''];
        if (model.usecases.length) { L.push('## 使用案例', '', '```mermaid', toMermaidUseCase(model), '```', ''); for (const u of model.usecases) { L.push('### ' + u.name, '', '```mermaid', toMermaidSequence(model, u), '```', ''); } }
        if (opts && opts.scenario) L.push('## 原始情境', '', String(opts.scenario).slice(0, 2000), '');
        return L.join('\n');
    }

    // ---------- 領域詞彙與動作（程式先讀情境，模型只處理程式不認得的）----------
    // 實測：0.6B 對「從中文情境直接寫出 JSON 設計」會改用散文回答、或把系統提示詞當成參與者。所以「讀情境」交給程式：
    //   詞彙表（中文詞 → 英文類別名稱、種類、常見屬性）＋動作表（中文動詞 → 動作名稱、會呼叫哪些類別的哪些操作），
    //   程式從「誰可以做什麼」的句型抽出參與者與使用案例，再依動作表展開呼叫順序。模型只負責「程式不認得的詞」的翻譯與屬性。
    // 詞彙表是資料，可以由使用者／離線訓練器擴充（opts.glossary：{ 中文詞: { en, kind, attrs } }）；模型翻譯出來而且通過驗證的詞，也能養回去。
    const ACTORS = { 顧客: 'Customer', 客戶: 'Customer', 使用者: 'User', 用戶: 'User', 會員: 'Member', 管理員: 'Admin', 店員: 'Clerk', 老闆: 'Owner', 老師: 'Teacher', 學生: 'Student', 醫生: 'Doctor', 醫師: 'Doctor', 病人: 'Patient', 患者: 'Patient', 讀者: 'Reader', 員工: 'Employee', 主管: 'Manager', 訪客: 'Visitor', 房客: 'Guest', 司機: 'Driver', 乘客: 'Passenger', 買家: 'Buyer', 賣家: 'Seller', 管理者: 'Admin', 系統: 'System' };
    const NOUNS = {
        書籍: ['Book', { title: 'str', author: 'str', price: 'decimal' }], 圖書: ['Book', { title: 'str', author: 'str', price: 'decimal' }], 書: ['Book', { title: 'str', author: 'str', price: 'decimal' }],
        商品: ['Product', { name: 'str', price: 'decimal', stock: 'int' }], 產品: ['Product', { name: 'str', price: 'decimal', stock: 'int' }], 購物車: ['Cart', {}], 訂單: ['Order', { status: 'str', total: 'decimal' }], 發票: ['Invoice', { number: 'str', amount: 'decimal' }], 庫存: ['Inventory', { quantity: 'int' }], 優惠券: ['Coupon', { code: 'str', discount: 'decimal' }],
        評論: ['Review', { rating: 'int', content: 'str' }], 評價: ['Review', { rating: 'int', content: 'str' }], 帳號: ['Account', { email: 'str', passwordHash: 'str' }], 帳戶: ['Account', { email: 'str', balance: 'decimal' }], 文章: ['Article', { title: 'str', content: 'str' }], 留言: ['Comment', { content: 'str' }],
        課程: ['Course', { title: 'str', credits: 'int' }], 成績: ['Grade', { score: 'float' }], 預約: ['Reservation', { time: 'datetime' }], 房間: ['Room', { number: 'str', price: 'decimal' }], 病歷: ['MedicalRecord', { diagnosis: 'str' }], 掛號: ['Appointment', { time: 'datetime' }],
        任務: ['Task', { title: 'str', done: 'bool' }], 待辦: ['Task', { title: 'str', done: 'bool' }], 專案: ['Project', { name: 'str' }], 檔案: ['File', { name: 'str', size: 'int' }], 通知: ['Notification', { message: 'str' }], 訊息: ['Message', { content: 'str' }], 地址: ['Address', { street: 'str', city: 'str' }], 報表: ['Report', { title: 'str' }], 會議: ['Meeting', { topic: 'str', time: 'datetime' }], 班表: ['Schedule', { date: 'date' }], 借閱: ['Loan', { dueDate: 'date' }],
    };
    // 動作：en＝使用案例名稱的動詞部分；steps＝依序呼叫「類別.操作」，'$obj' 是這個動作句子裡出現的名詞所對應的類別（沒有就跳過）；fixed＝固定涉及的輔助類別
    const VERBS = {
        瀏覽: { en: 'Browse', steps: [['$obj', 'list']] }, 查看: { en: 'View', steps: [['$obj', 'get']] }, 搜尋: { en: 'Search', steps: [['$obj', 'search']] }, 查詢: { en: 'Search', steps: [['$obj', 'search']] },
        加入: { en: 'AddTo', steps: [['$obj', 'add']] }, 移除: { en: 'Remove', steps: [['$obj', 'remove']] }, 刪除: { en: 'Delete', steps: [['$obj', 'delete']] }, 新增: { en: 'Create', steps: [['$obj', 'create']] }, 建立: { en: 'Create', steps: [['$obj', 'create']] },
        修改: { en: 'Update', steps: [['$obj', 'update']] }, 編輯: { en: 'Edit', steps: [['$obj', 'update']] }, 更新: { en: 'Update', steps: [['$obj', 'update']] }, 上架: { en: 'Publish', steps: [['$obj', 'publish']] }, 下架: { en: 'Unpublish', steps: [['$obj', 'unpublish']] },
        結帳: { en: 'Checkout', steps: [['Cart', 'checkout'], ['Order', 'create']] }, 下單: { en: 'PlaceOrder', steps: [['Order', 'create']] }, 付款: { en: 'Pay', steps: [['Payment', 'pay']] }, 支付: { en: 'Pay', steps: [['Payment', 'pay']] },
        取消: { en: 'Cancel', steps: [['$obj', 'cancel']] }, 登入: { en: 'Login', steps: [['AuthService', 'login']] }, 註冊: { en: 'Register', steps: [['AuthService', 'register']] }, 預約: { en: 'Reserve', steps: [['Reservation', 'create']] }, 借閱: { en: 'Borrow', steps: [['Loan', 'create']] }, 歸還: { en: 'Return', steps: [['Loan', 'close']] },
        審核: { en: 'Approve', steps: [['$obj', 'approve']] }, 核准: { en: 'Approve', steps: [['$obj', 'approve']] }, 通知: { en: 'Notify', steps: [['Notification', 'send']] }, 評論: { en: 'Review', steps: [['Review', 'create']] }, 管理: { en: 'Manage', steps: [['$obj', 'manage']] }, 統計: { en: 'Report', steps: [['Report', 'generate']] },
    };
    // 輔助類別（動作表會用到、情境沒提到名詞時自動補）：名稱 → [種類, 屬性]
    const AUX = { Payment: ['class', { amount: 'decimal', paid: 'bool' }], AuthService: ['class', {}], Order: ['class', { status: 'str', total: 'decimal' }], Cart: ['class', {}], Reservation: ['class', { time: 'datetime' }], Loan: ['class', { dueDate: 'date' }], Notification: ['class', { message: 'str' }], Report: ['class', { title: 'str' }], User: ['class', { email: 'str' }] };
    // 關係表：兩個類別都出現時加上
    const RELS = [['Cart', 'Book', 'aggregate'], ['Cart', 'Product', 'aggregate'], ['Order', 'Book', 'assoc'], ['Order', 'Product', 'assoc'], ['Order', 'Payment', 'assoc'], ['Order', 'Cart', 'assoc'], ['Review', 'Book', 'assoc'], ['Review', 'Product', 'assoc'], ['Loan', 'Book', 'assoc'], ['Reservation', 'Room', 'assoc'], ['Comment', 'Article', 'assoc'], ['Grade', 'Course', 'assoc'], ['Appointment', 'MedicalRecord', 'assoc'], ['Invoice', 'Order', 'assoc'], ['Inventory', 'Product', 'assoc'], ['Coupon', 'Order', 'assoc']];
    function longestKey(obj, text, from) { let best = null; for (const k of Object.keys(obj)) { const i = text.indexOf(k, from || 0); if (i >= 0 && (!best || i < best.i || (i === best.i && k.length > best.k.length))) best = { k, i }; } return best; }
    // 從情境抽出：參與者、使用案例（含呼叫順序）、類別（含常見屬性與由動作推出的操作）、關係；unknown＝程式不認得的詞（交給模型翻譯）
    function scenarioHints(scenario, glossary) {
        const gl = glossary || {}; const actors = Object.assign({}, ACTORS); const nouns = Object.assign({}, NOUNS);
        for (const [zh, v] of Object.entries(gl)) { if (!v || !v.en) continue; if (v.kind === 'actor') actors[zh] = v.en; else nouns[zh] = [v.en, v.attrs || {}]; }
        const text = String(scenario || ''); const clauses = text.split(/[。；;\n]+/).map((s) => s.trim()).filter(Boolean); const out = { actors: [], usecases: [], classes: [], relations: [], unknown: [] }; const classMap = new Map();
        const addClass = (name, attrs, kind) => { let c = classMap.get(name); if (!c) { c = { name, kind: kind || 'class', label: '', attrs: [], ops: [] }; classMap.set(name, c); if (!kind || kind === 'class') c.attrs.push({ name: 'id', type: 'int' }); } for (const [k, t] of Object.entries(attrs || {})) if (!c.attrs.some((a) => a.name === k)) c.attrs.push({ name: k, type: t }); return c; };
        const addOp = (cls, op, withArg) => { const c = classMap.get(cls); if (c && !c.ops.some((o) => o.name === op)) c.ops.push({ name: op, params: withArg ? [{ name: 'item', type: 'any' }] : [], returns: 'void' }); };
        let lastActor = null; const actorRe = new RegExp('(' + Object.keys(actors).sort((a, b) => b.length - a.length).join('|') + ')(?:都)?(?:可以|能夠|能|可|會|要|需要|負責|想要|想)');
        for (const clause of clauses) {
            // 一個句子可能有多個「X 可以 ...」：用逗號切段，段落沒有新的參與者就沿用上一個
            const segs = clause.split(/[，,]/).map((s) => s.trim()).filter(Boolean); let any = false;
            for (const seg of segs) {
                const am = actorRe.exec(seg); let predicate = seg;
                if (am) { lastActor = actors[am[1]]; if (!out.actors.includes(lastActor)) out.actors.push(lastActor); predicate = seg.slice(am.index + am[0].length); }
                else { const um = /^([一-鿿]{2,4})(?:可以|能夠|能|可|會|需要|想要)/.exec(seg); if (um && !nouns[um[1]] && !VERBS[um[1]]) { out.unknown.push(um[1]); continue; } }
                if (!lastActor) continue;
                for (const action of predicate.split(/[、和及並且並以及然後再還有或]/).map((s) => s.trim()).filter(Boolean)) {
                    const vs = Object.keys(VERBS).filter((v) => action.includes(v)); if (!vs.length) continue; any = true;
                    // 動作句裡的名詞：全部都加成類別；主要受詞＝第一個動詞「之後」最近的名詞（「加入購物車」→ 購物車），沒有就用句子裡第一個
                    const found = []; for (const k of Object.keys(nouns)) { const i = action.indexOf(k); if (i >= 0 && !found.some((f) => f.cls === nouns[k][0])) found.push({ k, i, cls: nouns[k][0] }); } found.sort((a, b) => a.i - b.i); found.forEach((f) => addClass(f.cls, nouns[f.k][1]));
                    const v0 = action.indexOf(vs.slice().sort((a, b) => action.indexOf(a) - action.indexOf(b))[0]); const after = found.find((f) => f.i >= v0); const nm = after || found[0] || null; const objCls = nm ? nm.cls : null;
                    // 動作句裡可能有兩個動詞（「結帳付款」）：依出現順序合成一個使用案例
                    vs.sort((a, b) => action.indexOf(a) - action.indexOf(b)); const vsFiltered = vs.filter((v, i) => !vs.some((o, j) => j !== i && o.length > v.length && o.includes(v)));
                    const steps = []; for (const v of vsFiltered) for (const [cls0, op] of VERBS[v].steps) { const cls = cls0 === '$obj' ? objCls : cls0; if (!cls) continue; if (!classMap.has(cls)) addClass(cls, (AUX[cls] || [])[1] || {}, (AUX[cls] || [])[0]); addOp(cls, op, op === 'add' || op === 'create' || op === 'remove'); if (!steps.some((s) => s.to === cls && s.op === op)) steps.push({ to: cls, op }); }
                    if (!steps.length) continue;
                    const name = vsFiltered.map((v) => VERBS[v].en).join('') + (vsFiltered.length === 1 && objCls && !/To$/.test(VERBS[vsFiltered[0]].en) ? objCls : (/To$/.test(VERBS[vsFiltered[0]].en) && objCls ? objCls : ''));
                    const uc = { name: name || 'UseCase', actor: lastActor, summary: action.slice(0, 30), steps }; if (!out.usecases.some((u) => u.name === uc.name && u.actor === uc.actor)) out.usecases.push(uc);
                }
            }
        }
        // 使用案例名稱重複時加上編號
        const seen = {}; for (const u of out.usecases) { seen[u.name] = (seen[u.name] || 0) + 1; if (seen[u.name] > 1) u.name += seen[u.name]; }
        out.classes = Array.from(classMap.values()); const names = new Set(out.classes.map((c) => c.name));
        for (const [a, b, k] of RELS) if (names.has(a) && names.has(b)) out.relations.push({ from: a, to: b, kind: k });
        // 不認得的名詞：情境裡「X」前後帶「的」「一個」的候選很難抓準，這裡只回報參與者／動作層級的未知詞
        out.unknown = Array.from(new Set(out.unknown)); return out;
    }

    // ---------- 情境 → UML（給弱模型：一次一個封閉的小問題，每個回覆都驗證）----------
    const KINDS = ['assoc', 'compose', 'aggregate', 'inherit', 'implement', 'depend'];
    const KIND_HELP = { assoc: '使用／關聯', compose: '組成（整體擁有部分，部分不能獨立存在）', aggregate: '聚合（整體包含部分，部分可獨立存在）', inherit: '繼承（是一種）', implement: '實作介面', depend: '暫時依賴' };
    function sysMsg(task, rules) { return { role: 'system', content: '你是 UML 設計助手。' + task + '只輸出一個 JSON 物件，不要多說別的。' + (rules ? rules : '') + '識別字一律用英文（類別 PascalCase、屬性與操作 camelCase），中文只放在 label／summary。不確定的欄位寧可省略，不要編造情境裡沒有的東西。' }; }
    function userMsg(scenario, extra) { return { role: 'user', content: '情境：\n' + String(scenario).slice(0, 1500) + (extra ? '\n\n' + extra : '') }; }
    const arr = (v) => (Array.isArray(v) ? v : []);
    // 每個階段回覆的開頭（先替模型寫好，它只需要接著把 JSON 寫完；小模型被要求「只輸出 JSON」時常常改用散文回答）
    const PREFILL = { actors: '{"actors":["', classes: '{"classes":[{"name":"', members: '{"attrs":[', relations: '{"relations":[', sequence: '{"steps":[{"to":"' };
    const stageSpec = {
        actors: (scenario) => ({ messages: [sysMsg('從情境找出參與者（人或外部系統）與使用案例（參與者想完成的一件事）。', '格式：{"actors":[參與者英文名稱…],"usecases":[{"name":使用案例英文名稱,"actor":參與者名稱,"summary":一句中文}…]}。參與者 1～4 個、使用案例 1～6 個。'), userMsg(scenario)], validate: (o) => { const e = []; const acts = arr(o.actors); if (!acts.length || acts.length > 4) e.push('actors 要有 1～4 個'); for (const a of acts) if (typeof a !== 'string' || !CLASS_NAME.test(a)) e.push('參與者「' + a + '」要是英文 PascalCase'); const ucs = arr(o.usecases); if (!ucs.length || ucs.length > 6) e.push('usecases 要有 1～6 個'); for (const u of ucs) { if (!u || typeof u.name !== 'string' || !CLASS_NAME.test(u.name)) e.push('使用案例名稱「' + (u && u.name) + '」要是英文 PascalCase'); else if (!acts.includes(u.actor)) e.push('使用案例 ' + u.name + ' 的 actor「' + u.actor + '」不在 actors 裡'); } return e; } }),
        classes: (scenario, ctx) => ({ messages: [sysMsg('找出系統需要的類別（領域物件、服務、介面、列舉）。', '格式：{"classes":[{"name":類別英文名稱,"kind":"class" 或 "interface" 或 "enum","label":中文名稱}…]}。類別 2～10 個；參與者可以是類別（例如使用者）也可以不是；不要重複，不要把使用案例當成類別。'), userMsg(scenario, '參與者：' + ctx.actors.join('、') + '\n使用案例：' + ctx.usecases.map((u) => u.name + '（' + (u.summary || '') + '）').join('；'))], validate: (o) => { const e = []; const cs = arr(o.classes); if (cs.length < 2 || cs.length > 10) e.push('classes 要有 2～10 個'); const seen = new Set(); for (const c of cs) { if (!c || typeof c.name !== 'string' || !CLASS_NAME.test(c.name)) e.push('類別名稱「' + (c && c.name) + '」要是英文 PascalCase'); else if (seen.has(c.name)) e.push('類別重複：' + c.name); else seen.add(c.name); if (c && !['class', 'interface', 'enum'].includes(c.kind)) e.push('類別 ' + (c && c.name) + ' 的 kind 只能是 class／interface／enum'); } return e; } }),
        members: (scenario, ctx) => ({ messages: [sysMsg('替類別「' + ctx.cls.name + '」（' + (ctx.cls.label || '') + '）列出屬性與操作。', '格式：{"attrs":[{"name":屬性名稱,"type":型別}…],"ops":[{"name":操作名稱,"params":[{"name":參數名稱,"type":型別}…],"returns":回傳型別}…]}。屬性最多 6 個、操作最多 6 個。型別只能用：' + PRIMS.filter((p) => p !== 'void').join('、') + '、List<型別>、Optional<型別>、或這些已知類別：' + ctx.classNames.join('、') + '。沒有回傳值的操作 returns 填 void。' + (ctx.cls.kind === 'enum' ? '這是列舉：只要 {"values":[值…]}（大寫英文 2～8 個）。' : '') + (ctx.cls.kind === 'interface' ? '這是介面：只要 ops，不要 attrs。' : '')), userMsg(scenario, '這個類別會被使用案例用到：' + (ctx.usedBy || '（未知）'))], validate: (o) => { const e = []; if (ctx.cls.kind === 'enum') { const v = arr(o.values); if (v.length < 2 || v.length > 8 || v.some((x) => typeof x !== 'string' || !/^[A-Z][A-Z0-9_]*$/.test(x))) e.push('values 要有 2～8 個大寫英文值'); return e; } const known = new Set(ctx.classNames); const chkType = (t, where) => { const pt = parseType(t); if (!pt) return where + ' 的型別「' + t + '」格式不對'; for (const ref of typeRefs(pt)) if (!known.has(ref)) return where + ' 的型別「' + ref + '」不是基本型別也不是已知類別'; return null; }; const as = arr(o.attrs); if (as.length > 6) e.push('attrs 最多 6 個'); const seen = new Set(); for (const a of as) { if (!a || typeof a.name !== 'string' || !MEMBER_NAME.test(a.name)) { e.push('屬性名稱「' + (a && a.name) + '」要是英文 camelCase'); continue; } if (seen.has(a.name)) e.push('屬性重複：' + a.name); seen.add(a.name); const te = chkType(a.type, '屬性 ' + a.name); if (te) e.push(te); } const os = arr(o.ops); if (os.length > 6) e.push('ops 最多 6 個'); const so = new Set(); for (const p of os) { if (!p || typeof p.name !== 'string' || !MEMBER_NAME.test(p.name)) { e.push('操作名稱「' + (p && p.name) + '」要是英文 camelCase'); continue; } if (so.has(p.name)) e.push('操作重複：' + p.name); so.add(p.name); for (const pr of arr(p.params)) { if (!pr || !MEMBER_NAME.test(String(pr.name))) e.push('操作 ' + p.name + ' 的參數名稱不合法'); else { const te = chkType(pr.type, '操作 ' + p.name + ' 的參數 ' + pr.name); if (te) e.push(te); } } if (p.returns != null && p.returns !== 'void') { const te = chkType(p.returns, '操作 ' + p.name + ' 的回傳'); if (te) e.push(te); } } return e; } }),
        relations: (scenario, ctx) => ({ messages: [sysMsg('列出類別「' + ctx.cls.name + '」跟其他類別的關係。', '格式：{"relations":[{"to":對方類別名稱,"kind":關係種類}…]}。關係種類只能是：' + KINDS.map((k) => k + '（' + KIND_HELP[k] + '）').join('；') + '。對方只能是：' + ctx.others.join('、') + '。沒有關係就回 {"relations":[]}。最多 4 個。'), userMsg(scenario)], validate: (o) => { const e = []; const rs = arr(o.relations); if (rs.length > 4) e.push('relations 最多 4 個'); for (const r of rs) { if (!r || !ctx.others.includes(r.to)) e.push('關係的對方「' + (r && r.to) + '」只能是：' + ctx.others.join('、')); else if (!KINDS.includes(r.kind)) e.push('關係種類「' + r.kind + '」只能是：' + KINDS.join('、')); else if (r.kind === 'implement' && ctx.kinds[r.to] !== 'interface') e.push(r.to + ' 不是 interface，不能 implement'); else if (r.kind === 'inherit' && ctx.kinds[r.to] === 'interface') e.push(r.to + ' 是 interface，要用 implement'); } return e; } }),
        sequence: (scenario, ctx) => ({ messages: [sysMsg('列出使用案例「' + ctx.uc.name + '」（參與者 ' + ctx.uc.actor + '：' + (ctx.uc.summary || '') + '）的呼叫順序：從參與者開始，依序呼叫哪些類別的哪個操作。', '格式：{"steps":[{"to":類別名稱,"op":操作名稱}…]}，2～8 步。類別與可用的操作：' + ctx.menu + '。只能用這些操作；如果真的需要一個沒列出的操作，op 填一個英文 camelCase 新名稱。'), userMsg(scenario)], validate: (o) => { const e = []; const ss = arr(o.steps); if (ss.length < 1 || ss.length > 8) e.push('steps 要有 1～8 步'); for (const s of ss) { if (!s || !ctx.ops[s.to]) e.push('呼叫的類別「' + (s && s.to) + '」只能是：' + Object.keys(ctx.ops).join('、')); else if (typeof s.op !== 'string' || !MEMBER_NAME.test(s.op)) e.push('操作名稱「' + (s && s.op) + '」要是英文 camelCase'); } return e; } }),
    };
    // 整條管線。opts: { generate({messages,maxTokens})→string, onStage(e), maxTries }
    // 回傳 { ok, model, dsl, decisions:[{stage,by,tries,rejected}], warnings:[…] }；任何一個階段模型連續失敗，該階段退回「程式的保守預設」並記在 warnings，不會整條掛掉
    async function scenarioToModel(scenario, opts) {
        const decisions = []; const warnings = []; const model = emptyModel(); const emit = (e) => { if (opts.onStage) try { opts.onStage(e); } catch (_) {} };
        // ⓪ 程式先讀情境（詞彙表＋動作表）：讀得出參與者、使用案例、至少一個類別，整份設計就由程式決定（模型 0 次呼叫）；讀不出才走下面一次一個小問題的模型階段
        if (opts.program !== false) { const h = scenarioHints(scenario, opts.glossary); if (h.actors.length && h.usecases.length && h.classes.length >= 1) {
            model.name = String(scenario || '').split(/[：:。\n]/)[0].replace(/^(?:請|幫我)?(?:設計|做|建立|產生)(?:一個|一套)?/, '').trim().slice(0, 24) || model.name; model.actors = h.actors.slice(); model.usecases = h.usecases.map((u) => ({ name: u.name, actor: u.actor, summary: u.summary, steps: [] })); model.classes = h.classes.map((c) => ({ name: c.name, kind: c.kind, label: c.label, attrs: c.attrs.map((a) => ({ name: a.name, type: parseType(a.type), visibility: '+' })), ops: c.ops.map((o) => ({ name: o.name, params: o.params.map((p) => ({ name: p.name, type: parseType(p.type) })), returns: parseType(o.returns), visibility: '+', static: false })), values: [] })); model.relations = h.relations.slice();
            h.usecases.forEach((u, i) => { let prev = u.actor; for (const s of u.steps) { model.usecases[i].steps.push({ from: prev, to: s.to, msg: s.op, args: [], returns: '' }); prev = s.to; } });
            decisions.push({ stage: 'hints', by: 'program', ok: true, actors: h.actors.length, usecases: h.usecases.length, classes: h.classes.length }); emit({ type: 'stage', stage: 'hints', ok: true });
            if (h.unknown.length) warnings.push('情境裡有程式不認得的參與者：' + h.unknown.join('、') + '（可以用詞彙表補上）');
            ensureOps(model); let errs0 = validateModel(model); if (errs0.length) warnings.push('驗證有 ' + errs0.length + ' 個問題：' + errs0.slice(0, 3).join('；'));
            return { ok: true, model, dsl: toDsl(model), decisions, warnings, errors: errs0, fromHints: true }; } }
        const ask = async (stage, spec, label) => { const r = await R.jsonStep({ generate: opts.generate, messages: spec.messages, validate: spec.validate, maxTries: opts.maxTries || 2, maxTokens: 400, prefill: PREFILL[stage] }); decisions.push({ stage, label, by: 'model', tries: r.tries, rejected: r.rejected, ok: r.ok }); emit({ type: 'stage', stage, label, ok: r.ok }); if (!r.ok) warnings.push(stage + (label ? '（' + label + '）' : '') + ' 模型沒給出合格的回覆：' + (r.error || '')); return r.ok ? r.value : null; };
        // ① 參與者與使用案例
        const a1 = await ask('actors', stageSpec.actors(scenario)); if (!a1) return { ok: false, model, dsl: '', decisions, warnings, error: '找不到參與者與使用案例' };
        model.actors = a1.actors.slice(); model.usecases = a1.usecases.map((u) => ({ name: u.name, actor: u.actor, summary: u.summary || '', steps: [] }));
        // ② 類別
        const a2 = await ask('classes', stageSpec.classes(scenario, { actors: model.actors, usecases: model.usecases })); if (!a2) return { ok: false, model, dsl: '', decisions, warnings, error: '找不到類別' };
        model.classes = a2.classes.map((c) => ({ name: c.name, kind: c.kind, label: c.label || '', attrs: [], ops: [], values: [] }));
        const names = model.classes.map((c) => c.name); const kinds = Object.fromEntries(model.classes.map((c) => [c.name, c.kind]));
        // ③ 每個類別的成員（一次一個類別，沒有前面類別的記憶，只給已知類別名稱）
        for (const c of model.classes) {
            const used = model.usecases.map((u) => u.name).join('、'); const r = await ask('members', stageSpec.members(scenario, { cls: c, classNames: names, usedBy: used }), c.name);
            if (!r) continue; if (c.kind === 'enum') { c.values = r.values.slice(); continue; }
            for (const a of arr(r.attrs)) c.attrs.push({ name: a.name, type: parseType(a.type), visibility: '+' });
            for (const o of arr(r.ops)) c.ops.push({ name: o.name, params: arr(o.params).map((p) => ({ name: p.name, type: parseType(p.type) })), returns: o.returns && o.returns !== 'void' ? parseType(o.returns) : { base: 'void', args: [] }, visibility: '+', static: false });
            if (c.kind === 'interface') c.attrs = [];
        }
        // ④ 每個類別的關係
        for (const c of model.classes) {
            const others = names.filter((n) => n !== c.name); if (!others.length) continue; const r = await ask('relations', stageSpec.relations(scenario, { cls: c, others, kinds }), c.name); if (!r) continue;
            for (const x of arr(r.relations)) if (!model.relations.some((y) => y.from === c.name && y.to === x.to && y.kind === x.kind)) model.relations.push({ from: c.name, to: x.to, kind: x.kind });
        }
        // ⑤ 每個使用案例的呼叫順序（選單：類別與它真的有的操作）
        const ops = Object.fromEntries(model.classes.filter((c) => c.kind !== 'enum').map((c) => [c.name, c.ops.map((o) => o.name)])); const menu = Object.entries(ops).map(([k, v]) => k + '（' + (v.length ? v.join('、') : '還沒有操作') + '）').join('；');
        for (const u of model.usecases) {
            const r = await ask('sequence', stageSpec.sequence(scenario, { uc: u, ops, menu }), u.name); if (!r) continue; let prev = u.actor;
            for (const s of arr(r.steps)) { u.steps.push({ from: prev, to: s.to, msg: s.op, args: [], returns: '' }); prev = s.to; }
        }
        const added = ensureOps(model); if (added.length) warnings.push('使用案例呼叫了還沒有的操作，已自動補進類別：' + added.join('、'));
        // 整體驗證；把不合法的關係／步驟拿掉（不要讓一個壞回覆毀掉整份模型）
        let errs = validateModel(model); if (errs.length) { const names2 = new Set(names); model.relations = model.relations.filter((r) => names2.has(r.from) && names2.has(r.to) && !(r.kind === 'implement' && kinds[r.to] !== 'interface')); errs = validateModel(model); if (errs.length) warnings.push('驗證仍有 ' + errs.length + ' 個問題：' + errs.slice(0, 3).join('；')); }
        const dsl = toDsl(model); decisions.push({ stage: 'assemble', by: 'program', ok: true }); emit({ type: 'done' });
        return { ok: true, model, dsl, decisions, warnings, errors: errs };
    }

    return { ACTORS, NOUNS, VERBS, scenarioHints, PREFILL, CLASS_NAME, MEMBER_NAME, PRIMS, KINDS, LANGS, parseType, typeToString, typeRefs, parseDsl, toDsl, validateModel, ensureOps, toMermaidClass, toMermaidSequence, toMermaidUseCase, toPlantUml, renderTpl, FILTERS, langType, genFiles, genReadme, scenarioToModel, stageSpec, emptyModel };
});
