# 單元目錄的 Python 抽取器（只用標準庫；在 Pyodide 或一般 CPython 裡都能跑）。設計見 DESIGN.unit-catalog.md 第三、四、五節。
# 用法：JS 端把 REQ 那一行的占位符換成請求（JSON 字串的字面值）再執行；輸出一行 "FA_EXTRACT_RESULT:" + JSON。
#   請求：{"modules": ["statistics", ...], "max_per_module": 400, "doctest": true}
# 這個腳本只「讀」：不呼叫任何被抽取的函式（doctest 範例只當文字存起來，之後在沙盒裡驗證才會執行）。
import sys, json, inspect, importlib, re, ast

REQ = json.loads(__FA_REQ__)
for _p in REQ.get('sys_path', []):  # 測試用：把暫存資料夾加進搜尋路徑
    sys.path.insert(0, _p)

# 匯入不明的模組會執行它的程式碼：匯入期間用稽核掛鉤擋下網路、子行程、開瀏覽器、系統呼叫（不擋 open：匯入系統自己要讀檔）。
_BLOCK_IMPORT = {'os.system', 'os.exec', 'os.posix_spawn', 'os.spawn', 'os.fork', 'os.forkpty', 'webbrowser.open', 'ctypes.dlopen'}
_imp = {'armed': False}


def _import_hook(event, args):
    if _imp['armed'] and (event in _BLOCK_IMPORT or event.startswith('socket.') or event.startswith('subprocess.')):
        raise RuntimeError('blocked-at-import:' + event)


try:
    sys.addaudithook(_import_hook)
except Exception:
    pass

# 副作用：整個模組的規則（不執行任何東西）。沒有列出的模組一律 unknown（保守）。
PURE_MODULES = set('json re math cmath statistics string textwrap base64 binascii hashlib hmac zlib html operator itertools functools collections urllib.parse difflib fractions decimal bisect heapq copy unicodedata struct csv shlex pprint numbers keyword token fnmatch posixpath ntpath colorsys calendar'.split())
EFFECT_MODULES = {
    'os': ['fs.read', 'fs.write', 'env', 'proc'], 'shutil': ['fs.read', 'fs.write'], 'subprocess': ['proc'], 'socket': ['net'], 'ssl': ['net'], 'urllib.request': ['net'],
    'http.client': ['net'], 'ftplib': ['net'], 'smtplib': ['net'], 'random': ['random'], 'secrets': ['random'], 'time': ['time'], 'tempfile': ['fs.write'], 'glob': ['fs.read'],
    'pathlib': ['fs.read', 'fs.write'], 'sqlite3': ['fs.write'], 'webbrowser': ['proc', 'ui'], 'ctypes': ['proc'], 'multiprocessing': ['proc'], 'threading': ['proc'], 'sys': ['env'],
    'datetime': ['time'], 'logging': ['ui'], 'pickle': ['fs.read', 'fs.write'], 'shelve': ['fs.write'], 'zipfile': ['fs.read', 'fs.write'], 'tarfile': ['fs.read', 'fs.write'],
}
FS_READ_NAMES = re.compile(r'^(exists|lexists|isfile|isdir|islink|ismount|getsize|getmtime|getatime|getctime|realpath|samefile|samestat|sameopenfile)$')


def type_name(a):
    if a is inspect.Parameter.empty or a is inspect.Signature.empty:
        return None
    if isinstance(a, str):
        return a
    n = getattr(a, '__name__', None)
    if n and not getattr(a, '__args__', None):
        return n
    return str(a).replace('typing.', '')


def first_para(doc):
    doc = (doc or '').strip()
    if not doc:
        return ''
    para = re.split(r'\n\s*\n', doc, maxsplit=1)[0]
    return re.sub(r'\s+', ' ', para)[:300]


def sig_from_doc(name, doc):
    # C 實作的函式 inspect 拿不到簽名時，試著解析文件字串第一行 name(a, b, /, *, c=1)
    first = (doc or '').strip().split('\n', 1)[0]
    m = re.match(r'^' + re.escape(name) + r'\((.*)\)\s*(?:->.*)?$', first)
    if not m:
        return None
    params, seen_star = [], False
    for part in [x.strip() for x in m.group(1).split(',') if x.strip()]:
        if part == '/':
            for p in params:
                if p['kind'] == 'POSITIONAL_OR_KEYWORD':
                    p['kind'] = 'POSITIONAL_ONLY'
            continue
        if part == '*':
            seen_star = True
            continue
        default = None
        if '=' in part:
            part, default = [x.strip() for x in part.split('=', 1)]
        kind = 'VAR_POSITIONAL' if part.startswith('**') is False and part.startswith('*') else ('VAR_KEYWORD' if part.startswith('**') else ('KEYWORD_ONLY' if seen_star else 'POSITIONAL_OR_KEYWORD'))
        params.append({'name': part.lstrip('*'), 'kind': kind, 'default': default, 'annotation': None})
    return params


def doctests(doc, limit=3):
    out, lines = [], (doc or '').split('\n')
    i = 0
    while i < len(lines) and len(out) < limit:
        s = lines[i].strip()
        if s.startswith('>>> '):
            expr = s[4:].strip()
            exp, j = [], i + 1
            while j < len(lines) and lines[j].strip() and not lines[j].strip().startswith('>>>') and not lines[j].strip().startswith('...'):
                exp.append(lines[j].strip())
                j += 1
            try:
                ast.parse(expr, mode='eval')
                ok = True
            except SyntaxError:
                ok = False
            e = ' '.join(exp)
            if ok and e and '<' not in e and 'Traceback' not in e and len(expr) < 200 and len(e) < 200:
                out.append({'expr': expr, 'expect': e, 'src': 'doctest'})
            i = j
        else:
            i += 1
    return out


