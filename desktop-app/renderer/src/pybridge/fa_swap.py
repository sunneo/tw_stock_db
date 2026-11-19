# -*- coding: utf-8 -*-
"""
fa_swap — 把瀏覽器的 IndexedDB 當 swap：資料比記憶體大也跑得動（慢一點，但不會被瀏覽器殺掉）。

Pyodide 的記憶體上限很低（WebAssembly 堆最多 2~4 GB，手機常常不到 1 GB），大陣列一放就爆。這裡把大陣列切成「頁」（page），
記憶體只留最近用的幾頁（熱區），其餘經橋接寫進 IndexedDB（瀏覽器把它存成磁碟檔）；用到再讀回。三層：

    Python 熱區（wasm 堆，hot_bytes）→ 助理頁面的 FaSwap 熱區（JS 記憶體）→ IndexedDB（磁碟）

用法：
    import numpy as np, fa_swap
    a = fa_swap.array((100000, 256), 'float32')      # 約 100 MB，但 Python 這邊只留 hot_mb（預設 16 MB）
    a[0:1000] = np.random.rand(1000, 256)            # 寫：整頁讀進來改完、標成「髒」，被踢出熱區時才寫回
    x = a[500:600]                                   # 讀：回傳 numpy 陣列（複本）
    for start, block in a.blocks(4096):              # 一塊一塊處理（out-of-core）
        block *= 2; a[start:start + len(block)] = block
    fa_swap.stats()                                  # {'pages_hot', 'pages_total', 'reads', 'writes', 'hot_bytes', 'backend': 'indexeddb'|'memory'}

規則與限制：
  * 只沿第 0 軸分頁（一頁 = 若干整列，預設 256 KB；一列比一頁還大就一列一頁）。索引支援：整數、切片（含 step）、整數序列、再接其他軸的索引（先取列再套後面的索引）。
  * 沒寫過的頁讀出來是 0（像 mmap 的新檔案）。程式結束或 close() 時橋接那一側的頁一律丟掉，不會殘留。
  * 沒有橋接（不在助理的環境、或沒有 IndexedDB）時退回記憶體字典：功能一樣，但**不省記憶體**，stats()['backend']=='memory'。
  * 不是執行緒安全的；一個 SwapArray 同時只給一個執行緒用。
"""
import atexit
import base64
import os
import uuid
from collections import OrderedDict

try:
    import numpy as np
except ImportError:  # pragma: no cover
    np = None

PAGE_BYTES = 256 * 1024
HOT_BYTES = int(float(os.environ.get("FA_SWAP_HOT_MB", "16")) * 1048576)


class SwapError(RuntimeError):
    pass


class _Backend:
    """頁面倉庫：put(bytes)->id、get(id)->bytes、drop(id)、close()。"""

    name = "memory"

    def __init__(self):
        self._m = {}
        self._n = 0

    def put(self, data):
        self._n += 1
        k = "m%d" % self._n
        self._m[k] = bytes(data)
        return k

    def get(self, k):
        return self._m[k]

    def drop(self, k):
        self._m.pop(k, None)

    def close(self):
        self._m.clear()

    def info(self):
        return {"backend": self.name, "items": len(self._m)}


class _BridgeBackend(_Backend):
    name = "indexeddb"

    def __init__(self, call, space):
        self._call = call
        self.space = space

    def put(self, data):
        return self._call("swap.put", {"space": self.space, "b64": base64.b64encode(data).decode("ascii")})["id"]

    def get(self, k):
        return base64.b64decode(self._call("swap.get", {"space": self.space, "id": k})["b64"])

    def drop(self, k):
        self._call("swap.drop", {"space": self.space, "id": k})

    def close(self):
        self._call("swap.close", {"space": self.space})

    def info(self):
        r = self._call("swap.stats", {"space": self.space})
        r["backend"] = self.name
        return r


def _make_backend(call=None, space=None):
    space = space or ("py-" + uuid.uuid4().hex[:10])
    if call is None:
        try:
            import fa_bridge
            if fa_bridge.available() and getattr(fa_bridge, "ACTIVE", True):
                call = fa_bridge.call
        except Exception:
            call = None
    if call is not None:
        try:
            b = _BridgeBackend(call, space)
            b.info()  # 探一下：沒有 IndexedDB 時這裡就會丟錯 → 退回記憶體
            return b
        except Exception:
            pass
    return _Backend()


