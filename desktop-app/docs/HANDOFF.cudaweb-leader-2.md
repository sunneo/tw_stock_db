# 交接：cudaweb 領導（第二任）

寫於 2026-11-18。接手者先讀這份，再讀 `docs/CHECKLIST.cudaweb-optimize.md`（含末尾「剩餘項目」段）與 `docs/HANDOFF.cudaweb-optimize.md`。

## 使用者的原話（逐字，不要轉述）

- 「繼續，直到完成，可以嗎」
- 「這本來數小時前就該持續完成 現在又是不停地問」
- 「請不要再提問」
- 「同意下載，每個階段修改都請commit, push, publish 做完才可以停止」
- 「請直接接續實現，同意下載，不過我這台沒有E:\，請用C:\Users\hungfu.lee\Downloads\SRC\tw_stock_db\ai-temp」
- 「運算變體的分頁應該也是屬於GPU相容層的」（已改完，見下）
- 「你沒有盡到主動把它喚醒」「我剛講完你才跑，這很明顯是錯的!」：使用者多次被迫中斷。**不要等使用者催；每個 session 回報完立刻檢查、推送、發布，並送出下一步。**
- 「現在不是remote」：工具曾把使用者判成 Remote Control 而拒絕開 session；使用者糾正後可以開。被拒時要在使用者說之前自己重試，不要把工具的判斷當成事實轉述。

## 工作方式（已驗證可行）

