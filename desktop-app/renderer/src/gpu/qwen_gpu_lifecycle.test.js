// node renderer/src/gpu/qwen_gpu_lifecycle.test.js
// GPU 引擎的生命週期（floating-assistant.js 的 _qwenGpuRelease／_qwenGpuIdleArm／_qwenGpuIdleMs，以及 ORT Worker 的 _vlmScheduleIdle／_vlmTerminate）：
// 閒置到時 destroy 引擎與 GPUDevice；換模型先卸載舊的；出錯後重建不殘留；閒置上限 60 秒（政策較短就用較短的）。
// 全部是假裝置、假引擎、假 Worker：只驗證生命週期邏輯，不量真 GPU 記憶體（真 GPU 使用者說不用驗）。
const fs = require('fs'); const path = require('path'); const vm = require('vm');
const SRC = fs.readFileSync(path.join(__dirname, '..', 'floating-assistant.js'), 'utf8');
let ok = 0, bad = 0; const check = (n, c, x) => { if (c) ok++; else { bad++; console.log('FAIL ' + n + (x === undefined ? '' : ' ' + JSON.stringify(x).slice(0, 240))); } };

function methodSource(name) {
    const re = new RegExp('\\n    (async )?' + name + '\\(');
    const m = re.exec(SRC); if (!m) throw new Error('找不到方法 ' + name);
    const nxt = /\n    (async )?[_a-zA-Z][_a-zA-Z0-9]*\(/g; nxt.lastIndex = m.index + m[0].length; const n = nxt.exec(SRC);
    const chunk = SRC.slice(m.index + 1, n ? n.index : SRC.length); const close = chunk.lastIndexOf('}');
    return chunk.slice(0, close + 1);
}
const NAMES = ['_qwenGpuRelease', '_qwenGpuIdleMs', '_qwenGpuIdleArm', '_vlmScheduleIdle', '_vlmTerminate'];
// 每次載入一組方法（timers 可以換成假的，驗證實際排的毫秒數）
function load(timers) {
    const ctx = Object.assign({ console, Promise, Map, Math, Number, String, Object, Array, Error, JSON }, timers || { setTimeout, clearTimeout });
    vm.createContext(ctx);
    return vm.runInContext('({' + NAMES.map(methodSource).join(',\n') + '})', ctx);
}
const M = load();
// 假的 GPUDevice／引擎：記錄 destroy 次數
function dev(name) { const d = { name, destroyed: 0 }; d.destroy = () => { d.destroyed++; }; return d; }
function eng(name) { const e = { name, destroyed: 0 }; e.destroy = () => { e.destroyed++; }; return e; }
function self(extra) { return Object.assign({ _qwenChat: null, _qwenEng: null, _qwenIdleTimer: null, _envPolicy: () => ({ idleMs: 600000, unloadAfterTask: false }) }, M, extra || {}); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
    // 1. 換模型：舊的 _qwenChat 與 _qwenEng 全部 destroy（引擎與 GPUDevice 各一次），快取清空；再呼叫一次不重複 destroy
    {
        const s = self(); const eA = eng('A'), dA = dev('A'), eB = eng('B'), dB = dev('B');
        s._qwenChat = { key: 'A', engine: eA, dev: dA, tok: {} };
        s._qwenEng = new Map([['modelB', { engine: eB, dev: dB, timeoutMs: 20000 }]]);
        s._qwenGpuRelease('換模型');
        check('1 舊 chat 的引擎 destroy 一次', eA.destroyed === 1, eA.destroyed);
        check('1 舊 chat 的 GPUDevice destroy 一次', dA.destroyed === 1, dA.destroyed);
        check('1 準備好的另一個模型引擎也 destroy', eB.destroyed === 1 && dB.destroyed === 1, [eB.destroyed, dB.destroyed]);
        check('1 兩個快取都清空', s._qwenChat === null && s._qwenEng.size === 0, [s._qwenChat, s._qwenEng.size]);
        check('1 記下卸載原因', s._qwenReleaseLast && s._qwenReleaseLast.reason === '換模型', s._qwenReleaseLast);
        s._qwenGpuRelease('再一次');
        check('1 重複卸載不重複 destroy', eA.destroyed === 1 && dA.destroyed === 1 && eB.destroyed === 1, [eA.destroyed, dA.destroyed]);
    }
    // 2. 閒置到時自動卸載：政策 idleMs 很短（30 ms）→ 到時引擎與 GPUDevice 都 destroy，原因寫「閒置」
    {
        const s = self({ _envPolicy: () => ({ idleMs: 30 }) }); const e = eng('idle'), d = dev('idle');
        s._qwenChat = { key: 'I', engine: e, dev: d, tok: {} };
        s._qwenGpuIdleArm();
        check('2 閒置前還在', e.destroyed === 0 && s._qwenChat !== null);
        await sleep(90);
        check('2 閒置到時引擎 destroy', e.destroyed === 1, e.destroyed);
        check('2 閒置到時 GPUDevice destroy', d.destroyed === 1, d.destroyed);
        check('2 閒置原因', s._qwenReleaseLast && s._qwenReleaseLast.reason.startsWith('閒置'), s._qwenReleaseLast);
    }
    // 3. 閒置上限：預設 60 秒；政策 idleMs 較短就用較短（使用者只能調小）；Infinity／很長的政策也是 60 秒
    {
        const cases = [[undefined, 60000], [Infinity, 60000], [600000, 60000], [20000, 20000], [30000, 30000]];
        for (const [idle, want] of cases) {
            const s = self({ _envPolicy: () => ({ idleMs: idle }) });
            check('3 idleMs=' + idle + ' → ' + want, s._qwenGpuIdleMs() === want, s._qwenGpuIdleMs());
        }
        const s2 = self({ _envPolicy: () => { throw new Error('沒有政策'); } });
        check('3 沒有環境政策 → 60 秒', s2._qwenGpuIdleMs() === 60000, s2._qwenGpuIdleMs());
    }
    // 4. 閒置計時會被重設：第一次排的時間到之前又使用（重新 arm），不能在中途被卸載
    {
        const s = self({ _envPolicy: () => ({ idleMs: 80 }) }); const e = eng('re'), d = dev('re');
        s._qwenChat = { key: 'R', engine: e, dev: d, tok: {} };
        s._qwenGpuIdleArm(); await sleep(40); s._qwenGpuIdleArm();
        await sleep(60);
        check('4 重新排時間後，原本的時間點不卸載', e.destroyed === 0, e.destroyed);
        await sleep(120);
        check('4 最後的閒置時間到才卸載（一次）', e.destroyed === 1, e.destroyed);
    }
    // 5. 手動卸載會取消排著的閒置計時：卸載後不會因舊的計時再 destroy 一次
    {
        const s = self({ _envPolicy: () => ({ idleMs: 40 }) }); const e = eng('c'), d = dev('c');
        s._qwenChat = { key: 'C', engine: e, dev: d, tok: {} };
        s._qwenGpuIdleArm(); s._qwenGpuRelease('換模型');
        await sleep(80);
        check('5 卸載後舊計時不再觸發', e.destroyed === 1 && d.destroyed === 1, [e.destroyed, d.destroyed]);
        check('5 計時已清掉', s._qwenIdleTimer === null, s._qwenIdleTimer);
    }
    // 6. 出錯後重建不殘留：出錯時卸載舊的；之後建新的，新舊各只 destroy 一次，互不影響
    {
        const s = self(); const eOld = eng('old'), dOld = dev('old');
        s._qwenChat = { key: 'O', engine: eOld, dev: dOld, tok: {} };
        s._qwenGpuRelease('出錯');
        const eNew = eng('new'), dNew = dev('new');
        s._qwenChat = { key: 'O', engine: eNew, dev: dNew, tok: {} };
        s._qwenGpuRelease('閒置 60 秒');
        check('6 舊的只 destroy 一次', eOld.destroyed === 1 && dOld.destroyed === 1, [eOld.destroyed, dOld.destroyed]);
        check('6 新的也只 destroy 一次', eNew.destroyed === 1 && dNew.destroyed === 1, [eNew.destroyed, dNew.destroyed]);
    }
    // 7. 沒有引擎時卸載不丟錯（所有路徑都可以呼叫）
    {
        const s = self(); let threw = false; try { s._qwenGpuRelease('沒有東西'); } catch (_) { threw = true; }
        check('7 沒有引擎也能卸載', !threw && s._qwenChat === null && (!s._qwenEng || s._qwenEng.size === 0));
    }
    // 8. ORT Worker 的閒置：排的時間最多 60 秒（即使政策是 10 分鐘）；到時 _vlmTerminate 會 die 掉 worker
    {
        const captured = []; const cap = load({ setTimeout: (fn, ms) => { captured.push(ms); return 1; }, clearTimeout: () => {} });
        const s = Object.assign({ _vlmIdleTimers: {}, _envPolicy: () => ({ unloadAfterTask: false, idleMs: 600000 }) }, cap);
        s._vlmScheduleIdle('gpu');
        check('8 ORT 閒置上限 60 秒（政策 10 分鐘）', captured[0] === 60000, captured);
        const live = load();
        let died = 0;
        const s2 = Object.assign({ _vlmIdleTimers: {}, _vlmWks: { gpu: { die: () => { died++; } } }, _vlmLoadedBy: { gpu: { modelId: 'm' } }, _envPolicy: () => ({ unloadAfterTask: false, idleMs: 20 }) }, live);
        s2._vlmScheduleIdle('gpu');
        await sleep(70);
        check('8 閒置到時 ORT Worker 被終止', died === 1, died);
        check('8 載入記錄清掉', s2._vlmLoadedBy.gpu === null, s2._vlmLoadedBy);
    }

    console.log('qwen_gpu_lifecycle.test.js: ' + ok + ' passed, ' + bad + ' failed');
    process.exit(bad ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
