#!/usr/bin/env python3
"""把「只有一個 main()」的參考解，機械式重構成 讀入／運算／輸出 三個函式（給 gen_code_split.js 用）。

stdin：JSON 陣列 [{id, ref}]；stdout：JSON 陣列 [{id, ok, reason?, functions?:[{name, signature, purpose, calls, src}]}]。

重構規則（純語法，不碰語意；是否等價由 gen_code_split.js 交給判題器驗證，不過就整題丟掉）：
  前段  read_input()：main 開頭連續的「讀取輸入」敘述（含 input() 或 sys.stdin），回傳後面會用到的變數
  後段  main 結尾連續的 print(...) 敘述，留在 main 裡
  中段  solve(...)：其餘敘述；參數是前段定義且中段用到的變數，回傳後段 print 會用到的中段變數
  import 提到模組最上面。
已經有多個函式的參考解（例如 bench_linux_all 的 12 題）不重構，直接用它本來的函式與呼叫關係。
"""
import ast
import json
import sys

RESERVED = {"read_input", "solve"}


def has_input(stmt):
    for n in ast.walk(stmt):
        if isinstance(n, ast.Name) and n.id == "input":
            return True
        if isinstance(n, ast.Attribute) and isinstance(n.value, ast.Name) and n.value.id == "sys" and n.attr in ("stdin",):
            return True
    return False


def is_setup(stmt):
    if isinstance(stmt, (ast.Import, ast.ImportFrom)):
        return True
    return isinstance(stmt, ast.Assign) and isinstance(stmt.value, ast.Constant)


def is_print(stmt):
    if not isinstance(stmt, ast.Expr) or not isinstance(stmt.value, ast.Call):
        return False
    f = stmt.value.func
    if isinstance(f, ast.Name) and f.id == "print":
        return True
    return isinstance(f, ast.Attribute) and f.attr == "write" and isinstance(f.value, ast.Attribute) and f.value.attr == "stdout"


class Names(ast.NodeVisitor):
    """收集 Name 的讀取與寫入；推導式內部的變數是推導式自己的範圍，不算。"""

    def __init__(self):
        self.loads, self.stores, self.order = set(), set(), []

    def visit_Name(self, n):
        if isinstance(n.ctx, ast.Load):
            self.loads.add(n.id)
        else:
            self.stores.add(n.id)
            if n.id not in self.order:
                self.order.append(n.id)

    def _comp(self, n):
        inner = Names()
        for g in n.generators:
            inner.visit(g.iter)
            for i in g.ifs:
                inner.visit(i)
        for part in ([n.elt] if hasattr(n, "elt") else [n.key, n.value]):
            inner.visit(part)
        # 推導式裡 Store 的名稱是區域的；只有「讀取」要往外傳（且要排除推導式自己的區域名稱）
        self.loads |= inner.loads - inner.stores

    visit_ListComp = visit_SetComp = visit_GeneratorExp = visit_DictComp = _comp

    def visit_FunctionDef(self, n):  # 內層函式：只看它讀了哪些外面的名稱（保守地全算讀取）
        inner = Names()
        for s in n.body:
            inner.visit(s)
        self.loads |= inner.loads
        self.stores.add(n.name)
        if n.name not in self.order:
            self.order.append(n.name)


def collect(stmts):
    v = Names()
    for s in stmts:
        v.visit(s)
    return v


def unparse_fn(name, params, body, ret_names):
    body = list(body)
    if ret_names:
        val = ast.Name(id=ret_names[0], ctx=ast.Load()) if len(ret_names) == 1 else ast.Tuple(elts=[ast.Name(id=n, ctx=ast.Load()) for n in ret_names], ctx=ast.Load())
        body.append(ast.Return(value=val))
    if not body:
        body = [ast.Pass()]
    fn = ast.FunctionDef(name=name, args=ast.arguments(posonlyargs=[], args=[ast.arg(arg=p) for p in params], kwonlyargs=[], kw_defaults=[], defaults=[]), body=body, decorator_list=[], type_params=[])
    ast.fix_missing_locations(fn)
    return ast.unparse(fn)


def assign_call(names, call_name, args):
    call = ast.Call(func=ast.Name(id=call_name, ctx=ast.Load()), args=[ast.Name(id=a, ctx=ast.Load()) for a in args], keywords=[])
    if not names:
        return ast.Expr(value=call)
    tgt = ast.Name(id=names[0], ctx=ast.Store()) if len(names) == 1 else ast.Tuple(elts=[ast.Name(id=n, ctx=ast.Store()) for n in names], ctx=ast.Store())
    return ast.Assign(targets=[tgt], value=call)


