"""
初始化 SQLite 資料庫：讀取 schema.sql 建立所有資料表。
用法： python db/init_db.py
"""
import sqlite3
import sys
import os

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from config import DB_PATH, SCHEMA_PATH


def init_db():
    with open(SCHEMA_PATH, "r", encoding="utf-8") as f:
        schema_sql = f.read()

    conn = sqlite3.connect(DB_PATH)
    try:
        conn.executescript(schema_sql)
        conn.commit()
        print(f"資料庫已初始化：{DB_PATH}")
    finally:
        conn.close()


if __name__ == "__main__":
    init_db()
