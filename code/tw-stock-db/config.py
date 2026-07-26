"""
共用設定檔。使用者可依自己電腦的路徑調整 DB_PATH。
"""
import os

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(BASE_DIR, "tw_stock.db")
SCHEMA_PATH = os.path.join(BASE_DIR, "db", "schema.sql")

# 爬蟲設定
REQUEST_DELAY_SEC = 0.5     # 每檔股票之間的延遲，避免請求過於密集
BATCH_SIZE = 50              # 每批次寫入DB的筆數
MAX_RETRIES = 3               # 單一股票抓取失敗的重試次數

# 技術指標參數（對應 SKILL 中的方法論設定）
MA_PERIODS = [5, 10, 20, 60]
KD_PERIOD = 9
RSI_PERIODS = [6, 12]
BB_PERIOD = 20
BB_STD = 2
BIAS_PERIOD = 20

# GitHub 同步設定（sync/sync_to_github.py 使用）
# 兩個獨立 clone，各自固定在自己的分支上，避免每月覆蓋 db-snapshot 時
# 不小心動到 main 分支的逐日歷史記錄。路徑依你自己電腦調整。
GITHUB_SYNC_MAIN_REPO = r"D:\Downloads\tw_stock_db_repo"                # main 分支：daily/ 逐日增量 CSV
GITHUB_SYNC_SNAPSHOT_REPO = r"D:\Downloads\tw_stock_db_repo_snapshot"   # db-snapshot 分支：完整 tw_stock.db
SYNC_STATE_PATH = os.path.join(BASE_DIR, ".sync_state.json")
