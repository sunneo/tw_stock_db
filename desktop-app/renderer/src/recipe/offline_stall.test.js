// node renderer/src/recipe/offline_stall.test.js
// 離線生成的卡死偵測（_llmGenerate 的包裝）：只在「完全沒有新詞元、也沒有載入進度」才終止工作者；有詞元或載入進度就一直等。
// 從 floating-assistant.js 抽出真正的方法本體，用假的 this 與假的核心呼叫驗證，不碰 GPU。
const fs = require('fs'); const path = require('path'); const vm = require('vm');
const SRC = fs.readFileSync(path.join(__dirname, '..', 'floating-assistant.js'), 'utf8');
let ok = 0, bad = 0; const check = (n, c, x) => { if (c) ok++; else { bad++; console.log('FAIL ' + n + (x === undefined ? '' : ' ' + JSON.stringify(x).slice(0, 300))); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
const ctx = vm.createContext({ console, setTimeout, clearTimeout });
const C = vm.runInContext('({' + methodSource('_llmGenerate') + '})', ctx);

// 假的核心：收到的 cb 會在 script 指定的時間點呼叫 onToken／update；終止工作者（_vlmTerminate）會讓它以錯誤結束，就像真的 worker 被殺掉
function makeSelf(script) {
    const calls = { terminate: 0 };
    const self = { _llmBusy: 0 };
    self._vlmTerminate = () => { calls.terminate++; if (self._kill) self._kill(new Error('worker 已終止')); };
    self._llmGenerateCore = (model, a, cb) => new Promise((resolve, reject) => {
        self._kill = reject;
        script(cb, resolve, reject);
    });
    self._llmGenerate = C._llmGenerate.bind(self);
    return { self, calls };
}

(async () => {
    // A. 完全沒有詞元、也沒有載入進度 → 超過門檻就終止（以錯誤結束）
    {
        const { self, calls } = makeSelf(() => {});
        let err = null; const t0 = Date.now();
        try { await self._llmGenerate({}, { stallMs: 60 }, {}); } catch (e) { err = e; }
        check('A 完全沒有進度：門檻到了就終止工作者', calls.terminate === 1 && err && /worker/.test(err.message), { calls, err: err && err.message });
        check('A 中斷時間接近門檻（不是無限等）', Date.now() - t0 < 1000, Date.now() - t0);
        check('A 結束後忙碌計數歸零', self._llmBusy === 0, self._llmBusy);
    }
    // B. 慢但持續出詞元（每 20 毫秒一個，總長 300 毫秒，門檻 80 毫秒）→ 不中斷，正常完成
    {
        const { self, calls } = makeSelf((cb, resolve) => {
            let n = 0; const iv = setInterval(() => { cb.onToken('字' + n); n++; if (n === 15) { clearInterval(iv); resolve('完成'); } }, 20);
        });
        const out = await self._llmGenerate({}, { stallMs: 80 }, { onToken() {} });
        check('B 慢但持續出詞元：不中斷、正常完成', out === '完成' && calls.terminate === 0, { out, calls });
    }
    // C. 載入有進度（update 每 20 毫秒）但還沒有詞元 → 也不中斷
    {
        const { self, calls } = makeSelf((cb, resolve) => {
            let n = 0; const iv = setInterval(() => { cb.update({ status: 'download', pct: n }); n++; if (n === 15) { clearInterval(iv); resolve('載入完成'); } }, 20);
        });
        const out = await self._llmGenerate({}, { stallMs: 80 }, { update() {} });
        check('C 載入有進度：不中斷', out === '載入完成' && calls.terminate === 0, { out, calls });
    }
    // D. 沒有 stallMs 的呼叫：不設卡死偵測（不會被終止）
    {
        const { self, calls } = makeSelf((cb, resolve) => { setTimeout(() => resolve('慢完成'), 150); });
        const out = await self._llmGenerate({}, {}, {});
        check('D 沒有設 stallMs：不套用卡死偵測', out === '慢完成' && calls.terminate === 0, { out, calls });
    }

    console.log(ok + ' passed, ' + bad + ' failed');
    process.exit(bad ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
