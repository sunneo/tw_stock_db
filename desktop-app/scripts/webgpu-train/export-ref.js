#!/usr/bin/env node
// 給「獨立參考實作」(PyTorch：lora-train/webtrain_ref.py) 與瀏覽器／逐層引擎共用的資料：
//   node scripts/webgpu-train/export-ref.js <model_quantized.onnx> <輸出資料夾> [T=32] [rank=8] [nseq=4]
// 輸出：weights.bin（所有 uint8 權重原樣串接）、weights.json（名稱→offset／形狀／縮放／零點，另含 float32 的 norm 增益與 cos/sin 表）、
//       seqs.json（nseq 條 token 序列，訓練時循環使用）、init.bin＋meta.json（LoRA 初始值與參數名稱順序，與 export-graph 的格式相容）。
const fs = require('fs'), path = require('path');
const [modelPath, outDir, TS, rS, nS] = process.argv.slice(2); if (!modelPath || !outDir) { console.error('用法見檔頭'); process.exit(2); }
const T = +(TS || 32), rank = +(rS || 8), nseq = +(nS || 4);
const Ref = require('../../renderer/src/studio/lora_ref_train.js'), Q = require('../../renderer/src/studio/qwen3_graph.js'), E = require('../../renderer/src/studio/qwen3_layered_engine.js');
const buf = fs.readFileSync(modelPath); const M = Q.openModel(new Uint8Array(buf.buffer, buf.byteOffset, buf.length)); fs.mkdirSync(outDir, { recursive: true });
const parts = [], index = { T, rank, alpha: 2 * rank, layers: 28, u8: {}, f32: {} }; let off = 0;
const addU8 = (key, name) => { const t = M.ix.inits.get(name); if (!t || t.dataType !== 2 || t.rawStart < 0) throw new Error('讀不到 uint8：' + name); const pre = name.replace(/\.weight_quantized$/, ''); const sc = M.ix.inits.get(pre + '.weight_scale'), zp = M.ix.inits.get(pre + '.weight_zero_point');
  index.u8[key] = { offset: off, shape: t.dims, scale: sc.floatData ? sc.floatData[0] : null, zp: zp.int32Data ? zp.int32Data[0] : (zp.rawStart >= 0 ? M.bytes[zp.rawStart] : null) }; const b = M.bytes.subarray(t.rawStart, t.rawEnd); parts.push(b); off += b.length; };
const f32 = (name, limitRows) => { const x = Q.f32Of(M, name); let d = x.data, dims = x.dims; if (limitRows) { d = d.slice(0, limitRows * dims[1]); dims = [limitRows, dims[1]]; } return { shape: dims, data: Array.from(d) }; };
addU8('embed', 'model.embed_tokens.weight_quantized');
for (let l = 0; l < 28; l++) {
  const pre = 'model.layers.' + l + '.';
  for (const [k, f] of [['q', 'attn.q_proj'], ['k', 'attn.k_proj'], ['v', 'attn.v_proj'], ['o', 'attn.o_proj'], ['gate', 'mlp.gate_proj'], ['up', 'mlp.up_proj'], ['down', 'mlp.down_proj']]) addU8('l' + l + '.' + k, pre + f + '.MatMul.weight_quantized');
  index.f32['l' + l + '.n1'] = f32(pre + 'input_layernorm.weight'); index.f32['l' + l + '.n2'] = f32(pre + 'post_attention_layernorm.weight'); index.f32['l' + l + '.qn'] = f32(pre + 'attn.q_norm.layernorm.weight'); index.f32['l' + l + '.kn'] = f32(pre + 'attn.k_norm.layernorm.weight');
}
index.f32.final_norm = f32('model.layers.28.final_norm_layernorm.weight'); index.f32.cos = f32('cos_cache', 256); index.f32.sin = f32('sin_cache', 256);
const w = fs.openSync(path.join(outDir, 'weights.bin'), 'w'); for (const p of parts) fs.writeSync(w, p); fs.closeSync(w);
fs.writeFileSync(path.join(outDir, 'weights.json'), JSON.stringify(index));
const rng = Ref.makeRng(5); const seqs = []; for (let i = 0; i < nseq; i++) { const s = Array.from({ length: T + 1 }, () => 1000 + Math.floor(rng() * 50000)); seqs.push({ ids: s.slice(0, T), tgt: s.slice(1) }); }
fs.writeFileSync(path.join(outDir, 'seqs.json'), JSON.stringify(seqs));
// LoRA 初始值：A ~ N(0,1/din)，B=0；順序＝引擎的 shapes 迭代順序
const eng = new E.LayeredEngine({ ort: null, M, T, rank, layers: 28 }); const rn = (() => { let s = 7; const u = () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; return () => Math.sqrt(-2 * Math.log(u() + 1e-12)) * Math.cos(2 * Math.PI * u()); })();
const params = [], chunks = []; for (const [name, shape] of eng.shapes) { const n = shape[0] * shape[1]; const a = new Float32Array(n); if (/\.A$/.test(name)) { const sd = 1 / Math.sqrt(shape[0]); for (let i = 0; i < n; i++) a[i] = rn() * sd; } params.push({ name, shape }); chunks.push(Buffer.from(a.buffer)); }
fs.writeFileSync(path.join(outDir, 'init.bin'), Buffer.concat(chunks));
fs.writeFileSync(path.join(outDir, 'meta.json'), JSON.stringify({ T, rank, layers: 28, chunks: 8, Vc: eng.Vc, ids: seqs[0].ids, tgt: seqs[0].tgt, params }));
console.log('輸出 ' + outDir + '：weights.bin ' + (off / 1048576).toFixed(0) + 'MB、' + Object.keys(index.u8).length + ' 個 uint8 矩陣、' + nseq + ' 條序列、' + params.length + ' 個 LoRA 張量');
