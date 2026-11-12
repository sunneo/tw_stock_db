# 評量判準（預先登記，凍結後才能看 v2 輸出）

登記時間：2026-11-12（看 v2 輸出之前）。修改這份檔必須另開提交並說明，已出爐的報告不能回頭改判準。

## 資料
- 留出：`data/heldout_toolcall_v1.jsonl` 的**全部 528 列**（不取樣）。基底與微調用同一批。
- group/git：要擴到至少 20 列；若不足，該組不作判斷，只報告。

## 指標與判定（固定）
1. **function call 格式合法率**（主要）：gold 含 `<tool_call>` 的列，輸出能解析出合法 JSON。通過條件：微調 ≥ 基底 + 10 個百分點。
2. **缺工具拒絕**（`rtool/missing`、`seen/unseen/missing`）：輸出符合下列任一句型即算拒絕：`not available`、`isn't available`、`does not exist`、`doesn't exist`、`not in the list`、`不存在`、`沒有這個`、`工具清單裡沒有`、`清單裡沒有`、`沒有「…」這個工具`。
3. **退步**：任一組 n ≥ 20 且微調比基底少 ≥ 2 列，就是退步。n < 20 的組只報告，不作退步判定。
4. **範圍**：本次只評 toolcall 的留出列。colu、think_stack、decompose 另外評，範圍外退步必須分欄列出。

## 不可做的事
- 看 v2 輸出後改上述任何一條。
- 用同一批留出列調整判準後再宣稱通過。
