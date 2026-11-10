'use strict';
/* when2call 領域：用我們自己的 322 個真實工具（data/real_tools_all.json）程式合成五種行為：
 *   call（只填必要參數、值取自使用者原話）／ask（缺必填值→反問）／direct（寒暄→直接答）／
 *   nofit（沒有工具能做→說做不到）／missing（要求的工具不在清單→說不存在、指出最接近的、不連環搜尋）。
 * 格式：row.tools＝Qwen3 chat template 的 tools=（Hermes <tool_call>），completion＝<tool_call>\n{"name","arguments"}\n</tool_call>。
 * 每題 2~8 個工具（含同家族干擾、打亂）；留出工具（heldout=true）絕不出現在 train 題的工具清單，只當 split:"heldout" 的目標。
 * 未覆蓋：必填參數含 array/object 的工具（寫進 data/coverage_when2call.json）。
 * 限制（誠實）：值由程式從 schema 型別／欄位名稱的小詞庫合成，使用者語句偏制式；rejected 為「錯誤行為」的程式範本，供 DPO。
 */
const fs = require('fs');
const path = require('path');
const C = require('./w2c_common.js');

const GREET = ['你好', '早安', '謝謝你', 'hi', '你是誰？', '今天心情不錯', 'thanks!', '辛苦了', '晚安', 'hello'];
const REPLY = ['你好！有什麼我可以幫你的嗎？', '早安！需要我幫忙處理什麼嗎？', '不客氣！還有其他需要的話再告訴我。', 'Hi! How can I help you today?', '我是你的離線小助理，需要時可以請我幫忙。', '聽起來不錯！需要我做什麼就說一聲。', "You're welcome! Let me know if you need anything else.", '不會，這是我該做的。還有什麼要處理嗎？', '晚安，好好休息！', 'Hello! What can I do for you?'];
const NOFIT = ['幫我把房間的燈關掉', '幫我訂一張明天去高雄的高鐵票', '幫我煮一杯咖啡', '請把冷氣調到 24 度', '幫我叫一台計程車', '幫我寄一份實體信件給客戶', '幫我預約明天的牙醫', '幫我把洗衣機打開', '幫我點一份便當外送', '請幫我澆花'];
const FAKE_SUFFIX = ['fill_form', 'apply_theme', 'auto_fix', 'export_all', 'batch_run', 'smart_merge', 'sync_cloud'];

