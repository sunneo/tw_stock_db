# 重複呼叫盤點（AUDIT.repeat-calls）

日期：2026-11-28。範圍：`renderer/src/floating-assistant.js`（桌面版與網頁版共用）。
目的：「模型不停重複呼叫同一個工具」這一類問題，全面盤點，不再逐案處理。
起因：2026-11-27 使用者實測，網頁章節索引的 big_content 被收起來、模型看不到，於是 23 次重打 fetch_web_page；v590／v591 只補了那兩個個案。

## 1. 修改前的現有防護

- **精確比對** `FA_DEDUP_EXACT_TOOLS`：`images_to_pdf`、`merge_pdfs`、`fetch_web_page`。參數正規化（欄位排序、去掉空值、去頭尾空白）後完全相同，而且先前成功過，就攔。
  - `fetch_web_page` 不轉小寫（網址大小寫有意義）；另外「同網址、不同輸出格式」算不同呼叫。
  - `images_to_pdf`、`merge_pdfs` 忽略 `filename`，並忽略等於預設值的 `margin: 0`。
- **字詞重疊比對** `FA_DEDUP_TOOLS` 其餘 12 個（`delegate_to_subagent` 桌面 0.85、網頁 0.6；其他 0.95）。只比參數文字；先前成功過才攔。「表面成功」（例如子agent回「找不到」）不算成功，累積 3 次相似重試才攔。
- 攔阻次數：本輪攔阻達桌面 8 次、網頁 2 次，就 `_forceNoTools` 關掉根層級所有工具（逃生用，只限根層級）。
- 攔下時的提示：`fetch_web_page` 有專用提示（告訴它用章節索引的 read_blocks、big_content 分段讀）；其他工具用通用提示。
- 壓縮索引與意圖過濾：模型直接叫到收起來的工具，會補進這一輪的清單（`_callToolGuarded` 開頭）。

**結論**：修改前只有 15 個工具（3 精確、12 字詞重疊）有重複防護；其餘 226 個完全沒有，連續用同樣參數重打也不會被攔。

## 2. 修改前的缺口（已查證）

1. **覆蓋面**：上面 15 個以外的工具沒有任何防護（見第 8 節表格的「既有防護」欄）。
2. **比對對象是參數，不是結果**：這點其實是對的（結果每次都會變，例如 file_id、bc_N 代號、時間戳，只比參數就不受影響）。真正會漏的是**參數的微小差異**（多一個預設欄位、順序以外的細節），字詞重疊 0.95 門檻對短參數很脆弱。這一類目前仍有殘留（見第 9 節）。
3. **結果提到沒送進清單的工具，只在「壓縮索引開啟＋根層級」才補**：
   - 意圖過濾模式（`multiSubAgentMode` 為 intent）：不補。
   - 壓縮索引關閉、而且不是 off 模式（委派模式）：領域閘門裡的工具不在清單，不補。
   - 子agent：完全不補（那段程式只在根層級執行）。
4. **子agent的連續重複**：字詞重疊防護有效；但沒有 `_forceNoTools` 逃生，只能靠子任務的回合上限結束。

## 3. 結果變化導致比對漏掉？（1b）

- 會每次變的回傳：`fetch_web_page`（file_id）、`big_content`（bc_N 代號）、`transcribe_media`／`extract_audio`／`burn_subtitles`／`compose_video`（新 file_id）、`render_*`、`generate_image`、`delegate_to_subagent`（子agent 文字）、`browser_*`（tab id）、`terminal_run`（session id）。
- 這些**不會**讓現有比對漏掉，因為現有比對只看參數（`_dedupText` 用的是 rawArgs）。
- 真正會漏的是參數變化：同一件事換個欄位順序以外的寫法、多帶一個預設值欄位，字詞重疊可能跌破門檻。這是殘留風險，本次不做語意比對。

## 4. 「工具結果叫模型去用另一個工具」逐一檢查（1c）

結果文字裡叫模型去用某工具的地方（以文字內容為準，行號會因修改而移動）：

| 來源（結果） | 叫去用的工具 | 修改前的可見性 | 修改後 |
|---|---|---|---|
| 網頁章節索引（read_blocks 說明） | `big_content`、`parse_uploaded_file`、`article_section`、`browser_get_page_text` | 壓縮索引開＋根層級才補 | 任何模式補（根、意圖、委派、子agent） |
| big_content 的截斷提示 | `big_content`、`python_execute`、`fs_read_file`、`summarize_large_text` | 同上 | 同上；**原提示指向不存在的 `analyze_large_file`，已改成 `summarize_large_text`（傳 file_id）** |
| fetch_web_page 結果 | `parse_uploaded_file`、`summarize_large_text` | 同上 | 同上 |
| article_outline 的 next | `article_section` | 同上 | 同上 |
| parse_uploaded_file（圖片） | `interpret_image` | 同上 | 同上 |
| parse_uploaded_file（二進位） | `fap_copy_to_storage`、`parse_uploaded_file`、`transcribe_media` | 同上 | 同上 |
| summarize_large_text（非文字） | `parse_uploaded_file` | 同上 | 同上 |
| fap_read_file（二進位） | `parse_uploaded_file` | 同上 | 同上 |
| fap_copy_to_storage | `list_uploaded_files`、`parse_uploaded_file`、`transcribe_media`、`extract_audio` | 同上 | 同上 |
| 附件修改結果 | `parse_uploaded_file` | 同上 | 同上 |
| 2D 動畫 YAML | `render_2d_animation` | 同上 | 同上 |
| 圖片檔（非圖片工具） | `parse_uploaded_file` 或 video 視覺 | 同上 | 同上 |

