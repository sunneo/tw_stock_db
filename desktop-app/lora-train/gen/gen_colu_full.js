'use strict';
/* colu 全工具版：對每個真實工具，用 offline_stack_core.js 真正的 routeColu／makeRouteColu({noneFirst}) 組 CoLU 字母選單題
 * （4 個候選：目標＋同家族干擾＋隨機干擾，選單與思考堆疊標頭都由 production 函式產生），並以「讀選單找正確那一行」的 oracle
 * 跑完整流程，只收被真正的 parseLetter 驗證通過的回覆。另外加不屬於任何工具的「都不是」題。
 * 留出：heldout 工具只當 split:"heldout"（colu/ext＝工具名稱訓練時完全沒見過），且不出現在 train 題的候選裡。
 * 限制：問句取工具描述第二句（沒有就第一句），語句偏制式。 */
const path = require('path');
const C = require('./w2c_common.js');
const O = require(path.join(__dirname, '..', '..', 'renderer', 'src', 'recipe', 'offline_stack_core.js'));
const T = require(path.join(__dirname, '..', '..', 'renderer', 'src', 'recipe', 'think_stack.js'));

const NONE_Q = ['你好', '謝謝', '今天天氣不錯', '你是誰', '幫我煮咖啡', '講個笑話', '晚安', '你覺得人生有意義嗎', '午餐吃什麼好', '幫我把燈關掉'];
function findLetter(messages, matcher) {
    for (const raw of messages.map((m) => String(m.content || '')).join('\n').split('\n')) { const m = /^([A-J])\.\s*(.*)$/.exec(raw.trim()); if (m && matcher(m[2])) return m[1]; }
    return null;
}
const question = (t) => { const s = String(t.description).replace(/\s+/g, ' ').split(/[。！？\n]/).map((x) => x.trim()).filter((x) => x.length >= 6); return (s[1] || s[0] || '').slice(0, 120); };

async function one(cands, q, want, cfgKey) {
    const stack = O.fromRounds('路由', [{ by: 'recipe', ok: false, reason: '沒有現成做法' }]); const cap = {};
    const matcher = want == null ? (x) => x.indexOf('都不是') >= 0 : (x) => x.indexOf('（工具 ' + want + '）') >= 0;
    const oracle = async (req) => { const l = findLetter(req.messages, matcher); if (!l) throw new Error('no line'); cap.messages = req.messages; cap.prefill = req.prefill || ''; cap.raw = cap.prefill + l; return cap.raw; };
    const router = cfgKey === 'nf' ? O.makeRouteColu({ noneFirst: true }) : O.routeColu;
    const r = await router({ cands, question: q, generate: oracle, stack, stackMod: T, label: '選工具' });
    const got = r.ok ? (r.none ? null : cands[r.index] && cands[r.index].tool) : undefined;
    return (!r.ok || got !== want) ? null : cap;
}

async function generate() {
    const rows = []; let skipped = 0;
    const add = (id, stage, cap, split, meta) => rows.push({ id, domain: 'colu', stage, messages: cap.messages, prefill: cap.prefill, completion: cap.raw.slice(cap.prefill.length), verified_by: 'program_ground_truth', split, source_file: C.SRC, meta });
    for (const t of C.TOOLS) {
        const q = question(t); const intent = C.firstClause(t.description).slice(0, 40); if (q.length < 6 || intent.length < 3) { skipped++; continue; }
        const split = t.heldout ? 'heldout' : 'train';
        for (const cfgKey of ['plain', 'nf']) {
            const rand = C.rng('colufull:' + t.name + ':' + cfgKey);
            const list = C.toolList(t, rand, 4, 4);
            const cands = list.map((x) => ({ tool: x.name, intent: C.firstClause(x.description).slice(0, 40), def: C.firstSentence(x.description).slice(0, 50) }));
            const cap = await one(cands, q, t.name, cfgKey);
            if (!cap) { skipped++; continue; }
            add('colu_full:' + t.name + ':' + cfgKey, cfgKey === 'nf' ? 'colu_letter_choice_nonefirst' : 'colu_letter_choice', cap, split, { tool: t.name, group: t.heldout ? 'colu/ext' : 'colu/choice', variant: cfgKey, cands: cands.map((c) => c.tool) });
        }
    }
    for (let i = 0; i < 60; i++) {
        const rand = C.rng('colufull:none:' + i); const target = C.pick(rand, C.TRAIN_POOL); const list = C.toolList(target, rand, 4, 4);
        const cands = list.map((x) => ({ tool: x.name, intent: C.firstClause(x.description).slice(0, 40), def: C.firstSentence(x.description).slice(0, 50) }));
        const cap = await one(cands, NONE_Q[i % NONE_Q.length], null, i % 2 ? 'nf' : 'plain');
        if (!cap) { skipped++; continue; }
        add('colu_full:none:' + i, i % 2 ? 'colu_letter_choice_nonefirst' : 'colu_letter_choice', cap, 'train', { tool: null, group: 'colu/none', cands: cands.map((c) => c.tool) });
    }
    const tr = rows.filter((r) => r.split === 'train').length;
    console.error('[gen_colu_full] 產生 ' + rows.length + ' 筆（train ' + tr + '／heldout ' + (rows.length - tr) + '），跳過 ' + skipped + '；問句由工具描述派生，偏制式');
    return rows;
}
module.exports = { generate };
if (require.main === module) (async () => { for (const r of await generate()) process.stdout.write(JSON.stringify(r) + '\n'); })();
