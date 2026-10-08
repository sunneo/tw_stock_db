# -*- coding: utf-8 -*-
"""fa_sqlite（Python 的 sqlite3 相容介面）的測試：橋接用「標準函式庫的 sqlite3」假冒引擎，
所以同一份測試也能對照標準 sqlite3 的行為（交易、型別、錯誤）。用法：python scripts/test_fa_sqlite.py"""
import base64
import os
import sqlite3 as std
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "renderer", "src", "pybridge"))
import fa_bridge  # noqa: E402

DBS = {}
TMP = tempfile.mkdtemp(prefix="fa-pysql-")
LOG = []


def _enc(v):
    if isinstance(v, (bytes, bytearray)):
        return {"$blob": base64.b64encode(bytes(v)).decode()}
    if isinstance(v, int) and not -(2 ** 53) < v < 2 ** 53:
        return {"$int": str(v)}
    return v


def _dec(v):
    if isinstance(v, dict) and "$blob" in v:
        return base64.b64decode(v["$blob"])
    if isinstance(v, dict) and "$int" in v:
        return int(v["$int"])
    return v


def fake_call(op, args=None, timeout=0):
    args = args or {}
    LOG.append(op)
    if op == "sqlite.open":
        ref = args["ref"]
        path = ":memory:" if ref == ":memory:" else os.path.join(TMP, ref.replace(":", "_").replace("/", "_"))
        con = std.connect(path, isolation_level=None)  # 引擎：連線自己沒有隱含交易，BEGIN／COMMIT 都是明確語句
        did = "db%d" % (len(DBS) + 1)
        DBS[did] = con
        return {"db": did, "label": ref}
    con = DBS[args["db"]]
    if op == "sqlite.close":
        con.close()
        return {"ok": True}
    if op == "sqlite.sync":
        return {"ok": True}
    if op == "sqlite.exec":
        sql = args["sql"]
        bind = args.get("bind")
        if isinstance(bind, list):
            bind = [_dec(x) for x in bind]
        elif isinstance(bind, dict):
            bind = {k: _dec(v) for k, v in bind.items()}
        try:
            if std.complete_statement(sql) and sql.strip().count(";") > 1:
                con.executescript(sql)
                return {"results": [{"columns": [], "rows": [], "changes": 0}]}
            cur = con.execute(sql, bind if bind is not None else ())
            cols = [d[0] for d in cur.description] if cur.description else []
            rows = [[_enc(v) for v in r] for r in cur.fetchall()] if cols else []
            return {"results": [{"columns": cols, "rows": rows, "changes": 0 if cols else max(cur.rowcount, 0), "last_id": cur.lastrowid if not cols else None}]}
        except std.Error as e:
            return {"results": [{"columns": [], "rows": [], "error": str(e)}]}
    raise RuntimeError("fake: " + op)


fa_bridge.call = fake_call
import fa_sqlite as sq  # noqa: E402

bad = []
ok = 0


def t(name, fn):
    global ok
    try:
        fn()
        ok += 1
    except Exception as e:  # noqa: BLE001
        import traceback
        bad.append("%s: %s %s" % (name, type(e).__name__, e))
        traceback.print_exc()


def test_basic():
    con = sq.connect(":memory:")
    con.execute("create table t(id integer primary key, name text, v real, b blob)")
    cur = con.execute("insert into t(name, v, b) values(?,?,?)", ("a", 1.5, b"\x00\x01"))
    assert cur.rowcount == 1 and cur.lastrowid == 1, (cur.rowcount, cur.lastrowid)
    con.commit()
    rows = con.execute("select * from t").fetchall()
    assert rows == [(1, "a", 1.5, b"\x00\x01")], rows
    c = con.execute("select name, v from t")
    assert [d[0] for d in c.description] == ["name", "v"]
    assert c.fetchone() == ("a", 1.5) and c.fetchone() is None


def test_params():
    con = sq.connect(":memory:")
    con.execute("create table t(a, b)")
    con.executemany("insert into t values(?,?)", [(1, "x"), (2, "y"), (3, "z")])
    assert con.execute("select count(*) from t").fetchone() == (3,)
    assert con.execute("select b from t where a = :n", {"n": 2}).fetchone() == ("y",)
    cur = con.executemany("insert into t values(?,?)", [(4, "p"), (5, "q")])
    assert cur.rowcount == 2