**各模式下模型看得到被叫去用的工具嗎？**

| 模式 | 修改前 | 修改後 |
|---|---|---|
| 壓縮索引開（預設） | 根層級：補（只限此模式）；子agent：看不到 | 根層級：補；子agent：唯讀或根層級能用的補進它的清單，其他在結果裡明講「不能用」 |
| 壓縮索引關、委派模式 | 領域閘門裡的工具看不到 | 補（`_compactExtra`，根層級清單會納入） |
| 意圖過濾 | 看不到（只有直接呼叫會補） | 補（`_intentAdmit`） |
| off 模式（全部原生） | 全部內建工具都在清單，沒有缺口 | 同左 |

**發現的殘留問題**：`analyze_large_file`、`get_large_file_analysis_chunk` 在本專案裡只出現在提示文字與領域清單中，**沒有任何註冊**。已修掉 big_content 的截斷提示；其餘（領域清單 `big_content` 描述、`tool_budget_core.js`、`catalog_core.js` 的 R() 規則）是提示文字與領域設定，改它們會動到壓縮索引的提示基準（`scripts/eval/baselines/compact-off-baseline.json`），本次不動，列為待辦。

## 5. 子agent 路徑（1d）

- 字詞重疊與精確比對：子agent 的呼叫記錄也會 push 進 `log.calls`，同樣生效。
- 壓縮索引補進：修改前完全不補。修改後：唯讀工具（`big_content`、`article_outline`、`article_section`、`parse_uploaded_file`、`summarize_large_text`、`get_tool_details`、`list_uploaded_files`、`fap_read_file`、`fs_read_file`、`browser_get_page_text`）或根層級本來就能用的工具，補進它的 `allowedToolNames`；其他（寫入、執行類）**不擴權**，只在結果裡寫明「不能用」。子agent 不能擴權時（`canRequestMore` 為 false），連根層級能用的也只告知。
- 通用連續重複防護：子agent 也生效（有測試）。子agent 沒有 `_forceNoTools`，所以它只會被攔、不會被關掉工具。

## 6. 合理的重複（通用防護不擋）（1e）

通用防護（`_findConsecutiveRepeat`）只擋「同一輪、同一工具、**連續**、**參數正規化後相同**、**每次都成功**」的呼叫。下列情況不會被擋：

- **輪詢與狀態**：`get_*`、`list_*`、`terminal_*`、`job_*`、`catalog_*`、`mcp_*`、`browser_*`（`browser_search` 除外）、`get_viewer_state` 等，結果會隨時間變，排除。
- **分頁讀取**：參數含 `cursor`／`offset`／`start_line`／`page`，不同頁就是不同參數，不擋；同一頁連續重打才擋（測試覆蓋 `big_content`）。
- **失敗重試**：失敗（`ok:false`）或被截斷（soft）不計入連續成功，重試不擋。
- **讀→改→再讀**：中間只要有別的工具呼叫，連續計數就重算，不擋。
- **寫入與執行**：`fs_write_*`、`fs_mkdir`、`fap_write*`、`python_execute`、`bash_execute`、`render_*`、`compose_*`、`transcribe_*`、`extract_*`、`burn_*`、`coding_run*` 等，有副作用，排除。
- **委派**：`delegate_to_subagent` 維持原本的字詞重疊規則（不屬於通用防護），通用防護排除 `delegate_*`。

## 7. 本次修改

1. `renderer/src/floating-assistant.js`
   - 新增 `_repeatGuardOn`、`_repeatKey`、`_findConsecutiveRepeat`：通用連續重複防護。桌面版連續 3 次成功後第 4 次起攔；網頁版連續 2 次成功後第 3 次起攔。攔下時告訴模型連續幾次、上一次結果（前 1500 字）、要它換做法。開關：`localStorage fa.genericRepeatGuard = '0'` 關掉（預設開）。
   - 新增 `_promoteMentionedTools`：取代原本只在壓縮索引下才跑的補進邏輯；任何模式、根層級與子agent 都套用（見第 4、5 節）。掃描範圍是結果前 `_toolResultBudgetChars()` 字（與模型實際看到的截斷一致）。
   - 新增 `_appendUnavailableToolNotice`：子agent 的結果裡提到不能用的工具時，在結果裡明講（JSON 結果加 `system_notice` 欄位；純文字附在後面）。
   - `_callToolGuarded`：接上連續重複防護；每次成功呼叫都記入 `log.tail`（最多 30 筆，結果只留 4000 字）；子agent 的 `subToolLog` 帶 `allowedNow`、`grantMention`。
   - big_content 截斷提示：`analyze_large_file`（不存在）改成 `summarize_large_text`（傳 file_id）。
