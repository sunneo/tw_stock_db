// 原生執行器子程序（階段 3）：只說協定（protocol.js），stdout 只放協定訊息，日誌一律寫 stderr。
// 目前是「假的推論引擎」：不載入任何模型、不引用 onnxruntime-node（那要等階段 4 且需使用者同意）。
// 假引擎的旋鈕只在 run 訊息的 fake 欄位（真引擎會忽略）：
//   fake.reply（回覆文字）、fake.delay_ms（每 token 的延遲）、fake.ignore_cancel（忽略取消，用來測逾時）、
//   fake.crash（收到 run 立刻以退出碼 7 結束）、fake.stuck（寫完進度後卡住不回，用來測強制結束後的進度檔）
// 命令列：node child.js [進度檔路徑]；環境變數 NATIVE_RUNNER_FAKE_VERSION 可覆寫回報的協定版本（用來測版本不符）。
'use strict';

const fs = require('fs');
const proto = require('./protocol.js');

const progressFile = process.argv[2] || '';
const versionOverride = process.env.NATIVE_RUNNER_FAKE_VERSION ? Number(process.env.NATIVE_RUNNER_FAKE_VERSION) : null;
const cancelled = new Set();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function send(obj) {
    process.stdout.write(proto.encodeLine(obj));
}

function journal(obj) {
    if (!progressFile) return;
    try { fs.appendFileSync(progressFile, JSON.stringify(Object.assign({ ts: Date.now(), pid: process.pid }, obj)) + '\n'); }
    catch (e) { process.stderr.write('journal failed: ' + ((e && e.message) || e) + '\n'); }
}

async function runFake(msg) {
    const f = msg.fake || {};
    const t0 = Date.now();
    if (f.crash) process.exit(7);
    const reply = String(f.reply != null ? f.reply : 'OK');
    const chars = Array.from(reply);
    const limit = Math.min(chars.length, msg.max_tokens || chars.length);
    let text = '';
    journal({ type: 'progress', id: msg.id, stage: 'generate', tokens: 0 });
    send({ type: 'progress', id: msg.id, stage: 'generate', tokens: 0 });
    for (let i = 0; i < limit; i++) {
        if (cancelled.has(msg.id) && !f.ignore_cancel) {
            send({ type: 'cancelled', id: msg.id });
            return;
        }
        if (f.stuck && i === 2) {
            // 寫完前幾個進度後卡住：不回 done，也不再讀取取消（用來測主程序強制結束後進度檔仍在）
            journal({ type: 'progress', id: msg.id, stage: 'stuck', tokens: i });
            await new Promise(() => {});
        }
        if (f.delay_ms) await sleep(f.delay_ms);
        text += chars[i];
        if (msg.stream) {
            journal({ type: 'token', id: msg.id, text: chars[i] });
            send({ type: 'token', id: msg.id, text: chars[i] });
        }
        if ((i + 1) % 8 === 0) {
            journal({ type: 'progress', id: msg.id, stage: 'generate', tokens: i + 1 });
            send({ type: 'progress', id: msg.id, stage: 'generate', tokens: i + 1 });
        }
    }
    const ms = Date.now() - t0;
    if (cancelled.has(msg.id) && !f.ignore_cancel) { send({ type: 'cancelled', id: msg.id }); return; }
    send({ type: 'done', id: msg.id, ok: true, text, ms, finish_reason: limit < chars.length ? 'length' : 'stop' });
}

function handle(msg) {
    const v = proto.validate(msg);
    if (!v.ok) {
        send({ type: 'error', id: (msg && msg.id) || '', code: 'internal', message: v.error });
        return;
    }
    if (msg.type === 'hello') {
        if (msg.v !== proto.PROTOCOL_VERSION) { send({ type: 'error', id: msg.id, code: 'version_mismatch', message: '主程序協定版本 ' + msg.v + '，子程序 ' + proto.PROTOCOL_VERSION }); return; }
        send({ type: 'hello_ack', id: msg.id, v: versionOverride != null ? versionOverride : proto.PROTOCOL_VERSION, pid: process.pid });
        return;
    }
    if (msg.type === 'load') {
        const bad = /missing/.test(String(msg.model_path || ''));
        if (bad) { send({ type: 'error', id: msg.id, code: 'load_failed', message: '假引擎：模型檔不存在 ' + msg.model_path }); return; }
        send({ type: 'done', id: msg.id, ok: true, text: '', ms: 0, finish_reason: 'loaded' });
        return;
    }
    if (msg.type === 'run') {
        // 提示樣板：假引擎不使用文字，但仍要驗證樣板名稱存在、messages 能套用（與真引擎行為一致）
        try {
            require('./template.js').applyTemplate(msg.template || 'qwen3-chatml', msg.messages || [], { enable_thinking: false });
            // gen 有給就要通過驗證（與真引擎相同的規則）；假引擎不實際取樣
            if (msg.gen !== undefined) require('./gen_params.js').validateGen(msg.gen);
        }
        catch (e) { send({ type: 'error', id: msg.id, code: 'internal', message: String((e && e.message) || e) }); return; }
        runFake(msg).catch((e) => send({ type: 'error', id: msg.id, code: 'internal', message: String((e && e.message) || e) }));
        return;
    }
    if (msg.type === 'cancel') { cancelled.add(msg.id); return; }
    if (msg.type === 'dispose') { send({ type: 'done', id: msg.id, ok: true, text: '', ms: 0, finish_reason: 'disposed' }); process.exit(0); }
    send({ type: 'error', id: msg.id, code: 'internal', message: '子程序不處理的訊息：' + msg.type });
}

const dec = proto.createLineDecoder();
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
    for (const line of dec.push(chunk)) {
        const p = proto.parseLine(line);
        if (!p.ok) { process.stderr.write('bad line: ' + p.error + '\n'); send({ type: 'error', id: '', code: 'internal', message: p.error }); continue; }
        handle(p.msg);
    }
});
process.stdin.on('end', () => process.exit(0));
process.stderr.write('native-runner child ready pid=' + process.pid + '\n');
