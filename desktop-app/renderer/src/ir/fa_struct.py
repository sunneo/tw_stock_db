"""結構轉換 runtime tool（Python 端）：JSON 型別 <-> 各語言資料結構，含 load / save 介面。

後端是同目錄的 fa_struct.js（nodejs）；兩邊介面一樣。設計與用法見 DESIGN.core-ir.md 第 15 節。

用法（Python 3.6+，需要 node 在 PATH，或設環境變數 FA_NODE 指向 node 執行檔）：

    import fa_struct
    schema = fa_struct.infer('{"id": 1, "tags": ["a"]}', name="Item")   # 範例 JSON（字串、檔案路徑或物件）-> 結構描述(dict)
    schema = fa_struct.from_desc({"id": "int", "nick?": "str"})         # 型別描述 -> 結構描述
    fa_struct.save_schema(schema, "item.schema.json")                   # 存成檔案；不給 path 回傳字串
    schema = fa_struct.load_schema("item.schema.json")                  # 從檔案或字串讀入
    r = fa_struct.generate(schema, "cpp", main=True)                    # -> {"ok","code","marshal","notes"}
    code = fa_struct.convert('{"id": 1}', "python")["code"]             # 範例 -> 目標語言程式碼，一步到位
"""
import json
import os
import subprocess

_HERE = os.path.dirname(os.path.abspath(__file__))
_CLI = os.path.join(_HERE, "fa_struct.js")
LANGS = ["cpp", "c", "python", "nodejs", "java", "csharp"]


def _rpc(cmd, *args):
    node = os.environ.get("FA_NODE", "node")
    req = json.dumps({"cmd": cmd, "args": list(args)}, ensure_ascii=False)
    p = subprocess.run([node, _CLI, "--rpc"], input=req.encode("utf-8"), stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=60)
    out = p.stdout.decode("utf-8", "replace").strip()
    if not out:
        raise RuntimeError("fa_struct 後端沒有回應：" + p.stderr.decode("utf-8", "replace")[:300])
    r = json.loads(out)
    if not r.get("ok"):
        raise ValueError(r.get("error", "未知錯誤"))
    return r["result"]


def infer(sample, name="Root"):
    """由範例 JSON（字串、檔案路徑、已解開的物件，或它們的 list）推出結構描述。"""
    return _rpc("infer", sample, {"name": name})


def from_desc(desc, name="Root"):
    """由型別描述（dict 或 JSON 字串／檔案）建結構描述。"""
    return _rpc("fromDesc", desc, {"name": name})


def load_schema(src):
    """從字串或檔案讀入結構描述（fa-struct v1）。"""
    return _rpc("loadSchema", src)


def save_schema(schema, path=None):
    """存結構描述：給 path 就寫檔並回傳 path，沒給就回傳 JSON 字串。"""
    return _rpc("saveSchema", schema, path)


def generate(schema, lang, main=False, out=None, name="Root"):
    """產生目標語言的型別宣告（cpp / c 還有 load、save 函式）。schema 可以是結構描述或範例 JSON。"""
    return _rpc("generate", schema, lang, {"main": main, "out": out, "name": name})


def convert(src, lang, name="Root", out=None):
    """範例 JSON 或結構描述 -> 目標語言程式碼。"""
    return _rpc("convert", src, lang, {"name": name, "out": out})
