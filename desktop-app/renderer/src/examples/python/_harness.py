# -*- coding: utf-8 -*-
"""無頭測試台（pygame 範例要先 pip install pygame-ce）：用假的 fa_bridge 跑 run terminal 的 Python 範例，照橋接層的上限檢查，不開視窗。
用法：python3 _harness.py game/breakout.py [--frames 180] [--seed 1] [--keys random|none] [--quiet] [腳本自己的參數…]
檢查：每幀 draw 指令 ≤ 100000 且指令種類合法、圖片每視窗 ≤ 16 張（大小不限）、畫布大小 ≤ 1200、程式沒有丟例外、跑滿 frames 幀後送出 close 能正常結束。
GUI 程式（用 w.wait()）：依序送出每個按鈕的 click、輸入框的 input，最後送 close。
結束碼 0＝通過；非 0＝有違規（訊息印在 stderr）。"""
import argparse, base64, os, random, runpy, sys, types, time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..', '..', 'pybridge'))
DRAW_OPS = {'clear', 'rect', 'circle', 'line', 'text', 'image'}
KEYS = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', ' ', 'Enter', 'a', 'd', 'w', 's', 'z', 'x']

ap = argparse.ArgumentParser()
ap.add_argument('script'); ap.add_argument('--frames', type=int, default=180); ap.add_argument('--seed', type=int, default=1)
ap.add_argument('--keys', default='random'); ap.add_argument('--quiet', action='store_true')
args, rest = ap.parse_known_args()
rest = [r for r in rest if r != '--']
rnd = random.Random(args.seed)
S = {'frames': 0, 'maxops': 0, 'nodes': {}, 'images': {}, 'closed': False, 'queue': [], 'waits': 0, 'tones': 0, 'sets': 0, 'gl': 0}
bad = []


def fail(msg):
    bad.append(msg); print('VIOLATION:', msg, file=sys.stderr)