RISKY_IMPORTS = set('os shutil subprocess socket ssl urllib.request http.client http.server ftplib smtplib poplib imaplib telnetlib tempfile glob pathlib sqlite3 webbrowser ctypes multiprocessing threading pickle shelve zipfile tarfile requests urllib3 httpx aiohttp asyncio selectors signal pty fcntl mmap'.split())
RISKY_CALLS = {'open', 'eval', 'exec', 'compile', '__import__', 'input', 'breakpoint', 'system', 'popen'}


def static_pure(mod):
    # 第三方模組的靜態判斷：看模組原始碼有沒有匯入會碰檔案／網路／行程的模組、有沒有呼叫 open／exec 之類。
    # 只看這一個檔案：它呼叫的別的模組可能做事——所以結果只是「疑似純」，一定要探測驗證（探測時稽核掛鉤會擋）才能信任。
    try:
        import inspect as _i
        src = _i.getsource(mod)
    except Exception:
        return False
    try:
        tree = ast.parse(src)
    except SyntaxError:
        return False
    for n in ast.walk(tree):
        if isinstance(n, ast.Import):
            if any(a.name in RISKY_IMPORTS or a.name.split('.')[0] in RISKY_IMPORTS for a in n.names):
                return False
        elif isinstance(n, ast.ImportFrom):
            m = n.module or ''
            if m in RISKY_IMPORTS or m.split('.')[0] in RISKY_IMPORTS:
                return False
        elif isinstance(n, ast.Call):
            f = n.func
            name = f.id if isinstance(f, ast.Name) else (f.attr if isinstance(f, ast.Attribute) else '')
            if name in RISKY_CALLS:
                return False
    return True


def effects_for(modname, fname):
    if modname in PURE_MODULES:
        return [], True
    if modname in ('os.path',):
        return (['fs.read'], False) if FS_READ_NAMES.match(fname) else ([], True)
    if modname == 'datetime':
        return (['time'], False) if re.match(r'^(now|today|utcnow|fromtimestamp)$', fname) else ([], True)
    eff = EFFECT_MODULES.get(modname)
    return (list(eff), False) if eff else (['unknown'], False)


def stdlib(modname):
    top = modname.split('.')[0]
    names = getattr(sys, 'stdlib_module_names', None)
    return top in names if names else top in sys.builtin_module_names


def extract(modname):
    _imp['armed'] = True
    try:
        mod = importlib.import_module(modname)
    finally:
        _imp['armed'] = False
    names = list(getattr(mod, '__all__', None) or [n for n in dir(mod) if not n.startswith('_')])
    protos, skipped = [], 0
    static_ok = (not stdlib(modname)) and static_pure(mod)
    for n in names[: REQ.get('max_per_module', 400)]:
        o = getattr(mod, n, None)
        if o is None or not callable(o) or inspect.isclass(o):
            skipped += 1
            continue
        doc = inspect.getdoc(o) or ''
        params, sig_src, ret = None, None, None
        try:
            s = inspect.signature(o)
            params = [{'name': p.name, 'kind': p.kind.name, 'default': None if p.default is p.empty else repr(p.default)[:80], 'annotation': type_name(p.annotation)} for p in s.parameters.values()]
            ret = type_name(s.return_annotation)
            sig_src = 'inspect'
        except (ValueError, TypeError):
            params = sig_from_doc(n, doc)
            sig_src = 'doc' if params is not None else None
        eff, pure = effects_for(modname, n)
        pure_src = 'allowlist' if pure else None
        if not pure and not stdlib(modname) and eff == ['unknown'] and static_ok:
            eff, pure, pure_src = [], True, 'static'
        protos.append({
            'module': modname, 'name': n, 'summary': first_para(doc), 'params': params, 'sig_src': sig_src, 'returns': ret,
            'effects': eff, 'pure': pure, 'pure_src': pure_src, 'stdlib': stdlib(modname), 'version': getattr(mod, '__version__', None),
            'tests': doctests(doc) if REQ.get('doctest', True) else [], 'has_doc': bool(doc),
        })
    return protos, skipped


res = {'ok': True, 'python': sys.version.split()[0], 'modules': {}, 'protos': [], 'errors': []}
for m in REQ.get('modules', []):
    try:
        protos, skipped = extract(m)
        res['modules'][m] = {'callables': len(protos), 'skipped': skipped}
        res['protos'].extend(protos)
    except Exception as e:  # 載入不了的模組（沒安裝、缺原生套件）只記錄，不中斷
        res['errors'].append({'module': m, 'error': type(e).__name__ + ': ' + str(e)[:200]})
pv = {}
for n in REQ.get('packages', []):  # 安裝的套件實際版本（之後套件升版要標過期）
    try:
        import importlib.metadata as _md
        pv[n.split('==')[0]] = _md.version(n.split('==')[0])
    except Exception:
        pv[n.split('==')[0]] = None
res['pkg_versions'] = pv
print('FA_EXTRACT_RESULT:' + json.dumps(res, ensure_ascii=False))
