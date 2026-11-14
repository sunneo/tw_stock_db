# -*- coding: utf-8 -*-
# 假橋接空跑（設計 2.7 第三關）：用假的 fa_bridge 跑一支組合出來的圖形介面程式，送預先排好的事件，事件用完就送關閉。
# 用法：python -I fake_run.py <程式檔> <事件檔.json>
#   事件檔是事件陣列，例如 [{"event":"click","name":"save"}, {"event":"shortcut","value":"save_file"}]；
#   "name" 是規格裡的節點名稱，這裡換成程式建出的真正節點代號（讀程式的 ids 字典）。
# 結果（一行 JSON 印到標準輸出）：{"ok": true|false, "ops": [[操作, 欄位]…], "error": "…", "state": {…}, "ids": {名稱: 代號}}
import json
import os
import sys
import types

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..', 'pybridge'))

ops = []
pending = []
scope = {'__name__': '__main__'}


def fake_call(op, args=None, timeout=240.0):
    ops.append([op, args])
    if op in ('gui.wait', 'gui.poll'):
        if pending:
            ev = dict(pending.pop(0))
            name = ev.pop('name', None)
            if name is not None:
                ev['node'] = scope['ids'][name]
            ev.setdefault('v', 1)
            ev.setdefault('id', args['id'])
            ev.setdefault('node', 'root')
            return ev
        return {'v': 1, 'event': 'close', 'id': args['id'], 'node': 'root'}
    return None


stub = types.ModuleType('fa_bridge')
stub.call = fake_call
sys.modules['fa_bridge'] = stub


def main():
    program, events_path = sys.argv[1], sys.argv[2]
    with open(events_path, encoding='utf-8') as f:
        pending.extend(json.load(f))
    with open(program, encoding='utf-8') as f:
        source = f.read()
    result = {'ok': True, 'ops': ops, 'error': ''}
    try:
        exec(compile(source, program, 'exec'), scope)
    except SystemExit:
        pass
    except BaseException as e:  # 任何例外都是驗收失敗
        result['ok'] = False
        result['error'] = '%s: %s' % (type(e).__name__, e)
    result['state'] = scope.get('state')
    result['ids'] = scope.get('ids')
    print(json.dumps(result))  # 純 ASCII：Windows 管道的預設編碼不是 UTF-8
    sys.exit(0 if result['ok'] else 1)


main()
