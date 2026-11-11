/* 網頁版訓練 LoRA：ONNX 反向圖產生器核心（DESIGN.TODO.offline-training-studio.md §5.6）。
 *  純函式核心（UMD）：Node／瀏覽器／Worker 皆可；不依賴 onnx、Python、onnxruntime 訓練版。
 *  做的事：
 *   1. 靜態形狀的圖建構器 G：每個運算子建立時就推導輸出形狀（訓練固定序列長度，所以形狀全已知）。
 *   2. grad(G, loss, wrt)：反向模式自動微分，沿圖反向走，依「反向規則表」RULES 產生新節點，輸出的仍是普通 ONNX 運算子，
 *      所以結果圖可以交給一般 onnxruntime-web（WASM／WebGPU）當推論圖執行。
 *   3. adam(G, ...)：把 Adam 優化步寫成圖內節點（p、m、v 都是輸入／輸出，圖本身無狀態）。
 *   4. toOnnx(G)：序列化成 ONNX ModelProto 位元組（opset 17）。
 *   5. run(G, feeds)：純 JS 直譯器（Float64），當規格與免 ORT 的測試執行器；與 ORT 的對拍見 scripts 的 ort 檢查。
 *  反向規則表 RULES 與運算子語意表只依賴「運算子名＋形狀」，之後的 WGSL 編譯器（§5.6 退路）可直接重用同一份規則。
 *  不支援的情況一律丟明確錯誤（絕不靜默產生錯的梯度）：需要對常數以外的 Gather 資料／未列規則的運算子求梯度。 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.FaOnnxGrad = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';
    const DT = { f32: 1, u8: 2, i8: 3, i32: 6, i64: 7 };
    const prod = (s) => s.reduce((a, b) => a * b, 1);
    function bshape(a, b) { const n = Math.max(a.length, b.length), o = []; for (let i = 0; i < n; i++) { const x = a[a.length - 1 - i] === undefined ? 1 : a[a.length - 1 - i], y = b[b.length - 1 - i] === undefined ? 1 : b[b.length - 1 - i]; if (x !== y && x !== 1 && y !== 1) throw new Error('形狀無法廣播：[' + a + '] 與 [' + b + ']'); o.unshift(Math.max(x, y)); } return o; }
    function strides(s) { const st = new Array(s.length); let p = 1; for (let i = s.length - 1; i >= 0; i--) { st[i] = p; p *= s[i]; } return st; }
    const normAxis = (a, r) => (a < 0 ? a + r : a);

    // ───────── 建構器 ─────────
    class G {
        constructor() { this.nodes = []; this.tensors = new Map(); this.inputs = []; this.outputs = []; this.n = 0; this.trainable = new Set(); }
        _t(name, shape, dtype) { if (this.tensors.has(name)) throw new Error('重複的張量名稱：' + name); const t = { name, shape: shape.slice(), dtype: dtype || 'f32' }; this.tensors.set(name, t); return t; }
        _name(p) { return (p || 't') + '_' + (this.n++); }
        input(name, shape, dtype, trainable) { const t = this._t(name, shape, dtype); this.inputs.push(t); if (trainable) this.trainable.add(name); return t; }
        // 常數：序列化成 initializer
        const(name, shape, data, dtype) { const t = this._t(name || this._name('c'), shape, dtype); t.data = data; t.isConst = true; return t; }
        scalar(v, name) { return this.const(name, [], Float64Array.of(v)); }
        output(t) { this.outputs.push(t); return t; }
        node(op, ins, shape, attrs, dtype) { const o = this._t(this._name(op.toLowerCase()), shape, dtype); this.nodes.push({ op, inputs: ins.map((x) => x.name), outputs: [o.name], attrs: attrs || {} }); return o; }
        bin(op, a, b) { return this.node(op, [a, b], bshape(a.shape, b.shape), null, a.dtype); }
        add(a, b) { return this.bin('Add', a, b); } sub(a, b) { return this.bin('Sub', a, b); } mul(a, b) { return this.bin('Mul', a, b); } div(a, b) { return this.bin('Div', a, b); }
        un(op, a) { return this.node(op, [a], a.shape, null, a.dtype); }
        neg(a) { return this.un('Neg', a); } sqrt(a) { return this.un('Sqrt', a); } recip(a) { return this.un('Reciprocal', a); } log(a) { return this.un('Log', a); } sigmoid(a) { return this.un('Sigmoid', a); }
        softmax(a, axis) { return this.node('Softmax', [a], a.shape, { axis: normAxis(axis === undefined ? -1 : axis, a.shape.length) }); }
        matmul(a, b) {
            if (a.shape.length < 2 || b.shape.length < 2) throw new Error('MatMul 只支援 2 維以上');
            const m = a.shape[a.shape.length - 2], k = a.shape[a.shape.length - 1], k2 = b.shape[b.shape.length - 2], n = b.shape[b.shape.length - 1];
            if (k !== k2) throw new Error('MatMul 內維不合：[' + a.shape + '] x [' + b.shape + ']');
            return this.node('MatMul', [a, b], bshape(a.shape.slice(0, -2), b.shape.slice(0, -2)).concat([m, n]));
        }
        transpose(a, perm) { return this.node('Transpose', [a], perm.map((p) => a.shape[p]), { perm }, a.dtype); }
        reshape(a, shape) { if (prod(shape) !== prod(a.shape)) throw new Error('Reshape 元素數不合'); const s = this.const(this._name('shp'), [shape.length], Float64Array.from(shape), 'i64'); return this.node('Reshape', [a, s], shape, null, a.dtype); }
        _axes(a, axes) { return axes.map((x) => normAxis(x, a.shape.length)); }
        reduce(op, a, axes, keep) {
            axes = this._axes(a, axes); const os = a.shape.map((d, i) => (axes.includes(i) ? (keep ? 1 : null) : d)).filter((d) => d !== null);
            if (op === 'ReduceSum') { const ax = this.const(this._name('axes'), [axes.length], Float64Array.from(axes), 'i64'); return this.node(op, [a, ax], os, { keepdims: keep ? 1 : 0 }); }
            return this.node(op, [a], os, { axes, keepdims: keep ? 1 : 0 });
        }
        reduceSum(a, axes, keep) { return this.reduce('ReduceSum', a, axes, keep); } reduceMean(a, axes, keep) { return this.reduce('ReduceMean', a, axes, keep); }
        expand(a, shape) { const s = this.const(this._name('shp'), [shape.length], Float64Array.from(shape), 'i64'); return this.node('Expand', [a, s], bshape(a.shape, shape)); }
        gather(d, idx) { return this.node('Gather', [d, idx], idx.shape.concat(d.shape.slice(1)), { axis: 0 }, d.dtype); }
        dequant(q, scale, zp, axis) { return this.node('DequantizeLinear', zp ? [q, scale, zp] : [q, scale], q.shape, axis === undefined ? {} : { axis }); }
    }

    // ───────── 反向規則表 ─────────
    // 規則簽名：(g, node, T, grads需求旗標) → 回傳與 node.inputs 對齊的梯度張量陣列（不需要的給 null）
    function unb(g, t, shape) {
        const gs = t.shape; if (gs.length === shape.length && gs.every((d, i) => d === shape[i])) return t;
        const lead = t.shape.length - shape.length, axes = [];
        for (let i = 0; i < t.shape.length; i++) if (i < lead || (shape[i - lead] === 1 && t.shape[i] !== 1)) axes.push(i);
        let r = t; if (axes.length) r = g.reduceSum(t, axes, true);
        return g.reshape(r, shape);
    }
    // 反向要再用到凍結權重的反量化／轉置結果時，重新產生一份（不沿用前向那份），讓前向的大張量能在用完後釋放（28 層的 fp32 權重不必同時存在）
    function fresh(g, t) {
        const p = g.nodes.find((n) => n.outputs[0] === t.name);
        if (!p || (p.op !== 'DequantizeLinear' && p.op !== 'Transpose')) return t;
        const ins = p.inputs.map((x) => g.tensors.get(x)); if (!ins.every((x) => x.isConst || g.nodes.some((n) => n.outputs[0] === x.name && (n.op === 'Transpose' || n.op === 'DequantizeLinear')))) return t;
        const ni = ins.map((x) => (x.isConst ? x : fresh(g, x)));
        return g.node(p.op, ni, t.shape, Object.assign({}, p.attrs), t.dtype);
    }
    const lastTwoPerm = (r) => { const p = [...Array(r).keys()]; p[r - 1] = r - 2; p[r - 2] = r - 1; return p; };
    const RULES = {
        Add: (g, dy, n, I, O, need) => [need[0] ? unb(g, dy, I[0].shape) : null, need[1] ? unb(g, dy, I[1].shape) : null],
        Sub: (g, dy, n, I, O, need) => [need[0] ? unb(g, dy, I[0].shape) : null, need[1] ? unb(g, g.neg(dy), I[1].shape) : null],
        Mul: (g, dy, n, I, O, need) => [need[0] ? unb(g, g.mul(dy, I[1]), I[0].shape) : null, need[1] ? unb(g, g.mul(dy, I[0]), I[1].shape) : null],
        Div: (g, dy, n, I, O, need) => [need[0] ? unb(g, g.div(dy, I[1]), I[0].shape) : null, need[1] ? unb(g, g.neg(g.div(g.mul(dy, I[0]), g.mul(I[1], I[1]))), I[1].shape) : null],
        Neg: (g, dy) => [g.neg(dy)],
        Sqrt: (g, dy, n, I, O) => [g.div(dy, g.mul(O[0], g.scalar(2)))],
        Reciprocal: (g, dy, n, I, O) => [g.neg(g.mul(dy, g.mul(O[0], O[0])))],
        Log: (g, dy, n, I) => [g.div(dy, I[0])],
        Sigmoid: (g, dy, n, I, O) => [g.mul(dy, g.mul(O[0], g.sub(g.scalar(1), O[0])))],
        Softmax: (g, dy, n, I, O) => { const ax = n.attrs.axis; const s = g.reduceSum(g.mul(dy, O[0]), [ax], true); return [g.mul(O[0], g.sub(dy, s))]; },
        MatMul: (g, dy, n, I, O, need) => {
            const a = I[0], b = I[1], ra = a.shape.length, rb = b.shape.length;
            return [need[0] ? unb(g, g.matmul(dy, g.transpose(fresh(g, b), lastTwoPerm(rb))), a.shape) : null, need[1] ? unb(g, g.matmul(g.transpose(a, lastTwoPerm(ra)), dy), b.shape) : null];
        },
        Transpose: (g, dy, n) => { const p = n.attrs.perm, inv = new Array(p.length); p.forEach((v, i) => { inv[v] = i; }); return [g.transpose(dy, inv)]; },
        Reshape: (g, dy, n, I) => [g.reshape(dy, I[0].shape), null],
        ReduceSum: (g, dy, n, I) => [g.expand(n.attrs.keepdims ? dy : g.reshape(dy, keepShape(I[0].shape, n._axes)), I[0].shape), null],
        ReduceMean: (g, dy, n, I) => { const ax = n.attrs.axes; const cnt = ax.reduce((a, i) => a * I[0].shape[i], 1); const k = n.attrs.keepdims ? dy : g.reshape(dy, keepShape(I[0].shape, ax)); return [g.expand(g.mul(k, g.scalar(1 / cnt)), I[0].shape)]; },
        Expand: (g, dy, n, I) => [unb(g, dy, I[0].shape), null],
        Gather: (g, dy, n, I, O, need) => { if (need[0]) throw new Error('Gather 對資料求梯度尚未實作（嵌入表是凍結常數時不需要）'); return [null, null]; },
        DequantizeLinear: (g, dy, n, I, O, need) => { if (need.some(Boolean)) throw new Error('DequantizeLinear 的輸入必須是凍結常數（直通估計的做法是：權重凍結，只對激活求梯度）'); return []; },
    };
    function keepShape(shape, axes) { return shape.map((d, i) => (axes.includes(i) ? 1 : d)); }

    // 反向：回傳 Map<paramName, gradTensor>
    function grad(g, loss, wrtNames) {
        const need = new Set(wrtNames);                       // 需要梯度的張量（沿前向傳播）
        const fwd = g.nodes.slice();
        for (const n of fwd) if (n.inputs.some((x) => need.has(x))) for (const o of n.outputs) need.add(o);
        const grads = new Map(); grads.set(loss.name, g.scalar(1));
        const add = (name, t) => { if (grads.has(name)) grads.set(name, g.add(grads.get(name), t)); else grads.set(name, t); };
        for (let i = fwd.length - 1; i >= 0; i--) {
            const n = fwd[i]; const dy = grads.get(n.outputs[0]); if (!dy || !n.outputs.some((o) => need.has(o))) continue;
            const rule = RULES[n.op]; if (!rule) throw new Error('沒有反向規則的運算子：' + n.op);
            if (n.op === 'ReduceSum') n._axes = g.tensors.get(n.inputs[1]).data ? Array.from(g.tensors.get(n.inputs[1]).data) : [];
            const I = n.inputs.map((x) => g.tensors.get(x)), O = n.outputs.map((x) => g.tensors.get(x));
            const nd = n.inputs.map((x) => need.has(x));
            const res = rule(g, dy, n, I, O, nd);
            n.inputs.forEach((x, k) => { if (nd[k] && res[k]) add(x, res[k]); });
        }
        const out = new Map(); for (const w of wrtNames) { if (!grads.has(w)) throw new Error('參數沒有梯度路徑：' + w); out.set(w, grads.get(w)); } return out;
    }

    // Adam：alpha = lr/(1-b1^t) 與 c2 = 1/(1-b2^t) 由呼叫端每步當純量輸入餵入
    function adam(g, params, grads, opt) {
        opt = opt || {}; const b1 = opt.b1 || 0.9, b2 = opt.b2 || 0.999, eps = opt.eps || 1e-8;
        const alpha = g.input('adam_alpha', []), c2 = g.input('adam_c2', []);
        const cb1 = g.scalar(b1), cb1c = g.scalar(1 - b1), cb2 = g.scalar(b2), cb2c = g.scalar(1 - b2), ce = g.scalar(eps);
        const state = [];
        for (const p of params) {
            const gr = grads.get(p.name); const m = g.input(p.name + '.m', p.shape), v = g.input(p.name + '.v', p.shape);
            const m2 = g.add(g.mul(m, cb1), g.mul(gr, cb1c)), v2 = g.add(g.mul(v, cb2), g.mul(g.mul(gr, gr), cb2c));
            const p2 = g.sub(p, g.mul(alpha, g.div(m2, g.add(g.sqrt(g.mul(v2, c2)), ce))));
            g.output(p2); g.output(m2); g.output(v2); state.push({ param: p.name, p: p2.name, m: m.name, m2: m2.name, v: v.name, v2: v2.name });
        }
        return state;
    }

    // ───────── 直譯器（Float64） ─────────
    function bIter(shape, outShape, fn) { // 對輸出每個索引，呼叫 fn(outIdx, srcOffset)
        const r = outShape.length, st = strides(shape), lead = r - shape.length; const idx = new Array(r).fill(0), n = prod(outShape);
        for (let o = 0; o < n; o++) {
            let off = 0; for (let d = lead; d < r; d++) if (shape[d - lead] !== 1) off += idx[d] * st[d - lead];
            fn(o, off);
            for (let d = r - 1; d >= 0; d--) { if (++idx[d] < outShape[d]) break; idx[d] = 0; }
        }
    }
    const UN = { Neg: (x) => -x, Sqrt: Math.sqrt, Reciprocal: (x) => 1 / x, Log: Math.log, Sigmoid: (x) => 1 / (1 + Math.exp(-x)) };
    const BIN = { Add: (a, b) => a + b, Sub: (a, b) => a - b, Mul: (a, b) => a * b, Div: (a, b) => a / b };
    const sc0 = (t) => t.shape.length === 0;
    function execNode(n, vals, g) {
        const I = n.inputs.map((x) => vals.get(x)); const outT = g.tensors.get(n.outputs[0]); const os = outT.shape; const out = new Float64Array(prod(os));
        const op = n.op;
        if (BIN[op]) { const f = BIN[op]; const ia = new Int32Array(out.length), ib = new Int32Array(out.length); bIter(I[0].shape, os, (o, off) => { ia[o] = off; }); bIter(I[1].shape, os, (o, off) => { ib[o] = off; }); for (let o = 0; o < out.length; o++) out[o] = f(I[0].data[ia[o]], I[1].data[ib[o]]); }
        else if (UN[op]) { const f = UN[op]; for (let i = 0; i < out.length; i++) out[i] = f(I[0].data[i]); }
        else if (op === 'MatMul') {
            const a = I[0], b = I[1], m = a.shape[a.shape.length - 2], k = a.shape[a.shape.length - 1], nn = b.shape[b.shape.length - 1]; const bs = os.slice(0, -2), nb = prod(bs);
            const ia = new Int32Array(nb), ib = new Int32Array(nb); const as = a.shape.slice(0, -2), bsh = b.shape.slice(0, -2);
            if (nb > 0) { bIter(as, bs, (o, off) => { ia[o] = off; }); bIter(bsh, bs, (o, off) => { ib[o] = off; }); }
            const bsz = m * nn; for (let q = 0; q < Math.max(nb, 1); q++) { const ao = (nb ? ia[q] : 0) * m * k, bo = (nb ? ib[q] : 0) * k * nn, co = q * bsz; for (let i = 0; i < m; i++) for (let p = 0; p < k; p++) { const av = a.data[ao + i * k + p]; if (av === 0) continue; for (let j = 0; j < nn; j++) out[co + i * nn + j] += av * b.data[bo + p * nn + j]; } }
        }
        else if (op === 'Transpose') { const p = n.attrs.perm, ish = I[0].shape, ist = strides(ish); const idx = new Array(os.length).fill(0); for (let o = 0; o < out.length; o++) { let off = 0; for (let d = 0; d < os.length; d++) off += idx[d] * ist[p[d]]; out[o] = I[0].data[off]; for (let d = os.length - 1; d >= 0; d--) { if (++idx[d] < os[d]) break; idx[d] = 0; } } }
        else if (op === 'Reshape') out.set(I[0].data);
        else if (op === 'Expand') { bIter(I[0].shape, os, (o, off) => { out[o] = I[0].data[off]; }); }
        else if (op === 'Softmax') { const ax = n.attrs.axis, sh = I[0].shape, st = strides(sh), len = sh[ax], tot = out.length; const done = new Uint8Array(tot); for (let s = 0; s < tot; s++) { if (done[s]) continue; const base = s - (Math.floor(s / st[ax]) % len) * st[ax]; let mx = -Infinity; for (let j = 0; j < len; j++) mx = Math.max(mx, I[0].data[base + j * st[ax]]); let sum = 0; for (let j = 0; j < len; j++) { const e = Math.exp(I[0].data[base + j * st[ax]] - mx); out[base + j * st[ax]] = e; sum += e; done[base + j * st[ax]] = 1; } for (let j = 0; j < len; j++) out[base + j * st[ax]] /= sum; } }
        else if (op === 'ReduceSum' || op === 'ReduceMean') {
            const axes = op === 'ReduceSum' ? Array.from(I[1].data) : n.attrs.axes; const sh = I[0].shape; const keepS = sh.map((d, i) => (axes.includes(i) ? 1 : d)); const cnt = axes.reduce((a, i) => a * sh[i], 1);
            const oidx = new Int32Array(I[0].data.length); bIter(keepS, sh, (o, off) => { oidx[o] = off; }); for (let i = 0; i < oidx.length; i++) out[oidx[i]] += I[0].data[i]; if (op === 'ReduceMean') for (let i = 0; i < out.length; i++) out[i] /= cnt;
        }
        else if (op === 'Gather') { const d = I[0], ix = I[1], row = d.data.length / d.shape[0]; for (let i = 0; i < ix.data.length; i++) { const r = ix.data[i]; for (let j = 0; j < row; j++) out[i * row + j] = d.data[r * row + j]; } }
        else if (op === 'DequantizeLinear' && sc0(I[1])) { const q = I[0], s0 = I[1].data[0], z0 = I[2] ? I[2].data[0] : 0; for (let i = 0; i < out.length; i++) out[i] = (q.data[i] - z0) * s0; }
        else if (op === 'DequantizeLinear') { const q = I[0], sc = I[1], zp = I[2]; const ax = n.attrs.axis, st = strides(q.shape); for (let i = 0; i < out.length; i++) { const c = Math.floor(i / st[ax]) % q.shape[ax]; out[i] = (q.data[i] - (zp ? zp.data[c] : 0)) * sc.data[c]; } }
        else throw new Error('直譯器沒有實作：' + op);
        vals.set(n.outputs[0], { shape: os, data: out });
    }
    function run(g, feeds) {
        const vals = new Map(); for (const [k, t] of g.tensors) if (t.isConst) vals.set(k, { shape: t.shape, data: t.data instanceof Float64Array ? t.data : Float64Array.from(t.data) });
        for (const t of g.inputs) { const f = feeds[t.name]; if (!f) throw new Error('缺少輸入：' + t.name); vals.set(t.name, { shape: t.shape, data: Float64Array.from(f) }); }
        for (const n of g.nodes) execNode(n, vals, g);
        return vals;
    }

    // ───────── ONNX 序列化 ─────────
    const TE = typeof TextEncoder !== 'undefined' ? new TextEncoder() : { encode: (s) => Uint8Array.from(Buffer.from(s, 'utf8')) };
    function vb(v) { const o = []; while (v >= 128) { o.push((v % 128) | 128); v = Math.floor(v / 128); } o.push(v); return o; }
    const cat = (arrs) => { let n = 0; for (const a of arrs) n += a.length; const o = new Uint8Array(n); let p = 0; for (const a of arrs) { o.set(a, p); p += a.length; } return o; };
    const fVar = (f, v) => Uint8Array.from([...vb(f * 8), ...vb(v)]);
    const fLen = (f, b) => cat([Uint8Array.from([...vb(f * 8 + 2), ...vb(b.length)]), b]);
    const fStr = (f, s) => fLen(f, TE.encode(s));
    function rawOf(dt, data) {
        if (dt === 'f32') { const a = new Float32Array(data.length); for (let i = 0; i < a.length; i++) a[i] = data[i]; return new Uint8Array(a.buffer); }
        if (dt === 'i64') { const a = new BigInt64Array(data.length); for (let i = 0; i < a.length; i++) a[i] = BigInt(Math.round(data[i])); return new Uint8Array(a.buffer); }
        if (dt === 'i32') { const a = new Int32Array(data.length); for (let i = 0; i < a.length; i++) a[i] = data[i]; return new Uint8Array(a.buffer); }
        if (dt === 'u8') return data instanceof Uint8Array ? data : Uint8Array.from(data); if (dt === 'i8') return new Uint8Array(Int8Array.from(data).buffer);
        throw new Error('未知 dtype ' + dt);
    }
    function tensorProto(name, shape, dt, data) { return cat([...shape.map((d) => fVar(1, d)), fVar(2, DT[dt]), fStr(8, name), fLen(9, rawOf(dt, data))]); }
    function attrProto(k, v) {
        if (Array.isArray(v)) return cat([fStr(1, k), ...v.map((x) => fVar(8, x)), fVar(20, 7)]);
        if (Number.isInteger(v)) return cat([fStr(1, k), fVar(3, v), fVar(20, 2)]);
        throw new Error('不支援的屬性型別 ' + k);
    }
    function valueInfo(t) { const dims = cat(t.shape.map((d) => fLen(1, fVar(1, d)))); const tt = cat([fVar(1, DT[t.dtype]), fLen(2, dims)]); return cat([fStr(1, t.name), fLen(2, fLen(1, tt))]); }
    function toOnnx(g, opts) {
        opts = opts || {}; const parts = [];
        for (const n of g.nodes) parts.push(fLen(1, cat([...n.inputs.map((x) => fStr(1, x)), ...n.outputs.map((x) => fStr(2, x)), fStr(3, n.outputs[0] + '_n'), fStr(4, n.op), ...Object.keys(n.attrs).filter((k) => n.attrs[k] !== undefined).map((k) => fLen(5, attrProto(k, n.attrs[k])))])));
        parts.push(fStr(2, opts.name || 'train_graph'));
        for (const [, t] of g.tensors) if (t.isConst) parts.push(fLen(5, tensorProto(t.name, t.shape, t.dtype, t.data)));
        for (const t of g.inputs) parts.push(fLen(11, valueInfo(t)));
        for (const t of g.outputs) parts.push(fLen(12, valueInfo(t)));
        const opset = cat([fStr(1, ''), fVar(2, 17)]);
        return cat([fVar(1, 8), fLen(8, opset), fLen(7, cat(parts))]);
    }

    return { G, RULES, grad, adam, run, toOnnx, DT, prod };
});