class Swap:
    """一個 swap 空間：管熱區（LRU、髒頁寫回）與一個後端。SwapArray 共用它。"""

    def __init__(self, hot_bytes=None, page_bytes=None, backend=None, call=None):
        self.hot_bytes = HOT_BYTES if hot_bytes is None else int(hot_bytes)
        self.page_bytes = PAGE_BYTES if page_bytes is None else int(page_bytes)
        self.backend = backend or _make_backend(call)
        self._hot = OrderedDict()   # (aid, pno) → [ndarray, dirty]
        self._disk = {}             # (aid, pno) → 後端的 id
        self._arrays = {}
        self._seq = 0
        self.reads = self.writes = self.hits = 0
        self._closed = False

    # ---- 頁面 ----
    def _hot_size(self):
        return sum(v[0].nbytes for v in self._hot.values())

    def _evict(self, keep=None):
        while self._hot and self._hot_size() > self.hot_bytes:
            key = next(iter(self._hot))
            if key == keep:
                if len(self._hot) == 1:
                    break
                self._hot.move_to_end(key)
                key = next(iter(self._hot))
            arr, dirty = self._hot.pop(key)
            if dirty or key not in self._disk:
                old = self._disk.get(key)
                self._disk[key] = self.backend.put(arr.tobytes())
                self.writes += 1
                if old is not None:
                    self.backend.drop(old)

    def page(self, arr, pno, for_write=False):
        key = (arr._id, pno)
        ent = self._hot.get(key)
        if ent is not None:
            self.hits += 1
            self._hot.move_to_end(key)
        else:
            shape = (arr._rows_in_page(pno),) + arr.shape[1:]
            if key in self._disk:
                raw = self.backend.get(self._disk[key])
                self.reads += 1
                data = np.frombuffer(raw, dtype=arr.dtype).reshape(shape).copy()
            else:
                data = np.full(shape, arr._fill, dtype=arr.dtype)
            ent = self._hot[key] = [data, False]
            self._evict(keep=key)
        if for_write:
            ent[1] = True
        return ent[0]

    def new_id(self):
        self._seq += 1
        return self._seq

    def drop_array(self, arr):
        for key in [k for k in list(self._hot) if k[0] == arr._id]:
            del self._hot[key]
        for key in [k for k in list(self._disk) if k[0] == arr._id]:
            self.backend.drop(self._disk.pop(key))
        self._arrays.pop(arr._id, None)

    def flush(self):
        """把所有髒頁寫到後端（熱區內容保留）。"""
        for key, ent in self._hot.items():
            if ent[1] or key not in self._disk:
                old = self._disk.get(key)
                self._disk[key] = self.backend.put(ent[0].tobytes())
                self.writes += 1
                ent[1] = False
                if old is not None:
                    self.backend.drop(old)

    def set_hot_bytes(self, n):
        self.hot_bytes = int(n)
        self._evict()

    def stats(self):
        s = {"pages_hot": len(self._hot), "pages_total": len(set(self._hot) | set(self._disk)), "reads": self.reads,
             "writes": self.writes, "hits": self.hits, "hot_bytes": self._hot_size(), "limit": self.hot_bytes,
             "arrays": len(self._arrays)}
        try:
            s.update({"backend": self.backend.name, "host": self.backend.info()})
        except Exception as e:  # 橋接那一側出錯不該讓 stats 壞掉
            s.update({"backend": self.backend.name, "host_error": str(e)})
        return s

    def close(self):
        if self._closed:
            return
        self._closed = True
        self._hot.clear()
        self._disk.clear()
        self._arrays.clear()
        try:
            self.backend.close()
        except Exception:
            pass

    def array(self, shape, dtype="float64", fill=0):
        return SwapArray(self, shape, dtype, fill)

    def from_array(self, a):
        a = np.asarray(a)
        out = SwapArray(self, a.shape, a.dtype)
        n = out._rows_per_page
        for p in range(out._npages):
            out.page_write(p, a[p * n:(p + 1) * n])
        return out


