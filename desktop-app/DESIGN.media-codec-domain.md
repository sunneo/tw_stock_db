# 影音壓縮領域（H.264／有損聲音／有損影像）：進度與接手

範圍與階段表見 `DESIGN.blockly-curriculum.md` §5。本文件記錄實際做到哪裡、量到的數字、缺口與接續點。

## 1. 目前狀態（2026-11-11）

| 階段 | 內容 | 狀態 |
|---|---|---|
| 0 設計 | `DESIGN.blockly-curriculum.md` §5（提交 `33e4c0f5b`） | 完成 |
| 1 位元級基礎 `domain_avbits` | Exp-Golomb、NAL 切分、防競爭位元組、RBSP 尾位元、SPS／PPS／slice header | 起手檔已在；**測試能跑，train 12/16、holdout 4/7，未通過** |
| 2 H.264 I 幀解碼 `domain_h264dec` | 逆變換、反量化、Intra 預測、CAVLC、去區塊 | 未開始 |
| 3 H.264 編碼與 P／B／CABAC | 整數正變換、量化、運動搜尋與補償、CABAC、B 幀 | 未開始 |
| 4 有損聲音 `domain_avaudio` | MDCT、量化、簡化心理聲學 | 未開始 |
| 5 有損影像 `domain_avimage` | 8×8 DCT、量化、Z 字形、熵編碼、Haar／5/3 小波 | 未開始 |

本次只完成階段 1 的「能跑」驗證，沒有修改任何程式檔，沒有改動判題器或讀取器。

## 2. 實測數字（階段 1，`domain_avbits.test.js`）

執行方式（Linux）：

```bash
FA_TS_DIR=<含 tree-sitter.js、tree-sitter.wasm、tree-sitter-python.wasm 的資料夾> FA_PYTHON=python3.13 nice -n 10 taskset -c 8-9 node renderer/src/uml/domain_avbits.test.js
```

- 參考解與 ffprobe 的寬高／level 交叉驗證通過（`avbits` 種子檔內的 SPS 檢查）。
- train：12/16 由指定範式解出（選項反序同為 12/16）。
- holdout（只量測）：4/7 解出。
- 未解的 train 題（4 題，原敘述與反序皆失敗）：
  - `eg-enc-se`：輸入 se(v) 編碼的整數串。讀取器回報「沒有配方」，原因未查（可能是 `av-eg-encode` 的 `算 se` 敘述缺 `se(v)` 對應詞）。
  - `slice-hdr`：讀取 slice header，回報「沒有配方」，`av-slice-header` 的 regex 要求「解析」，題目用「請解析」應可命中，需要查是哪條 algo 搶先。
  - `sps-write`、`pps-write`：寫出類題目，回報「沒有配方」，需要用 `DBG=1` 看判題器的 detail。
- holdout 未解：`ho-eg-enc`、`ho-pps`、`ho-sps-write`。

這些是讀取器（`algo_intent_core.js` 的配方比對）與範式的問題，不是位元運算本身的錯；尚未確認根因，**不能宣稱階段 1 完成**。

根因查證（`DBG=1 ONLY=eg-enc-se,sps-write`，2026-11-11）：
- `eg-enc-se`：`av-eg-encode` 的 regex 與否決詞對這段敘述實測都通過（`ALL` 兩段皆命中，否決詞不命中），但回報的 rounds 只有 `matrix`、沒有任何範式被嘗試，代表配方在更前面的讀取步驟（CNL 或 algo 挑選）就被丟掉。讀取器的 CNL 只剩 `讀入一行整數成清單 a`，與 `eg-enc-ue` 同樣的輸入形狀，差別在敘述裡的 `se(v)` 與括號後的 `ue(v)`，待查。
- `sps-write`：讀成 `程式：s = input()`（單行字串），範式嘗試 9 次，但判題器沒有被呼叫（沒有 `DBGJ` 輸出），代表候選程式在進判題前就被剔除；原因待查（推測是輸入形狀與骨架的 `numIn` 判斷不合）。
- 修法會動到共用的 `algo_intent_core.js`，其他工作階段（blockly、matrix、ir）也依賴它；**本次未改，等管理者決定**（見 §6）。

## 3. 環境與坑（重要，接手前先看）

1. **tree-sitter 快取**：`FA_TS_DIR` 不設或找不到時，`domain_harness.js` 會印「略過」並以 0 結束，這會假通過。接手時先確認輸出有「train N/M」那一行，不能只看結束碼。本機可用的一組匹配檔是倉庫內 `renderer/vendor/tree-sitter/`（`tree-sitter.js`、`tree-sitter.wasm`、`tree-sitter-python.wasm`）；把三個檔複製到一個資料夾再設 `FA_TS_DIR`。**混用不同版本會出現 `unknown section code #0x13`**（本次踩過：VS Code 擴充的 wasm 配上倉庫的 js 會失敗）。
2. **Python**：預設 `python3` 在此機器沒有 numpy／scipy／Pillow；`python3.13` 也沒有 numpy。參考解目前只用標準庫。需要 numpy 時要先確認環境，不要下載。
3. **ffmpeg**：`/usr/bin/ffmpeg` 有 `libx264`、`aac`、`libmp3lame`；`ffprobe` 可用。種子題的期望輸出應在出題時由 ffmpeg 算好、寫進種子檔，判題時不依賴 ffmpeg。
4. **分支**：本工作樹原本指向 `f8089636`（分支 `claude/media-codec-domain-bdfe56`）。中途誤以 `git reset --hard desktop-app` 移動過，已還原回 `f8089636`。工作改在新分支 `media-codec-domain-h264`（起點 `desktop-app` 的 `63ee38e6`）。
5. 清理暫存檔時不要用含未檢查變數的 `rm -f $S/*`，安全檢查會擋下（本次被擋）；用 `cp` 覆蓋即可。

## 4. 缺口清單（誠實）

- 階段 1：train 4 題未解、holdout 3 題未解，原因未查明。
- 階段 2 至 5：全部未開始。
- CABAC、B 幀、多參考幀、加權預測、多 slice、FMO：列為最後階段，未開始；做不完時在此寫具體阻礙，不寫成「不做」。
- 整幀端對端測試（16×16 至 64×64）：未做。
- 有損聲音與影像的 PSNR、SSIM、位元率曲線：未做。

## 5. 接續點（依序）

1. 查出階段 1 四題 train 未解的根因（先跑 `DBG=1` 看 detail；確認是讀取器配方比對還是判題器輸出不符），修到 train 16/16，holdout 另量測、不為它改教法。
2. 階段 2：先寫 `domain_h264dec` 的單元種子（4×4 逆變換、反量化表），每個子元件一題，用 ffmpeg 解出的 yuv 當真值。
3. 階段 3、4、5 依序，每階段完成後在本節更新數字並提交。

## 6. 接手

- 本次交接時間：2026-11-11。
- 提交訊息需結尾 `Co-Authored-By: Claude Haiku 5.5 <noreply@anthropic.com>`（依最新指示）。
- 未推送、未發布、未執行 `embed-code-ui.js`／`build-assistant.js`。`domain_avbits` 尚未登記進 `scripts/embed-code-ui.js`、`floating-assistant.js` 標記與 `scripts/run-core-tests.js`，需要管理者統一嵌入時一併登記。
