# 遊戲 ROM 音樂擷取（音樂庫的一部分）設計與待辦（2026-11-22）

狀態：設計與待辦，尚未實作（RIX 與 Flash 已派工，見音樂庫文件）。上層需求與進度表見 `DESIGN.TODO.music-library.md`。

## 使用者原話（逐字，2026-11-22）

- 「可以掃遊戲檔案如nes rom, pce rom , sfc rom, 或早期的RIX格式音樂, macromedia flash的檔案」
- 「rom extract mp3, midi再來辨識  這樣比較可以重複使用」
- 「應該這些rom都有現成的emulator project, 例如fceux」
- 「我沒有要跑現成built好的模擬器  是要再electron環境中可以這樣跑起來」
- 「所以意思是只把rom載入到聲音模擬器做出來  就像nes有nsf吧」
- 「我偏好是做出nes->nsf on wasm」
- 「sfc: https://github.com/blarggs-audio-libraries/snes_spc」
- 「我不接受subsession自己改題目或選擇什麼不做」
- 「做完才可以停下來    之後用會主動回應的terminal跑publish」

樣本目錄（唯讀、不進 repo，ROM 有版權）：FC `D:\emu\Roms\FC roms`、PCE `D:\emu\Roms\pce`、SFC `D:\emu\Roms\SFC roms`、RIX `D:\Downloads\SOFTSTAR.tar\SOFTSTAR\SOFTSTAR\PAL\86RIX`。

## 原則

1. 擷取器是獨立轉換器：輸入 ROM／音樂檔，輸出標準 MIDI 與 wav／mp3 衍生檔，在曲庫登記成「來源檔的子曲目」（來源路徑、第幾首、擷取方式）；衍生檔存在使用者可設定的資料夾，不進 repo；來源沒變就不重做。
2. 辨識端（檔名搜尋、歌詞、哼歌旋律索引、批次輸出）只看到普通 mid／mp3，不做任何平台特例。
3. 模擬器必須在 Electron 頁面（Web Worker 或 wasm）內自己跑，不呼叫使用者電腦上的 exe。
4. 授權：產品是 MIT。GPL 核心不能隨附；LGPL 只能以可分離的 wasm 檔載入並附原始碼與替換說明（使用者已選定 `snes_spc`，視為接受 LGPL 以此方式使用）。
5. 做不到的遊戲（抽不出播放入口、相容性不足）要明確標示原因，不假裝成功。

## 為什麼不是「直接把 ROM 丟給聲音模擬器」

NSF、SPC、HES 是別人整理好的音樂包（含初始化位址、播放位址、曲目編號與音樂資料）；ROM 只有整個遊戲，沒有人告訴你音樂程式在哪、有幾首、怎麼叫第幾首。所以 ROM 要先得到「可以只跑聲音那一半」的東西，這一步每個平台做法不同。

## 平台做法

- **RIX、Flash**：不需要模擬器，直接解析（RIX 是 OPL 暫存器序列；SWF 抽 DefineSound／SoundStreamBlock 的音訊與內嵌 MIDI）。已派工。
- **NES → NSF（使用者偏好，跑在 wasm／JS）**：用 jsnes（Apache-2.0）在 Worker 跑 ROM，於 APU 寫入處加掛鉤；觀察每次 NMI 時哪個副程式在寫聲音暫存器，推出播放入口（PLAY），並找初始化入口（INIT）與資料範圍，打包成 NSF；抽不出入口的遊戲標「無法抽出播放入口」並退回「錄開機後播放的音樂」（記錄暫存器寫入轉 MIDI）。NSF 做出來後交給 Game_Music_Emu 或自己的 APU 渲染成 wav／mp3，並轉 MIDI。
- **SFC**：用 `snes_spc`（blargg，LGPL）當 SPC700＋DSP。ROM 沒有 .spc：用 SnesJs（MIT）的主 CPU 跑 ROM，監看對 `$2140-$2143` 的寫入，偵測聲音程式上傳完成時傾印 SPC700 的 64KB、DSP 128 個暫存器與 SPC700 暫存器，組成 .spc 再交給 `snes_spc` 渲染。多數遊戲每首換不同資料，需要在多個時間點傾印。
- **PCE**：沒有成熟的 MIT 核心；以 jspce（MIT）為基礎驗證其 PSG，不夠就自寫 HuC6280＋PSG（PSG 只有六聲道，規格單純）。同樣做法：記錄暫存器寫入，轉 MIDI 與 wav。
- **第二層（最完整）**：使用者已有的 NSF、SPC、HES 檔，直接用聲音模擬器（Game_Music_Emu，LGPL，需先確認以可分離 wasm 載入的做法）逐首輸出；列得出全部曲目。

## 調查摘要（子代理只讀網頁，**未逐項核實、未實測**；GPL 排除項：snes9x 僅限非商業、bsnes、fceumm、nestopia、Mesen、Beetle PCE）

