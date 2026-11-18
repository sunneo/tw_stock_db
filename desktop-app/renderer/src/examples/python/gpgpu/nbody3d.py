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
        if device == "gpu" and cuda is None:
            self.note = "GPU source not available (the GPU compatibility layer is off); staying on CPU"
            device = "cpu"
        self.device = device

    def step(self):
        """One frame of Nbody() for every body, then the cluster center. Returns True when a cycle (LOOP frames) has just ended."""
        t0 = time.time()
        args = (self.x, self.y, self.z, self.mass, self.soft2, self.gravity)
        if self.device == "gpu":
            before = gpu_fallbacks()
            sx, sy, sz, pot = pairwise_gpu(*args)
            if gpu_fallbacks() > before:
                self.note = "the GPU kernel could not run here (it was emulated, very slowly): back to CPU"
                self.device = "cpu"
                sx, sy, sz, pot = pairwise_cpu(*args)
        else:
            sx, sy, sz, pot = pairwise_cpu(*args)
        self.pot = pot
        dt = np.float32(self.dt)
        self.vx += sx * dt; self.vy += sy * dt; self.vz += sz * dt                     # newX_velocity[i] += sumX * simulatetime_factor
        self.x += clampf(self.vx, MIN_VELOCITY, self.max_v) * dt                         # X_axis[i] += clampf(newX_velocity[i], ...) * factor
        self.y += clampf(self.vy, MIN_VELOCITY, self.max_v) * dt
        self.z += clampf(self.vz, MIN_VELOCITY, self.max_v) * dt
        self.center = self.cluster_center()
        self.last_ms = (time.time() - t0) * 1000.0
        self.loop += 1
        if self.loop >= self.loops:
            print("%d %f" % (self.n, time.time() - self.cycle_start))
            if self.random_factor:
                self.dt = float(self.rng.uniform(0, 1))
            self.randomize()
            self.init_bodies()
            return True
        return False

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
        if dev == "gpu" and cuda is None:
            print("gpu: skipped (the GPU compatibility layer is off)"); continue
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
def hud_ops(sim, cam, size, ms):
    """The overlay of draw3D(): text lines and the two sliders, as 2D canvas commands (y of text is the baseline, so +14)."""
    W = "#ffffff"; G = "#aaaaaa"
    t = lambda y, s, c=W: ["text", 5, y + 14, s, c]
    src = "GPU (WebGPU)" if sim.device == "gpu" else "CPU (numpy)"
    ops = [["clear", "#000000"],
           t(5, "[%-3d/%-3d] tm:%-3.3f bodies:%d" % (sim.loop, sim.loops, ms / 1000.0, sim.n)),
           t(25, "simulate factor: %-3.5f" % sim.dt),
           t(45, "random factor: %s[r]" % ("on" if sim.random_factor else "off")),
           t(65, "particle size: %-3.1f" % size),
           t(85, "cam dist:%.1f angle:(%.2f,%.2f)" % (cam.dist, cam.ax, cam.ay)),
           t(105, "camera tracking: %s[C]" % ("on" if cam.tracking else "off")),
           t(125, "compute source: %s" % src),
           t(165, "MAX_X:%.1f MAX_Y:%.1f MAX_Z:%.1f" % (sim.max_x, sim.max_y, sim.max_z), G),
           t(185, "MAX_Vel:%.1f Grav:%.1f Soft:%.1f" % (sim.max_v, sim.gravity, sim.softening), G),
           t(205, "[h]help [+/-]zoom [arrows/mouse]rotate [C]track", G)]
    if sim.note:
        ops.append(t(145, sim.note, "#ffcc66"))
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


def run_window(n, device, seed, loops):
    import gui
    import gl3d
    sim = Sim(n, device, seed=seed, loops=loops)
    cam = Cam()
    cam.snapshot = (sim.max_x / 2.0, sim.max_y / 2.0, sim.max_z / 2.0)   # centered from the first frame (see "Differences")
    size = PARTICLE_SIZE_DEFAULT
    w = gui.Window("[3D] NBody-Simulation", width=800, height=700, resizable=True)
    bar = w.row(role="toolbar")
    w.label("Compute source:", parent=bar)
    b_cpu = w.button("CPU", parent=bar)
    b_gpu = w.button("GPU", parent=bar)
    hud = w.canvas(760, 225, fps=0, fit=True)         # keeps its 760 x 225 drawing space (and the slider coordinates) whatever the window size
    view = gl3d.View(w, 780, 440, fps=60, grow=1)
    view.camera.fovy, view.camera.near, view.camera.far = 0.78, 0.1, 5000.0
    view.buffer("col", glow_colors(n))
    pressed = False
    show_help = True
    ms = 0.0

    def draw_hud():
        if show_help:
            w.draw(hud, hud_ops(sim, cam, size, ms))

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
        if kind == "click":
            if node == b_cpu: sim.set_device("cpu"); sim.note = ""
            elif node == b_gpu: sim.set_device("gpu"); sim.note = "" if sim.device == "gpu" else sim.note
            draw_hud()
        elif kind == "key" and (ev.get("value") or {}).get("down"):
            k = ev["value"]["key"]
            if k in ("r", "R"): sim.random_factor = not sim.random_factor
            elif k in ("h", "H"):
                show_help = not show_help
                w.set(hud, visible=show_help)
            else: cam.key(k, sim.center)
            draw_hud()
        elif kind == "mouse" and node == hud:
            v = ev.get("value") or {}
            if v.get("kind") == "down": pressed = True
            elif v.get("kind") == "up": pressed = False
            if pressed and v.get("kind") in ("down", "move"):
                sim.dt, size = slider_hit(v["x"], v["y"], sim, size)
                draw_hud()
        elif kind == "mouse":
            cam.mouse(ev)
        elif kind == "frame" and node == view.nid:
            if sim.step() and cam.tracking:                       # a new cycle: a new random box, so center on it
                cam.snapshot = (sim.max_x / 2.0, sim.max_y / 2.0, sim.max_z / 2.0)
            ms = sim.last_ms
            render()
            draw_hud()
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
    run_window(n, "gpu" if a.device in ("gpu", "auto") and cuda is not None else "cpu", a.seed, max(1, a.loops))
    return 0


if __name__ == "__main__":
    sys.exit(main())
