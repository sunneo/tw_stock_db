# 巢狀委派：領域／技能可以請「另一個領域或技能」幫忙（2026-10-14）

## 以前
`delegate_to_subagent` 只有根模型能呼叫（刻意不放進任何領域的工具子集，避免無限遞迴）。領域／技能（`skill_<id>` 技能包也是一個領域）的子agent 只有 `request_additional_tools`：能追加「工具」，不能請「另一個有自己工具與知識的子agent」。所以簡報領域做到一半缺 3D 場景、技能缺另一個技能整理的結果，只能回報做不到。

## 現在
`_runSubAgentTask` 在領域／技能的執行裡多一個偽工具 `delegate_subtask({task, domain?})`（跟 `request_additional_tools` 同一種機制：只在這次執行內存在，不寫進 `this.tools`），而且系統提示會告訴它「你可以請另一個領域或技能幫忙」與可選清單（技能用使用者取的名字、內建領域用代號；`domain` 填代號、技能名稱或領域顯示名稱都行；留空自動挑選＝`_delegateToSubagentAuto`）。結果（含視覺結果，例如 3D 場景）原樣交回給呼叫它的子agent，視覺結果會一路浮到對話。

## 防失控（寫死在程式裡）
- 深度：根→領域→再往下一層，**第二層不能再委派**（`SUBAGENT_NEST_MAX_DEPTH = 2`；第二層的工具清單裡根本沒有這個工具）。
- 不能委派給自己或上層（`delegationChain`／`delegationExclude`；自動挑選選到上層也擋下並要求明確指定）。
- 一次執行最多 4 次（`SUBAGENT_NEST_MAX_CALLS`）；使用者按停止（`shouldStop`）就不再委派。
- 不開放：分階段 pipeline 的某一步、批次子任務、離線訓練器老師、群組轉來的任務（它們沒有 `delegationChain`）。
- 相同參數的重複呼叫被 `FA_DEDUP_TOOLS` 擋。
- 巢狀時要保護外層的實例旗標：`_deckInDomainRun` 還原成進來時的值（不是設 false）、瀏覽器分頁交給最外層收。
- 關掉：`advancedSettings.subagentNestedDelegation = false`（預設開）。

## 驗證
`scripts/eval/nested-delegation.eval.js`：假的 LLM 端點、真實 Electron——A 有 `delegate_subtask`、被委派的 B 沒有；B 的結果回到 A；委派給自己被擋且回報可選清單；用領域顯示名稱委派可以解析。**沒有用真實模型測過**：真的弱模型會不會在該委派時委派、不該委派時不亂委派，要靠使用者實測回報再調提示詞。

## 沒做
- 設定頁沒有開關（要關得改 `advancedSettings`）。
- 技能清單只有名稱，沒有每個技能的一句話說明；模型不認得的技能名稱不會被選。
- 深度固定 2，不可設定。
