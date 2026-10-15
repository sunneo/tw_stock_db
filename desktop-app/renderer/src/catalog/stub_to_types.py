# 型別存根（.pyi，例如 typeshed 的 stdlib）→ 型別表。只用標準庫（ast），建置時跑一次；產出的 JSON 給單元目錄的 Python 抽取器查（標 type_src:"stub"）。
# 設計見 DESIGN.unit-catalog.md。用法：
#   python stub_to_types.py <存根資料夾> <輸出.json> [--py 3.12] [--platform linux] [模組…]
# 做的事：
#   - 只看模組層級的函式（含 @overload 多載、async def）；類別與類別方法第一版不收。
#   - 照目標 Python 版本與平台選 `if sys.version_info >= (3, 12):`／`if sys.platform == "win32":` 的分支。
#   - TypeVar 展開（有限制條件→聯集、有 bound→bound、都沒有→Any）；模組層級的型別別名（X: TypeAlias = … 或 X = …）展開，跨檔案用簡單名稱對（_typeshed 的 StrPath 之類）。
#   - 多載合併：每個參數的註解取聯集，回傳型別取聯集；不是每個多載都有的參數標成非必填。
import ast, json, os, sys, re

TARGET = {'py': (3, 12), 'platform': 'linux'}


import operator
_OPS = {ast.Gt: operator.gt, ast.GtE: operator.ge, ast.Lt: operator.lt, ast.LtE: operator.le, ast.Eq: operator.eq, ast.NotEq: operator.ne}


def _cmp(op, a, b):
    if isinstance(a, list):
        a = tuple(a)
    return _OPS[type(op)](a, b)


def eval_cond(node):
    """判斷 if 條件在目標版本／平台下是否成立。看不懂的回傳 None（兩個分支都收，後面的覆蓋前面的）。"""
    if isinstance(node, ast.Compare) and len(node.ops) == 1 and isinstance(node.comparators[0], (ast.Tuple, ast.Constant)):
        left, right, op = node.left, node.comparators[0], node.ops[0]
        if isinstance(left, ast.Attribute) and isinstance(left.value, ast.Name) and left.value.id == 'sys' and left.attr == 'version_info' and isinstance(right, ast.Tuple):
            try:
                tup = tuple(e.value for e in right.elts)
            except AttributeError:
                return None
            return _cmp(op, tuple(TARGET['py'])[:len(tup)], tup)
        if isinstance(left, ast.Attribute) and isinstance(left.value, ast.Name) and left.value.id == 'sys' and left.attr == 'platform' and isinstance(right, ast.Constant):
            return _cmp(op, TARGET['platform'], right.value)
        if isinstance(left, ast.Subscript) and isinstance(right, ast.Constant):  # sys.version_info[0] >= 3
            v = left.value
            if isinstance(v, ast.Attribute) and v.attr == 'version_info' and isinstance(left.slice, ast.Constant):
                return _cmp(op, tuple(TARGET['py'])[left.slice.value], right.value)
    if isinstance(node, ast.BoolOp):
        vals = [eval_cond(v) for v in node.values]
        if any(v is None for v in vals):
            return None
        return all(vals) if isinstance(node.op, ast.And) else any(vals)
    if isinstance(node, ast.UnaryOp) and isinstance(node.op, ast.Not):
        v = eval_cond(node.operand)
        return None if v is None else (not v)
    return None


def walk_top(body):
    """攤平模組層級的 if 分支，依目標版本選分支。"""
    for n in body:
        if isinstance(n, ast.If):
            c = eval_cond(n.test)
            if c is True:
                yield from walk_top(n.body)
            elif c is False:
                yield from walk_top(n.orelse)
            else:
                yield from walk_top(n.body)
                yield from walk_top(n.orelse)
        else:
            yield n


class Names(ast.NodeTransformer):
    """把註解裡的 TypeVar 與型別別名換成它們的內容（有深度上限，避免循環）。"""
    def __init__(self, aliases, tvars):
        self.aliases, self.tvars, self.depth = aliases, tvars, 0

    def visit_Name(self, node):
        n = node.id
        if n in self.tvars and self.depth < 6:
            return ast.copy_location(self.tvars[n], node)
        if n in self.aliases and self.depth < 6:
            self.depth += 1
            try:
                return ast.copy_location(self.visit(self.aliases[n]), node)
            finally:
                self.depth -= 1
        return node


def parse_ann(s):
    return ast.parse(s, mode='eval').body


def collect_names(trees):
    """所有存根裡的 TypeVar 與別名（以簡單名稱為鍵；後面的檔案覆蓋前面的）。"""
    aliases, tvars = {}, {}
    for tree in trees:
        for n in walk_top(tree.body):
            targets, value = None, None
            if isinstance(n, ast.Assign) and len(n.targets) == 1 and isinstance(n.targets[0], ast.Name):
                targets, value = n.targets[0].id, n.value
            elif isinstance(n, ast.AnnAssign) and isinstance(n.target, ast.Name) and n.value is not None:
                targets, value = n.target.id, n.value
            if targets is None or value is None:
                continue
            if isinstance(value, ast.Call) and getattr(value.func, 'id', getattr(value.func, 'attr', '')) == 'TypeVar':
                cons = [a for a in value.args[1:]]
                bound = next((k.value for k in value.keywords if k.arg == 'bound'), None)
                if cons:
                    expr = cons[0]
                    for c in cons[1:]:
                        expr = ast.BinOp(left=expr, op=ast.BitOr(), right=c)
                    tvars[targets] = expr
                elif bound is not None:
                    tvars[targets] = bound
                else:
                    tvars[targets] = ast.Name(id='Any', ctx=ast.Load())
            elif isinstance(n, ast.AnnAssign) and 'TypeAlias' in ast.dump(n.annotation) or (isinstance(n, ast.Assign) and re.match(r'^_?[A-Z]', targets) and isinstance(value, (ast.BinOp, ast.Subscript, ast.Name, ast.Attribute))):
                aliases[targets] = value
    return aliases, tvars


