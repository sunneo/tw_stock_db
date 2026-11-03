# -*- coding: utf-8 -*-
"""
pygame -- a small subset of pygame on top of a skill window (gui.py). The screen is a canvas: flip() sends the frame's drawing
commands in one message, and event.get() reads the keys and the close button from the window's queue.

    import pygame
    pygame.init()
    screen = pygame.display.set_mode((320, 240))
    x = 150
    clock = pygame.time.Clock()
    running = True
    while running:
        for ev in pygame.event.get():
            if ev.type == pygame.QUIT:
                running = False
        if pygame.key.get_pressed()[pygame.K_LEFT]:
            x -= 4
        screen.fill((0, 0, 0))
        pygame.draw.rect(screen, (0, 255, 0), pygame.Rect(x, 200, 60, 8))
        pygame.display.flip()
        clock.tick(30)
    pygame.quit()

Supported: display (set_mode, set_caption, flip, update, get_surface), draw (rect, circle, line), Rect, font (Font, SysFont,
render), image (load: PNG, JPEG, GIF, WebP), transform (scale), event (get; QUIT, KEYDOWN, KEYUP, MOUSEMOTION, MOUSEBUTTONDOWN,
MOUSEBUTTONUP, MOUSEWHEEL, VIDEORESIZE; set_mode(size, RESIZABLE) makes the window resizable and maximizable), key (get_pressed), mouse (get_pos, get_pressed), time (Clock, get_ticks, wait), and the K_ key constants below.
The mouse positions are in the screen's pixels; button 1 is the left button, 2 the middle one, 3 the right one.
Limits: the text size and font are the page's (the size argument is ignored); no sound; no offscreen Surface drawing (only the
screen, and a picture can be blitted onto it); line and circle widths other than 1 and 0 raise NotImplementedError; a frame has at
most 200 commands; a picture is at most 256 KB and at most 16 per window, and image.load needs set_mode first (the picture is
registered on the window's canvas). Pictures are drawn at their own size or the size transform.scale gives; their own alpha
channel shows, but there is no set_alpha / colorkey. The window's title is the one set_caption had before set_mode. Click the
window once so it has the keyboard for key presses.
"""
import time as _time

import gui

error = RuntimeError

QUIT = 256
KEYDOWN = 768
KEYUP = 769
MOUSEMOTION = 1024
MOUSEBUTTONUP = 1025
MOUSEBUTTONDOWN = 1026
MOUSEWHEEL = 1027
VIDEORESIZE = 32797
RESIZABLE = 16                # set_mode flag: the window can be resized and maximized; a resize arrives as VIDEORESIZE (size=(w, h))
K_RETURN = 13
K_ESCAPE = 27
K_SPACE = 32
K_RIGHT = 1073741903
K_LEFT = 1073741904
K_DOWN = 1073741905
K_UP = 1073741906
_JS_KEYS = {"ArrowUp": K_UP, "ArrowDown": K_DOWN, "ArrowLeft": K_LEFT, "ArrowRight": K_RIGHT, " ": K_SPACE,
            "Enter": K_RETURN, "Escape": K_ESCAPE}
_NAMED = {"black": (0, 0, 0), "white": (255, 255, 255), "red": (255, 0, 0), "green": (0, 255, 0), "blue": (0, 0, 255),
          "yellow": (255, 255, 0), "cyan": (0, 255, 255), "magenta": (255, 0, 255), "gray": (128, 128, 128),
          "grey": (128, 128, 128)}
MAX_OPS = 200
MAX_PICTURE = 256 * 1024
_PICTURE_TYPES = (("\x89PNG", "image/png"), ("\xff\xd8\xff", "image/jpeg"), ("GIF8", "image/gif"))

# the window, its canvas and the screen Surface, plus the key state and the caption for the next set_mode
_state = {"window": None, "canvas": None, "screen": None, "caption": "pygame", "keys": {}, "started": None,
          "mouse": {"pos": (0, 0), "pressed": [False, False, False]}}


