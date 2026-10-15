/* 需求 → 活動 → 單元（UMD，純函式）：把 UML 使用案例（參與者依序呼叫「類別.操作(參數):回傳」）接到單元目錄的單元，
 * 產出可以直接檢查、執行的呼叫程式（FaCatalogIR）。整個過程 0 次模型呼叫：
 *   ① 型別合約：UML 操作的參數／回傳型別 → 單元目錄的型別（str→text、List<T>→list<T>、列舉→enum、有屬性的類別→object）；
 *   ② 挑單元：用「類別名稱＋操作名稱＋使用案例名稱」做檢索（BM25，跟評測同一套），再用型別合約打分——
 *      必填參數能不能從目前手上的資料（使用案例輸入＋前面步驟的輸出）接得上、回傳型別對不對得上宣告的回傳；
 *   ③ 資料流：每個參數優先接「同名」的資料，其次接型別接得上的最近一個；接不上就用「型別接線矩陣」找一小段橋接單元
 *      （例如 url →下載→ 檔案 → 數頁），找不到才變成程式的輸入並標示沒接上；
 *   ④ 沒有任何單元對得上、但合約有明確的輸入／輸出型別的步驟：直接用矩陣從輸入型別走到輸出型別（型別合約自動接線）。
 * 輸出的程式一定經過 FaCatalogIR.validate；不確定的地方（沒接上、靠名稱猜、用了強制轉型）都列在 issues。 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory(require('./catalog_core.js'), require('./matrix_core.js'), require('./select_core.js'), require('./ir_core.js'));
    else root.FaCatalogBind = factory(root.FaCatalog || (typeof FaCatalog !== 'undefined' ? FaCatalog : undefined), root.FaCatalogMatrix || (typeof FaCatalogMatrix !== 'undefined' ? FaCatalogMatrix : undefined), root.FaCatalogSelect || (typeof FaCatalogSelect !== 'undefined' ? FaCatalogSelect : undefined), root.FaCatalogIR || (typeof FaCatalogIR !== 'undefined' ? FaCatalogIR : undefined));
})(typeof self !== 'undefined' ? self : this, function (Cat, MX, SEL, IR) {
    'use strict';
    const snake = (s) => String(s || '').replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').toLowerCase();
    const KINDED = [[/pdf/i, 'pdf_file'], [/video/i, 'video_file'], [/audio/i, 'audio_file'], [/gif/i, 'gif_file'], [/subtitle|srt/i, 'subtitle_file'], [/image|img|picture/i, 'image_file']];

    // ===== UML 型別 → 單元目錄型別字串（'void' 代表沒有回傳）=====
    function umlToType(t, model, depth) {
        depth = depth || 0; if (!t) return 'any'; const b = t.base, a = t.args || [];
        switch (b) {
            case 'str': return 'text'; case 'int': return 'int'; case 'float': case 'decimal': return 'number'; case 'bool': return 'bool'; case 'date': case 'datetime': return 'text'; case 'bytes': return 'bytes'; case 'any': return 'any'; case 'void': return 'void';
            case 'List': case 'Set': return 'list<' + umlToType(a[0], model, depth + 1) + '>'; case 'Map': return 'dict'; case 'Optional': return umlToType(a[0], model, depth);
        }
        const lower = String(b).toLowerCase();
        if (/^(path|filepath|dirpath)$/.test(lower)) return 'path'; if (/^(url|uri|link)$/.test(lower)) return 'url'; if (lower === 'yaml') return 'yaml'; if (lower === 'code') return 'code';
        const fm = /file(id)?$/.test(lower) ? KINDED.find(([re]) => re.test(lower)) : null; if (fm) return fm[1]; if (/^fileid$/.test(lower)) return 'file_id';
        const c = model && model.classes && model.classes.find((x) => x.name === b);
        if (c) {
            if (c.kind === 'enum') { const vs = (c.values || []).filter((v) => /^[A-Za-z0-9_\-.]+$/.test(v)); return vs.length && vs.length === (c.values || []).length ? 'enum<' + vs.join('|') + '>' : 'text'; }
            if (depth < 2 && c.attrs && c.attrs.length) { const fs = c.attrs.filter((x) => /^[A-Za-z_]\w*$/.test(x.name)).slice(0, 8).map((x) => x.name + ':' + umlToType(x.type, model, depth + 1)).filter((x) => !/:void$/.test(x)); if (fs.length) return 'object{' + fs.join(',') + '}'; }
            return 'dict';
        }
        return 'any';
    }
    const stem = (w) => (w.length > 3 && /s$/.test(w) && !/ss$/.test(w) ? w.slice(0, -1) : w);
    // 操作名稱裡的每個字（send、email）有多少比例出現在單元的名稱／說明裡——只靠一個共同字（send）湊出來的不算對得上
    function tokenCoverage(index, id, words) {
        if (!words.length) return 1; const d = index.docs.find((x) => x.u.id === id); if (!d) return 0; const have = new Set(Array.from(d.tf.keys()).map(stem)); let hit = 0; for (const w of words) if (have.has(stem(w))) hit++; return hit / words.length;
    }
    const TEXTISH = new Set(['text', 'path', 'url', 'query', 'code', 'yaml']); const isTextish = (k) => TEXTISH.has(k);
    const isVoid = (s) => s === 'void' || s === '' || s == null;
    const isOpaque = (s) => { try { const k = Cat.parseType(s).k; return k === 'any' || k === 'json' || k === 'dict'; } catch (_) { return true; } };

    // ===== 資料池：使用案例輸入＋各步驟輸出 =====
    function outputEntries(u, sid, step, op) {
        const outs = MX.outputsOf(u); const aliases = new Set(); const lbl = step && step.returns && /^[A-Za-z_]\w*$/.test(step.returns) ? step.returns : null;
        if (lbl) aliases.add(lbl); if (step) { aliases.add(snake(step.msg)); aliases.add(snake(step.to) + '_result'); }
        return outs.map((o) => ({ name: o.name === '$' ? null : o.name, aliases: o.name === '$' ? Array.from(aliases) : [], type: Cat.typeToString(o.type), parsed: o.type, ref: { $ref: sid + (o.name === '$' ? '' : '.' + o.name) }, origin: sid, whole: o.name === '$' }));
    }
    // 資料 s 能不能接進型別 want：回傳 0（不行）～1；輸入（使用者給的）型別不明時給低分，步驟的不明輸出不接
    function fit(s, want) {
        const sp = s.parsed || Cat.parseType(s.type); const wp = typeof want === 'string' ? Cat.parseType(want) : want;
        if (s.origin === 'input') { if (sp.k === 'any' || sp.k === 'json') return 0.3; if (isTextish(sp.k) && isTextish(wp.k)) return Cat.isAssignable(sp, wp) ? Math.max(0.3, MX.matchScore(sp, wp)) : 0.3; }
        if (wp.k === 'any') return 0.2; if (!Cat.isAssignable(sp, wp)) return 0; return MX.matchScore(sp, wp);
    }
    function pickSource(pool, pname, want, used) {
        let best = null;
        for (let i = pool.length - 1; i >= 0; i--) { // 越新的越優先
            const s = pool[i]; let f = fit(s, want); if (!f) continue;
            const names = [s.name].concat(s.aliases || []).filter(Boolean); const nameHit = names.includes(pname) ? 1 : 0; const score = f + nameHit * 1 + (used && used.has(s) ? -0.15 : 0) + i * 1e-4;
            if (!best || score > best.score) best = { s, score, nameHit: !!nameHit, fit: f };
        }
        return best;
    }

    // ===== 橋接：從資料池的型別走到需要的型別，用矩陣找一小段單元 =====
    function bridge(M, fromType, toType, opts) {
        if (!M || !fromType || !toType) return null; let r; try { r = MX.findPipelines(M, { from: fromType, to: toType }, { k: 3, maxLen: opts.maxBridge || 3 }); } catch (_) { return null; }
        const ok = r.paths.filter((p) => p.score >= (opts.minBridge || 0.2) && !p.extra_required.length); return ok[0] || null;
    }
    function emitPath(path, M, sourceRef, nextId, steps, taken) {
        // 把矩陣的一條路徑展開成 IR 步驟；回傳最後一步的輸出參照
        let prevId = null, prevOut = null; const byId = new Map(M.units.map((u) => [u.id, u]));
        path.units.forEach((uid, i) => {
            const u = byId.get(uid); const sid = nextId(); const args = {}; const via = i > 0 ? path.via[i - 1] : null; const taken0 = via ? via.param : path.start;
            for (const p of u.params) { if (p.name === taken0) { args[p.name] = i === 0 ? sourceRef : { $ref: prevId + (via.out && via.out !== '$' ? '.' + via.out : '') }; continue; } if (p.required) taken.push({ step: sid, unit: u.id, param: p.name, type: p.type }); }
            steps.push({ id: sid, call: uid, args }); prevId = sid; prevOut = path.goal;
        });
        return { $ref: prevId + (prevOut && prevOut !== '$' ? '.' + prevOut : '') };
    }

    // ===== 主流程：一個使用案例 =====
    function bindUseCase(model, uc, ctx) {
        const cat = ctx.catalog, M = ctx.matrix, opts = ctx.opts || {}; const byId = new Map(cat.units.map((u) => [u.id, u]));
        const program = { version: 1, inputs: {}, steps: [] }; const pool = []; const issues = []; const report = []; let n = 0; const nextId = () => 's' + (++n);
        const used = new Set(); let lastRef = null, lastType = null;
        const addInput = (name, type) => { let nm = name; if (program.inputs[nm]) { if (program.inputs[nm].type === type) return pool.find((p) => p.origin === 'input' && p.name === nm); let k = 2; while (program.inputs[nm + k]) k++; nm = nm + k; } program.inputs[nm] = { type }; const e = { name: nm, aliases: [], type, parsed: Cat.parseType(type), ref: { $in: nm }, origin: 'input' }; pool.push(e); return e; };
        for (const step of uc.steps) {
            const cls = model.classes.find((c) => c.name === step.to); const op = cls && cls.ops.find((o) => o.name === step.msg); const label = step.to + '.' + step.msg;
            const opParams = (op ? op.params : []).map((p, i) => ({ name: (step.args && step.args[i] && /^[A-Za-z_]\w*$/.test(step.args[i])) ? step.args[i] : p.name, type: umlToType(p.type, model) }));
            if (!op) (step.args || []).forEach((a, i) => { if (/^[A-Za-z_]\w*$/.test(a)) opParams.push({ name: a, type: 'any' }); });
            const retType = op ? umlToType(op.returns, model) : 'any';
            // 這一步要的資料：UML 操作的參數。池子裡找得到（同名或型別接得上）就用，找不到就是使用案例的輸入
            const resolveIn = () => opParams.map((p) => { const hit = pickSource(pool, p.name, p.type, used); if (hit && (hit.nameHit || (hit.fit >= 0.3 && hit.s.origin !== 'input'))) return { p, s: hit.s }; if (lastType && isOpaque(lastType) && program.steps.length) issues.push({ step: label, kind: 'opaque_link', msg: '上一步的回傳型別不明（' + lastType + '），' + p.name + ' 沒辦法從它接過來，只能當輸入' }); return { p, s: addInput(p.name, p.type) }; });
            const stepIn = program.steps.length === 0 && !pool.length ? resolveIn() : null; // 第一步：UML 的參數就是使用案例的輸入；後面的步驟先看能不能從前面接過來，接不上才變輸入
            // 挑單元
            const q = [uc.name, step.to, step.msg, op && op.doc].filter(Boolean).join(' ');
            const hits = SEL.retrieve(ctx.index, snake(step.to).replace(/_/g, ' ') + ' ' + snake(step.msg).replace(/_/g, ' ') + ' ' + (ctx.intentFor ? ctx.intentFor(step, uc) : '') + ' ' + (opts.useCaseInText ? uc.name : ''), 12);
            const top = hits.length ? hits[0].score : 1; const cands = []; const words = SEL.tokenize(snake(step.msg).replace(/_/g, ' ')).filter((w) => w.length >= 2 && !['get', 'do', 'run', 'set'].includes(w));
            const exact = cat.units.filter((u) => u.tier === 1 && (snake(u.name.replace(/^[a-z]+:/, '')) === snake(step.msg) || snake(u.name.replace(/^[a-z]+:/, '')) === snake(step.to) + '_' + snake(step.msg)));
            for (const e of exact) if (!hits.some((h) => h.id === e.id)) hits.unshift({ id: e.id, score: top, u: e });
            for (const h of hits) {
                const u = byId.get(h.id); if (!u || u.tier !== 1 || u.avail.state !== 'builtin') continue; const rel = Math.min(1, h.score / (top || 1)) * (exact.some((e) => e.id === u.id) ? 1 : 0.85);
                const req = u.params.filter((p) => p.required); let sat = 0; const sources = pool.slice(); for (const p of req) if (pickSource(sources, p.name, p.type, null)) sat++;
                const cov = req.length ? sat / req.length : 1; const ut = u.returns.type; let rf = 1; if (!isVoid(retType) && retType !== 'any') rf = isOpaque(ut) ? 0.6 : (Cat.isAssignable(ut, retType) ? 1 : (MX.outputsOf(u).some((o) => o.name !== '$' && !isOpaque(Cat.typeToString(o.type)) && Cat.isAssignable(o.type, retType)) ? 0.9 : 0.3));
                const tc = exact.some((e) => e.id === u.id) ? 1 : tokenCoverage(ctx.index, u.id, words); cands.push({ unit: u.id, token_cov: Math.round(tc * 100) / 100, rel: Math.round(rel * 1000) / 1000, coverage: Math.round(cov * 100) / 100, ret_fit: rf, score: Math.round(rel * (0.4 + 0.6 * cov) * (0.5 + 0.5 * rf) * 1000) / 1000 });
            }
            cands.sort((a, b) => b.score - a.score); const best = cands.find((c) => c.token_cov >= (opts.minTokenCoverage || 0.6)); // 名稱對不上的不採用
            const rec = { step: label, op_params: opParams.map((p) => p.name + ':' + p.type), returns: retType, candidates: cands.slice(0, 3) };
            if (best && best.score >= (opts.minScore || 0.25) && best.rel >= (opts.minRel || 0.3)) {
                const u = byId.get(best.unit); const sid = nextId(); const args = {}; const bridged = [];
                for (const p of u.params) {
                    const hit = pickSource(pool, p.name, p.type, used); 
                    if (hit && (hit.nameHit || hit.fit >= 0.3)) { if (hit.s.origin === 'input' && !Cat.isAssignable(hit.s.type, p.type) && (isTextish(hit.s.parsed.k) || isOpaque(hit.s.type)) && (isTextish(Cat.parseType(p.type).k) || true)) { hit.s.type = p.type; hit.s.parsed = Cat.parseType(p.type); program.inputs[hit.s.name].type = p.type; } args[p.name] = hit.s.ref; used.add(hit.s); if (hit.fit < 0.3 && !hit.nameHit) issues.push({ step: label, kind: 'weak_link', msg: p.name + ' 靠型別勉強接上（得分 ' + hit.fit + '）' }); continue; }
                    if (!p.required) continue;
                    // 橋接：從池子裡最新、型別明確的資料走到這個參數要的型別
                    let done = false; for (let i = pool.length - 1; i >= 0 && i >= pool.length - 8 && !done; i--) { const s = pool[i]; if (isOpaque(s.type)) continue; const path = bridge(M, s.type, p.type, opts); if (!path) continue; const taken = []; const steps = []; const out = emitPath(path, M, s.ref, nextId, steps, taken); if (taken.length) { taken.forEach((t) => { const nm = addInput(t.step + '_' + t.param, t.type); const st = steps.find((x) => x.id === t.step); st.args[t.param] = nm.ref; }); } steps.forEach((x) => program.steps.push(x)); args[p.name] = out; bridged.push(path.names.join(' → ')); used.add(s); done = true; }
                    if (!done) { const declared = opParams.some((op) => op.name === p.name || (isOpaque(op.type) ? false : Cat.isAssignable(op.type, p.type))); const nm = addInput(p.name, p.type); args[p.name] = nm.ref; if (lastType && isOpaque(lastType) && program.steps.length) issues.push({ step: label, kind: 'opaque_link', msg: '上一步的回傳型別不明（' + lastType + '），' + p.name + ' 沒辦法從它接過來，只能當輸入' }); if (!declared) issues.push({ step: label, kind: 'unwired', msg: '必填參數 ' + p.name + '（' + p.type + '）沒有資料可以接，變成程式的輸入' }); }
                }
                program.steps.push({ id: sid, call: u.id, args }); rec.unit = u.id; rec.by = 'retrieval+contract'; rec.score = best.score; if (bridged.length) rec.bridged = bridged;
                for (const e of outputEntries(u, sid, step, op)) pool.push(e); lastRef = { $ref: sid }; lastType = u.returns.type;
                if (best.score < 0.5) issues.push({ step: label, kind: 'low_confidence', msg: '挑 ' + u.name + ' 的信心偏低（' + best.score + '）' });
            } else {
                // 沒有單元對得上：合約有明確輸入／輸出型別就直接用矩陣接線
                const typedIn = (stepIn || resolveIn()).filter((x) => !isOpaque(x.s.type)); let wired = false;
                if (typedIn.length && !isVoid(retType) && !isOpaque(retType)) {
                    const path = bridge(M, typedIn[0].s.type, retType, opts);
                    if (path) { const taken = []; const steps = []; const out = emitPath(path, M, typedIn[0].s.ref, nextId, steps, taken); taken.forEach((t) => { const nm = addInput(t.step + '_' + t.param, t.type); steps.find((x) => x.id === t.step).args[t.param] = nm.ref; }); steps.forEach((x) => program.steps.push(x)); rec.by = 'type-wiring'; rec.units = path.units; rec.score = path.score; wired = true; used.add(typedIn[0].s);
                        const lastU = byId.get(path.units[path.units.length - 1]); const sid = steps[steps.length - 1].id; for (const e of outputEntries(lastU, sid, step, op)) pool.push(e); lastRef = out; lastType = retType; issues.push({ step: label, kind: 'wired_by_type', msg: '沒有對得上名稱的單元，用型別合約接線：' + path.names.join(' → ') }); }
                }
                if (!wired) { rec.unit = null; rec.by = 'none'; issues.push({ step: label, kind: 'unbound', msg: '找不到對得上的單元' + (best ? '（最接近 ' + best.unit + '，得分 ' + best.score + '）' : '') }); }
            }
            report.push(rec);
        }
        program.return = lastRef || { $ref: 's1' };
        let validation = { ok: false, errors: ['沒有任何步驟'], warnings: [], effects: [] };
        if (program.steps.length) validation = IR.validate(program, cat);
        const bound = report.filter((r) => r.unit || r.units).length;
        return { usecase: uc.name, actor: uc.actor, steps: report, program: program.steps.length ? program : null, text: program.steps.length ? IR.toText(program) : '', valid: validation.ok, errors: validation.errors, warnings: validation.warnings, effects: validation.effects, issues, bound, total: report.length, inputs: Object.keys(program.inputs), result_type: lastType, model_calls: 0 };
    }
    // ===== 整份 UML =====
    // opts: { intents, minScore, minRel, maxBridge, minBridge }；回傳每個使用案例的結果與彙整
    function bindModel(model, catalog, opts) {
        opts = opts || {}; const t0 = Date.now(); const M = opts.matrix || MX.buildMatrix(catalog, { allowOpaque: false }); const index = SEL.buildIndex(catalog.units.filter((u) => u.tier === 1), { intents: opts.intents });
        const ctx = { catalog, matrix: M, index, opts, intentFor: opts.intentFor || null };
        const results = (model.usecases || []).map((uc) => bindUseCase(model, uc, ctx));
        const steps = results.reduce((a, r) => a + r.total, 0), bound = results.reduce((a, r) => a + r.bound, 0);
        return { results, summary: { usecases: results.length, steps, bound, bound_pct: steps ? Math.round((bound / steps) * 1000) / 10 : null, valid: results.filter((r) => r.valid).length, fully_wired: results.filter((r) => r.valid && !r.issues.some((i) => i.kind === 'unwired' || i.kind === 'unbound')).length, issues: results.reduce((a, r) => a + r.issues.length, 0), model_calls: 0, ms: Date.now() - t0 } };
    }
    function toText(res) {
        const L = []; for (const r of res.results) { L.push('▸ ' + r.usecase + '（' + r.actor + '）　' + (r.valid ? '檢查通過' : '檢查失敗：' + (r.errors[0] || '沒有程式')) + '　' + r.bound + '/' + r.total + ' 步有單元'); for (const s of r.steps) L.push('  ' + s.step + ' → ' + (s.unit || (s.units ? s.units.join(' → ') : '（沒有）')) + (s.by ? '　[' + s.by + (s.score != null ? ' ' + s.score : '') + ']' : '')); for (const i of r.issues) L.push('  ⚠ ' + i.msg); }
        const s = res.summary; L.push('', '共 ' + s.usecases + ' 個使用案例、' + s.steps + ' 步，單元對上 ' + s.bound + ' 步（' + s.bound_pct + '%），程式檢查通過 ' + s.valid + ' 個，完全接通 ' + s.fully_wired + ' 個；模型呼叫 0 次，' + s.ms + ' 毫秒。'); return L.join('\n');
    }
    return { umlToType, bindUseCase, bindModel, toText, pickSource };
});
