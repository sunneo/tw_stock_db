# -*- coding: utf-8 -*-
# The pygame subset (assets/pybridge/pygame.py) against a stubbed fa_bridge: window and canvas, frame ops, text, keys, close,
# the limits. Run: python3 test/gui_bridge/gui_pygame_test.py
import os
import sys
import types

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..', 'pybridge'))

calls = []
replies = []


def fake_call(op, args=None, timeout=240.0):
    calls.append((op, args))
    return replies.pop(0) if replies else None


stub = types.ModuleType('fa_bridge')
stub.call = fake_call
sys.modules['fa_bridge'] = stub

import pygame  # noqa: E402

failures = []


def check(name, cond):
    if not cond:
        failures.append(name)
        print('FAIL', name)


def raises(exc, fn):
    try:
        fn()
    except exc:
        return True
    except Exception:
        return False
    return False


pygame.init()
screen = pygame.display.set_mode((320, 240))
check('open window', calls[0][0] == 'gui.open' and calls[0][1]['width'] == 344)
check('a plain window is not resizable or maximizable', calls[0][1]['resizable'] is False and calls[0][1]['maximizable'] is False)
check('canvas node', calls[1][1]['node'] == {'id': 'n1', 'kind': 'canvas', 'width': 320, 'height': 240, 'fps': 0})
check('screen size', screen.get_width() == 320 and screen.get_height() == 240)
check('screen get_size / get_rect', screen.get_size() == (320, 240) and screen.get_rect().width == 320 and screen.get_rect().height == 240)
check('one screen per program', raises(RuntimeError, lambda: pygame.display.set_mode((10, 10))))

# fill, rect, circle, line, text: one flip sends them in order as one gui.draw
calls.clear()
screen.fill((0, 0, 0))
pygame.draw.rect(screen, 'green', pygame.Rect(10, 20, 30, 4))
pygame.draw.circle(screen, (255, 255, 0), (100, 100), 8)
pygame.draw.line(screen, '#123456', (0, 0), (319, 239))
screen.blit(pygame.font.Font(None, 20).render('score 0', True, (200, 200, 200)), (4, 12))
pygame.display.flip()
check('flip sends one draw', len(calls) == 1 and calls[0][0] == 'gui.draw')
check('draw ops', calls[0][1]['ops'] == [
    ['clear', '#000000'],
    ['rect', 10, 20, 30, 4, '#00ff00'],
    ['circle', 100, 100, 8, '#ffff00'],
    ['line', 0, 0, 319, 239, '#123456'],
    ['text', 4, 12, 'score 0', '#c8c8c8'],
])
check('flip clears the screen ops', screen.ops == [])
pygame.display.flip()
check('an empty frame is still sent', calls[-1][1]['ops'] == [])

# outlined rect: four strips; a width the subset does not do raises
screen.ops = []
pygame.draw.rect(screen, (1, 2, 3), (0, 0, 10, 8), 2)
check('outline rect strips', screen.ops == [['rect', 0, 0, 10, 2, '#010203'], ['rect', 0, 6, 10, 2, '#010203'],
                                            ['rect', 0, 0, 2, 8, '#010203'], ['rect', 8, 0, 2, 8, '#010203']])
check('circle outline unsupported', raises(NotImplementedError, lambda: pygame.draw.circle(screen, 'red', (1, 1), 2, 1)))
check('line width unsupported', raises(NotImplementedError, lambda: pygame.draw.line(screen, 'red', (0, 0), (1, 1), 3)))
check('blit image unsupported', raises(NotImplementedError, lambda: screen.blit(object(), (0, 0))))
check('unknown color name', raises(ValueError, lambda: screen.fill('mauve')))
check('tuple color clamps', screen.fill((300, -5, 16)) is None and screen.ops[-1] == ['clear', '#ff0010'])

# a frame over the limit is refused before it is sent
screen.ops = []
for _ in range(201):
    screen.fill((0, 0, 0))
n = len(calls)
check('more than 200 commands raises', raises(RuntimeError, lambda: pygame.display.flip()))
check('nothing sent for an oversized frame', len(calls) == n)
screen.ops = []

