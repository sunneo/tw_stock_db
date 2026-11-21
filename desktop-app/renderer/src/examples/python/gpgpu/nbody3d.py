# -*- coding: utf-8 -*-
"""
nbody3d.py -- 3D N-body gravity, a port of exams/nbody3d.c (the NVIDIA CUDA nbody sample's algorithm with a softening parameter) to a
GPGPU example. Every body pulls on every other one, O(N^2) work per frame; the pairwise sum runs on the compute source you choose:

    CPU  numpy, vectorized in blocks (always works)
    GPU  a numba @cuda.jit kernel, translated to WGSL and run on the real GPU through WebGPU (GPU compatibility layer)

Run:    python nbody3d.py [N]                    N bodies (default 3072, like the C program); a window with a 3D view
        python nbody3d.py --device cpu|gpu|auto  start on a source ("auto" = GPU when the page can run kernels, else CPU);
                                                 the CPU / GPU buttons switch it while it runs
        python nbody3d.py --bench [N]            no window: time both sources for a few steps and compare the results
        python nbody3d.py --seed 5 --loops 500   random seed; frames per cycle (the C program uses 2000)

Same as the C program:
  * Physics: F = G * m_j * r / (r^2 + eps^2)^(3/2) with softening eps; v += sum * dt; position += clampf(v, MIN_velocity, MAX_Velocity) * dt,
    where clampf is the C program's soft clamp (a value past a limit is moved halfway back toward it, not cut). Masses are 200..299.
  * Start: bodies uniform in a box 0..MAX_X x 0..MAX_Y x 0..MAX_Z, velocity 0. Every LOOP (2000) frames it prints "N seconds",
    randomizes MAX_X/Y/Z, MAX_Velocity, Gravity_Coef and SOFTENING in the same ranges, and starts over.
  * Look: glowing gaussian point sprites with additive blending in the cyan family (the C program's glowColors), positions scaled by 0.1,
    camera orbiting the origin (distance 50, angles 0.3 and 0), cluster-center tracking (the body with the highest gravitational
    potential and its neighbors within 100, weighted by mass / (distance + 1)).
  * Controls: drag the picture = rotate; arrows = rotate; + / - = zoom; C = camera tracking (snapshots the cluster center); R = random
    simulation factor each cycle; H = show / hide the overlay; the two sliders in the overlay set the simulation factor (0..2) and the
    particle size (5..200). Click the picture once so it gets the keyboard.

Differences (on purpose): the C program starts with camera tracking on but a snapshot center of 0, so the bodies (which fill a box from 0
to MAX_X/Y/Z, times 0.1) are mostly off screen until you press C twice; here the snapshot starts at the center of each cycle's box, so the
cloud is centered from the first frame (pressing C still snapshots the cluster center, as in the C program). The C program updates positions in place while other threads still read them (a data race under OpenMP); here every
body sees the same positions in a frame, so the result is deterministic. The camera is right-handed (the C program's is left-handed), so
the picture is a mirror image. If the GPU kernel cannot run (no WebGPU, or the page refuses it), the compatibility layer would emulate it one
thread at a time in Python, far slower than numpy; this program notices after the first GPU frame, switches back to CPU and says so.
"""
import argparse
import math
import sys
import time

import numpy as np

try:
    from numba import cuda
except Exception:  # the compatibility layer is off or missing: the GPU source is simply not offered
    cuda = None

# ------------------------------------------------------------------ constants (nbody3d.c)
SCREENX, SCREENY = 1400, 800
NUM_BODY = 3072
LOOP = 2000
MIN_VELOCITY = 1.0
MAX_MASS, MIN_MASS = 300, 200
PARTICLE_SIZE_MIN, PARTICLE_SIZE_MAX, PARTICLE_SIZE_DEFAULT = 5.0, 200.0, 15.0
MOUSE_ROTATION_SENSITIVITY = 0.005
CAM_ANGLE_X_MAX, CAM_ANGLE_X_MIN = 1.5, -1.5
CAM_TRANSITION_SPEED = 0.1
SLIDER_X_START, SLIDER_WIDTH = 320, 400
SLIDER_SIM_Y, SLIDER_PARTICLE_Y, SLIDER_HEIGHT = 25, 65, 15
GLOW_COLORS = (0xFFFF00, 0xFFFF40, 0xFFFF80, 0xFFFFC0, 0xFFFFFF, 0xE0E000, 0xC0C000, 0xFFFF60, 0xFFFFA0, 0xFFFFE0)   # cyan family (BGR ints)


