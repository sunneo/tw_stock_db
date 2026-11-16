'use strict';
// 網頁版 lm_head 接線的真 Chrome 端到端驗證（只綁 127.0.0.1）。用法：node scripts/eval/cudaweb_web_head_browser.js [埠，預設 18767]
// 在真 Chrome 頁面裡跑與產品相同的程式：llm_web_core（greedyGenerate＋隱藏狀態頭）、head_service（q8lmAuto：WebGPU→WebGL2）、
// onnx_lite（變體圖）。模型與分詞器讀自本機已有的 q8 檔（不下載）。onnxruntime-web 1.22.0 由頁面從與產品相同的 CDN 載入（見 ORT_URL）。
// 比對：原路徑（ORT wasm）詞元 vs 頭開啟（變體圖＋GPU 頭）詞元；另跑「頭開啟但沒有 GPU」應整段退回原路徑、詞元相同。結果寫 cudaweb_web_head_browser.result.json。
// 驗完用 /quit 關掉伺服器。
const http = require('http'), fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const PORT = Number(process.argv[2]) || 18767;
const rd = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const base = path.join(process.env.APPDATA, 'floating-assistant-desktop', 'native-models', 'qwen3-0.6b-q8');
const MODEL = fs.readFileSync(path.join(base, 'onnx', 'model_quantized.onnx'));
const TOK = fs.readFileSync(path.join(base, 'tokenizer.json'));
const ORT_URL = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/ort.wasm.min.mjs';
const ORT_BASE = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/';
const SHIM = (name, file) => 'window.__mods=window.__mods||{};window.__mods[' + JSON.stringify(name) + ']=(function(){var module={exports:{}};var exports=module.exports;function require(n){var k=n.replace(/^\\.\\//,"").replace(/\\.js$/,"");if(window.__mods[k])return window.__mods[k];if(k==="gpu_core")return window.FaGpuCore;throw new Error("no "+n)}\n' + rd(file) + '\nreturn module.exports})();';