# events: key presses update get_pressed; the page's poll answers from its queue
calls.clear()
replies[:] = [
    {'v': 1, 'event': 'frame', 'id': 'x', 'node': 'n1', 'value': {'t': 1}},
    {'v': 1, 'event': 'key', 'id': 'x', 'node': 'n1', 'value': {'key': 'ArrowLeft', 'down': True}},
    {'v': 1, 'event': 'key', 'id': 'x', 'node': 'n1', 'value': {'key': 'a', 'down': True}},
    None,
]
evs = pygame.event.get()
check('keydown events', [e.type for e in evs] == [pygame.KEYDOWN, pygame.KEYDOWN])
check('arrow code', evs[0].key == pygame.K_LEFT)
check('letter code', evs[1].key == ord('a'))
check('pressed while down', pygame.key.get_pressed()[pygame.K_LEFT] and pygame.key.get_pressed()[ord('a')])
check('poll never waits', all(c[0] == 'gui.poll' for c in calls))

replies[:] = [{'v': 1, 'event': 'key', 'id': 'x', 'node': 'n1', 'value': {'key': 'ArrowLeft', 'down': False}}, None]
evs = pygame.event.get()
check('keyup event', evs[0].type == pygame.KEYUP and not pygame.key.get_pressed()[pygame.K_LEFT])

replies[:] = [{'v': 1, 'event': 'close', 'id': 'x', 'node': 'root'}, None]
evs = pygame.event.get()
check('close gives QUIT', len(evs) == 1 and evs[0].type == pygame.QUIT)

# clock, ticks, the Rect helpers
clock = pygame.time.Clock()
check('tick returns ms', isinstance(clock.tick(1000), int))
check('ticks start at zero after init', pygame.time.get_ticks() >= 0)
r = pygame.Rect(0, 0, 10, 10)
check('rect collide', r.colliderect(pygame.Rect(5, 5, 10, 10)) and not r.colliderect(pygame.Rect(10, 0, 5, 5)))
check('rect point', r.collidepoint(9, 9) and not r.collidepoint(10, 0))
check('rect move', r.move(3, 4) == pygame.Rect(3, 4, 10, 10) and r.left == 0 and r.right == 10)

pygame.quit()
check('quit after a close event sends no second close', calls[-1][0] != 'gui.close')
pygame.display.set_mode((64, 64))
check('set_mode again after quit opens a new window', [c[0] for c in calls[-2:]] == ['gui.open', 'gui.add'])


# mouse: the page's pointer events come out of event.get as MOUSEMOTION / MOUSEBUTTONDOWN / MOUSEBUTTONUP; get_pos and get_pressed follow them
replies.extend([{'event': 'mouse', 'value': {'kind': 'move', 'x': 10, 'y': 12}},
                {'event': 'mouse', 'value': {'kind': 'down', 'x': 10, 'y': 12, 'button': 0}}])
evs = pygame.event.get()
check('mouse events come out in order', [e.type for e in evs] == [pygame.MOUSEMOTION, pygame.MOUSEBUTTONDOWN])
check('mouse down carries the position and button 1 (left)', evs[1].pos == (10, 12) and evs[1].button == 1)
check('mouse move carries the position and the movement', evs[0].pos == (10, 12) and evs[0].rel == (10, 12))
check('get_pos follows the last event', pygame.mouse.get_pos() == (10, 12))
check('get_pressed shows the left button held', pygame.mouse.get_pressed()[0] is True and pygame.mouse.get_pressed()[2] is False)
replies.append({'event': 'wheel', 'value': {'x': 4, 'y': 5, 'dy': 120}})
evs = pygame.event.get()
check('wheel down (browser dy > 0) is MOUSEWHEEL with y -1', evs[0].type == pygame.MOUSEWHEEL and evs[0].y == -1 and evs[0].pos == (4, 5))
replies.append({'event': 'wheel', 'value': {'x': 4, 'y': 5, 'dy': -120}})
evs = pygame.event.get()
check('wheel up (browser dy < 0) is MOUSEWHEEL with y 1', evs[0].type == pygame.MOUSEWHEEL and evs[0].y == 1)
replies.append({'event': 'mouse', 'value': {'kind': 'up', 'x': 30, 'y': 40, 'button': 2}})
evs = pygame.event.get()
check('right button up is MOUSEBUTTONUP with button 3', evs[0].type == pygame.MOUSEBUTTONUP and evs[0].button == 3 and evs[0].pos == (30, 40))
check('get_pos moves with the release', pygame.mouse.get_pos() == (30, 40))
replies.append({'event': 'mouse', 'value': {'kind': 'up', 'x': 30, 'y': 40, 'button': 0}})
pygame.event.get()
check('left button up clears get_pressed', pygame.mouse.get_pressed()[0] is False)

