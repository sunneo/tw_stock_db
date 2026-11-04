// 原生執行器階段 4（選用）：本機推論伺服器。只綁 127.0.0.1，每個請求都要 Bearer 金鑰，預設埠 17924（不可用 17923：瀏覽器控制占用）。
// 路由：GET /v1/health、POST /v1/run（非串流，body 為 JSON，上限 1 MB）。預設不啟動，由 ipc.js 的 fa:native:server:* 控制。
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const proto = require('./protocol.js');

const BIND_HOST = '127.0.0.1';
const DEFAULT_PORT = 17924;
const RESERVED_PORTS = [17923];
const MAX_BODY = 1024 * 1024;

// 金鑰檔：不存在就產生 32 位元組（hex），權限盡量收緊。金鑰只存在使用者資料夾，不寫進程式或日誌。
function loadOrCreateKey(keyFile) {
    try {
        const k = fs.readFileSync(keyFile, 'utf8').trim();
        if (/^[0-9a-f]{64}$/.test(k)) return k;
    } catch (_) { /* 不存在就產生 */ }
    const k = crypto.randomBytes(32).toString('hex');
    fs.mkdirSync(path.dirname(keyFile), { recursive: true });
    fs.writeFileSync(keyFile, k + '\n', { mode: 0o600 });
    return k;
}

function safeEqual(a, b) {
    const x = Buffer.from(String(a)), y = Buffer.from(String(b));
    if (x.length !== y.length) return false;
    return crypto.timingSafeEqual(x, y);
}

function send(res, status, obj) {
    const body = JSON.stringify(obj);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store' });
    res.end(body);
}

// 錯誤碼對應 HTTP 狀態：呼叫端看得到真實原因（依使用者偏好，不靜默）
const STATUS_OF = { native_disabled: 503, crashed: 502, timeout: 504, cancelled: 499, version_mismatch: 503, load_failed: 500, internal: 500 };

function createServer(opts) {
    opts = opts || {};
    const port = opts.port != null ? Number(opts.port) : DEFAULT_PORT;
    if (RESERVED_PORTS.indexOf(port) >= 0) return Promise.reject(new Error('埠 ' + port + ' 已被瀏覽器控制占用，請換一個埠'));
    const key = opts.key || loadOrCreateKey(opts.keyFile);
    const host = opts.host;
    if (!host) return Promise.reject(new Error('缺少子程序執行器（host）'));

    const server = http.createServer((req, res) => {
        const auth = String(req.headers['authorization'] || '');
        const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
        if (!token || !safeEqual(token, key)) { send(res, 401, { ok: false, code: 'unauthorized', message: '金鑰不正確或沒有提供' }); return; }
        if (req.method === 'GET' && req.url === '/v1/health') {
            send(res, 200, { ok: true, v: proto.PROTOCOL_VERSION, status: host.status() });
            return;
        }
        if (req.method === 'POST' && req.url === '/v1/run') {
            let size = 0; const chunks = [];
            req.on('data', (c) => { size += c.length; if (size > MAX_BODY) { send(res, 413, { ok: false, code: 'too_large', message: '請求超過 1 MB' }); req.destroy(); } else chunks.push(c); });
            req.on('end', async () => {
                if (size > MAX_BODY) return;
                let body;
                try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
                catch (e) { send(res, 400, { ok: false, code: 'bad_json', message: 'body 不是合法 JSON' }); return; }
                try {
                    const r = await host.run({ messages: body.messages || [], maxTokens: body.maxTokens, timeoutMs: body.timeoutMs, stream: false, fake: body.fake });
                    send(res, 200, { ok: true, text: r.text, ms: r.ms, finish_reason: r.finish_reason });
                } catch (e) {
                    const code = e.code || 'internal';
                    send(res, STATUS_OF[code] || 500, { ok: false, code, message: String((e && e.message) || e) });
                }
            });
            return;
        }
        send(res, 404, { ok: false, code: 'not_found', message: '沒有這個路由' });
    });

    return new Promise((resolve, reject) => {
        server.once('error', (e) => reject(new Error(e.code === 'EADDRINUSE' ? '埠 ' + port + ' 已被占用' : String((e && e.message) || e))));
        server.listen(port, BIND_HOST, () => {
            const addr = server.address();
            if (addr.address !== BIND_HOST) { server.close(); reject(new Error('綁定位址不是 127.0.0.1：' + addr.address)); return; }
            resolve({ server, port: addr.port, address: addr.address, key, close: () => new Promise((r) => server.close(() => r())) });
        });
    });
}

module.exports = { createServer, loadOrCreateKey, DEFAULT_PORT, RESERVED_PORTS, BIND_HOST };
