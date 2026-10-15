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


SYS_PURE_CALLS = {'getsizeof', 'getrecursionlimit', 'intern', 'getdefaultencoding', 'getfilesystemencoding', 'is_finalizing', 'exc_info', 'getrefcount'}
DANGER_METHODS = {  # 接收者不明的方法呼叫：名稱幾乎只會做這件事的才算（read／write／remove 太常見，在 list、檔案物件、參數上都有，不算）
    'connect': 'net', 'send': 'net', 'sendall': 'net', 'recv': 'net', 'sendto': 'net', 'recvfrom': 'net', 'urlopen': 'net', 'getaddrinfo': 'net',
    'popen': 'proc', 'system': 'proc', 'communicate': 'proc', 'unlink': 'fs.write', 'rmdir': 'fs.write', 'mkdir': 'fs.write', 'makedirs': 'fs.write',
    'write_text': 'fs.write', 'write_bytes': 'fs.write', 'read_text': 'fs.read', 'read_bytes': 'fs.read', 'touch': 'fs.write', 'rename': 'fs.write',
    'iterdir': 'fs.read', 'listdir': 'fs.read', 'rglob': 'fs.read', 'glob': 'fs.read', 'exists': 'fs.read', 'is_file': 'fs.read', 'is_dir': 'fs.read', 'stat': 'fs.read',
}
MUTATORS = {'append', 'extend', 'update', 'add', 'pop', 'clear', 'setdefault', 'insert', 'remove', 'discard', 'popitem', 'sort', 'reverse'}
BUILTIN_UI = {'print', 'input'}
BUILTIN_UNKNOWN = {'eval', 'exec', 'compile', '__import__'}
NET_LIBS = {'requests', 'httpx', 'urllib3', 'aiohttp', 'websockets', 'websocket', 'paramiko', 'boto3', 'botocore', 'grpc', 'pymysql', 'psycopg2', 'redis', 'pymongo'}  # 常見的第三方網路函式庫：呼叫它們就是 net
SUMMARIES = {}  # 這次抽取裡已經分析過的第三方模組：{模組: {名稱: (效果集合, 證據)}}，後面的模組呼叫它們時用


def open_effects(call):
    mode = None
    if len(call.args) >= 2 and isinstance(call.args[1], ast.Constant) and isinstance(call.args[1].value, str):
        mode = call.args[1].value
    elif len(call.args) >= 2:
        return {'fs.read', 'fs.write'}  # 模式不是常數字串：兩種都算
    for k in call.keywords:
        if k.arg == 'mode':
            if isinstance(k.value, ast.Constant) and isinstance(k.value.value, str):
                mode = k.value.value
            else:
                return {'fs.read', 'fs.write'}
    if mode is None or not any(c in mode for c in 'wax+'):
        return {'fs.read'}
    return {'fs.write', 'fs.read'} if ('+' in mode) else {'fs.write'}


OS_FUNCS = {}
for _n in 'listdir scandir stat lstat walk getcwd getcwdb readlink access fwalk statvfs path_exists'.split():
    OS_FUNCS[_n] = {'fs.read'}
for _n in 'remove unlink rename renames replace rmdir removedirs mkdir makedirs chmod chown lchown truncate symlink link utime mkfifo mknod chdir chroot sync'.split():
    OS_FUNCS[_n] = {'fs.write'}
for _n in 'getenv getenvb putenv unsetenv getlogin uname environ_get'.split():
    OS_FUNCS[_n] = {'env'}
for _n in 'system popen execv execve execl execle execlp execlpe execvp execvpe spawnl spawnle spawnv spawnve spawnvp spawnlp fork forkpty kill killpg startfile abort _exit wait waitpid'.split():
    OS_FUNCS[_n] = {'proc'}
OS_FUNCS['urandom'] = {'random'}
OS_PURE = set('fsencode fsdecode fspath cpu_count getpid getppid strerror get_terminal_size fdopen_none sep getuid getgid get_exec_path'.split())
PATHLIB_PURE = {'Path', 'PurePath', 'PurePosixPath', 'PureWindowsPath', 'PosixPath', 'WindowsPath'}
THREAD_PURE = {'Lock', 'RLock', 'Event', 'local', 'Semaphore', 'BoundedSemaphore', 'Condition', 'Barrier', 'current_thread', 'get_ident', 'active_count'}


