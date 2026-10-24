// computer use 的渲染端接線（真實 Electron，自己的 Xvfb；不啟用功能——啟用要在原生視窗按確認，端到端的核准流程在 scripts/computer-tests/electron.itest.js）：
// preload 的 desktopAPI.computer、18 個 computer_* 工具與 computer_use 領域有註冊、/computer 指令、停用時工具如實說沒啟用、工具路由提示。
// 用法：FA_DEBUG_EVAL_FILE=scripts/eval/computer.eval.js xvfb-run -a node_modules/electron/dist/electron . --no-sandbox --user-data-dir=$(mktemp -d)
const fa = window.fa; const R = {}; const wait = (ms) => new Promise((r) => setTimeout(r, ms)); fa.messages = [];
const c = window.desktopAPI && window.desktopAPI.computer; R.preload = { api: !!c, methods: c ? Object.keys(c).length : 0 };
const st = await c.status(); R.status = { enabled: st.enabled, scope: !!st.scope, aborted: !!st.aborted };
const cap = await c.capabilities(); R.capabilities = { ok: cap.ok, platform: cap.platform, has_features: !!cap.features, keys: cap.features ? Object.keys(cap.features).slice(0, 8) : null, a11y: cap.features && cap.features.a11y };
const names = FaComputerHost.TOOL_NAMES; R.tools = { count: names.length, registered: names.filter((n) => fa.tools && fa.tools[n]).length, gated: names.filter((n) => fa._domainGatedToolNames && fa._domainGatedToolNames.has(n)).length };
R.domain = { exists: !!(fa.domains && fa.domains.computer_use), enabled: !!(fa.domains && fa.domains.computer_use && fa.domains.computer_use.enabled), tools: fa.domains && fa.domains.computer_use ? fa.domains.computer_use.toolNames.length : 0, resolved: fa.domains && fa.domains.computer_use ? fa._resolveRunToolNames(fa.domains.computer_use).length : 0 };
const cmd = (x) => (fa.slashCommands.get ? fa.slashCommands.get(x) : fa.slashCommands[x]); R.slash = !!cmd('/computer');
await cmd('/computer').handler('', fa); const last = () => String((fa.messages[fa.messages.length - 1] || {}).content || ''); R.slash_status = { text: last().slice(0, 160), mentions_enable: /enable/.test(last()), says_off: /關閉|沒有啟用|未啟用|disabled|off/i.test(last()) };
await cmd('/computer').handler('windows', fa); R.slash_windows = last().slice(0, 140);
// tools refuse politely while disabled (nothing is touched)
const call = async (n, a) => { try { return JSON.parse(await fa.tools[n].callback.call(fa, JSON.stringify(a || {}))); } catch (e) { return { threw: String(e.message || e) }; } };
R.tool_caps = await call('computer_capabilities'); R.tool_list = await call('computer_list_windows'); R.tool_click = await call('computer_click', { x: 10, y: 10 });
R.tool_click_ok = R.tool_click.ok === false && /啟用|enable|disabled|範圍/.test(JSON.stringify(R.tool_click)); R.tool_list_brief = R.tool_list && { ok: R.tool_list.ok, error: String(R.tool_list.error || '').slice(0, 100), n: (R.tool_list.windows || []).length };
const hints = ['看一下我現在螢幕上有什麼', '幫我點一下那個視窗的存檔按鈕', '連到遠端桌面 VNC 看畫面', '怎麼設定電腦操作', '今天天氣如何'].map((t) => _faTaskToolHints(t).map((h) => h.id).join()); R.hints = hints;
return R;