async function generate() {
    const rows = []; const uncovered = []; const covered = []; const count = {};
    const add = (r) => { C.tag(r, 'rtool', r.meta.behavior); rows.push(r); const k = r.meta.group + '/' + r.meta.behavior; count[k] = (count[k] || 0) + 1; };
    for (const t of C.TOOLS) {
        const cov = C.coverageOf(t);
        if (!cov.ok) { uncovered.push({ tool: t.name, why: cov.why, heldout: !!t.heldout }); continue; }
        covered.push(t.name);
        const split = t.heldout ? 'heldout' : 'train';
        const intent = C.firstClause(t.description).slice(0, 40);
        const group = C.groupOf(t);
        const req = C.requiredOf(t); const props = t.parameters.properties || {};
        const base = { domain: 'when2call', verified_by: 'program_ground_truth', split, source_file: C.SRC };
        // call ×2
        for (let v = 0; v < 2; v++) {
            const rand = C.rng('w2c:call:' + t.name + ':' + v);
            const args = C.synthArgs(t, rand);
            const pairs = req.map((k) => C.phrase(k, args[k]));
            const text = v === 0 ? '請幫我' + intent + (pairs.length ? '。' + pairs.join('，') : '') : intent + (pairs.length ? '，' + req.map((k) => k + '=' + args[k]).join('，') : '');
            const list = C.toolList(t, rand, 3, 7);
            add(Object.assign({ id: 'when2call:call:' + t.name + ':' + v, stage: 'w2c_call', messages: [C.sysMsg(), { role: 'user', content: text }], tools: list.map(C.toolSpec), completion: C.toolCall(t.name, args), rejected: C.toolCall(C.pick(rand, list.filter((x) => x.name !== t.name)).name, args), meta: { behavior: 'call', tool: t.name, group, check: { kind: 'call', name: t.name, args } } }, base));
        }
        // ask ×1（有必填參數才有意義）
        if (req.length) {
            const rand = C.rng('w2c:ask:' + t.name);
            const list = C.toolList(t, rand, 3, 7);
            const guessed = C.synthArgs(t, rand);
            add(Object.assign({ id: 'when2call:ask:' + t.name, stage: 'w2c_ask', messages: [C.sysMsg(), { role: 'user', content: '請幫我' + intent + '。' }], tools: list.map(C.toolSpec), completion: '要完成這件事，我還需要知道：' + req.join('、') + '。請告訴我' + req.map((k) => '「' + k + '」要填什麼').join('、') + '？', rejected: C.toolCall(t.name, guessed), meta: { behavior: 'ask', tool: t.name, group, check: { kind: 'no_call' } } }, base));
        }
        // missing ×1
        {
            const rand = C.rng('w2c:missing:' + t.name);
            let fake; let n = 0; do { fake = C.family(t.name) + '_' + C.pick(rand, FAKE_SUFFIX) + (n++ ? '_' + n : ''); } while (C.BY_NAME[fake]);
            const list = C.toolList(t, rand, 3, 7);
            add(Object.assign({ id: 'when2call:missing:' + t.name, stage: 'w2c_missing', messages: [C.sysMsg(), { role: 'user', content: '請用 ' + fake + ' 幫我' + intent + '。' }], tools: list.map(C.toolSpec), completion: '工具清單裡沒有「' + fake + '」這個工具。最接近的是「' + t.name + '」（' + intent + '），要改用它嗎？', rejected: C.toolCall('get_tool_details', { name: fake }), meta: { behavior: 'missing', tool: t.name, group, check: { kind: 'no_call_mention', mention: t.name } } }, base));
        }
    }
    // direct / nofit：只用訓練池（不含留出工具）
    for (let i = 0; i < 130; i++) {
        const rand = C.rng('w2c:direct:' + i); const gi = Math.floor(rand() * GREET.length); const target = C.pick(rand, C.TRAIN_POOL);
        add({ id: 'when2call:direct:' + i, domain: 'when2call', stage: 'w2c_direct', messages: [C.sysMsg(), { role: 'user', content: GREET[gi] }], tools: C.toolList(target, rand, 2, 8).map(C.toolSpec), completion: REPLY[gi], rejected: C.toolCall(target.name, C.synthArgs(target, rand)), verified_by: 'program_ground_truth', split: 'train', source_file: C.SRC, meta: { behavior: 'direct', group: 'chat', check: { kind: 'no_call' } } });
    }
    for (let i = 0; i < 130; i++) {
        const rand = C.rng('w2c:nofit:' + i); const q = NOFIT[i % NOFIT.length]; const target = C.pick(rand, C.TRAIN_POOL);
        add({ id: 'when2call:nofit:' + i, domain: 'when2call', stage: 'w2c_nofit', messages: [C.sysMsg(), { role: 'user', content: q }], tools: C.toolList(target, rand, 2, 8).map(C.toolSpec), completion: '目前提供的工具沒辦法做到「' + q + '」，我無法替你完成這件事。', rejected: C.toolCall(target.name, C.synthArgs(target, rand)), verified_by: 'program_ground_truth', split: 'train', source_file: C.SRC, meta: { behavior: 'nofit', group: 'offtopic', check: { kind: 'no_call' } } });
    }
    fs.writeFileSync(path.join(__dirname, '..', 'data', 'coverage_when2call.json'), JSON.stringify({ tools_total: C.TOOLS.length, covered: covered.length, uncovered_count: uncovered.length, uncovered, rows: rows.length, per_group_behavior: count }, null, 1));
    const tr = rows.filter((r) => r.split === 'train').length;
    console.error('[gen_when2call] 工具 ' + C.TOOLS.length + '，覆蓋 ' + covered.length + '，未覆蓋 ' + uncovered.length + '（必填含 array/object 等，見 data/coverage_when2call.json）；產生 ' + rows.length + ' 筆（train ' + tr + '／heldout ' + (rows.length - tr) + '）；值由程式合成、語句偏制式');
    return rows;
}
module.exports = { generate };
if (require.main === module) (async () => { for (const r of await generate()) process.stdout.write(JSON.stringify(r) + '\n'); })();
