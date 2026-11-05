SDXS 原生對網頁版逐階段比對（見 DESIGN.native-all-models.md 9.8）。需要本機已有 SDXS int8 三個檔（不下載）。
- native_stages.js：原生端（ELECTRON_RUN_AS_NODE=1），環境變數 NAB_ORT、MODELS、OUT、SD（imagegen/local_sd.js）、IDS（CLIP token 編號，逗號）、SEED、THREADS、GOPT。
- wasm_stages.eval.js ＋ run_wasm_stages.js：真 Electron（埠 17960 以上、獨立 user-data-dir）跑網頁版同設定並比對。
- run_pair.sh：一組提示詞兩邊各跑一次（路徑寫死成作者的暫存資料夾，使用前改 S／MD）。mkpng.js：合成 PNG。cmp.js：比較兩個輸出資料夾。
- 提示詞用手動組的 CLIP 編號（沒有下載分詞器）：cat＝49406,320,1125,539,320,2368,49407；beach 把 2368 換成 2117。
