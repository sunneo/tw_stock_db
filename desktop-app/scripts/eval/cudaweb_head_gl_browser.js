'use strict';
// lm_head 的 WebGL2 退路真瀏覽器驗證（只綁 127.0.0.1）。用法：node scripts/eval/cudaweb_head_gl_browser.js [埠，預設 18766]
// 權重讀自本機已有的 q8 模型（不下載）。頁面在真 Chrome 上跑：CPU 參考版、強制 WebGL2（T3）、預設自動選層（T1）三者比對。
// 結果 POST 回 /result，寫到 cudaweb_head_gl_browser.result.json。驗完用 /quit 關掉。
const http = require('http'), fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const PORT = Number(process.argv[2]) || 18766;
const rd = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const lite = require('../../renderer/src/gpu/onnx_lite.js');
const poc = require('../../renderer/src/gpu/infer_poc_core.js');
const modelPath = path.join(process.env.APPDATA, 'floating-assistant-desktop', 'native-models', 'qwen3-0.6b-q8', 'onnx', 'model_quantized.onnx');
const w = poc.extractWeights(lite.parseModel(fs.readFileSync(modelPath)), 0);
const meta = { V: w.lm.V, K: w.lm.K, zp: w.lm.zp, scale: w.lm.scale };
const LM = w.lm.W;  // 155 MB，只讀
const SHIM = (name, file) => 'window.__mods=window.__mods||{};window.__mods[' + JSON.stringify(name) + ']=(function(){var module={exports:{}};var exports=module.exports;function require(n){var k=n.replace(/^\\.\\//,"").replace(/\\.js$/,"");if(window.__mods[k])return window.__mods[k];if(k==="gpu_core")return window.FaGpuCore;throw new Error("no "+n)}\n' + rd(file) + '\nreturn module.exports})();';

const PAGE = `<!doctype html><meta charset="utf-8"><title>lm_head WebGL2 驗證</title>
<body style="font:14px/1.5 system-ui;margin:16px"><h3>lm_head 的 WebGL2 退路（真 Chrome）</h3><pre id="out">執行中…</pre>
<script src="/gpu_core.js"></script><script src="/mods.js"></script>
<script>
(async()=>{
 const out=document.getElementById('out');
 const R={userAgent:navigator.userAgent,navigatorGpu:!!navigator.gpu};
 try{
  const meta=await (await fetch('/meta.json')).json();
  const W=new Uint8Array(await (await fetch('/w/lm')).arrayBuffer());
  const ops=window.__mods.infer_ops;
  const K=meta.K, V=meta.V;
  let s=12345; const x=new Float32Array(K); for(let i=0;i<K;i++){ s=(s*1103515245+12345)>>>0; x[i]=((s>>>8)%20001)/10000-1; }
  const gl=new OffscreenCanvas(1,1).getContext('webgl2');
  R.webgl2={available:!!gl, maxTex: gl&&gl.getParameter(gl.MAX_TEXTURE_SIZE), colorBufferFloat: !!(gl&&gl.getExtension('EXT_color_buffer_float'))};
  let t=performance.now();
  const ref=ops.q8lmRef(x,W,meta.zp,V,K,meta.scale);
  R.refMs=Math.round(performance.now()-t);
  const cmp=(a)=>{let maxAbs=0,refMax=0,am=0,ag=0;for(let i=0;i<V;i++){maxAbs=Math.max(maxAbs,Math.abs(a[i]-ref[i]));refMax=Math.max(refMax,Math.abs(ref[i]));if(ref[i]>ref[am])am=i;if(a[i]>a[ag])ag=i;}return {maxRel:maxAbs/refMax,argmaxRef:am,argmaxGot:ag,argmatch:am===ag};};
  t=performance.now();
  const t3a=await ops.q8lmAuto(x,W,V,K,meta.zp,meta.scale,{skipT1:true,navigator:undefined});
  R.t3First={ms:Math.round(performance.now()-t),layer:t3a.info.layer,reasons:t3a.info.reasons,...cmp(t3a.result)};
  t=performance.now();
  const t3b=await ops.q8lmAuto(x,W,V,K,meta.zp,meta.scale,{skipT1:true,navigator:undefined});
  R.t3Warm={ms:Math.round(performance.now()-t),layer:t3b.info.layer,...cmp(t3b.result)};
  t=performance.now();
  const t1a=await ops.q8lmAuto(x,W,V,K,meta.zp,meta.scale,{});
  R.t1First={ms:Math.round(performance.now()-t),layer:t1a.info.layer,reasons:t1a.info.reasons,...cmp(t1a.result)};
  t=performance.now();
  const t1b=await ops.q8lmAuto(x,W,V,K,meta.zp,meta.scale,{});
  R.t1Warm={ms:Math.round(performance.now()-t),layer:t1b.info.layer,...cmp(t1b.result)};
  // 無 GPU 時必須丟出具體原因（不得偷偷用純 JS）
  try{ await ops.q8lmAuto(x,W,V,K,meta.zp,meta.scale,{navigator:{},gl:null}); R.noGpuNoThrow=true; }
  catch(e){ R.noGpuReasons=e.reasons; }
  R.pass=!!(R.t3First.layer==='T3'&&R.t3First.maxRel<1e-4&&R.t3First.argmatch&&R.t3Warm.maxRel<1e-4&&R.t1First.maxRel<1e-4&&R.t1First.argmatch&&R.noGpuReasons&&R.noGpuReasons.length>0);
 }catch(e){R.error=String(e&&e.stack||e).slice(0,1500);R.pass=false}
 out.textContent=JSON.stringify(R,null,1);
 try{await fetch('/result',{method:'POST',body:JSON.stringify(R)})}catch(_){}
 document.title='lm_head WebGL2 驗證：'+(R.pass?'通過':'有項目未過');
})();
</script>`;

const srv = http.createServer((req, res) => {
  const send = (code, type, body) => { res.writeHead(code, { 'Content-Type': type + '; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(body); };
  if (req.url === '/' || req.url.startsWith('/?')) return send(200, 'text/html', PAGE);
  if (req.url === '/gpu_core.js') return send(200, 'application/javascript', rd('renderer/src/gpu/gpu_core.js'));
  if (req.url === '/mods.js') return send(200, 'application/javascript', 'window.__mods={};\n' + ['nn_ops', 'infer_ops'].map((n) => SHIM(n, 'renderer/src/gpu/' + n + '.js')).join('\n'));
  if (req.url === '/meta.json') return send(200, 'application/json', JSON.stringify(meta));
  if (req.url === '/w/lm') { res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': LM.length, 'Cache-Control': 'no-store' }); return res.end(Buffer.from(LM.buffer, LM.byteOffset, LM.length)); }
  if (req.url === '/result' && req.method === 'POST') { let b = ''; req.on('data', (d) => { b += d; }); req.on('end', () => { fs.writeFileSync(path.join(__dirname, 'cudaweb_head_gl_browser.result.json'), b); send(200, 'text/plain', 'ok'); }); return; }
  if (req.url === '/quit') { send(200, 'text/plain', 'bye'); setTimeout(() => { srv.close(); process.exit(0); }, 100); return; }
  send(404, 'text/plain', 'not found');
}).listen(PORT, '127.0.0.1', () => console.log('lm_head WebGL2 驗證：http://127.0.0.1:' + PORT + '/'));
