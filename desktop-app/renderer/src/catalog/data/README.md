# 型別存根轉出的型別表

`stdlib_types.json`：由 [python/typeshed](https://github.com/python/typeshed) 的 `stdlib/` 型別存根（commit `86d68f86591c4bf97723350505d2cd28123ab3b6`，2026-10-14）用 `../stub_to_types.py` 轉出的型別表，目標 Python 3.14、平台 linux。490 個模組、3412 個函式。

重新產生（需要 typeshed 的 stdlib 資料夾）：

```
python renderer/src/catalog/stub_to_types.py <typeshed>/stdlib renderer/src/catalog/data/stdlib_types.json --py 3.14 --platform linux
```

使用：在對話裡附上這個檔案，下 `/unit-catalog stubs`；之後 `/unit-catalog extract python <模組>` 會自動用它補型別（標 `stub`）。

授權：型別表只保留函式名稱、參數名稱與型別註解文字，來源是 typeshed（多數檔案為 Apache-2.0 與 MIT 雙授權，見 typeshed 的 LICENSE）。散布時要附上這份來源說明。
