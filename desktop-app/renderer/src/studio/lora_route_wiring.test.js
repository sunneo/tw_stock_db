// node renderer/src/studio/lora_route_wiring.test.js
// 行為測試（取代原本的 regex 接線檢查）：從 floating-assistant.js 抽出真正的方法本體，放進 vm 沙箱，用假的 this 執行。
// 涵蓋：_loraRouteTurn、_llmGenerate、_planModel（任務類型 → 登錄表 → acquire／release）；
// 以及三個原本藏在閉包外層方法裡的呼叫點（_unitCatalogEvalStep：選單 colu、工具參數 toolcall；_umlModel：UML 拆解 decompose；
// _omToolBench：工具階段 toolcall）。這些外層方法整個執行，只替換 UI、儲存與模型本體，檢查實際送進 _llmGenerate 的任務類型。
const fs = require('fs'); const path = require('path'); const vm = require('vm');
const Rt = require('./lora_route_core.js');
const SRC = fs.readFileSync(path.join(__dirname, '..', 'floating-assistant.js'), 'utf8');
let ok = 0, bad = 0; const check = (n, c, x) => { if (c) ok++; else { bad++; console.log('FAIL ' + n + (x === undefined ? '' : ' ' + JSON.stringify(x).slice(0, 240))); } };

