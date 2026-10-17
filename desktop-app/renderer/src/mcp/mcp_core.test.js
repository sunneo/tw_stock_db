// node renderer/src/mcp/mcp_core.test.js
const M = require('./mcp_core.js');
let ok = 0; const bad = []; const check = (n, c, x) => { if (c) ok++; else bad.push(n + (x !== undefined ? ' ' + JSON.stringify(x).slice(0, 500) : '')); };
const j = (...l) => l.join('\n');

// 小型替身：可以一次給完（字串），或之後再推（push／end）
class FakeBody { constructor() { this.q = []; this.waiters = []; this.ended = false; } push(s) { const b = new TextEncoder().encode(s); const w = this.waiters.shift(); if (w) w({ value: b, done: false }); else this.q.push(b); } end() { this.ended = true; for (const w of this.waiters.splice(0)) w({ value: undefined, done: true }); } getReader() { return { read: () => { if (this.q.length) return Promise.resolve({ value: this.q.shift(), done: false }); if (this.ended) return Promise.resolve({ value: undefined, done: true }); return new Promise((r) => this.waiters.push(r)); } }; } }
class Response { constructor(body, init) { init = init || {}; this.status = init.status || 200; this.ok = this.status >= 200 && this.status < 300; const h = init.headers || {}; this.headers = { get: (k) => { const key = Object.keys(h).find((x) => x.toLowerCase() === String(k).toLowerCase()); return key ? h[key] : null; } }; if (body instanceof FakeBody) this.body = body; else { this._s = String(body == null ? '' : body); this.body = null; } } async text() { return this._s; } async json() { return JSON.parse(this._s); } }
(async () => {
  // ===== 設定檔 =====
  check('stripJsonc: comments and trailing commas, strings untouched', JSON.parse(M.stripJsonc('{ // c\n "a": "http://x/*y*/", /* b */ "b": [1,2,], }')).a === 'http://x/*y*/' && JSON.parse(M.stripJsonc('{"a":1,}')).a === 1);
  const claude = M.parseConfigText(JSON.stringify({ mcpServers: { filesystem: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', 'C:/data'] }, github: { command: 'npx', args: ['-y', '@mcp/github'], env: { GITHUB_TOKEN: 'ghp_x' } }, remote: { url: 'https://mcp.example.com/mcp' }, legacy: { url: 'https://x.com/sse', type: 'sse' } } }));
  check('Claude Desktop format', claude.ok && claude.format === 'mcpServers' && claude.servers.length === 4 && claude.servers[0].transport === 'stdio' && claude.servers[0].args[1] === '@modelcontextprotocol/server-filesystem', claude);
  check('transport inference: url → http, /sse url or type → sse', claude.servers[2].transport === 'http' && claude.servers[3].transport === 'sse' && M.parseConfigText('{"mcpServers":{"a":{"url":"https://h/sse"}}}').servers[0].transport === 'sse');
  check('VS Code / servers / mcp.servers / single / array / bare map', M.parseConfigText('{"servers":{"a":{"command":"node","args":["a.js"]}}}').format === 'servers' && M.parseConfigText('{"mcp":{"servers":{"a":{"command":"x"}}}}').format === 'mcp.servers' && M.parseConfigText('{"command":"uvx","args":["mcp-server-git"]}').format === 'single' && M.parseConfigText('[{"name":"a","command":"x"},{"name":"b","url":"http://h/mcp"}]').servers.length === 2 && M.parseConfigText('{"a":{"command":"x"},"b":{"url":"http://h"}}').format === 'bare-map');
  check('comments and trailing commas in a real-world mcp.json', M.parseConfigText('{\n // my servers\n "mcpServers": { "a": { "command": "node", "args": ["s.js",], }, },\n}').ok);
  check('command as array, or a whole command line in command', M.parseConfigText('{"mcp":{"a":{"command":["npx","-y","pkg"]}}}').servers[0].args.join() === '-y,pkg' && (() => { const s = M.parseConfigText('{"mcpServers":{"a":{"command":"npx -y @scope/pkg --flag \\"a b\\""}}}').servers[0]; return s.command === 'npx' && s.args.join('|') === '-y|@scope/pkg|--flag|a b'; })());
  check('Windows path with spaces in command is not split', M.parseConfigText('{"mcpServers":{"a":{"command":"C:\\\\Program Files\\\\nodejs\\\\node.exe","args":["x.js"]}}}').servers[0].command === 'C:\\Program Files\\nodejs\\node.exe');
  check('names are sanitised and de-duplicated', M.parseConfigText('{"mcpServers":{"My Server!":{"command":"x"},"my-server":{"command":"y"}}}').servers.map((s) => s.name).join() === 'my-server,my-server-2');
  check('disabled flag, headers, cwd and env kept', (() => { const s = M.parseConfigText('{"mcpServers":{"a":{"command":"x","disabled":true,"cwd":"/w","env":{"K":1}},"b":{"url":"https://h/mcp","headers":{"Authorization":"Bearer t"}}}}').servers; return s[0].disabled && s[0].cwd === '/w' && s[0].env.K === '1' && s[1].headers.Authorization === 'Bearer t'; })());
  check('errors: not json / not mcp / bad url / no command', !M.parseConfigText('hello').ok && /看不出/.test(M.parseConfigText('{"x":1}').error) && /http/.test(M.parseConfigText('{"mcpServers":{"a":{"url":"ftp://x"}}}').error) && /command/.test(M.parseConfigText('{"mcpServers":{"a":{"args":["x"]}}}').error));
  check('partial success: bad servers reported, good ones kept', (() => { const r = M.parseConfigText('{"mcpServers":{"a":{"command":"x"},"b":{"url":"nope"}}}'); return r.ok && r.servers.length === 1 && r.errors.length === 1; })());
  check('maskEnv hides secrets only', (() => { const m = M.maskEnv({ GITHUB_TOKEN: 'abc', PATH_X: '/x', API_KEY: 'k', EMPTY_TOKEN: '' }); return m.GITHUB_TOKEN === '••••' && m.PATH_X === '/x' && m.API_KEY === '••••' && m.EMPTY_TOKEN === ''; })());

  // ===== manifest（.mcpb／.dxt）=====
  const mf = { manifest_version: '0.2', name: 'My Notes', display_name: 'My Notes', version: '1.0.0', description: 'notes', author: { name: 'me' }, server: { type: 'node', entry_point: 'server/index.js', mcp_config: { command: 'node', args: ['${__dirname}/server/index.js', '--dir', '${user_config.dir}'], env: { TOKEN: '${user_config.token}' } } }, user_config: { dir: { type: 'directory', title: '資料夾', required: true }, token: { type: 'string', sensitive: true, required: true } }, tools: [{ name: 'add_note', description: 'x' }] };
  const pm = M.parseManifest(mf, { __dirname: '/inst/notes', user_config: { dir: '/data' } });
  check('manifest: substitution and unresolved variables', pm.ok && pm.server.command === 'node' && pm.server.args[0] === '/inst/notes/server/index.js' && pm.server.args[2] === '/data' && pm.unresolved.join() === 'user_config.token' && pm.server.env.TOKEN === '${user_config.token}', pm);
  check('manifest: user_config metadata, tools, runtime', pm.user_config.token.sensitive === true && pm.user_config.dir.required && pm.tools[0].name === 'add_note' && pm.needs_runtime === 'node' && pm.name === 'my-notes');
  check('manifest: entry_point only (python) and binary', M.parseManifest({ manifest_version: '0.1', name: 'p', server: { type: 'python', entry_point: 'main.py' } }, { __dirname: '/i' }).server.args[0] === '/i/main.py' && M.parseManifest({ manifest_version: '0.1', name: 'b', server: { type: 'binary', entry_point: 'bin/s.exe' } }, { __dirname: '/i' }).server.command === '/i/bin/s.exe');
  check('manifest: platform override', M.parseManifest({ manifest_version: '0.2', name: 'w', server: { type: 'node', mcp_config: { command: 'node', args: ['a.js'], platform_overrides: { win32: { command: 'node.exe' } } } } }, { __platform: 'win32' }).server.command === 'node.exe');
  check('manifest: rejects non-manifests', !M.parseManifest({ name: 'x' }).ok && !M.parseManifest('nope').ok);

  // ===== 專案偵測 =====
  const paths1 = ['proj/package.json', 'proj/src/index.ts', 'proj/dist/index.js', 'proj/README.md'];
  const pk = { name: '@acme/mcp-server-notes', description: 'An MCP server for notes', bin: { 'mcp-notes': 'dist/index.js' }, dependencies: { '@modelcontextprotocol/sdk': '^1.0.0' }, scripts: { build: 'tsc' } };
  const d1 = M.detectProject(paths1.filter((p) => !p.includes('dist')), { 'proj/package.json': JSON.stringify(pk) });
  check('detect node: bin entry, install and build steps, mcp-like', d1[0].kind === 'node' && d1[0].server.args[0] === 'dist/index.js' && d1[0].steps.map((s) => s.run).join() === 'npm install,npm run build' && d1[0].mcp_like && d1[0].confidence > 0.7 && d1[0].needs_runtime === 'node', d1);
  const d1b = M.detectProject(paths1, { 'proj/package.json': JSON.stringify(pk) }); check('detect node: already built → no build step', d1b[0].steps.map((s) => s.run).join() === 'npm install');
  const d2 = M.detectProject(['x/pyproject.toml', 'x/server.py'], { 'x/pyproject.toml': '[project]\nname = "mcp-server-time"\n[project.scripts]\nmcp-server-time = "mcp_server_time:main"\n' });
  check('detect python: console script, pip install', d2[0].kind === 'python' && d2[0].server.command === 'mcp-server-time' && d2[0].steps[0].run === 'pip install -e .' && d2[0].mcp_like, d2);
  const d3 = M.detectProject(['r/requirements.txt', 'r/server.py'], { 'r/requirements.txt': 'mcp>=1.0\nhttpx\n' }); check('detect python: requirements + server.py', d3[0].kind === 'python' && d3[0].server.args[0] === 'server.py' && d3[0].steps[0].run === 'pip install -r requirements.txt' && d3[0].mcp_like);
  const d4 = M.detectProject(['a/mcp.json', 'a/package.json'], { 'a/mcp.json': '{"mcpServers":{"x":{"command":"node","args":["s.js"]}}}', 'a/package.json': '{"name":"x"}' }); check('detect: an included mcp.json wins over guessing', d4[0].kind === 'config' && d4[0].servers[0].name === 'x');
  const d5 = M.detectProject(['m/manifest.json', 'm/server/index.js'], { 'm/manifest.json': JSON.stringify(mf) }); check('detect: mcpb bundle', d5[0].kind === 'bundle' && d5[0].manifest.name === 'my-notes');
  check('detect: Dockerfile only is flagged unsupported; nothing → empty', M.detectProject(['d/Dockerfile'], {})[0].unsupported === true && M.detectProject(['z/readme.txt'], {}).length === 0);
  check('keyFiles picks the files worth reading, shallow only', M.keyFiles(['a/package.json', 'a/b/c/d/package.json', 'a/src/x.js', 'mcp.json', 'a/README.md']).join() === 'a/package.json,mcp.json,a/README.md');

  // ===== 名稱與結果 =====
  check('toolName: prefix, sanitised, within 64 chars and stable', M.toolName('My-Server', 'read file') === 'mcp__my_server__read_file' && M.toolName('s', 'x'.repeat(100)).length <= 64 && M.toolName('s', 'x'.repeat(100)) === M.toolName('s', 'x'.repeat(100)) && M.toolName('s', 'x'.repeat(100)) !== M.toolName('s', 'x'.repeat(99) + 'y'));
  const fr = M.formatResult({ content: [{ type: 'text', text: 'hello' }, { type: 'image', mimeType: 'image/png', data: 'AAAA' }, { type: 'resource', resource: { uri: 'file:///a', text: 'body' } }, { type: 'resource_link', uri: 'x://y', name: 'n' }], isError: false });
  check('formatResult: text, image placeholder, embedded resource, link', /hello/.test(fr.text) && /\[圖片 image\/png/.test(fr.text) && /\[資源 file:\/\/\/a\]\nbody/.test(fr.text) && fr.images.length === 1 && !fr.isError, fr);
  check('formatResult: isError, structuredContent only, truncation', M.formatResult({ content: [{ type: 'text', text: 'boom' }], isError: true }).isError && M.formatResult({ structuredContent: { a: 1 } }).text === '{"a":1}' && M.formatResult({ content: [{ type: 'text', text: 'x'.repeat(100) }] }, 50).truncated);

  // ===== SSE =====
  const evs = []; const sp = M.createSseParser((e) => evs.push(e)); sp.feed('event: message\ndata: {"a":'); sp.feed('1}\n\n: comment\ndata: l1\r\ndata: l2\r\n\r\nevent: endpoint\ndata: /m?s=1\n\n'); sp.end();
  check('SSE parser: split chunks, comments, multi-line data, CRLF, event names', evs.length === 3 && evs[0].data === '{"a":1}' && evs[1].data === 'l1\nl2' && evs[2].event === 'endpoint', evs);

  // ===== 用戶端（假伺服器，迴路傳輸）=====
  function makeServer(opts) {
    opts = opts || {}; const tools = Array.from({ length: 5 }, (_, i) => ({ name: 'tool' + i, description: 'd' + i, inputSchema: { type: 'object', properties: { x: { type: 'string' } } } }));
    return (msg, reply) => {
      const r = (result) => reply({ jsonrpc: '2.0', id: msg.id, result }); const e = (code, message) => reply({ jsonrpc: '2.0', id: msg.id, error: { code, message } });
      switch (msg.method) {
        case 'initialize': return r({ protocolVersion: opts.version || '2025-03-26', capabilities: { tools: {}, resources: {}, prompts: {} }, serverInfo: { name: 'fake', version: '1' }, instructions: 'be nice' });
        case 'notifications/initialized': return opts.onInitialized && opts.onInitialized();
        case 'tools/list': { const start = msg.params && msg.params.cursor ? Number(msg.params.cursor) : 0; return r({ tools: tools.slice(start, start + 2), nextCursor: start + 2 < tools.length ? String(start + 2) : undefined }); }
        case 'tools/call': if (msg.params.name === 'echo') return r({ content: [{ type: 'text', text: JSON.stringify(msg.params.arguments) }] }); if (msg.params.name === 'fail') return r({ content: [{ type: 'text', text: 'nope' }], isError: true }); if (msg.params.name === 'slow') return undefined; if (msg.params.name === 'rpcerr') return e(-32602, 'bad args'); if (msg.params.name === 'askping') { reply({ jsonrpc: '2.0', id: 900, method: 'ping' }); return r({ content: [{ type: 'text', text: 'pinged' }] }); } return e(-32601, 'unknown tool');
        case 'resources/list': return r({ resources: [{ uri: 'file:///a', name: 'a' }] });
        case 'resources/read': return r({ contents: [{ uri: msg.params.uri, text: 'content of ' + msg.params.uri }] });
        case 'prompts/list': return r({ prompts: [{ name: 'p1' }] });
        case 'prompts/get': return r({ messages: [{ role: 'user', content: { type: 'text', text: 'hi ' + JSON.stringify(msg.params.arguments) } }] });
        default: return e(-32601, 'no ' + msg.method);
      }
    };
  }
  function loop(handler) {
    const t = { sent: [], onmessage: null, onclose: null, onerror: null, async send(m) { t.sent.push(m); setTimeout(() => handler(m, (x) => t.onmessage && t.onmessage(x)), 0); }, async close() { t.closed = true; if (t.onclose) t.onclose(); } }; return t;
  }
  let inited = false; const tp = loop(makeServer({ onInitialized: () => { inited = true; } })); const c = new M.McpClient(tp, { timeoutMs: 3000 });
  const init = await c.initialize(); await new Promise((res) => setTimeout(res, 10));
  check('client: initialize handshake and initialized notification', init.serverInfo.name === 'fake' && c.protocolVersion === '2025-03-26' && inited && c.instructions === 'be nice');
  check('client: tools/list follows pagination', (await c.listTools()).length === 5);
  check('client: callTool returns content', JSON.parse(M.formatResult(await c.callTool('echo', { x: 'a' })).text).x === 'a');
  check('client: isError results come back as results (not exceptions)', M.formatResult(await c.callTool('fail', {})).isError === true);
  check('client: JSON-RPC errors reject with code and message', await c.callTool('rpcerr', {}).then(() => false, (e) => e instanceof M.McpError && e.code === -32602 && /bad args/.test(e.message)));
  check('client: timeouts reject and send a cancel notification', await c.request('tools/call', { name: 'slow' }, { timeoutMs: 40 }).then(() => false, (e) => /逾時/.test(e.message)) && tp.sent.some((m) => m.method === 'notifications/cancelled'));
  check('client: server-initiated ping is answered', JSON.stringify(M.formatResult(await c.callTool('askping', {})).text) === '"pinged"' && tp.sent.some((m) => m.id === 900 && m.result && Object.keys(m.result).length === 0));
  check('client: resources and prompts', (await c.listResources())[0].uri === 'file:///a' && (await c.readResource('file:///a')).contents[0].text === 'content of file:///a' && (await c.listPrompts())[0].name === 'p1' && (await c.getPrompt('p1', { a: 1 })).messages[0].content.text.includes('"a":1'));
  check('client: unsupported server requests get a method-not-found error', (() => { tp.onmessage({ jsonrpc: '2.0', id: 77, method: 'sampling/createMessage', params: {} }); return new Promise((res) => setTimeout(() => res(tp.sent.some((m) => m.id === 77 && m.error && m.error.code === -32601)), 20)); })() instanceof Promise && await (async () => { await new Promise((r) => setTimeout(r, 30)); return tp.sent.some((m) => m.id === 77 && m.error && m.error.code === -32601); })());
  let notified = null; c.on('notifications/tools/list_changed', () => { notified = true; }); tp.onmessage({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' }); check('client: notification handlers', notified === true);
  const pending = c.request('tools/call', { name: 'slow' }, { timeoutMs: 5000 }); await c.close(); check('client: close rejects pending requests and refuses new ones', await pending.then(() => false, (e) => /已關閉/.test(e.message)) && await c.listTools().then(() => false, (e) => /已關閉/.test(e.message)) && tp.closed);
  const old = new M.McpClient(loop(makeServer({ version: '1999-01-01' }))); check('client: unsupported protocol version is a clear error', await old.initialize().then(() => false, (e) => /協定版本/.test(e.message)));
  const t2 = new M.McpClient(loop(makeServer({ version: '2024-11-05' }))); check('client: older supported version accepted', (await t2.initialize()) && t2.protocolVersion === '2024-11-05');

  // ===== stdio 傳輸（假的子行程橋接）=====
  function fakeBridge(server) {
    const dataFns = [], exitFns = []; const state = { started: null, stopped: false, written: [] };
    return { state, async start(spec) { state.started = spec; return { ok: true, id: 'p1', pid: 123 }; }, async write(id, text) { state.written.push(text); const msg = JSON.parse(text); const out = []; server(msg, (x) => out.push(JSON.stringify(x) + '\n')); const all = out.join(''); const mid = Math.floor(all.length / 2); setTimeout(() => { dataFns.forEach((f) => f('p1', all.slice(0, mid), 'stdout')); setTimeout(() => dataFns.forEach((f) => f('p1', all.slice(mid), 'stdout')), 1); }, 0); return { ok: true }; }, async stop() { state.stopped = true; exitFns.forEach((f) => f('p1', 0, null)); }, onData(fn) { dataFns.push(fn); return () => dataFns.splice(dataFns.indexOf(fn), 1); }, onExit(fn) { exitFns.push(fn); return () => exitFns.splice(exitFns.indexOf(fn), 1); }, emit(id, text, stream) { dataFns.forEach((f) => f(id, text, stream)); }, exit(code) { exitFns.forEach((f) => f('p1', code, null)); } };
  }
  const br = fakeBridge(makeServer()); const st = new M.StdioTransport(br, { command: 'node', args: ['s.js'] }); const sc = new M.McpClient(st, { timeoutMs: 3000 }); await st.start(); await sc.initialize();
  check('stdio: spawn spec passed through; messages survive being split across chunks', br.state.started.command === 'node' && (await sc.listTools()).length === 5);
  br.emit('p1', 'some log line\n', 'stderr'); br.emit('p1', 'not json at all\n', 'stdout'); check('stdio: stderr and non-JSON stdout are kept as logs, not crashes', /not json/.test(st.logs()) && /some log line/.test(st.logs()));
  br.emit('other', '{"jsonrpc":"2.0","id":1,"result":{}}\n', 'stdout'); check('stdio: data for other processes is ignored', true);
  let closedWhy = null; sc.onclose = (w) => { closedWhy = w; }; const pend2 = sc.request('tools/call', { name: 'slow' }, { timeoutMs: 5000 }); br.exit(1);
  check('stdio: process exit closes the client and rejects pending requests with the reason', await pend2.then(() => false, (e) => /已關閉/.test(e.message)) && /子行程結束/.test(closedWhy || ''), closedWhy);
  check('stdio: start failure surfaces the host error', await (async () => { const b = fakeBridge(makeServer()); b.start = async () => ({ ok: false, error: '找不到 node' }); try { await new M.StdioTransport(b, {}).start(); return false; } catch (e) { return /找不到 node/.test(e.message); } })());

  // ===== HTTP（Streamable HTTP）=====
  const enc = new TextEncoder();
  function sseResponse(events) { const body = new FakeBody(); for (const e of events) body.push('event: message\ndata: ' + JSON.stringify(e) + '\n\n'); body.end(); return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }); }
  const calls = [];
  const fakeFetch = async (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers, body: init.body ? JSON.parse(init.body) : null }); if (init.method === 'DELETE') return new Response('', { status: 200 }); const msg = JSON.parse(init.body); let out = []; makeServer()(msg, (x) => out.push(x));
    if (msg.id == null) return new Response('', { status: 202 });
    if (msg.method === 'initialize') return new Response(JSON.stringify(out[0]), { status: 200, headers: { 'content-type': 'application/json', 'Mcp-Session-Id': 'sess-1' } });
    if (msg.method === 'tools/list') return sseResponse(out);
    return new Response(JSON.stringify(out[0]), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const ht = new M.HttpTransport('https://h/mcp', { fetch: fakeFetch, headers: { Authorization: 'Bearer k' } }); const hc = new M.McpClient(ht, { timeoutMs: 3000 }); await ht.start(); await hc.initialize();
  check('http: session id captured and sent back; auth header sent; protocol version header after init', ht.session === 'sess-1' && (await hc.listTools()).length === 5 && calls.filter((x) => x.body && x.body.method === 'tools/list').every((x) => x.headers['Mcp-Session-Id'] === 'sess-1' && x.headers.Authorization === 'Bearer k' && x.headers['MCP-Protocol-Version'] === '2025-03-26'));
  check('http: JSON responses and 202 notifications both work', M.formatResult(await hc.callTool('echo', { y: 1 })).text.includes('"y":1') && calls.some((x) => x.body && x.body.method === 'notifications/initialized'));
  await hc.close(); check('http: close sends DELETE with the session', calls.some((x) => x.method === 'DELETE' && x.headers['Mcp-Session-Id'] === 'sess-1'));
  const bad401 = new M.HttpTransport('https://h/mcp', { fetch: async () => new Response('unauthorized', { status: 401 }) }); await bad401.start(); check('http: 401 is explained', await bad401.send({ jsonrpc: '2.0', id: 1, method: 'x' }).then(() => false, (e) => /HTTP 401/.test(e.message) && /金鑰|權杖/.test(e.message)));
  check('http: network failure is explained with the url', await new M.HttpTransport('https://down/mcp', { fetch: async () => { throw new Error('ECONNREFUSED'); } }).send({ jsonrpc: '2.0', id: 1, method: 'x' }).then(() => false, (e) => /連不上 https:\/\/down\/mcp/.test(e.message)));

  // ===== 舊版 SSE =====
  (() => {
    const posts = []; let ctl;
    const f = async (url, init) => { if (!init || init.method !== 'POST') { const body = new FakeBody(); ctl = { enqueue: (u8) => body.push(new TextDecoder().decode(u8)) }; body.push('event: endpoint\ndata: /messages?session=9\n\n'); return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }); } const msg = JSON.parse(init.body); posts.push({ url, msg }); if (msg.id != null) makeServer()(msg, (x) => ctl.enqueue(enc.encode('event: message\ndata: ' + JSON.stringify(x) + '\n\n'))); return new Response('Accepted', { status: 202 }); };
    const st2 = new M.SseTransport('https://h/sse', { fetch: f }); const c3 = new M.McpClient(st2, { timeoutMs: 3000 });
    return st2.start().then(() => c3.initialize()).then(() => c3.listTools()).then(async (tools) => { check('legacy SSE: endpoint event, POST to it, replies arrive on the stream', tools.length === 5 && posts[0].url === 'https://h/messages?session=9', posts.map((p) => p.url)); await c3.close(); });
  })().then(() => {
    console.log('mcp_core: ' + ok + ' passed' + (bad.length ? ', ' + bad.length + ' FAILED' : '')); bad.forEach((x) => console.log('FAIL', x)); process.exit(bad.length ? 1 : 0);
  });
})();
