// node renderer/src/gpu/qwen_gpu_gate.test.js
// Qwen GPU 路徑的開關閘門（q8 的 qwenGpuDecode、q4f16 的 qwenGpuQ4）：失敗記錄（fa_gpu_broken:<feature>）必須擋住手動設成 on 的情況，
// 否則失敗後每次回答都會再撞一次；切換「GPU 加速」（_gpuBrokenClear）後才會重新啟用。方法本體從 floating-assistant.js 抽出來執行，localStorage 用假的。
const fs = require('fs'); const path = require('path'); const vm = require('vm');
const SRC = fs.readFileSync(path.join(__dirname, '..', 'floating-assistant.js'), 'utf8');
let ok = 0, bad = 0; const check = (n, c, x) => { if (c) ok++; else { bad++; console.log('FAIL ' + n + (x === undefined ? '' : ' ' + JSON.stringify(x).slice(0, 240))); } };

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

// 假的 localStorage（只有 getItem／setItem／removeItem／keys 用得到）
const store = new Map();
const localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    get length() { return store.size; },
    key: (i) => Array.from(store.keys())[i] || null,
};
Object.defineProperty(localStorage, 'length', { get: () => store.size });
// Object.keys(localStorage) 在假物件上取不到鍵，所以 _gpuBrokenClear 用的 keys 要靠 Proxy 補上
const storage = new Proxy(localStorage, { ownKeys: () => Array.from(store.keys()), getOwnPropertyDescriptor: (t, k) => (store.has(k) ? { value: store.get(k), enumerable: true, configurable: true, writable: true } : Reflect.getOwnPropertyDescriptor(t, k)) });

const names = ['_qwenGpuQ4On', '_qwenGpuDecodeOn', '_gpuAutoOn', '_gpuBrokenGet', '_gpuBrokenSet', '_gpuBrokenClear'];
const ctx = { console, Promise, localStorage: storage }; vm.createContext(ctx);
const M = vm.runInContext('({' + names.map(methodSource).join(',\n') + '})', ctx);

function make(settings) {
    const self = Object.assign({ advancedSettings: settings, _gpuAutoDec: null, _gpuAutoBusy: false, _gpuAutoProbe: () => {} }, { _qwenGpuQ4On: M._qwenGpuQ4On, _qwenGpuDecodeOn: M._qwenGpuDecodeOn, _gpuAutoOn: M._gpuAutoOn, _gpuBrokenGet: M._gpuBrokenGet, _gpuBrokenSet: M._gpuBrokenSet, _gpuBrokenClear: M._gpuBrokenClear });
    return self;
}

// 1. 手動 on、沒有失敗記錄：開
let s = make({ qwenGpuQ4: 'on', qwenGpuDecode: 'on', gpuAccel: 'off' });
check('q4 手動 on 沒有失敗記錄 → 開', s._qwenGpuQ4On() === true);
check('q8 手動 on 沒有失敗記錄 → 開', s._qwenGpuDecodeOn() === true);

// 2. 失敗記錄存在：即使手動 on 也要關（q4 與 q8 各自獨立）
s._gpuBrokenSet('qwenGpuQ4', 'GPU 解碼失敗：裝置遺失');
check('q4 有失敗記錄 → 關（手動 on 也一樣）', s._qwenGpuQ4On() === false);
check('q8 不受 q4 的失敗影響 → 仍開', s._qwenGpuDecodeOn() === true);
s._gpuBrokenSet('qwenGpuDecode', 'DXGI_ERROR_DEVICE_HUNG');
check('q8 有失敗記錄 → 關（手動 on 也一樣）', s._qwenGpuDecodeOn() === false);
check('失敗原因讀得回來', (s._gpuBrokenGet('qwenGpuDecode') || {}).why === 'DXGI_ERROR_DEVICE_HUNG');

// 3. 切換「GPU 加速」＝ _gpuBrokenClear：兩條都重新啟用
s._gpuBrokenClear();
check('清除失敗記錄後 q4 重新開', s._qwenGpuQ4On() === true);
check('清除失敗記錄後 q8 重新開', s._qwenGpuDecodeOn() === true);

// 4. 沒有手動設定、只靠 gpuAccel 自動：失敗記錄照樣擋（既有行為不變）
s = make({ qwenGpuQ4: undefined, qwenGpuDecode: undefined, gpuAccel: 'on' });
s._gpuAutoDec = { decision: { features: { qwenGpuQ4: { on: true }, qwenGpuDecode: { on: true } } } };
check('自動模式、沒失敗 → q4 開', s._qwenGpuQ4On() === true);
s._gpuBrokenSet('qwenGpuQ4', 'x');
check('自動模式、有失敗 → q4 關', s._qwenGpuQ4On() === false);
s._gpuBrokenClear();

// 5. 沒有任何設定：關
s = make({ gpuAccel: 'off' });
check('沒有設定 → q4 關', s._qwenGpuQ4On() === false);
check('沒有設定 → q8 關', s._qwenGpuDecodeOn() === false);

console.log('qwen_gpu_gate.test.js: ' + ok + ' passed, ' + bad + ' failed');
if (bad) process.exit(1);
