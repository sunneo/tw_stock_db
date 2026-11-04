// 原生 vs WASM 交錯量測的驅動程式（Node，在本機 node 執行，只負責發號與記錄，不做推論）。
// 流程：啟動 WASM 端（真 Electron，scripts/eval/native_vs_wasm_live.eval.js）與原生端（Electron 的 node 模式，scripts/eval/nvw_live.js），
//   兩者都降為低優先權；雙方載入完成後逐題輪流：第 i 題先 wasm 再 native，再到第 i+1 題。
// 每個發號視窗記錄背景負載：系統 CPU 忙碌率 − 本量測程序（Electron 與 node，以命令列辨識）的 CPU 使用率。
// 背景負載 > 30% 的題目標記為「有干擾」；另外算中位數時只用「兩個視窗都 ≤ 30%」的題目（低負載子集）。
// 總時間上限 10 分鐘（超過即停止發號，已完成題目保留）。
// 用法：node scripts/eval/run_interleaved.js  （需要 %TEMP%\colu-real-ud 內已有快取模型，且 %TEMP%\ort-node-test 內有 ONNX 與 onnxruntime-node）
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const REPO = path.resolve(__dirname, '..', '..');
const TEMP = process.env.TEMP || os.tmpdir();
const LIVE = path.join(TEMP, 'nvw-live');
const PROFILE = path.join(TEMP, 'colu-real-ud');
const ORT_DIR = path.join(TEMP, 'ort-node-test');
const MODEL = path.join(ORT_DIR, 'models', 'qwen3-0.6b-cpu.onnx');
const TOK = path.join(ORT_DIR, 'tok', 'tokenizer.json');
const ELECTRON = path.join(REPO, 'node_modules', 'electron', 'dist', 'electron.exe');
const N_ITEMS = 16, BUDGET_MS = 10 * 60 * 1000, FLAG_PCT = 30;
const OUT = path.join(REPO, 'test-reports', 'native-vs-wasm', 'live-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json');
const NCPU = os.cpus().length;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return null; } };

