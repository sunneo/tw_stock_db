# CHANGES.md

`floating-assistant.js`（AI聊天widget，host-agnostic，tw_stock_db/piano-web共用）
的逐日異動摘要。詳細技術細節（涉及的函式/行號/實測數據）見同資料夾的
`DESIGN-INDEX.md`，這份文件只做濃縮版的「今天做了什麼、為什麼」，方便快速掃過
歷史脈絡，不用整份翻`DESIGN-INDEX.md`。新的一天永遠加在最上面。

## 2026-09-13

背景：使用者計畫把floating-assistant.js整合進piano-web（鋼琴多音軌編輯器），並
預期piano-web未來會需要大量（上百種）音樂曲風的subagent。今天圍繞著「怎麼讓
subagent機制撐得住這種規模、同時不污染主對話」這個主軸做了兩項延伸。

1. **Skill(自訂工具)改走subagent domain委派，不再無條件掛根層級**
   （commit `c9740921`）
   - Advance Settings「Skill」分頁的自訂工具（`advancedSettings.customTools`）
     原本無條件曝光在根層級對話工具清單，Skill越加越多會稀釋根模型注意力/塞爆
     system prompt。改成新增一個`custom_skills`虛擬domain（`toolNames`即時讀
     `advancedSettings.customTools`），跟9/6~9/9做好的內建工具domain委派機制
     共用同一套路由/執行邏輯——`router`/`full`模式下Skill不再無條件曝光，只能
     透過`delegate_to_subagent`委派給子agent按需查詢/呼叫；`off`模式（沒有
     subagent機制）維持直接掛根層級不變。
   - 新增`_importSkillFolder`（File System Access API）：除了既有的`.skill`
     zip附件匯入，現在也能直接選一個本機資料夾（結構跟zip解開後一樣：
     `SKILL.md`+`tools/*.js`）匯入，不用先手動打包成zip。刻意不持久化授權、
     不自動重新掃描——每次都是使用者主動選一次資料夾的單次匯入動作。
   - 順便確認（沒有改code）：RAG知識圖譜（`rag_lookup`domain）在這套委派機制下
     依然可用——路由子agent本來就能一次選多個domain，任務需要「Skill+過去成功
     案例/關聯經驗」時，`custom_skills`跟`rag_lookup`會被合併進同一次委派，實測
     驗證過。

2. **兩層domain路由（類別→細分domain）+ subagent執行中動態追加工具**
   （commit `f0dced72`）
   - 新增`multiSubAgentMode`第4個值`'hierarchical'`：domain數大到像「上百種
     曲風」這種規模時，既有的扁平單層路由（一次列出全部domain目錄）會塞爆
     路由子agent的注意力。改成選配的兩層路由——先選「類別」，選中的類別再
     各自平行問一次「該用哪個細分domain」。用tw_stock_db共用金鑰模式對
     `nvidia/nemotron-3-super-120b-a12b`做過真實LLM benchmark：45個domain時
     兩層式省58%路由token、但延遲多6-7秒；精準度測試裡扁平模式在45個domain
     時真的漏判一題，兩層式全對——這組實測數據是把它做成「選配」而非取代
     既有模式的依據，domain少時不建議用。
   - 新增`register_domain_category`+`register_domain`的`category`選填參數，
     讓host頁面（piano-web之後可以自己註冊）能把domain分類。
   - 新增`request_additional_tools`偽工具：子agent執行到一半才發現需要一個
     原本沒拿到的domain工具時，可以在**同一次執行**裡原地申請追加（直接擴充
     這次執行的可用工具清單、下一輪立刻生效），不需要跳出去重新委派一次
     整個流程——避免使用者擔心的「查完GitHub才發現要查wiki」這類多階段任務
     卡在工具不夠用。有申請次數上限（3次）防止失控。
   - 路由prompt同步補一句引導：任務如果是多階段的，路由時要盡量把預期會用到
     的domain一次選齊，降低事後才發現不夠的機率（零額外LLM往返成本的prompt
     wording調整，不是加一輪驗證呼叫）。

兩項今天都只做在`floating-assistant.js`這個共用引擎本身，piano-web實際要用
（幫每個曲風`register_domain`帶`category`、累積曲風knowledge等）是piano-web
之後自己要做的事，這次沒有處理piano-web的實際曲風資料/MIDI分類管線。