def module_call_effects(modname, fname):
    """呼叫「某個已匯入的模組」的函式：回傳 (效果集合, 說明)。標準庫查規則表；第三方先查這次抽取已分析過的模組；都沒有就是 unknown。"""
    if modname == 'sys':
        return (set(), '') if fname in SYS_PURE_CALLS else ({'env'}, 'sys.' + fname)
    if modname in PURE_MODULES or modname.split('.')[0] in PURE_MODULES and modname.split('.')[0] not in ('os',):
        if modname.startswith('os.path') or modname in ('posixpath', 'ntpath'):
            return ({'fs.read'}, modname + '.' + fname) if FS_READ_NAMES.match(fname) else (set(), '')
        return set(), ''
    if modname in ('os.path', 'posixpath', 'ntpath'):
        return ({'fs.read'}, modname + '.' + fname) if FS_READ_NAMES.match(fname) else (set(), '')
    if modname == 'os':  # os 整個模組太粗：依函式名稱分；沒列到的保守當 unknown
        if fname in OS_PURE:
            return set(), ''
        if fname in OS_FUNCS:
            return set(OS_FUNCS[fname]), 'os.' + fname
        return {'unknown'}, 'unclassified os.' + fname
    if modname == 'pathlib' and fname in PATHLIB_PURE:
        return set(), ''
    if modname == 'threading' and fname in THREAD_PURE:
        return set(), ''
    if modname == 'datetime':
        return ({'time'}, 'datetime.' + fname) if re.match(r'^(now|today|utcnow|fromtimestamp)$', fname) else (set(), '')
    for key in (modname, modname.split('.')[0]):
        if key in EFFECT_MODULES:
            return set(EFFECT_MODULES[key]), key + '.' + fname
    if modname.split('.')[0] in NET_LIBS:
        return {'net'}, modname + '.' + fname
    if modname in SUMMARIES:
        s = SUMMARIES[modname].get(fname)
        if s is not None:
            return set(s[0]), 'calls ' + modname + '.' + fname
    if stdlib(modname):
        return set(), ''  # 其他標準庫（沒列在規則表的）當成沒有副作用——這是假設，不是證明；探測時稽核掛鉤會擋
    return {'unknown'}, 'unresolved ' + modname + '.' + fname


