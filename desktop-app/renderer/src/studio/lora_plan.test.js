// node renderer/src/studio/lora_plan.test.js
// 計畫逐步切換 LoRA（設計見 DESIGN.lora-training.md §28）。涵蓋：
//  1) lora_plan_core 純函式：步驟→領域、相依重排（只在無相依時重排、最後一步不動）、切換次數、聯合領域上限；
//  2) lora_route_core.routeDomains：整批領域的組合（每個領域都要涵蓋，否則回基底）；
//  3) 從 floating-assistant.js 抽出真的方法本體（_loraPlanOn、_planLoraWrap、_llmGenerate）放進 vm 沙箱，用假的 this 執行：
//     關閉時零呼叫、同領域不重複切換、對不上的步驟切回基底、切換失敗寫出步驟與原因且這一步用基底繼續、_llmGenerate 沿用 _loraStepPin。
const fs = require('fs'); const path = require('path'); const vm = require('vm');
const P = require('./lora_plan_core.js'); const Rt = require('./lora_route_core.js');
const SRC = fs.readFileSync(path.join(__dirname, '..', 'floating-assistant.js'), 'utf8');
let ok = 0, bad = 0; const check = (n, c, x) => { if (c) ok++; else { bad++; console.log('FAIL ' + n + (x !== undefined ? ' ' + JSON.stringify(x).slice(0, 300) : '')); } };

// 抽出類別內一個方法的原始碼（與 lora_route_wiring.test.js 相同做法）
function methodSource(name) {
    const re = new RegExp('\\n    (async )?' + name + '\\(');
    const m = re.exec(SRC); if (!m) throw new Error('找不到方法 ' + name);
    let i = SRC.indexOf('{', m.index + m[0].length); let depth = 0; const start = m.index + 1;
    for (; i < SRC.length; i++) {
        const c = SRC[i];
        if (c === '/' && SRC[i + 1] === '/') { i = SRC.indexOf('\n', i); continue; }
        if (c === "'" || c === '"' || c === '`') { const q = c; i++; while (i < SRC.length && SRC[i] !== q) { if (SRC[i] === '\\') i++; i++; } continue; }
        if (c === '{') depth++;
        else if (c === '}') { depth--; if (depth === 0) return SRC.slice(start, i + 1); }
    }
    throw new Error('方法 ' + name + ' 大括號不成對');
}
// 放進沙箱：回傳 { 方法名: 函式 }（方法簡寫語法），之後用 .call(假的 this) 綁定
function loadMethods(names, globals) {
    const ctx = Object.assign({ console, Promise }, globals || {}); vm.createContext(ctx);
    return vm.runInContext('({' + names.map(methodSource).join(',\n') + '})', ctx);
}

