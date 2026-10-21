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