1. 子 session 用 `mcp__ccd_session__start_session`（`user_asked`、`context: fresh`、`use_worktree: false`、`wake_when_done: true`、Haiku 5.5 effort high；領導是 Opus 5.5 時改 Sonnet 5.5 medium）。後續任務用 `SendMessage`，**`to` 必須用 `local_…` session id，名稱會找不到**。
2. 每個 session 只提交（`git commit --author="IceCold Sunneo <sunneo@users.noreply.github.com>" -- <pathspec>`），不 push、不跑 `scripts/publish.sh`（含 dry-run）、不問使用者。推送與發布只由領導做。
3. 領導每批：`git checkout -- desktop-app/judge-core.js`（別的 session 只改了換行，會讓發布腳本拒絕），`git push origin desktop-app`，`PUBLISH_TRAILER="Co-Authored-By: …" scripts/publish.sh -m "…"`，確認輸出「版本 N，檢查碼都對」。目前最新版 464。`PATCH_VERSION` 由腳本維護，不要手改。
4. 每個子 session 都要在清單如實更新：驗收沒全達成就不勾，沒驗證的明寫。
5. 子 session 只依使用者在**它自己的對話**裡的指示行事，會拒絕「領導轉述使用者同意」。需要下載時，由領導用使用者對領導的授權自己下載到 `ai-temp\`（不進 git），再把現成檔案路徑與 sha256 告訴子 session。

## 這台機器的事實（重要更正）

- 真 Chrome（claude-in-chrome 工具，本機靜態伺服器 `python -X utf8 -m http.server 8765 --bind 127.0.0.1`，根目錄 `desktop-app`）有 WebGPU：**Intel Xe-LPG，shader-f16 可用、subgroups 可用**，caps 分級 mid，maxWorkgroupStorage 32768。先前「這台無 f16、無法真機驗證」是錯的。
- 內建瀏覽器（`mcp__Claude_Browser__*`）**沒有 WebGPU**，不能用來跑驗證頁。
- 驗證頁一次只跑一個形狀，避免 Chrome 凍結。結果寫進 `scripts/eval/cudaweb_optimize.result.json`（intel 區段）。
- 假裝置測試抓不到 WGSL 綁定錯誤（O8 曾因 `attn_bwd_kv` 宣告未使用的綁定，真 GPU 上整個提交被拒、輸出全 0）。**每個新核心都要在真 Chrome 跑過才算驗證。**
- 無 CUDA。網頁版 repo（`..\videos-嗨投資`）這台找不到，`publish.sh` 的網頁版步驟每次都跳過；要更新網頁版需要使用者提供 repo 位置（用 `WEB_REPO` 指定）。

## 已完成並已發布（版本 451–464）

O13b SmolVLM 視覺與語言解碼 CPU／GPU 真權重對拍；O14c／O14d 自訂核心樣板；離線不設耗時上限；aidoc ask 走聊天核心；O13a LLaVA 骨架與 SigLIP／Qwen2 對拍；O13c Florence-2 部分子圖；O15a 覆蓋表；O15b MoveNet、Depth Anything、SlimSAM 的 WebGPU 路徑（預設關）；O7 融合核心；O8 融合 AdamW、整步一次提交（修綁定錯誤）；O9 競賽引擎合一、快取合一、設定窗格（已在 GPU 相容層 `gpu-compat` 內）；O10 結果檔；O12 描述表與覆寫登記表；matmul 子群組、split-K 進規則表；O1m 貼圖與 uniform 量過不採用。

## 進行中（交接時）

- `o10` = `local_65969161-25e1-4368-bae4-63b736dbf0ee`：R5 剩餘（MatMulNBits、注意力、卷積、訓練轉置）、R2 軟體預取、O11 建置、清單「剩餘項目」段。
- `o15b` = `local_09b387c4-988c-455d-8e8f-746258343523`：SlimSAM 4.2.0 shader 失敗已修（端到端 IoU 0.968，`samGpuLib` 預設關）；已找到並修正「先跑過 CPU 後 GPU 偏好靜默退回 CPU」的 bug。下一步看覆蓋表選下個模型。
- 已閒置、可再派工：`o6` = `local_69bfe21f-251a-4a5a-ab27-cb01017f6bcc`（O12，Llama 3.2 1B q8 ONNX 的 CPU 參考與 GPU 引擎第二步起與 ORT 差約 1 個 logit，根因未查，需 ORT 中間張量）；`o8` = `local_17abaa2c-6255-4e91-877d-4b1a5b82bc77`；`o13b` = `local_7af0400f-af3f-4c2a-bf3c-cc1992a24c84`；`o9int` = `local_d1080b2f-a900-46ce-abb2-8d5db72c7954`。

## 尚未完成（依清單，細節看清單本身）

- O12b／O12c／O12d：Llama 1B 對 ORT 第二步差異；通用骨架接成 qwen_gpu 備援。
- O13a／O13c：SigLIP 其餘層、語言模型逐層、DaViT stage 1、q8 路徑（SmolVLM q8 沒過：視覺相對 RMS 2.8%）。
- O14a／O14b：入口盤點與舊樸素核心入口全改走優化路徑。
- O15b：其餘模型（Whisper 編碼器、SDXS、Kokoro 整圖 GPU 對拍等）逐一實測；Kokoro、e5、翻譯寫死 wasm 且沒有對拍證據。
- O8：整步 f32 路徑 20 步 loss 誤差比舊路徑大約 1.6 倍（1.85e-6 對 1.15e-6，都在 f32 雜訊量級），維持未勾；速度約快 28 倍。是否預設開由使用者決定，**不要擅自改預設**。
- O9：驗收尚缺；O11：真 GPU 的 `bench_run` 沒驗證。

## 清單之外、仍欠的事

- LoRA 全量訓練（4141 筆，CPU 約 9–10 小時一個 epoch）沒跑；除工具路由外沒有留出資料評估；`nr-engine.js` 的 `generate` 缺 `prefill`；App 內自動下載 LoRA（`DESIGN.lora-training.md` §10）沒實作；`/offline-training-studio` 只有設計書 `DESIGN.TODO.offline-training-studio.md`。
- 網頁版 repo 位置。

## 規矩（不要違反）

- 檔案與歷史中不得出現舊產品名（redmine）。
- 絕不 `pip install` 到全域 Python（用 `lora-train/.venv`）。
- commit 作者一律 `--author="IceCold Sunneo <sunneo@users.noreply.github.com>"`，不改 git config。
- 不要重新凍結互換版（`live-patch-compat`）；一律走 `publish.sh`，不手組 patch、不手寫版號。
- 下載只放 `C:\Users\hungfu.lee\Downloads\SRC\tw_stock_db\ai-temp`，單檔大致 <3GB、驗 sha256、不進 git。
- 子 session 回報的結論是它的說法，推送前用 `git log`／測試輸出核對；沒驗證的不要在對使用者的回報裡說成完成。