(async () => {
    // ---- 1) 步驟 → 領域 ----
    const CODE = ['write_python'];
    check('UML 設計 → decompose', P.stepDomain({ tool: 'local_uml_design', local: true }, { codeTools: CODE }) === 'decompose');
    check('寫程式（語言工具）→ codewrite', P.stepDomain({ tool: 'write_python', local: true }, { codeTools: CODE }) === 'codewrite');
    check('摘要／讀檔 → reading', P.stepDomain({ tool: 'local_summarize', local: true }) === 'reading' && P.stepDomain({ tool: 'parse_uploaded_file' }) === 'reading');
    check('一般工具呼叫 → toolcall', P.stepDomain({ tool: 'merge_pdfs' }) === 'toolcall');
    check('其他本機函式（pick_urls）→ 基底 null', P.stepDomain({ tool: 'pick_urls', local: true }) === null);
    check('沒有工具名 → null', P.stepDomain({}) === null && P.stepDomain(null) === null);

    // ---- 2) 重排：只在無相依時重排，同領域相鄰，最後一步不動 ----
    const st = (id, tool, bind) => ({ id, tool, state: 'pending', bind: bind || {} });
    const dom = { toolcall: 'toolcall', decompose: 'decompose' };
    const domainOf = (s) => dom[s.tool] || null;
    // 原順序 A(t) B(d) C(t) D(d) E(t，最後）；C 不依賴任何人 → 應該排成 A C B D E
    const A = st('A', 'toolcall'), B = st('B', 'decompose'), C = st('C', 'toolcall'), D = st('D', 'decompose'), E = st('E', 'toolcall');
    const ord = P.orderSteps([A, B, C, D, E], domainOf);
    check('無相依：同領域相鄰（A C B D E）', ord.map((s) => s.id).join('') === 'ACBDE', ord.map((s) => s.id));
    check('最後一步固定在最後', ord[ord.length - 1].id === 'E');
    // 相依：C 依賴 B（不同領域）→ C 不能排到 B 前面
    const B2 = st('B', 'decompose'), C2 = st('C', 'toolcall', { x: { from: { type: 'step', ref: 'B' } } });
    const ord2 = P.orderSteps([st('A', 'toolcall'), B2, C2, st('D', 'decompose'), st('E', 'toolcall')], domainOf);
    const pos = (arr, id) => arr.findIndex((s) => s.id === id);
    check('相依不被打破：C 在 B 後面', pos(ord2, 'C') > pos(ord2, 'B'), ord2.map((s) => s.id));
    // 遞移相依：E 依賴 D，D 依賴 B → B 必須在 D 前面
    const dm = P.dependsMap([st('B', 'decompose'), st('D', 'decompose', { y: { from: { type: 'step', ref: 'B' } } }), st('Z', 'toolcall', { y: { from: { type: 'step', ref: 'D' } } })]);
    check('遞移相依閉包：Z 依賴 B', dm.get('Z').has('B') && dm.get('Z').has('D'));
    // 循環依賴：原樣回傳，不冒險
    const cyc = [st('X', 'toolcall', { a: { from: { type: 'step', ref: 'Y' } } }), st('Y', 'decompose', { a: { from: { type: 'step', ref: 'X' } } }), st('Z', 'toolcall')];
    check('循環依賴回傳原順序', P.orderSteps(cyc, domainOf).map((s) => s.id).join('') === 'XYZ');
    check('單一步驟原樣', P.orderSteps([A], domainOf).length === 1);

    // ---- 3) 切換次數 ----
    check('原順序 t d t d t → 5 次', P.switchCount(['toolcall', 'decompose', 'toolcall', 'decompose', 'toolcall']) === 5);
    check('重排後 t t d d t → 3 次', P.switchCount(['toolcall', 'toolcall', 'decompose', 'decompose', 'toolcall']) === 3);
    check('開頭的基底不算切換；中間的基底算一次', P.switchCount([null, null, 'plan', null, 'plan']) === 3);
    check('空序列 0 次', P.switchCount([]) === 0);

    // ---- 4) 聯合領域：不重複、保留順序、上限 ----
    check('聯合領域去重、去空、保序', JSON.stringify(P.unionDomains(['decompose', null, 'toolcall', 'decompose', 'plan'], 4)) === '["decompose","toolcall","plan"]');
    check('聯合領域上限 2', JSON.stringify(P.unionDomains(['decompose', 'toolcall', 'plan'], 2)) === '["decompose","toolcall"]');

    // ---- 5) routeDomains：假登錄表 ----
    const reg = (map) => ({ resolve: async (q) => { const ids = []; for (const d of q.domains) if (map[d]) ids.push(map[d]); return { active: ids, handles: ids.map((id) => ({ id })), skipped: [] }; } });
    const full = reg({ decompose: 'd-r4', toolcall: 't-r4', plan: 'p-r4' });
    const r1 = await Rt.routeDomains(full, ['decompose', 'toolcall']);
    check('整批：兩個領域都有 → lora 且 active 兩顆', r1.fallback === 'lora' && r1.active.join(',') === 'd-r4,t-r4', r1);
    check('整批：有一個領域沒有 LoRA → 整批回基底', (await Rt.routeDomains(full, ['decompose', 'reading'])).fallback === 'base');
    check('整批：空領域 → 基底', (await Rt.routeDomains(full, [])).fallback === 'base');
    check('整批：沒有登錄表 → 基底', (await Rt.routeDomains(null, ['plan'])).fallback === 'base');
    const boom = { resolve: async () => { throw new Error('登錄表壞掉'); } };
    const r2 = await Rt.routeDomains(boom, ['plan']);
    check('整批：登錄表丟例外 → 基底＋原因（永不丟例外）', r2.fallback === 'base' && /登錄表壞掉/.test(r2.reason), r2);
    const prev = await Rt.routeDomains(full, ['decompose', 'toolcall'], { prevActive: ['d-r4', 't-r4'] });
    check('整批：同一組 → keep（不重建）', prev.action === 'keep');

    // ---- 6) 方法本體（floating-assistant.js）：假的 this ----
    const FaStudio = { FaLoraPlan: P, FaLoraRoute: Rt };
    const FaLangColu = { languages: ['python'], toolName: (lg) => 'write_' + lg };
    const mkSelf = (over) => Object.assign({ advancedSettings: {}, _studioDesktop: () => true, _loraTurnState: null, _loraStepPin: undefined, _loraSwitchLog: [] }, over || {});
    const M = loadMethods(['_loraPlanOn', '_planLoraWrap', '_llmGenerate'], { FaStudio, FaLangColu });
    // 6a) 開關：預設關
    const off = mkSelf({}); check('開關預設關（沒設 loraPerStep）→ _loraPlanOn 為 false', M._loraPlanOn.call(off) === false);
    const on = mkSelf({ advancedSettings: { loraPerStep: true } }); check('loraPerStep 為 true → 開', M._loraPlanOn.call(on) === true);
    check('非桌面版 → 關', M._loraPlanOn.call(Object.assign(mkSelf({ advancedSettings: { loraPerStep: true } }), { _studioDesktop: () => false })) === false);

    // 6b) 逐步切換：假的 _loraSwitch 與 _loraRouteDomains
    const mkRun = (steps) => ({ state: 'running', steps: steps.map((s) => Object.assign({ state: 'pending', bind: {} }, s)) });
    const mkEnv = (log) => ({ fns: { local_uml_design: async () => { log.push('fn:uml'); return { ok: true, text: 'u' }; }, pick_urls: async () => { log.push('fn:pick'); return { ok: true, text: 'p' }; } }, tool: async (name) => { log.push('tool:' + name); return { ok: true, text: 't' }; }, fill: async (step) => { log.push('fill:' + step.tool); return { values: {}, missing: [] }; } });
    const domMap = { local_uml_design: 'decompose', merge_pdfs: 'toolcall', local_summarize: 'reading' };
    // 假的登錄表路由：每個領域有一顆 LoRA；可以指定某個領域「載入失敗」
    const mkWiring = (opt) => {
        const log = []; const msgs = [];
        const self = mkSelf({
            advancedSettings: { loraPerStep: true, loraPlanUnionMax: opt && opt.union ? 4 : 1 },
            _loraRouteDomains: async (ds) => { log.push('route:' + ds.join('+')); return Rt.routeDomains(reg({ decompose: 'd-r4', toolcall: 't-r4', reading: 'r-r4' }), ds, {}); },
            _loraSwitch: async (route) => {
                if (route.action === 'clear') { log.push('clear'); return Object.assign({}, route, { applied: true }); }
                if (opt && opt.failOn && route.active.some((id) => id === opt.failOn)) { log.push('switch-fail:' + route.active.join('+')); return Object.assign({}, route, { fallback: 'base', active: [], applied: false, applyError: 'HTTP 503 套用失敗' }); }
                log.push('switch:' + route.active.join('+')); return Object.assign({}, route, { applied: true });
            },
        });
        return { self, log, msgs, prog: { log: (m) => msgs.push(m) } };
    };
    // 6b-1) 同領域連續不重複切換；基底步驟切回基底
    {
        const w = mkWiring(); const env = mkEnv(w.log);
        const run = mkRun([{ id: 'a', tool: 'local_uml_design' }, { id: 'b', tool: 'local_uml_design' }, { id: 'c', tool: 'pick_urls' }, { id: 'd', tool: 'local_uml_design' }, { id: 'e', tool: 'merge_pdfs' }]);
        const wrapped = await M._planLoraWrap.call(w.self, run, env, '畫 UML', w.prog);
        for (const s of run.steps) { s.state = 'running'; if (s.tool === 'pick_urls' || s.tool === 'local_uml_design') await wrapped.fns[s.tool](); else await wrapped.tool(s.tool, {}); s.state = 'done'; }
        const sw = w.log.filter((x) => /^(switch|clear|switch-fail)/.test(x));
        // 重排後順序是 d d d（null）t：decompose 三步只載入一次；切換總數 = switchCount([decompose,decompose,decompose,null,toolcall]) = 3
        check('同領域連續不重複切換：decompose 只載入一次', sw.filter((x) => x === 'switch:d-r4').length === 1, w.log);
        check('切換總數等於 switchCount（d、基底、t 共 3 次）', sw.length === 3 && P.switchCount(['decompose', 'decompose', 'decompose', null, 'toolcall']) === 3, sw);
        check('基底步驟（pick_urls）切回基底', w.log.indexOf('clear') >= 0, w.log);
        check('步驟照順序執行、每一步都被呼叫', w.log.filter((x) => x.indexOf('fn:') === 0 || x.indexOf('tool:') === 0).length === 5, w.log);
    }
    // 6b-2) 整批一起載入：整批一次 switch，之後同組不再切
    {
        const w = mkWiring({ union: true }); const env = mkEnv(w.log);
        const run = mkRun([{ id: 'a', tool: 'local_uml_design' }, { id: 'b', tool: 'merge_pdfs' }, { id: 'c', tool: 'local_summarize' }]);
        const wrapped = await M._planLoraWrap.call(w.self, run, env, '做計畫', w.prog);
        for (const s of run.steps) { s.state = 'running'; await wrapped.tool(s.tool, {}); s.state = 'done'; }
        check('整批：只套用一次（三個領域一起進槽）', w.log.filter((x) => /^switch:/.test(x)).length === 1, w.log);
        check('整批：三顆一起在槽裡', w.log.some((x) => x === 'switch:d-r4+t-r4+r-r4'), w.log);
    }
    // 6b-3) 切換失敗：寫出步驟、領域、原因、耗時；這一步用基底繼續，計畫不中斷
    {
        const w = mkWiring({ failOn: 't-r4' }); const env = mkEnv(w.log);
        const run = mkRun([{ id: 'a', tool: 'merge_pdfs' }]);
        const wrapped = await M._planLoraWrap.call(w.self, run, env, '合併', w.prog);
        run.steps[0].state = 'running'; const res = await wrapped.tool('merge_pdfs', {}); run.steps[0].state = 'done';
        check('切換失敗：工具仍被呼叫（用基底繼續）', res.ok === true && w.log.indexOf('tool:merge_pdfs') >= 0, w.log);
        const line = w.msgs.find((m) => /切換失敗/.test(m)) || '';
        check('切換失敗：訊息含步驟名、領域、HTTP 狀態與耗時', /merge_pdfs/.test(line) && /toolcall/.test(line) && /HTTP 503/.test(line) && /耗時 \d+ 毫秒/.test(line), line);
    }
    // 6b-4) 填欄位的生成先切好：fill 也會經過 enter
    {
        const w = mkWiring(); const env = mkEnv(w.log);
        const run = mkRun([{ id: 'a', tool: 'local_summarize' }]);
        const wrapped = await M._planLoraWrap.call(w.self, run, env, '摘要', w.prog);
        await wrapped.fill({ tool: 'local_summarize' }, [], null);
        check('填欄位也先切到該領域（reading）', w.log.some((x) => x === 'switch:r-r4'), w.log);
    }
    // 6b-5) 重排後的順序仍然相依正確（實際執行的順序）
    {
        const w = mkWiring(); const env = mkEnv(w.log);
        const run = mkRun([{ id: 'a', tool: 'merge_pdfs' }, { id: 'b', tool: 'local_uml_design' }, { id: 'c', tool: 'merge_pdfs', bind: { x: { from: { type: 'step', ref: 'a' } } } }, { id: 'd', tool: 'local_uml_design' }]);
        await M._planLoraWrap.call(w.self, run, env, '混合', w.prog);
        const order = run.steps.map((s) => s.id).join('');
        check('重排：相依的 c 仍在 a 之後，最後一步 d 不動', run.steps.findIndex((s) => s.id === 'c') > run.steps.findIndex((s) => s.id === 'a') && order[order.length - 1] === 'd', order);
    }

    // 6c) _llmGenerate：有 _loraStepPin 時沿用，不再路由、不切換
    {
        const calls = []; const acq = [];
        const self = mkSelf({
            _loraStepPin: ['d-r4'], _loraTurnReg: { acquire: (id) => acq.push('acq:' + id), release: (id) => acq.push('rel:' + id) },
            _loraRouteTurn: async () => { calls.push('route'); return null; },
            _loraSwitch: async (r) => { calls.push('switch'); return r; },
            _llmGenerateInner: async () => { calls.push('gen'); return 'OK'; },
        });
        const out = await M._llmGenerate.call(self, {}, { task: 'plan', messages: [] }, {});
        check('_llmGenerate：沿用計畫組合，不路由不切換', out === 'OK' && calls.join(',') === 'gen', calls);
        check('_llmGenerate：沿用的 LoRA 生成期間 acquire、結束 release', acq.join(',') === 'acq:d-r4,rel:d-r4', acq);
        const self2 = mkSelf({ _loraStepPin: undefined, _loraTurnReg: null, _loraRouteTurn: async () => { calls.push('route2'); return null; }, _llmGenerateInner: async () => 'OK2' });
        calls.length = 0; await M._llmGenerate.call(self2, {}, { task: 'plan', messages: [] }, {});
        check('沒有計畫組合時照舊：依任務類型路由', calls.join(',') === 'route2', calls);
    }

    console.log('lora_plan 測試：' + ok + ' 通過，' + bad + ' 失敗');
    if (bad) process.exitCode = 1;
})().catch((e) => { console.error(e); process.exitCode = 1; });
