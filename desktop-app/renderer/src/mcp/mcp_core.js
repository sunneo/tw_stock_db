/* MCP（Model Context Protocol）用戶端的核心（UMD，純函式＋傳輸層介面，不碰 DOM／Electron）：
 *  - 設定檔：parseConfigText 認得各家的 mcp.json 寫法（Claude Desktop／Cursor／VS Code／Windsurf 的 mcpServers、servers、mcp.servers，單一伺服器物件、陣列），
 *    容忍註解與結尾逗號；parseManifest 認得 .mcpb／.dxt 的 manifest.json（含 ${__dirname}、${user_config.x}）；detectProject 從解開的檔案猜怎麼啟動（package.json、pyproject.toml、server.py…）。
 *  - 協定：McpClient 做 JSON-RPC 2.0（initialize 握手、tools／resources／prompts、ping、逾時、取消、分頁、伺服器發來的請求）。
 *  - 傳輸：StdioTransport（透過主程式 IPC 橋接的子行程）、HttpTransport（Streamable HTTP：POST，回應是 JSON 或 SSE）、SseTransport（舊版 HTTP+SSE）。
 *  - 工具名稱：mcp__伺服器__工具（最長 64 字元，太長加雜湊）；formatResult 把 MCP 的內容區塊轉成給模型看的文字。
 * 傳輸層都是 { start(), send(msg), close(), onmessage, onclose, onerror }，所以可以用假的傳輸完整測試。 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.FaMcp = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';
    const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
    const CLIENT_INFO = { name: 'floating-ai-assistant', version: '1.0.0' };

    // ===== 設定檔 =====
    // 去掉 // 與 /* */ 註解、結尾逗號（字串裡面的不動）
    function stripJsonc(text) {
        let out = '', i = 0; const s = String(text || '').replace(/^﻿/, ''); const n = s.length; let inStr = false;
        while (i < n) {
            const c = s[i]; if (inStr) { out += c; if (c === '\\') { out += s[i + 1] || ''; i += 2; continue; } if (c === '"') inStr = false; i++; continue; }
            if (c === '"') { inStr = true; out += c; i++; continue; }
            if (c === '/' && s[i + 1] === '/') { while (i < n && s[i] !== '\n') i++; continue; }
            if (c === '/' && s[i + 1] === '*') { i += 2; while (i < n && !(s[i] === '*' && s[i + 1] === '/')) i++; i += 2; continue; }
            out += c; i++;
        }
        return out.replace(/,(\s*[}\]])/g, '$1');
    }
    function sanitizeName(s, fallback) { const t = String(s || '').toLowerCase().replace(/^@/, '').replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40); return t || fallback || 'server'; }
    const SENSITIVE = /(token|secret|password|passwd|api[-_]?key|auth|credential|private[-_]?key|bearer)/i;
    const maskEnv = (env) => Object.fromEntries(Object.entries(env || {}).map(([k, v]) => [k, SENSITIVE.test(k) && String(v).length ? '••••' : String(v)]));
    // 一個伺服器設定 → 統一格式。type：stdio／http（Streamable HTTP）／sse。
    function normalizeServer(name, raw) {
        if (!raw || typeof raw !== 'object') return { ok: false, error: '伺服器 ' + name + ' 的設定不是物件' };
        const t = String(raw.type || raw.transport || '').toLowerCase(); const url = raw.url || raw.serverUrl || raw.httpUrl || raw.baseUrl || '';
        let transport = /sse/.test(t) ? 'sse' : (/http|stream/.test(t) ? 'http' : (t === 'stdio' ? 'stdio' : (url ? (/\/sse\/?$/i.test(url) ? 'sse' : 'http') : 'stdio')));
        const out = { name: sanitizeName(name), transport, disabled: !!(raw.disabled || raw.enabled === false), description: raw.description ? String(raw.description).slice(0, 300) : undefined };
        if (transport === 'stdio') {
            let command = raw.command, args = Array.isArray(raw.args) ? raw.args.map(String) : [];
            if (Array.isArray(command)) { args = command.slice(1).map(String).concat(args); command = command[0]; } // OpenCode 風格：command 是陣列
            if (typeof command === 'string' && /\s/.test(command.trim()) && !args.length && !/^["']?[A-Za-z]:\\|^\//.test(command.trim())) { const parts = command.trim().match(/"[^"]*"|'[^']*'|\S+/g) || []; command = parts[0].replace(/^["']|["']$/g, ''); args = parts.slice(1).map((x) => x.replace(/^["']|["']$/g, '')); } // 整行命令寫在 command 裡
            if (!command || typeof command !== 'string') return { ok: false, error: '伺服器 ' + name + ' 沒有 command（stdio）也沒有 url' };
            out.command = command; out.args = args; if (raw.env && typeof raw.env === 'object') out.env = Object.fromEntries(Object.entries(raw.env).map(([k, v]) => [k, String(v)])); if (raw.cwd) out.cwd = String(raw.cwd);
        } else {
            if (!/^https?:\/\//i.test(url)) return { ok: false, error: '伺服器 ' + name + ' 的 url 要是 http(s)：' + url }; out.url = String(url); const h = raw.headers || raw.http_headers; if (h && typeof h === 'object') out.headers = Object.fromEntries(Object.entries(h).map(([k, v]) => [k, String(v)]));
        }
        return { ok: true, server: out };
    }
    // 回傳 { ok, servers:[…], errors:[…], format }
    function parseConfigText(text) {
        let data; try { data = JSON.parse(stripJsonc(text)); } catch (e) { return { ok: false, error: '不是合法的 JSON：' + String(e.message || e).slice(0, 100) }; }
        let map = null, format = '';
        if (Array.isArray(data)) { map = {}; data.forEach((x, i) => { map[(x && (x.name || x.id)) || 'server' + (i + 1)] = x; }); format = 'array'; }
        else if (data && typeof data === 'object') {
            if (data.mcpServers && typeof data.mcpServers === 'object') { map = data.mcpServers; format = 'mcpServers'; }
            else if (data.mcp && data.mcp.servers && typeof data.mcp.servers === 'object') { map = data.mcp.servers; format = 'mcp.servers'; }
            else if (data.servers && typeof data.servers === 'object' && !Array.isArray(data.servers) && !('command' in data) && !('url' in data)) { map = data.servers; format = 'servers'; }
            else if (data.mcp && typeof data.mcp === 'object' && Object.values(data.mcp).some((v) => v && typeof v === 'object' && (v.command || v.url))) { map = data.mcp; format = 'mcp'; }
            else if (data.command || data.url || data.serverUrl) { map = { [data.name || 'server']: data }; format = 'single'; }
            else if (data.context_servers && typeof data.context_servers === 'object') { map = data.context_servers; format = 'context_servers'; } // Zed
            else if (Object.values(data).length && Object.values(data).every((v) => v && typeof v === 'object' && (v.command || v.url))) { map = data; format = 'bare-map'; }
        }
        if (!map) return { ok: false, error: '看不出這是 MCP 設定（要有 mcpServers、servers，或單一伺服器的 command／url）' };
        const servers = [], errors = []; for (const [k, v] of Object.entries(map)) { const r = normalizeServer(k, (v && v.command && typeof v.command === 'object' && !Array.isArray(v.command)) ? Object.assign({}, v, { command: v.command.path || v.command.command, args: v.command.args || v.args, env: v.command.env || v.env }) : v); if (r.ok) servers.push(r.server); else errors.push(r.error); }
        const seen = new Set(); for (const s of servers) { let n = s.name, i = 2; while (seen.has(n)) n = s.name + '-' + i++; s.name = n; seen.add(n); }
        if (!servers.length) return { ok: false, error: errors[0] || '沒有可用的伺服器設定', errors };
        return { ok: true, servers, errors, format };
    }
    // ${a.b}、${__dirname}、${HOME}…；沒有的變數保留原樣並回報
    function substitute(str, vars, missing) { return String(str).replace(/\$\{([^}]+)\}/g, (m, k) => { const v = k.split('.').reduce((a, p) => (a == null ? a : a[p]), vars); if (v == null) { if (missing) missing.add(k); return m; } return String(v); }); }
    // .mcpb／.dxt 的 manifest.json。回傳 { ok, name, version, description, server:{command,args,env}|null, user_config, tools, needs_runtime }
    function parseManifest(json, vars) {
        let m = json; if (typeof json === 'string') { try { m = JSON.parse(stripJsonc(json)); } catch (e) { return { ok: false, error: 'manifest.json 不是合法的 JSON' }; } }
        if (!m || typeof m !== 'object' || !(m.manifest_version || m.dxt_version) || !m.server) return { ok: false, error: '不是 MCP bundle 的 manifest（要有 manifest_version 和 server）' };
        const sv = m.server; const uc = {}; for (const [k, d] of Object.entries(m.user_config || {})) uc[k] = { type: d.type || 'string', title: d.title || k, description: d.description || '', required: !!d.required, sensitive: !!d.sensitive, default: d.default, multiple: !!d.multiple };
        const missing = new Set(); const cfg = sv.mcp_config || {}; const platform = vars && vars.__platform; const pcfg = (platform && cfg.platform_overrides && cfg.platform_overrides[platform]) || {}; const merged = Object.assign({}, cfg, pcfg);
        const sub = (x) => substitute(x, Object.assign({ user_config: {} }, vars || {}), missing);
        let command = merged.command ? sub(merged.command) : null; let args = (merged.args || []).map(sub); const env = merged.env ? Object.fromEntries(Object.entries(merged.env).map(([k, v]) => [k, sub(v)])) : undefined;
        if (!command && sv.entry_point) { const type = sv.type || 'node'; command = type === 'python' ? 'python' : (type === 'binary' ? sub('${__dirname}/' + sv.entry_point) : 'node'); if (type !== 'binary') args = [sub('${__dirname}/' + sv.entry_point)]; }
        const needs = (sv.type === 'python' || /^python/.test(command || '')) ? 'python' : (sv.type === 'binary' ? null : ((/^(node|npx)/.test(command || '') || sv.type === 'node') ? 'node' : null));
        return { ok: true, name: sanitizeName(m.name || m.display_name), display_name: m.display_name || m.name, version: m.version || '', description: m.description || '', author: m.author && (m.author.name || m.author) || '', server: command ? { command, args, env } : null, user_config: uc, unresolved: Array.from(missing), tools: (m.tools || []).map((t) => ({ name: t.name, description: t.description || '' })), needs_runtime: needs, compatibility: m.compatibility || undefined };
    }
    // 從解開的檔案猜怎麼啟動。files：{ 路徑: 文字或 null }（只需要給關鍵檔案：keyFiles 回傳要讀哪些）。回傳候選陣列（最可信的在前）
    const KEY_FILE_RE = /(^|\/)(manifest\.json|mcp\.json|\.mcp\.json|claude_desktop_config\.json|mcp_config\.json|cline_mcp_settings\.json|package\.json|pyproject\.toml|requirements\.txt|smithery\.yaml|server\.json|Dockerfile|README(\.md)?)$/i;
    function keyFiles(paths, depth) { const maxD = depth == null ? 2 : depth; return paths.filter((p) => KEY_FILE_RE.test(p) && p.split('/').filter(Boolean).length - 1 <= maxD); }
    const dirOf = (p) => p.replace(/[^/]*$/, '');
    function detectProject(paths, files) {
        const out = []; const read = (p) => (files && files[p] != null ? files[p] : null); const roots = Array.from(new Set(paths.filter((p) => KEY_FILE_RE.test(p)).map(dirOf))).sort((a, b) => a.length - b.length);
        for (const dir of roots) {
            const at = (n) => paths.includes(dir + n) ? dir + n : null;
            // 1. 已經是 mcp 設定檔
            for (const n of ['mcp.json', '.mcp.json', 'claude_desktop_config.json', 'mcp_config.json', 'cline_mcp_settings.json']) { const p = at(n); if (p && read(p) != null) { const r = parseConfigText(read(p)); if (r.ok) out.push({ kind: 'config', dir, via: p, servers: r.servers, confidence: 0.95 }); } }
            // 2. MCP bundle
            const mf = at('manifest.json'); if (mf && read(mf) != null) { const r = parseManifest(read(mf), { __dirname: '${__dirname}' }); if (r.ok) out.push({ kind: 'bundle', dir, via: mf, manifest: r, confidence: 0.95 }); }
            // 3. Node 專案
            const pj = at('package.json'); if (pj && read(pj) != null) {
                let j = null; try { j = JSON.parse(read(pj)); } catch (_) { j = null; }
                if (j) { const bin = typeof j.bin === 'string' ? j.bin : (j.bin && Object.values(j.bin)[0]); const looks = /mcp|model-context-protocol/i.test(JSON.stringify([j.name, j.description, j.keywords, Object.keys(j.dependencies || {})]));
                    const entry = bin || j.main || (j.scripts && j.scripts.start ? null : 'index.js'); const built = (p) => (p && /^dist|^build|^lib/.test(p.replace(/^\.\//, '')) && !paths.includes(dir + p.replace(/^\.\//, '')));
                    const steps = []; if (j.dependencies && Object.keys(j.dependencies).length) steps.push({ run: 'npm install', cwd: dir, why: '安裝相依套件' }); if (j.scripts && j.scripts.build && (built(entry) || !entry)) steps.push({ run: 'npm run build', cwd: dir, why: '編譯（入口檔還不存在）' });
                    const args = j.scripts && j.scripts.start && !bin ? ['run', 'start'] : [entry ? entry.replace(/^\.\//, '') : 'index.js']; const command = j.scripts && j.scripts.start && !bin ? 'npm' : 'node';
                    out.push({ kind: 'node', dir, via: pj, name: sanitizeName(j.name), description: j.description || '', server: { command, args, cwd: dir }, steps, needs_runtime: 'node', confidence: looks ? 0.8 : 0.45, mcp_like: looks }); }
            }
            // 4. Python 專案
            const pp = at('pyproject.toml'); if (pp && read(pp) != null) {
                const txt = read(pp); const name = (/^\s*name\s*=\s*["']([^"']+)["']/m.exec(txt) || [])[1]; const scripts = /\[project\.scripts\]([\s\S]*?)(\n\[|$)/.exec(txt); const sc = scripts ? (/^\s*([\w.-]+)\s*=/m.exec(scripts[1]) || [])[1] : null; const looks = /mcp|model-context-protocol/i.test(txt);
                const steps = [{ run: 'pip install -e .', cwd: dir, why: '安裝這個專案與相依套件' }]; const py = ['server.py', 'main.py', '__main__.py'].map((n) => at(n)).find(Boolean);
                out.push({ kind: 'python', dir, via: pp, name: sanitizeName(name), server: sc ? { command: sc, args: [], cwd: dir } : (py ? { command: 'python', args: [py.slice(dir.length)], cwd: dir } : { command: 'python', args: ['-m', (name || 'server').replace(/-/g, '_')], cwd: dir }), steps, needs_runtime: 'python', confidence: looks ? 0.75 : 0.4, mcp_like: looks });
            } else { const rq = at('requirements.txt'); const py = ['server.py', 'main.py', 'app.py'].map((n) => at(n)).find(Boolean); if (rq && py) out.push({ kind: 'python', dir, via: py, name: sanitizeName(dir.split('/').filter(Boolean).pop() || 'python-server'), server: { command: 'python', args: [py.slice(dir.length)], cwd: dir }, steps: [{ run: 'pip install -r requirements.txt', cwd: dir, why: '安裝相依套件' }], needs_runtime: 'python', confidence: /mcp/i.test(read(rq) || '') ? 0.7 : 0.3, mcp_like: /mcp/i.test(read(rq) || '') }); }
            // 5. Smithery
            const sm = at('smithery.yaml'); if (sm && read(sm) != null) { const txt = read(sm); const cmd = /command:\s*['"]?([^\s'"]+)['"]?/.exec(txt); const args = /args:\s*\[([^\]]*)\]/.exec(txt); if (cmd) out.push({ kind: 'smithery', dir, via: sm, server: { command: cmd[1], args: args ? args[1].split(',').map((x) => x.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean) : [], cwd: dir }, steps: [], confidence: 0.6, note: 'smithery.yaml 的啟動命令可能用到 configSchema 的參數，要確認' }); }
            // 6. Docker 以外沒有線索
            const dk = at('Dockerfile'); if (dk && !out.some((o) => o.dir === dir)) out.push({ kind: 'docker', dir, via: dk, unsupported: true, confidence: 0.1, note: '只有 Dockerfile：需要 Docker，目前不支援自動安裝' });
        }
        return out.sort((a, b) => b.confidence - a.confidence);
    }

    // ===== 工具名稱與結果 =====
    function hash(s) { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } return h.toString(36).slice(0, 5); }
    function toolName(server, tool) { const base = 'mcp__' + sanitizeName(server).replace(/-/g, '_') + '__' + String(tool).replace(/[^A-Za-z0-9_-]/g, '_'); return base.length <= 64 ? base : base.slice(0, 57) + '_' + hash(base).slice(0, 6); }
    // MCP 的內容區塊 → 給模型看的文字。回傳 { text, isError, images:[{mimeType,data}], truncated }
    function formatResult(res, maxChars) {
        const max = maxChars || 20000; if (!res || typeof res !== 'object') return { text: String(res == null ? '' : res), isError: false, images: [], truncated: false };
        const parts = [], images = []; for (const c of res.content || []) {
            if (!c) continue; if (c.type === 'text') parts.push(String(c.text)); else if (c.type === 'image') { images.push({ mimeType: c.mimeType, data: c.data }); parts.push('[圖片 ' + (c.mimeType || '') + '，' + Math.round(String(c.data || '').length * 0.75 / 1024) + ' KB]'); }
            else if (c.type === 'audio') parts.push('[音訊 ' + (c.mimeType || '') + ']'); else if (c.type === 'resource' && c.resource) parts.push(c.resource.text != null ? '[資源 ' + c.resource.uri + ']\n' + c.resource.text : '[資源 ' + c.resource.uri + ' ' + (c.resource.mimeType || '') + '（二進位）]'); else if (c.type === 'resource_link') parts.push('[資源連結 ' + (c.name || '') + ' ' + c.uri + ']'); else parts.push(JSON.stringify(c));
        }
        if (res.structuredContent && !parts.length) parts.push(JSON.stringify(res.structuredContent)); let text = parts.join('\n'); let truncated = false; if (text.length > max) { text = text.slice(0, max) + '\n…（共 ' + text.length + ' 字元，已截斷）'; truncated = true; }
        return { text, isError: !!res.isError, images, truncated };
    }

    // ===== SSE 解析 =====
    function createSseParser(onEvent) {
        let buf = '', ev = { event: 'message', data: [], id: undefined };
        const flush = () => { if (ev.data.length) onEvent({ event: ev.event, data: ev.data.join('\n'), id: ev.id }); ev = { event: 'message', data: [], id: undefined }; };
        return { feed(chunk) { buf += chunk; let i; while ((i = buf.search(/\r\n|\n|\r/)) >= 0) { const m = /^(\r\n|\n|\r)/.exec(buf.slice(i)); const line = buf.slice(0, i); buf = buf.slice(i + m[1].length); if (line === '') { flush(); continue; } if (line[0] === ':') continue; const c = line.indexOf(':'); const f = c < 0 ? line : line.slice(0, c); let v = c < 0 ? '' : line.slice(c + 1); if (v[0] === ' ') v = v.slice(1); if (f === 'data') ev.data.push(v); else if (f === 'event') ev.event = v; else if (f === 'id') ev.id = v; } }, end() { flush(); } };
    }

    // ===== 用戶端 =====
    class McpError extends Error { constructor(msg, code, data) { super(msg); this.name = 'McpError'; this.code = code; this.data = data; } }
    class McpClient {
        constructor(transport, opts) { opts = opts || {}; this.t = transport; this.timeoutMs = opts.timeoutMs || 30000; this.id = 0; this.pending = new Map(); this.closed = false; this.info = null; this.capabilities = null; this.protocolVersion = null; this.handlers = {}; this.log = opts.log || (() => {});
            transport.onmessage = (m) => this._onmessage(m); transport.onclose = (why) => this._onclose(why); transport.onerror = (e) => this.log('transport error: ' + String((e && e.message) || e)); }
        on(method, fn) { this.handlers[method] = fn; }
        _onclose(why) { this.closed = true; for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(new McpError('連線已關閉' + (why ? '：' + why : ''), -32000)); } this.pending.clear(); if (this.onclose) this.onclose(why); }
        async _onmessage(m) {
            if (!m || typeof m !== 'object') return;
            if (m.id != null && (('result' in m) || ('error' in m)) && !m.method) { const p = this.pending.get(m.id); if (!p) return; this.pending.delete(m.id); clearTimeout(p.timer); if (m.error) p.reject(new McpError(m.error.message || 'MCP 錯誤', m.error.code, m.error.data)); else p.resolve(m.result); return; }
            if (m.method && m.id != null) { // 伺服器發來的請求
                let result, error; try { if (m.method === 'ping') result = {}; else if (m.method === 'roots/list') result = { roots: [] }; else if (this.handlers[m.method]) result = await this.handlers[m.method](m.params); else error = { code: -32601, message: '用戶端不支援 ' + m.method }; } catch (e) { error = { code: -32603, message: String((e && e.message) || e) }; }
                try { await this.t.send(error ? { jsonrpc: '2.0', id: m.id, error } : { jsonrpc: '2.0', id: m.id, result }); } catch (_) { /* 連線可能已關 */ } return;
            }
            if (m.method) { if (this.handlers[m.method]) { try { this.handlers[m.method](m.params); } catch (_) { /* 通知的處理失敗不影響連線 */ } } }
        }
        request(method, params, opts) {
            if (this.closed) return Promise.reject(new McpError('連線已關閉', -32000)); const id = ++this.id; const ms = (opts && opts.timeoutMs) || this.timeoutMs;
            return new Promise((resolve, reject) => { const timer = setTimeout(() => { this.pending.delete(id); try { this.t.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: id, reason: 'timeout' } }); } catch (_) { /* */ } reject(new McpError(method + ' 逾時（' + Math.round(ms / 1000) + ' 秒）', -32001)); }, ms); this.pending.set(id, { resolve, reject, timer }); Promise.resolve(this.t.send({ jsonrpc: '2.0', id, method, params })).catch((e) => { if (this.pending.delete(id)) { clearTimeout(timer); reject(e); } }); });
        }
        notify(method, params) { return this.t.send({ jsonrpc: '2.0', method, params }); }
        async initialize(extra) {
            const r = await this.request('initialize', { protocolVersion: PROTOCOL_VERSIONS[0], capabilities: Object.assign({ roots: { listChanged: false } }, extra && extra.capabilities), clientInfo: CLIENT_INFO }, { timeoutMs: (extra && extra.timeoutMs) || 60000 });
            if (!r || !PROTOCOL_VERSIONS.includes(r.protocolVersion)) throw new McpError('伺服器用的協定版本 ' + (r && r.protocolVersion) + ' 這個用戶端不支援（支援 ' + PROTOCOL_VERSIONS.join('、') + '）', -32002);
            this.protocolVersion = r.protocolVersion; this.capabilities = r.capabilities || {}; this.info = r.serverInfo || {}; this.instructions = r.instructions; if (this.t.setProtocolVersion) this.t.setProtocolVersion(r.protocolVersion); await this.notify('notifications/initialized'); return r;
        }
        async _list(method, key, params) { const all = []; let cursor; for (let i = 0; i < 50; i++) { const r = await this.request(method, Object.assign({}, params, cursor ? { cursor } : {})); all.push(...(r[key] || [])); if (!r.nextCursor) break; cursor = r.nextCursor; } return all; }
        listTools() { return this._list('tools/list', 'tools'); }
        callTool(name, args, opts) { return this.request('tools/call', { name, arguments: args || {} }, { timeoutMs: (opts && opts.timeoutMs) || 120000 }); }
        listResources() { return this._list('resources/list', 'resources'); }
        readResource(uri) { return this.request('resources/read', { uri }); }
        listPrompts() { return this._list('prompts/list', 'prompts'); }
        getPrompt(name, args) { return this.request('prompts/get', { name, arguments: args || {} }); }
        async close() { this.closed = true; for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(new McpError('連線已關閉', -32000)); } this.pending.clear(); try { await this.t.close(); } catch (_) { /* */ } }
    }

    // ===== 傳輸 =====
    // stdio：換行分隔的 JSON；子行程由主程式啟動，bridge 是 { start(spec)→id, write(id,text), stop(id), onData(fn(id,text,stream)), onExit(fn(id,code,signal)) }
    class StdioTransport {
        constructor(bridge, spec) { this.b = bridge; this.spec = spec; this.id = null; this.buf = ''; this.stderr = []; this.onmessage = null; this.onclose = null; this.onerror = null; }
        async start() { const r = await this.b.start(this.spec); if (!r || r.ok === false) throw new Error((r && r.error) || '啟動失敗'); this.id = r.id; this.pid = r.pid; this._off = [this.b.onData((id, text, stream) => { if (id !== this.id) return; if (stream === 'stderr') { this.stderr.push(text); if (this.stderr.length > 200) this.stderr.shift(); return; } this.buf += text; let i; while ((i = this.buf.indexOf('\n')) >= 0) { const line = this.buf.slice(0, i).replace(/\r$/, ''); this.buf = this.buf.slice(i + 1); if (!line.trim()) continue; let m = null; try { m = JSON.parse(line); } catch (_) { this.stderr.push('[非 JSON 的輸出] ' + line.slice(0, 200)); continue; } if (this.onmessage) this.onmessage(m); } }), this.b.onExit((id, code, signal) => { if (id !== this.id) return; if (this.onclose) this.onclose('子行程結束（code ' + code + (signal ? ', ' + signal : '') + '）' + (this.stderr.length ? '：' + this.stderr.slice(-3).join(' | ').slice(0, 300) : '')); })]; }
        async send(msg) { if (this.id == null) throw new Error('還沒啟動'); const r = await this.b.write(this.id, JSON.stringify(msg) + '\n'); if (r && r.ok === false) throw new Error(r.error || '寫入失敗'); }
        async close() { if (this.id != null) { try { await this.b.stop(this.id); } catch (_) { /* */ } } for (const f of this._off || []) { try { if (typeof f === 'function') f(); } catch (_) { /* */ } } }
        logs() { return this.stderr.slice(-50).join('\n'); }
    }
    // Streamable HTTP：每個訊息 POST 一次；回應是 application/json 或 text/event-stream。202＝通知已收到。session 用 Mcp-Session-Id。
    class HttpTransport {
        constructor(url, opts) { opts = opts || {}; this.url = url; this.headers = opts.headers || {}; this.fetch = opts.fetch || ((typeof fetch !== 'undefined') ? fetch.bind(globalThis) : null); this.session = null; this.pv = null; this.onmessage = null; this.onclose = null; this.onerror = null; this.closed = false; this.ctrl = new Set(); }
        async start() { if (!this.fetch) throw new Error('這個環境沒有 fetch'); }
        setProtocolVersion(v) { this.pv = v; }
        async send(msg) {
            const h = Object.assign({ 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, this.headers); if (this.session) h['Mcp-Session-Id'] = this.session; if (this.pv) h['MCP-Protocol-Version'] = this.pv;
            const ac = typeof AbortController !== 'undefined' ? new AbortController() : null; if (ac) this.ctrl.add(ac); let resp;
            try { resp = await this.fetch(this.url, { method: 'POST', headers: h, body: JSON.stringify(msg), signal: ac ? ac.signal : undefined }); } catch (e) { if (ac) this.ctrl.delete(ac); throw new Error('連不上 ' + this.url + '：' + String((e && e.message) || e)); }
            const sid = resp.headers && resp.headers.get && resp.headers.get('Mcp-Session-Id'); if (sid) this.session = sid;
            if (resp.status === 202 || resp.status === 204) { if (ac) this.ctrl.delete(ac); return; }
            if (!resp.ok) { if (ac) this.ctrl.delete(ac); let body = ''; try { body = (await resp.text()).slice(0, 200); } catch (_) { /* */ } throw new Error('HTTP ' + resp.status + (body ? '：' + body : '') + (resp.status === 401 || resp.status === 403 ? '（可能需要在 headers 帶金鑰或權杖）' : '')); }
            const ct = (resp.headers && resp.headers.get && resp.headers.get('content-type')) || '';
            if (/text\/event-stream/i.test(ct)) { const done = this._readSse(resp, ac); if (msg.id == null) { done.catch(() => {}); return; } done.catch((e) => { if (this.onerror) this.onerror(e); }); return; }
            const j = await resp.json(); if (ac) this.ctrl.delete(ac); for (const m of (Array.isArray(j) ? j : [j])) if (this.onmessage) this.onmessage(m);
        }
        async _readSse(resp, ac) { const p = createSseParser((ev) => { if (ev.event !== 'message') return; try { const m = JSON.parse(ev.data); if (this.onmessage) this.onmessage(m); } catch (_) { /* 非 JSON 事件略過 */ } }); const rd = resp.body && resp.body.getReader ? resp.body.getReader() : null; const td = new TextDecoder(); try { if (rd) { for (;;) { const { value, done } = await rd.read(); if (done) break; p.feed(td.decode(value, { stream: true })); } } else p.feed(await resp.text()); p.end(); } finally { if (ac) this.ctrl.delete(ac); } }
        async close() { this.closed = true; for (const a of this.ctrl) { try { a.abort(); } catch (_) { /* */ } } this.ctrl.clear(); if (this.session) { try { await this.fetch(this.url, { method: 'DELETE', headers: Object.assign({ 'Mcp-Session-Id': this.session }, this.headers) }); } catch (_) { /* 伺服器不一定支援 */ } } }
    }
    // 舊版 HTTP+SSE：GET url 開事件串流，第一個 endpoint 事件給 POST 的位置
    class SseTransport {
        constructor(url, opts) { opts = opts || {}; this.url = url; this.headers = opts.headers || {}; this.fetch = opts.fetch || ((typeof fetch !== 'undefined') ? fetch.bind(globalThis) : null); this.endpoint = null; this.onmessage = null; this.onclose = null; this.onerror = null; this.ac = typeof AbortController !== 'undefined' ? new AbortController() : null; }
        async start() {
            const resp = await this.fetch(this.url, { headers: Object.assign({ Accept: 'text/event-stream' }, this.headers), signal: this.ac ? this.ac.signal : undefined }); if (!resp.ok) throw new Error('HTTP ' + resp.status + '（' + this.url + '）'); let resolveEp, rejectEp; const epReady = new Promise((a, b) => { resolveEp = a; rejectEp = b; }); const to = setTimeout(() => rejectEp(new Error('等不到 endpoint 事件（這可能不是 SSE 型的 MCP 伺服器）')), 15000);
            const p = createSseParser((ev) => { if (ev.event === 'endpoint') { this.endpoint = new URL(ev.data, this.url).href; clearTimeout(to); resolveEp(); } else if (ev.event === 'message') { try { if (this.onmessage) this.onmessage(JSON.parse(ev.data)); } catch (_) { /* */ } } });
            (async () => { try { const rd = resp.body.getReader(); const td = new TextDecoder(); for (;;) { const { value, done } = await rd.read(); if (done) break; p.feed(td.decode(value, { stream: true })); } if (this.onclose) this.onclose('事件串流結束'); } catch (e) { if (!(this.ac && this.ac.signal.aborted)) { if (this.onerror) this.onerror(e); if (this.onclose) this.onclose(String((e && e.message) || e)); } } })();
            await epReady;
        }
        async send(msg) { if (!this.endpoint) throw new Error('還沒連上'); const r = await this.fetch(this.endpoint, { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, this.headers), body: JSON.stringify(msg) }); if (!r.ok) throw new Error('HTTP ' + r.status); }
        async close() { if (this.ac) this.ac.abort(); }
    }

    return { PROTOCOL_VERSIONS, CLIENT_INFO, stripJsonc, sanitizeName, maskEnv, SENSITIVE, normalizeServer, parseConfigText, substitute, parseManifest, keyFiles, detectProject, toolName, formatResult, createSseParser, McpError, McpClient, StdioTransport, HttpTransport, SseTransport };
});
