# -*- coding: utf-8 -*-
# 把螢幕說明（HUD）補進「手寫」的 .ll（sdl2_piano、sdl2_pong、sdl2_gl_triangle）。
# 做法：模組層級（字型、字串常數、hud_text／hud_int 或 hud_text_gl、需要的 declare）放在第一個 define 之前；
#       畫面層級（每幀呼叫 hud_text）放在指定的繪製收尾行之前。兩段都用標記包住，重跑會先移除舊的再插入，所以是可重複執行的。
# 用法：python3 _hud_patch.py   （直接改寫 ../game、../gui 底下的三個 .ll；視窗高度也在這裡調整）
# 注意：HUD 的字串與位置寫在下方的 CONFIG；改了字串就重跑這支腳本，不要手改兩個標記之間的內容。
import os, re, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _hud as H
from _irb import f32

BASE = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
MOD_B = '; ==== HUD BEGIN（模組）==== 由 _gen/_hud_patch.py 產生，勿手改'
MOD_E = '; ==== HUD END（模組）===='
FN_B = '  ; ==== HUD BEGIN（畫面）==== 由 _gen/_hud_patch.py 產生，勿手改'
FN_E = '  ; ==== HUD END（畫面）===='

def strip_blocks(lines):
    out, skipping, end = [], False, None
    for ln in lines:
        if not skipping and ln.startswith('; ==== HUD BEGIN（模組）'):
            skipping, end = True, MOD_E
            continue
        if not skipping and ln.startswith('  ; ==== HUD BEGIN（畫面）'):
            skipping, end = True, FN_E
            continue
        if skipping:
            if ln.startswith(end):
                skipping = False
            continue
        out.append(ln)
    return out


def ensure_decl(text, name, line):
    if re.search(r'declare [^\n]*@%s\(' % re.escape(name), text):
        return ''
    return line + '\n'


def c8(r, g, b):
    return 'i8 %d, i8 %d, i8 %d' % (r, g, b)


def sdl_text_call(ren, x, y, sname, s, col):
    return '  call void @hud_text(ptr %s, i32 %d, i32 %d, ptr @%s, i32 %d, %s)' % (ren, x, y, sname, len(s), c8(*col))


def sdl_int_call(ren, x, y, val, col):
    return '  call void @hud_int(ptr %s, i32 %d, i32 %d, i32 %s, %s)' % (ren, x, y, val, c8(*col))


def build_module(strings, kind):
    parts = [H.font_global()]
    for name, s in strings:
        parts.append(H.str_global(name, s))
    if kind == 'sdl':
        parts.append(H.hud_text_sdl_ir())
        parts.append(H.hud_int_sdl_ir())
    else:
        parts.append(H.hud_ir_gl())
    return '\n'.join(parts) + '\n'


def patch(cfg):
    full = os.path.normpath(os.path.join(BASE, cfg['file']))
    text = open(full, encoding='utf-8').read()
    lines = strip_blocks(text.split('\n'))
    text = '\n'.join(lines)
    # 視窗高度
    if 'win_old' in cfg:
        if text.count(cfg['win_old']) == 1:
            text = text.replace(cfg['win_old'], cfg['win_new'])
        else:   # 已經改過（重跑）
            assert text.count(cfg['win_new']) == 1, cfg['file']
    # 模組層級的 declare（缺才加）
    decls = ''
    for name, line in cfg['decls']:
        decls += ensure_decl(text, name, line)
    mod = MOD_B + '\n' + decls + build_module(cfg['strings'], cfg['kind']) + MOD_E + '\n\n'
    i = text.index('\ndefine ')
    text = text[:i + 1] + mod + text[i + 1:]
    # 畫面層級：插在繪製收尾行之前
    anchor = cfg['anchor']
    assert text.count(anchor) == 1, (cfg['file'], text.count(anchor))
    block = FN_B + '\n' + '\n'.join(cfg['calls']) + '\n' + FN_E + '\n'
    text = text.replace(anchor, block + anchor)
    open(full, 'w', encoding='utf-8').write(text)
    print('patched', cfg['file'])


DECL_SDL_DRAW = [('SDL_SetRenderDrawColor', 'declare i32 @SDL_SetRenderDrawColor(ptr, i8, i8, i8, i8)'),
                 ('SDL_RenderFillRect', 'declare i32 @SDL_RenderFillRect(ptr, ptr)')]
WHITE = (235, 235, 235)
ACCENT = (255, 210, 90)

