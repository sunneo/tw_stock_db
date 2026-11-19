/* Python 工具橋的 Node 端：常駐 worker.py，把它的工具以 Claude tool 的格式提供出來。
 *   list()                → [{ name, description, input_schema }]（可直接放進 Anthropic API 的 tools，或給 MCP tools/list）
 *   call(name, args)      → { ok, result, images:[{path,mime,data(base64)}], error }
 * 另有 mcp_server.js 把它包成 MCP stdio 伺服器，讓 Claude Code / Claude Desktop 直接掛載。
 */
'use strict';
const { spawn } = require('child_process'); const path = require('path'); const fs = require('fs'); const readline = require('readline');

function createBridge(opts) {
    opts = opts || {}; let proc = null, rl = null, seq = 0; const waiting = new Map(); let listWaiter = null;
    const python = opts.python || process.env.WH_PYTHON || 'python3';
    function start() {
        if (proc) return;
        proc = spawn(python, [path.join(__dirname, 'worker.py')], { stdio: ['pipe', 'pipe', 'inherit'], env: Object.assign({}, process.env, opts.out ? { WH_OUT: opts.out } : {}) });
        rl = readline.createInterface({ input: proc.stdout });
        rl.on('line', (line) => { let m; try { m = JSON.parse(line); } catch (_) { return; } if (m.tools && listWaiter) { listWaiter(m); listWaiter = null; } else if (waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); } });
        proc.on('exit', () => { for (const f of waiting.values()) f({ ok: false, error: 'python worker 已結束' }); waiting.clear(); if (listWaiter) listWaiter({ tools: [] }); proc = null; });
        proc.on('error', (e) => { for (const f of waiting.values()) f({ ok: false, error: '無法啟動 ' + python + '：' + e.message }); waiting.clear(); proc = null; });
    }
    function send(obj) { start(); proc.stdin.write(JSON.stringify(obj) + '\n'); }
    async function list() { return new Promise((res) => { listWaiter = (m) => res(m.tools); send({ op: 'list' }); }); }
    function call(name, args, timeoutMs) {
        return new Promise((resolve) => {
            const id = ++seq; const timer = setTimeout(() => { waiting.delete(id); resolve({ ok: false, error: '逾時（' + (timeoutMs || 120000) + ' ms）' }); }, timeoutMs || 120000);
            waiting.set(id, (m) => { clearTimeout(timer);
                const images = (m.images || []).filter((p) => fs.existsSync(p)).map((p) => ({ path: p, mime: /\.jpe?g$/i.test(p) ? 'image/jpeg' : 'image/png', data: fs.readFileSync(p).toString('base64') }));
                resolve({ ok: !!m.ok, result: m.result, images, error: m.error }); });
            send({ id, tool: name, args: args || {} });
        });
    }
    function close() { if (proc) { try { proc.stdin.end(); } catch (_) {} setTimeout(() => { if (proc) proc.kill(); }, 3000).unref(); } }
    return { list, call, close };
}
module.exports = { createBridge };
