# cudaweb 與 cpu-py 全參數步量測摘要

## 環境
- 轉接器（cudaweb）：nvidia / kepler
- 最大儲存緩衝綁定：2147483644 bytes
- CPU（cpu-py）：Intel(R) Core(TM) i5-2320 CPU @ 3.00GHz，邏輯核心 4，記憶體 17.1 GB
- 執行緒（cpu-py）：4（設定值；未回讀實際值）
- 峰值假設（屋頂線）：0.3 TFLOPS、14 GB/s（使用者指定的本機規格預設；可用 --peak-tflops、--bw-gbs 覆寫）
- 量測口徑：批次 1 條序列；每步 30 步，前 5 步暖機，取中位數；cudaweb 含一次提交與兩次讀回；cpu-py 為 llm_full_cpu.py 逐步牆鐘時間。

## 各規模
| 規模 | T | 參數 | FLOPs／步 | 屋頂線預測 ms | cudaweb ms | cpu-py ms | cudaweb÷屋頂線 | cudaweb tokens/s | cpu-py tokens/s | cudaweb÷cpu-py |
|---|---|---|---|---|---|---|---|---|---|---|
| S | 12 | 26880 | 2.03e+6 | 0.046 | 32.3 | 15.4 | 701× | 372 | 781 | 2.1× |
| M | 64 | 656640 | 2.77e+8 | 1.126 | 294.6 | 50.9 | 262× | 217 | 1258 | 5.8× |
| L | 128 | 2886144 | 2.42e+9 | 8.053 | 1263.3 | 110.8 | 157× | 101 | 1155 | 11.4× |
| XL | 256 | 15211776 | 2.58e+10 | 85.899 | — | 622.0 | —× | — | 412 | —× |
|  | cudaweb 錯誤：Windows GPU 裝置遺失（DXGI_ERROR_DEVICE_HUNG，逾時重置）；單次提交的步驟超過 GPU 看門狗時限。未重試，避免驅動再次掛起。 |||||||||

## 解釋（屋頂線 vs 實測）
- 固定開銷（由最小規模推得）：約 32.3 ms／步（上界：實測減去屋頂線）。這包含每步一次提交、兩次讀回與 JS 端的組裝。
- 有效 GFLOP/s：cudaweb 由兩個最大規模的斜率推得約 2.2 GFLOP/s；cpu-py 由最大規模推得約 21.8 GFLOP/s。
- 屋頂線峰值為 0.3 TFLOPS，遠高於上面兩個實測速率；差距不能只靠固定開銷解釋，還有隨規模增長的成本（JS 陣列轉換、每步派發數、頻寬使用效率）。這些成本的各自佔比尚未拆解（見 P1b）。

## 交叉點（模型大到多少 cudaweb 才開始贏 cpu-py）
- 實測：實測斜率比 cpu-py 平緩：交叉點不存在（cudaweb 永遠較慢）。
- 若 cudaweb 達到屋頂線（0.3 TFLOPS），交叉點約每步 FLOPs 7.58e+8。（以實測固定開銷推算；假設固定開銷不隨規模增長。）

## 原始 JSON
```json
{
 "gpu": {
  "adapter": {
   "info": {
    "vendor": "nvidia",
    "architecture": "kepler",
    "device": "",
    "description": ""
   },
   "features": [
    "depth32float-stencil8",
    "rg11b10ufloat-renderable",
    "bgra8unorm-storage",
    "texture-formats-tier1",
    "texture-compression-bc",
    "dual-source-blending",
    "core-features-and-limits",
    "float32-filterable",
    "indirect-first-instance",
    "float32-blendable",
    "depth-clip-control",
    "texture-compression-bc-sliced-3d",
    "clip-distances",
    "timestamp-query",
    "primitive-index",
    "texture-component-swizzle",
    "subgroups"
   ],
   "maxStorageBufferBindingSize": 2147483644,
   "maxBufferSize": 2147483648,
   "maxComputeWorkgroupStorageSize": 32768
  },
  "sizes": [
   {
    "size": "S",
    "msMedian": 32.3,
    "msFirst": 583.5,
    "error": null
   },
   {
    "size": "M",
    "msMedian": 294.6,
    "msFirst": 340,
    "error": null
   },
   {
    "size": "L",
    "msMedian": 1263.3,
    "msFirst": 1367.4,
    "error": null
   },
   {
    "size": "XL",
    "error": "Windows GPU 裝置遺失（DXGI_ERROR_DEVICE_HUNG，逾時重置）；單次提交的步驟超過 GPU 看門狗時限。未重試，避免驅動再次掛起。"
   }
  ]
 },
 "cpu": {
  "sizes": [
   {
    "size": "S",
    "msMedian": 15.37,
    "msFirst": 20.95,
    "error": null
   },
   {
    "size": "M",
    "msMedian": 50.87,
    "msFirst": 59.44,
    "error": null
   },
   {
    "size": "L",
    "msMedian": 110.85,
    "msFirst": 130.89,
    "error": null
   },
   {
    "size": "XL",
    "msMedian": 622.04,
    "msFirst": 638.53,
    "error": null
   }
  ]
 }
}
```
