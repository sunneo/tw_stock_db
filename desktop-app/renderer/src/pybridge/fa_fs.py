# -*- coding: utf-8 -*-
"""
fa_fs — 網頁版（Pyodide）的檔案存取：寫入繞進 fap（使用者授權的資料夾）。

網頁版的 Python 跑在瀏覽器裡，只有一個看不到的暫存檔案系統（關掉頁面就消失）。腳本寫出的報告、截圖、資料庫等如果留在那裡，
使用者永遠拿不到。所以這裡把檔案存取接到 fap：
  * 明確指定：/fap/<資料夾名稱>/路徑，或 "fap:<資料夾名稱>/路徑"
  * 一般路徑（相對路徑、或不是系統內部用途的絕對路徑）：自動放進「預設的 fap」——設定裡指定的那一個，沒指定就用第一個已授權、可寫入的
  * 系統內部路徑（/tmp、/proc、/dev、Python 的標準函式庫與套件、轉接層自己）維持在暫存檔案系統，不繞
沒有任何可寫入的 fap 時，寫入會丟出 PermissionError 並說明怎麼授權（不會悄悄把檔案丟掉）。

做法：open() 讀取時先把 fap 的內容取到暫存、寫入時在關閉檔案的當下送回 fap；os／pathlib 的 exists、stat、listdir、scandir、makedirs、mkdir、
remove、rmdir、rename、replace 也接上。桌面版 Python 是真的檔案系統，不需要這一層。
"""
import builtins
import io
import os
import sys

import fa_bridge

_ST = {"installed": False, "default": None, "cache": "/fa_fap_cache"}
_LOCAL = ("/tmp", "/proc", "/dev", "/sys", "/lib", "/usr", "/fa_pybridge", "/fa_fap_cache", "/home/pyodide/.cache", "/etc", "/var/tmp")
_orig = {}


def _call(op, **a):
    return fa_bridge.call(op, a, timeout=120.0)


def default_label():
    if _ST["default"] is None:
        r = _call("fs.info")
        if not r or not r.get("label"):
            raise PermissionError((r or {}).get("hint") or "沒有可以寫入的授權資料夾（fap）。請先在助理的「檔案存取點」授權一個資料夾，或在設定指定 pythonBridgeFap。")
        _ST["default"] = r["label"]
    return _ST["default"]


def _site_dirs():
    out = [p for p in sys.path if p and p.startswith("/") and ("site-packages" in p or "python3" in p or p.endswith(".zip"))]
    pre = getattr(sys, "prefix", "") or ""
    if len(pre) > 1:  # Pyodide 的 sys.prefix 是 "/"，不能拿來當前綴（會讓所有路徑都被當成系統路徑）
        out.append(pre)
    return out


def classify(path):
    """回傳 (label, rel) 表示要走 fap，或 None 表示維持本地。"""
    if not fa_bridge.ACTIVE:
        return None
    if isinstance(path, int) or path is None:
        return None
    try:
        p = os.fspath(path)
    except TypeError:
        return None
    if isinstance(p, bytes):
        p = p.decode("utf-8", "replace")
    if p.startswith("fap:"):
        rest = p[4:].lstrip("/")
        label, _, rel = rest.partition("/")
        return label, rel.strip("/")
    if p.startswith("/fap/"):
        rest = p[5:]
        label, _, rel = rest.partition("/")
        return label, rel.strip("/")
    absp = os.path.normpath(os.path.join(os.getcwd(), p)) if not p.startswith("/") else os.path.normpath(p)
    if any(absp == l or absp.startswith(l + "/") for l in _LOCAL) or any(absp.startswith(s) for s in _site_dirs()):
        return None
    cwd = os.getcwd().rstrip("/")
    if absp == cwd or absp.startswith(cwd + "/"):
        rel = absp[len(cwd):].strip("/")
    else:
        rel = absp.strip("/")
    return default_label(), rel