# pictures: image.load registers the file on the canvas (gui.image) and blit / transform.scale draw it by name
import struct  # noqa: E402
import tempfile  # noqa: E402
import zlib  # noqa: E402


def make_png(w, h):
    """A small solid PNG (pure Python: zlib + struct), so the test needs no image library."""
    raw = b''.join(b'\x00' + b'\x20\x80\x40\xff' * w for _ in range(h))
    def chunk(kind, body):
        return struct.pack('>I', len(body)) + kind + body + struct.pack('>I', zlib.crc32(kind + body) & 0xffffffff)
    return (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 6, 0, 0, 0))
            + chunk(b'IDAT', zlib.compress(raw)) + chunk(b'IEND', b''))


tmp = tempfile.mkdtemp()
ship = os.path.join(tmp, 'ship.png')
with open(ship, 'wb') as f:
    f.write(make_png(16, 12))
screen = pygame.display.get_surface()
replies.append({'w': 16, 'h': 12})
calls[:] = []
pic = pygame.image.load(ship)
check('load sends gui.image with a PNG data URL', calls[-1][0] == 'gui.image' and calls[-1][1]['data'].startswith('data:image/png;base64,'))
check('load gives the picture size from the page', pic.get_width() == 16 and pic.get_height() == 12 and pic.get_size() == (16, 12))
check('the picture name is the one the page registered', calls[-1][1]['name'] == 'i1' and pic.name == 'i1')
screen.blit(pic, (3, 4))
check('blit draws the picture at its own size', screen.ops[-1] == ['image', 'i1', 3, 4, 16, 12])
screen.blit(pygame.transform.scale(pic, (32, 6)), pygame.Rect(7, 8, 1, 1))
check('transform.scale changes the drawn size and keeps the name', screen.ops[-1] == ['image', 'i1', 7, 8, 32, 6])
check('the scaled copy does not change the original', pic.get_size() == (16, 12))
check('blit still draws text', (screen.blit(pygame.font.Font().render('x'), (1, 1)) is None) and screen.ops[-1][0] == 'text')
text_file = os.path.join(tmp, 'a.txt')
with open(text_file, 'w') as f:
    f.write('not a picture')
n_before = len(calls)
check('a non-picture file is refused', raises(RuntimeError, lambda: pygame.image.load(text_file)) and len(calls) == n_before)
big = os.path.join(tmp, 'big.png')
with open(big, 'wb') as f:
    f.write(make_png(16, 12) + b'\x00' * (256 * 1024))
check('a picture over 256 KB is refused before the page', raises(RuntimeError, lambda: pygame.image.load(big)) and len(calls) == n_before)
check('blit of an unknown object is refused', raises(NotImplementedError, lambda: screen.blit(object(), (0, 0))))

pygame.quit()
check('load after quit needs set_mode first', raises(RuntimeError, lambda: pygame.image.load(ship)))

# RESIZABLE: the window opens resizable and maximizable; the page's resize (window dragged or maximized) arrives as VIDEORESIZE and the screen takes the size
calls.clear()
replies.clear()
pygame.init()
screen = pygame.display.set_mode((320, 240), pygame.RESIZABLE)
check('a RESIZABLE window opens resizable and maximizable', calls[0][1]['resizable'] is True and calls[0][1]['maximizable'] is True)
replies.append({'v': 1, 'event': 'resize', 'id': calls[0][1]['id'], 'node': 'n1', 'value': {'width': 400, 'height': 260}})
events = pygame.event.get()
check('resize arrives as VIDEORESIZE with the new size', len(events) == 1 and events[0].type == pygame.VIDEORESIZE and events[0].size == (400, 260))
check('the screen takes the new size', screen.get_width() == 400 and screen.get_height() == 260)
pygame.quit()

if failures:
    print('pygame subset: %d checks failed' % len(failures))
    sys.exit(1)
print('pygame subset: all checks passed')
