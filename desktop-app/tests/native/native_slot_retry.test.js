// 離線模型 LoRA 槽版自動轉換的重試（native-slot-model.js）。
// 用假的轉換子行程（cp.spawn）與暫存資料夾：第一次失敗、第二次成功 → 成功且只轉兩次；全部失敗 → 回 slot_build_failed 並附「已試 3 次」。
// 沒測到的：真的 Electron 子行程與真的 617 MB 模型（見 DESIGN.lora-training.md §10）。
'use strict';
const fs = require('fs'), os = require('os'), path = require('path');
const { EventEmitter } = require('events');
const NSM = require(path.join(__dirname, '..', '..', 'native-slot-model.js'));

let ok = 0; const bad = [];
const check = (n, c, x) => { if (c) ok++; else { bad.push(n); console.log('FAIL', n, x === undefined ? '' : JSON.stringify(x).slice(0, 400)); } };

// 假的標準版模型（只要檔案存在且大小 > 0 即可；轉換由假子行程完成）
function setup(name) {
    const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'nsm-' + name + '-'));
    const stdDir = path.join(userData, 'native-models', NSM.STD.localDirName, 'onnx');
    fs.mkdirSync(stdDir, { recursive: true });
    fs.writeFileSync(path.join(stdDir, 'model_quantized.onnx'), 'standard-model-bytes');
    const buildScript = path.join(userData, 'lora-slot-build.js');
    fs.writeFileSync(buildScript, '// fake\n');
    return { userData, buildScript };
}

// 假子行程：failTimes 次數內失敗（stderr 寫錯誤、結束碼 1）；之後成功（在 outDir 寫槽版檔＋輸出結果行）
function fakeCp(failTimes) {
    const calls = [];
    return {
        calls,
        spawn(exe, args) {
            const outDir = args[3];
            const child = new EventEmitter();
            child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
            const attempt = calls.length + 1; calls.push({ exe, args: args.slice(), attempt });
            setImmediate(() => {
                if (attempt <= failTimes) {
                    child.stderr.emit('data', Buffer.from('Error: boom attempt ' + attempt + '\n'));
                    child.emit('close', 1);
                    return;
                }
                fs.mkdirSync(outDir, { recursive: true });
                fs.writeFileSync(path.join(outDir, 'model_quantized.onnx'), 'slot-bytes');
                fs.writeFileSync(path.join(outDir, 'layout.json'), JSON.stringify({ rank: 16, total_bytes: 10 }));
                child.stdout.emit('data', Buffer.from(JSON.stringify({ result: { outBytes: 10, targets: ['q'], ms: 1, peakRssMB: 1 } }) + '\n'));
                child.emit('close', 0);
            });
            return child;
        },
    };
}

function make(name, failTimes) {
    const env = setup(name);
    const cp = fakeCp(failTimes);
    const slot = NSM.create({ fs, path, crypto: require('crypto'), cp, userData: env.userData, buildScript: env.buildScript, execPath: process.execPath, retryDelayMs: 0, env: {} });
    return { slot, cp };
}

(async () => {
    // 1) withRetry：第二次才成功
    {
        let n = 0;
        const v = await NSM.withRetry(async () => { n++; if (n < 2) throw new Error('x'); return 'got'; }, { tries: 3, delayMs: 0 });
        check('withRetry 第二次成功', v === 'got' && n === 2, { v, n });
    }
    // 2) withRetry：全部失敗 → 訊息附已試次數
    {
        let err = null; try { await NSM.withRetry(async () => { throw new Error('bad'); }, { tries: 3, delayMs: 0 }); } catch (e) { err = e; }
        check('withRetry 全部失敗附已試次數', !!err && /已試 3 次/.test(err.message) && /bad/.test(err.message), err && err.message);
    }
    // 3) 轉換：第一次子行程失敗、第二次成功 → ok，且只轉換兩次
    {
        const { slot, cp } = make('retry-ok', 1);
        const r = await slot.ensure();
        check('轉換第一次失敗後重試成功', r.ok === true && cp.calls.length === 2, { ok: r.ok, code: r.code, msg: r.message, calls: cp.calls.length });
        check('重試成功後槽版可用', !!slot.currentSlot(), null);
    }
    // 4) 轉換：三次都失敗 → slot_build_failed，訊息附已試 3 次，子行程只跑 3 次
    {
        const { slot, cp } = make('retry-fail', 99);
        const r = await slot.ensure();
        check('轉換全部失敗回 slot_build_failed', r.ok === false && r.code === 'slot_build_failed', r);
        check('全部失敗附已試 3 次', !!r.message && /已試 3 次/.test(r.message), r.message);
        check('全部失敗只跑 3 次子行程', cp.calls.length === 3, cp.calls.length);
    }
    console.log(bad.length ? 'FAILED ' + bad.length + ' / ' + (ok + bad.length) : 'OK ' + ok + ' checks');
    process.exit(bad.length ? 1 : 0);
})().catch((e) => { console.log('FAIL 例外', e && e.stack); process.exit(1); });
