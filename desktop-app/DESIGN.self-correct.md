# 自我糾正：領域委派與斜線指令不得放棄

使用者的要求：所有工具呼叫（尤其指派領域後、斜線指令涵蓋的）出錯都要能自我糾正；回合不夠要請使用者延展（`extend_rounds`，見 DESIGN.extend-rounds.md），不得丟一段空話當「最終回覆」。

## 2026-11-12 事故
`/media-presentation <文章網址> 圖文並茂…2分鐘，請讀給我聽`：模型讀完網頁只用文字說「已完成」，沒呼叫 render_presentation；程式後備因為任務帶網址／附件就放棄 → 使用者什麼都沒拿到。簡報本來就跟附件無關。

## 通用機制（`_delegateToSubagentDomainInner`）
1. 有「完成判準」的領域（`FA_DOMAIN_PRODUCES`）：模型說完成但沒有任何成功的產物工具呼叫 → 帶**具體糾正訊息**（缺什麼、用哪個工具、上次呼叫的錯誤原文）重來，最多 2 次。
2. 仍沒有 → 誠實失敗（附最後一次錯誤、建議補什麼／`/rounds`），模型的空話放在 `model_said`，不當成果。
3. 結尾是問句（向使用者釐清）不算放棄。
4. 回合用完 → 既有 `extend_rounds` 卡片。
5. 工具參數錯誤的原文本來就回饋給模型（工具結果）；文字 JSON 工具呼叫由程式還原執行（既有）。

## 簡報（已有專屬流程，且與附件無關）
模型沒做出簡報 → 程式救回文字參數 → 程式自己組（食譜）。**不看有沒有附件／網址**：有網址就先抓網頁當素材（`_deckUrlBrief`）。只有連要講什麼都沒說才請使用者補素材。需求解析：`圖文並茂／配圖`＝找照片、`N分鐘`＝頁數（約 22 秒一頁）、`讀給我聽`＝旁白。

## 盤點表
| 領域／指令 | 完成判準 | 失敗時 |
|---|---|---|
| 簡報（/media-presentation） | visual 產物 | 救回 → 程式食譜 → 重來 → 誠實失敗 |
| scene_3d、/image-to-3d | render_3d_scene／image_to_3d／import_3d_model_attachment 成功 | 糾正×2 → 誠實失敗 |
| animation_2d | render_2d_animation／import | 同上 |
| interactive_component | render_interactive_viewer／import | 同上 |
| translate | translate_text 成功 | 同上 |
| worksheet | worksheet_make／topic／open | 同上 |
| drawing | render_drawing／render_uml_diagram／images_to_pdf | 同上 |
| image（畫／生成類任務） | generate_image／render_drawing／render_uml_diagram 成功（軟判準，依任務文字） | 糾正×2 → 回覆後加警告（不判失敗，因為可能判錯） |
| music（作曲／轉 midi／拆軌） | midi_compose*／audio_to_midi／soundtrack_make／music_topic／midi_to_mp3 成功（軟） | 同上 |
| coding（寫／修／優化／轉換） | write_code／fix_code／optimize_code／convert_code／merge_patch／uml_to_code／fap 寫檔工具成功（軟） | 同上 |
| editors（剪／合併／字幕／配音／轉 3D） | video_*／image_to_3d／edit_*_open 成功（軟） | 同上 |
| file_analysis、browser_*、research、knowledge、computer_use、git、mcp、browser_search… | **查詢／操作類：答案本身就是成果**，沒有單一產物工具；失敗靠既有的工具錯誤回饋＋延展回合＋重複呼叫攔截。若之後有事故（模型只說做完、實際沒做），依事故逐項加判準 | 既有機制 |

## 測試
`scripts/self-correct/domain_produces.test.js`（判準、糾正訊息、接線）、`scripts/deck-tests/deck_url_wiring.test.js`、`scripts/deck-tests/deck_topic.test.js`。
