// node renderer/src/recipe/gpu_bench_gate.test.js
// GPU 量測閘門（_gpuBenchGate）：生成中不量（回原因）；沒有生成時先釋放 Qwen 引擎，再釋放 ORT 的 GPU 工作者（順序固定）。
// 從 floating-assistant.js 抽出真正的方法本體，用假的 this 驗證，不碰 GPU。
const fs = require('fs'); const path = require('path'); const vm = require('vm');
const SRC = fs.readFileSync(path.join(__dirname, '..', 'floating-assistant.js'), 'utf8');
let ok = 0, bad = 0; const check = (n, c, x) => { if (c) ok++; else { bad++; console.log('FAIL ' + n + (x === undefined ? '' : ' ' + JSON.stringify(x).slice(0, 300))); } };

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
const ctx = vm.createContext({ console });
const C = vm.runInContext('({' + methodSource('_gpuBenchGate') + '})', ctx);

function makeSelf(extra) {
    const calls = [];
    const self = Object.assign({
        _llmBusy: 0, _qwenBusy: 0,
        _qwenGpuRelease: (r) => calls.push('qwen:' + r),
        _vlmTerminate: (slot) => calls.push('ort:' + slot),
    }, extra || {});
    self._gpuBenchGate = C._gpuBenchGate.bind(self);
    return { self, calls };
}

// A. 生成中（摘要的 _llmGenerate 進行中）→ 不量，回原因，且不釋放任何東西
{
    const { self, calls } = makeSelf({ _llmBusy: 1 });
    const g = self._gpuBenchGate('偵測／基準');
    check('A 生成中不量：ok=false 並說明請等生成結束', g.ok === false && g.reason.includes('請等目前的生成結束') && g.reason.includes('偵測／基準'), g);
    check('A 生成中不釋放任何引擎（不影響正在跑的生成）', calls.length === 0, calls);
}
// B. Qwen GPU 解碼中 → 同樣不量
{
    const { self, calls } = makeSelf({ _qwenBusy: 1 });
    const g = self._gpuBenchGate('變體競賽');
    check('B Qwen GPU 生成中不量', g.ok === false && calls.length === 0, { g, calls });
}
// C. 沒有生成：先釋放 Qwen 引擎，再釋放 ORT GPU 工作者（順序固定）
{
    const { self, calls } = makeSelf();
    const g = self._gpuBenchGate('變體競賽');
    check('C 沒有生成時 ok=true', g.ok === true, g);
    check('C 釋放順序：先 Qwen 引擎與裝置，再 ORT 的 gpu 工作者', JSON.stringify(calls) === JSON.stringify(['qwen:量測前釋放（變體競賽）', 'ort:gpu']), calls);
}
// D. 生成結束後的計數歸零：之後可以量
{
    const { self } = makeSelf({ _llmBusy: 2 });
    self._llmBusy = 0;
    check('D 生成都結束後可以量', self._gpuBenchGate('偵測／基準').ok === true);
}

console.log(ok + ' passed, ' + bad + ' failed');
process.exit(bad ? 1 : 0);
