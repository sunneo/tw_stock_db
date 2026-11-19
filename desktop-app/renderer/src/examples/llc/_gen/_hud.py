# -*- coding: utf-8 -*-
# 螢幕說明（HUD）共用的文字繪製（DESIGN.run-terminal.md §21.y）。
#   字型：_font_data.py 的 7×13 點陣（只有 ASCII 32..126；其他字元畫成空白）。
#   hud_text(ren, x, y, s, n, r, g, b)：畫字串 s 的前 n 個位元組，第 row 列畫在 y+row。
#       每列把整串的連續亮像素合併成一個矩形（跨字元也合併），每段一次 SDL_RenderFillRect。
#   hud_int(ren, x, y, v, r, g, b)：0..999 的整數，三位（不足位補空白）。
#   hud_text_gl(x, y, s, n, r, g, b)：OpenGL 版（呼叫端先 glBegin(GL_QUADS)、結束再 glEnd；每段一個四邊形）。
# 用法：產生器（DSL）呼叫 install_dsl(m)；手寫的 .ll 用 hud_text_sdl_ir()／hud_int_sdl_ir()／hud_ir_gl() 取得 IR 文字。
import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _font_data as FD
from _irb import esc

assert len(FD.ROWS) == 95 * 13, len(FD.ROWS)
NROWS = FD.H   # 13


def font_global():
    return '@hud_font = private constant [%d x i32] [%s]' % (
        len(FD.ROWS), ', '.join('i32 %d' % v for v in FD.ROWS))


def _scan(name, params, pre, draw, sdl):
    """共用的掃描迴圈：對每一列、每一欄（0..7n，最後一欄是「已結束」的哨兵）判斷亮不亮，遇到一段結束就呼叫 draw。
    用 alloca／load／store 代替 phi（橋接的 LLVM 子集不支援 phi）。"""
    L = ['define void @%s(%s) {' % (name, params), 'entry:']
    if sdl:
        L.append('  %rc = alloca [4 x i32], align 4')
    L += ['  %row = alloca i32', '  %xi = alloca i32', '  %st = alloca i32', '  %w = mul i32 %n, 7'] + pre + [
        '  store i32 0, ptr %row', '  br label %rowloop',
        'rowloop:', '  %rv = load i32, ptr %row', '  %rdone = icmp eq i32 %rv, 13', '  br i1 %rdone, label %exit, label %rowbody',
        'rowbody:', '  store i32 0, ptr %xi', '  store i32 -1, ptr %st', '  br label %col',
        'col:',
        '  %xv = load i32, ptr %xi',
        '  %inside = icmp slt i32 %xv, %w',
        '  %ci0 = udiv i32 %xv, 7',
        '  %ci = select i1 %inside, i32 %ci0, i32 0',
        '  %cm = urem i32 %xv, 7',
        '  %cp = getelementptr i8, ptr %s, i32 %ci',
        '  %cb = load i8, ptr %cp',
        '  %cv = zext i8 %cb to i32',
        '  %lo = icmp slt i32 %cv, 32',
        '  %hi = icmp sgt i32 %cv, 126',
        '  %bad = or i1 %lo, %hi',
        '  %cv2 = select i1 %bad, i32 32, i32 %cv',
        '  %gi = sub i32 %cv2, 32',
        '  %gb = mul i32 %gi, 13',
        '  %gidx = add i32 %gb, %rv',
        '  %gp = getelementptr [1235 x i32], ptr @hud_font, i32 0, i32 %gidx',
        '  %gv = load i32, ptr %gp',
        '  %sh = sub i32 6, %cm',
        '  %shv = lshr i32 %gv, %sh',
        '  %bit = and i32 %shv, 1',
        '  %bitb = icmp ne i32 %bit, 0',
        '  %lit = and i1 %bitb, %inside',
        '  %stv = load i32, ptr %st',
        '  %sn = icmp slt i32 %stv, 0',
        '  %begin = and i1 %lit, %sn',
        '  %newst = select i1 %begin, i32 %xv, i32 %stv',
        '  %nlit = xor i1 %lit, 1',
        '  %nsn = xor i1 %sn, 1',
        '  %endrun = and i1 %nlit, %nsn',
        '  %stfin = select i1 %endrun, i32 -1, i32 %newst',
        '  store i32 %stfin, ptr %st',
        '  br i1 %endrun, label %draw, label %cont',
        'draw:'] + draw + [
        '  br label %cont',
        'cont:',
        '  %x1 = add i32 %xv, 1',
        '  store i32 %x1, ptr %xi',
        '  %more = icmp slt i32 %xv, %w',
        '  br i1 %more, label %col, label %rowend',
        'rowend:',
        '  %r1 = add i32 %rv, 1',
        '  store i32 %r1, ptr %row',
        '  br label %rowloop',
        'exit:', '  ret void', '}', '']
    return '\n'.join(L)


