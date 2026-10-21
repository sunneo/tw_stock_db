# vendor-models

預先釘版、切片的模型檔，給桌面版與網頁版的離線翻譯（中文↔英文）與語意檢索（文字轉向量：單元目錄的語意檢索、Knowledge Inventory）使用。**只有一個目的：版本固定、不依賴外部服務。**

| 目錄 | 來源（Hugging Face） | 版本（revision） | 授權 |
|---|---|---|---|
| vendor/opus-mt-zh-en | Xenova/opus-mt-zh-en（Helsinki-NLP/opus-mt-zh-en 的 ONNX 轉檔，量化 q8） | 39d480d52a9ea3065a1f117adfe4dbc55de10e6f | CC-BY-4.0 |
| vendor/opus-mt-en-zh | Xenova/opus-mt-en-zh（Helsinki-NLP/opus-mt-en-zh 的 ONNX 轉檔，量化 q8） | 046f55aec303cdee3e0318604406d4df20f1e8ea | Apache-2.0 |
| vendor/multilingual-e5-small | Xenova/multilingual-e5-small（intfloat/multilingual-e5-small 的 ONNX 轉檔，量化 q8，384 維語意向量） | 761b726dd34fb83930e26aab4e9ac3899aa1fa78 | MIT |

原始模型：Helsinki-NLP（翻譯）、intfloat（multilingual-e5-small，MIT 授權：Wang et al., Multilingual E5 Text Embeddings）。翻譯模型的原始來源：Helsinki-NLP（OPUS-MT 專案，University of Helsinki）。授權依各模型（見上表）：CC-BY-4.0 與 Apache-2.0 都允許使用、轉換、再散布，需標示來源與授權（本檔與 manifest.json 即為標示）。ONNX 轉換：Xenova（Hugging Face）。

## 檔案怎麼放
- 大檔案（>40MB，量化後的 encoder／decoder）切成 40MB 一片：`<檔名>.part000`、`.part001`…，依序接起來就是原檔。
- 小檔案（設定、分詞器）原樣放。
- `vendor/manifest.json` 列出每個檔案與每一片的大小與 sha256。**接起來之後一定要核對 sha256**。
- 這個分支永遠只有一個提交（跟 db-snapshot 同一種慣例：整個重建、強制推送）；程式用「提交的完整 SHA」取檔，內容不可變。

## 手動合併
```
cat encoder_model_quantized.onnx.part* > encoder_model_quantized.onnx
sha256sum encoder_model_quantized.onnx   # 對照 manifest.json
```