def call(op, a=None, timeout=240.0):
    a = a or {}
    if op == 'gui.open':
        return {'ok': True}
    if op == 'gui.add':
        n = a['node']; S['nodes'][n['id']] = n
        if n['kind'] == 'canvas' and (n.get('width', 0) > 1200 or n.get('height', 0) > 1200): fail('canvas 超過 1200')
        if len(S['nodes']) > 200: fail('節點超過 200')
        return {'ok': True}
    if op == 'gui.set':
        S['sets'] += 1; return {'ok': True}
    if op == 'gui.draw':
        ops = a['ops']; S['frames'] += 1; S['maxops'] = max(S['maxops'], len(ops))
        if len(ops) > 100000: fail('一幀 %d 道指令，超過 100000' % len(ops))
        for o in ops:
            if not o or o[0] not in DRAW_OPS: fail('不認得的繪圖指令 %r' % (o[:1],))
            if o[0] == 'image' and o[1] not in S['images']: fail('image 未註冊 %s' % o[1])
        return {'ok': True}
    if op == 'gui.image':
        if 'parts' in a:   # 大圖分段傳送：最後一段才註冊
            S.setdefault('pending', {}).setdefault(a['name'], []).append(base64.b64decode(a['chunk']))
            if a['part'] < a['parts'] - 1: return {'w': 0, 'h': 0}
            size = sum(len(p) for p in S['pending'].pop(a['name']))
        else:
            raw = a['data'].split(',', 1)[1]; size = len(base64.b64decode(raw))   # 圖片不設大小上限
        S['images'][a['name']] = size
        if len(S['images']) > 16: fail('圖片超過 16 張')
        return {'w': 64, 'h': 64}
    if op in ('gui.theme', 'gui.shortcut'):
        return {'ok': True}
    if op == 'gui.tone':
        S['tones'] += 1; return {'ok': True}
    if op == 'gui.close':
        S['closed'] = True; return {'ok': True}
    if op == 'gui.poll':
        if S['frames'] >= args.frames:
            if S.get('close_sent'): return None       # close 只送一次：pygame.event.get() 會一直 poll 到 None 才停
            S['close_sent'] = True
            return {'event': 'close'}
        for nid, n in S['nodes'].items():
            if n['kind'] == 'canvas' and n.get('fps', 0) > 0 and (S['frames'] == 0 or rnd.random() < 0.8):
                return {'event': 'frame', 'node': nid, 'value': {'t': int(time.time() * 1000)}}
        if args.keys == 'random' and rnd.random() < 0.3:
            return {'event': 'key', 'value': {'key': rnd.choice(KEYS), 'down': rnd.random() < 0.6}}
        return None
    if op == 'gui.wait':
        S['waits'] += 1
        if not S['queue']:
            for nid, n in S['nodes'].items():
                if n['kind'] == 'button': S['queue'].append({'event': 'click', 'node': nid})
            S['queue'].append({'event': 'close'})
        return S['queue'].pop(0)
    if op == 'gui.glbuf':
        S.setdefault('glbufs', {})
        if a.get('data') is None: S['glbufs'].pop(a['name'], None); return {'ok': True}
        size = len(base64.b64decode(a['data']))
        if size > 4 * 1024 * 1024: fail('glbuf %s 超過 4 MB' % a['name'])
        S['glbufs'][a['name']] = a['type']
        if len(S['glbufs']) > 24: fail('glbuf 超過 24 個')
        return {'ok': True}
    if op == 'gui.glprog':
        S.setdefault('glprogs', set()).add(a['name'])
        if len(S['glprogs']) > 12: fail('glprog 超過 12 個')
        for k in ('vs', 'fs'):
            if not a[k].lstrip().startswith('#version 300 es'): fail('著色器缺 #version 300 es')
        return {'ok': True}
    if op == 'gui.glframe':
        S['frames'] += 1; S['gl'] += 1; S['maxops'] = max(S['maxops'], len(a['cmds']))
        if len(a['cmds']) > 256: fail('glframe %d 道指令，超過 256' % len(a['cmds']))
        for c in a['cmds']:
            if c[0] == 'use' and c[1] not in S.get('glprogs', ()): fail('use 未註冊的程式 %s' % c[1])
            if c[0] in ('attr', 'index'):
                bn = c[2] if c[0] == 'attr' else c[1]
                if bn not in S.get('glbufs', {}): fail('%s 用到未上傳的緩衝區 %s' % (c[0], bn))
        return {'ok': True}
    return {'ok': True}


stub = types.ModuleType('fa_bridge'); stub.call = call; stub.sleep = lambda s: None; stub.ACTIVE = True
sys.modules['fa_bridge'] = stub
# pygame 是 pip 的真套件（pygame-ce）；SDL 用 dummy 驅動，後端 fa_pygame 把畫面與事件接到上面的假橋接。沒有安裝就只能跑不用 pygame 的範例
os.environ.setdefault('SDL_VIDEODRIVER', 'dummy'); os.environ.setdefault('SDL_AUDIODRIVER', 'dummy'); os.environ.setdefault('PYGAME_HIDE_SUPPORT_PROMPT', '1')
try:
    import pygame, fa_pygame
    fa_pygame.patch(pygame)
except ImportError:
    pass
script = os.path.join(HERE, args.script) if not os.path.isabs(args.script) else args.script
sys.argv = [script] + rest
import signal
signal.signal(signal.SIGALRM, lambda *a: (_ for _ in ()).throw(TimeoutError('超過 60 秒仍未結束（沒有處理 QUIT／close？）')))
signal.alarm(60)
t0 = time.time()
try:
    runpy.run_path(script, run_name='__main__')
except SystemExit:
    pass
except Exception as e:
    import traceback; traceback.print_exc(); fail('程式丟出例外：%r' % (e,))
if not args.quiet:
    print('%s：%d 幀，單幀最多 %d 道指令，節點 %d，圖片 %d，tone %d，耗時 %.1f 秒' % (args.script, S['frames'], S['maxops'], len(S['nodes']), len(S['images']), S['tones'], time.time() - t0))
sys.exit(1 if bad else 0)
