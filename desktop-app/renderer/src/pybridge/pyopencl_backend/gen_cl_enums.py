# -*- coding: utf-8 -*-
"""產生 _cl.py 裡的列舉區塊（位於 `# <<<GENERATED ENUMS` 與 `# GENERATED ENUMS>>>` 之間）。

來源：
  - 真 pyopencl 的 `_cl.pyi`（型別存根）：列舉類別與成員的名單（它只寫 `auto()`，沒有數值；少數成員有明確數值就直接用）。
  - Khronos 的 `CL/cl.h`：數值。每個成員用「類別專屬前綴＋成員名」在標頭裡找 `#define`；找不到就**不產生**，列在 `_UNRESOLVED`，不編造。
  - 手動補充 EXTRA：標頭以外的、已知值但這裡無法核對的（逐項標明原因）。

用法：python3 -I gen_cl_enums.py <_cl.pyi> <標頭，以 os.pathsep 分隔：cl.h:cl_ext.h:cl_gl.h> [_cl.py，預設是這個檔案旁邊的 _cl.py]   （重複執行結果相同）
下載來源與核對紀錄見 DESIGN.pyopencl.md §7.2。pyi 與 cl.h 不隨產品出貨；產生出來的區塊才是產品的一部分。"""
import os
import re
import sys

pyi_path, hdr_paths = sys.argv[1], sys.argv[2].split(os.pathsep)
cl_py = sys.argv[3] if len(sys.argv) > 3 else os.path.join(os.path.dirname(os.path.abspath(__file__)), "_cl.py")

# ---- 標頭：#define → 整數 ----
defs = {}
for hp in hdr_paths:
    for line in open(hp, encoding="utf-8"):
        m = re.match(r"#define\s+(CL_[A-Z0-9_]+)\s+(.+?)\s*(?:/\*.*)?$", line.rstrip())
        if m:
            defs.setdefault(m.group(1), m.group(2).strip())


def _val(expr, depth=0):
    e = re.sub(r"\(cl_\w+\)", "", expr)
    e = re.sub(r"\b(0x[0-9A-Fa-f]+)[uU]?[lL]*\b", r"\1", e)
    # 表達式裡引用別的 #define（例如 ((1 << CL_VERSION_MAJOR_BITS) - 1)）：先代入它們的值
    for ref in set(re.findall(r"\bCL_[A-Z0-9_]+\b", e)):
        rv = resolve(ref) if depth < 8 else None
        if rv is None:
            return None
        e = re.sub(r"\b%s\b" % ref, str(rv), e)
    try:
        return int(eval(e, {"__builtins__": {}}, {}))
    except Exception:  # noqa: BLE001
        return None


def resolve(name, seen=()):
    if name not in defs or name in seen:
        return None
    ex = defs[name].strip("()")
    if re.fullmatch(r"CL_[A-Z0-9_]+", ex):
        return resolve(ex, seen + (name,))
    return _val(defs[name], len(seen))


# ---- 存根：列舉類別 ----
pyi = open(pyi_path, encoding="utf-8").read()
enums = []   # (類別, [(成員, 明確值或 None)])
for m in re.finditer(r"^class (\w+)\((?:IntEnum|IntFlag|Flag|Enum)\)[^\n]*\n((?:    [^\n]*\n|\n)+)", pyi, re.M):
    mem = []
    for mm in re.finditer(r"^    ([A-Za-z_][A-Za-z_0-9]*)\s*=\s*(auto\(\)|0x[0-9A-Fa-f]+|-?\d+)\s*$", m.group(2), re.M):
        mem.append((mm.group(1), None if mm.group(2) == "auto()" else int(mm.group(2), 0)))
    enums.append((m.group(1), mem))

prefixes = set()
for k in defs:
    parts = k.split("_")
    for i in range(1, len(parts)):
        prefixes.add("_".join(parts[:i]) + "_")

# 最佳前綴涵蓋率低但確認正確的類別（目前沒有；有就在這裡逐一列出理由）
LOW_MATCH_OK = set()

# 標頭的命名與最佳前綴不同的成員：類別 → 額外要試的前綴
ALT_PREFIX = {"program_build_info": ["CL_PROGRAM_"], "device_info": ["CL_"]}

# 標頭以外、已知值但無法用 cl.h 核對的成員（逐項標明）
EXTRA = {}   # 以前手補的 -1001（cl_ext.h）與 gl_object_type 四值（cl_gl.h）現在都由標頭產生並核對，不再手補

# pyopencl 自己的列舉（不是標頭的）：數值是這個後端自己定的，只在 pyopencl 的純 Python 層內部比對，不與 OpenCL 交換
OWN = {"program_kind": {"UNKNOWN": 0, "SOURCE": 1, "BINARY": 2, "IL": 3}}