function ps(script) {
    const enc = Buffer.from(script, 'utf16le').toString('base64');
    return cp.execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', enc], { encoding: 'utf8', timeout: 60000 }).trim();
}
// 本量測程序的 CPU 秒數合計（命令列含 colu-real-ud 或 nvw_live.js 的 electron.exe 及其子程序）
function ourCpuSeconds() {
    const out = ps("$s=0; Get-CimInstance Win32_Process -Filter \"Name='electron.exe'\" | Where-Object { $_.CommandLine -match 'colu-real-ud|nvw_live' } | ForEach-Object { $p=Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue; if ($p) { $s += $p.TotalProcessorTime.TotalSeconds } }; [Math]::Round($s,3)");
    return Number(out) || 0;
}
function cpuSnapshot() {
    return os.cpus().map((c) => ({ idle: c.times.idle, total: Object.values(c.times).reduce((a, b) => a + b, 0) }));
}
function busyPct(a, b) {
    let idle = 0, total = 0;
    for (let i = 0; i < a.length; i++) { idle += b[i].idle - a[i].idle; total += b[i].total - a[i].total; }
    return total > 0 ? 100 * (1 - idle / total) : 0;
}
function startLow(file, args, env) {
    const envSet = Object.entries(env).map(([k, v]) => "$env:" + k + "='" + String(v).replace(/'/g, "''") + "'").join('; ');
    const argList = args.map((a) => "'" + String(a).replace(/'/g, "''") + "'").join(',');
    const pid = ps(envSet + "; $p = Start-Process -FilePath '" + file.replace(/'/g, "''") + "' -ArgumentList @(" + argList + ") -WorkingDirectory '" + REPO.replace(/'/g, "''") + "' -WindowStyle Hidden -PassThru; try { $p.PriorityClass = 'BelowNormal' } catch {}; $p.Id");
    return Number(pid);
}
function stopPid(pid) { if (pid) try { ps("Stop-Process -Id " + pid + " -Force -ErrorAction SilentlyContinue"); } catch (_) { /* 已結束 */ } }
async function waitFile(p, ms) {
    const t = Date.now();
    while (!fs.existsSync(p)) {
        if (Date.now() - t > ms) return false;
        if (fs.existsSync(path.join(LIVE, 'native-error.txt'))) return false; // 原生端已失敗，不再等
        await sleep(200);
    }
    return true;
}
function median(a) { const s = a.filter((x) => x != null).slice().sort((x, y) => x - y); if (!s.length) return null; return s[Math.floor(s.length / 2)]; }

(async () => {
    fs.rmSync(LIVE, { recursive: true, force: true });
    fs.mkdirSync(LIVE, { recursive: true });
    const result = { started_at: new Date().toISOString(), ncpu: NCPU, flag_pct: FLAG_PCT, budget_ms: BUDGET_MS, rows: [], loads: [] };

    // 開頭的系統負載（啟動前，3 秒）
    const s0 = cpuSnapshot(); await sleep(3000); result.load_start_pct = Math.round(busyPct(s0, cpuSnapshot()) * 10) / 10;

    const nativePid = startLow(ELECTRON, [path.join(REPO, 'scripts', 'eval', 'nvw_live.js')], {
        ELECTRON_RUN_AS_NODE: '1', NVW_LIVE: LIVE, NVW_MODEL: MODEL, NVW_TOK: TOK, NVW_THREADS: '4',
        NVW_ORT_MODULE: path.join(ORT_DIR, 'node_modules', 'onnxruntime-node'),
    });
    const wasmPid = startLow(ELECTRON, [REPO, '--no-sandbox', '--disable-gpu', '--user-data-dir=' + PROFILE], {
        FA_DISABLE_MAIN_OVERLAY: '1', FA_BROWSER_CONTROL_PORT: '17948',
        FA_DEBUG_EVAL_FILE: path.join(REPO, 'scripts', 'eval', 'native_vs_wasm_live.eval.js'),
    });
    result.pids = { native: nativePid, wasm: wasmPid };

    try {
        const readyOk = (await waitFile(path.join(LIVE, 'ready-wasm.txt'), 8 * 60 * 1000)) && (await waitFile(path.join(LIVE, 'ready-native.txt'), 8 * 60 * 1000));
        if (fs.existsSync(path.join(LIVE, 'native-error.txt'))) throw new Error('原生端失敗：' + fs.readFileSync(path.join(LIVE, 'native-error.txt'), 'utf8').slice(0, 500));
        if (!readyOk) throw new Error('兩端沒有在 8 分鐘內就緒');
        result.ready = { wasm: readJson(path.join(LIVE, 'ready-wasm.txt')), native: readJson(path.join(LIVE, 'ready-native.txt')) };

        const t0 = Date.now();
        for (let i = 0; i < N_ITEMS; i++) {
            const row = { i, wasm: null, native: null };
            for (const who of ['wasm', 'native']) {
                if (Date.now() - t0 > BUDGET_MS) { result.stopped_by_budget = true; break; }
                const a0 = cpuSnapshot(), ours0 = ourCpuSeconds(), w0 = Date.now();
                fs.writeFileSync(path.join(LIVE, 'turn.json'), JSON.stringify({ who, i }));
                const got = await waitFile(path.join(LIVE, 'res-' + who + '-' + i + '.json'), 6 * 60 * 1000);
                const w1 = Date.now();
                const ours1 = ourCpuSeconds(), a1 = cpuSnapshot();
                const wall = (w1 - w0) / 1000;
                const sys = busyPct(a0, a1);
                const ours = wall > 0 ? 100 * (ours1 - ours0) / (wall * NCPU) : 0;
                const bg = Math.max(0, sys - ours);
                const load = { i, who, wall_ms: w1 - w0, sys_busy_pct: Math.round(sys * 10) / 10, our_pct: Math.round(ours * 10) / 10, bg_pct: Math.round(bg * 10) / 10, flagged: bg > FLAG_PCT };
                result.loads.push(load);
                if (!got) { row[who] = { error: 'timeout' }; break; }
                row[who] = Object.assign(readJson(path.join(LIVE, 'res-' + who + '-' + i + '.json')) || {}, { load });
                console.log('[interleave]', i, who, 'wall', load.wall_ms, 'ms', 'bg', load.bg_pct, '%', load.flagged ? '（有干擾）' : '');
            }
            result.rows.push(row);
            if (result.stopped_by_budget) break;
        }
        fs.writeFileSync(path.join(LIVE, 'turn.json'), JSON.stringify({ who: 'stop' }));
    } catch (e) {
        result.error = String((e && e.message) || e);
        try { fs.writeFileSync(path.join(LIVE, 'turn.json'), JSON.stringify({ who: 'stop' })); } catch (_) { /* */ }
    } finally {
        await sleep(1500);
        stopPid(nativePid); stopPid(wasmPid);
    }

    // 結尾的系統負載（停止後，3 秒）
    const s1 = cpuSnapshot(); await sleep(3000); result.load_end_pct = Math.round(busyPct(s1, cpuSnapshot()) * 10) / 10;

    // 統計：全部題目的中位數，與「低負載子集」（兩個視窗都 ≤ 30%）的中位數
    const pairs = result.rows.filter((r) => r.wasm && r.native && r.wasm.ms != null && r.native.ms != null);
    const clean = pairs.filter((r) => !r.wasm.load.flagged && !r.native.load.flagged);
    const summarize = (set) => ({
        n: set.length,
        wasm_median_ms: median(set.map((r) => r.wasm.ms)),
        native_median_ms: median(set.map((r) => r.native.ms)),
        ratio_wasm_over_native: (median(set.map((r) => r.wasm.ms)) && median(set.map((r) => r.native.ms))) ? Math.round(100 * median(set.map((r) => r.wasm.ms)) / median(set.map((r) => r.native.ms))) / 100 : null,
        same_text: set.filter((r) => r.wasm.text === r.native.text).length,
    });
    result.summary_all = summarize(pairs);
    result.summary_low_load = summarize(clean);
    result.flagged_turns = result.loads.filter((l) => l.flagged).map((l) => ({ i: l.i, who: l.who, bg_pct: l.bg_pct }));
    result.finished_at = new Date().toISOString();
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify(result, null, 1));
    console.log('[interleave] 結果檔：' + OUT);
    console.log('[interleave] 全部題目：', JSON.stringify(result.summary_all));
    console.log('[interleave] 低負載子集：', JSON.stringify(result.summary_low_load));
    console.log('[interleave] 有干擾的發號：', JSON.stringify(result.flagged_turns));
})().catch((e) => { console.log('[interleave] 失敗：' + ((e && e.stack) || e)); process.exit(1); });