def clampf(v, lo, hi):
    """The C program's clampf: a value beyond a limit is moved halfway back toward it (v = (v + limit) / 2), not cut off."""
    v = np.where(v > hi, (v + hi) * 0.5, v)
    v = np.where(v < lo, (v + lo) * 0.5, v)
    return v


# ------------------------------------------------------------------ pairwise sums: CPU (numpy) and GPU (numba kernel)
def pairwise_cpu(px, py, pz, m, soft2, gcoef, block=256):
    """For every body i: sum over j != i of s * (xj - xi) with s = G * m_j / (r^2 + eps^2)^(3/2) (three arrays), and the potential sum of m_j / dist."""
    n = px.shape[0]
    sx = np.empty(n, np.float32); sy = np.empty(n, np.float32); sz = np.empty(n, np.float32); pot = np.empty(n, np.float32)
    soft2 = np.float32(soft2); gcoef = np.float32(gcoef)
    for a in range(0, n, block):
        b = min(n, a + block)
        dx = px[None, :] - px[a:b, None]
        dy = py[None, :] - py[a:b, None]
        dz = pz[None, :] - pz[a:b, None]
        inv = 1.0 / np.sqrt(dx * dx + dy * dy + dz * dz + soft2)
        s = gcoef * m[None, :] * inv * inv * inv           # j == i has dx = dy = dz = 0, so it adds no force
        sx[a:b] = (s * dx).sum(axis=1); sy[a:b] = (s * dy).sum(axis=1); sz[a:b] = (s * dz).sum(axis=1)
        pot[a:b] = (m[None, :] * inv).sum(axis=1) - m[a:b] / np.sqrt(soft2)   # leave out the body's own term
    return sx, sy, sz, pot


if cuda is not None:
    @cuda.jit
    def nbody_kernel(px, py, pz, m, sx, sy, sz, pot, n, soft2, gcoef):
        i = cuda.grid(1)
        if i < n:
            ax = 0.0
            ay = 0.0
            az = 0.0
            p = 0.0
            for j in range(n):
                if j != i:
                    dx = px[j] - px[i]
                    dy = py[j] - py[i]
                    dz = pz[j] - pz[i]
                    d2 = dx * dx + dy * dy + dz * dz + soft2
                    inv = 1.0 / math.sqrt(d2)
                    s = gcoef * m[j] * inv * inv * inv
                    ax += s * dx
                    ay += s * dy
                    az += s * dz
                    p += m[j] * inv
            sx[i] = ax
            sy[i] = ay
            sz[i] = az
            pot[i] = p