def _cache_path(label, rel):
    return os.path.join(_ST["cache"], label, rel) if rel else os.path.join(_ST["cache"], label)


def _mk_local(path):
    d = os.path.dirname(path)
    if d:
        _orig["makedirs"](d, exist_ok=True)


def _fetch(label, rel):
    """把 fap 的檔案取到暫存，回傳暫存路徑（fap 沒有這個檔案就回 None）。"""
    r = _call("fs.read", label=label, path=rel)
    if not r or not r.get("exists"):
        return None
    import base64
    cp = _cache_path(label, rel)
    _mk_local(cp)
    with _orig["open"](cp, "wb") as f:
        f.write(base64.b64decode(r.get("b64") or ""))
    return cp


def _push(label, rel, cp):
    import base64
    with _orig["open"](cp, "rb") as f:
        data = f.read()
    _call("fs.write", label=label, path=rel, b64=base64.b64encode(data).decode("ascii"))


class _SyncFile(object):
    """寫入模式的檔案：關閉時把內容送回 fap。其餘行為跟真的檔案物件一樣。"""

    def __init__(self, f, label, rel, cp):
        self.__dict__.update(_f=f, _label=label, _rel=rel, _cp=cp, _done=False)

    def __getattr__(self, k):
        return getattr(self.__dict__["_f"], k)

    def __iter__(self):
        return iter(self.__dict__["_f"])

    def __enter__(self):
        return self

    def __exit__(self, *a):
        self.close()
        return False

    def close(self):
        d = self.__dict__
        if d["_done"]:
            return
        d["_done"] = True
        d["_f"].close()
        _push(d["_label"], d["_rel"], d["_cp"])

    def __del__(self):
        try:
            self.close()
        except Exception:
            pass


def _explicit(path):
    s = str(os.fspath(path)) if not isinstance(path, int) else ""
    return s.startswith("fap:") or s.startswith("/fap/")


def _local_has(path):
    """沒有明確指定 fap 的路徑，如果本地暫存檔案系統裡已經有（例如 python_execute 放進去的檔案），就維持本地。"""
    try:
        _orig["stat"](path)
        return True
    except (OSError, ValueError, TypeError):
        return False


def _open(file, mode="r", *a, **kw):
    c = classify(file)
    if c is None:
        return _orig["open"](file, mode, *a, **kw)
    label, rel = c
    writing = any(m in mode for m in "wax+")
    if not writing and not _explicit(file) and _local_has(file):
        return _orig["open"](file, mode, *a, **kw)
    cp = _cache_path(label, rel)
    if "w" in mode or "x" in mode:
        if "x" in mode and _call("fs.exists", label=label, path=rel).get("exists"):
            raise FileExistsError(file)
        _mk_local(cp)
        return _SyncFile(_orig["open"](cp, mode, *a, **kw), label, rel, cp)
    got = _fetch(label, rel)
    if got is None:
        if "a" in mode or "+" in mode and "r" not in mode:
            _mk_local(cp)
            return _SyncFile(_orig["open"](cp, mode, *a, **kw), label, rel, cp)
        raise FileNotFoundError(2, "No such file or directory (fap)", str(file))
    f = _orig["open"](cp, mode, *a, **kw)
    return _SyncFile(f, label, rel, cp) if writing else f


# ---- os 層
def _stat(path, *a, **kw):
    c = classify(path)
    if c is None or (not _explicit(path) and _local_has(path)):
        return _orig["stat"](path, *a, **kw)
    label, rel = c
    r = _call("fs.stat", label=label, path=rel)
    if not r or not r.get("exists"):
        raise FileNotFoundError(2, "No such file or directory (fap)", str(path))
    mode = (0o040755 if r.get("is_dir") else 0o100644)
    t = float(r.get("mtime") or 0) / 1000.0
    return os.stat_result((mode, 0, 0, 1, 0, 0, int(r.get("size") or 0), t, t, t))