(async () => {
// 抽出類別內的一個方法（4 個空白縮排的方法宣告），回傳整段原始碼（含 async 與本體）
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
// 放進沙箱：回傳 { 方法名: 函式 }，this 之後用 .call(假的 this) 綁定
function loadMethods(names, globals) {
    const ctx = Object.assign({ console, Promise }, globals || {}); vm.createContext(ctx);
    const obj = vm.runInContext('({' + names.map(methodSource).join(',\n') + '})', ctx);
    return obj;
}

// ---- 1) _loraRouteTurn：任務類型 → 真的 routeTurn → 登錄表 resolve（領域＋這一輪的話）----
{
    const calls = [];
    const reg = { resolve: async (q) => { calls.push(q); return { active: ['decomp-r4'], handles: [{ id: 'decomp-r4' }], skipped: [] }; } };
    const M = loadMethods(['_loraRouteTurn'], { FaStudio: { FaLoraRoute: Rt } });
    const self = { _studioDesktop: () => true, _studioStoreSync: {}, _loraCore: () => ({ registry: async () => reg }), _loraTurnReg: null, _loraTurnState: null };
    const r = await M._loraRouteTurn.call(self, 'toolcall', '幫我把這段拆成 UML');
    check('工具任務走真的 routeTurn：領域 toolcall、文字一併交給登錄表', calls.length === 1 && calls[0].domains[0] === 'toolcall' && calls[0].text === '幫我把這段拆成 UML', calls);
    check('登錄表有可用 adapter → fallback lora 且 active 帶回', r && r.fallback === 'lora' && r.active[0] === 'decomp-r4', r);
    check('登錄表記到 this（生成時要 acquire 用）', self._loraTurnReg === reg);
    const n0 = calls.length;
    check('task 為 null → 直接 null，不碰登錄表', (await M._loraRouteTurn.call(self, null, 'x')) === null && calls.length === n0);
    check('非桌面版 → 直接 null', (await M._loraRouteTurn.call(Object.assign({}, self, { _studioDesktop: () => false }), 'colu', 'x')) === null && calls.length === n0);
    const unk = await M._loraRouteTurn.call(self, 'chitchat', '哈囉');
    check('未知任務 → 基底，不查登錄表', unk && unk.fallback === 'base' && calls.length === n0, unk);
    const bad2 = Object.assign({}, self, { _loraCore: () => ({ registry: async () => ({ resolve: async () => { throw new Error('壞掉'); } }) }) });
    const rb = await M._loraRouteTurn.call(bad2, 'plan', '規劃');
    check('登錄表 resolve 丟錯 → 基底（不往外拋）', rb && rb.fallback === 'base' && /壞掉/.test(rb.reason), rb);
    const noStore = { _studioDesktop: () => true, _studioStoreSync: null, _studioStorage: async () => { throw new Error('no store'); }, _loraCore: () => ({ registry: async () => reg }) };
    check('儲存層準備失敗 → 直接 null（不靜默拿到空登錄表）', (await M._loraRouteTurn.call(noStore, 'colu', 'x')) === null);
}

// ---- 2) _llmGenerate：路由文字取最後一則 user、生成前 acquire、生成後 release、錯誤路徑 ----
{
    const log = [];
    const reg = { acquire: (id) => log.push('acq:' + id), release: (id) => log.push('rel:' + id) };
    const M = loadMethods(['_llmGenerate']);
    const base = {
        _loraRouteTurn: async (task, text) => { log.push('route:' + task + ':' + text); return { active: ['colu-r4'], fallback: 'lora' }; },
        _loraSwitch: async (r) => r,
        _llmGenerateInner: async (model, a) => { log.push('inner:' + model + ':' + a.task); return 'OK'; },
        _loraTurnReg: reg,
    };
    const msgs = [{ role: 'system', content: 's' }, { role: 'user', content: '第一句' }, { role: 'assistant', content: '回' }, { role: 'user', content: '第二句' }];
    log.length = 0;
    const out = await M._llmGenerate.call(base, 'm1', { task: 'colu', messages: msgs }, {});
    check('路由用最後一則 user 訊息當文字', log[0] === 'route:colu:第二句', log);
    check('順序：路由 → acquire → 生成 → release', log.join('|') === 'route:colu:第二句|acq:colu-r4|inner:m1:colu|rel:colu-r4', log);
    check('回傳生成結果', out === 'OK', out);
    log.length = 0;
    await M._llmGenerate.call(base, 'm1', { task: 'colu', text: '明確文字', messages: msgs }, {});
    check('a.text 優先於訊息內容', log[0] === 'route:colu:明確文字', log);
    log.length = 0;
    const throwing = Object.assign({}, base, { _llmGenerateInner: async () => { log.push('inner'); throw new Error('生成失敗'); } });
    let msg = null; try { await M._llmGenerate.call(throwing, 'm1', { task: 'toolcall', messages: msgs }, {}); } catch (e) { msg = e.message; }
    check('生成丟錯：錯誤照常往外拋，且仍 release', msg === '生成失敗' && log.join('|') === 'route:toolcall:第二句|acq:colu-r4|inner|rel:colu-r4', { msg, log });
    log.length = 0;
    const routeErr = Object.assign({}, base, { _loraRouteTurn: async () => { throw new Error('路由爛掉'); } });
    const r3 = await M._llmGenerate.call(routeErr, 'm1', { task: 'decompose', messages: msgs }, {});
    check('路由丟錯 → 基底生成照跑、不 acquire', r3 === 'OK' && log.join('|') === 'inner:m1:decompose', log);
}

// ---- 3) _planModel：呼叫端沒指定任務 → plan；UML 拆解傳 decompose；都經 _llmGenerate ----
{
    const seen = [];
    const ctx = {
        FaVlm: {
            routeStages: () => ({ answer: { id: 'm1' } }),
            resolveDevice: () => ({ order: ['cpu'], reason: '' }),
            estimateDownload: () => 0,
        },
    };
    const M = loadMethods(['_planModel'], ctx);
    const self = {
        _omSettings: () => ({ roles: {}, bench: {}, textModel: 'm1' }),
        _omInstalled: async () => ({ set: new Set(['m1']), usage: { byModel: {} } }),
        _omGpuInfo: async () => ({ available: false, f16: false }),
        _omDevicePrefOf: () => 'auto',
        _llmGenerate: async (model, a) => { seen.push({ model: model.id, task: a.task, tools: a.tools }); return 'R'; },
    };
    const plan = await M._planModel.call(self, {});
    const out1 = await plan.gen({ messages: [] });
    check('未指定任務 → plan（食譜規劃）', seen[0] && seen[0].task === 'plan' && seen[0].model === 'm1' && Array.isArray(seen[0].tools) && seen[0].tools.length === 0, seen);
    check('規劃生成的回傳值照常', out1 === 'R', out1);
    const dec = await M._planModel.call(self, { task: 'decompose' });
    await dec.gen({ messages: [] });
    check('opts.task=decompose → 傳 decompose 給路由', seen[1] && seen[1].task === 'decompose', seen);
    await dec.gen({ messages: [], task: 'colu' });
    check('呼叫端指定的 a.task 優先', seen[2] && seen[2].task === 'colu', seen);
}

// ---- 4) 原本是閉包內呼叫點的三處：整個外層方法執行，檢查實際送出的任務類型 ----
// 4a) _unitCatalogEvalStep：選單評量（colu）與工具參數評量（toolcall，預填 "{"）
{
    const calls = [];
    const SEL = {
        retrieve: () => [], buildCandidates: () => [{ id: 'u1' }, { id: 'u2' }], selectionMessages: () => ['sel'],
        parseChoice: () => 1, argsMessages: () => ['args'], parseArgs: () => ({ a: 1 }), scoreArgs: () => ({ exact: true }),
    };
    const M = loadMethods(['_unitCatalogEvalStep'], { FaCatalogSelect: SEL });
    const self = {
        _unitCatalogEval: {
            i: 0, errors: 0, model: { id: 'm1' }, device: 'cpu', idxInt: {}, universe: [], byId: new Map([['u1', { id: 'u1' }]]),
            tasks: [
                { t: 'sel', c: { id: 'c1', query: 'q', kind: 'pos', truth: ['u1'] }, mode: 'none', k: 2 },
                { t: 'args', a: { unit: 'u1', query: 'q2', expected: { a: 1 } } },
            ],
            rows: [], argRows: [], failures: [],
        },
        _llmGenerate: async (model, a) => { calls.push({ model: model.id, task: a.task, prefill: a.prefill }); return a.task === 'colu' ? '1' : '{"a":1}'; },
    };
    const out = await M._unitCatalogEvalStep.call(self, 5, {});
    check('選單評量的生成呼叫帶 task=colu', calls[0] && calls[0].task === 'colu' && calls[0].model === 'm1', calls);
    check('工具參數評量的生成呼叫帶 task=toolcall，並預填 "{"', calls[1] && calls[1].task === 'toolcall' && calls[1].prefill === '{', calls);
    check('兩段都有結果列、進度推進到底', self._unitCatalogEval.rows.length === 1 && self._unitCatalogEval.argRows.length === 1 && out.done === 2, out);
}
// 4b) _umlModel（離線）：經真的 _planModel → _llmGenerate，任務必須是 decompose
{
    const seen = [];
    const ctx = { FaVlm: { routeStages: () => ({ answer: { id: 'm1' } }), resolveDevice: () => ({ order: ['cpu'], reason: '' }), estimateDownload: () => 0 } };
    const M = loadMethods(['_umlModel', '_planModel'], ctx);
    const self = {
        _umlOnlineRow: () => null,
        _omSettings: () => ({ roles: {}, bench: {}, textModel: 'm1' }),
        _omInstalled: async () => ({ set: new Set(['m1']), usage: { byModel: {} } }),
        _omGpuInfo: async () => ({ available: false, f16: false }),
        _omDevicePrefOf: () => 'auto',
        _llmGenerate: async (model, a) => { seen.push({ model: model.id, task: a.task }); return 'R'; },
    };
    self._planModel = (o) => M._planModel.call(self, o); // 呼叫端 this._planModel 指到真的方法
    const off = await M._umlModel.call(self, 'offline');
    check('UML 離線拆解取得可用的模型（沒有錯誤、標示離線模型）', off && off.label === '離線模型' && off.error === undefined, off);
    const out = await off.gen({ messages: [] });
    check('UML 離線拆解的生成帶 task=decompose 並回傳生成結果', seen[0] && seen[0].task === 'decompose' && seen[0].model === 'm1' && out === 'R', seen);
}
// 4c) _omToolBench：工具階段基準，每一題都以 toolcall 生成
{
    const calls = [];
    const FaVlmStub = {
        byId: () => ({ id: 'm2', label: 'M2', task: 'text-generation', toolCalling: true, repo: 'x/y' }),
        resolveDevice: () => ({ order: ['cpu'], reason: '' }), estimateDownload: () => 0, fmtBytes: () => '0',
        compactToolSpecs: (t) => t, BENCH_TOOLS: [], BENCH_CASES: [{ id: 'b1', user: 'u1' }, { id: 'b2', user: 'u2' }],
        TOOL_STAGE_SYSTEM: 'SYS', scoreToolCase: () => ({ ok: false, reason: '未通過' }),
        summarizeToolBench: (rs) => ({ passed: 0, total: rs.length, label: 'L' }),
    };
    const M = loadMethods(['_omToolBench'], { FaVlm: FaVlmStub });
    const self = {
        advancedSettings: { offlineToolBench: {} }, _omLastDevice: {},
        _omGpuInfo: async () => ({ available: false, f16: false }),
        _omDevicePrefOf: () => 'auto',
        _omInstalled: async () => ({ usage: { byModel: {} } }),
        _createProgressWidget: () => ({ update() {}, log() {}, finish() {}, fail() {} }),
        _saveAdvancedSettings: () => {},
        _llmGenerate: async (m, a) => { calls.push({ model: m.id, task: a.task }); return ''; },
    };
    const r = await M._omToolBench.call(self, 'm2', null);
    check('工具階段基準：兩題都以 task=toolcall 生成', calls.length === 2 && calls.every((c) => c.task === 'toolcall' && c.model === 'm2'), calls);
    check('工具階段基準完成並回傳 ok', r && r.ok === true && r.result && r.result.total === 2, r);
}

// 路由核心認得四種任務（純函式）
for (const [t, d] of [['colu', 'colu'], ['toolcall', 'toolcall'], ['plan', 'plan'], ['decompose', 'decompose']]) check('taskDomain ' + t, Rt.taskDomain(t) === d);
check('未知任務回 null（走基底）', Rt.taskDomain('chitchat') === null);

})().then(() => { console.log(ok + ' passed, ' + bad + ' failed'); process.exit(bad ? 1 : 0); }, (e) => { console.error(e); process.exit(1); });
