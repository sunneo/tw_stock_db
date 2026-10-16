#!/usr/bin/env node
// 測試用的最小 MCP 伺服器（stdio，沒有相依套件）：echo、add、fail 三個工具、一個資源。
// 用來驗證「安裝 → 啟動 → 列工具 → 呼叫」整條路；不是範例程式，不要拿去當正式伺服器。
"use strict";
const readline = require("readline");
const rl = readline.createInterface({ input: process.stdin });
const send = (m) => process.stdout.write(JSON.stringify(m) + "\n");
const TOOLS = [
  { name: "echo", description: "把輸入的文字原樣傳回來", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
  { name: "add", description: "兩個數字相加", inputSchema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"] } },
  { name: "fail", description: "永遠回報失敗（測試錯誤處理）", inputSchema: { type: "object", properties: {} } },
  { name: "env", description: "回傳環境變數 ECHO_GREETING 的值（測試 env 有帶進去）", inputSchema: { type: "object", properties: {} } },
];
rl.on("line", (line) => {
  let m; try { m = JSON.parse(line); } catch (_) { process.stderr.write("bad json: " + line + "\n"); return; }
  if (m.method === "initialize") return send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: "2025-03-26", capabilities: { tools: {}, resources: {} }, serverInfo: { name: "echo-mcp", version: "0.0.1" } } });
  if (m.method === "notifications/initialized") return;
  if (m.method === "ping") return send({ jsonrpc: "2.0", id: m.id, result: {} });
  if (m.method === "tools/list") return send({ jsonrpc: "2.0", id: m.id, result: { tools: TOOLS } });
  if (m.method === "resources/list") return send({ jsonrpc: "2.0", id: m.id, result: { resources: [{ uri: "echo://hello", name: "hello", mimeType: "text/plain" }] } });
  if (m.method === "resources/read") return send({ jsonrpc: "2.0", id: m.id, result: { contents: [{ uri: m.params.uri, mimeType: "text/plain", text: "hello from echo-mcp" }] } });
  if (m.method === "tools/call") {
    const { name, arguments: a } = m.params || {};
    if (name === "echo") return send({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: String(a.text) }] } });
    if (name === "add") return send({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: String(Number(a.a) + Number(a.b)) }] } });
    if (name === "fail") return send({ jsonrpc: "2.0", id: m.id, result: { isError: true, content: [{ type: "text", text: "這個工具永遠失敗" }] } });
    if (name === "env") return send({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: String(process.env.ECHO_GREETING || "(沒設定)") }] } });
    return send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "unknown tool " + name } });
  }
  if (m.id != null) send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "no method " + m.method } });
});
process.stderr.write("echo-mcp ready\n");
