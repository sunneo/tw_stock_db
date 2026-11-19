#!/usr/bin/env node
/* MCP stdio 伺服器：把 Python 工具橋（Playwright、OpenAI）掛成 Claude 的工具。
 * Claude Code：  claude mcp add weak-harness-bridge -- node <這個檔案>
 * Claude Desktop：在 claude_desktop_config.json 的 mcpServers 加 { "command": "node", "args": ["<這個檔案>"] }
 * 協定：一行一個 JSON-RPC（initialize、tools/list、tools/call）。截圖以 image content 回傳。
 */
'use strict';
const readline = require('readline'); const { createBridge } = require('./bridge.js');
const bridge = createBridge({ out: process.env.WH_OUT });
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
const fail = (id, code, message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n');
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', async (line) => {
    let m; try { m = JSON.parse(line); } catch (_) { return; }
    if (m.id === undefined) return;   // 通知（notifications/initialized 等）不回
    if (m.method === 'initialize') return reply(m.id, { protocolVersion: (m.params && m.params.protocolVersion) || '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'weak-harness-bridge', version: '1.0.0' } });
    if (m.method === 'tools/list') return reply(m.id, { tools: await bridge.list() });
    if (m.method === 'tools/call') {
        const r = await bridge.call(m.params.name, m.params.arguments);
        const content = [{ type: 'text', text: r.ok ? JSON.stringify(r.result, null, 1) : '失敗：' + r.error }].concat((r.images || []).map((i) => ({ type: 'image', data: i.data, mimeType: i.mime })));
        return reply(m.id, { content, isError: !r.ok });
    }
    if (m.method === 'ping') return reply(m.id, {});
    fail(m.id, -32601, '不支援的方法：' + m.method);
});
rl.on('close', () => { bridge.close(); setTimeout(() => process.exit(0), 200); });