2. `scripts/repeat-guard.test.js`（新增）：直接從 `floating-assistant.js` 抽出真正的方法原始碼執行（不複製邏輯），涵蓋：門檻（桌面、網頁）、中間有別的工具、不同 cursor、失敗不計、輪詢／寫入／執行排除、`fs_read_file` 會攔、big_content 分頁、開關、子agent 路徑、結果提到隱藏工具（根層級、意圖模式、子agent 唯讀／寫入、不能擴權、純文字）、既有 fetch_web_page 精確攔阻不變。
3. `scripts/compact-result-mentions.test.js`：原本檢查的是已移除的內嵌程式碼，改成檢查 `_promoteMentionedTools`（並確認 `_callToolGuarded` 有呼叫它）。原本的「複製邏輯」斷言已刪除。

## 8. 工具防護表（自動產生，來源：`floating-assistant.js` 與 `main.js` 的 fs_ 名稱）

欄位：工具名 ｜ 註冊方式 ｜ 既有精確／字詞比對 ｜ 通用連續防護 ｜ 是否為元工具（`FA_OT_META_TOOLS`）。

「通用連續防護：參與」表示只要連續用相同參數、全部成功，就會攔；「排除」表示有狀態、輪詢、寫入、執行、委派，理由見第 6 節。

範圍說明：工具清單以原始碼註冊為準（`registerOptional`、`register_openai_tool`、`bcTool`，加上 `main.js` 的 `fs_` 名稱）。通用防護對 `this.tools` 裡所有名稱都生效（不是只列出來的），所以以後新增的工具會自動納入，只有符合排除規則的才不擋。

