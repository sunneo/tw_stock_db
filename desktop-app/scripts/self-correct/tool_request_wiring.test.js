// 申請工具（request_additional_tools）沒發揮作用的檢討（2026-11-12）：模型直接叫名單外的工具（簡報領域叫 generate_image），
// 被當成最終答案、沒有糾正。修正：名單外的真工具自動追加；追加不了時退回並教它申請；簡報領域本來就有 generate_image；畫圖結果直接給 ref。
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '../..'); const fa = fs.readFileSync(path.join(root, 'renderer/src/floating-assistant.js'), 'utf8'); const dt = fs.readFileSync(path.join(root, 'renderer/src/deck/deck_tools.js'), 'utf8');
let ok = 0; const bad = []; const check = (n, c) => { if (c) ok++; else bad.push(n); };
check('簡報領域工具清單有 generate_image', /const DOMAIN_TOOLS = \['generate_image'/.test(dt));
check('子任務執行器有自動追加（autoGrantTool），跟申請共用上限', /function autoGrantTool\(fnName\)/.test(fa) && /toolEscalationCount >= SUBAGENT_MAX_TOOL_ESCALATIONS\) return false/.test(fa));
check('高風險工具不自動追加', /run_command\|bash_execute\|python_execute\|fs_write_file/.test(fa));
check('文字寫成的名單外呼叫：先試自動追加', /autoGrantTool\(dc2\.name\)/.test(fa));
check('名單外的工具描述呼叫不再被當最終答案（會退回並教申請）', /名單外但真的存在的工具/.test(fa) && /它不在你目前的工具名單裡，沒有被執行/.test(fa));
check('偵測函式不再因名單外就放過', /名單外的工具也要認得/.test(fa));
check('畫圖結果直接給 ref，不必再匯入', /_deckAnnotateResult\(toolName, result\)/.test(dt) && /result = this\._deckAnnotateResult\(fnName, result\)/.test(fa));
console.log(bad.length ? 'FAILED:\n  ' + bad.join('\n  ') : 'tool_request_wiring: ' + ok + ' passed'); process.exit(bad.length ? 1 : 0);
