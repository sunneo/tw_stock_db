'use strict';
/* tool_routing 全工具版：由 extract_tools.js 抽出的 322 個真實註冊工具（data/real_tools_all.json）程式合成選單題。
 * 每個工具至少一題：選單＝目標工具＋3 個干擾工具（隨機、位置打亂），menu 用 recipe_core.js 真正的 menuMessages()，
 * 答案編號由我們放置的位置決定（by construction），並用真正的 chooseTool() 解析驗證格式。
 * 使用者的話＝該工具描述的第二句（沒有就第一句，上限 120 字，盡量避免與選單文字逐字相同）；選單上的 intent＝第一個子句（上限 40 字）。
 * 限制（誠實）：問句由工具自己的描述派生，語句偏制式、與選單文字高度重疊，會偏易；不等於真實使用者說法。
 * 留出：heldout=true 的工具（md5('rt:'+name)%5==0）只當 split:"heldout" 的目標，且絕不出現在任何 train 題的選單裡。
 */
const path = require('path');
const crypto = require('crypto');
const R = require(path.join(__dirname, '..', '..', 'renderer', 'src', 'recipe', 'recipe_core.js'));
const SRC = 'lora-train/data/real_tools_all.json';

function rng(seed) { let h = crypto.createHash('md5').update(seed).digest(); let i = 0; return () => { if (i > 12) { h = crypto.createHash('md5').update(h).digest(); i = 0; } const v = h.readUInt32LE(i) / 4294967296; i += 4; return v; }; }
const firstSentence = (d) => String(d || '').replace(/\s+/g, ' ').split(/[。！？\n]/)[0].trim();
const firstClause = (d) => firstSentence(d).split(/[，、；:：（(]/)[0].trim();

async function generate() {
    const data = require(path.join(__dirname, '..', '..', SRC.replace('lora-train/', 'lora-train/')));
    const tools = (data.tools || data).filter((t) => t.name && t.description);
    const trainPool = tools.filter((t) => !t.heldout);
    const rows = []; let skipped = 0;
    for (const t of tools) {
        const sents = String(t.description).replace(/\s+/g, ' ').split(/[。！？\n]/).map((x) => x.trim()).filter((x) => x.length >= 6); const q = (sents[1] || sents[0] || '').slice(0, 120); const intent = firstClause(t.description).slice(0, 40);
        if (q.length < 6 || intent.length < 3) { skipped++; continue; }
        const rand = rng('route:' + t.name);
        const distract = [];
        while (distract.length < 3) { const d = trainPool[Math.floor(rand() * trainPool.length)]; if (d.name !== t.name && !distract.includes(d) && firstClause(d.description).length >= 3) distract.push(d); }
        const cands = distract.map((d) => ({ tool: d.name, intent: firstClause(d.description).slice(0, 40) }));
        const pos = Math.floor(rand() * 4); cands.splice(pos, 0, { tool: t.name, intent });
        const completion = '{"choice": ' + (pos + 1) + '}';
        const r = await R.chooseTool({ cands, question: q, generate: async () => completion });
        if (!r.ok || r.none || cands[r.index].tool !== t.name) { skipped++; continue; }
        rows.push({ id: 'tool_routing_full:' + t.name, domain: 'tool_routing', stage: 'choose_tool_full', messages: R.menuMessages(q, cands), prefill: '{"choice":', completion: ' ' + (pos + 1) + '}', verified_by: 'program_ground_truth', split: t.heldout ? 'heldout' : 'train', source_file: SRC, meta: { tool: t.name, pos: pos + 1, distractors: distract.map((d) => d.name), synthetic_question: true } });
    }
    console.error('[gen_tool_routing_full] 工具 ' + tools.length + '，產生 ' + rows.length + ' 筆（train ' + rows.filter((r) => r.split === 'train').length + '／heldout ' + rows.filter((r) => r.split === 'heldout').length + '），跳過 ' + skipped + '；問句由工具描述派生，偏易、語句制式');
    return rows;
}
module.exports = { generate };
if (require.main === module) (async () => { for (const r of await generate()) process.stdout.write(JSON.stringify(r) + '\n'); })();
