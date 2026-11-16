'use strict';
// midigen 固定種子生成：真 ORT 與 CPU 參考各自逐步生成 N 個詞元（seeded 取樣，同一個取樣器），輸出 ORT 的詞元序列與每步 logits 給 GPU 驗證頁比對。
// 用法：node scripts/eval/cudaweb_midi_gen_ref.js <模型> <輸出 json> [N=12] [seed=12345]
const fs = require('fs'), path = require('path'), os = require('os');
const MD = require('../../renderer/src/gpu/midi_decoder.js');
const [modelPath, outPath] = [process.argv[2], process.argv[3]], N = Number(process.argv[4]) || 12, SEED = Number(process.argv[5]) || 12345;
if (!modelPath || !outPath) { console.error('用法：... <模型> <輸出 json> [N] [seed]'); process.exit(2); }
const ort = require(path.join(process.env.APPDATA || path.join(os.homedir(), '.config'), 'floating-assistant-desktop', 'native-runtime', '1.22.0-1', 'node_modules', 'onnxruntime-node'));
// 取樣器（驗證頁內有同一份）：mulberry32，溫度 0.9，top-k 20
const SAMPLER = `function mulberry32(a){return function(){a|=0;a=a+0x6D2B79F5|0;var t=Math.imul(a^a>>>15,1|a);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296}}
function sampleTok(logits,rnd){var idx=Array.from(logits.keys()).sort(function(a,b){return logits[b]-logits[a]||a-b}).slice(0,20),mx=logits[idx[0]],ps=idx.map(function(i){return Math.exp((logits[i]-mx)/0.9)}),s=ps.reduce(function(a,b){return a+b},0),r=rnd()*s;for(var k=0;k<idx.length;k++){r-=ps[k];if(r<=0)return idx[k]}return idx[idx.length-1]}`;
eval(SAMPLER + ';global.mulberry32=mulberry32;global.sampleTok=sampleTok;');
(async () => {
  const buf = fs.readFileSync(modelPath), model = MD.loadMidiDecoder(buf);
  const sess = await ort.InferenceSession.create(buf, { executionProviders: ['cpu'] });
  const prompt = [7, 123, 45, 300, 12];
  // ORT 生成
  let past = null, ids = prompt, rnd = global.mulberry32(SEED);
  const ortToks = [], ortLogits = [];
  for (let s = 0; s < N; s++) {
    const feeds = { ids: new ort.Tensor('int64', BigInt64Array.from(ids.map((x) => BigInt(x))), [1, ids.length]) };
    for (let i = 0; i < MD.NL; i++) { feeds['past_k' + i] = past ? past[i].k : new ort.Tensor('float32', new Float32Array(0), [1, MD.H, 0, MD.HD]); feeds['past_v' + i] = past ? past[i].v : new ort.Tensor('float32', new Float32Array(0), [1, MD.H, 0, MD.HD]); }
    const o = await sess.run(feeds);
    past = []; for (let i = 0; i < MD.NL; i++) past.push({ k: o['present_k' + i], v: o['present_v' + i] });
    const lg = Float32Array.from(o.logits.data); ortLogits.push(Array.from(lg));
    const t = global.sampleTok(lg, rnd); ortToks.push(t); ids = [t];
  }
  // CPU 參考生成
  let cache = null; ids = prompt; rnd = global.mulberry32(SEED);
  const cpuToks = [];
  for (let s = 0; s < N; s++) { const r = await MD.decode(model, ids, cache); cache = r.cache; const t = global.sampleTok(r.logits, rnd); cpuToks.push(t); ids = [t]; }
  const same = JSON.stringify(ortToks) === JSON.stringify(cpuToks);
  console.log(JSON.stringify({ N, SEED, prompt, ortToks, cpuToks, same }));
  fs.writeFileSync(outPath, JSON.stringify({ N, SEED, prompt, ortToks, ortLogits, sampler: SAMPLER }));
  process.exitCode = same ? 0 : 1;
})().catch((e) => { console.error(e && e.stack || e); process.exitCode = 1; });
