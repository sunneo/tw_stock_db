# -*- coding: utf-8 -*-
"""
fa_sqlite — 走助理 SQLite 引擎的 sqlite3 相容介面（DB-API 風格）。

為什麼不直接用標準函式庫的 sqlite3：
  * 檔案可以是助理看得到、Python 看不到的地方：fap:<名稱>/<路徑>（授權的資料夾）、終端機沙盒內的檔案、file:<真實路徑>；
  * 與終端機的 sqlite3／sqlitebrowser 共用同一個引擎（SQLite 3.53、含 FTS5），結果一致；
  * 大型資料庫由引擎在主行程開檔，不吃 Python 的記憶體。
只在執行技能包的腳本裡可用（要有橋接，見 fa_bridge）；一般的 Python 想開本機資料庫，直接用標準函式庫的 sqlite3 就好。

    import fa_sqlite as sqlite3
    con = sqlite3.connect("fap:myproj/.floating-assistant/index/index.sqlite3", readonly=True)
    for name, line in con.execute("select name, line from symbols where name = ?", ("main",)):
        print(name, line)
    con.close()

交易語意與標準 sqlite3 相同：isolation_level 預設 ""，第一個 INSERT／UPDATE／DELETE／REPLACE 前自動 BEGIN，commit() 才提交
並把變更寫回來源（暫存副本會寫回 fap／沙盒）；isolation_level=None 是自動提交。
"""
import base64
import json

import fa_bridge

paramstyle = "qmark"
apilevel = "2.0"
threadsafety = 1
sqlite_version = "3.53.4"
version = "fa-1"
PARSE_DECLTYPES = 1
PARSE_COLNAMES = 2


class Error(Exception):
    pass


class Warning(Exception):
    pass


class InterfaceError(Error):
    pass


class DatabaseError(Error):
    pass


class DataError(DatabaseError):
    pass


class OperationalError(DatabaseError):
    pass


class IntegrityError(DatabaseError):
    pass


class InternalError(DatabaseError):
    pass


class ProgrammingError(DatabaseError):
    pass


class NotSupportedError(DatabaseError):
    pass


def _raise(msg):
    m = str(msg)
    low = m.lower()
    if "constraint failed" in low or "unique constraint" in low or "foreign key" in low:
        raise IntegrityError(m)
    if "no such" in low or "syntax error" in low or "locked" in low or "readonly" in low or "unable to open" in low or "already exists" in low:
        raise OperationalError(m)
    if "bind" in low or "parameter" in low:
        raise ProgrammingError(m)
    raise DatabaseError(m)


def _enc(v):
    if v is None or isinstance(v, (str, float)):
        return v
    if isinstance(v, bool):
        return 1 if v else 0
    if isinstance(v, int):
        return v if -(2 ** 53) < v < 2 ** 53 else {"$int": str(v)}
    if isinstance(v, (bytes, bytearray, memoryview)):
        return {"$blob": base64.b64encode(bytes(v)).decode("ascii")}
    raise InterfaceError("不支援的參數型別：%s" % type(v).__name__)


def _dec(v):
    if isinstance(v, dict):
        if "$blob" in v:
            return base64.b64decode(v["$blob"])
        if "$int" in v:
            return int(v["$int"])
        if "$real" in v:
            return float(v["$real"])
    return v


def _bind(params):
    if params is None:
        return None
    if isinstance(params, dict):
        return {k: _enc(v) for k, v in params.items()}
    return [_enc(v) for v in params]


class Row(object):
    """sqlite3.Row 的對應：可以用位置或欄位名稱取值。"""
    __slots__ = ("_keys", "_vals")

    def __init__(self, cursor, row):
        self._keys = [d[0] for d in cursor.description]
        self._vals = tuple(row)

    def keys(self):
        return list(self._keys)

    def __getitem__(self, k):
        if isinstance(k, str):
            for i, n in enumerate(self._keys):
                if n.lower() == k.lower():
                    return self._vals[i]
            raise IndexError("No item with that key")
        return self._vals[k]

    def __iter__(self):
        return iter(self._vals)

    def __len__(self):
        return len(self._vals)

    def __eq__(self, other):
        return isinstance(other, Row) and self._vals == other._vals and self._keys == other._keys

    def __repr__(self):
        return "<Row %s>" % dict(zip(self._keys, self._vals))


_WRITE = ("INSERT", "UPDATE", "DELETE", "REPLACE")


def _first_word(sql):
    s = sql.lstrip()
    while s.startswith("--") or s.startswith("/*"):
        if s.startswith("--"):
            nl = s.find("\n")
            s = "" if nl < 0 else s[nl + 1:].lstrip()
        else:
            end = s.find("*/")
            s = "" if end < 0 else s[end + 2:].lstrip()
    w = s.split(None, 1)[0].upper() if s else ""
    return w