class SwapArray:
    """沿第 0 軸分頁、像 numpy 一樣用的陣列。"""

    def __init__(self, swap, shape, dtype="float64", fill=0):
        if np is None:
            raise SwapError("需要 numpy")
        self._swap = swap
        self.shape = tuple(int(x) for x in ((shape,) if isinstance(shape, int) else shape))
        if not self.shape or any(x < 0 for x in self.shape):
            raise SwapError("shape 不合法：%r" % (shape,))
        self.dtype = np.dtype(dtype)
        self._fill = fill
        row = max(1, int(np.prod(self.shape[1:], dtype=np.int64)) * self.dtype.itemsize)
        self._row_bytes = row
        self._rows_per_page = max(1, swap.page_bytes // row)
        self._npages = (self.shape[0] + self._rows_per_page - 1) // self._rows_per_page
        self._id = swap.new_id()
        swap._arrays[self._id] = self

    # ---- 基本屬性 ----
    ndim = property(lambda self: len(self.shape))
    nbytes = property(lambda self: int(np.prod(self.shape, dtype=np.int64)) * self.dtype.itemsize)
    size = property(lambda self: int(np.prod(self.shape, dtype=np.int64)))

    def __len__(self):
        return self.shape[0]

    def __repr__(self):
        return "<SwapArray shape=%r dtype=%s %.1f MB 頁=%d>" % (self.shape, self.dtype, self.nbytes / 1048576.0, self._npages)

    def _rows_in_page(self, pno):
        n = self._rows_per_page
        return min(n, self.shape[0] - pno * n)

    def page_write(self, pno, data):
        pg = self._swap.page(self, pno, for_write=True)
        pg[...] = data

    # ---- 索引 ----
    def _rows(self, idx):
        """第 0 軸的索引 → (列號陣列, 是不是單一整數)。"""
        n = self.shape[0]
        if isinstance(idx, (int, np.integer)):
            i = int(idx)
            if i < 0:
                i += n
            if not 0 <= i < n:
                raise IndexError("index %d 超出範圍（長度 %d）" % (idx, n))
            return np.array([i]), True
        if isinstance(idx, slice):
            return np.arange(*idx.indices(n)), False
        r = np.asarray(idx)
        if r.dtype == bool:
            r = np.nonzero(r)[0]
        r = r.astype(np.int64).ravel() if r.ndim else r.reshape(1)
        r = np.where(r < 0, r + n, r)
        if r.size and (r.min() < 0 or r.max() >= n):
            raise IndexError("列號超出範圍（長度 %d）" % n)
        return r, False

    def _split(self, key):
        if isinstance(key, tuple):
            return (key[0] if key else slice(None)), key[1:]
        return key, ()

    def __getitem__(self, key):
        k0, rest = self._split(key)
        rows, single = self._rows(k0)
        out = np.empty((len(rows),) + self.shape[1:], dtype=self.dtype)
        n = self._rows_per_page
        if len(rows):
            pnos = rows // n
            for p in np.unique(pnos):
                sel = np.nonzero(pnos == p)[0]
                pg = self._swap.page(self, int(p))
                out[sel] = pg[rows[sel] - int(p) * n]
        if single:
            out = out[0]
            return out[rest] if rest else out
        return out[(slice(None),) + rest] if rest else out

    def __setitem__(self, key, value):
        k0, rest = self._split(key)
        rows, single = self._rows(k0)
        n = self._rows_per_page
        if rest:
            cur = np.array(self[k0], copy=True)
            cur[rest if single else (slice(None),) + rest] = value
            value = cur
        v = np.asarray(value, dtype=self.dtype)
        target = (len(rows),) + self.shape[1:]
        if single and v.shape == self.shape[1:]:
            v = v.reshape((1,) + v.shape)
        v = np.broadcast_to(v, target) if v.shape != target else v
        if len(rows):
            pnos = rows // n
            for p in np.unique(pnos):
                sel = np.nonzero(pnos == p)[0]
                pg = self._swap.page(self, int(p), for_write=True)
                pg[rows[sel] - int(p) * n] = v[sel]

    def fill(self, value):
        self._fill = value
        for p in range(self._npages):
            pg = self._swap.page(self, p, for_write=True)
            pg[...] = value

    def blocks(self, rows=None):
        """依序給 (起始列, 這一塊的複本)。預設一塊＝一頁。"""
        step = rows or self._rows_per_page
        for s in range(0, self.shape[0], step):
            yield s, self[s:s + step]

    def apply(self, fn, rows=None):
        """每一塊 block = fn(block) 後寫回（原地、一塊一塊，記憶體只用一塊的量）。"""
        for s, b in self.blocks(rows):
            r = fn(b)
            self[s:s + len(b)] = b if r is None else r

    def to_numpy(self):
        """整個讀進記憶體（陣列夠小才用）。"""
        return self[:]

    def close(self):
        self._swap.drop_array(self)


_DEFAULT = {"swap": None}


def default():
    s = _DEFAULT["swap"]
    if s is None or s._closed:
        s = _DEFAULT["swap"] = Swap()
    return s


def array(shape, dtype="float64", fill=0):
    return default().array(shape, dtype, fill)


def from_array(a):
    return default().from_array(a)


def stats():
    return default().stats()


def set_hot_mb(mb):
    default().set_hot_bytes(float(mb) * 1048576)


def close():
    s = _DEFAULT["swap"]
    if s is not None:
        s.close()
        _DEFAULT["swap"] = None


atexit.register(close)
