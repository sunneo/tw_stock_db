// 原生執行器主程序端（階段 3）：管理子程序的生命週期與協定。只在主程序使用（需要 child_process）。
// 生命週期：懶啟動（第一次 run 才啟動）→ 握手（hello／hello_ack，版本不符即停用）→ 閒置關閉（idleMs）→
//          崩潰自動重啟一次（連續兩次崩潰即停用原生路徑，回傳真實原因）→ 取消（cancel，寬限後強制結束）→
//          逾時（timeoutMs：先送 cancel，寬限 graceMs 仍沒回來就強制結束子程序，呼叫端拿到 code:'timeout'）。
'use strict';

const proto = require('./nr-protocol.js');

function makeError(code, message, detail) {
    const e = new Error(message);
    e.code = code;
    if (detail) Object.assign(e, detail);
    if (code === 'timeout') e.timeout = true;
    return e;
}

function createNativeRunnerHost(opts) {
    opts = opts || {};
    const spawnFn = opts.spawnFn || require('child_process').spawn;
    const execPath = opts.execPath || process.execPath;
    const childPath = opts.childPath;
    const progressFile = opts.progressFile || '';
    const idleMs = opts.idleMs != null ? opts.idleMs : 10 * 60 * 1000;
    const graceMs = opts.graceMs != null ? opts.graceMs : 5000;
    const handshakeMs = opts.handshakeMs != null ? opts.handshakeMs : 10000;
    const env = Object.assign({}, process.env, opts.env || {}, { ELECTRON_RUN_AS_NODE: '1' });
    const log = opts.log || (() => {});
    if (progressFile) { try { require('fs').mkdirSync(require('path').dirname(progressFile), { recursive: true }); } catch (_) { /* 寫不了進度檔時子程序會自己回報 */ } }

    let child = null;          // 目前的子程序（ChildProcess）
    let ready = null;          // 握手完成的 Promise
    let seq = 0;
    let consecutiveCrashes = 0;
    let disabledReason = '';   // 非空＝原生路徑已停用
    let idleTimer = null;
    const pending = new Map(); // id → { resolve, reject, onToken, onProgress, timeoutTimer, graceTimer, cancelling }
    const stderrTail = [];

    function touch() {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = null;
        if (idleMs > 0 && child) idleTimer = setTimeout(() => { if (pending.size === 0) dispose('閒置關閉'); }, idleMs);
    }

    function rejectAll(err) {
        for (const [id, p] of pending) {
            clearTimeout(p.timeoutTimer); clearTimeout(p.graceTimer);
            p.reject(err);
            pending.delete(id);
        }
    }

    function writeMsg(obj) {
        if (!child || !child.stdin || child.stdin.destroyed) throw makeError('internal', '子程序沒有在執行');
        child.stdin.write(proto.encodeLine(obj));
    }

    function onLine(line) {
        const p = proto.parseLine(line);
        if (!p.ok) { log('[native] 子程序輸出不合法：' + p.error); return; }
        const m = p.msg;
        const job = pending.get(m.id);
        if (m.type === 'progress') { if (job && job.onProgress) job.onProgress(m); return; }
        if (m.type === 'token') { if (job && job.onToken) job.onToken(m.text); return; }
        if (m.type === 'hello_ack') return; // 由 ensureChild 內的 hello 處理
        if (!job) return;
        clearTimeout(job.timeoutTimer); clearTimeout(job.graceTimer);
        pending.delete(m.id);
        if (m.type === 'done') { consecutiveCrashes = 0; job.resolve({ ok: m.ok, text: m.text, ms: m.ms, finish_reason: m.finish_reason }); touch(); return; }
        if (m.type === 'cancelled') { job.reject(makeError('cancelled', '已取消')); touch(); return; }
        if (m.type === 'error') {
            if (m.code === 'version_mismatch') { disabledReason = '協定版本不符：' + (m.message || ''); }
            job.reject(makeError(m.code, m.message || m.code, { detail: m.message || '' }));
            touch();
        }
    }

    function spawnChild() {
        const c = spawnFn(execPath, [childPath, progressFile], { stdio: ['pipe', 'pipe', 'pipe'], env, windowsHide: true });
        child = c;
        let exitedExpectedly = false;
        c.stdout.setEncoding('utf8');
        c.stderr.setEncoding('utf8');
        const dec = proto.createLineDecoder();
        c.stdout.on('data', (chunk) => { for (const line of dec.push(chunk)) onLine(line); });
        c.stderr.on('data', (chunk) => { for (const l of String(chunk).split('\n')) { if (l.trim()) { stderrTail.push(l.trim()); if (stderrTail.length > 20) stderrTail.shift(); } } });
        c.on('error', (e) => log('[native] spawn 失敗：' + ((e && e.message) || e)));
        c.on('exit', (code, signal) => {
            if (child !== c) return; // 已被新的子程序取代
            child = null; ready = null;
            if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
            if (exitedExpectedly) { rejectAll(makeError('cancelled', '子程序已結束')); return; }
            consecutiveCrashes++;
            const tail = stderrTail.slice(-3).join(' | ');
            const why = '子程序意外結束（退出碼 ' + code + '，signal ' + (signal || '無') + '）' + (tail ? '；最後的日誌：' + tail : '');
            rejectAll(makeError('crashed', why, { exitCode: code, signal: signal || null }));
            log('[native] ' + why + '；連續崩潰 ' + consecutiveCrashes + ' 次');
            if (consecutiveCrashes >= 2) { disabledReason = '連續崩潰 ' + consecutiveCrashes + ' 次，已停用原生路徑。最後一次：' + why; return; }
            try { ensureChild().catch(() => {}); } catch (_) { /* 下一次 run 再試 */ }
        });
        c._markExpected = () => { exitedExpectedly = true; };
        return c;
    }

    function ensureChild() {
        if (disabledReason) return Promise.reject(makeError('native_disabled', disabledReason));
        if (child && ready) return ready;
        spawnChild();
        const c = child;
        ready = new Promise((resolve, reject) => {
            let timer = setTimeout(() => { reject(makeError('internal', '握手逾時（' + handshakeMs + ' 毫秒）')); if (c._markExpected) c._markExpected(); try { c.kill(); } catch (_) {} }, handshakeMs);
            const origOnLine = onLine;
            const dec = proto.createLineDecoder();
            c.stdout.removeAllListeners('data');
            c.stdout.on('data', (chunk) => {
                for (const line of dec.push(chunk)) {
                    const p = proto.parseLine(line);
                    if (p.ok && p.msg.type === 'hello_ack') {
                        clearTimeout(timer);
                        if (p.msg.v !== proto.PROTOCOL_VERSION) {
                            disabledReason = '協定版本不符（主程序 ' + proto.PROTOCOL_VERSION + '，子程序 ' + p.msg.v + '）';
                            if (c._markExpected) c._markExpected(); try { c.kill(); } catch (_) {}
                            reject(makeError('version_mismatch', disabledReason));
                            return;
                        }
                        resolve(p.msg);
                        // 之後的輸出交給正常處理
                        const d2 = proto.createLineDecoder();
                        c.stdout.removeAllListeners('data');
                        c.stdout.on('data', (ch) => { for (const l of d2.push(ch)) origOnLine(l); });
                        return;
                    }
                    if (p.ok && p.msg.type === 'error' && p.msg.code === 'version_mismatch') {
                        clearTimeout(timer);
                        disabledReason = '協定版本不符：' + (p.msg.message || '');
                        reject(makeError('version_mismatch', disabledReason));
                        return;
                    }
                }
            });
            writeMsg({ type: 'hello', id: 'hello', v: proto.PROTOCOL_VERSION });
        });
        return ready;
    }

    function run(req) {
        req = req || {};
        const id = 'r' + (++seq);
        return ensureChild().then(() => new Promise((resolve, reject) => {
            const job = { resolve, reject, onToken: req.onToken, onProgress: req.onProgress, timeoutTimer: null, graceTimer: null };
            pending.set(id, job);
            if (req.onStart) req.onStart(id);
            if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
            if (req.timeoutMs > 0) {
                job.timeoutTimer = setTimeout(() => {
                    if (!pending.has(id)) return;
                    try { writeMsg({ type: 'cancel', id }); } catch (_) {}
                    job.graceTimer = setTimeout(() => {
                        if (!pending.has(id)) return;
                        pending.delete(id);
                        reject(makeError('timeout', '逾時（' + req.timeoutMs + ' 毫秒），子程序在寬限 ' + graceMs + ' 毫秒內沒有回應，已強制結束'));
                        if (child) { const c = child; if (c._markExpected) c._markExpected(); child = null; ready = null; try { c.kill(); } catch (_) {} }
                        rejectAll(makeError('cancelled', '子程序已因逾時強制結束'));
                    }, graceMs);
                }, req.timeoutMs);
            }
            try {
                const msg = { type: 'run', id, messages: req.messages || [], template: req.template || 'qwen3-chatml', max_tokens: req.maxTokens || 512, timeout_ms: req.timeoutMs || 0, stream: !!req.stream, fake: req.fake };
                if (req.gen !== undefined) msg.gen = req.gen; // 產品端的 textGenParams 結果，原樣傳給子程序
                if (req.seed !== undefined) msg.seed = req.seed; // 取樣用的亂數種子（可重現）
                writeMsg(msg);
            } catch (e) { pending.delete(id); clearTimeout(job.timeoutTimer); reject(e); }
        }));
    }

    function cancel(id) {
        if (!pending.has(id)) return false;
        writeMsg({ type: 'cancel', id });
        return true;
    }

    function dispose(reason) {
        if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
        const c = child;
        if (!c) return false;
        if (c._markExpected) c._markExpected();
        child = null; ready = null;
        try { c.stdin.write(proto.encodeLine({ type: 'dispose', id: 'dispose' })); } catch (_) {}
        const t = setTimeout(() => { try { c.kill(); } catch (_) {} }, 1000);
        if (t.unref) t.unref();
        log('[native] 子程序結束：' + (reason || '手動'));
        rejectAll(makeError('cancelled', '子程序已結束：' + (reason || '手動')));
        return true;
    }

    function status() {
        return { alive: !!child, pid: child ? child.pid : null, pending: pending.size, consecutiveCrashes, disabled: !!disabledReason, disabledReason };
    }

    function reenable() { disabledReason = ''; consecutiveCrashes = 0; }

    return { run, cancel, dispose, status, reenable, _ensureChild: ensureChild };
}

module.exports = { createNativeRunnerHost };