| 工具 | 註冊方式 | 既有精確／字詞比對 | 通用連續防護 | 元工具 |
|---|---|---|---|---|
| `add_ai_function` | registerOptional | — | 排除（有狀態／輪詢／寫入／執行／委派） |  |
| `apply_git_patch` | registerOptional | — | 排除（有狀態／輪詢／寫入／執行／委派） |  |
| `article_outline` | registerOptional | — | 參與（連續相同參數、全部成功才攔） |  |
| `article_section` | registerOptional | — | 參與（連續相同參數、全部成功才攔） |  |
| `ask_user_card` | registerOptional | — | 排除（有狀態／輪詢／寫入／執行／委派） |  |
| `attachment_apply_patch` | registerOptional | — | 排除（有狀態／輪詢／寫入／執行／委派） |  |
| `audio_to_midi` | registerOptional | — | 參與（連續相同參數、全部成功才攔） |  |
| `bash_execute` | registerOptional | — | 排除（有狀態／輪詢／寫入／執行／委派） |  |
| `behavior_card` | registerOptional | — | 參與（連續相同參數、全部成功才攔） |  |
| `behavior_define` | registerOptional | — | 參與（連續相同參數、全部成功才攔） |  |
| `big_content` | registerOptional | — | 參與（連續相同參數、全部成功才攔） |  |
| `browser_activate_tab` | bcTool | — | 排除（有狀態／輪詢／寫入／執行／委派） |  |
| `browser_click` | bcTool | — | 排除（有狀態／輪詢／寫入／執行／委派） |  |
| `browser_close` | bcTool | — | 排除（有狀態／輪詢／寫入／執行／委派） |  |
| `browser_create_tab` | bcTool | — | 排除（有狀態／輪詢／寫入／執行／委派） |  |
| `browser_create_tab_group` | bcTool | — | 排除（有狀態／輪詢／寫入／執行／委派） |  |
| `browser_get_elements` | bcTool | — | 排除（有狀態／輪詢／寫入／執行／委派） |  |
| `browser_get_page_structure` | registerOptional | — | 排除（有狀態／輪詢／寫入／執行／委派） |  |
| `browser_get_page_text` | bcTool | — | 排除（有狀態／輪詢／寫入／執行／委派） |  |
| `browser_list_downloads` | bcTool | — | 排除（有狀態／輪詢／寫入／執行／委派） |  |
| `browser_list_tabs` | bcTool | — | 排除（有狀態／輪詢／寫入／執行／委派） |  |
| `browser_mouse` | bcTool | — | 排除（有狀態／輪詢／寫入／執行／委派） |  |
| `browser_navigate` | bcTool | — | 排除（有狀態／輪詢／寫入／執行／委派） |  |
| `browser_press_key` | bcTool | — | 排除（有狀態／輪詢／寫入／執行／委派） |  |
| `browser_screenshot` | registerOptional | — | 排除（有狀態／輪詢／寫入／執行／委派） |  |
| `browser_scroll` | bcTool | — | 排除（有狀態／輪詢／寫入／執行／委派） |  |
| `browser_search` | registerOptional | — | 參與（連續相同參數、全部成功才攔） |  |
| `browser_set_download_behavior` | bcTool | — | 排除（有狀態／輪詢／寫入／執行／委派） |  |
| `browser_status` | bcTool | — | 排除（有狀態／輪詢／寫入／執行／委派） |  |
| `browser_task` | registerOptional | — | 排除（有狀態／輪詢／寫入／執行／委派） |  |
| `browser_type_text` | bcTool | — | 排除（有狀態／輪詢／寫入／執行／委派） |  |
| `browser_upload` | registerOptional | — | 排除（有狀態／輪詢／寫入／執行／委派） |  |
| `browser_wait_download` | bcTool | — | 排除（有狀態／輪詢／寫入／執行／委派） |  |
| `burn_subtitles` | registerOptional | 相似度比對（Jaccard，見程式） | 排除（有狀態／輪詢／寫入／執行／委派） |  |
| `call_ai_function` | registerOptional | — | 參與（連續相同參數、全部成功才攔） |  |
| `catalog_bind` | registerOptional | — | 排除（有狀態／輪詢／寫入／執行／委派） |  |
| `catalog_card` | registerOptional | — | 排除（有狀態／輪詢／寫入／執行／委派） |  |
| `catalog_discover` | registerOptional | — | 排除（有狀態／輪詢／寫入／執行／委派） |  |
| `catalog_feedback` | registerOptional | — | 排除（有狀態／輪詢／寫入／執行／委派） |  |
| `catalog_intent` | registerOptional | — | 排除（有狀態／輪詢／寫入／執行／委派） |  |
| `catalog_js` | registerOptional | — | 排除（有狀態／輪詢／寫入／執行／委派） |  |
| `catalog_onboard` | registerOptional | — | 排除（有狀態／輪詢／寫入／執行／委派） |  |
| `catalog_query` | registerOptional | — | 排除（有狀態／輪詢／寫入／執行／委派） |  |
| `catalog_run` | registerOptional | — | 排除（有狀態／輪詢／寫入／執行／委派） |  |
| `chat_delete_children` | register_openai_tool | — | 參與（連續相同參數、全部成功才攔） |  |
| `chat_get_child_summary` | register_openai_tool | — | 參與（連續相同參數、全部成功才攔） |  |
| `chat_list_children` | register_openai_tool | — | 參與（連續相同參數、全部成功才攔） |  |
| `chat_send_to_child` | register_openai_tool | — | 參與（連續相同參數、全部成功才攔） |  |
| `coding_read_file` | registerOptional | — | 參與（連續相同參數、全部成功才攔） |  |
| `coding_run_check` | registerOptional | — | 排除（有狀態／輪詢／寫入／執行／委派） |  |
| `coding_run_tests` | registerOptional | — | 排除（有狀態／輪詢／寫入／執行／委派） |  |
| `coding_task_state` | registerOptional | — | 排除（有狀態／輪詢／寫入／執行／委派） |  |
| `coding_workspace` | registerOptional | — | 排除（有狀態／輪詢／寫入／執行／委派） |  |
| `compare_images` | registerOptional | — | 參與（連續相同參數、全部成功才攔） |  |
| `compose_video` | registerOptional | — | 排除（有狀態／輪詢／寫入／執行／委派） |  |
| `concat_audio` | registerOptional | — | 排除（有狀態／輪詢／寫入／執行／委派） |  |
| `convert_code` | registerOptional | — | 排除（有狀態／輪詢／寫入／執行／委派） |  |
| `convert_to_animated_gif` | registerOptional | — | 排除（有狀態／輪詢／寫入／執行／委派） |  |
| `convert_video_to_animation` | registerOptional | — | 排除（有狀態／輪詢／寫入／執行／委派） |  |
| `delegate_to_machine` | register_openai_tool | — | 排除（有狀態／輪詢／寫入／執行／委派） |  |
| `delegate_to_subagent` | register_openai_tool | 相似度比對（桌面 0.85／網頁 0.6） | 排除（有狀態／輪詢／寫入／執行／委派） | 是 |
| `delete_ai_function` | registerOptional | — | 排除（有狀態／輪詢／寫入／執行／委派） |  |
| `design_choices` | registerOptional | — | 參與（連續相同參數、全部成功才攔） |  |
| `diagnose_log` | registerOptional | — | 參與（連續相同參數、全部成功才攔） |  |
| `docgen_design_guide` | registerOptional | — | 參與（連續相同參數、全部成功才攔） |  |
| `docgen_list_templates` | registerOptional | — | 參與（連續相同參數、全部成功才攔） |  |
| `docgen_user_guide` | registerOptional | — | 參與（連續相同參數、全部成功才攔） |  |
| `edit_3d_open` | registerOptional | — | 排除（有狀態／輪詢／寫入／執行／委派） |  |
| `edit_docx_open` | registerOptional | — | 排除（有狀態／輪詢／寫入／執行／委派） |  |
| `edit_picture_open` | registerOptional | — | 排除（有狀態／輪詢／寫入／執行／委派） |  |
| `edit_svg_open` | registerOptional | — | 排除（有狀態／輪詢／寫入／執行／委派） |  |
| `edit_video_open` | registerOptional | — | 排除（有狀態／輪詢／寫入／執行／委派） |  |
| `explain_build_error` | registerOptional | — | 參與（連續相同參數、全部成功才攔） |  |
| `explain_code` | registerOptional | — | 參與（連續相同參數、全部成功才攔） |  |
| `explain_command_line` | registerOptional | — | 參與（連續相同參數、全部成功才攔） |  |
| `extract_audio` | registerOptional | 相似度比對（Jaccard，見程式） | 排除（有狀態／輪詢／寫入／執行／委派） |  |
| `extract_clip_range` | registerOptional | — | 排除（有狀態／輪詢／寫入／執行／委派） |  |
| `extract_clip_range_audio` | registerOptional | — | 排除（有狀態／輪詢／寫入／執行／委派） |  |
| `extract_pdf_images` | registerOptional | — | 排除（有狀態／輪詢／寫入／執行／委派） |  |
| `extract_pdf_pages` | registerOptional | — | 排除（有狀態／輪詢／寫入／執行／委派） |  |
| `extract_pptx_images` | registerOptional | — | 排除（有狀態／輪詢／寫入／執行／委派） |  |
| `extract_video_frames` | registerOptional | — | 排除（有狀態／輪詢／寫入／執行／委派） |  |
| `fap_apply_patch` | registerOptional | — | 排除（有狀態／輪詢／寫入／執行／委派） |  |
| `fap_copy_from_storage` | registerOptional | — | 排除（有狀態／輪詢／寫入／執行／委派） |  |
| `fap_copy_to_storage` | registerOptional | — | 排除（有狀態／輪詢／寫入／執行／委派） |  |
| `fap_download_url` | registerOptional | — | 排除（有狀態／輪詢／寫入／執行／委派） |  |
| `fap_find_file` | registerOptional | — | 參與（連續相同參數、全部成功才攔） |  |
| `fap_list_files` | registerOptional | — | 參與（連續相同參數、全部成功才攔） |  |
| `fap_read_file` | registerOptional | — | 參與（連續相同參數、全部成功才攔） |  |
| `fap_write_file` | registerOptional | — | 排除（有狀態／輪詢／寫入／執行／委派） |  |
| `fetch_web_page` | registerOptional | 精確比對（參數正規化後相同即攔） | 參與（連續相同參數、全部成功才攔） |  |
| `fix_code` | registerOptional | — | 排除（有狀態／輪詢／寫入／執行／委派） |  |
| `fs_list_files` | main.js（主程序提供） | — | 參與（連續相同參數、全部成功才攔） |  |
| `fs_read_file` | main.js（主程序提供） | — | 參與（連續相同參數、全部成功才攔） |  |
| `generate_image` | registerOptional | — | 排除（有狀態／輪詢／寫入／執行／委派） |  |
| `get_2d_animation_yaml` | registerOptional | — | 排除（有狀態／輪詢／寫入／執行／委派） |  |
| `get_3d_scene_topic` | registerOptional | — | 排除（有狀態／輪詢／寫入／執行／委派） |  |
| `get_3d_scene_yaml` | registerOptional | — | 排除（有狀態／輪詢／寫入／執行／委派） |  |
| `get_interactive_viewer_yaml` | registerOptional | — | 排除（有狀態／輪詢／寫入／執行／委派） |  |
| `get_saved_script` | registerOptional | — | 排除（有狀態／輪詢／寫入／執行／委派） |  |
| `get_tool_details` | register_openai_tool | — | 排除（有狀態／輪詢／寫入／執行／委派） | 是 |
| `get_viewer_state` | registerOptional | — | 排除（有狀態／輪詢／寫入／執行／委派） |  |
| `git_clone` | registerOptional | — | 排除（有狀態／輪詢／寫入／執行／委派） |  |
| `git_commit` | registerOptional | — | 排除（有狀態／輪詢／寫入／執行／委派） |  |
| `git_inspect` | registerOptional | — | 排除（有狀態／輪詢／寫入／執行／委派） |  |
| `git_log` | registerOptional | — | 排除（有狀態／輪詢／寫入／執行／委派） |  |
| `git_pull` | registerOptional | — | 排除（有狀態／輪詢／寫入／執行／委派） |  |
| `git_push` | registerOptional | — | 排除（有狀態／輪詢／寫入／執行／委派） |  |
| `git_status` | registerOptional | — | 排除（有狀態／輪詢／寫入／執行／委派） |  |
| `glue_define` | registerOptional | — | 排除（有狀態／輪詢／寫入／執行／委派） |  |
| `glue_list` | registerOptional | — | 參與（連續相同參數、全部成功才攔） |  |
| `glue_report` | registerOptional | — | 參與（連續相同參數、全部成功才攔） |  |
| `gui_template_compose` | register_openai_tool | — | 參與（連續相同參數、全部成功才攔） |  |
| `gui_template_find` | register_openai_tool | — | 參與（連續相同參數、全部成功才攔） |  |
| `image_check` | registerOptional | — | 排除（有狀態／輪詢／寫入／執行／委派） |  |
| `image_decompose_redraw` | registerOptional | — | 排除（有狀態／輪詢／寫入／執行／委派） |  |
| `image_details` | registerOptional | — | 排除（有狀態／輪詢／寫入／執行／委派） |  |
| `image_draft` | registerOptional | — | 排除（有狀態／輪詢／寫入／執行／委派） |  |
| `image_improve` | registerOptional | — | 排除（有狀態／輪詢／寫入／執行／委派） |  |
| `image_lens` | registerOptional | — | 排除（有狀態／輪詢／寫入／執行／委派） |  |
| `image_mood` | registerOptional | — | 排除（有狀態／輪詢／寫入／執行／委派） |  |
| `image_parts_annotate` | registerOptional | — | 排除（有狀態／輪詢／寫入／執行／委派） |  |
| `image_parts_teach` | registerOptional | — | 排除（有狀態／輪詢／寫入／執行／委派） |  |
| `image_render` | registerOptional | — | 排除（有狀態／輪詢／寫入／執行／委派） |  |
| `image_retouch` | registerOptional | — | 排除（有狀態／輪詢／寫入／執行／委派） |  |
| `image_rig_animate` | registerOptional | — | 排除（有狀態／輪詢／寫入／執行／委派） |  |
| `image_scene` | registerOptional | — | 排除（有狀態／輪詢／寫入／執行／委派） |  |
| `image_to_3d` | registerOptional | — | 排除（有狀態／輪詢／寫入／執行／委派） |  |
| `image_to_text` | registerOptional | — | 排除（有狀態／輪詢／寫入／執行／委派） |  |
| `images_to_pdf` | registerOptional | 精確比對（參數正規化後相同即攔） | 排除（有狀態／輪詢／寫入／執行／委派） |  |
| `import_2d_animation_attachment` | registerOptional | — | 參與（連續相同參數、全部成功才攔） |  |
| `import_3d_model_attachment` | registerOptional | — | 參與（連續相同參數、全部成功才攔） |  |
| `import_interactive_viewer_attachment` | registerOptional | — | 參與（連續相同參數、全部成功才攔） |  |
| `intent_parse` | registerOptional | — | 排除（有狀態／輪詢／寫入／執行／委派） |  |
| `interpret_image` | registerOptional | — | 參與（連續相同參數、全部成功才攔） |  |
| `job_gui` | registerOptional | — | 排除（有狀態／輪詢／寫入／執行／委派） |  |
| `job_list` | registerOptional | — | 排除（有狀態／輪詢／寫入／執行／委派） |  |
| `job_run` | registerOptional | — | 排除（有狀態／輪詢／寫入／執行／委派） |  |
| `job_stop` | registerOptional | — | 排除（有狀態／輪詢／寫入／執行／委派） |  |
| `language_explore` | registerOptional | — | 參與（連續相同參數、全部成功才攔） |  |
| `list_ai_features` | registerOptional | — | 排除（有狀態／輪詢／寫入／執行／委派） | 是 |
| `list_ai_functions` | registerOptional | — | 排除（有狀態／輪詢／寫入／執行／委派） |  |
| `list_designed_tools` | registerOptional | — | 排除（有狀態／輪詢／寫入／執行／委派） |  |
| `list_file_access_points` | registerOptional | — | 排除（有狀態／輪詢／寫入／執行／委派） |  |
| `list_remote_machines` | register_openai_tool | — | 排除（有狀態／輪詢／寫入／執行／委派） |  |
| `list_saved_scripts` | registerOptional | — | 排除（有狀態／輪詢／寫入／執行／委派） |  |
| `list_uploaded_files` | registerOptional | — | 排除（有狀態／輪詢／寫入／執行／委派） |  |
| `llvm_execute` | registerOptional | — | 排除（有狀態／輪詢／寫入／執行／委派） |  |
| `log_ask` | registerOptional | — | 參與（連續相同參數、全部成功才攔） |  |
| `log_learn` | registerOptional | — | 參與（連續相同參數、全部成功才攔） |  |
| `log_triage` | registerOptional | — | 參與（連續相同參數、全部成功才攔） |  |
| `lookup_error_code` | registerOptional | — | 參與（連續相同參數、全部成功才攔） |  |
| `matrix_blocks` | registerOptional | — | 參與（連續相同參數、全部成功才攔） |  |
| `mcp_call` | registerOptional | — | 排除（有狀態／輪詢／寫入／執行／委派） |  |
| `mcp_install` | registerOptional | — | 排除（有狀態／輪詢／寫入／執行／委派） |  |
| `mcp_manage` | registerOptional | — | 排除（有狀態／輪詢／寫入／執行／委派） |  |
| `mcp_resources` | registerOptional | — | 排除（有狀態／輪詢／寫入／執行／委派） |  |
| `mcp_servers` | registerOptional | — | 排除（有狀態／輪詢／寫入／執行／委派） |  |
| `mcp_tools` | registerOptional | — | 排除（有狀態／輪詢／寫入／執行／委派） |  |
| `merge_patch` | registerOptional | — | 排除（有狀態／輪詢／寫入／執行／委派） |  |
| `merge_pdfs` | registerOptional | 精確比對（參數正規化後相同即攔） | 排除（有狀態／輪詢／寫入／執行／委派） |  |
| `midi_compose` | registerOptional | — | 排除（有狀態／輪詢／寫入／執行／委派） |  |
| `midi_compose_tree` | registerOptional | — | 排除（有狀態／輪詢／寫入／執行／委派） |  |
| `midi_edit_open` | registerOptional | — | 排除（有狀態／輪詢／寫入／執行／委派） |  |
| `midi_play` | registerOptional | — | 排除（有狀態／輪詢／寫入／執行／委派） |  |
| `midi_song_jsonl` | registerOptional | — | 排除（有狀態／輪詢／寫入／執行／委派） |  |
| `midi_to_mp3` | registerOptional | — | 排除（有狀態／輪詢／寫入／執行／委派） |  |
| `mix_highlight` | registerOptional | — | 排除（有狀態／輪詢／寫入／執行／委派） |  |
| `mix_understand` | registerOptional | — | 排除（有狀態／輪詢／寫入／執行／委派） |  |
| `music_topic` | registerOptional | — | 參與（連續相同參數、全部成功才攔） |  |
| `music_work_learn` | registerOptional | — | 參與（連續相同參數、全部成功才攔） |  |
| `offline_trainer` | registerOptional | — | 排除（有狀態／輪詢／寫入／執行／委派） | 是 |
| `optimize_code` | registerOptional | — | 排除（有狀態／輪詢／寫入／執行／委派） |  |
| `parse_uploaded_file` | registerOptional | — | 參與（連續相同參數、全部成功才攔） |  |
| `plan_route` | registerOptional | — | 排除（有狀態／輪詢／寫入／執行／委派） |  |
| `playbook_state` | registerOptional | — | 排除（有狀態／輪詢／寫入／執行／委派） |  |
| `programming_domains` | registerOptional | — | 參與（連續相同參數、全部成功才攔） |  |
| `programming_knowledge` | registerOptional | — | 參與（連續相同參數、全部成功才攔） |  |
| `python_execute` | registerOptional | — | 排除（有狀態／輪詢／寫入／執行／委派） |  |
| `rag_chunk_document` | registerOptional | — | 排除（有狀態／輪詢／寫入／執行／委派） | 是 |
| `rag_delete` | registerOptional | — | 排除（有狀態／輪詢／寫入／執行／委派） | 是 |
| `rag_query_graph` | registerOptional | — | 排除（有狀態／輪詢／寫入／執行／委派） | 是 |
| `rag_store_graph_node` | registerOptional | — | 排除（有狀態／輪詢／寫入／執行／委派） | 是 |
| `ref_define` | registerOptional | — | 參與（連續相同參數、全部成功才攔） |  |
| `ref_expand` | registerOptional | — | 參與（連續相同參數、全部成功才攔） |  |
| `ref_lookup` | registerOptional | — | 參與（連續相同參數、全部成功才攔） |  |
| `ref_resolve` | registerOptional | — | 參與（連續相同參數、全部成功才攔） |  |
| `ref_types` | registerOptional | — | 參與（連續相同參數、全部成功才攔） |  |
| `ref_validate` | registerOptional | — | 參與（連續相同參數、全部成功才攔） |  |
| `register_designed_tool` | registerOptional | — | 排除（有狀態／輪詢／寫入／執行／委派） |  |
| `register_saved_script` | registerOptional | — | 排除（有狀態／輪詢／寫入／執行／委派） |  |
| `remove_designed_tool` | registerOptional | — | 排除（有狀態／輪詢／寫入／執行／委派） |  |
| `remove_pdf_pages` | registerOptional | — | 排除（有狀態／輪詢／寫入／執行／委派） |  |
| `render_2d_animation` | registerOptional | 相似度比對（Jaccard，見程式） | 排除（有狀態／輪詢／寫入／執行／委派） |  |
| `render_3d_scene` | registerOptional | 相似度比對（Jaccard，見程式） | 排除（有狀態／輪詢／寫入／執行／委派） |  |
| `render_drawing` | registerOptional | — | 排除（有狀態／輪詢／寫入／執行／委派） |  |
| `render_interactive_viewer` | registerOptional | 相似度比對（Jaccard，見程式） | 排除（有狀態／輪詢／寫入／執行／委派） |  |
| `render_uml_diagram` | registerOptional | — | 排除（有狀態／輪詢／寫入／執行／委派） |  |
| `repo_ask` | registerOptional | — | 參與（連續相同參數、全部成功才攔） |  |
| `repo_map` | registerOptional | — | 參與（連續相同參數、全部成功才攔） |  |
| `repo_read_doc` | registerOptional | — | 參與（連續相同參數、全部成功才攔） |  |
| `repo_sql` | registerOptional | — | 參與（連續相同參數、全部成功才攔） |  |
| `repo_wiki` | registerOptional | — | 參與（連續相同參數、全部成功才攔） |  |
| `request_additional_tools` | register_openai_tool | — | 排除（有狀態／輪詢／寫入／執行／委派） | 是 |
| `sandbox_capabilities` | registerOptional | — | 排除（有狀態／輪詢／寫入／執行／委派） |  |
| `sandbox_html` | registerOptional | — | 排除（有狀態／輪詢／寫入／執行／委派） |  |
| `sandbox_mock` | registerOptional | — | 排除（有狀態／輪詢／寫入／執行／委派） |  |
| `sandbox_py_app` | registerOptional | — | 排除（有狀態／輪詢／寫入／執行／委派） |  |
| `sandbox_worker` | registerOptional | — | 排除（有狀態／輪詢／寫入／執行／委派） |  |
| `set_viewer_state` | registerOptional | — | 排除（有狀態／輪詢／寫入／執行／委派） |  |
| `skill_compile` | registerOptional | — | 排除（有狀態／輪詢／寫入／執行／委派） |  |
| `skill_create` | registerOptional | — | 排除（有狀態／輪詢／寫入／執行／委派） | 是 |
| `skill_list` | registerOptional | — | 排除（有狀態／輪詢／寫入／執行／委派） | 是 |
| `skill_read` | registerOptional | — | 排除（有狀態／輪詢／寫入／執行／委派） | 是 |
| `skill_run_script` | registerOptional | — | 排除（有狀態／輪詢／寫入／執行／委派） |  |
| `soundtrack_make` | registerOptional | — | 參與（連續相同參數、全部成功才攔） |  |
| `start_dubbing_session` | registerOptional | — | 排除（有狀態／輪詢／寫入／執行／委派） |  |
| `summarize_large_text` | registerOptional | — | 參與（連續相同參數、全部成功才攔） |  |
| `terminal_cp_from` | registerOptional | — | 排除（有狀態／輪詢／寫入／執行／委派） |  |
| `terminal_cp_to` | registerOptional | — | 排除（有狀態／輪詢／寫入／執行／委派） |  |
| `terminal_create` | registerOptional | — | 排除（有狀態／輪詢／寫入／執行／委派） |  |
| `terminal_get_text` | registerOptional | — | 排除（有狀態／輪詢／寫入／執行／委派） |  |
| `terminal_list` | registerOptional | — | 排除（有狀態／輪詢／寫入／執行／委派） |  |
| `terminal_run` | registerOptional | — | 排除（有狀態／輪詢／寫入／執行／委派） |  |
| `text_to_speech` | registerOptional | 相似度比對（Jaccard，見程式） | 排除（有狀態／輪詢／寫入／執行／委派） |  |
| `transcribe_media` | registerOptional | 相似度比對（Jaccard，見程式） | 排除（有狀態／輪詢／寫入／執行／委派） |  |
| `translate_text` | registerOptional | — | 參與（連續相同參數、全部成功才攔） |  |
| `uefi_parse` | registerOptional | — | 參與（連續相同參數、全部成功才攔） |  |
| `uml_design` | registerOptional | — | 排除（有狀態／輪詢／寫入／執行／委派） |  |
| `uml_edit` | registerOptional | — | 排除（有狀態／輪詢／寫入／執行／委派） |  |
| `uml_guide` | registerOptional | — | 排除（有狀態／輪詢／寫入／執行／委派） |  |
| `uml_to_code` | registerOptional | — | 排除（有狀態／輪詢／寫入／執行／委派） |  |
| `uml_to_wasm` | registerOptional | — | 排除（有狀態／輪詢／寫入／執行／委派） |  |
| `webedit_open` | registerOptional | — | 排除（有狀態／輪詢／寫入／執行／委派） |  |
| `webedit_topic` | registerOptional | — | 排除（有狀態／輪詢／寫入／執行／委派） |  |
| `worksheet_adjust` | registerOptional | — | 排除（有狀態／輪詢／寫入／執行／委派） |  |
| `worksheet_make` | registerOptional | — | 排除（有狀態／輪詢／寫入／執行／委派） |  |
| `worksheet_open` | registerOptional | — | 排除（有狀態／輪詢／寫入／執行／委派） |  |
| `worksheet_topic` | registerOptional | — | 排除（有狀態／輪詢／寫入／執行／委派） |  |
| `write_code` | registerOptional | — | 排除（有狀態／輪詢／寫入／執行／委派） |  |
| `youtube_download` | registerOptional | — | 排除（有狀態／輪詢／寫入／執行／委派） |  |

