// node renderer/src/studio/llm_export_core.test.js
const E = require('./llm_export_core.js'), PL = require('./pipeline_core.js');
let ok = 0, bad = 0; const check = (n, c, x) => { if (c) ok++; else { bad++; console.log('FAIL', n, x === undefined ? '' : JSON.stringify(x).slice(0, 300)); } };
const ALL = { optimum: { found: true }, onnxruntime: { found: true }, llamaCpp: { found: true }, peft: { found: true } };

// ---- 步驟表 ----
check('格式只有 ONNX 與 GGUF', JSON.stringify(E.FORMATS) === '["onnx","gguf"]');
check('ONNX 用 q8、GGUF 用 q8_0', E.EXPORT_PLANS.onnx.quant === 'q8' && E.EXPORT_PLANS.gguf.quant === 'q8_0');
check('兩個格式都是 合併→轉換→量化→核對→寫入 五步', ['onnx', 'gguf'].every((f) => E.EXPORT_PLANS[f].steps.map((s) => s.id).join(',') === 'merge,convert,quantize,verify,pack'));
check('執行器腳本都已寫（runner=true）', ['onnx', 'gguf'].every((f) => E.EXPORT_PLANS[f].steps.every((s) => s.runner === true && s.script)));

// ---- 計畫：缺工具要分開說清楚 ----
const none = E.exportPlan('onnx', {});
check('沒有工具：轉換步驟是「缺工具」，寫出工具名稱', none.steps.find((s) => s.id === 'convert').state === '缺工具' && /optimum/.test(none.steps.find((s) => s.id === 'convert').blocker));
check('沒有工具：pack 不需外部工具，是「待做」', none.steps.find((s) => s.id === 'pack').state === '待做');
check('沒有工具：計畫不可用，阻礙清單含四個缺工具步驟', none.ready === false && none.blockers.length === 4, none);
const withTools = E.exportPlan('onnx', ALL);
check('工具都找到：全部待做、ready=true', withTools.ready === true && withTools.steps.every((s) => s.state === '待做'), withTools);
check('未知格式回錯誤', E.exportPlan('safetensors', {}).ok === false);

// ---- 可用性與原因 ----
const av0 = E.exportAvailability({});
check('沒有工具：兩個格式都不可用，原因是缺工具並列出名稱', av0.onnx.available === false && /缺工具：/.test(av0.onnx.reason) && /optimum/.test(av0.onnx.reason) && av0.gguf.available === false && /llama\.cpp/.test(av0.gguf.reason), av0);
const av1 = E.exportAvailability(ALL);
check('工具都找到：兩個格式都可用、原因為空', av1.onnx.available === true && av1.gguf.available === true && av1.onnx.reason === '' && av1.gguf.reason === '', av1);
const avNoPeft = E.exportAvailability({ optimum: { found: true }, onnxruntime: { found: true }, llamaCpp: { found: true } });
check('沒有 peft：合併步驟缺工具，兩格式都不可用', avNoPeft.onnx.available === false && avNoPeft.gguf.available === false && avNoPeft.onnx.missingTools.join() === 'peft', avNoPeft);
check('只有 llama.cpp 時 GGUF 的缺工具清單只剩 peft', E.exportAvailability({ llamaCpp: { found: true } }).gguf.missingTools.join() === 'peft');

// ---- 偵測 ----
const pr = E.probeExportTools((n) => (n === 'optimum' ? { found: true, version: '1.2.3', path: '/x/optimum-cli' } : { found: false, reason: '找不到 ' + n }));
check('偵測：找到的工具帶版本與路徑', pr.optimum.found === true && pr.optimum.version === '1.2.3' && pr.optimum.path === '/x/optimum-cli');
check('偵測：沒找到的工具帶原因', pr.llamaCpp.found === false && /找不到 llamaCpp/.test(pr.llamaCpp.reason));
check('偵測：沒有偵測函式＝全部沒找到', E.probeExportTools(null).optimum.found === false);
check('偵測：偵測函式丟例外不影響其他工具', (() => { const s = E.probeExportTools((n) => { if (n === 'optimum') throw new Error('boom'); return { found: true }; }); return s.optimum.found === false && /boom/.test(s.optimum.reason) && s.onnxruntime.found === true; })());

