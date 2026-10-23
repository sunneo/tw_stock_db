<!-- 從 TODO.md 拆出（2026-10-23）：內容原封不動，只是改成一份一個主題。 -->

# TODO：本機 `/edge-tts` 的 Sec-MS-GEC v2 簽章（先放著，目前夠用）

2026-10-14 評估：本機 proxy 的 `/edge-tts`（`edge-tts.js`）路由、驗證、CORS 都在，但實際合成會被 Microsoft 擋（握手 **403**）。
同一台機器上最新的參考函式庫 `edge-tts 7.3.1` 能合成，差別是協定改了：

- [ ] `Sec-MS-GEC-Version` 現在是 `2-143.0.3650.75`（我們送 `1-…`）。
- [ ] `Sec-MS-GEC` 改成 v2：`<16 hex>-<64 hex>`，由自訂的 SHA-256＋CS64 雜湊算出（參考 `edge_tts/drm.py` 的 `generate_sec_ms_gec_v2`，約 250 行）。移植後用 Python 在固定時間戳下的輸出當測試向量驗證。
- [ ] 403 時用回應的 `Date` 標頭校正時鐘差再重試一次（`DRM.handle_client_response_error`）。
- [ ] `edge-tts.js` 單元測試（簽章測試向量、驗證、錯誤路徑）。
- [ ] 授權：參考實作是 LGPL-3.0，直接移植要補 `THIRD-PARTY-NOTICES.md`，需先決定能不能接受。
- [ ] 使用者那份 Cloudflare `worker.js` 用的也是舊的 v1 公式，之後可能一樣失效（不在這個 repo）。

目前的替代：離線 Kokoro 中文語音已加上（使用者自己加的），線上中文語音失敗時會退到它，所以不急。
安裝版若根路徑回 404，多半是 9/21（`b903975d`）之前沒有 `/edge-tts` 路由的舊版；本機 proxy 的埠是隨機的，repo 裡沒有 `41877`。
