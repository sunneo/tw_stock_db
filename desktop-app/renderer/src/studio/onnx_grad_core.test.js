'use strict';
// ONNX 反向圖產生器：圖版本的小 transformer（前向＋自動產生的反向＋Adam）對純 JS 手寫參考（lora_ref_train.js）逐項對拍。
const fs = require('fs'), path = require('path');
const Ref = require('./lora_ref_train.js'), Gm = require('./onnx_grad_core.js'), M = require('./lora_graph_model.js');
let fail = 0; const ok = (c, n, e) => { if (!c) fail++; console.log((c ? 'ok   ' : 'FAIL ') + n + (e ? '  ' + e : '')); };
const cfg = { V: 32, d: 64, L: 2, H: 4, F: 128, r: 8, alpha: 16 };
const rng = Ref.makeRng(11); const toks = Array.from({ length: 17 }, () => Math.floor(rng() * cfg.V));
const relL2 = (a, b) => { let n = 0, d = 0; for (let i = 0; i < a.length; i++) { n += (a[i] - b[i]) ** 2; d += b[i] ** 2; } return Math.sqrt(n / (d || 1)); };

function cloneEff(m, eff) { const c = Object.assign({}, m, { layers: m.layers.map((x) => Object.assign({}, x)) }); for (const [name, e] of eff) { const mm = /^l(\d+)\.(W[a-z])$/.exec(name); c.layers[+mm[1]][mm[2]] = e; } return c; }
function lorafeeds(m, f) { m.lora.forEach((lo, l) => { for (const k of ['q', 'k', 'v', 'o']) { f['l' + l + '.' + k + '.A'] = lo[k].A; f['l' + l + '.' + k + '.B'] = lo[k].B; } }); return f; }

for (const quant of [false, true]) {
    const m = Ref.makeModel(cfg, 7); const built = M.build(m, toks, { quant });
    const ref = quant ? cloneEff(m, built.eff) : m; const R = Ref.lossAndGrads(ref, toks);
    const gr = Gm.grad(built.g, built.loss, built.params.map((p) => p.name));
    const outs = built.params.map((p) => gr.get(p.name)); outs.forEach((t) => built.g.output(t));
    const vals = Gm.run(built.g, lorafeeds(m, Object.assign({}, built.feeds)));
    const lossG = vals.get(built.loss.name).data[0];
    let worst = 0; const na = []; built.params.forEach((p) => { const mt = /^l(\d+)\.(\w)\.(A|B)$/.exec(p.name); const a = vals.get(gr.get(p.name).name).data, b = R.grads[+mt[1]][mt[2]][mt[3]]; const e = relL2(a, b); worst = Math.max(worst, e); });
    const tag = quant ? '（基底權重 int8＋DequantizeLinear，直通估計）' : '（基底 fp 權重）';
    ok(Math.abs(lossG - R.loss) < 1e-9, 'loss 與參考一致' + tag, 'Δ=' + Math.abs(lossG - R.loss).toExponential(2));
    ok(worst < 1e-9, '全部 ' + built.params.length + ' 個 LoRA 張量梯度對參考的相對 L2 誤差' + tag, '最大=' + worst.toExponential(2));
    if (!quant) {
        // Adam 一步（圖內）對參考 adamStep
        const m2 = Ref.makeModel(cfg, 7); const b2 = M.build(m2, toks, {}); const g2 = Gm.grad(b2.g, b2.loss, b2.params.map((p) => p.name));
        const st = Gm.adam(b2.g, b2.params, g2, {}); const lr = 0.02;
        const feeds = lorafeeds(m2, Object.assign({}, b2.feeds)); feeds.adam_alpha = [lr / (1 - 0.9)]; feeds.adam_c2 = [1 / (1 - 0.999)];
        for (const p of b2.params) { feeds[p.name + '.m'] = new Float64Array(Gm.prod(p.shape)); feeds[p.name + '.v'] = new Float64Array(Gm.prod(p.shape)); }
        const v2 = Gm.run(b2.g, feeds);
        const mr = Ref.makeModel(cfg, 7); const rr = Ref.lossAndGrads(mr, toks); Ref.adamStep(mr, rr.grads, Ref.adamInit(mr), lr);
        let w = 0; for (const s of st) { const mt = /^l(\d+)\.(\w)\.(A|B)$/.exec(s.param); w = Math.max(w, relL2(v2.get(s.p).data, mr.lora[+mt[1]][mt[2]][mt[3]])); }
        ok(w < 1e-9, '圖內 Adam 一步後的參數對參考 adamStep', '最大相對誤差=' + w.toExponential(2));
        // ONNX 序列化：位元組開頭、可再解析節點數
        const bytes = Gm.toOnnx(b2.g); ok(bytes.length > 1000 && bytes[0] === 0x08 && bytes[1] === 8, 'ONNX 序列化產出位元組（opset 17）', bytes.length + ' bytes、節點 ' + b2.g.nodes.length + '（前向＋反向＋Adam）');
        const ops = {}; b2.g.nodes.forEach((n) => { ops[n.op] = (ops[n.op] || 0) + 1; }); console.log('     用到的運算子：' + JSON.stringify(ops));
        if (process.env.FA_GRAD_DUMP) { fs.writeFileSync(path.join(process.env.FA_GRAD_DUMP, 'tiny_train.onnx'), bytes); fs.writeFileSync(path.join(process.env.FA_GRAD_DUMP, 'tiny_feeds.json'), JSON.stringify({ feeds: Object.fromEntries(Object.entries(feeds).map(([k, v]) => [k, Array.from(v)])), shapes: Object.fromEntries(b2.g.inputs.map((t) => [t.name, { shape: t.shape, dtype: t.dtype }])), expect: Object.fromEntries(st.flatMap((s) => [[s.p, Array.from(v2.get(s.p).data)]]).concat([['loss', Array.from(v2.get(b2.loss.name).data)]])) })); }
    }
}
// 沒有規則的情況要丟明確錯誤
{ const g = new Gm.G(); const x = g.input('x', [2, 2], 'f32', true); const s = g.node('Erf', [x], [2, 2]); let msg = ''; try { Gm.grad(g, g.reduceMean(s, [0, 1], false), ['x']); } catch (e) { msg = e.message; } ok(/沒有反向規則/.test(msg), '未列規則的運算子丟明確錯誤', msg); }
console.log(fail ? fail + ' 項失敗' : '全部通過'); process.exit(fail ? 1 : 0);
