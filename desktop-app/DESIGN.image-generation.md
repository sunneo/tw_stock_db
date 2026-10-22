# 圖像生成（NVIDIA 線上模型）

## 內建預設
- 模型清單（內建，順序固定）：FLUX.1 schnell → FLUX.2 klein 4B → FLUX klein → FLUX.1 dev → Stable Diffusion 3 Medium。預設用最快的 schnell。之後加 OpenRouter 的圖像模型時排在這些後面。
- **沒有填金鑰**。規則跟內建的 NVIDIA 模型一樣：留空就退回「我們預設的網址與金鑰」。
  - 預設是 NVIDIA 官方端點（`…nvidia.com…`）：直接打 `https://ai.api.nvidia.com/v1/genai/<廠商>/<模型>`，用預設金鑰。
  - 預設是 Cloudflare Worker（訪客的預設）：打 `{Worker}/genai/<廠商>/<模型>`，請求本文跟 NVIDIA 的一樣；**金鑰由 Worker 那端解析**（跟 `/openrouter` 同一種作法）。
  - 使用者自己在「進階設定 → 影音處理」填了 nvapi- 金鑰：一律直接打 NVIDIA，不經 Worker。
- 輪流使用多把 NVIDIA 金鑰是 Worker 那端自己的事（部署者自己用），這個專案的程式不內建任何金鑰輪替。

## Worker 要加的路由（私有 repo 的 `code/cloudflare-worker/worker.js`，這個專案改不到）
請求：`POST {Worker}/genai/black-forest-labs/flux.1-schnell`，本文是 JSON（`prompt`、`width`、`height`、`seed`、`steps`…），標頭 `Authorization: Bearer <假金鑰>`（要忽略）。
Worker 做的事：只放行 `/genai/<廠商>/<模型>`（模型路徑只允許英數、`.`、`_`、`-`），把本文原樣轉到 `https://ai.api.nvidia.com/v1/genai/<廠商>/<模型>`，換上真正的 `Authorization: Bearer <NVIDIA 金鑰>`，把回應原樣傳回（含 CORS 標頭）。建議限制本文大小與每個來源的頻率。

```js
// 示意（照 Worker 現有的寫法調整）
async function handleGenai(request, env, path) {
  const m = /^\/genai\/([a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*)$/i.exec(path);
  if (!m) return new Response('bad model path', { status: 400 });
  const body = await request.text();
  if (body.length > 20000) return new Response('too large', { status: 413 });
  const r = await fetch('https://ai.api.nvidia.com/v1/genai/' + m[1], {
    method: 'POST', body,
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: 'Bearer ' + pickNvidiaKey(env) },
  });
  return new Response(r.body, { status: r.status, headers: { 'Content-Type': 'application/json', ...corsHeaders(request) } });
}
```

## 回應格式
`artifacts[].base64`（FLUX）、`image`（SD3）、`data[].b64_json` 都認得；被安全過濾擋掉會明說是被過濾。

## 驗證
`scripts/imagegen-tests/nvidia_image.test.js`（請求整理、參數夾範圍、回應解析）、`scripts/eval/imagegen-nvidia.eval.js` 與 `scripts/eval/imagegen-default.eval.js`（真實 Electron、假的網路回應）。沒有用真的 NVIDIA 金鑰打過真的服務。

## 本機小模型生圖（SDXS-512，2026-10-22，整合完成、尚未在真機實測執行速度）
- 目的：離線也能畫圖，不連線上服務。TODO「WebGPU／CPU＋transformers.js 的圖像生成（模型要夠小）」的第一版。
- 模型：SDXS-512-DreamShaper（DreamShaper 8 蒸餾，一步取樣、不需要 guidance、固定 512×512，授權 CreativeML Open RAIL++-M，有使用限制，下載前的同意視窗會寫出來）。兩個版本，依這台機器選：
  - **GPU 版**（fp16，約 880 MB）：`skillsafeai/sdxs-512-dreamshaper-onnx-webgpu`，onnxruntime-web 的 WebGPU，需要顯示卡支援 shader-f16。
  - **CPU 版**（int8，約 1.12 GB）：`lequangky/tipsy-sdxs-512-int8`，onnxruntime-web 的 wasm；MatMul 權重 int8、Conv 保持 fp32。沒有 WebGPU 或沒有 f16 的電腦用這個。
  - 兩個版本的 commit 與每個檔案的位元組數都釘在程式裡；下載完核對大小，不對就刪掉重來。分詞器用 transformers.js 的 `Xenova/clip-vit-base-patch32`（跟 SD 1.x 同一套 CLIP 詞表）。
- 取樣（一步）：sigma = 14.6146…；x = randn(1,4,64,64)×sigma；eps = unet(x/√(sigma²+1), t=999, 文字向量)；x0 = x − sigma×eps；影像 = 解碼器(x0)／2 + 0.5。亂數是可重現的（seed 一樣、圖就一樣）。
- 流程：判斷用哪一版（設定可指定）→ 沒下載就說明大小與授權、問同意、下載（Cache Storage `fa-localsd`，邊下載邊算進度）→ 載入（閒置 5 分鐘釋放）→ 一步取樣 → PNG，顯示在對話並放進檔案快取。GPU 版沒跑起來（常見是顯示卡沒有 f16）會自動改用 CPU 版（如果 CPU 版已下載）。
- 入口：`generate_image` 工具與 `/image` 多了 `provider`（auto｜online｜local）；預設 auto＝線上優先，線上失敗而且本機模型已下載才改用本機（不會自動下載幾百 MB）；離線模式直接用本機。設定頁「圖像生成」有「畫圖用哪裡的模型」、「本機小模型用什麼算」、狀態與下載／刪除按鈕。
- 驗證：`scripts/imagegen-tests/local_sd.test.js`（33 項：版本選擇、取樣的數學、亂數、張量轉圖片、錯誤說明）；真實 Electron 驗了選版本（這台是 GT 720，有 WebGPU 但沒有 f16 → 選 CPU 版）、同意被拒不下載、下載→快取→核對大小→再次不重下載、大小不對不留壞檔、設定畫面。
- **還沒驗證**：真的載入模型並畫出一張圖（onnxruntime-web 的 WebGPU／wasm 執行、輸入輸出名稱與型別的判斷、速度、記憶體）。CPU 版在沒有跨來源隔離（單執行緒）時可能要好幾分鐘；Electron 要開 crossOriginIsolated 才有多執行緒，這次沒做。