def _key_code(name):
    """A page key name ("ArrowLeft", "a") as a pygame key code: letters and digits are their lowercase code point."""
    if name in _JS_KEYS:
        return _JS_KEYS[name]
    if isinstance(name, str) and len(name) == 1:
        return ord(name.lower())
    return 0


def _hex(color):
    """A pygame color (a name, an (r, g, b) tuple, or "#rrggbb") as the page's color text."""
    if isinstance(color, str):
        if color.startswith("#"):
            return color
        if color not in _NAMED:
            raise ValueError("unknown color name " + repr(color))
        color = _NAMED[color]
    r, g, b = (max(0, min(255, int(c))) for c in tuple(color)[:3])
    return "#%02x%02x%02x" % (r, g, b)


class Rect(object):
    def __init__(self, x, y=None, w=None, h=None):
        if y is None:
            x, y, w, h = x
        self.x, self.y, self.w, self.h = int(x), int(y), int(w), int(h)

    @property
    def width(self):
        return self.w

    @property
    def height(self):
        return self.h

    @property
    def left(self):
        return self.x

    @property
    def top(self):
        return self.y

    @property
    def right(self):
        return self.x + self.w

    @property
    def bottom(self):
        return self.y + self.h

    def collidepoint(self, x, y=None):
        if y is None:
            x, y = x
        return self.x <= x < self.right and self.y <= y < self.bottom

    def colliderect(self, other):
        return self.x < other.right and other.x < self.right and self.y < other.bottom and other.y < self.bottom

    def move(self, dx, dy):
        return Rect(self.x + dx, self.y + dy, self.w, self.h)

    def copy(self):
        return Rect(self.x, self.y, self.w, self.h)

    def __iter__(self):
        return iter((self.x, self.y, self.w, self.h))

    def __eq__(self, other):
        return tuple(self) == tuple(other)

    def __repr__(self):
        return "Rect(%d, %d, %d, %d)" % (self.x, self.y, self.w, self.h)


def _rect_args(rect):
    return tuple(rect) if not isinstance(rect, Rect) else (rect.x, rect.y, rect.w, rect.h)


class _Text(object):
    """What font.render returns: blit draws it as a text command on the screen."""

    def __init__(self, text, color):
        self.text = text
        self.color = color


class _Picture(object):
    """What image.load returns: a registered picture (name on the window's canvas) and its size. transform.scale gives a copy with
    another size; blit draws it as an image command on the screen."""

    def __init__(self, name, w, h):
        self.name = name
        self.w = w
        self.h = h

    def get_width(self):
        return self.w

    def get_height(self):
        return self.h

    def get_size(self):
        return (self.w, self.h)

    def get_rect(self):
        return Rect(0, 0, self.w, self.h)


class Surface(object):
    """The screen. Drawing calls add commands; display.flip() sends them as one frame."""

    def __init__(self, size):
        self.size = (int(size[0]), int(size[1]))
        self.ops = []

    def get_width(self):
        return self.size[0]

    def get_height(self):
        return self.size[1]

    def get_rect(self):
        return Rect(0, 0, self.size[0], self.size[1])

    def fill(self, color, rect=None):
        if rect is None:
            self.ops.append(["clear", _hex(color)])
        else:
            x, y, w, h = _rect_args(rect)
            self.ops.append(["rect", x, y, w, h, _hex(color)])

    def blit(self, source, dest):
        x, y = (dest.x, dest.y) if isinstance(dest, Rect) else (int(dest[0]), int(dest[1]))
        if isinstance(source, _Picture):
            self.ops.append(["image", source.name, x, y, source.w, source.h])
        elif isinstance(source, _Text):
            self.ops.append(["text", x, y, source.text, source.color])
        else:
            raise NotImplementedError("blit supports text from font.render and pictures from image.load")


