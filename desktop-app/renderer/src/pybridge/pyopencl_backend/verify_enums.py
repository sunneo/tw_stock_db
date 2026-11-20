# 用 Khronos 的 cl.h（https://github.com/KhronosGroup/OpenCL-Headers 的 CL/cl.h）逐項核對 _cl.py 的列舉值。
# 用法：python3 -I verify_enums.py <標頭路徑，以 os.pathsep 分隔：cl.h:cl_ext.h:cl_gl.h> [_cl.py 所在資料夾，預設是這個檔案的資料夾]
# 2026-11-20 的結果（cl.h 版權年 2008-2026）：一致 154、不符 0；PLATFORM_NOT_FOUND_KHR（-1001）在 cl_ext.h，無法用 cl.h 核對。
import re, sys
import os
hdrs = sys.argv[1].split(os.pathsep)
here = sys.argv[2] if len(sys.argv) > 2 else os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, here)
import _cl
defs = {}
for hdr in hdrs:
    for line in open(hdr, encoding="utf-8"):
        m = re.match(r"#define\s+(CL_[A-Z0-9_]+)\s+(.+?)\s*(?:/\*.*)?$", line.rstrip())
        if m: defs.setdefault(m.group(1), m.group(2).strip())
def val(expr):
    e = re.sub(r"\(cl_\w+\)", "", expr)           # 去掉 (cl_bitfield) 之類的轉型
    e = re.sub(r"\b(0x[0-9A-Fa-f]+)[uU]?[lL]*\b", r"\1", e)
    try: return int(eval(e, {"__builtins__": {}}, {}))
    except Exception: return None
def resolve(name, seen=()):
    if name not in defs or name in seen: return None
    ex = defs[name].strip("()")
    if re.fullmatch(r"CL_[A-Z0-9_]+", ex): return resolve(ex, seen + (name,))
    return val(defs[name])
PREFIX = {"status_code": ["CL_"], "platform_info": ["CL_PLATFORM_"], "device_info": ["CL_DEVICE_", "CL_"], "device_type": ["CL_DEVICE_TYPE_"],
          "context_info": ["CL_CONTEXT_"], "command_queue_info": ["CL_QUEUE_"], "command_queue_properties": ["CL_QUEUE_"],
          "mem_flags": ["CL_MEM_"], "mem_info": ["CL_MEM_"], "mem_object_type": ["CL_MEM_OBJECT_"], "program_info": ["CL_PROGRAM_"],
          "program_build_info": ["CL_PROGRAM_BUILD_", "CL_PROGRAM_"], "kernel_info": ["CL_KERNEL_"], "kernel_work_group_info": ["CL_KERNEL_"],
          "event_info": ["CL_EVENT_"], "command_type": ["CL_COMMAND_"], "command_execution_status": ["CL_"], "profiling_info": ["CL_PROFILING_COMMAND_"], "gl_object_type": ["CL_GL_OBJECT_"]}
SKIP = {("program_kind", None), ("command_queue_properties", "_zero")}   # pyopencl 自己的列舉／補的零值，標頭沒有
ok = bad = unk = 0
for en, prefs in PREFIX.items():
    cls = getattr(_cl, en)
    for k, v in cls.__dict__.items():
        if k.startswith("_") or k == "to_string": continue
        got = None
        for p in prefs:
            got = resolve(p + k)
            if got is not None: break
        if got is None:
            unk += 1; print("無法核對（標頭沒有 %s*%s）：%s.%s = %s" % (prefs[0], k, en, k, v)); continue
        if got == v: ok += 1
        else: bad += 1; print("不符：%s.%s 我寫 %s，標頭 %s" % (en, k, hex(v) if v >= 0 else v, hex(got) if got >= 0 else got))
print("一致 %d、不符 %d、標頭裡找不到 %d" % (ok, bad, unk))