# 存根沒列、但標頭有的成員（真 _cl 的 C++ 在 have_gl 時才把 GL 屬性加進 context_properties／status_code）：類別 → {成員: 標頭巨集名}；值從標頭解析，所以是核對過的
EXTRA_FROM_HEADER = {
    "context_properties": {"GL_CONTEXT_KHR": "CL_GL_CONTEXT_KHR", "EGL_DISPLAY_KHR": "CL_EGL_DISPLAY_KHR", "GLX_DISPLAY_KHR": "CL_GLX_DISPLAY_KHR",
                           "WGL_HDC_KHR": "CL_WGL_HDC_KHR", "CGL_SHAREGROUP_KHR": "CL_CGL_SHAREGROUP_KHR"},
    "status_code": {"INVALID_GL_SHAREGROUP_REFERENCE_KHR": "CL_INVALID_GL_SHAREGROUP_REFERENCE_KHR"},
}

out = []
unresolved = {}
nres = ntot = 0
for en, mem in enums:
    names = [n for n, _ in mem]
    best, bp = 0, None
    for p in prefixes:
        c = sum(1 for n in names if (p + n) in defs)
        if c > best:
            best, bp = c, p
    # 前綴只涵蓋不到一半成員，多半是巧合（例如 gl_object_type 的 BUFFER 會誤對到 CL_DEVICE_SVM_COARSE_GRAIN_BUFFER）：寧可不自動對應，列為未解決
    if bp and best * 2 < len(names) and en not in LOW_MATCH_OK:
        print("警告：%s 的最佳前綴 %s 只涵蓋 %d／%d 個成員，不自動對應（列為未解決）" % (en, bp, best, len(names)))
        bp = None
    members = {}
    for n, explicit in mem:
        ntot += 1
        v = None
        for p in ([bp] + ALT_PREFIX.get(en, []) + ["CL_"] if bp else ALT_PREFIX.get(en, [])):
            v = resolve(p + n) if p else None
            if v is not None:
                break
        if explicit is not None:
            if v is not None and v != explicit:
                raise SystemExit("存根與標頭不一致：%s.%s 存根 %s、標頭 %s" % (en, n, explicit, v))
            v = explicit
        if v is None and n in EXTRA.get(en, {}):
            v = EXTRA[en][n]
        if v is None and n in OWN.get(en, {}):
            v = OWN[en][n]
        if v is None:
            unresolved.setdefault(en, []).append(n)
        else:
            members[n] = v
            nres += 1
    if en == "status_code":   # 標頭裡所有負值的 CL_* 錯誤碼都收（存根的名單不全，例如缺 INVALID_PROPERTY）
        for macro in sorted(defs):
            v = resolve(macro)
            nm = macro[3:]
            if v is not None and v < 0 and nm not in members and re.fullmatch(r"[A-Z0-9_]+", nm) and not nm.endswith(("_MASK",)):
                members[nm] = v
                nres += 1
                ntot += 1
    for n, macro in EXTRA_FROM_HEADER.get(en, {}).items():
        v = resolve(macro)
        if v is None:
            unresolved.setdefault(en, []).append(n)
        else:
            members[n] = v
            nres += 1
            ntot += 1
    out.append((en, members))


def fmt(v):
    return str(v) if v < 256 else hex(v)


lines = ["# <<<GENERATED ENUMS（由 gen_cl_enums.py 產生，不要手改；數值取自 CL/cl.h 或存根的明確值）"]
for en, members in out:
    body = ", ".join("%s: %s" % (repr(k), fmt(v)) for k, v in members.items())
    lines.append("%s = _enum(%r, {%s})" % (en, en, body))
lines.append("# 對不到標頭的成員（多半在 cl_ext.h／cl_gl.h，這些標頭沒下載）；沒有編造數值，所以這些成員在 _cl 裡不存在：")
lines.append("_UNRESOLVED = %r" % (unresolved,))
lines.append("# GENERATED ENUMS>>>")
block = "\n".join(lines)

src = open(cl_py, encoding="utf-8").read()
a, b = src.find("# <<<GENERATED ENUMS"), src.find("# GENERATED ENUMS>>>")
if a < 0 or b < 0:
    raise SystemExit("_cl.py 裡沒有 GENERATED ENUMS 標記")
src = src[:a] + block + src[b + len("# GENERATED ENUMS>>>"):]
open(cl_py, "w", encoding="utf-8").write(src)
print("列舉類別 %d；成員 %d／%d 有數值；未解決 %d" % (len(out), nres, ntot, ntot - nres))
