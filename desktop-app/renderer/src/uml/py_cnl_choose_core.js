/* Python：UML 任務切割 → 骨架 → 區塊迴圈（庫存過濾＋嚴格範本）→ 模型只做微選擇 → 沙盒驗證 ⇄ 錯誤回饋。純函式 UMD，Python 專屬。
 *
 *   UML 任務切割     操作（函式）清單來自 UML 模型（uml_design／code→UML／預設只有 main）
 *   程式骨架         由 UML 模型 codegen 產生（每個操作先是空殼），區塊迴圈把 body 填進去
 *   區塊迴圈         ① 程式算出目前的符號表（庫存）② 用庫存過濾合法的類別與範本 ③ 套嚴格範本（for／while 的初始化、條件、遞增，break 只在迴圈裡…）
 *                    ④ 模型只在合法的選單裡選：類別 → 範本 → 每個槽位（名稱、變數、運算式積木，全部都是選擇題）；只有一個選項就不問模型
 *   沙盒驗證與回饋   組好的程式交給判題器（編譯＋執行範例）；沒過就把「判決與差異」連同上一版的區塊回饋，重寫（有輪數上限）
 * 選擇題只比較選項字母的機率（pick），正序倒序各問一次抵銷位置偏誤。
 *
 *   writeBlocks({op, ops, problem, plan, feedback, pick, B, R, namesOf, builtins}) → {ok, cnl, lines, steps, forced, trace, reason}
 *   writeProgramChoose({problem, umlOps?, pick, B, R, FaPyBody, C2U, judge?, rounds?}) → {ok, source, model, cnl, rounds:[...], ...}
 * pick(messages, labels[]) → Promise<{logprobs[]}>；judge(source) → Promise<{verdict, detail}> */
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(); else root.FaPyCnlChoose = factory(); })(typeof self !== 'undefined' ? self : this, function () {
    'use strict';
    const LET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'.split('');
    const CAT_DESC = { 輸入: '輸入（讀取標準輸入的資料）', 輸出: '輸出（印出結果）', 資料: '資料（建立變數、轉換、計算出新的值）', 更新: '更新（改變已有變數的值、計數）', 集合: '集合（清單、集合的加入、刪除、排序）', 迴圈: '迴圈（重複做）', 流程: '流程（回傳、跳出、略過）', 演算法: '演算法（成套的演算法片段：二分搜尋、篩法、前綴和…）', 條件: '條件（如果／否則如果／否則）', 引入: '引入（引入函式庫，之後才能用它的函式）', 繪圖: '繪圖（matplotlib 畫圖）', 科學: '科學（亂數、種子）' };
    const CAT_ORDER = ['輸入', '資料', '引入', '更新', '集合', '條件', '迴圈', '輸出', '繪圖', '科學', '演算法', '流程'];
    const ECAT_DESC = { 算術: '算術（加減乘除餘）', 比較: '比較（等於、大於、在裡面…）', 邏輯: '邏輯（而且、或者、不是、條件式）', 取值: '取值（第幾個、切片、反轉）', 函式: '函式（長度、轉整數、總和、最大值…）', 方法: '方法（切單字、去空白、字典取值、連接…）', 組合: '組合（二元組、清單、空清單、空字典）', '科學·數學': '科學：數學（開根號、三角函數、對數…）', '科學·數值': '科學：numpy 陣列與線性代數', '科學·統計': '科學：統計（平均、中位數、標準差）', '科學·亂數': '科學：亂數', '科學·微積分': '科學：定積分', '科學·集合': '集合：佇列、計數器、二分位置' };
    const KW = new Set('False None True and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield'.split(' '));
    const POOL = ['n', 'm', 'a', 'b', 's', 'x', 'y', 'i', 'j', 'k', 't', 'c', 'd', 'l', 'r', 'p', 'q', 'u', 'v', 'w', 'res', 'ans', 'cnt', 'total', 'lst', 'dp', 'ws'];
    const PAIRS = ['a, b', 'n, m', 'n, k', 'l, r', 'x, y', 'i, j', 'n, t', 'a, b, c'];
    const SPLIT = /\{(\w+)(?::(\w+))?\}/g;
    const gloss = (t) => t.line.replace(SPLIT, '〔$1〕');
    const render = (lines) => lines.map((l) => '  '.repeat(l.d) + l.t).join('\n');
    const ZONE_NAME = { import: '引入區', declare: '宣告區', logic: '邏輯與流程區' };
    // 給模型看的樣子：函式 body 固定三區，依序是 引入區 → 宣告區 → 邏輯與流程區
    const renderZ = (lines, zone) => { const out = []; let cur = null; for (const l of lines) { if (l.z !== cur) { cur = l.z; out.push('【' + ZONE_NAME[cur] + '】'); } out.push('  '.repeat(l.d) + l.t); } if (zone !== cur) out.push('【' + ZONE_NAME[zone] + '】（現在在這一區）'); return out.join('\n'); };
    const byZone = (lines) => { const z = { import: [], declare: [], logic: [] }; for (const l of lines) z[l.z].push(l); return { import: render(z.import), declare: render(z.declare), logic: render(z.logic) }; };
    const uniq = (xs) => { const o = []; for (const x of xs) if (!o.includes(x)) o.push(x); return o; };

    async function writeBlocks(o) {
        const B = o.B, R = o.R, maxStmts = o.maxStmts || 40, maxLineTry = o.maxLineTry || 3, exprDepth = o.exprDepth || 3;
        const st = R.initState(o.op); const lines = []; const trace = []; let steps = 0, forced = 0, retries = 0, lastText = ''; const sizes = []; const hk = (f, a, b) => { const h = o.oracleHooks; if (h && h[f]) h[f](a, b); };
        const builtins = o.builtins || new Set(); const log = (r) => { trace.push(r); if (o.onTrace) o.onTrace(r); };
        const stmt = String(o.problem.statement || ''); const nums = uniq((stmt.match(/-?\d+(?:\.\d+)?/g) || []).concat(['0', '1', '2'])).slice(0, 10);
        const strs = uniq(((stmt.match(/\b[A-Z]{2,}\b/g) || []).concat((stmt.match(/["'「」]([^"'「」\n]{1,12})["'「」]/g) || []).map((x) => x.replace(/^["'「」]|["'「」]$/g, '')))).concat(['', ' '])).slice(0, 8);
        const stmtNames = uniq((stmt.match(/\b[a-zA-Z]\w{0,5}\b/g) || []).filter((w) => !KW.has(w) && /^[a-z]/.test(w) && w.length <= 5));
        const fresh = (k) => uniq([...stmtNames.slice(0, 8), ...POOL]).filter((n) => !st.vars.has(n)).slice(0, k || 4); // 新名稱的選單最多 4 個（名稱本身不影響對錯）
        const inv = () => [...st.vars].map(([n, t]) => n + ':' + t).join('、');
        const head = (extra) => '題目：' + stmt.slice(0, 700) + (o.plan ? '\n解題步驟：\n' + o.plan : '') + (o.feedback ? '\n\n' + o.feedback : '') + '\n\n目前宣告的變數（庫存）：' + (inv() || '（沒有）') + (st.imports.size ? '\n已引入：' + [...st.imports].join('、') : '') + '\n目前已寫好的區塊（函式固定分三區：引入區、宣告區、邏輯與流程區，只能往後走）：\n' + renderZ(lines, st.zone) + (extra ? '\n\n' + extra : '');
        const SYS = '你是 Python 程式設計助手。我們用「區塊」一步一步寫程式，每一步只能在給你的選項裡選，你只回答選項前面的字母。';
        // 選擇題：只有一個選項不問；否則正序＋倒序各一次，機率相加
        async function choose(question, items, kind, metas) {
            const n = Math.min(items.length, LET.length); sizes.push({ kind, n, items: o.keepItems ? items.slice(0, n) : undefined });
            if (o.oracle) { const k = o.oracle({ kind, metas: metas || [], items }); if (n === 1) forced++; else steps++; return Math.max(0, Math.min(k, n - 1)); }
            if (n === 1) { forced++; return 0; } steps++;
            const id = Array.from({ length: n }, (_, i) => i); const orders = o.noDebias ? [id] : [id, id.slice().reverse()]; const sum = new Array(n).fill(0);
            for (const ord of orders) { const body = ord.map((j, i) => LET[i] + '. ' + items[j]).join('\n'); const r = await o.pick([{ role: 'system', content: SYS }, { role: 'user', content: question + '\n' + body + '\n只回答選項的字母。' }], LET.slice(0, n)); r.logprobs.forEach((lp, pos) => { sum[ord[pos]] += lp; }); }
            let k = 0; for (let i = 1; i < n; i++) if (sum[i] > sum[k]) k = i; log({ t: 'choose', kind, pick: items[k].slice(0, 40), n }); return k;
        }
        // ---- 槽位 ----
        async function pickDecl(p, tplText) {
            if (p.tuple) { const cand = uniq([stmtNames.slice(0, 2).join(', '), ...PAIRS]).filter((c) => c.split(', ').every((x) => x && !st.vars.has(x))); const k = await choose(head('區塊「' + tplText + '」要同時宣告幾個新的變數名稱，選哪一組？'), cand.map((c) => c + '（新的名稱）'), 'name', cand.map((c) => ({ v: c }))); return { ir: B.exprOf(cand[k]), type: 'int' }; }
            const exist = p.reassign ? [...st.vars.keys()].filter((n) => !o.ops.some((x) => x.name === n)) : []; const fr = fresh(4);
            const items = exist.map((n) => n + '（已有，重新指定）').concat(fr.map((n) => n + '（新的名稱）')); const vals = exist.concat(fr);
            const k = await choose(head('區塊「' + tplText + '」的槽位「' + p.slot + '」要宣告一個新的變數名稱，選哪一個？'), items, 'name', vals.map((v, i) => ({ v, existing: i < exist.length }))); return { ir: { n: 'name', v: vals[k] }, type: p.type };
        }
        async function pickVar(p, tplText) {
            const vs = R.varsOf(st, p.type).filter((v) => !o.ops.some((x) => x.name === v.name)); const k = await choose(head('區塊「' + tplText + '」的槽位「' + p.slot + '」要用哪一個已宣告的變數？'), vs.map((v) => v.name + '（' + v.type + '）'), 'var', vs.map((v) => ({ v: v.name })));
            return { ir: { n: 'name', v: vs[k].name }, type: vs[k].type };
        }
        async function pickExpr(slot, type, tplText, depth) {
            const M = R.exprMenu(type, st); M.vars = M.vars.filter((v) => !o.ops.some((x) => x.name === v.name));
            if (o.focus && o.focus.exprs) M.cats = M.cats.map((c) => ({ id: c.id, blocks: c.blocks.filter((b) => o.focus.exprs.has(b.id)) })).filter((c) => c.blocks.length); // 動作表的白名單：這個算法會用到的運算積木
            const menu = []; if (M.vars.length) menu.push({ k: 'var', label: '變數（已宣告的）' }); if (M.num) menu.push({ k: 'num', label: '數字' }); if (M.str) menu.push({ k: 'str', label: '文字' });
            if (depth < exprDepth) for (const c of M.cats) menu.push({ k: 'cat', id: c.id, blocks: c.blocks, label: ECAT_DESC[c.id] || c.id });
            if (!menu.length) return null;
            const m = menu[await choose(head('區塊「' + tplText + '」的槽位「' + slot + '」要填一個「' + type + '」的值，是哪一種？'), menu.map((x) => x.label), 'expr-kind', menu)];
            if (m.k === 'var') { const items = M.vars.slice(0, LET.length); const k = await choose(head('槽位「' + slot + '」填哪一個變數？'), items.map((v) => v.name + '（' + v.type + '）'), 'var', items.map((v) => ({ v: v.name }))); return { ir: { n: 'name', v: items[k].name }, type: items[k].type }; }
            if (m.k === 'num') { const k = await choose(head('槽位「' + slot + '」填哪一個數字？'), nums, 'num', nums.map((v) => ({ v }))); return { ir: B.exprOf(nums[k]), type: /\./.test(nums[k]) ? 'float' : 'int' }; }
            if (m.k === 'str') { const k = await choose(head('槽位「' + slot + '」填哪一段文字？'), strs.map((x) => JSON.stringify(x)), 'str', strs.map((v) => ({ v }))); return { ir: B.exprOf(JSON.stringify(strs[k])), type: 'str' }; }
            const e = m.blocks[await choose(head('槽位「' + slot + '」要填「' + m.id + '」類的運算，選哪一個？'), m.blocks.map((x) => x.line.replace(SPLIT, '〔$1〕')), 'expr', m.blocks)];
            hk('exprBlock', e); const fills = {}; for (const sl of e.slots) { hk('begin', sl); const sub = await pickExpr(sl, R.exprParamType(e.id, sl), e.line.replace(SPLIT, '〔$1〕'), depth + 1); hk('end'); if (!sub) return null; fills[sl] = sub.ir; }
            return { ir: B.buildExpr(e.id, fills), type: R.exprRet(e.id) };
        }
        const text = (kind, ir) => (kind === 'name' && ir.n === 'tuple' && ir.xs.length > 1 ? ir.xs.map(B.exprText).join(', ') : B.exprText(ir));
        for (;;) {
            if (steps >= (o.maxSteps || 900) || lines.length >= maxStmts) return { ok: false, lines, steps, forced, trace, reason: '區塊太多或選擇太多' };
            let got = null, lastErr = ''; const banned = new Set();
            for (let attempt = 0; attempt < maxLineTry && !got; attempt++) {
                const L0 = R.legal(st); const depth = st.frames.length - 1; const f = R.top(st);
                const fpl = o.focus && o.focus.templates ? L0.templates.filter((t) => o.focus.templates.has(t.id)) : L0.templates; // 動作表的白名單：這個算法會用到的區塊
                const L = Object.assign({}, L0, { templates: fpl, cats: [...new Set(fpl.map((t) => t.cat))].concat(L0.ifOptions.if || L0.ifOptions.elif || L0.ifOptions.else ? ['條件'] : []) });
                const where = depth === 0 ? '目前在函式「' + o.op.name + '」的最外層。' : '目前在「' + f.header + '」這個區塊裡面。';
                const menu = []; for (const c of CAT_ORDER) if (L.cats.includes(c) && (c === '條件' || L.templates.some((t) => t.cat === c && !banned.has(t.id)))) menu.push({ k: 'cat', id: c, label: CAT_DESC[c] || c });
                if (L.canEnd) menu.push({ k: 'end', label: '結束這個區塊（回到上一層）' });
                for (const to of L.zoneNext) menu.push({ k: 'zone', to, label: to === 'declare' ? '進入「宣告區」（引入完了，開始宣告變數）' : '進入「邏輯與流程區」（宣告完了，開始寫運算與流程）' });
                if (L.canDone && L.zone === 'logic') menu.push({ k: 'done', label: '函式寫完了' });
                if (!menu.length) return { ok: false, lines, steps, forced, trace, reason: '沒有任何合法的下一步（' + (L.endWhy || L.doneWhy || '庫存不足') + '）' };
                const m = menu[await choose(head(where + '\n下一步要寫哪一類區塊？只有符合目前庫存與規則的類別列在這裡。'), menu.map((x) => x.label), 'category', menu)];
                if (m.k === 'end') { got = { kind: 'end' }; break; } if (m.k === 'done') { got = { kind: 'done' }; break; } if (m.k === 'zone') { got = { kind: 'zone', to: m.to }; break; }
                let tpl = null, line = null, header = false, special = null, slots = {};
                if (m.id === '條件') {
                    const opts = []; if (L.ifOptions.if) opts.push({ id: 'if', label: '如果〔條件〕就：' }); if (L.ifOptions.elif) opts.push({ id: 'elif', label: '否則如果〔條件〕就：（接在上面的如果後面）' }); if (L.ifOptions.else) opts.push({ id: 'else', label: '否則：（接在上面的如果後面）' });
                    special = opts[await choose(head(where + '\n選哪一個？'), opts.map((x) => x.label), 'cond', opts)].id;
                    if (special === 'else') { line = '否則：'; header = true; }
                    else { hk('begin', '條件', null); const c = await pickExpr('條件', 'cond', '如果〔條件〕就：', 0); hk('end'); if (!c) { lastErr = '條件選不出來'; retries++; continue; } slots = { c }; line = (special === 'if' ? '如果 ' : '否則如果 ') + B.exprText(c.ir) + ' 就：'; header = true; }
                } else {
                    const list = L.templates.filter((t) => t.cat === m.id && !banned.has(t.id));
                    tpl = list[await choose(head(where + '\n「' + m.id + '」類的區塊，選哪一個？'), list.map(gloss), 'template', list)];
                    let okSlots = true;
                    for (const p of R.slotPlan(tpl)) {
                        hk('begin', p.slot, tpl); const v = p.mode === 'decl' ? await pickDecl(p, gloss(tpl)) : p.mode === 'var' ? await pickVar(p, gloss(tpl)) : await pickExpr(p.slot, p.type, gloss(tpl), 0); hk('end');
                        if (!v) { okSlots = false; break; } slots[p.slot] = v;
                    }
                    if (!okSlots) { lastErr = '槽位選不出來'; banned.add(tpl.id); retries++; continue; }
                    line = tpl.line.replace(SPLIT, (m0, n, kind) => text(kind, slots[n].ir)); header = tpl.bodies.length > 0;
                }
                if (line === lastText && !header) { lastErr = '和上一行一樣'; if (tpl) banned.add(tpl.id); retries++; continue; }
                const sib = special === 'elif' || special === 'else'; const src = (sib ? '如果 True 就：\n  什麼都不做\n' : '') + line + (header ? '\n  什麼都不做' : '');
                const pr = B.parseCNL(src); if (!pr.ok || pr.blocks.length !== 1) { lastErr = pr.errors[0] ? pr.errors[0].msg : '一行只能是一個區塊'; if (tpl) banned.add(tpl.id); retries++; continue; }
                let ir; try { ir = B.toIR(pr.blocks); } catch (e) { lastErr = '轉不成程式'; retries++; continue; }
                got = { kind: 'line', line, header, tpl, special, slots, ir: sib ? [] : ir };
            }
            if (!got) return { ok: false, lines, steps, forced, trace, reason: '連續 ' + maxLineTry + ' 次選不出合格的一行：' + lastErr };
            if (got.kind === 'zone') { R.advanceZone(st, got.to); continue; }
            if (got.kind === 'done') return { ok: true, lines, cnl: render(lines), zones: byZone(lines), steps, forced, retries, trace, sizes };
            if (got.kind === 'end') { R.endBlock(st); continue; }
            const depth = st.frames.length - 1; lines.push({ d: depth, t: got.line, z: depth === 0 ? st.zone : 'logic' }); lastText = got.line; hk('lineDone', got);
            R.apply(st, { tpl: got.tpl, special: got.special, slots: got.slots, ir: got.ir, header: got.header, line: got.line });
        }
    }

    // 整條管線：UML 切割（操作清單）→ 骨架 → 區塊迴圈 → 沙盒驗證 ⇄ 回饋
    async function writeProgramChoose(o) {
        const P = o.FaPyBody; const umlOps = (o.umlOps && o.umlOps.length ? o.umlOps : [{ name: 'main', params: [] }]).map((x) => ({ name: x.name, params: x.params || [], sig: 'def ' + x.name + '(' + (x.params || []).join(', ') + '):' }));
        const rounds = []; let feedback = '', last = null; let imports = []; const maxRounds = o.rounds || 2;
        for (let round = 0; round < maxRounds; round++) {
            const parts = []; let steps = 0, forced = 0; const cnls = {}; let fail = null; imports = [];
            for (const op of umlOps) {
                const R = o.R; const r = await writeBlocks({ op, ops: umlOps, plan: o.plan, feedback, problem: o.problem, pick: o.pick, B: o.B, R, namesOf: P.namesOf, builtins: P.BUILTINS, maxStmts: o.maxStmts, onTrace: o.onTrace, noDebias: o.noDebias });
                steps += r.steps; forced += r.forced; if (o.onOp) o.onOp(op, r);
                if (!r.ok) { fail = op.name + '：' + r.reason + (r.lines.length ? '\n' + render(r.lines) : ''); break; }
                const zir = {}; let bad = false; for (const z of ['import', 'declare', 'logic']) { const txt = r.zones[z]; if (!txt) { zir[z] = []; continue; } const pr = o.B.parseCNL(txt); if (!pr.ok) { bad = true; break; } zir[z] = o.B.toIR(pr.blocks); }
                if (bad) { fail = op.name + '：組起來的區塊解析失敗'; break; } cnls[op.name] = ['【引入區】', r.zones.import, '【宣告區】', r.zones.declare, '【邏輯與流程區】', r.zones.logic].filter((x) => x !== '').join('\n'); imports.push(...zir.import); parts.push({ op, body: zir.declare.concat(zir.logic) });
            }
            if (fail) { rounds.push({ round, ok: false, reason: fail, steps, forced }); last = { ok: false, reason: fail, rounds, steps }; break; }
            // 骨架：UML 模型 → codegen；body 是區塊轉出來的敘述
            const model = { name: 'Module', actors: ['User'], relations: [], usecases: [], prelude: [], order: [], classes: [{ name: 'Module', kind: 'class', attrs: [], values: [], ops: parts.map((p) => ({ name: p.op.name, params: p.op.params.map((n) => ({ name: n, type: { base: 'any', args: [] } })), returns: { base: 'any', args: [] }, visibility: '+', static: true, body: p.body })) }] };
            const seenImp = new Set(); model.prelude = imports.filter((x) => { const k = JSON.stringify(x); if (seenImp.has(k)) return false; seenImp.add(k); return true; }); model.order = model.prelude.map((x) => ({ t: 's', s: x })).concat(model.classes[0].ops.map((o2) => ({ t: 'f', o: o2 }))); const source = o.C2U.toPython(model);
            let v = { verdict: 'UNCHECKED', detail: '' }; if (o.judge) v = await o.judge(source);
            rounds.push({ round, ok: v.verdict === 'AC' || v.verdict === 'UNCHECKED', verdict: v.verdict, detail: v.detail, steps, forced, cnl: cnls });
            last = { ok: true, source, model, cnl: cnls, ops: umlOps, steps, forced, verdict: v.verdict, rounds };
            if (v.verdict === 'AC' || v.verdict === 'UNCHECKED') break;
            feedback = '上一版的區塊：\n' + Object.values(cnls).join('\n') + '\n上一版驗證結果：' + v.verdict + (v.detail ? '（' + String(v.detail).slice(0, 160) + '）' : '') + '。請改正。';
        }
        return last;
    }
    return { writeBlocks, writeProgramChoose, CAT_ORDER };
});