def ann_text(node, names):
    if node is None:
        return None
    t = names.visit(ast.fix_missing_locations(ast.parse(ast.unparse(node), mode='eval').body))
    return ast.unparse(t)


def func_proto(fn, names):
    a = fn.args
    params = []
    pos = list(a.posonlyargs) + list(a.args)
    defaults = [None] * (len(pos) - len(a.defaults)) + list(a.defaults)
    for i, arg in enumerate(pos):
        if arg.arg in ('self', 'cls'):
            continue
        params.append({'name': arg.arg, 'kind': 'POSITIONAL_ONLY' if i < len(a.posonlyargs) else 'POSITIONAL_OR_KEYWORD', 'annotation': ann_text(arg.annotation, names), 'has_default': defaults[i] is not None})
    if a.vararg:
        params.append({'name': a.vararg.arg, 'kind': 'VAR_POSITIONAL', 'annotation': ann_text(a.vararg.annotation, names), 'has_default': False})
    for arg, d in zip(a.kwonlyargs, a.kw_defaults):
        params.append({'name': arg.arg, 'kind': 'KEYWORD_ONLY', 'annotation': ann_text(arg.annotation, names), 'has_default': d is not None})
    if a.kwarg:
        params.append({'name': a.kwarg.arg, 'kind': 'VAR_KEYWORD', 'annotation': ann_text(a.kwarg.annotation, names), 'has_default': False})
    return {'params': params, 'returns': ann_text(fn.returns, names)}


def union(a, b):
    if a is None:
        return b
    if b is None or a == b:
        return a
    parts = []
    for x in (a + ' | ' + b).split(' | '):
        if x not in parts:
            parts.append(x)
    return ' | '.join(parts)


def merge_overloads(protos):
    if len(protos) == 1:
        p = protos[0]
        p['overloads'] = 1
        return p
    by = {}
    order = []
    for pr in protos:
        for q in pr['params']:
            if q['name'] not in by:
                by[q['name']] = dict(q)
                by[q['name']]['_n'] = 0
                order.append(q['name'])
            else:
                by[q['name']]['annotation'] = union(by[q['name']]['annotation'], q['annotation'])
                by[q['name']]['has_default'] = by[q['name']]['has_default'] or q['has_default']
            by[q['name']]['_n'] += 1
    params = []
    for k in order:
        q = by[k]
        if q.pop('_n') < len(protos):
            q['has_default'] = True  # 不是每個多載都有的參數＝選填
        params.append(q)
    ret = None
    for pr in protos:
        ret = union(ret, pr['returns'])
    return {'params': params, 'returns': ret, 'overloads': len(protos)}


def convert(stubs):
    """stubs: {模組名稱: .pyi 原始碼}。回傳 {模組名稱: {函式名稱: 原型}}。"""
    trees = {}
    errors = {}
    for mod, src in stubs.items():
        try:
            trees[mod] = ast.parse(src)
        except SyntaxError as e:
            errors[mod] = str(e)
    aliases, tvars = collect_names(list(trees.values()))
    names = Names(aliases, tvars)
    out = {}
    for mod, tree in trees.items():
        groups = {}
        for n in walk_top(tree.body):
            if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)) and not n.name.startswith('_'):
                try:
                    groups.setdefault(n.name, []).append(func_proto(n, names))
                except Exception as e:  # 單一函式失敗不影響其他
                    errors[mod + '.' + n.name] = str(e)[:100]
        if groups:
            out[mod] = {k: merge_overloads(v) for k, v in groups.items()}
    return out, errors


def module_name(root, path):
    rel = os.path.relpath(path, root)[:-4].replace(os.sep, '.')
    return rel[:-9] if rel.endswith('.__init__') else rel


if __name__ == '__main__':
    args = sys.argv[1:]
    if len(args) < 2:
        print(__doc__)
        sys.exit(2)
    root, out_path, rest = args[0], args[1], args[2:]
    mods = []
    i = 0
    while i < len(rest):
        if rest[i] == '--py':
            v = rest[i + 1].split('.')
            TARGET['py'] = (int(v[0]), int(v[1]))
            i += 2
        elif rest[i] == '--platform':
            TARGET['platform'] = rest[i + 1]
            i += 2
        else:
            mods.append(rest[i])
            i += 1
    stubs = {}
    for dp, _, fs in os.walk(root):
        for f in fs:
            if f.endswith('.pyi'):
                m = module_name(root, os.path.join(dp, f))
                if not mods or any(m == x or m.startswith(x + '.') for x in mods) or m in ('_typeshed', 'typing', 'builtins', 'collections.abc'):
                    stubs[m] = open(os.path.join(dp, f), encoding='utf-8').read()
    table, errs = convert(stubs)
    if mods:
        table = {m: v for m, v in table.items() if any(m == x or m.startswith(x + '.') for x in mods)}
    json.dump({'version': 1, 'python': '%d.%d' % TARGET['py'], 'platform': TARGET['platform'], 'modules': table}, open(out_path, 'w', encoding='utf-8'), ensure_ascii=False, separators=(',', ':'))
    print('modules=%d functions=%d errors=%d' % (len(table), sum(len(v) for v in table.values()), len(errs)))
    for k, v in list(errs.items())[:10]:
        print('  ', k, v)
