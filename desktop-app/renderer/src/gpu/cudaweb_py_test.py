# -*- coding: utf-8 -*-
# python renderer/src/gpu/cudaweb_py_test.py
# cudaweb（renderer/src/pybridge/cudaweb.py）的 Python 端：參數檢查、呼叫宿主的操作名與參數、結果與錯誤的傳回。
# 宿主（_fa_cudaweb）與 pyodide.ffi.run_sync 以假物件代替；真的 WebGPU 行為由 gpu_core.js 與真桌面版評估負責。
import io
import json
import os
import sys
import types

# Windows 主控台的代碼頁可能不是 UTF-8，強制輸出用 UTF-8，免得中文訊息變亂碼
if hasattr(sys.stdout, "buffer"):
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..', 'pybridge'))

import cudaweb  # noqa: E402

failures = []
passes = 0


def check(name, fn):
    global passes
    try:
        fn()
        passes += 1
        print('ok   ' + name)
    except AssertionError as e:
        failures.append(name)
        print('FAIL ' + name + ': ' + str(e))


# 假的宿主：記錄每次呼叫，回傳預先設定的 JSON 字串（同步，run_sync 直接回傳）
calls = []
reply = {'value': None}


def fake_call(op, argsjson):
    calls.append((op, json.loads(argsjson)))
    return reply['value']


def install_host(on=True):
    cudaweb._ON_EMSCRIPTEN = on
    host = types.ModuleType('_fa_cudaweb')
    host.call = fake_call
    sys.modules['_fa_cudaweb'] = host
    ffi = types.ModuleType('pyodide.ffi')
    ffi.run_sync = lambda x: x
    pyodide = types.ModuleType('pyodide')
    pyodide.ffi = ffi
    sys.modules['pyodide'] = pyodide
    sys.modules['pyodide.ffi'] = ffi


def ok(result):
    return json.dumps({'ok': True, 'result': result})


def err(message):
    return json.dumps({'ok': False, 'error': message})


def expect_error(fn, needle):
    try:
        fn()
    except cudaweb.CudaWebError as e:
        assert needle in str(e), '錯誤訊息缺少「%s」：%s' % (needle, e)
        return
    raise AssertionError('沒有丟出 CudaWebError（應含「%s」）' % needle)


def t_not_emscripten():
    install_host(on=False)
    del calls[:]
    expect_error(lambda: cudaweb.vector_add([1], [2]), '只能在 Python 模擬器')
    assert calls == [], '不在模擬器裡不應呼叫宿主'


def t_vector_add_roundtrip():
    install_host(True)
    del calls[:]
    reply['value'] = ok([4, 6])
    r = cudaweb.vector_add((1, 2), [3, 4])
    assert r == [4, 6], r
    assert calls == [('vector_add', {'a': [1, 2], 'b': [3, 4]})], calls


def t_vector_add_length_mismatch():
    install_host(True)
    del calls[:]
    expect_error(lambda: cudaweb.vector_add([1, 2], [1]), '長度不同（2 與 1）')
    assert calls == [], '參數錯誤時不應呼叫宿主'


def t_matmul_roundtrip():
    install_host(True)
    del calls[:]
    # 2×3 乘 3×2 → 2×2；宿主回傳扁平結果 [58, 64, 139, 154]
    reply['value'] = ok([58, 64, 139, 154])
    r = cudaweb.matmul([[1, 2, 3], [4, 5, 6]], [[7, 8], [9, 10], [11, 12]])
    assert r == [[58, 64], [139, 154]], r
    op, args = calls[-1]
    assert op == 'matmul'
    assert args == {'a': [1, 2, 3, 4, 5, 6], 'b': [7, 8, 9, 10, 11, 12], 'm': 2, 'k': 3, 'n': 2}, args


def t_matmul_shape_errors():
    install_host(True)
    del calls[:]
    expect_error(lambda: cudaweb.matmul([[1, 2], [3]], [[1], [2]]), '不是矩形')
    expect_error(lambda: cudaweb.matmul([[1, 2]], [[1, 2]]), 'A 的欄數 2 與 B 的列數 1 不符')
    expect_error(lambda: cudaweb.matmul([], [[1]]), '非空的二維 list')
    assert calls == [], '形狀錯誤時不應呼叫宿主'


def t_sum_returns_float():
    install_host(True)
    del calls[:]
    reply['value'] = ok(10)
    r = cudaweb.sum([1, 2, 3, 4])
    assert r == 10.0 and isinstance(r, float), r
    assert calls == [('sum', {'a': [1, 2, 3, 4]})], calls


def t_host_error_is_raised():
    install_host(True)
    reply['value'] = err('輸入超過裝置的儲存緩衝上限')
    expect_error(lambda: cudaweb.sum([1]), '超過裝置的儲存緩衝上限')


def t_backend_info_passthrough():
    install_host(True)
    del calls[:]
    info = {'hasWebGPU': False, 'last': {'layer': 'T4', 'reason': '此環境沒有 WebGPU（navigator.gpu 不存在）'}, 'degradeLog': []}
    reply['value'] = ok(info)
    r = cudaweb.backend_info()
    assert r == info, r
    assert calls == [('backend_info', {})], calls


def main():
    check('不在模擬器裡：明確報錯、不呼叫宿主', t_not_emscripten)
    check('vector_add 來回：參數與結果正確', t_vector_add_roundtrip)
    check('vector_add 長度不同：不呼叫宿主', t_vector_add_length_mismatch)
    check('matmul 來回：扁平化與還原正確', t_matmul_roundtrip)
    check('matmul 形狀錯誤：不呼叫宿主', t_matmul_shape_errors)
    check('sum 回傳 float', t_sum_returns_float)
    check('宿主錯誤會變成 CudaWebError', t_host_error_is_raised)
    check('backend_info 原樣回傳', t_backend_info_passthrough)
    print('\n%d 通過，%d 失敗' % (passes, len(failures)))
    if failures:
        sys.exit(1)


if __name__ == '__main__':
    main()
