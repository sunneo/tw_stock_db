/* 網頁版逐層 LoRA 訓練引擎（DESIGN.TODO.offline-training-studio.md §5.6）。
 *  為什麼逐層：整個 28 層訓練圖放進一個 onnxruntime-web 工作階段時，WASM 的 32 位元位址空間（4GB）會被「模型複本＋常數折疊＋激活」吃滿；
 *  逐層則任何時刻只有一層的權重（約 15MB）在算，激活只留每層的輸入（activation checkpointing，反向時在反向圖裡重算本層前向）。
 *  一步 = 嵌入（圖外）→ 28 次前向圖 F → 頭部圖 H（loss、dh）→ 28 次反向圖 B（dx、本層 14 個梯度）→ 圖外 Adam。
 *  依賴注入：ort（onnxruntime-web 模組）、模型位元組由 qwen3_graph.openModel 提供。後端 ep 可選 'wasm' 或 'webgpu'。
 *  這裡不含檔案系統／IndexedDB；層圖的位元組來源 layerSource 可替換（預設即時由模型建圖；交換空間版從 IndexedDB 取）。 */
'use strict';
const Gm = require('./onnx_grad_core.js');
const Q = require('./qwen3_graph.js');

function randnFn(seed) { let s = seed >>> 0 || 1; const u = () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; return () => Math.sqrt(-2 * Math.log(u() + 1e-12)) * Math.cos(2 * Math.PI * u()); }
const DIMS = { q: [1024, 2048], k: [1024, 1024], v: [1024, 1024], o: [2048, 1024], gate: [1024, 3072], up: [1024, 3072], down: [3072, 1024] };