## 9. 殘留風險與未驗證的部分

1. **參數的微小差異仍會漏掉**：通用防護與既有的字詞重疊防護都是比參數。多一個預設欄位、欄位值寫法不同，就不會被視為同一呼叫。要處理需要語意比對，本次不做。
2. **交錯重打不擋**：通用防護只看連續呼叫。模型若在 A、B 兩個工具之間來回重打（A B A B …），不會被通用防護攔。最常見的 fetch_web_page 交錯重打已有既有的精確防護涵蓋。
3. **結果提到工具只掃前 N 字**：掃描範圍與模型實際看到的截斷一致（`_toolResultBudgetChars()`）。超過截斷範圍的提及，模型看不到，也不會補進清單；這是刻意的，避免補進模型不知道的工具。
4. **真 Electron 與真模型未重現**：本次沒有啟動 Electron。依任務的退路，以模擬的工具結果序列驗證（`scripts/repeat-guard.test.js` 第 9 節「模擬序列」）：抓文章→章節索引叫用 big_content→模型重打 fetch→第二次起被攔，big_content 補進清單。模擬用的結果文字是手寫的，不是真實抓取結果。
5. **`analyze_large_file`、`get_large_file_analysis_chunk` 未註冊**：提示文字與領域清單仍有引用（`big_content` 領域描述、`renderer/src/tools/tool_budget_core.js`、`renderer/src/catalog/catalog_core.js` 的規則）。big_content 的截斷提示已修；其餘未改，因為它們是提示文字與領域設定，改了會動到壓縮索引的提示基準（`scripts/eval/baselines/compact-off-baseline.json`）。待辦：要麼註冊這兩個工具，要麼從提示中拿掉。
6. **`scripts/desktop-only-settings.test.js` 在 HEAD 也失敗**：錯誤是 `this._termBeginLoad is not a function`。已用 HEAD 版本的 `floating-assistant.js` 在暫存資料夾重跑，同樣失敗，與本次修改無關，未修。
7. **預設行為的變動**：通用防護與結果提及補進預設開啟（桌面版連續 3 次成功攔）。新增的補進邏輯不再只限壓縮索引，所以在「壓縮索引關、委派模式」下，結果提到的隱藏工具現在會補進清單（以前不會）。這是為了修 1c 的缺口，預期行為改變；通用防護有開關 `fa.genericRepeatGuard`（設 0 即關）；結果提及補進目前沒有單獨開關。
8. **未發布、未推送**：依任務，本次只提交到 `desktop-app` 分支，不發布、不推送、不合併。