// ---- 與流程核心接上 ----
check('流程核心：工具沒找到時格式預設是 null', PL.pickExportFormat('desktop', E.exportCapsFrom({})).default === null);
check('流程核心：工具都找到時 ONNX 可選', E.exportCapsFrom(ALL).onnxExport === true);

// ---- 命令組裝 ----
const dirs = { pyTrain: '/t/py', pyExport: '/e/py', scriptsDir: '/s', baseDir: '/b', adapterDir: '/a', workDir: '/w', outDir: '/w/o', llamaDir: '/l/bin', llamaSrc: '/l', recipe: 'full' };
const cOnnx = E.buildStepCommands('onnx', dirs);
check('ONNX 命令：五步、順序正確', cOnnx.ok && cOnnx.steps.map((s) => s.id).join(',') === 'merge,convert,quantize,verify,pack', cOnnx);
check('ONNX merge 用訓練環境、輸出到 workDir/merged', cOnnx.steps[0].argv[0] === '/t/py' && cOnnx.steps[0].argv.join(' ').includes('--output_dir /w/merged'));
check('ONNX convert 用匯出環境，--model 指向合併結果、tokenizer 指向基底', cOnnx.steps[1].argv[0] === '/e/py' && cOnnx.steps[1].argv.join(' ').includes('--model /w/merged --tokenizer /b'));
check('ONNX quantize 帶 recipe', cOnnx.steps[2].argv.join(' ').includes('--recipe full') && cOnnx.steps[2].argv.join(' ').includes('--step quantize'));
const cGguf = E.buildStepCommands('gguf', dirs);
check('GGUF convert 帶 llama 原始碼根與 tokenizer', cGguf.ok && cGguf.steps[1].argv.join(' ').includes('--llama_src /l') && cGguf.steps[1].argv.join(' ').includes('--tokenizer /b'));
check('GGUF quantize 帶 llama bin 資料夾', cGguf.steps[2].argv.join(' ').includes('--llama_dir /l/bin'));
const cMiss = E.buildStepCommands('gguf', { workDir: '/w' });
check('缺路徑：回錯誤並列出缺的欄位', cMiss.ok === false && /缺 pyTrain/.test(cMiss.error) && /缺 llamaSrc/.test(cMiss.error), cMiss);
check('未知格式命令：回錯誤', E.buildStepCommands('safetensors', dirs).ok === false);