def _listdir(path="."):
    c = classify(path)
    if c is None or (not _explicit(path) and _local_has(path)):
        return _orig["listdir"](path)
    r = _call("fs.list", label=c[0], path=c[1])
    if r is None or r.get("exists") is False:
        raise FileNotFoundError(2, "No such file or directory (fap)", str(path))
    return [e["name"] for e in r.get("entries", [])]


class _Entry(object):
    def __init__(self, base, e):
        self.name = e["name"]
        self.path = os.path.join(base, e["name"])
        self._dir = bool(e.get("is_dir"))

    def is_dir(self, follow_symlinks=True):
        return self._dir

    def is_file(self, follow_symlinks=True):
        return not self._dir

    def is_symlink(self):
        return False

    def stat(self, follow_symlinks=True):
        return _stat(self.path)

    def __fspath__(self):
        return self.path


class _ScanIter(object):
    def __init__(self, items):
        self._it = iter(items)

    def __iter__(self):
        return self

    def __next__(self):
        return next(self._it)

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def close(self):
        pass


def _scandir(path="."):
    c = classify(path)
    if c is None or (not _explicit(path) and _local_has(path)):
        return _orig["scandir"](path)
    r = _call("fs.list", label=c[0], path=c[1])
    if r is None or r.get("exists") is False:
        raise FileNotFoundError(2, "No such file or directory (fap)", str(path))
    base = os.fspath(path)
    return _ScanIter([_Entry(base, e) for e in r.get("entries", [])])


def _makedirs(name, mode=0o777, exist_ok=False):
    c = classify(name)
    if c is None:
        return _orig["makedirs"](name, mode, exist_ok)
    if _call("fs.exists", label=c[0], path=c[1]).get("exists") and not exist_ok:
        raise FileExistsError(17, "File exists (fap)", str(name))
    _call("fs.mkdir", label=c[0], path=c[1])


def _mkdir(path, mode=0o777, *a, **kw):
    c = classify(path)
    if c is None:
        return _orig["mkdir"](path, mode, *a, **kw)
    if _call("fs.exists", label=c[0], path=c[1]).get("exists"):
        raise FileExistsError(17, "File exists (fap)", str(path))
    _call("fs.mkdir", label=c[0], path=c[1])


def _remove(path, *a, **kw):
    c = classify(path)
    if c is None:
        return _orig["remove"](path, *a, **kw)
    r = _call("fs.remove", label=c[0], path=c[1])
    if not r or not r.get("removed"):
        raise FileNotFoundError(2, "No such file or directory (fap)", str(path))
    cp = _cache_path(*c)
    if os.path.exists(cp):
        try:
            _orig["remove"](cp)
        except OSError:
            pass


def _rename(src, dst, *a, **kw):
    cs, cd = classify(src), classify(dst)
    if cs is None and cd is None:
        return _orig["rename"](src, dst, *a, **kw)
    with _open(src, "rb") as f:
        data = f.read()
    with _open(dst, "wb") as g:
        g.write(data)
    _remove(src)


def install():
    if _ST["installed"]:
        return
    _ST["installed"] = True
    for k, mod, name in (("open", builtins, "open"), ("stat", os, "stat"), ("listdir", os, "listdir"), ("scandir", os, "scandir"),
                         ("makedirs", os, "makedirs"), ("mkdir", os, "mkdir"), ("remove", os, "remove"), ("rename", os, "rename")):
        _orig[k] = getattr(mod, name)
    builtins.open = _open
    io.open = _open
    os.stat = _stat
    os.listdir = _listdir
    os.scandir = _scandir
    os.makedirs = _makedirs
    os.mkdir = _mkdir
    os.remove = _remove
    os.unlink = _remove
    os.rmdir = _remove
    os.rename = _rename
    os.replace = _rename
    try:
        _orig["makedirs"](_ST["cache"], exist_ok=True)
    except OSError:
        pass
