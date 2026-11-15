// 訓練工作室：「建立語言模型（從零開始）」與「加長上下文」在簡單模式第一步就選得到，選了會出現對應的執行面板（回歸測試）。
// 檢查：（1）範本內嵌腳本可解析；（2）模型類型清單有這兩項，且完整輸出可以跑；（3）選了類型時目前輸出會自動切到可用的那個（先前停在「LoRA 小檔」會被擋）；
// （4）執行面板的欄位與後端規格（ext_job_core）對得上（路徑鍵、參數鍵）；（5）簡單模式「你想做什麼？」有直接入口。
// 沒測到：真畫面的點擊與渲染（那要真桌面版驗證）。
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const MT = require('./model_types_core.js');
const EXT = require('./ext_job_core.js');

let ok = 0; const bad = [];
const check = (n, c, x) => { if (c) ok++; else { bad.push(n); console.log('FAIL', n, x === undefined ? '' : JSON.stringify(x).slice(0, 400)); } };

const tpl = fs.readFileSync(path.join(__dirname, 'studio-viewer.template.html'), 'utf8').replace(/\r\n/g, '\n');

// （1）內嵌腳本可解析
const scriptRe = /<script(?![^>]*\bsrc\b)[^>]*>([\s\S]*?)<\/script>/g;
let m, parseErr = null;
while ((m = scriptRe.exec(tpl))) { try { new Function(m[1]); } catch (e) { parseErr = parseErr || e; } }
check('template: inline scripts parse', !parseErr, parseErr && String(parseErr.message));

// （2）清單與可跑的輸出
const list = MT.listFor(false);
const ids = list.map((t) => t.id);
check('dropdown: llm_scratch offered', ids.indexOf('llm_scratch') >= 0, ids);
check('dropdown: context_extend offered', ids.indexOf('context_extend') >= 0, ids);
check('llm_scratch: full output runnable', MT.canStart('llm_scratch', 'full', false).ok === true, MT.canStart('llm_scratch', 'full', false));
check('context_extend: full output runnable', MT.canStart('context_extend', 'full', false).ok === true, MT.canStart('context_extend', 'full', false));

// （3）mtSet 會把輸出切到可用的那個：取範本裡的實際函式來跑
const pick = (re) => { const x = tpl.split('\n').find((l) => re.test(l)); if (!x) throw new Error('找不到 ' + re); return x; };
const helperLines = [
    pick(/^var MT_KEY=/), pick(/^var MT_MEM=/), pick(/^function lsGet\(/), pick(/^function lsSet\(/),
    pick(/^function mtOut\(/), pick(/^function mtOutSet\(/), pick(/^function mtSet\(/)
];
const ctx = { MTYPES: list }; vm.createContext(ctx);
let helperErr = null;
try { vm.runInContext(helperLines.join('\n') + '\n;this.__ok = true;', ctx); } catch (e) { helperErr = e; }
check('mt helpers from template run', !helperErr && ctx.__ok === true, helperErr && String(helperErr.message));
if (!helperErr) {
    check('default output is lora', ctx.mtOut() === 'lora', ctx.mtOut());
    ctx.mtSet('context_extend');
    check('select context_extend switches output to full', ctx.mtOut() === 'full', ctx.mtOut());
    ctx.mtSet('llm_scratch');
    check('select llm_scratch switches output to full', ctx.mtOut() === 'full', ctx.mtOut());
    ctx.mtSet('llm');
    const llmT = list.filter((t) => t.id === 'llm')[0];
    check('select llm keeps an output that llm offers and is available', !!llmT && llmT.outputs.some((x) => x.id === ctx.mtOut() && x.available), { out: ctx.mtOut(), outs: llmT && llmT.outputs.map((x) => [x.id, x.available]) });
}

// （4）執行面板與後端規格對得上
const extRunStart = tpl.indexOf('var EXT_RUN={');
const extRunEnd = tpl.indexOf('\n};', extRunStart);
let EXT_RUN = null, extErr = null;
try { EXT_RUN = vm.runInNewContext('(' + tpl.slice(extRunStart + 'var EXT_RUN='.length, extRunEnd + 2) + ')', {}); } catch (e) { extErr = e; }
check('EXT_RUN parses', !extErr && EXT_RUN && typeof EXT_RUN === 'object', extErr && String(extErr.message));
if (EXT_RUN) {
    check('EXT_RUN has context_extend', !!EXT_RUN.context_extend, Object.keys(EXT_RUN));
    check('EXT_RUN has llm_scratch', !!EXT_RUN.llm_scratch, Object.keys(EXT_RUN));
    const spec = EXT.SPECS.context_extend;
    const pathKeys = (EXT_RUN.context_extend.paths || []).map((p) => p.k).sort();
    const specKeys = spec.paths.map((p) => p.key).sort();
    check('context_extend path keys match backend spec', JSON.stringify(pathKeys) === JSON.stringify(specKeys), { pathKeys, specKeys });
    const fieldKeys = (EXT_RUN.context_extend.fields || []).map((f) => f.k);
    check('context_extend field keys are backend params', fieldKeys.every((k) => Object.prototype.hasOwnProperty.call(spec.defaults, k)), { fieldKeys, defaults: Object.keys(spec.defaults) });
    check('context_extend default steps is within limits', EXT_RUN.context_extend.steps >= spec.limits.steps[0] && EXT_RUN.context_extend.steps <= spec.limits.steps[1], EXT_RUN.context_extend.steps);
    check('llm_scratch backend spec registered', !!EXT.SPECS.llm_scratch, Object.keys(EXT.SPECS));
    check('llm_scratch EXT_RUN has a stage line', /匯出 ONNX/.test(tpl) && /重新載入核對/.test(tpl), null);
}

// （5）簡單模式「你想做什麼？」有直接入口
check('intent step: llm_scratch card', tpl.indexOf("['llm_scratch','🧱 建立語言模型（從零開始）'") >= 0, null);
check('intent step: context_extend card', tpl.indexOf("['context_extend','📏 加長上下文（語言模型）'") >= 0, null);
check('run panel: back button to ordinary training', tpl.indexOf('← 改回一般訓練（語言模型）') >= 0, null);
check('wizard: draw has an error boundary', tpl.indexOf('function draw(){var t0=Date.now();drawInner()') >= 0, null);

console.log('train_types_visible: ' + ok + ' 通過，' + bad.length + ' 失敗');
process.exit(bad.length ? 1 : 0);