def sig(name, params):
    return name + "(" + ", ".join(params) + ")"


def from_existing(tree, fns):
    """多函式參考解：用它本來的函式與呼叫關係。"""
    names = [f.name for f in fns]
    out = []
    for f in fns:
        calls = []
        for n in ast.walk(f):
            if isinstance(n, ast.Call) and isinstance(n.func, ast.Name) and n.func.id in names and n.func.id != f.name and n.func.id not in calls:
                calls.append(n.func.id)
        params = [a.arg for a in f.args.args]
        out.append({"name": f.name, "signature": sig(f.name, params), "purpose": "", "calls": calls, "src": ast.unparse(f)})
    imports = [ast.unparse(n) for n in tree.body if isinstance(n, (ast.Import, ast.ImportFrom))]
    return out, imports


def refactor(ref):
    tree = ast.parse(ref)
    fns = [n for n in tree.body if isinstance(n, ast.FunctionDef)]
    if not any(f.name == "main" for f in fns):
        return None, "沒有 main"
    if len(fns) > 1:
        out, imports = from_existing(tree, fns)
        return {"functions": out, "imports": imports, "mode": "existing"}, None
    main = fns[0]
    body = list(main.body)
    if body and isinstance(body[0], ast.Expr) and isinstance(body[0].value, ast.Constant) and isinstance(body[0].value.value, str):
        body = body[1:]
    imports_in = [s for s in body if isinstance(s, (ast.Import, ast.ImportFrom))]
    body = [s for s in body if not isinstance(s, (ast.Import, ast.ImportFrom))]
    imports = [ast.unparse(n) for n in tree.body if isinstance(n, (ast.Import, ast.ImportFrom))] + [ast.unparse(n) for n in imports_in]
    for n in ast.walk(main):
        if isinstance(n, (ast.Return, ast.Yield, ast.YieldFrom, ast.Global, ast.Nonlocal, ast.AsyncFunctionDef)):
            return None, "main 裡有 return／yield／global／nonlocal"
    allnames = collect(main.body)
    if allnames.stores & RESERVED or allnames.loads & RESERVED:
        return None, "變數名稱和 read_input／solve 衝突"
    # 前段：開頭連續的（含 input 或設定）敘述，到最後一個含 input 的
    last = -1
    i = 0
    while i < len(body) and (has_input(body[i]) or is_setup(body[i])):
        if has_input(body[i]):
            last = i
        i += 1
    if last < 0:
        return None, "開頭沒有讀取輸入"
    prefix, rest = body[: last + 1], body[last + 1:]
    j = len(rest)
    while j > 0 and is_print(rest[j - 1]):
        j -= 1
    middle, suffix = rest[:j], rest[j:]
    if not middle:
        return None, "沒有中段運算"
    pre, mid, suf = collect(prefix), collect(middle), collect(suffix)
    later = mid.loads | suf.loads
    read_out = [n for n in pre.order if n in later]
    if not read_out:
        return None, "前段沒有東西傳給後面"
    solve_in = [n for n in read_out if n in mid.loads]
    solve_out = [n for n in mid.order if n in suf.loads]
    if suffix and not solve_out:
        return None, "後段 print 沒有用到中段的結果"
    if not suffix:
        solve_out = []  # solve 自己印
    fn_read = unparse_fn("read_input", [], prefix, read_out)
    fn_solve = unparse_fn("solve", solve_in, middle, solve_out)
    main_body = [assign_call(read_out, "read_input", [])]
    main_body.append(assign_call(solve_out, "solve", solve_in))
    main_body += suffix
    fn_main = unparse_fn("main", [], main_body, [])
    funcs = [
        {"name": "read_input", "signature": sig("read_input", []), "purpose": "讀入全部輸入", "calls": [], "src": fn_read},
        {"name": "solve", "signature": sig("solve", solve_in), "purpose": "做主要運算" if solve_out else "做主要運算並輸出答案", "calls": [], "src": fn_solve},
        {"name": "main", "signature": "main()", "purpose": "讀入全部輸入、呼叫其他函式、輸出答案", "calls": ["read_input", "solve"], "src": fn_main},
    ]
    return {"functions": funcs, "imports": imports, "mode": "refactor"}, None


def main():
    items = json.load(sys.stdin)
    out = []
    for it in items:
        try:
            r, why = refactor(it["ref"])
        except Exception as e:  # noqa: BLE001
            r, why = None, "例外：" + type(e).__name__ + " " + str(e)[:80]
        out.append({"id": it["id"], "ok": r is not None, "reason": why, **(r or {})})
    json.dump(out, sys.stdout, ensure_ascii=False)


if __name__ == "__main__":
    main()