class LayeredEngine {
    constructor(o) {
        this.ort = o.ort; this.ep = o.ep || 'wasm'; this.M = o.M; this.T = o.T; this.rank = o.rank; this.layers = o.layers === undefined ? 28 : o.layers; this.chunks = o.headChunks || 8;
        this.graphOpt = o.graphOpt || (this.ep === 'webgpu' ? 'basic' : 'disabled');   // WebGPU 後端在最佳化全關時會算錯（逐算子實測），WASM 要關掉常數折疊以免 fp32 權重複本
        this.lr = o.lr === undefined ? 0.001 : o.lr; this.b1 = 0.9; this.b2 = 0.999; this.eps = 1e-8;
        this.keep = o.keepSessions !== false; this.sess = new Map(); this.layerSource = o.layerSource || null; this.stats = { created: 0, runMs: 0, createMs: 0 };
        this.V = this.M.ix.inits.get('model.embed_tokens.weight_quantized').dims[0]; this.Vc = this.V / this.chunks; this.phase = ''; this.params = new Map(); this.m = new Map(); this.v = new Map(); this.t = 0; this.shapes = new Map();
        for (let l = 0; l < this.layers; l++) for (const k of Object.keys(DIMS)) { const [din, dout] = DIMS[k]; this.shapes.set('l' + l + '.' + k + '.A', [din, this.rank]); this.shapes.set('l' + l + '.' + k + '.B', [this.rank, dout]); }
    }
    // 初始化：A 為 N(0,1/din)，B 為 0；也可傳入 Map<name, Float32Array>（續訓／與別的實作對拍）
    initParams(init, seed) {
        const rn = randnFn(seed || 7);
        for (const [name, shape] of this.shapes) {
            const n = shape[0] * shape[1]; let a;
            if (init && init.has(name)) { a = Float32Array.from(init.get(name)); if (a.length !== n) throw new Error('初始值大小不符：' + name); }
            else { a = new Float32Array(n); if (/\.A$/.test(name)) { const sd = 1 / Math.sqrt(shape[0]); for (let i = 0; i < n; i++) a[i] = rn() * sd; } }
            this.params.set(name, a); this.m.set(name, new Float32Array(n)); this.v.set(name, new Float32Array(n));
        }
        this.t = 0;
    }
    async _session(kind, layer) {
        const key = kind + layer; if (this.sess.has(key)) return this.sess.get(key);
        const t0 = Date.now(); let bytes;
        if (this.layerSource) bytes = await this.layerSource(kind, layer);
        else { const b = kind === 'F' ? Q.buildLayerF(this.M, layer, this.T, this.rank) : kind === 'B' ? Q.buildLayerB(this.M, layer, this.T, this.rank) : Q.buildHead(this.M, this.T, { headChunks: this.chunks }); bytes = Gm.toOnnx(b.g, { name: key }); }
        const s = await this.ort.InferenceSession.create(bytes, { executionProviders: [this.ep], graphOptimizationLevel: this.graphOpt, logSeverityLevel: 3 });
        this.stats.created++; this.stats.createMs += Date.now() - t0;
        if (this.keep) this.sess.set(key, s);
        return s;
    }
    _layerFeeds(layer, feeds) { for (const k of Object.keys(DIMS)) for (const w of ['A', 'B']) { const name = 'l' + layer + '.' + k + '.' + w; feeds[name] = new this.ort.Tensor('float32', this.params.get(name), this.shapes.get(name)); } return feeds; }
    async _release(s) { if (!this.keep && s.release) await s.release(); }
    async _forward(ids) {
        const T = this.T, d = 1024; const x0 = Float32Array.from(Q.embed(this.M, ids)); const acts = [x0];
        for (let l = 0; l < this.layers; l++) {
            this.phase = '前向 ' + (l + 1) + '/' + this.layers; const s = await this._session('F', l); const t0 = Date.now();
            const out = await s.run(this._layerFeeds(l, { x: new this.ort.Tensor('float32', acts[l], [T, d]) })); this.stats.runMs += Date.now() - t0;
            acts.push(Float32Array.from(out[s.outputNames[0]].data)); await this._release(s);
        }
        return acts;
    }
    async _head(h, tgt, withGrad, mask) {
        const T = this.T; const s = await this._session('H', 0); const loss = s.outputNames[0], dh = s.outputNames[1], chunks = this.chunks, Vc = this.Vc;   // 輸出順序固定：loss、dh
        const feeds = { h: new this.ort.Tensor('float32', h, [T, 1024]), rowmask: new this.ort.Tensor('float32', LayeredEngine.rowMask(mask, T), [T]) };
        for (let k = 0; k < chunks; k++) { const oh = new Float32Array(T * Vc); tgt.forEach((id, t) => { if (id >= k * Vc && id < (k + 1) * Vc) oh[t * Vc + id - k * Vc] = 1; }); feeds['onehot' + k] = new this.ort.Tensor('float32', oh, [T, Vc]); }
        const t0 = Date.now(); const out = await s.run(feeds); this.stats.runMs += Date.now() - t0; await this._release(s);
        return { loss: out[loss].data[0], dh: withGrad ? Float32Array.from(out[dh].data) : null };
    }
    static rowMask(mask, T) { const r = new Float32Array(T); if (!mask) return r.fill(1 / T); let n = 0; for (let i = 0; i < T; i++) if (mask[i]) n++; if (!n) throw new Error('這一筆沒有任何要算損失的位置（答案 token 為 0）'); for (let i = 0; i < T; i++) r[i] = mask[i] ? 1 / n : 0; return r; }
    async evalLoss(ids, tgt, mask) { const acts = await this._forward(ids); const r = await this._head(acts[this.layers], tgt, false, mask); return { loss: r.loss }; }
    // 一個訓練步；回傳 {loss, gradNorm, ms}
    async step(ids, tgt, lr, mask) {
        const t0 = Date.now(); const T = this.T, d = 1024; const acts = await this._forward(ids); const hd = await this._head(acts[this.layers], tgt, true, mask);
        let dh = hd.dh; this.t++; const lr_ = lr === undefined ? this.lr : lr; const c1 = 1 - Math.pow(this.b1, this.t), c2 = 1 - Math.pow(this.b2, this.t); let gn = 0;
        for (let l = this.layers - 1; l >= 0; l--) {
            this.phase = '反向 ' + (this.layers - l) + '/' + this.layers; const s = await this._session('B', l); const t1 = Date.now();
            const out = await s.run(this._layerFeeds(l, { x: new this.ort.Tensor('float32', acts[l], [T, d]), dy: new this.ort.Tensor('float32', dh, [T, d]) })); this.stats.runMs += Date.now() - t1;
            const names = Q.layerParamNames(l), dx = s.outputNames[0];   // 輸出順序固定：dx，然後本層 14 個梯度（q,k,v,o,gate,up,down 各 A、B）
            names.forEach((name, i) => {
                const g = out[s.outputNames[1 + i]].data, p = this.params.get(name), m = this.m.get(name), v = this.v.get(name);
                for (let j = 0; j < p.length; j++) { const gj = g[j]; gn += gj * gj; m[j] = this.b1 * m[j] + (1 - this.b1) * gj; v[j] = this.b2 * v[j] + (1 - this.b2) * gj * gj; p[j] -= lr_ * (m[j] / c1) / (Math.sqrt(v[j] / c2) + this.eps); }
            });
            dh = Float32Array.from(out[dx].data); await this._release(s);
        }
        return { loss: hd.loss, gradNorm: Math.sqrt(gn), ms: Date.now() - t0 };
    }
    // 取出／放回完整訓練狀態（供規範化檢查點）
    exportState() { return { t: this.t, shapes: this.shapes, params: this.params, m: this.m, v: this.v }; }
    importState(st) { for (const [k, a] of st.params) { this.params.get(k).set(a); this.m.get(k).set(st.m.get(k)); this.v.get(k).set(st.v.get(k)); } this.t = st.t; }
    async dispose() { for (const s of this.sess.values()) if (s.release) await s.release(); this.sess.clear(); }
}

module.exports = { LayeredEngine, DIMS };