_SDL_DRAW = [
    '  %dx = add i32 %x, %stv',
    '  %dy = add i32 %y, %rv',
    '  %dl = sub i32 %xv, %stv',
    '  %p0 = getelementptr [4 x i32], ptr %rc, i32 0, i32 0',
    '  %p1 = getelementptr [4 x i32], ptr %rc, i32 0, i32 1',
    '  %p2 = getelementptr [4 x i32], ptr %rc, i32 0, i32 2',
    '  %p3 = getelementptr [4 x i32], ptr %rc, i32 0, i32 3',
    '  store i32 %dx, ptr %p0',
    '  store i32 %dy, ptr %p1',
    '  store i32 %dl, ptr %p2',
    '  store i32 1, ptr %p3',
    '  %fr = call i32 @SDL_RenderFillRect(ptr %ren, ptr %rc)',
]

_GL_DRAW = [
    '  %dx = add i32 %x, %stv',
    '  %dy = add i32 %y, %rv',
    '  %dl = sub i32 %xv, %stv',
    '  %dx1 = add i32 %dx, %dl',
    '  %dy1 = add i32 %dy, 1',
    '  %fx0 = sitofp i32 %dx to float',
    '  %fx1 = sitofp i32 %dx1 to float',
    '  %fy0 = sitofp i32 %dy to float',
    '  %fy1 = sitofp i32 %dy1 to float',
    '  call void @glVertex2f(float %fx0, float %fy0)',
    '  call void @glVertex2f(float %fx1, float %fy0)',
    '  call void @glVertex2f(float %fx1, float %fy1)',
    '  call void @glVertex2f(float %fx0, float %fy1)',
]


def hud_text_sdl_ir():
    """SDL 版的 hud_text。需要 SDL_SetRenderDrawColor、SDL_RenderFillRect 的宣告。"""
    return _scan('hud_text', 'ptr %ren, i32 %x, i32 %y, ptr %s, i32 %n, i8 %r, i8 %g, i8 %b',
                 ['  %cr = call i32 @SDL_SetRenderDrawColor(ptr %ren, i8 %r, i8 %g, i8 %b, i8 -1)'],
                 _SDL_DRAW, True)


def hud_int_sdl_ir():
    """SDL 版的 hud_int（呼叫 hud_text）。"""
    return '''define void @hud_int(ptr %ren, i32 %x, i32 %y, i32 %v, i8 %r, i8 %g, i8 %b) {
entry:
  %buf = alloca [3 x i8], align 1
  %hq = udiv i32 %v, 100
  %hd = urem i32 %hq, 10
  %tq = udiv i32 %v, 10
  %td = urem i32 %tq, 10
  %od = urem i32 %v, 10
  %hge = icmp uge i32 %v, 100
  %tge = icmp uge i32 %v, 10
  %hc0 = add i32 %hd, 48
  %hc1 = select i1 %hge, i32 %hc0, i32 32
  %tc0 = add i32 %td, 48
  %tc1 = select i1 %tge, i32 %tc0, i32 32
  %oc0 = add i32 %od, 48
  %hc = trunc i32 %hc1 to i8
  %tc = trunc i32 %tc1 to i8
  %oc = trunc i32 %oc0 to i8
  %p0 = getelementptr [3 x i8], ptr %buf, i32 0, i32 0
  %p1 = getelementptr [3 x i8], ptr %buf, i32 0, i32 1
  %p2 = getelementptr [3 x i8], ptr %buf, i32 0, i32 2
  store i8 %hc, ptr %p0
  store i8 %tc, ptr %p1
  store i8 %oc, ptr %p2
  call void @hud_text(ptr %ren, i32 %x, i32 %y, ptr %buf, i32 3, i8 %r, i8 %g, i8 %b)
  ret void
}
'''
    return text + '\n' + integer


def hud_ir_gl():
    """OpenGL 版的 IR（hud_text_gl）。需要 glColor3f、glVertex2f 的宣告；呼叫端在 glBegin／glEnd 之間呼叫。"""
    return _scan('hud_text_gl', 'i32 %x, i32 %y, ptr %s, i32 %n, float %r, float %g, float %b',
                 ['  call void @glColor3f(float %r, float %g, float %b)'],
                 _GL_DRAW, False)


