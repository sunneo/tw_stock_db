# db-monthly 分支

網頁優化用的逐月封存快照（db/monthly、db/monthly-chip、db/by-id），用一般incremental commit累積歷史（不像db-snapshot分支的完整tw_stock.db part檔那樣每月orphan commit + force push整個覆蓋）——過去月份一旦封存就不會再變動，用一般commit保留歷史對這類「不可變」資料沒有無限增長的疑慮，也不需要每次都重新上傳全部月份，只需要傳輸真正變動的部分。