PIANO = {
    'file': 'game/sdl2_piano.ll', 'kind': 'sdl',
    'win_old': 'i32 640, i32 200, i32 0)', 'win_new': 'i32 640, i32 250, i32 0)',
    'decls': DECL_SDL_DRAW,
    'strings': [('hud_pa', 'A S D F G H J K = C4 TO C5'), ('hud_pb', 'ESC QUIT  NOTES PLAYED ')],
    'anchor': '  call void @SDL_RenderPresent(ptr %ren)',
    'calls': [
        sdl_text_call('%ren', 8, 200, 'hud_pa', 'A S D F G H J K = C4 TO C5', WHITE),
        sdl_text_call('%ren', 8, 218, 'hud_pb', 'ESC QUIT  NOTES PLAYED ', WHITE),
        '  %hud_n = load i32, ptr %notes',
        sdl_int_call('%ren', 169, 218, '%hud_n', ACCENT),
    ],
}

PONG = {
    'file': 'game/sdl2_pong.ll', 'kind': 'sdl',
    'win_old': 'i32 640, i32 400, i32 0)', 'win_new': 'i32 640, i32 440, i32 0)',
    'decls': DECL_SDL_DRAW,
    'strings': [('hud_qa', 'W/S OR UP DOWN: MOVE'), ('hud_qb', 'RALLY '), ('hud_qc', 'BEST '), ('hud_qd', 'ESC QUIT')],
    'anchor': '  call void @SDL_RenderPresent(ptr %rend)',
    'calls': [
        sdl_text_call('%rend', 8, 412, 'hud_qa', 'W/S OR UP DOWN: MOVE', WHITE),
        sdl_text_call('%rend', 8, 428, 'hud_qb', 'RALLY ', WHITE),
        '  %hud_r = load i32, ptr %rally',
        sdl_int_call('%rend', 50, 428, '%hud_r', ACCENT),
        sdl_text_call('%rend', 77, 428, 'hud_qc', 'BEST ', WHITE),
        '  %hud_b = load i32, ptr %best',
        sdl_int_call('%rend', 112, 428, '%hud_b', ACCENT),
        sdl_text_call('%rend', 147, 428, 'hud_qd', 'ESC QUIT', WHITE),
    ],
}

GL_DECLS = [('glMatrixMode', 'declare void @glMatrixMode(i32)'),
            ('glLoadIdentity', 'declare void @glLoadIdentity()'),
            ('glOrtho', 'declare void @glOrtho(double, double, double, double, double, double)'),
            ('glColor3f', 'declare void @glColor3f(float, float, float)'),
            ('glVertex2f', 'declare void @glVertex2f(float, float)'),
            ('glBegin', 'declare void @glBegin(i32)'),
            ('glEnd', 'declare void @glEnd()')]


def gl_call(x, y, sname, s, col):
    return '  call void @hud_text_gl(i32 %d, i32 %d, ptr @%s, i32 %d, float %s, float %s, float %s)' % (
        x, y, sname, len(s), f32(col[0] / 255.0), f32(col[1] / 255.0), f32(col[2] / 255.0))


TRI_STRINGS = [('hud_ta', 'DRAG: ROTATE   WHEEL: ZOOM'), ('hud_tb', 'ESC QUIT'),
               ('hud_tc', 'DRAGGING'), ('hud_td', 'IDLE')]
TRI = {
    'file': 'gui/sdl2_gl_triangle.ll', 'kind': 'gl',
    'decls': GL_DECLS,
    'strings': TRI_STRINGS,
    'anchor': '  call void @SDL_GL_SwapWindow(ptr %win)',
    'calls': [
        '  ; 2D 疊加：正交投影（y 向下），畫完三角形之後，交換緩衝區之前',
        '  call void @glMatrixMode(i32 5889)                  ; GL_PROJECTION',
        '  call void @glLoadIdentity()',
        '  call void @glOrtho(double 0.0, double 640.0, double 480.0, double 0.0, double -1.0, double 1.0)',
        '  call void @glMatrixMode(i32 5888)                  ; GL_MODELVIEW',
        '  call void @glLoadIdentity()',
        '  call void @glBegin(i32 7)                          ; GL_QUADS：整段說明一批送出',
        gl_call(8, 440, 'hud_ta', 'DRAG: ROTATE   WHEEL: ZOOM', WHITE),
        gl_call(8, 458, 'hud_tb', 'ESC QUIT', WHITE),
        '  %hud_drag = load i32, ptr %drag',
        '  %hud_isdrag = icmp ne i32 %hud_drag, 0',
        '  br i1 %hud_isdrag, label %hud_dragging, label %hud_idle',
        'hud_dragging:',
        gl_call(8, 8, 'hud_tc', 'DRAGGING', ACCENT),
        '  br label %hud_end',
        'hud_idle:',
        gl_call(8, 8, 'hud_td', 'IDLE', ACCENT),
        '  br label %hud_end',
        'hud_end:',
        '  call void @glEnd()',
        '  call void @glMatrixMode(i32 5889)',
        '  call void @glLoadIdentity()',
        '  call void @glMatrixMode(i32 5888)',
        '  call void @glLoadIdentity()',
    ],
}


if __name__ == '__main__':
    for cfg in (PIANO, PONG, TRI):
        patch(cfg)