class _Display(object):
    def set_mode(self, size=(640, 480), flags=0, depth=0):
        if _state["window"] is not None:
            raise error("set_mode: the window is already open (one screen per program)")
        w, h = int(size[0]), int(size[1])
        # RESIZABLE lets the user resize and maximize the window; the program then gets VIDEORESIZE events with the new size
        resizable = bool(int(flags) & RESIZABLE)
        win = gui.Window(_state["caption"], width=max(160, w + 24), resizable=resizable, maximizable=resizable)
        _state["canvas"] = win.canvas(width=w, height=h, fps=0)
        _state["window"] = win
        _state["screen"] = Surface((w, h))
        return _state["screen"]

    def set_caption(self, title, icontitle=None):
        _state["caption"] = str(title)

    def get_surface(self):
        return _state["screen"]

    def flip(self):
        if _state["screen"] is None:
            raise error("display.flip before display.set_mode")
        ops = _state["screen"].ops
        if len(ops) > MAX_OPS:
            raise error("a frame has %d drawing commands, at most %d" % (len(ops), MAX_OPS))
        _state["window"].draw(_state["canvas"], list(ops))
        _state["screen"].ops = []

    def update(self, rects=None):
        self.flip()


class _Draw(object):
    @staticmethod
    def rect(surface, color, rect, width=0):
        x, y, w, h = _rect_args(rect)
        c = _hex(color)
        if width == 0:
            surface.ops.append(["rect", x, y, w, h, c])
            return
        t = int(width)
        surface.ops.append(["rect", x, y, w, t, c])                # top
        surface.ops.append(["rect", x, y + h - t, w, t, c])        # bottom
        surface.ops.append(["rect", x, y, t, h, c])                # left
        surface.ops.append(["rect", x + w - t, y, t, h, c])        # right

    @staticmethod
    def circle(surface, color, center, radius, width=0):
        if width != 0:
            raise NotImplementedError("draw.circle supports only a filled circle (width 0)")
        surface.ops.append(["circle", int(center[0]), int(center[1]), int(radius), _hex(color)])

    @staticmethod
    def line(surface, color, start, end, width=1):
        if width != 1:
            raise NotImplementedError("draw.line supports only width 1")
        surface.ops.append(["line", int(start[0]), int(start[1]), int(end[0]), int(end[1]), _hex(color)])


class _Font(object):
    def __init__(self, name=None, size=14, bold=False, italic=False):
        self.size = size

    def render(self, text, antialias=True, color=(255, 255, 255), background=None):
        if background is not None:
            raise NotImplementedError("font.render supports no background color")
        return _Text(str(text), _hex(color))


class _Event(object):
    def __init__(self, type_, **fields):
        self.type = type_
        self.__dict__.update(fields)


class _Event_(object):
    @staticmethod
    def get():
        win = _state["window"]
        if win is None:
            return []
        out = []
        while True:
            ev = win.poll()           # never waits; the page answers from its queue
            if ev is None:
                break
            kind = ev.get("event")
            if kind == "close":
                out.append(_Event(QUIT))
            elif kind == "key":
                v = ev.get("value") or {}
                code = _key_code(v.get("key", ""))
                _state["keys"][code] = bool(v.get("down"))
                out.append(_Event(KEYDOWN if v.get("down") else KEYUP, key=code))
            elif kind == "resize":
                # the page resized the canvas (window resized or maximized): the screen takes the new size
                v = ev.get("value") or {}
                size = (int(v.get("width", 0)), int(v.get("height", 0)))
                if _state["screen"] is not None:
                    _state["screen"].size = size
                out.append(_Event(VIDEORESIZE, size=size, w=size[0], h=size[1]))
            elif kind == "wheel":
                v = ev.get("value") or {}
                pos = (int(v.get("x", 0)), int(v.get("y", 0)))
                # pygame's y is positive when the wheel goes up, the browser's deltaY is positive when it goes down
                out.append(_Event(MOUSEWHEEL, pos=pos, x=0, y=-1 if float(v.get("dy", 0)) > 0 else 1))
            elif kind == "mouse":
                v = ev.get("value") or {}
                mouse = _state["mouse"]
                pos = (int(v.get("x", 0)), int(v.get("y", 0)))
                button = int(v.get("button", 0)) + 1          # pygame numbers the buttons from 1: left, middle, right
                if v.get("kind") == "move":
                    rel = (pos[0] - mouse["pos"][0], pos[1] - mouse["pos"][1])
                    out.append(_Event(MOUSEMOTION, pos=pos, rel=rel, buttons=tuple(mouse["pressed"])))
                else:
                    down = v.get("kind") == "down"
                    if 1 <= button <= 3:
                        mouse["pressed"][button - 1] = down
                    out.append(_Event(MOUSEBUTTONDOWN if down else MOUSEBUTTONUP, pos=pos, button=button))
                mouse["pos"] = pos
        return out


