---
name: tw-stock-db-repo-guardrails
description: 本目錄（tw-stock-db）為受 git 版控的資料管線原始碼。任何在此目錄內執行「產生報表／簡報／PPTX／週報／持股分析」等分析任務時，必須先讀取本檔案，並嚴格遵守下列規則，不得修改任何原始碼檔案。
---

# tw-stock-db 原始碼保護規則

本目錄是使用者用 git 管理、持續開發中的資料管線原始碼（爬蟲、資料庫、技術指標計算），
不是一次性的分析沙盒。任何 Claude 對話（不論是 Claude Code、Claude Desktop 的 local agent
mode，或其他有檔案系統存取權的介面）在這個資料夾內做「選股／週報／持股分析／PPTX／報表」
之類的任務時，**只能讀取資料、輸出報表檔案，絕對不能修改或覆蓋下列版控原始碼**：

## 禁止修改（除非使用者在對話中明確要求「修改程式碼」並描述具體需求）

- `config.py`、`run_daily_update.py`
- `db/schema.sql`、`db/init_db.py`
- `scrapers/*.py`
- `analysis/*.py`（含 `compute_indicators.py`、`screen_strong_stocks.py`、
  `generate_watchlist.py`、`generate_holdings_report.py`、`generate_daily_report.py`）
- `sync/*.py`
- `README.md`、`requirements.txt`、`SKILL.md`（本檔案）

## 唯一允許的輸出位置

新產生的報表、PPTX、CSV/JSON 名單等一律寫到：

- `reports/weekly/{日期}/`
- `reports/holdings/{日期}.md`
- 或使用者指定的其他輸出路徑（例如桌面、下載資料夾）

**不要**把沙盒（例如 `/mnt/user-data/outputs/...`）裡重新產生的專案檔案，複製或下載回這個
git 工作目錄覆蓋既有檔案。沙盒環境常常是從舊的/不完整的上下文重建整個專案骨架，直接覆蓋
會用「看起來像同名檔案」的舊版本，悄悄砍掉已經 commit 的功能（例如 RS 值排名、WAL 併發保護、
週報/持股報表流程、GitHub 同步），且會讓其他仍 import 舊介面（如 `get_connection`）的檔案
直接壞掉。

## 如果分析邏輯需要新原則（例如新的 RS 相對強度定義）

- 不要直接改寫 `analysis/compute_indicators.py` 等共用管線檔案。
- 讀取資料庫現有欄位（例如已存在的 `rs_rating`）在報表產生階段自行加工/重新詮釋即可；
  或是把新邏輯寫成獨立的一次性分析腳本（放在對話沙盒或使用者指定的暫存資料夾），不要
  動到共用模組。
- 若確實需要變更共用管線的計算邏輯或 schema，先用文字說明「建議怎麼改、為什麼、影響哪些
  檔案」，讓使用者自己在 Claude Code 裡審閱並決定是否要修改、commit。

## 原則

這個資料夾的原始碼異動一律由使用者本人在 Claude Code 對話中審閱、測試、commit。產生報表
類的任務結束時，工作目錄裡除了 `reports/` 或使用者指定的輸出檔案外，不應該出現任何
`git status` 看得到的原始碼修改。
