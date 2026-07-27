"""
初始化 SQLite 資料庫：讀取 schema.sql 建立所有資料表。
也負責「輕量遷移」：如果資料庫已存在（舊版schema），會補上 schema.sql 裡
新增的欄位（例如 rs_rating），不會動到既有資料。
用法： python db/init_db.py
"""
import sqlite3
import sys
import os

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from config import DB_PATH, SCHEMA_PATH, get_connection

# 舊資料庫升級用：(資料表, 新欄位, 欄位型別/預設值 SQL片段)
MIGRATIONS = [
    ("technical_indicators", "rs_rating", "REAL"),
]


def migrate(conn):
    cur = conn.cursor()
    for table, column, col_type in MIGRATIONS:
        cur.execute("SELECT name FROM sqlite_master WHERE type='table' AND name=?", (table,))
        if cur.fetchone() is None:
            continue  # 資料表還沒建立，交給 executescript 的 CREATE TABLE 處理
        cur.execute(f"PRAGMA table_info({table})")
        existing_cols = {row[1] for row in cur.fetchall()}
        if column not in existing_cols:
            print(f"[migrate] {table} 缺少欄位 {column}，補上...")
            cur.execute(f"ALTER TABLE {table} ADD COLUMN {column} {col_type}")
    conn.commit()


def init_db():
    with open(SCHEMA_PATH, "r", encoding="utf-8") as f:
        schema_sql = f.read()

    conn = get_connection()
    try:
        try:
            conn.executescript(schema_sql)
        except sqlite3.OperationalError as e:
            # 常見情況：舊資料庫已有資料表，但缺少 schema.sql 新增的欄位，導致依賴
            # 該欄位的 CREATE INDEX 失敗（例如 rs_rating）。先補欄位再重跑一次整份
            # schema（CREATE TABLE/INDEX 都有 IF NOT EXISTS，重跑是安全的）。
            print(f"[init] 建表時遇到欄位缺失（{e}），嘗試遷移後重試...")
            migrate(conn)
            conn.executescript(schema_sql)
        conn.commit()
        migrate(conn)
        print(f"資料庫已初始化：{DB_PATH}")
    finally:
        conn.close()


if __name__ == "__main__":
    init_db()
