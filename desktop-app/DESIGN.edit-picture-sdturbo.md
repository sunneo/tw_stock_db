# sd-turbo 整合進 /edit-picture：查證結果（2026-10-30）

## 模型檔（Hugging Face，已用介面查到位元組數）
- 官方 stabilityai/sd-turbo：只有 safetensors（unet fp16 1.73 GB、文字編碼器 fp16 681 MB、VAE fp16 167 MB），沒有 ONNX，不門控。
- jdp8/sd-turbo-onnx（一般 ONNX 匯出，無授權標示）：text_encoder 681552894、unet 1737702391、vae_decoder 99129787、vae_encoder 136760235 位元組；含 tokenizer。**有 VAE 編碼器**。權重是 fp16 大小（unet 1.7 GB）。
- tlwu/sd-turbo-onnxruntime：Olive 最佳化給 CUDA（說明寫「不能跑在 CPU 等其他後端」），**不能用**。
- 沒有 onnx-community／Xenova 的 sd-turbo。

## 授權
- 官方模型卡指向 Stability AI 社群授權（2024-07-05）：研究與非商業免費；商業用途須向 Stability AI 登記，且年營收超過 100 萬美元即失效、須另談。tlwu 版標示 sai-nc-community（非商業）。
- 結論：**不內建、不代下載**。做成「使用者自己下載」：設定頁顯示授權與連結，使用者按下載才從 Hugging Face 取得（沿用 FaLocalSd 的分檔下載，核對大小）。

## 執行環境（部分未驗證）
- WebGPU：fp16 的 unet 配合 shader-f16 應可跑（SDXS 的 fp16 GPU 版已是同做法）。jdp8 匯出的運算子是否全被 onnxruntime-web WebGPU 支援：**未驗證**，要實機跑。
- wasm／CPU：onnxruntime-web 的 CPU 後端對 fp16 支援很有限；fp32 的 unet 約 3.5 GB，超過 wasm 的 4 GB 記憶體上限，實務上跑不了。需要自己量化成 int8（約 0.9 GB）才可能，**目前沒有現成檔案，未驗證**。
- 因此 CPU 降級的做法：模型清單用「每個版本一筆」設計；wasm 沒有可用的 sd-turbo 版本時，明確說明並降級用 SDXS（VAE 同為 4 通道 SD 系，一步取樣，已內建下載），SDXS 的圖生圖共用同一套數學（只換起始雜訊強度對應）。

## 圖生圖數學（兩者共用）
- 圖縮放到 512（8 的倍數）→ VAE 編碼取平均 → ×0.18215 → 依 strength 取起始時間點加噪 → 1～4 步 → VAE 解碼 → 以遮罩羽化蓋回原圖。