def test_row_factory():
    con = sq.connect(":memory:")
    con.row_factory = sq.Row
    con.execute("create table t(a, b)")
    con.execute("insert into t values(1,'x')")
    r = con.execute("select a, b from t").fetchone()
    assert r["a"] == 1 and r["B"] == "x" and r[1] == "x" and r.keys() == ["a", "b"] and tuple(r) == (1, "x")


def test_transactions():
    con = sq.connect(":memory:")
    con.execute("create table t(a)")
    con.commit()
    con.execute("insert into t values(1)")
    assert con.in_transaction
    con.rollback()
    assert con.execute("select count(*) from t").fetchone() == (0,)
    con.execute("insert into t values(2)")
    con.commit()
    assert not con.in_transaction
    con.execute("insert into t values(3)")
    con.close()
    c2 = sq.connect(":memory:")  # 另一個連線：:memory: 是獨立的，這裡只驗證 close 不丟錯
    c2.close()


def test_autocommit_mode():
    con = sq.connect(":memory:", isolation_level=None)
    con.execute("create table t(a)")
    con.execute("insert into t values(1)")
    assert not con.in_transaction
    con.execute("begin")
    con.execute("insert into t values(2)")
    assert con.in_transaction
    con.execute("rollback")
    assert not con.in_transaction
    assert con.execute("select count(*) from t").fetchone() == (1,)


def test_context_manager():
    con = sq.connect(":memory:")
    con.execute("create table t(a)")
    with con:
        con.execute("insert into t values(1)")
    assert con.execute("select count(*) from t").fetchone() == (1,)
    try:
        with con:
            con.execute("insert into t values(2)")
            raise ValueError("boom")
    except ValueError:
        pass
    assert con.execute("select count(*) from t").fetchone() == (1,)


def test_errors():
    con = sq.connect(":memory:")
    try:
        con.execute("select * from nope")
        raise AssertionError("沒有丟錯")
    except sq.OperationalError:
        pass
    con.execute("create table u(a unique)")
    con.execute("insert into u values(1)")
    try:
        con.execute("insert into u values(1)")
        raise AssertionError("沒有丟錯")
    except sq.IntegrityError:
        pass
    assert issubclass(sq.IntegrityError, sq.DatabaseError) and issubclass(sq.DatabaseError, sq.Error)
    con.close()
    try:
        con.execute("select 1")
        raise AssertionError("沒有丟錯")
    except sq.ProgrammingError:
        pass


def test_bigint_blob_none():
    con = sq.connect(":memory:")
    con.execute("create table t(a integer, b blob, c)")
    big = 9223372036854775807
    con.execute("insert into t values(?,?,?)", (big, b"abc", None))
    assert con.execute("select a, b, c from t").fetchone() == (big, b"abc", None)
    con.execute("insert into t values(?,?,?)", (True, bytearray(b"z"), 2.5))
    assert con.execute("select a, b, c from t where c = 2.5").fetchone() == (1, b"z", 2.5)


def test_iteration_and_fetch():
    con = sq.connect(":memory:")
    con.execute("create table t(a)")
    con.executemany("insert into t values(?)", [(i,) for i in range(10)])
    cur = con.execute("select a from t order by a")
    assert cur.fetchmany(3) == [(0,), (1,), (2,)]
    assert [r[0] for r in cur] == [3, 4, 5, 6, 7, 8, 9]


def test_script():
    con = sq.connect(":memory:")
    con.executescript("create table t(a); insert into t values(1); insert into t values(2);")
    assert con.execute("select sum(a) from t").fetchone() == (3,)


def test_refs_pass_through():
    LOG.clear()
    con = sq.connect("fap:proj/index.sqlite3", readonly=False)
    con.execute("create table x(a)")
    con.commit()
    con.close()
    assert "sqlite.sync" in LOG and LOG[0] == "sqlite.open" and LOG[-1] == "sqlite.close", LOG


for name, fn in list(globals().items()):
    if name.startswith("test_"):
        t(name, fn)
print("%d passed, %d failed %s" % (ok, len(bad), bad))
sys.exit(1 if bad else 0)