// ---- 執行器（注入假的 runner，不真的跑） ----
const okLine = (step) => JSON.stringify({ step, ok: true, bytes: 1 });
(async () => {
    const seen = [];
    const fakeOk = async (argv, id) => { seen.push(id); return { code: 0, stdout: 'noise\n' + okLine(id) + '\n', stderr: '' }; };
    const r1 = await E.runExportSteps(cOnnx, fakeOk, { onEvent: () => {} });
    check('執行器：全部成功 → ok=true、每步完成、順序照命令', r1.ok === true && r1.steps.every((s) => s.state === '完成') && seen.join(',') === 'merge,convert,quantize,verify,pack', r1);
    const fakeFail = async (argv, id) => (id === 'quantize' ? { code: 1, stdout: JSON.stringify({ step: 'quantize', ok: false, error: 'RuntimeError: x' }), stderr: '' } : { code: 0, stdout: okLine(id), stderr: '' });
    const r2 = await E.runExportSteps(cOnnx, fakeFail);
    check('執行器：中途失敗 → 停止，後面標「未執行」，failedAt 正確', r2.ok === false && r2.failedAt === 'quantize' && r2.steps.find((s) => s.id === 'quantize').error === 'RuntimeError: x' && r2.steps.filter((s) => s.state === '未執行').length === 2, r2);
    const r3 = await E.runExportSteps(cOnnx, async () => ({ code: 0, stdout: 'no json here', stderr: 'boom' }));
    check('執行器：退出碼 0 但沒有 JSON 結果 → 視為失敗，錯誤取 stderr 尾端', r3.ok === false && /boom/.test(r3.steps[0].error), r3);
    const r4 = await E.runExportSteps(cOnnx, async () => { throw new Error('spawn ENOENT'); });
    check('執行器：runner 丟例外 → 記成失敗，不往外丟', r4.ok === false && /ENOENT/.test(r4.steps[0].error), r4);
    const events = [];
    await E.runExportSteps({ format: 'onnx', steps: cOnnx.steps.slice(0, 2) }, fakeOk, { onEvent: (e) => events.push(e.type) });
    check('執行器：事件順序 start/end 成對', events.join(',') === 'step-start,step-end,step-start,step-end', events);
    // 續跑：skip 的步驟不執行；停止要求在步驟之間生效（剩下的標未執行、done 只含已完成）
    const ran = [];
    const rSkip = await E.runExportSteps(cOnnx, async (argv, id) => { ran.push(id); return { code: 0, stdout: okLine(id), stderr: '' }; }, { skip: new Set(['merge', 'convert']) });
    check('續跑：skip 的步驟不執行，標「略過（已完成）」，其餘照跑', ran.join(',') === 'quantize,verify,pack' && rSkip.steps[0].state === '略過（已完成）' && rSkip.ok === true && rSkip.done.join() === 'merge,convert,quantize,verify,pack', rSkip);
    const ran2 = [];
    let stopAfter = 1, calls = 0;
    const rStop = await E.runExportSteps(cOnnx, async (argv, id) => { ran2.push(id); return { code: 0, stdout: okLine(id), stderr: '' }; }, { isStopRequested: () => ran2.length >= stopAfter });
    check('暫停：要求停止後不再開新步驟，剩下標未執行，stopped=true、ok=false', ran2.join() === 'merge' && rStop.stopped === true && rStop.ok === false && rStop.steps[4].state === '未執行' && rStop.done.join() === 'merge', rStop);
    void calls;
    const rInt = await E.runExportSteps(cOnnx, async (argv, id) => (id === 'convert' ? { code: -15, stdout: '', stderr: 'killed' } : { code: 0, stdout: okLine(id), stderr: '' }), { isStopRequested: () => false });
    check('失敗（非停止）仍是失敗', rInt.failedAt === 'convert' && rInt.stopped === false, rInt);
    let stopNow = false;
    const rInt2 = await E.runExportSteps(cOnnx, async (argv, id) => { if (id === 'convert') stopNow = true; return id === 'convert' ? { code: -15, stdout: '', stderr: 'killed' } : { code: 0, stdout: okLine(id), stderr: '' }; }, { isStopRequested: () => stopNow });
    check('被要求停止時中斷的步驟標「中斷」、不算失敗、後面不開始', rInt2.stopped === true && rInt2.failedAt === null && rInt2.steps[1].state === '中斷' && rInt2.steps[2].state === '未執行' && rInt2.done.join() === 'merge', rInt2);
    check('parseStepResult：取最後一行有效 JSON', E.parseStepResult('{"step":"a","ok":false}\n{"step":"b","ok":true}').step === 'b' && E.parseStepResult('x') === null);

    // ---- 訓練模式 ----
    check('LoRA 模式已實作', E.trainModePlan('lora').implemented === true && E.trainModePlan('lora').blocker === '');
    const full = E.trainModePlan('full');
    check('完整微調：有腳本（implemented=true），說明只跑過 smoke', full.implemented === true && /smoke/.test(full.note), full);
    check('未知訓練模式回錯誤', E.trainModePlan('dpo').ok === false);

    // exportCapsFrom
    check('exportCapsFrom 沒有工具：兩格式都 false', E.exportCapsFrom({}).onnxExport === false && E.exportCapsFrom({}).ggufExport === false);
    check('exportCapsFrom 收到 undefined 不丟例外', E.exportCapsFrom(undefined).ggufExport === false);

    console.log(ok + ' passed, ' + bad + ' failed');
    process.exit(bad ? 1 : 0);
})();
