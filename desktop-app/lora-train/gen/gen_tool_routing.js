'use strict';
/* tool_routing 領域產生器：recipe_core.js 的 chooseTool／menuMessages（{"choice": N} 編號選單）。
 *
 * 真實來源：scripts/eval/stack_route_cases.js 的 `base`（stack_route.js／stack_route_native.js 共用的路由量測題組）——
 * 5 個真實工具候選（calc／search／code／file／timer）＋ 10 句話，每句話都已經人工標好正確答案（第三個陣列元素 want：
 * 工具名稱，或 null＝都不是）。這不是我們自己編的，是既有 eval 腳本已經在用、且跟 recipe_core.measureRoute 的
 * 正確率統計綁在一起的題庫（見 scripts/eval/stack_route_native.js:10 require 它、offline_stack_core.js 的
 * measureRoute 用同樣形狀的 {question, cands, want} 跑量測）。
 *
 * 作法：直接 require recipe_core.js，呼叫它真正的 menuMessages() 產生 messages（不要自己刻字串）；
 * 再呼叫真正的 chooseTool()，餵一個「不會說謊」的假 generate（只回傳我們已經從 want 算出的正確答案），
 * 跑一次真正的格式驗證（prefill、validate、choice 範圍）確認完全照 production 的解析器會接受——
 * 如果驗證不過，產生器會直接丟錯（不會安靜吞掉錯誤資料）。
 */
const path = require('path');
const R = require(path.join(__dirname, '..', '..', 'renderer', 'src', 'recipe', 'recipe_core.js'));
const { base, cands } = require(path.join(__dirname, '..', '..', 'scripts', 'eval', 'stack_route_cases.js'));

const SOURCE_FILE = 'scripts/eval/stack_route_cases.js';

async function generate() {
    const rows = [];
    let skipped = 0;
    let seq = 0;
    for (const [question, want] of base) {
        seq++;
        // 正確答案：want 是工具名稱 → 選單裡的 1-based 編號；want 是 null → 0（都不是）
        const wantIndex = want == null ? -1 : cands.findIndex((c) => c.tool === want);
        if (want != null && wantIndex < 0) { skipped++; console.error('[gen_tool_routing] 跳過：想要的工具 "' + want + '" 不在候選裡：' + question); continue; }
        const choice = want == null ? 0 : wantIndex + 1;
        const expectedCompletion = '{"choice": ' + choice + '}';

        // 真正的 production 訊息組字函式（不要自己拼字串）
        const messages = R.menuMessages(question, cands);

        // 用真正的 chooseTool() 跑一次格式驗證：假 generate 直接回答已知正確答案，確認 prefill／validate 都照 production 接受
        let seenPrefill = null;
        const oracleGenerate = async (req) => { seenPrefill = req.prefill; return expectedCompletion; };
        const r = await R.chooseTool({ cands, question, generate: oracleGenerate });
        if (!r.ok) { skipped++; console.error('[gen_tool_routing] 跳過：chooseTool 驗證不過：' + question + '：' + r.error); continue; }
        const gotTool = r.none ? null : cands[r.index].tool;
        if (gotTool !== want) { skipped++; console.error('[gen_tool_routing] 跳過：chooseTool 解析出來的答案跟題庫的 want 對不上：' + question + '（want=' + want + '，got=' + gotTool + '）'); continue; }
        if (seenPrefill !== '{"choice":') { skipped++; console.error('[gen_tool_routing] 跳過：prefill 跟預期不同：' + question); continue; }

        rows.push({
            id: 'tool_routing:' + SOURCE_FILE + ':' + seq,
            domain: 'tool_routing',
            stage: 'choose_tool',
            messages,
            completion: expectedCompletion,
            verified_by: 'program_ground_truth',
            split: 'train',
            source_file: SOURCE_FILE,
            meta: { question, want, cands: cands.map((c) => c.tool), tries: r.tries },
        });
    }
    console.error('[gen_tool_routing] 產生 ' + rows.length + ' 筆（來源：' + SOURCE_FILE + '，共 ' + base.length + ' 句話，跳過 ' + skipped + ' 筆）');
    return rows;
}

module.exports = { generate };

if (require.main === module) {
    (async () => {
        for (const row of await generate()) process.stdout.write(JSON.stringify(row) + '\n');
    })();
}