def analyze_module(mod):
    """第三方模組的函式層級靜態副作用分析：對每個模組層級的函式（和類別的建構／方法），找出它直接做的事、呼叫了什麼，再沿著模組內的呼叫鏈合併。
    回傳 {名稱: (效果集合, 證據清單)}。看不到原始碼或解析不了的模組回傳 {}（全部 unknown，保守）。"""
    try:
        import inspect as _i
        src = _i.getsource(mod)
        tree = ast.parse(src)
    except Exception:
        return {}
    imports = {}  # 本地名稱 -> ('mod', 模組) 或 ('from', 模組, 名稱)
    defs, classes = {}, {}
    for n in ast.walk(tree):
        if isinstance(n, ast.Import):
            for a in n.names:
                imports[(a.asname or a.name.split('.')[0])] = ('mod', a.name if a.asname else a.name.split('.')[0])
        elif isinstance(n, ast.ImportFrom) and n.module and not n.level:
            for a in n.names:
                imports[a.asname or a.name] = ('from', n.module, a.name)
    for n in tree.body:
        if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)):
            defs[n.name] = n
        elif isinstance(n, ast.ClassDef):
            classes[n.name] = n
    globals_assigned = set()
    for n in tree.body:
        if isinstance(n, ast.Assign):
            for t in n.targets:
                if isinstance(t, ast.Name):
                    globals_assigned.add(t.id)
    direct, edges = {}, {}

    def local_names(fn):
        names = {a.arg for a in fn.args.args + fn.args.posonlyargs + fn.args.kwonlyargs}
        if fn.args.vararg:
            names.add(fn.args.vararg.arg)
        if fn.args.kwarg:
            names.add(fn.args.kwarg.arg)
        for x in ast.walk(fn):
            if isinstance(x, ast.Name) and isinstance(x.ctx, ast.Store):
                names.add(x.id)
        return names

    def scan(fn, key):
        eff, evid, calls = set(), [], set()
        loc = local_names(fn)
        for x in ast.walk(fn):
            if isinstance(x, ast.Global):
                eff.add('state.write'); evid.append('global ' + ','.join(x.names))
            elif isinstance(x, (ast.Import, ast.ImportFrom)) and x is not fn:
                for a in x.names:  # 函式裡的匯入
                    if isinstance(x, ast.Import):
                        imports.setdefault(a.asname or a.name.split('.')[0], ('mod', a.name if a.asname else a.name.split('.')[0]))
                    elif x.module and not x.level:
                        imports.setdefault(a.asname or a.name, ('from', x.module, a.name))
            elif isinstance(x, ast.Attribute) and isinstance(x.ctx, ast.Store):
                base = x.value
                while isinstance(base, ast.Attribute):
                    base = base.value
                if isinstance(base, ast.Name) and (base.id in imports or (base.id in globals_assigned and base.id not in loc)):
                    eff.add('state.write'); evid.append('assigns ' + base.id + '.' + x.attr)
            elif isinstance(x, ast.Call):
                f = x.func
                if isinstance(f, ast.Name):
                    nm = f.id
                    if nm == 'open' and nm not in loc and nm not in defs:
                        e = open_effects(x); eff |= e; evid.append('open()')
                    elif nm in BUILTIN_UI and nm not in loc:
                        eff.add('ui'); evid.append(nm + '()')
                    elif nm in BUILTIN_UNKNOWN and nm not in loc:
                        eff.add('unknown'); evid.append(nm + '()')
                    elif nm in loc:
                        pass  # 呼叫參數或區域變數（回呼）：效果屬於傳進來的函式
                    elif nm in defs or nm in classes:
                        calls.add(nm)
                    elif nm in imports:
                        imp = imports[nm]
                        if imp[0] == 'from':
                            e, why = module_call_effects(imp[1], imp[2])
                            if e:
                                eff |= e; evid.append(why)
                        # ('mod', …) 被直接呼叫（模組不能呼叫）：忽略
                elif isinstance(f, ast.Attribute):
                    chain, base = [f.attr], f.value
                    while isinstance(base, ast.Attribute):
                        chain.append(base.attr)
                        base = base.value
                    chain.reverse()
                    if isinstance(base, ast.Name):
                        b = base.id
                        if b in loc and b not in imports:
                            if f.attr in DANGER_METHODS:
                                eff.add(DANGER_METHODS[f.attr]); evid.append('.' + f.attr + '()')
                        elif b in imports:
                            imp = imports[b]
                            if imp[0] == 'mod':
                                full = imp[1] + ''.join('.' + c for c in chain[:-1]); e, why = module_call_effects(full, chain[-1])
                            else:  # from x import y；y.attr()
                                full = imp[1] + '.' + imp[2] + ''.join('.' + c for c in chain[:-1]); e, why = module_call_effects(full, chain[-1])
                                if not e and f.attr in DANGER_METHODS:
                                    e, why = {DANGER_METHODS[f.attr]}, '.' + f.attr + '()'
                            if e:
                                eff |= e; evid.append(why)
                        elif b in defs or b in classes:
                            calls.add(b)
                        elif b in globals_assigned:
                            if f.attr in MUTATORS:
                                eff.add('state.write'); evid.append(b + '.' + f.attr + '()')
                            elif f.attr in DANGER_METHODS:
                                eff.add(DANGER_METHODS[f.attr]); evid.append('.' + f.attr + '()')
                    elif f.attr in DANGER_METHODS:
                        eff.add(DANGER_METHODS[f.attr]); evid.append('.' + f.attr + '()')
        direct[key] = (eff, evid)
        edges[key] = calls

    for name, fn in defs.items():
        scan(fn, name)
    for cname, cls in classes.items():
        e_all, ev_all, calls_all = set(), [], set()
        for m in cls.body:
            if isinstance(m, (ast.FunctionDef, ast.AsyncFunctionDef)):
                scan(m, cname + '.' + m.name)
                e, ev = direct[cname + '.' + m.name]
                e_all |= e
                ev_all += ev
                calls_all |= edges[cname + '.' + m.name]
        direct[cname] = (e_all, ev_all)
        edges[cname] = calls_all
    # 沿呼叫鏈合併（到不再變動為止；有環也會停）
    total = {k: (set(v[0]), list(v[1])) for k, v in direct.items()}
    for _ in range(len(total) + 1):
        changed = False
        for k, calls in edges.items():
            for c in calls:
                if c in total:
                    add = total[c][0] - total[k][0]
                    if add:
                        total[k][0].update(add)
                        total[k][1].append('calls ' + c)
                        changed = True
        if not changed:
            break
    return {k: (v[0], v[1][:6]) for k, v in total.items() if '.' not in k}


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
    summ = {} if stdlib(modname) else analyze_module(mod)
    if not stdlib(modname):
        SUMMARIES[modname] = summ
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
        effects_src, evid = None, []
        if not pure and not stdlib(modname):
            info = summ.get(n)
            if info is not None:  # 函式層級的靜態分析（沒有分析到的，例如從別處轉出的名稱，保持 unknown）
                effs = sorted(info[0])
                eff, pure, pure_src, effects_src, evid = effs, (not effs), ('static' if not effs else None), 'static', info[1]
        protos.append({
            'module': modname, 'name': n, 'summary': first_para(doc), 'params': params, 'sig_src': sig_src, 'returns': ret,
            'effects': eff, 'pure': pure, 'pure_src': pure_src, 'effects_src': effects_src, 'effect_evidence': evid, 'stdlib': stdlib(modname), 'version': getattr(mod, '__version__', None),
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