def pairwise_gpu(px, py, pz, m, soft2, gcoef):
    n = px.shape[0]
    sx = np.zeros(n, np.float32); sy = np.zeros(n, np.float32); sz = np.zeros(n, np.float32); pot = np.zeros(n, np.float32)
    threads = 64
    nbody_kernel[(n + threads - 1) // threads, threads](px, py, pz, m, sx, sy, sz, pot, n, float(soft2), float(gcoef))
    return sx, sy, sz, pot


def gpu_fallbacks():
    """How many kernel launches the compatibility layer has had to emulate on the CPU (0 means every launch ran on the GPU)."""
    try:
        import fa_gpu
        return int(fa_gpu.STATS.get("fallbacks", 0))
    except Exception:
        return 0


_PROBE = {}


def probe_gpu():
    """Try the GPU kernel once on a tiny problem. Returns (ok, reason). If the compatibility layer would emulate it one thread at a time in
    Python (no WebGPU, a limit the adapter does not meet...), say so up front instead of crawling through the first real frames."""
    if "r" in _PROBE:
        return _PROBE["r"]
    if cuda is None:
        _PROBE["r"] = (False, "the GPU compatibility layer is off")
        return _PROBE["r"]
    before = gpu_fallbacks()
    try:
        r = np.random.RandomState(0)
        f = lambda: r.uniform(0, 10, 16).astype(np.float32)
        pairwise_gpu(f(), f(), f(), np.full(16, 250, np.float32), 100.0, 30.0)
        if gpu_fallbacks() > before:
            try:
                import fa_gpu
                why = str(fa_gpu.STATS.get("reason") or "")
            except Exception:
                why = ""
            _PROBE["r"] = (False, why[:240] or "the kernel could not run on the GPU")
        else:
            _PROBE["r"] = (True, "")
    except Exception as e:
        _PROBE["r"] = (False, str(e)[:240])
    return _PROBE["r"]


# ------------------------------------------------------------------ the simulation
class Sim(object):
    def __init__(self, n, device, seed=1, loops=LOOP):
        self.n = n
        self.device = device
        self.rng = np.random.RandomState(seed)
        self.loops = loops
        self.dt = 0.02                      # simulatetime_factor
        self.random_factor = False
        self.note = ""
        self.last_ms = 0.0
        self.phase = {}                     # last frame's time per phase in ms (pairwise / integrate / center here; render / hud from the window)
        self.psum, self.pcount = {}, 0       # sums over the current cycle, for the average printed at its end
        self.cycle_start = time.time()
        self.loop = 0
        self.center = (0.0, 0.0, 0.0)
        self.randomize()
        self.init_bodies()

    def randomize(self):
        """Randomize_Parameters(): the box, the velocity limit, gravity and softening for this cycle (same ranges as the C program)."""
        r = self.rng.uniform
        self.max_x = r(10.0, SCREENX); self.max_y = r(10.0, SCREENY); self.max_z = r(10.0, max(SCREENX, SCREENY))
        self.max_v = r(10.0, SCREENY / 2.0)
        self.gravity = r(10.0, 60.0)
        self.softening = r(50.0, 200.0)
        self.soft2 = self.softening * self.softening

    def init_bodies(self):
        n = self.n
        f = lambda a: np.ascontiguousarray(a, dtype=np.float32)
        self.x = f(self.rng.uniform(0, self.max_x, n)); self.y = f(self.rng.uniform(0, self.max_y, n)); self.z = f(self.rng.uniform(0, self.max_z, n))
        self.vx = np.zeros(n, np.float32); self.vy = np.zeros(n, np.float32); self.vz = np.zeros(n, np.float32)
        self.mass = f(self.rng.randint(MIN_MASS, MAX_MASS, n))
        self.pot = np.zeros(n, np.float32)
        self.loop = 0
        self.cycle_start = time.time()

    def set_device(self, device):
        if device == "gpu":
            ok, why = probe_gpu()
            if not ok:
                self.note = "GPU source not available here: " + why + " (staying on CPU)"
                device = "cpu"
        self.device = device

    def step(self):
        """One frame of Nbody() for every body, then the cluster center. Returns True when a cycle (LOOP frames) has just ended."""
        t0 = time.time()
        pc = time.perf_counter
        a0 = pc()
        args = (self.x, self.y, self.z, self.mass, self.soft2, self.gravity)
        if self.device == "gpu":
            before = gpu_fallbacks()
            sx, sy, sz, pot = pairwise_gpu(*args)
            if gpu_fallbacks() > before:
                self.note = "the GPU kernel stopped running on the GPU (it was emulated, very slowly): back to CPU"
                self.device = "cpu"
                sx, sy, sz, pot = pairwise_cpu(*args)
        else:
            sx, sy, sz, pot = pairwise_cpu(*args)
        a1 = pc()
        self.pot = pot
        dt = np.float32(self.dt)
        self.vx += sx * dt; self.vy += sy * dt; self.vz += sz * dt                     # newX_velocity[i] += sumX * simulatetime_factor
        self.x += clampf(self.vx, MIN_VELOCITY, self.max_v) * dt                         # X_axis[i] += clampf(newX_velocity[i], ...) * factor
        self.y += clampf(self.vy, MIN_VELOCITY, self.max_v) * dt
        self.z += clampf(self.vz, MIN_VELOCITY, self.max_v) * dt
        a2 = pc()
        self.center = self.cluster_center()
        a3 = pc()
        self.last_ms = (time.time() - t0) * 1000.0
        self.note_phases(pairwise=(a1 - a0) * 1000.0, integrate=(a2 - a1) * 1000.0, center=(a3 - a2) * 1000.0)
        self.loop += 1
        if self.loop >= self.loops:
            print("%d %f" % (self.n, time.time() - self.cycle_start))
            self.print_phases()
            if self.random_factor:
                self.dt = float(self.rng.uniform(0, 1))
            self.randomize()
            self.init_bodies()
            return True
        return False

    def note_phases(self, **ms):
        """Record this frame's time per phase (ms); the window adds render / hud with the same call."""
        self.phase.update(ms)
        for k, v in ms.items():
            self.psum[k] = self.psum.get(k, 0.0) + v
        if "pairwise" in ms or "enqueue" in ms:
            self.pcount += 1

    def print_phases(self):
        """The average time per phase over the cycle that just ended (a second line after the "N seconds" line)."""
        if self.pcount:
            print("phases (ms/frame, mean of %d): " % self.pcount + "  ".join("%s %.2f" % (k, v / self.pcount) for k, v in self.psum.items()))
        self.psum, self.pcount = {}, 0

    def cluster_center(self):
        """findClusterCenter(): around the body with the highest potential, the mass / (distance + 1) weighted mean of the bodies within 100."""
        k = int(np.argmax(self.pot))
        dx = self.x - self.x[k]; dy = self.y - self.y[k]; dz = self.z - self.z[k]
        dist = np.sqrt(dx * dx + dy * dy + dz * dz)
        near = dist < 100.0
        if not near.any():
            return (float(self.x[k]), float(self.y[k]), float(self.z[k]))
        w = (self.mass / (dist + 1.0))[near]
        return (float((self.x[near] * w).sum() / w.sum()), float((self.y[near] * w).sum() / w.sum()), float((self.z[near] * w).sum() / w.sum()))


def glow_colors(n):
    """Per-body r g b (0..1): GLOW_COLORS[i % 10], read as 0xBBGGRR so 0xFFFF00 is cyan like the C program's comments say."""
    out = np.empty((n, 3), np.float32)
    for i in range(n):
        c = GLOW_COLORS[i % len(GLOW_COLORS)]
        out[i] = ((c & 0xFF) / 255.0, ((c >> 8) & 0xFF) / 255.0, ((c >> 16) & 0xFF) / 255.0)
    return out


# ------------------------------------------------------------------ bench (no window)
def bench(n, steps, seed):
    print("N-body %d bodies, %d steps per source" % (n, steps))
    results = {}
    for dev in ("cpu", "gpu"):
        if dev == "gpu":
            ok, why = probe_gpu()
            if not ok:
                print("gpu: skipped (" + why + ")"); continue
        s = Sim(n, dev, seed=seed)
        times = []
        for _ in range(steps):
            s.step(); times.append(s.last_ms)
        results[dev] = s
        print("%s: %.1f ms per step (median)%s%s" % (dev, sorted(times)[len(times) // 2], "" if s.device == dev else "  [ran as %s]" % s.device, ("  note: " + s.note) if s.note else ""))
    if "cpu" in results and "gpu" in results:
        a, b = results["cpu"], results["gpu"]
        print("largest position difference between CPU and GPU: %.2e" % float(max(np.abs(a.x - b.x).max(), np.abs(a.y - b.y).max(), np.abs(a.z - b.z).max())))
    return results


# ------------------------------------------------------------------ the camera (nbody3d.c: updateCamera, keys, mouse drag)
class Cam(object):
    def __init__(self):
        self.dist, self.ax, self.ay = 50.0, 0.3, 0.0
        self.t_dist, self.t_ax, self.t_ay = 50.0, 0.3, 0.0
        self.tracking = True
        self.snapshot = (0.0, 0.0, 0.0)
        self.dragging = False
        self.last = (0, 0)

    def update(self):
        """Smooth transition toward the target while tracking; otherwise the targets follow the current values."""
        if self.tracking:
            self.ax += (self.t_ax - self.ax) * CAM_TRANSITION_SPEED
            self.ay += (self.t_ay - self.ay) * CAM_TRANSITION_SPEED
            self.dist += (self.t_dist - self.dist) * CAM_TRANSITION_SPEED
        else:
            self.t_ax, self.t_ay, self.t_dist = self.ax, self.ay, self.dist

    def eye(self):
        return [self.dist * math.sin(self.ay) * math.cos(self.ax), self.dist * math.sin(self.ax), -self.dist * math.cos(self.ay) * math.cos(self.ax)]

    def manual(self):
        self.tracking = False

    def toggle_tracking(self, center):
        self.tracking = not self.tracking
        if self.tracking:
            self.snapshot = center                           # snapshot the cluster center so the camera does not shake
            self.t_ax, self.t_ay, self.t_dist = 0.3, 0.0, 50.0

    def key(self, k, center):
        """Same keys as kbfnc() in the C program."""
        if k in ("c", "C"):
            self.toggle_tracking(center)
        elif k in ("+", "="):
            self.dist -= 3.0; self.manual()
        elif k in ("-", "_"):
            self.dist += 3.0; self.manual()
        elif k == "ArrowUp":
            self.ax += 0.1; self.manual()
        elif k == "ArrowDown":
            self.ax -= 0.1; self.manual()
        elif k == "ArrowLeft":
            self.ay -= 0.1; self.manual()
        elif k == "ArrowRight":
            self.ay += 0.1; self.manual()

    def mouse(self, ev):
        """Mouse drag on the picture rotates (mousemotion() in the C program)."""
        v = ev.get("value") or {}
        kind = v.get("kind")
        if kind == "down":
            self.dragging = True; self.last = (v["x"], v["y"])
        elif kind == "up":
            self.dragging = False
        elif kind == "move" and self.dragging:
            self.ay += (v["x"] - self.last[0]) * MOUSE_ROTATION_SENSITIVITY
            self.ax -= (v["y"] - self.last[1]) * MOUSE_ROTATION_SENSITIVITY
            self.ax = max(CAM_ANGLE_X_MIN, min(CAM_ANGLE_X_MAX, self.ax))
            self.last = (v["x"], v["y"])
            self.manual()


# ------------------------------------------------------------------ window
BTN_Y, BTN_H = 122, 20
BTN_CPU = (140, BTN_Y, 50, BTN_H)          # x, y, w, h of the two compute source buttons in the overlay
BTN_GPU = (200, BTN_Y, 50, BTN_H)


def inside(x, y, r):
    return r[0] <= x <= r[0] + r[2] and r[1] <= y <= r[1] + r[3]


def hud_ops(sim, cam, size, ms):
    """The overlay of draw3D(), drawn over the 3D view on a transparent canvas: text lines, the two sliders and the compute source buttons.
    (The y of a text op is its baseline, so +14 puts the line where the C program's top-left text position would be.)"""
    W = "#ffffff"; G = "#aaaaaa"
    t = lambda y, s, c=W: ["text", 5, y + 14, s, c]
    ops = [t(5, "[%-3d/%-3d] tm:%-3.3f bodies:%d" % (sim.loop, sim.loops, ms / 1000.0, sim.n)),
           t(25, "simulate factor: %-3.5f" % sim.dt),
           t(45, "random factor: %s[r]" % ("on" if sim.random_factor else "off")),
           t(65, "particle size: %-3.1f" % size),
           t(85, "cam dist:%.1f angle:(%.2f,%.2f)" % (cam.dist, cam.ax, cam.ay)),
           t(105, "camera tracking: %s[C]" % ("on" if cam.tracking else "off")),
           t(125, "compute source:"),
           t(165, "MAX_X:%.1f MAX_Y:%.1f MAX_Z:%.1f" % (sim.max_x, sim.max_y, sim.max_z), G),
           t(185, "MAX_Vel:%.1f Grav:%.1f Soft:%.1f" % (sim.max_v, sim.gravity, sim.softening), G),
           t(205, "[h]help [+/-]zoom [arrows/mouse]rotate [C]track", G)]
    if getattr(sim, "phase", None):
        ops.append(t(225, "ms  " + "  ".join("%s %.1f" % (k, v) for k, v in sim.phase.items()), G))
    if sim.note:
        ops.append(t(145, sim.note, "#ffcc66"))
    for r, label, on in ((BTN_CPU, "CPU", sim.device == "cpu"), (BTN_GPU, "GPU", sim.device == "gpu")):
        ops += [["rect", r[0], r[1], r[2], r[3], "#1f7a1f" if on else "#303030"],
                ["line", r[0], r[1], r[0] + r[2], r[1], W], ["line", r[0], r[1] + r[3], r[0] + r[2], r[1] + r[3], W],
                ["line", r[0], r[1], r[0], r[1] + r[3], W], ["line", r[0] + r[2], r[1], r[0] + r[2], r[1] + r[3], W],
                ["text", r[0] + 12, r[1] + 15, label, W]]
    x0, x1 = SLIDER_X_START, SLIDER_X_START + SLIDER_WIDTH
    for y, frac, color in ((SLIDER_SIM_Y, sim.dt / 2.0, "#fdfd00"), (SLIDER_PARTICLE_Y, (size - PARTICLE_SIZE_MIN) / (PARTICLE_SIZE_MAX - PARTICLE_SIZE_MIN), "#00ff00")):
        y1 = y + SLIDER_HEIGHT
        ops += [["rect", x0, y, max(0, SLIDER_WIDTH * frac), SLIDER_HEIGHT, color],
                ["line", x0, y, x1, y, W], ["line", x0, y1, x1, y1, W], ["line", x0, y, x0, y1, W], ["line", x1, y, x1, y1, W]]
    return ops


def slider_hit(x, y, sim, size):
    """mousefnc(): a press or drag inside a slider sets its value. Returns the new (dt, size)."""
    dt = sim.dt
    if SLIDER_SIM_Y < y < SLIDER_SIM_Y + SLIDER_HEIGHT and SLIDER_X_START <= x <= SLIDER_X_START + SLIDER_WIDTH:
        dt = 2.0 * (x - SLIDER_X_START) / SLIDER_WIDTH
    elif SLIDER_PARTICLE_Y < y < SLIDER_PARTICLE_Y + SLIDER_HEIGHT and SLIDER_X_START <= x <= SLIDER_X_START + SLIDER_WIDTH:
        size = PARTICLE_SIZE_MIN + (PARTICLE_SIZE_MAX - PARTICLE_SIZE_MIN) * (x - SLIDER_X_START) / SLIDER_WIDTH
    return dt, size


def in_slider(x, y):
    return (SLIDER_X_START <= x <= SLIDER_X_START + SLIDER_WIDTH and
            (SLIDER_SIM_Y <= y < SLIDER_SIM_Y + SLIDER_HEIGHT or SLIDER_PARTICLE_Y <= y < SLIDER_PARTICLE_Y + SLIDER_HEIGHT))


def run_window(n, device, seed, loops):
    import gui
    import gl3d
    sim = Sim(n, device, seed=seed, loops=loops)
    cam = Cam()
    cam.snapshot = (sim.max_x / 2.0, sim.max_y / 2.0, sim.max_z / 2.0)   # centered from the first frame (see "Differences")
    size = PARTICLE_SIZE_DEFAULT
    w = gui.Window("[3D] NBody-Simulation", width=800, height=620, resizable=True)
    # one area, two layers: the 3D view fills it, and the overlay (a transparent 2D canvas on top) draws the text, sliders and buttons over it
    # like the C program does. The overlay is the top layer, so it also receives the mouse: it passes drags that are not on a slider or button
    # to the camera.
    layers = w.stack(grow=1)
    view = gl3d.View(w, 780, 560, fps=60, parent=layers)
    hud = w.canvas(780, 560, fps=0, parent=layers, transparent=True)
    view.camera.fovy, view.camera.near, view.camera.far = 0.78, 0.1, 5000.0
    view.buffer("col", glow_colors(n))
    pressed = None            # what the mouse button went down on: "sim", "size", "cam" or "button"
    show_help = True
    ms = 0.0

    def draw_hud():
        w.draw(hud, hud_ops(sim, cam, size, ms) if show_help else [])

    def render():
        cam.update()
        c = cam.snapshot if cam.tracking else (sim.max_x / 2.0, sim.max_y / 2.0, sim.max_z / 2.0)
        pos = np.empty((n, 3), np.float32)
        pos[:, 0] = (sim.x - c[0]) * 0.1; pos[:, 1] = (sim.y - c[1]) * 0.1; pos[:, 2] = (sim.z - c[2]) * 0.1
        view.buffer("pos", pos)
        e = cam.eye()
        view.camera.eye = lambda: e                               # the C program's camera position formula; it looks at the origin
        f = view.frame(clear=(0.0, 0.0, 0.0, 1.0), depth=False)
        f.glow("pos", "col", n, size=size, ref=50.0, gain=0.5)
        view.show(f)

    draw_hud()
    while not w.closed:
        ev = w.poll()
        if ev is None:
            time.sleep(0.004)
            continue
        kind, node = ev.get("event"), ev.get("node")
        if kind == "close":
            break
        if kind == "key" and (ev.get("value") or {}).get("down"):
            k = ev["value"]["key"]
            if k in ("r", "R"): sim.random_factor = not sim.random_factor
            elif k in ("h", "H"): show_help = not show_help
            else: cam.key(k, sim.center)
            draw_hud()
        elif kind == "mouse":
            v = ev.get("value") or {}
            mk, x, y = v.get("kind"), v.get("x", 0), v.get("y", 0)
            if mk == "down":
                if show_help and in_slider(x, y):
                    pressed = "sim" if y < SLIDER_PARTICLE_Y else "size"
                elif show_help and (inside(x, y, BTN_CPU) or inside(x, y, BTN_GPU)):
                    pressed = "button"
                    sim.note = ""
                    sim.set_device("cpu" if inside(x, y, BTN_CPU) else "gpu")      # sets a note when the GPU source is not available
                else:
                    pressed = "cam"
                    cam.mouse(ev)
            elif mk == "up":
                if pressed == "cam": cam.mouse(ev)
                pressed = None
            elif mk == "move":
                if pressed in ("sim", "size"):
                    sim.dt, size = slider_hit(x, y, sim, size)
                elif pressed == "cam":
                    cam.mouse(ev)
            if mk == "down" and pressed in ("sim", "size"):
                sim.dt, size = slider_hit(x, y, sim, size)
            draw_hud()
        elif kind == "frame" and node == view.nid:
            if sim.step() and cam.tracking:                       # a new cycle: a new random box, so center on it
                cam.snapshot = (sim.max_x / 2.0, sim.max_y / 2.0, sim.max_z / 2.0)
            ms = sim.last_ms
            r0 = time.perf_counter()
            render()
            r1 = time.perf_counter()
            draw_hud()
            sim.note_phases(render=(r1 - r0) * 1000.0, hud=(time.perf_counter() - r1) * 1000.0)
        elif kind == "resize":
            view.handle(ev)
        elif kind == "glerror":
            sim.note = "WebGL error: " + str(ev.get("value"))


def main(argv=None):
    ap = argparse.ArgumentParser(description="3D N-body gravity (port of nbody3d.c) with a switchable compute source")
    ap.add_argument("n", nargs="?", type=int, default=NUM_BODY, help="number of bodies (default %d)" % NUM_BODY)
    ap.add_argument("--device", choices=["cpu", "gpu", "auto"], default="auto")
    ap.add_argument("--bench", action="store_true")
    ap.add_argument("--steps", type=int, default=5, help="steps per source in --bench")
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--loops", type=int, default=LOOP, help="frames per cycle before the parameters are randomized again")
    a = ap.parse_args(argv)
    n = max(16, min(8192, a.n))
    if a.bench:
        bench(min(n, 1024) if a.n == NUM_BODY else n, max(1, a.steps), a.seed); return 0
    device = "cpu"
    if a.device in ("gpu", "auto"):
        ok, why = probe_gpu()
        device = "gpu" if ok else "cpu"
        if not ok and a.device == "gpu":
            print("GPU source not available here: " + why + " (using CPU)")
    run_window(n, device, a.seed, max(1, a.loops))
    return 0


if __name__ == "__main__":
    sys.exit(main())
