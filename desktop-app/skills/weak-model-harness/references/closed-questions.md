# 封閉題型

| 題型 | 模型看到 | 模型回答 | 程式核對 | 不合格的退路 |
|---|---|---|---|---|
| 路由題 | 使用者原話＋編號選項（字母） | 一個字母 | 字母在範圍內（容許引號、{"choice":"B"}） | 兩次不合格 → 路由失敗，判定 failed |
| 選擇題 | 題目＋字母選項 | 一個字母 | 同上 | 範本指定的預設選項，by:default |
| 填空題 | 只列程式還沒填的欄位 | 一個 JSON 物件 | 鍵必須是列出的欄位；型別、列舉、範圍；數字必須出現在使用者的話裡；沒提到填 null | 全部欄位 null，必填欄位缺 → 判定 failed |

程式先決定的：關鍵字路由（命中數差距夠大）、只有一個選項的關鍵字命中、只有一個的列舉值出現在話裡、只有一個數字欄位且話裡只有一個數字。程式決定的步驟紀錄為 by:program。

判定：ok＝所有步驟 by 是 program 或 model 且通過核對、必填齊全；degraded＝用過預設退路但必填齊全；failed＝缺必填或路由不到。

新增範本：在 `templates.json` 加一筆 `{id, label, keywords, questions[], result}`；fill 題的欄位格式同 recipe_core 的欄位定義（name、type、enum、min、max、required、description）；result 用 `{{slots.欄位}}` 內插。
