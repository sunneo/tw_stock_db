// 累積評測：使用者確認過一次的說法，之後「換個動詞再說一次」是否直接命中（程式端，不靠小模型）；以及學了一組之後對另一組沒學過的句子有沒有被帶偏。
const fs = require('fs'), path = require('path');
const G = require('../../renderer/src/offline/intent_gate.js');
const D = require('./offline-open-derive.data.js');
const src = fs.readFileSync(path.join(__dirname, '..', '..', 'renderer/src/floating-assistant.js'), 'utf8');
const scan = G.scanTools(src);
function pick(t, memory) { const g = G.gate(t); if (g.kind) return g.kind; const p = G.pickDerived(G.deriveTool(t, scan.tools, { memory })); return p ? p.kind : null; }
const swap = (t) => '幫我打開' + t.replace(/^(叫出|調出|秀出|開個|開一下|顯示出)/, '');
function run() {
    const mem = {}; D.heldout.forEach(([t, k]) => { mem['s:' + G.memKey(t)] = 'kind:' + k; });
    let before = 0, after = 0; D.heldout.forEach(([t, k]) => { if (pick(swap(t), {}) === k) before++; if (pick(swap(t), mem) === k) after++; });
    let b2 = 0, a2 = 0; D.heldout2.forEach(([t, k]) => { if (pick(t, {}) === k) b2++; if (pick(t, mem) === k) a2++; });
    return { n1: D.heldout.length, before, after, n2: D.heldout2.length, b2, a2 };
}
if (require.main === module) { const r = run(); console.log('換動詞再說一次（heldout ' + r.n1 + ' 句）：沒記憶 ' + r.before + '，確認過一次後 ' + r.after + '；學了 heldout 之後對沒學過的 heldout2（' + r.n2 + ' 句）：' + r.b2 + ' → ' + r.a2); }
module.exports = { run };