SDL_DECLS = ['declare i32 @SDL_SetRenderDrawColor(ptr, i8, i8, i8, i8)', 'declare i32 @SDL_RenderFillRect(ptr, ptr)']
GL_DECLS = ['declare void @glColor3f(float, float, float)', 'declare void @glVertex2f(float, float)',
            'declare void @glBegin(i32)', 'declare void @glEnd()']


class RawFn(object):
    """DSL（_irb.Mod）的 funcs 只要有 text() 就行；這個把一段現成的 IR 文字塞進去。"""
    def __init__(self, t):
        self.t = t

    def text(self):
        return self.t


def install_dsl(m):
    """把 HUD 的字型、函式、簽名放進 _irb.Mod（產生器用）。之後用 c('hud_text', ren, x, y, '字串', n, r, g, b) 呼叫。"""
    m.globs.append(font_global())
    m.decl('i32', 'SDL_SetRenderDrawColor', 'ptr', 'i8', 'i8', 'i8', 'i8')
    m.decl('i32', 'SDL_RenderFillRect', 'ptr', 'ptr')
    m.sigs['hud_text'] = ('void', ['ptr', 'i32', 'i32', 'ptr', 'i32', 'i8', 'i8', 'i8'], False)
    m.sigs['hud_int'] = ('void', ['ptr', 'i32', 'i32', 'i32', 'i8', 'i8', 'i8'], False)
    m.funcs.append(RawFn(hud_text_sdl_ir()))
    m.funcs.append(RawFn(hud_int_sdl_ir()))


def runs(s):
    """這串字在 hud_text 裡會畫幾個矩形（同一列的連續亮像素合併）。用來控制每個 HUD 的繪圖次數。"""
    n = len(s)
    total = 0
    for r in range(NROWS):
        prev = 0
        for X in range(7 * n + 1):
            bit = 0
            if X < 7 * n:
                c = ord(s[X // 7])
                c = c if 32 <= c <= 126 else 32
                bit = (FD.ROWS[(c - 32) * 13 + r] >> (6 - X % 7)) & 1
            if bit and not prev:
                total += 1
            prev = bit
    return total


def str_global(name, s):
    """手寫 .ll 用的字串常數（不含結尾 NUL 之外的位元組長度正確）。"""
    b = s.encode('ascii') + b'\0'
    return '@%s = private constant [%d x i8] c"%s"' % (name, len(b), esc(b))


# ---- 單元測試用的固定 IR（renderer/src/uml/llvm_hud.test.js 讀它）：python _hud.py 會重產 _hud_test.ll
TEST_STRINGS = [('t1', 'MUSIC BOX'), ('t2', 'UP DOWN TEMPO'), ('t4', 'ESC QUIT  NOTES PLAYED '), ('t5', '000')]


def test_fixture_text():
    L = ['target triple = "x86_64-pc-linux-gnu"',
         'declare i32 @SDL_SetRenderDrawColor(ptr, i8, i8, i8, i8)',
         'declare i32 @SDL_RenderFillRect(ptr, ptr)',
         font_global()]
    L += [str_global(n, s) for n, s in TEST_STRINGS]
    L.append('@t3 = private constant [3 x i8] c"A\E4B"')   # 非 ASCII 位元組（0xE4）應畫成空白
    L.append(hud_text_sdl_ir())
    L.append(hud_int_sdl_ir())
    L.append('define i32 @main() {\nentry:\n'
             '  call void @hud_text(ptr null, i32 3, i32 5, ptr @t1, i32 9, i8 255, i8 255, i8 255)\n'
             '  call void @hud_int(ptr null, i32 40, i32 5, i32 105, i8 255, i8 255, i8 255)\n'
             '  call void @hud_int(ptr null, i32 70, i32 5, i32 7, i8 255, i8 255, i8 255)\n'
             '  call void @hud_text(ptr null, i32 3, i32 40, ptr @t2, i32 13, i8 255, i8 255, i8 255)\n'
             '  call void @hud_text(ptr null, i32 3, i32 60, ptr @t3, i32 3, i8 255, i8 255, i8 255)\n'
             '  call void @hud_text(ptr null, i32 3, i32 80, ptr @t4, i32 24, i8 255, i8 255, i8 255)\n'
             '  call void @hud_text(ptr null, i32 3, i32 100, ptr @t5, i32 3, i8 255, i8 255, i8 255)\n'
             '  ret i32 0\n}')
    return '\n'.join(L) + '\n'


if __name__ == '__main__':
    out = os.path.join(os.path.dirname(os.path.abspath(__file__)), '_hud_test.ll')
    open(out, 'w', encoding='utf-8').write(test_fixture_text())
    print('wrote', out)
