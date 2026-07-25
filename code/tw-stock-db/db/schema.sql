-- 台股資料庫 schema
-- 設計原則：daily_prices 存原始OHLCV，technical_indicators 存衍生指標（可隨時重算、不影響原始資料）

PRAGMA foreign_keys = ON;

-- 類股/產業對照表
CREATE TABLE IF NOT EXISTS sectors (
    sector_id   INTEGER PRIMARY KEY AUTOINCREMENT,
    sector_name TEXT NOT NULL UNIQUE
);

-- 個股基本資料
CREATE TABLE IF NOT EXISTS stocks (
    stock_code  TEXT PRIMARY KEY,          -- 例如 '2330'
    stock_name  TEXT NOT NULL,             -- 例如 '台積電'
    market      TEXT NOT NULL CHECK (market IN ('TWSE', 'TPEx')),  -- 上市 / 上櫃
    sector_id   INTEGER,
    is_active   INTEGER NOT NULL DEFAULT 1,  -- 1=正常交易中, 0=下市/暫停
    updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (sector_id) REFERENCES sectors(sector_id)
);

CREATE INDEX IF NOT EXISTS idx_stocks_sector ON stocks(sector_id);
CREATE INDEX IF NOT EXISTS idx_stocks_market ON stocks(market);

-- 每日OHLCV原始資料
CREATE TABLE IF NOT EXISTS daily_prices (
    stock_code  TEXT NOT NULL,
    trade_date  TEXT NOT NULL,   -- 'YYYY-MM-DD'
    open        REAL,
    high        REAL,
    low         REAL,
    close       REAL,
    volume      INTEGER,         -- 成交股數（非成交張數，換算時 /1000）
    PRIMARY KEY (stock_code, trade_date),
    FOREIGN KEY (stock_code) REFERENCES stocks(stock_code)
);

CREATE INDEX IF NOT EXISTS idx_daily_prices_date ON daily_prices(trade_date);

-- 技術指標（衍生計算欄位，可整表重算）
CREATE TABLE IF NOT EXISTS technical_indicators (
    stock_code   TEXT NOT NULL,
    trade_date   TEXT NOT NULL,
    ma5          REAL,
    ma10         REAL,
    ma20         REAL,
    ma60         REAL,
    vol_ma5      REAL,           -- 5日均量（基本量的計算基礎）
    kd_k         REAL,
    kd_d         REAL,
    macd_dif     REAL,
    macd_macd    REAL,
    macd_osc     REAL,
    rsi6         REAL,
    rsi12        REAL,
    bb_upper     REAL,           -- 布林上軌 (MA20 + 2*STD)
    bb_mid       REAL,           -- 布林中軌 (MA20)
    bb_lower     REAL,           -- 布林下軌 (MA20 - 2*STD)
    bias20       REAL,           -- 20日乖離率 (%)
    ma_alignment TEXT,           -- '多排' / '空排' / '交叉混雜'（5/10/20/60四線排列狀態）
    PRIMARY KEY (stock_code, trade_date),
    FOREIGN KEY (stock_code) REFERENCES stocks(stock_code)
);

CREATE INDEX IF NOT EXISTS idx_ti_date ON technical_indicators(trade_date);

-- 大盤指數（加權指數，作為大盤環境判斷基準）
CREATE TABLE IF NOT EXISTS market_index (
    index_code  TEXT NOT NULL,    -- 'TAIEX' 或 'TPEx'
    trade_date  TEXT NOT NULL,
    open        REAL,
    high        REAL,
    low         REAL,
    close       REAL,
    volume      INTEGER,
    PRIMARY KEY (index_code, trade_date)
);

-- 爬蟲執行紀錄（方便追蹤哪些股票/日期抓取失敗，供補抓使用）
CREATE TABLE IF NOT EXISTS fetch_log (
    log_id      INTEGER PRIMARY KEY AUTOINCREMENT,
    stock_code  TEXT,
    fetch_date  TEXT NOT NULL DEFAULT (datetime('now')),
    status      TEXT NOT NULL,   -- 'success' / 'failed' / 'no_data'
    message     TEXT
);