class _Pressed(object):
    def __getitem__(self, code):
        return bool(_state["keys"].get(code, False))


class _Key(object):
    @staticmethod
    def get_pressed():
        return _Pressed()


class _Mouse(object):
    @staticmethod
    def get_pos():
        return _state["mouse"]["pos"]

    @staticmethod
    def get_pressed(num_buttons=3):
        return tuple(_state["mouse"]["pressed"])


class _Clock(object):
    def __init__(self):
        self._last = _time.time()
        self._fps = 0.0

    def tick(self, framerate=0):
        now = _time.time()
        if framerate and framerate > 0:
            spent = now - self._last
            if spent < 1.0 / framerate:
                _time.sleep(1.0 / framerate - spent)
        t = _time.time()
        dt = t - self._last
        self._last = t
        self._fps = 1.0 / dt if dt > 0 else 0.0
        return int(dt * 1000)

    def get_fps(self):
        return self._fps


class _Time(object):
    Clock = _Clock

    @staticmethod
    def get_ticks():
        started = _state["started"]
        return int((_time.time() - started) * 1000) if started is not None else 0

    @staticmethod
    def wait(ms):
        _time.sleep(max(0, int(ms)) / 1000.0)
        return int(ms)

    delay = wait


def _picture_type(data):
    for magic, mime in _PICTURE_TYPES:
        if data.startswith(magic.encode("latin-1")):
            return mime
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    raise error("image.load: the file is not a PNG, JPEG, GIF or WebP picture")


class _Image_(object):
    @staticmethod
    def load(path):
        if _state["window"] is None:
            raise error("image.load: call display.set_mode first (the picture is drawn on the screen's canvas)")
        with open(path, "rb") as f:
            data = f.read(MAX_PICTURE + 1)
        if len(data) > MAX_PICTURE:
            raise error("image.load: the picture is larger than %d KB" % (MAX_PICTURE // 1024))
        name, w, h = _state["window"].image(_state["canvas"], data, _picture_type(data))
        return _Picture(name, w, h)


class _Transform(object):
    @staticmethod
    def scale(surface, size):
        if not isinstance(surface, _Picture):
            raise NotImplementedError("transform.scale supports pictures from image.load only")
        return _Picture(surface.name, max(1, int(size[0])), max(1, int(size[1])))


class _Font_(object):
    Font = _Font

    @staticmethod
    def SysFont(name, size, bold=False, italic=False):
        return _Font(name, size, bold, italic)

    @staticmethod
    def init():
        return None


def init():
    if _state["started"] is None:
        _state["started"] = _time.time()
    return (0, 0)


def quit():
    if _state["window"] is not None:
        _state["window"].close()
    _state["window"] = None
    _state["canvas"] = None
    _state["screen"] = None


display = _Display()
draw = _Draw()
event = _Event_()
key = _Key()
time = _Time()
font = _Font_()
image = _Image_()
mouse = _Mouse()
transform = _Transform()