class Cursor(object):
    arraysize = 1

    def __init__(self, con):
        self.connection = con
        self.description = None
        self.rowcount = -1
        self.lastrowid = None
        self.row_factory = None
        self._rows = []
        self._pos = 0

    def _run(self, sql, params):
        con = self.connection
        con._check()
        w = _first_word(sql)
        if con.isolation_level is not None and not con._in_txn and w in _WRITE:
            con._exec("BEGIN")
            con._in_txn = True
        results = con._exec(sql, params)
        res = results[-1] if results else {"columns": [], "rows": []}
        return res

    def execute(self, sql, parameters=()):
        res = self._run(sql, _bind(parameters))
        cols = res.get("columns") or []
        self.description = tuple((c, None, None, None, None, None, None) for c in cols) if cols else None
        self._rows = [tuple(_dec(v) for v in r) for r in (res.get("rows") or [])]
        self._pos = 0
        self.rowcount = -1 if cols else int(res.get("changes") or 0)
        lid = res.get("last_id")
        if lid is not None:
            self.lastrowid = _dec(lid)
        if self.connection._in_txn is False and _first_word(sql) in ("BEGIN", "SAVEPOINT"):
            self.connection._in_txn = True
        elif _first_word(sql) in ("COMMIT", "END", "ROLLBACK"):
            self.connection._in_txn = False
        return self

    def executemany(self, sql, seq):
        total = 0
        for p in seq:
            self.execute(sql, p)
            total += max(0, self.rowcount)
        self.rowcount = total
        return self

    def executescript(self, script):
        con = self.connection
        con.commit()
        con._exec(script)
        con._in_txn = False
        return self

    def _wrap(self, r):
        f = self.row_factory or self.connection.row_factory
        return f(self, r) if f else r

    def fetchone(self):
        if self._pos >= len(self._rows):
            return None
        r = self._rows[self._pos]
        self._pos += 1
        return self._wrap(r)

    def fetchmany(self, size=None):
        n = size or self.arraysize
        out = []
        while len(out) < n:
            r = self.fetchone()
            if r is None:
                break
            out.append(r)
        return out

    def fetchall(self):
        out = []
        while True:
            r = self.fetchone()
            if r is None:
                break
            out.append(r)
        return out

    def __iter__(self):
        return self

    def __next__(self):
        r = self.fetchone()
        if r is None:
            raise StopIteration
        return r

    def close(self):
        self._rows = []

    def setinputsizes(self, *a):
        pass

    def setoutputsize(self, *a):
        pass


class Connection(object):
    Error = Error
    DatabaseError = DatabaseError
    OperationalError = OperationalError
    IntegrityError = IntegrityError
    ProgrammingError = ProgrammingError

    def __init__(self, ref, readonly=False, create=True, isolation_level="", max_rows=1000000):
        self.row_factory = None
        self.isolation_level = isolation_level
        self.text_factory = str
        self._in_txn = False
        self._closed = False
        self._max_rows = max_rows
        self._ref = ref
        r = fa_bridge.call("sqlite.open", {"ref": ref, "readonly": bool(readonly), "create": bool(create)})
        self._db = r["db"]
        self.label = r.get("label", ref)
        self.readonly = bool(readonly)

    def _check(self):
        if self._closed:
            raise ProgrammingError("Cannot operate on a closed database.")

    def _exec(self, sql, bind=None):
        args = {"db": self._db, "sql": sql, "limit": self._max_rows, "typed": False}
        if bind is not None:
            args["bind"] = bind
        r = fa_bridge.call("sqlite.exec", args)
        results = r.get("results") or []
        for x in results:
            if x.get("error"):
                _raise(x["error"])
        return results

    def cursor(self, factory=None):
        self._check()
        c = (factory or Cursor)(self)
        return c

    def execute(self, sql, parameters=()):
        return self.cursor().execute(sql, parameters)

    def executemany(self, sql, seq):
        return self.cursor().executemany(sql, seq)

    def executescript(self, script):
        return self.cursor().executescript(script)

    def commit(self):
        self._check()
        if self._in_txn:
            self._exec("COMMIT")
            self._in_txn = False
        fa_bridge.call("sqlite.sync", {"db": self._db})  # 暫存副本寫回 fap／沙盒

    def rollback(self):
        self._check()
        if self._in_txn:
            self._exec("ROLLBACK")
            self._in_txn = False

    def sync(self):
        self.commit()

    def close(self):
        if self._closed:
            return
        try:
            if self._in_txn:
                self._exec("ROLLBACK")  # 與標準 sqlite3 一樣：close 不會提交
        except Exception:
            pass
        self._closed = True
        fa_bridge.call("sqlite.close", {"db": self._db})

    @property
    def total_changes(self):
        r = self._exec("select total_changes()")
        return int(r[0]["rows"][0][0]) if r and r[0].get("rows") else 0

    @property
    def in_transaction(self):
        return self._in_txn

    def create_function(self, *a, **k):
        raise NotSupportedError("fa_sqlite 不支援自訂 SQL 函式（引擎在助理的主行程裡）")

    def __enter__(self):
        return self

    def __exit__(self, et, ev, tb):
        if et is None:
            self.commit()
        else:
            self.rollback()
        return False


def connect(database, timeout=5.0, detect_types=0, isolation_level="", check_same_thread=True, factory=None, cached_statements=128, uri=False, readonly=False, create=True, max_rows=1000000):
    """database：:memory:、fap:<名稱>/<路徑>、file:<真實路徑>、或助理終端機沙盒內的路徑。"""
    return Connection(database, readonly=readonly, create=create, isolation_level=isolation_level, max_rows=max_rows)


def complete_statement(sql):
    s = sql.rstrip()
    return s.endswith(";") and s.count("'") % 2 == 0