const PAGE = `<!doctype html><meta charset="utf-8"><title>網頁版 lm_head 驗證</title>
<body style="font:14px/1.5 system-ui;margin:16px"><h3>網頁版 lm_head 接線（真 Chrome）</h3><pre id="out">執行中…</pre>
<script src="/gpu_core.js"></script><script src="/mods.js"></script><script src="/llm_web_core.js"></script>
<script type="module">
const out=document.getElementById('out');
const R={userAgent:navigator.userAgent,navigatorGpu:!!navigator.gpu};
const log=(m)=>{R.progress=(R.progress||[]); R.progress.push(m); out.textContent=JSON.stringify(R,null,1);};
try{
  const ort=await import('${ORT_URL}');
  ort.env.wasm.wasmPaths='${ORT_BASE}'; ort.env.wasm.numThreads=1;
  R.ortVersion='1.22.0';
  const H=window.__mods.head_service, LLM=window.FaLlmWeb, lm0=null;
  const mdl=new Uint8Array(await (await fetch('/model')).arrayBuffer());
  const tokj=await (await fetch('/tokenizer.json')).json();
  const tok=LLM.createTokenizer(tokj);
  const eosIds=(tokj.added_tokens||[]).filter(t=>['<|im_end|>','<|endoftext|>'].indexOf(t.content)>=0).map(t=>t.id);
  const ids=tok.encode('用一句話介紹台北。');
  log('loading original session');
  let t=performance.now();
  const sess=await LLM.loadSession(ort, mdl, {executionProviders:['wasm']});
  R.loadOrigMs=Math.round(performance.now()-t);
  const lm=H.extractLmHead(mdl);
  t=performance.now();
  const v=H.buildVariant(mdl,1024);
  R.variantBuildMs=Math.round(performance.now()-t); R.variantRemoved=v.removed.length;
  log('loading variant session');
  t=performance.now();
  const vsess=await LLM.loadSession(ort, v.bytes, {executionProviders:['wasm']});
  R.loadVariantMs=Math.round(performance.now()-t);
  const svc=H.createHeadService({meta:lm.meta, weights:lm.W, navigator});
  const svcNoGpu=H.createHeadService({meta:lm.meta, weights:lm.W, navigator:{}, gl:null});
  const gen=(headOpts)=>LLM.greedyGenerate(ort, sess, ids, {maxNew:8, eosIds, layers:28, kvHeads:8, headDim:128, head: headOpts});
  log('original run');
  t=performance.now(); const ref=await gen(undefined); R.origGenMs=Math.round(performance.now()-t); R.origTokens=ref.tokens;
  log('head run (GPU)');
  t=performance.now();
  const a=await gen({variant:vsess, hiddenName:v.hiddenName, vocab:lm.meta.V, run:(h)=>svc.computeF32(h).then(r=>r.logits), timeoutMs:8000, verifySteps:1});
  R.headGenMs=Math.round(performance.now()-t); R.headTokens=a.tokens; R.headDiag=a.head; R.headLayers=svc.stats.layers;
  log('head run (no GPU)');
  const b=await gen({variant:vsess, hiddenName:v.hiddenName, vocab:lm.meta.V, run:(h)=>svcNoGpu.computeF32(h).then(r=>r.logits), timeoutMs:8000, verifySteps:1});
  R.noGpuTokens=b.tokens; R.noGpuDiag=b.head;
  R.textRef=tok.decode(ref.tokens);
  R.checks=[
    {name:'GPU 頭：詞元與原路徑相同', pass:JSON.stringify(a.tokens)===JSON.stringify(ref.tokens)},
    {name:'GPU 頭：全部步驟走頭、對拍通過', pass:a.head.used===a.head.steps && a.head.fallbackAt===-1 && a.head.verify.length===1 && a.head.verify[0].argmaxSame},
    {name:'沒有 GPU：整段退回原路徑、詞元相同、原因寫明', pass:JSON.stringify(b.tokens)===JSON.stringify(ref.tokens) && b.head.fallbackAt===0 && /沒有可用的 GPU 層/.test(b.head.reason)},
  ];
  R.pass=R.checks.every(c=>c.pass);
}catch(e){R.error=String(e&&e.stack||e).slice(0,1500);R.pass=false}
out.textContent=JSON.stringify(R,null,1);
try{await fetch('/result',{method:'POST',body:JSON.stringify(R)})}catch(_){}
document.title='網頁版 lm_head 驗證：'+(R.pass?'通過':'有項目未過');
</script>`;

const srv = http.createServer((req, res) => {
  const send = (code, type, body) => { res.writeHead(code, { 'Content-Type': type + '; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(body); };
  const bin = (b) => { res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': b.length, 'Cache-Control': 'no-store' }); res.end(Buffer.from(b.buffer, b.byteOffset, b.length)); };
  if (req.url === '/' || req.url.startsWith('/?')) return send(200, 'text/html', PAGE);
  if (req.url === '/gpu_core.js') return send(200, 'application/javascript', rd('renderer/src/gpu/gpu_core.js'));
  if (req.url === '/llm_web_core.js') return send(200, 'application/javascript', rd('renderer/src/studio/llm_web_core.js'));
  if (req.url === '/mods.js') return send(200, 'application/javascript', 'window.__mods={};\n' + ['nn_ops', 'infer_ops', 'onnx_lite', 'head_service'].map((n) => SHIM(n, 'renderer/src/gpu/' + n + '.js')).join('\n') + '\nwindow.__mods.head_service=window.__mods.head_service;');
  if (req.url === '/model') return bin(MODEL);
  if (req.url === '/tokenizer.json') return bin(TOK);
  if (req.url === '/result' && req.method === 'POST') { let b = ''; req.on('data', (d) => { b += d; }); req.on('end', () => { fs.writeFileSync(path.join(__dirname, 'cudaweb_web_head_browser.result.json'), b); send(200, 'text/plain', 'ok'); }); return; }
  if (req.url === '/quit') { send(200, 'text/plain', 'bye'); setTimeout(() => { srv.close(); process.exit(0); }, 100); return; }
  send(404, 'text/plain', 'not found');
}).listen(PORT, '127.0.0.1', () => console.log('網頁版 lm_head 驗證：http://127.0.0.1:' + PORT + '/'));
