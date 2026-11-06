/* Python 區塊的「庫存與範本」規則：每一步能放什麼區塊，由程式從目前的狀態算出來，模型只在合法的選單裡選。純函式 UMD，Python 專屬。
 *
 * 狀態（state）：
 *   vars     已宣告的變數 名稱 → 型別（int float num str list dict set range cond any）；參數一開始就在裡面
 *   imports  已引入的模組名稱（math、np、plt、statistics、random、integrate、deque、heapq、bisect）
 *   frames   目前開著的區塊（最外層是函式本身）：{kind: func|for|while|forever|if|else, header, count, writes, condVars, hasBreak, terminal}
 *   hasReturn  這個函式裡有沒有 return 值
 *
 * 規則（使用者的要求）：
 *   什麼都沒宣告 → 只能宣告（輸入、資料的初始化、引入模組）或 return
 *   while 要有終止條件：用 while_counter／for_counter 這類範本（遞增在範本裡），或 while_do 結束前檢查「迴圈裡有改到條件用到的變數，或有 break」；while True 一定要有 break
 *   for 要有初始化、條件、遞增（for_counter），或「重複 n 次、用 i 計數」（for_range）；迴圈變數一定是新的名稱
 *   break／continue 只能在迴圈裡；return／break／continue 後同一層不能再放區塊（只能結束區塊）
 *   用到變數的槽位（更新、集合操作…）要有型別相容的已宣告變數才會出現；模組函式要先引入模組
 *   輔助函式（不是 main）一定要 return 值；空的區塊不能結束
 *
 *   makeRules(B) → R
 *   R.initState(op) → state
 *   R.legal(state) → {templates:[tpl], cats:[類別], canEnd, endWhy, canDone, doneWhy, ifOptions:{if, elif, else}}
 *   R.slotPlan(tpl) → [{slot, mode:'decl'|'var'|'expr', type, tuple?}]
 *   R.exprMenu(type, state) → {vars:[{name,type}], num:bool, str:bool, cats:[{id, blocks:[expr]}]}
 *   R.compat(slotType, valType) → boolean
 *   R.apply(state, {tpl|special, slots:{名稱:{ir,type}}, ir}) → 更新 state
 *   R.canEnd(state) → {ok, why} */
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(); else root.FaPyBlocksRules = factory(); })(typeof self !== 'undefined' ? self : this, function () {
    'use strict';
    const ECAT_ORDER = ['算術', '比較', '邏輯', '取值', '函式', '方法', '組合', '科學·數學', '科學·數值', '科學·統計', '科學·亂數', '科學·微積分', '科學·集合'];
    const ITER = new Set(['list', 'str', 'dict', 'set', 'range', 'iter']);
    function compat(slot, val) {
        if (!slot || slot === 'any' || !val || val === 'any') return true;
        switch (slot) {
            case 'num': return val === 'int' || val === 'float' || val === 'num';
            case 'int': return val === 'int' || val === 'num';
            case 'float': return val === 'float' || val === 'num' || val === 'int';
            case 'str': return val === 'str';
            case 'list': return val === 'list';
            case 'dict': return val === 'dict';
            case 'set': return val === 'set';
            case 'iter': return ITER.has(val);
            case 'cond': return val === 'cond' || val === 'bool';
            default: return slot === val;
        }
    }
    const LOOPS = new Set(['for', 'while', 'forever']);
    // 從敘述 IR 找「被寫到的名稱」（指派目標、複合指派目標、for 目標、對名稱呼叫方法）
    function writesOf(list, out) {
        out = out || new Set(); const target = (e) => { if (!e) return; if (e.n === 'name') out.add(e.v); else if (e.n === 'tuple' || e.n === 'list') (e.xs || []).forEach(target); else if (e.n === 'idx' || e.n === 'attr') { let b = e; while (b && (b.n === 'idx' || b.n === 'attr')) b = b.o; if (b && b.n === 'name') out.add(b.v); } else if (e.n === 'star') target(e.e); };
        const callTarget = (e) => { if (!e || typeof e !== 'object') return; if (Array.isArray(e)) return e.forEach(callTarget); if (e.n === 'call' && e.f && e.f.n === 'attr' && e.f.o && e.f.o.n === 'name') out.add(e.f.o.v); for (const k of Object.keys(e)) if (e[k] && typeof e[k] === 'object') callTarget(e[k]); };
        for (const s of list || []) { if (s.k === 'assign') (s.ts || [s.t]).forEach(target); else if (s.k === 'aug') target(s.t); else if (s.k === 'for') target(s.t); else if (s.k === 'expr') callTarget(s.e); writesOf(s.a, out); writesOf(s.b, out); }
        return out;
    }
    function makeRules(B) {
        const L = B.LIB; const TYPES = L.TYPES || {}, ETYPES = L.ETYPES || {}, REQ = L.REQ || {}, IMPORTS = L.IMPORTS || {};
        const tinfo = (id) => TYPES[id] || {};
        const isVarUse = (t) => typeof t === 'string' && t.startsWith('v:');
        function initState(op, o) { const vars = new Map(); for (const p of op.params || []) vars.set(p, (op.paramTypes && op.paramTypes[p]) || 'any'); return { op, zone: (o && o.zone) || 'import', vars, imports: new Set(), frames: [{ kind: 'func', header: 'def ' + op.name, count: 0, writes: new Set(), terminal: false }], hasReturn: false }; }
        const top = (st) => st.frames[st.frames.length - 1];
        const needsReturn = (st) => st.op.name !== 'main' && st.op.returns !== 'void'; // 有回傳型別的輔助函式一定要 return 值；main／void 的操作（例如 solve）不用
        const inLoop = (st) => st.frames.some((f) => LOOPS.has(f.kind));
        const varsOf = (st, type) => [...st.vars].filter(([n, t]) => compat(type, t)).map(([name, t]) => ({ name, type: t }));
        const declOnly = (t) => { if (t.cat !== '輸入' && t.cat !== '資料') return false; const ti = tinfo(t.id); const dk = Object.keys(ti.decl || {}); if (!dk.length || t.bodies.length) return false; return !Object.values(ti.use || {}).some(isVarUse); };

        function legal(st) {
            const f = top(st); const empty = st.vars.size === 0; const res = { templates: [], cats: [], canEnd: false, endWhy: '', canDone: false, doneWhy: '', ifOptions: { if: false, elif: false, else: false } };
            const e = R.canEnd(st); res.canEnd = e.ok; res.endWhy = e.why;
            const d = R.canDone(st); res.canDone = d.ok; res.doneWhy = d.why;
            const zone = st.frames.length > 1 ? 'logic' : st.zone; res.zone = zone; res.zoneNext = []; // 區只能往後走：引入區 → 宣告區 → 邏輯與流程區
            if (st.frames.length === 1) { if (zone === 'import') res.zoneNext.push('declare', 'logic'); else if (zone === 'declare') res.zoneNext.push('logic'); }
            if (f.terminal) return res; // return／break／continue 之後，這一層只能結束
            for (const t of B.TEMPLATES) {
                const ti = tinfo(t.id);
                if (zone === 'import' && t.cat !== '引入') continue; if (zone !== 'import' && t.cat === '引入') continue;
                if (zone === 'declare' && !(t.cat === '輸入' || t.cat === '資料')) continue;
                if (REQ[t.id] && !st.imports.has(REQ[t.id])) continue;
                if (empty && zone === 'logic' && !(declOnly(t) || t.id.startsWith('return_') || t.cat === '引入')) continue;
                if (t.id === 'break_loop' || t.id === 'continue_loop') { if (!inLoop(st)) continue; }
                if (t.id === 'return_none' && needsReturn(st) && !st.hasReturn) continue;
                if (t.id === 'return_value' && false) continue;
                const uses = ti.use || {}; let ok = true;
                for (const [slot, ty] of Object.entries(uses)) if (isVarUse(ty) && !varsOf(st, ty.slice(2)).length) { ok = false; break; }
                if (!ok) continue;
                if (t.id === 'while_do' || t.id === 'while_counter' || t.id === 'while_countdown') { if (st.vars.size === 0) continue; }
                if ((t.id === 'for_items') && !varsOf(st, 'dict').length) continue;
                res.templates.push(t);
            }
            const cats = new Set(res.templates.map((t) => t.cat)); // 條件：宣告過變數才有意義
            res.ifOptions = zone !== 'logic' ? { if: false, elif: false, else: false } : { if: !empty, elif: !!(f.sibOK && f.sibOK === 'if'), else: !!(f.sibOK && f.sibOK === 'if') };
            res.cats = [...cats]; if (res.ifOptions.if || res.ifOptions.elif || res.ifOptions.else) res.cats.push('條件');
            return res;
        }
        function canEnd(st) {
            if (st.frames.length < 2) return { ok: false, why: '最外層不能用「結束區塊」，要用「函式寫完」' };
            const f = top(st); if (!f.count) return { ok: false, why: '區塊是空的，至少要放一個區塊' };
            if (f.kind === 'while') { const hit = [...(f.condVars || [])].some((n) => f.writes.has(n)); if (!hit && !f.hasBreak) return { ok: false, why: 'while 要有終止條件：迴圈裡要改變條件用到的變數（' + [...(f.condVars || [])].join('、') + '）或 break' }; }
            if (f.kind === 'forever' && !f.hasBreak) return { ok: false, why: '一直重複的迴圈裡一定要有「跳出迴圈」' };
            return { ok: true, why: '' };
        }
        function canDone(st) {
            if (st.frames.length > 1) return { ok: false, why: '還有沒結束的區塊' };
            const f = top(st); if (!f.count) return { ok: false, why: '函式還沒有任何區塊' };
            if (needsReturn(st) && !st.hasReturn) return { ok: false, why: '輔助函式一定要回傳值' };
            return { ok: true, why: '' };
        }
        function slotPlan(t) {
            const ti = tinfo(t.id); const plan = [];
            for (const slot of Object.keys(t.slots)) {
                const decl = (ti.decl || {})[slot]; const use = (ti.use || {})[slot];
                if (decl) plan.push({ slot, mode: 'decl', type: decl, tuple: decl === 'int*', reassign: t.id === 'assign' });
                else if (isVarUse(use)) plan.push({ slot, mode: 'var', type: use.slice(2) });
                else if (t.slots[slot] === 'name') plan.push({ slot, mode: 'decl', type: 'any' });
                else plan.push({ slot, mode: 'expr', type: use || 'any' });
            }
            return plan;
        }
        function exprMenu(type, st) {
            const menu = { vars: varsOf(st, type), num: ['int', 'num', 'float', 'any'].includes(type), str: ['str', 'any'].includes(type), cats: [] };
            if (type === 'cond') { menu.num = false; menu.str = false; menu.vars = menu.vars.filter((v) => v.type === 'cond' || v.type === 'bool'); }
            for (const cid of ECAT_ORDER) {
                const blocks = B.EXPRS.filter((x) => x.cat === cid).filter((x) => { const et = ETYPES[x.id]; if (REQ[x.id] && !st.imports.has(REQ[x.id])) return false; if (type === 'cond') return !!et && (et.ret === 'cond' || et.ret === 'bool'); return !et || compat(type, et.ret); });
                if (blocks.length) menu.cats.push({ id: cid, blocks });
            }
            return menu;
        }
        const exprRet = (id) => (ETYPES[id] ? ETYPES[id].ret : 'any');
        const exprParamType = (id, slot) => ((ETYPES[id] && ETYPES[id].p) || {})[slot] || 'any';
        // 套用一個區塊到狀態
        function apply(st, b) {
            const f = top(st); const ti = b.tpl ? tinfo(b.tpl.id) : {}; const ir = b.ir || [];
            const writes = writesOf(ir); const isHeader = !!b.header;
            if (b.tpl && IMPORTS[b.tpl.id]) st.imports.add(IMPORTS[b.tpl.id]);
            if (b.tpl) for (const [slot, ty] of Object.entries(ti.decl || {})) {
                const s = b.slots && b.slots[slot]; if (!s) continue; const names = s.ir.n === 'tuple' ? s.ir.xs.map((x) => x.v) : [s.ir.v];
                let vt = ty; if (ty === 'int*') vt = 'int'; else if (typeof ty === 'string' && ty.startsWith('elem')) { const src = b.slots[ty.split(':')[1] || 'it']; const st0 = src && src.type; vt = st0 === 'str' ? 'str' : st0 === 'range' ? 'int' : 'any'; } else if (b.tpl.id === 'assign') vt = (b.slots.e && b.slots.e.type) || 'any';
                for (const n of names) { if (n && n !== '_') { st.vars.set(n, vt); writes.add(n); } }
            }
            for (const fr of st.frames) for (const n of writes) fr.writes.add(n);
            if (b.special === 'break' || (b.tpl && b.tpl.id === 'break_loop')) { for (let i = st.frames.length - 1; i >= 0; i--) if (LOOPS.has(st.frames[i].kind)) { st.frames[i].hasBreak = true; break; } }
            if (b.tpl && b.tpl.id === 'return_value') st.hasReturn = true;
            f.count++; f.sibOK = null;
            if (b.tpl && (b.tpl.id.startsWith('return_') || b.tpl.id === 'break_loop' || b.tpl.id === 'continue_loop')) f.terminal = true;
            if (isHeader) {
                let kind = 'for'; if (b.special === 'if' || b.special === 'elif') kind = 'if'; else if (b.special === 'else') kind = 'else'; else if (b.tpl && b.tpl.id === 'while_do') kind = 'while'; else if (b.tpl && b.tpl.id === 'while_forever') kind = 'forever';
                const fr = { kind, header: b.line, count: 0, writes: new Set(), terminal: false, hasBreak: false };
                if (kind === 'while') { const cs = b.slots && b.slots.c && b.slots.c.ir; fr.condVars = new Set(); const walk = (e) => { if (!e || typeof e !== 'object') return; if (Array.isArray(e)) return e.forEach(walk); if (e.n === 'name') fr.condVars.add(e.v); for (const k of Object.keys(e)) if (e[k] && typeof e[k] === 'object') walk(e[k]); }; walk(cs); }
                st.frames.push(fr);
            }
        }
        function endBlock(st) { const c = st.frames.pop(); const f = top(st); f.sibOK = c.kind === 'if' ? 'if' : (c.kind === 'else' ? null : null); return c; }
        function advanceZone(st, to) { const order = ['import', 'declare', 'logic']; if (order.indexOf(to) <= order.indexOf(st.zone)) return false; st.zone = to; return true; }
        const R = { advanceZone, initState, legal, canEnd, canDone, slotPlan, exprMenu, compat, apply, endBlock, writesOf, exprRet, exprParamType, tinfo, varsOf, top };
        return R;
    }
    return { makeRules, compat, writesOf };
});
