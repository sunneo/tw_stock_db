// 原生執行器協定（階段 3）：標準輸入輸出，一行一則 JSON。主程序與子程序共用，這是唯一的定義來源。
// 版本號 PROTOCOL_VERSION：主程序與子程序不一致就拒絕啟動（不靜默降級）。
// 子程序只能把協定訊息寫到 stdout；日誌一律寫 stderr。
'use strict';

const PROTOCOL_VERSION = 1;

// 訊息種類表：方向、必填欄位。驗證函式以此為準。
const MESSAGES = {
    hello: { dir: 'host->child', required: ['v', 'id'] },
    load: { dir: 'host->child', required: ['id', 'model_path', 'device', 'threads', 'dtype'] },
    run: { dir: 'host->child', required: ['id', 'messages', 'max_tokens', 'timeout_ms', 'stream'] },
    cancel: { dir: 'host->child', required: ['id'] },
    dispose: { dir: 'host->child', required: ['id'] },
    hello_ack: { dir: 'child->host', required: ['id', 'v', 'pid'] },
    progress: { dir: 'child->host', required: ['id', 'stage'] },
    token: { dir: 'child->host', required: ['id', 'text'] },
    done: { dir: 'child->host', required: ['id', 'ok', 'text', 'ms', 'finish_reason'] },
    error: { dir: 'child->host', required: ['id', 'code'] },
    cancelled: { dir: 'child->host', required: ['id'] },
};

// error.code 只能是這幾種
const ERROR_CODES = ['load_failed', 'oom', 'timeout', 'cancelled', 'internal', 'crashed', 'version_mismatch'];

// 把一則訊息序列化成一行（結尾加 \n）
function encodeLine(obj) {
    return JSON.stringify(obj) + '\n';
}

// 驗證一則訊息：回傳 { ok, error }
function validate(msg) {
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return { ok: false, error: '訊息不是物件' };
    const spec = MESSAGES[msg.type];
    if (!spec) return { ok: false, error: '未知的訊息種類：' + String(msg.type) };
    for (const k of spec.required) {
        if (msg[k] === undefined) return { ok: false, error: '缺少必填欄位 ' + k + '（' + msg.type + '）' };
    }
    if (msg.type === 'error' && ERROR_CODES.indexOf(msg.code) < 0) return { ok: false, error: 'error.code 不合法：' + String(msg.code) };
    return { ok: true, error: '' };
}

// 逐行切分輸入（處理分段到達與 \r\n）：push 一段文字，回傳完整的行陣列，未完成的行留在緩衝區
function createLineDecoder() {
    let buf = '';
    return {
        push(chunk) {
            buf += String(chunk);
            const parts = buf.split('\n');
            buf = parts.pop();
            return parts.map((s) => s.replace(/\r$/, '')).filter((s) => s.length > 0);
        },
        pending() { return buf; },
    };
}

// 解析一行：回傳 { ok, msg, error }（非 JSON 或驗證失敗都回 ok:false，不丟例外）
function parseLine(line) {
    let msg;
    try { msg = JSON.parse(line); } catch (e) { return { ok: false, msg: null, error: '不是合法的 JSON：' + String((e && e.message) || e) }; }
    const v = validate(msg);
    return v.ok ? { ok: true, msg, error: '' } : { ok: false, msg, error: v.error };
}

module.exports = { PROTOCOL_VERSION, MESSAGES, ERROR_CODES, encodeLine, validate, createLineDecoder, parseLine };
