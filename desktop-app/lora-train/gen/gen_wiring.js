'use strict';
/* toolwire 領域（對應對照設計 toolwire/wiring）：選「哪一條管線能完成這個請求」的 A/B/C 三選一，回覆 {"choice":"B"}（prefill 空）。
 * 格式照對照設計 toolwire_data.py：system＝WIRING_PROMPT，user＝"Request: <文字>\nA. <管線>\nB. ...\nC. ..."。
 * 管線＝我們真實工具的呼叫字串 name(k: v, ...)。正確管線來自 gen_natural.js 的手寫請求＋參數（人手標好），以及 w2c_common 程式合成的請求＋參數；
 * 錯誤選項（程式組）：同家族另一個工具、同工具少一個必填參數、同工具參數值被換掉。選項位置打亂，每題 2 種排列。
 * 留出：工具 heldout=true 或 gen_natural 的奇數索引說法 → split:"heldout"。
 * 限制：錯誤選項是程式規則組的，偏容易分辨；請求語句偏制式。 */
const C = require('./w2c_common.js');
const NAT = require('./gen_natural.js');

const WIRING_PROMPT = 'You wire tools. Pick the ONE pipeline that does the request. Reply with only JSON like {"choice":"A"}.';
const pipe = (name, args) => name + '(' + Object.keys(args).map((k) => k + ': ' + args[k]).join(', ') + ')';
const LET = 'ABC';

function wrongs(t, args, rand) {
    const out = []; const keys = Object.keys(args);
    const fam = C.TRAIN_POOL.filter((x) => x.name !== t.name && C.family(x.name) === C.family(t.name));
    const other = fam.length ? C.pick(rand, fam) : C.pick(rand, C.TRAIN_POOL.filter((x) => x.name !== t.name));
    const oreq = C.requiredOf(other); const oa = {}; for (const k of oreq) oa[k] = (k in args) ? args[k] : C.synthValue(k, other.parameters.properties[k], rand);
    out.push(pipe(other.name, oa));
    const req = C.requiredOf(t).filter((k) => k in args);
    if (req.length) { const a2 = Object.assign({}, args); delete a2[req[0]]; out.push(pipe(t.name, a2)); }
    if (keys.length) { const a3 = Object.assign({}, args); const k = keys[0]; a3[k] = typeof a3[k] === 'number' ? a3[k] + 7 : typeof a3[k] === 'string' ? a3[k] + '_x' : a3[k]; if (JSON.stringify(a3) !== JSON.stringify(args)) out.push(pipe(t.name, a3)); }
    const o2 = C.pick(rand, C.TRAIN_POOL.filter((x) => x.name !== t.name && x.name !== other.name)); const oa2 = {}; for (const k of C.requiredOf(o2)) oa2[k] = C.synthValue(k, o2.parameters.properties[k], rand); out.push(pipe(o2.name, oa2));
    return out;
}

async function generate() {
    const items = [];
    for (const [name, list] of NAT.N) { const t = C.BY_NAME[name]; if (!t) continue; list.forEach(([text, args], idx) => items.push({ t, text, args, split: t.heldout || idx % 2 ? 'heldout' : 'train', src: 'natural' })); }
    for (const t of C.TOOLS) {
        const cov = C.coverageOf(t); if (!cov.ok || !C.requiredOf(t).length) continue;
        const rand = C.rng('wire:' + t.name); const args = C.synthArgs(t, rand); const intent = C.firstClause(t.description).slice(0, 40);
        items.push({ t, text: '請幫我' + intent + '。' + C.requiredOf(t).map((k) => C.phrase(k, args[k])).join('，'), args, split: t.heldout ? 'heldout' : 'train', src: 'synth' });
    }
    const rows = []; let seq = 0;
    for (const it of items) {
        for (let s = 0; s < 2; s++) {
            const rand = C.rng('wire:' + it.t.name + ':' + it.text + ':' + s);
            const ok = pipe(it.t.name, it.args); const w = C.shuffle(rand, wrongs(it.t, it.args, rand).filter((x) => x !== ok)).slice(0, 2); if (w.length < 2) continue;
            const opts = C.shuffle(rand, [ok, w[0], w[1]]); const ans = LET[opts.indexOf(ok)];
            const text = 'Request: ' + it.text + '\n' + opts.map((o, i) => LET[i] + '. ' + o).join('\n');
            const rejL = C.pick(rand, LET.split('').filter((c) => c !== ans));
            seq++;
            rows.push({ id: 'wiring:' + seq, domain: 'toolwire', stage: 'wiring', task: 'toolwire', kind: 'wiring', messages: [{ role: 'system', content: WIRING_PROMPT }, { role: 'user', content: text }], prefill: '', completion: '{"choice":"' + ans + '"}', rejected: '{"choice":"' + rejL + '"}', verified_by: 'program_ground_truth', split: it.split, source_file: it.src === 'natural' ? 'lora-train/gen/gen_natural.js' : C.SRC, group: 'toolwire/wiring', seen: it.t.heldout ? 'unseen' : 'seen', tool: it.t.name, meta: { group: 'toolwire/wiring', tool: it.t.name, source: it.src, answer: ans, family: C.groupOf(it.t) } });
        }
    }
    const tr = rows.filter((r) => r.split === 'train').length;
    const pos = {}; rows.forEach((r) => { pos[r.meta.answer] = (pos[r.meta.answer] || 0) + 1; });
    console.error('[gen_wiring] 請求 ' + items.length + '，產生 ' + rows.length + ' 筆（train ' + tr + '／heldout ' + (rows.length - tr) + '），答案字母分布 ' + JSON.stringify(pos) + '；錯誤選項由程式規則組，偏易');
    return rows;
}
module.exports = { generate };
if (require.main === module) (async () => { for (const r of await generate()) process.stdout.write(JSON.stringify(r) + '\n'); })();
