#!/usr/bin/env node
// 掃描各領域：系統提示（systemPrompt）裡點名要用、而且是真的已註冊的工具，卻不在該領域的 toolNames 名單裡 → 模型被叫去用拿不到的工具（2026-11-12 簡報領域缺 generate_image 的同一類問題）。
// 用法：node scripts/self-correct/domain_tools_scan.js [--json]；有缺漏時結束碼 1（只在要求時當測試用）。
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '../..'); const src = fs.readFileSync(path.join(root, 'renderer/src/floating-assistant.js'), 'utf8');
const deck = fs.readFileSync(path.join(root, 'renderer/src/deck/deck_tools.js'), 'utf8');
const registered = new Set(); for (const m of (src + deck).matchAll(/(?:register_openai_tool|registerOptional|\btool|reg)\(\s*['"]([a-z][a-z0-9_]+)['"]/g)) registered.add(m[1]);
// 已逐項看過、確定是「跨領域指路／不要用／出處說明」而不是要它去用的工具（2026-11-12 逐一檢視）；新增的缺漏不在這裡就會被報出來
const REVIEWED = { file_analysis: ['fetch_web_page'], browser_control: ['fap_write_file', 'fap_copy_from_storage', 'fap_download_url'], ai_functions: ['browser_search'], browser_search: ['transcribe_media', 'extract_audio', 'burn_subtitles'], media_av: ['summarize_large_text'], code_execution: ['browser_search', 'fetch_web_page'] };
function scan() {
    const a = src.indexOf('const SUBAGENT_DOMAIN_REGISTRY = {'); const b = src.indexOf('\n};\n', a); const blk = src.slice(a, b); const out = [];
    const re = /\n    ([A-Za-z0-9_]+): \{\n([\s\S]*?)(?=\n    [A-Za-z0-9_]+: \{\n|$)/g; let m;
    while ((m = re.exec(blk))) {
        const key = m[1], body = m[2]; const tn = /toolNames:\s*\[([\s\S]*?)\]/.exec(body); if (!tn) continue;
        const names = new Set(Array.from(tn[1].matchAll(/['"]([a-z][a-z0-9_]+)['"]/g)).map((x) => x[1]));
        const sp = /systemPrompt:\s*([\s\S]*?)(?:,\n\s+dynamicNote:|,\n\s+[a-zA-Z]+:|$)/.exec(body); const prompt = sp ? sp[1] : '';
        const missing = Array.from(new Set(Array.from(prompt.matchAll(/\b([a-z][a-z0-9]*(?:_[a-z0-9]+)+)\b/g)).map((x) => x[1]))).filter((n) => registered.has(n) && !names.has(n) && !((REVIEWED[key] || []).includes(n)) && !/^(request_additional_tools|delegate_to_subagent|get_tool_details|delegate_subtask|list_ai_features)$/.test(n));
        if (missing.length) out.push({ domain: key, missing });
    }
    return out;
}
if (require.main === module) { const r = scan(); console.log(process.argv.includes('--json') ? JSON.stringify(r, null, 1) : (r.length ? r.map((x) => x.domain + '：提示詞點名、但名單沒有 → ' + x.missing.join('、')).join('\n') : '沒有缺漏')); process.exit(r.length ? 1 : 0); }
module.exports = { scan };
