# 單元目錄的探測執行（只用標準庫；在 Pyodide 或一般 CPython 裡都能跑）。設計見 DESIGN.unit-catalog.md 第四、五節。
# 只對「純函式」（模組白名單、沒有副作用）執行，並且：
#   - 用稽核掛鉤（sys.addaudithook）擋下檔案、網路、子行程、程式碼執行這類事件，碰到就中止那一次呼叫、記成 blocked；
#   - 每個案例執行兩次，結果不同就標非決定性；結果與輸出都截短；
#   - 逾時由呼叫端（JS）終止整個 Worker，這裡只負責不讓單次結果太大。
# 用法：JS 端把 PROBE_REQ 那一行的占位符換成請求（JSON 字串的字面值）再執行；輸出一行 "FA_PROBE_RESULT:" + JSON。
#   請求：{"jobs":[{"id","module","name","cases":[{"args":[...],"kwargs":{...}}]}], "max_repr":200}
#   參數值的特殊編碼：{"$bytes": "<base64>"}→ bytes；{"$tuple": [...]}→ tuple。
import sys, json, importlib, base64, math, re

REQ = json.loads(__FA_PROBE_REQ__)
MAX_REPR = int(REQ.get('max_repr', 200))
BLOCKED_EVENTS = {'open', 'os.system', 'os.exec', 'os.posix_spawn', 'os.spawn', 'os.fork', 'os.forkpty', 'subprocess.Popen', 'os.remove', 'os.rename', 'os.rmdir', 'os.mkdir',
                  'os.chmod', 'os.chown', 'os.truncate', 'os.symlink', 'os.link', 'os.putenv', 'os.unsetenv', 'shutil.rmtree', 'shutil.copyfile', 'shutil.move', 'shutil.copytree',
                  'ctypes.dlopen', 'ctypes.dlsym', 'exec', 'compile', 'import.__main__', 'webbrowser.open', 'tempfile.mkstemp', 'tempfile.mkdtemp', 'urllib.Request', 'http.client.connect'}
_state = {'armed': False}


def _hook(event, args):
    if not _state['armed']:
        return
    if event in BLOCKED_EVENTS or event.startswith('socket.') or event.startswith('subprocess.'):
        raise RuntimeError('blocked:' + event)


try:
    sys.addaudithook(_hook)
    AUDIT = True
except Exception:  # 沒有稽核掛鉤（很舊的版本）：不執行任何探測，直接回報
    AUDIT = False


def decode(v):
    if isinstance(v, dict):
        if '$bytes' in v and len(v) == 1:
            return base64.b64decode(v['$bytes'])
        if '$tuple' in v and len(v) == 1:
            return tuple(decode(x) for x in v['$tuple'])
        return {k: decode(x) for k, x in v.items()}
    if isinstance(v, list):
        return [decode(x) for x in v]
    return v


def tname(v, depth=0):
    # 結果值 → 我們的型別詞彙（對不上的一律 any，不猜）
    if v is None:
        return 'null'
    if isinstance(v, bool):
        return 'bool'
    if isinstance(v, int):
        return 'int'
    if isinstance(v, (float, complex)):
        return 'number'
    if type(v).__name__ in ('Fraction', 'Decimal'):
        return 'number'
    if isinstance(v, str):
        return 'text'
    if isinstance(v, (bytes, bytearray)):
        return 'bytes'
    if isinstance(v, dict):
        return 'dict'
    if isinstance(v, (list, tuple, set, frozenset)):
        if depth >= 2:
            return 'list<any>'
        items = list(v)[:20]
        if not items:
            return 'list<any>'
        ts = sorted(set(tname(x, depth + 1) for x in items))
        if 'number' in ts and 'int' in ts:
            ts.remove('int')
        return 'list<' + (ts[0] if len(ts) == 1 else 'union<' + '|'.join(ts) + '>') + '>'
    return 'any'


def srepr(v):
    # 物件的預設 repr 帶記憶體位址（每次不同），比較與記錄時去掉，不然會被誤判成非決定性
    return re.sub(r' (at|@) 0x[0-9a-fA-F]+', '', repr(v))


def jsonable(v):
    try:
        s = json.dumps(v, allow_nan=False)
        return json.loads(s) if len(s) <= 2000 else None
    except Exception:
        return None


def one_call(fn, case):
    args = [decode(a) for a in case.get('args', [])]
    kwargs = {k: decode(v) for k, v in (case.get('kwargs') or {}).items()}
    _state['armed'] = True
    try:
        return fn(*args, **kwargs)
    finally:
        _state['armed'] = False


def run_case(fn, case):
    positional = False
    try:
        try:
            r1 = one_call(fn, case)
        except TypeError as e:
            # 存根寫成關鍵字參數、實際是僅位置參數（例如 math.log）：改用位置參數重試一次，並記下來
            if 'keyword argument' in str(e) and case.get('kwargs'):
                r1 = one_call(fn, {'args': list(case.get('args', [])) + list(case['kwargs'].values()), 'kwargs': {}})
                positional = True
            else:
                raise
    except RuntimeError as e:
        if str(e).startswith('blocked:'):
            return {'ok': False, 'exc': 'Blocked', 'msg': str(e)[:120], 'blocked': True}
        return {'ok': False, 'exc': 'RuntimeError', 'msg': str(e)[:120]}
    except BaseException as e:  # 包含 SystemExit：探測不能讓整個程序結束
        return {'ok': False, 'exc': type(e).__name__, 'msg': str(e)[:120], 'bases': [c.__name__ for c in type(e).__mro__[1:4]]}
    try:
        r2 = one_call(fn, {'args': list(case.get('args', [])) + list(case['kwargs'].values()), 'kwargs': {}} if positional else case)
        det = srepr(r1) == srepr(r2)
    except BaseException:
        det = False
    j = jsonable(r1)
    out = {'ok': True, 'type': tname(r1), 'repr': srepr(r1)[:MAX_REPR], 'det': det, 'jsonable': j is not None or r1 is None}
    if positional:
        out['positional'] = True
    if out['jsonable']:
        out['json'] = j
    if isinstance(r1, float) and (math.isnan(r1) or math.isinf(r1)):
        out['jsonable'] = False
        out.pop('json', None)
    return out


res = {'ok': True, 'python': sys.version.split()[0], 'audit': AUDIT, 'jobs': []}
for job in REQ.get('jobs', []):
    item = {'id': job['id'], 'cases': [], 'import_error': None}
    if not AUDIT:
        item['import_error'] = 'no audit hook'
        res['jobs'].append(item)
        continue
    try:
        mod = importlib.import_module(job['module'])
        fn = mod
        for part in job['name'].split('.'):
            fn = getattr(fn, part)
        if not callable(fn):
            raise TypeError('not callable')
    except BaseException as e:
        item['import_error'] = type(e).__name__ + ': ' + str(e)[:120]
        res['jobs'].append(item)
        continue
    for case in job.get('cases', []):
        item['cases'].append(run_case(fn, case))
    res['jobs'].append(item)
print('FA_PROBE_RESULT:' + json.dumps(res, ensure_ascii=False))