- NES：jsnes（Apache-2.0，純 JS，仍維護，可取音訊取樣，暫存器掛鉤要自己加）；NesJs（MIT，已封存）。
- PCE：jspce（MIT，聲音是否實作未驗證）。
- SNES：SnesJs（MIT，純 JS，已封存）；LakeSnes（MIT，C，需自編 wasm，已封存）；`snes_spc`（LGPL-2.1，授權為憑記憶，需複核）。
- 通用：Game_Music_Emu（LGPL-2.1；啟用 MAME YM2612 會變 GPL，要關掉；官方無 wasm 版，第三方 wasm 已停更；吃音樂檔不吃 ROM）。

## 待辦（依序，做完一段才下一段；每段完成都要核對、真桌面版評測、發布）

1. RIX 與 Flash 擷取（進行中）。
2. 擷取骨架：擷取器介面、子曲目登記、衍生檔資料夾設定、面板「擷取」按鈕與進度（RIX／Flash 已先做出第一版，之後各平台沿用）。
3. NES → NSF（jsnes＋APU 掛鉤＋入口推導＋NSF 打包），用 `D:\emu\Roms\FC roms` 評測：報出成功抽出入口的 ROM 數與失敗原因。
4. 第二層：NSF／SPC／HES 直接播放與逐首輸出（先確認 Game_Music_Emu 與 `snes_spc` 以可分離 wasm 載入的做法與授權文件）。
5. SFC：SnesJs 跑 ROM＋傾印 SPC＋`snes_spc` 渲染，用 `D:\emu\Roms\SFC roms` 評測。
6. PCE：jspce 或自寫 PSG，用 `D:\emu\Roms\pce` 評測。
7. YouTube 清單：接既有 `youtube_download`，播放清單能否一次多支先確認。
8. 歌詞真轉錄的真機驗證（目前只驗過 1 秒靜音）。

## 已知風險

- 不同遊戲的聲音驅動差異大，NES→NSF 的入口推導不保證全自動；要用樣本目錄實測成功率並如實回報。
- SnesJs、jspce 是個人專案，ROM 相容性與音效時序要實測。
- 擷取很吃時間，要背景進行、可暫停續跑、可取消，失敗附階段與原因；不設人為上限（遊戲數量、單首長度）。

## 晶片音樂播放器（使用者 2026-11-22 追加，待辦）

使用者原話：「還是我們也有辦法做出rix播放器, spc, nsf 播放器?」「讓播放器可以支援重播，seek, goto , 像是midi播放器介面, 加上匯出mp3, midi」

做法：
- 一個共用的晶片音樂播放器介面：`load(來源) → 曲目列表`、`render(曲目, 起點秒, 長度秒) → PCM`、`durationSec`、`seek(秒)`；後端各一：RIX（OPL2 模擬）、NSF（NES APU，jsnes 的 APU 或自寫渲染）、SPC（`snes_spc`，LGPL，以可分離 wasm 載入）、之後 PCE（PSG）。
- 控制介面重用既有 MIDI 播放卡片的元件（`renderer/src/music/midi_ui.js`、`midi_play.js`）：播放、暫停、重播、進度條 seek、goto（輸入時間或曲目編號）、曲目清單與上一首／下一首。
- 晶片不能任意跳轉：seek 用「靜音快速模擬到那個時間點」再開始出聲；曲目很長時用分段快取。
- 匯出：mp3（重用批次輸出的 mp3 編碼與一分鐘預設、可指定分鐘數）與 MIDI（沿用各格式的擷取結果：RIX 與 NES 的暫存器寫入轉 MIDI、SPC 的 DSP 事件轉 MIDI；轉不出來要明確說明原因）。
- RIX 目前是「轉 MIDI 再用 GM 音色合成」，音色是近似；真正的 OPL2 模擬才是原曲音色，列為這個播放器的第一個後端。

## YouTube 清單（使用者原話：「可以加youtube list(if possible)」）調查事實（2026-11-22，讀程式）

- 既有工具 `youtube_download`（`renderer/src/floating-assistant.js` 約 93216 行）只吃影片連結或影片 ID（`_youtubeExtractVideoIds`），**不認播放清單**，不會把一個清單展開成多支影片。
- 它有**範圍限制**：設定了「YouTube Data API 金鑰」與「我的 YouTube 頻道 ID」時，只允許自己頻道的影片或授權欄位標示 Creative Commons 的影片；沒設定這兩個欄位會跳過驗證、直接放行（回傳 `verification_skipped: true`，要提醒使用者）。音樂庫接它時**不能繞過這個限制**，要沿用同一個驗證與回報。
- 只能下載 progressive 格式（沙盒沒有 ffmpeg 合併）；底層是 Pyodide 跑的 yt-dlp。
- 待辦：播放清單展開（yt-dlp 的 flat-playlist 或 Data API 的 playlistItems，擇一並寫明）、展開後逐支走既有驗證與下載、下載完登記成曲目（來源記為 YouTube 清單）；清單很大時背景進行、可暫停續跑。
