# -*- coding: utf-8 -*-
"""
fluid3d.py -- 3D liquid (SPH, smoothed-particle hydrodynamics), a GPGPU example. A block of water particles falls into a box and splashes.
Every step each particle sums over all the others twice (density, then pressure and viscosity forces), so the work is O(N^2) and
the compute source matters:

    CPU  numpy, vectorized in blocks (always works)
    GPU  two numba @cuda.jit kernels, translated to WGSL and run on the real GPU through WebGPU (GPU compatibility layer)

Run:    python fluid3d.py                        window with a 3D view; the buttons switch the source while it runs
        python fluid3d.py --device cpu|gpu|auto start on a source ("auto" = GPU when the page can run kernels, else CPU)
        python fluid3d.py --side 10              the block is side^3 particles (6 to 14; 10 gives 1000 particles)
        python fluid3d.py --bench                no window: time both sources for a few steps and compare the results

View:   drag = turn the camera, Ctrl+wheel = zoom (click the picture once first so it gets the mouse).
Method: Mueller et al. 2003 kernels (poly6 for density, spiky for pressure, viscosity laplacian), pressure p = k * max(rho - rho0, 0),
        semi-implicit Euler, reflecting walls. It is a toy: no neighbor grid (so it is all-pairs), no surface reconstruction (particles are
        drawn as round sprites colored by speed). Only the two pairwise sums change source; integration and the walls are numpy.
Notes:  If the GPU kernels cannot run (no WebGPU, or the page refuses them), the compatibility layer would emulate them one thread at a
        time in Python, far slower than numpy. This program notices that after the first GPU step and switches back to CPU.
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

# ------------------------------------------------------------------ constants (tuned so the block settles into a pool without blowing up)
H = 0.1                      # smoothing radius
SPACING = H / 2.0            # initial lattice spacing
RHO0 = 1000.0                # rest density
MASS = RHO0 * SPACING ** 3
K_GAS = 200.0                # pressure stiffness
MU = 3.0                     # viscosity
GRAVITY = -9.8
DT = 0.003
WALL_LO, WALL_HI, WALL_DAMP = 0.02, 0.98, 0.3
POLY6 = 315.0 / (64.0 * math.pi * H ** 9)
SPIKY = -45.0 / (math.pi * H ** 6)
VISC = 45.0 / (math.pi * H ** 6)


def make_fluid(side):
    g = np.arange(side) * SPACING + 0.05
    X, Y, Z = np.meshgrid(g, g, g, indexing="ij")
    px = X.ravel().astype(np.float32)
    py = (Y.ravel() + 0.3).astype(np.float32)
    pz = Z.ravel().astype(np.float32)
    n = px.size
    return [px, py, pz, np.zeros(n, np.float32), np.zeros(n, np.float32), np.zeros(n, np.float32)]


# ------------------------------------------------------------------ CPU (numpy)
def forces_cpu(px, py, pz, vx, vy, vz, block=256):
    """Returns ax, ay, az, rho (float32 arrays). The pairwise matrices are built a block of rows at a time."""
    n = px.shape[0]
    h2 = np.float32(H * H)
    rho = np.empty(n, np.float32)
    ax = np.empty(n, np.float32); ay = np.empty(n, np.float32); az = np.empty(n, np.float32)
    for a in range(0, n, block):
        b = min(n, a + block)
        dx = px[a:b, None] - px[None, :]; dy = py[a:b, None] - py[None, :]; dz = pz[a:b, None] - pz[None, :]
        r2 = dx * dx + dy * dy + dz * dz
        t = np.where(r2 < h2, h2 - r2, 0.0)
        rho[a:b] = MASS * POLY6 * (t * t * t).sum(axis=1)
    p = np.maximum(K_GAS * (rho - RHO0), 0.0)
    for a in range(0, n, block):
        b = min(n, a + block)
        dx = px[a:b, None] - px[None, :]; dy = py[a:b, None] - py[None, :]; dz = pz[a:b, None] - pz[None, :]
        r2 = dx * dx + dy * dy + dz * dz
        mask = (r2 < h2) & (r2 > 1e-12)
        r = np.sqrt(np.maximum(r2, 1e-12))
        t = np.where(mask, H - r, 0.0)
        coef = np.where(mask, -MASS * (p[a:b, None] + p[None, :]) / (2.0 * rho[None, :]) * (SPIKY * t * t) / r, 0.0)
        lap = np.where(mask, VISC * t, 0.0) * MASS / rho[None, :]
        fx = (coef * dx).sum(axis=1) + MU * (lap * (vx[None, :] - vx[a:b, None])).sum(axis=1)
        fy = (coef * dy).sum(axis=1) + MU * (lap * (vy[None, :] - vy[a:b, None])).sum(axis=1)
        fz = (coef * dz).sum(axis=1) + MU * (lap * (vz[None, :] - vz[a:b, None])).sum(axis=1)
        ax[a:b] = fx / rho[a:b]; ay[a:b] = fy / rho[a:b] + GRAVITY; az[a:b] = fz / rho[a:b]
    return ax, ay, az, rho


# ------------------------------------------------------------------ GPU (numba kernels -> WGSL)
# Positions, velocities and accelerations are packed as (N, 3) arrays: every array is one storage buffer binding, and WebGPU allows only 8
# per shader stage by default, so a kernel with ten separate arrays (x, y, z, vx, ...) cannot run on many adapters.
if cuda is not None:
    @cuda.jit
    def density_kernel(pos, rho, n, h2, coef):
        i = cuda.grid(1)
        if i < n:
            s = 0.0
            for j in range(n):
                dx = pos[i, 0] - pos[j, 0]
                dy = pos[i, 1] - pos[j, 1]
                dz = pos[i, 2] - pos[j, 2]
                r2 = dx * dx + dy * dy + dz * dz
                if r2 < h2:
                    t = h2 - r2
                    s += t * t * t
            rho[i] = coef * s

    @cuda.jit
    def force_kernel(pos, vel, rho, acc, n, h, mass, spiky, visc, k, rho0, mu, grav):
        i = cuda.grid(1)
        if i < n:
            h2 = h * h
            pi_ = k * (rho[i] - rho0)
            if pi_ < 0.0:
                pi_ = 0.0
            fx = 0.0
            fy = 0.0
            fz = 0.0
            for j in range(n):
                dx = pos[i, 0] - pos[j, 0]
                dy = pos[i, 1] - pos[j, 1]
                dz = pos[i, 2] - pos[j, 2]
                r2 = dx * dx + dy * dy + dz * dz
                if r2 < h2 and r2 > 1e-12:
                    r = math.sqrt(r2)
                    t = h - r
                    pj = k * (rho[j] - rho0)
                    if pj < 0.0:
                        pj = 0.0
                    c = -mass * (pi_ + pj) / (2.0 * rho[j]) * (spiky * t * t) / r
                    lap = visc * t * mass / rho[j] * mu
                    fx += c * dx + lap * (vel[j, 0] - vel[i, 0])
                    fy += c * dy + lap * (vel[j, 1] - vel[i, 1])
                    fz += c * dz + lap * (vel[j, 2] - vel[i, 2])
            acc[i, 0] = fx / rho[i]
            acc[i, 1] = fy / rho[i] + grav
            acc[i, 2] = fz / rho[i]


def forces_gpu(px, py, pz, vx, vy, vz):
    n = px.shape[0]
    pos = np.ascontiguousarray(np.stack([px, py, pz], axis=1), dtype=np.float32)
    vel = np.ascontiguousarray(np.stack([vx, vy, vz], axis=1), dtype=np.float32)
    rho = np.zeros(n, np.float32)
    acc = np.zeros((n, 3), np.float32)
    threads = 64
    blocks = (n + threads - 1) // threads
    density_kernel[blocks, threads](pos, rho, n, float(H * H), float(MASS * POLY6))
    force_kernel[blocks, threads](pos, vel, rho, acc, n, float(H), float(MASS), float(SPIKY), float(VISC),
                                  float(K_GAS), float(RHO0), float(MU), float(GRAVITY))
    return acc[:, 0].copy(), acc[:, 1].copy(), acc[:, 2].copy(), rho


def gpu_fallbacks():
    """How many kernel launches the compatibility layer has had to emulate on the CPU (0 means every launch ran on the GPU)."""
    try:
        import fa_gpu
        return int(fa_gpu.STATS.get("fallbacks", 0))
    except Exception:
        return 0


_PROBE = {}


def probe_gpu():
    """Try the GPU kernels once on a tiny problem. Returns (ok, reason). If the compatibility layer would emulate them one thread at a time
    in Python (no WebGPU, a limit the adapter does not meet...), say so up front instead of crawling through the first real frames."""
    if "r" in _PROBE:
        return _PROBE["r"]
    if cuda is None:
        _PROBE["r"] = (False, "the GPU compatibility layer is off")
        return _PROBE["r"]
    before = gpu_fallbacks()
    try:
        b = make_fluid(4)
        forces_gpu(*b)
        if gpu_fallbacks() > before:
            try:
                import fa_gpu
                why = str(fa_gpu.STATS.get("reason") or "")
            except Exception:
                why = ""
            _PROBE["r"] = (False, why[:240] or "the kernels could not run on the GPU")
        else:
            _PROBE["r"] = (True, "")
    except Exception as e:
        _PROBE["r"] = (False, str(e)[:240])
    return _PROBE["r"]


class Sim(object):
    def __init__(self, side, device):
        self.side = side
        self.body = make_fluid(side)
        self.n = self.body[0].size
        self.device = device
        self.note = ""
        self.last_ms = 0.0
        self.steps = 0
        self.rho = np.full(self.n, RHO0, np.float32)

    def set_device(self, device):
        if device == "gpu":
            ok, why = probe_gpu()
            if not ok:
                self.note = "GPU source not available here: " + why + " (staying on CPU)"
                device = "cpu"
        self.device = device

    def step(self, dt=DT):
        px, py, pz, vx, vy, vz = self.body
        t0 = time.time()
        if self.device == "gpu":
            before = gpu_fallbacks()
            ax, ay, az, rho = forces_gpu(px, py, pz, vx, vy, vz)
            if gpu_fallbacks() > before:
                self.note = "the GPU kernels stopped running on the GPU (they were emulated, very slowly): back to CPU"
                self.device = "cpu"
                ax, ay, az, rho = forces_cpu(px, py, pz, vx, vy, vz)
        else:
            ax, ay, az, rho = forces_cpu(px, py, pz, vx, vy, vz)
        self.last_ms = (time.time() - t0) * 1000.0
        self.rho = rho
        vx += ax * dt; vy += ay * dt; vz += az * dt
        px += vx * dt; py += vy * dt; pz += vz * dt
        for a, va in ((px, vx), (py, vy), (pz, vz)):
            lo = a < WALL_LO; a[lo] = WALL_LO; va[lo] *= -WALL_DAMP
            hi = a > WALL_HI; a[hi] = WALL_HI; va[hi] *= -WALL_DAMP
        self.steps += 1


def vertex_data(sim):
    """x y z r g b per particle (stride 24): deep blue when slow, light cyan to white when fast."""
    px, py, pz, vx, vy, vz = sim.body
    t = np.clip(np.sqrt(vx * vx + vy * vy + vz * vz) / 3.0, 0.0, 1.0)
    out = np.empty((sim.n, 6), np.float32)
    out[:, 0] = px - 0.5; out[:, 1] = py - 0.5; out[:, 2] = pz - 0.5      # center the box on the origin
    out[:, 3] = 0.1 + 0.8 * t; out[:, 4] = 0.35 + 0.6 * t; out[:, 5] = 0.9 + 0.1 * t
    return out


def box_lines():
    """The 12 edges of the box [-0.5, 0.5]^3 as 'flat' vertices (x y z r g b)."""
    c = [(-0.5, -0.5, -0.5), (0.5, -0.5, -0.5), (0.5, -0.5, 0.5), (-0.5, -0.5, 0.5), (-0.5, 0.5, -0.5), (0.5, 0.5, -0.5), (0.5, 0.5, 0.5), (-0.5, 0.5, 0.5)]
    edges = [(0, 1), (1, 2), (2, 3), (3, 0), (4, 5), (5, 6), (6, 7), (7, 4), (0, 4), (1, 5), (2, 6), (3, 7)]
    out = []
    for a, b in edges:
        out += list(c[a]) + [0.5, 0.55, 0.65] + list(c[b]) + [0.5, 0.55, 0.65]
    return np.array(out, np.float32)


# ------------------------------------------------------------------ bench (no window)
def bench(side, steps):
    print("SPH fluid: %d particles, %d steps per source" % (side ** 3, steps))
    results = {}
    for dev in ("cpu", "gpu"):
        if dev == "gpu":
            ok, why = probe_gpu()
            if not ok:
                print("gpu: skipped (" + why + ")"); continue
        s = Sim(side, dev)
        times = []
        for _ in range(steps):
            s.step(); times.append(s.last_ms)
        results[dev] = s
        print("%s: %.1f ms per step (median)%s%s" % (dev, sorted(times)[len(times) // 2], "" if s.device == dev else "  [ran as %s]" % s.device, ("  note: " + s.note) if s.note else ""))
    if "cpu" in results and "gpu" in results:
        print("largest position difference between CPU and GPU: %.2e" % float(np.abs(results["cpu"].body[1] - results["gpu"].body[1]).max()))
    return results


# ------------------------------------------------------------------ window
def run_window(side, device):
    import gui
    import gl3d
    sim = Sim(side, device)
    w = gui.Window("Fluid 3D (SPH)", width=640, height=560, resizable=True)
    top = w.row(role="toolbar")
    w.label("Compute source:", parent=top)
    b_cpu = w.button("CPU", parent=top)
    b_gpu = w.button("GPU", parent=top)
    b_pause = w.button("Pause", parent=top)
    b_reset = w.button("Reset", parent=top)
    info = w.label("", role="muted")
    view = gl3d.View(w, 600, 440, fps=30, grow=1, camera=gl3d.Camera(dist=2.2, yaw=0.6, pitch=0.35))
    view.buffer("fluid", vertex_data(sim))
    view.buffer("box", box_lines())
    paused = False
    smooth = 0.0

    def label():
        src = "GPU (WebGPU)" if sim.device == "gpu" else "CPU (numpy)"
        w.set(info, text="%d particles | source: %s | %.1f ms per step | step %d%s" % (sim.n, src, smooth, sim.steps, ("\n" + sim.note) if sim.note else ""))

    label()
    while not w.closed:
        ev = w.poll()
        if ev is None:
            time.sleep(0.005)
            continue
        kind = ev.get("event")
        if kind == "close":
            break
        if kind == "click":
            node = ev.get("node")
            if node == b_cpu: sim.set_device("cpu"); sim.note = ""
            elif node == b_gpu: sim.set_device("gpu"); sim.note = "" if sim.device == "gpu" else sim.note
            elif node == b_pause: paused = not paused
            elif node == b_reset: sim = Sim(side, sim.device)
            label()
            continue
        res = view.handle(ev)
        if res == "frame":
            if not paused:
                sim.step()
                smooth = sim.last_ms if smooth == 0.0 else 0.9 * smooth + 0.1 * sim.last_ms
            view.buffer("fluid", vertex_data(sim))
            f = view.frame()
            f.lines("flat", "box", 24)
            f.points("fluid", sim.n, stride=24, color_offset=12, size=10.0)
            view.show(f)
            if sim.steps % 15 == 0:
                label()
        elif res == "glerror":
            w.set(info, text="WebGL error: " + view.errors[-1])


def main(argv=None):
    ap = argparse.ArgumentParser(description="3D SPH liquid with a switchable compute source")
    ap.add_argument("--device", choices=["cpu", "gpu", "auto"], default="auto")
    ap.add_argument("--side", type=int, default=10)
    ap.add_argument("--bench", action="store_true")
    ap.add_argument("--steps", type=int, default=3, help="steps per source in --bench")
    a = ap.parse_args(argv)
    side = max(6, min(14, a.side))
    if a.bench:
        bench(side, max(1, a.steps)); return 0
    device = "cpu"
    note = ""
    if a.device in ("gpu", "auto"):
        ok, why = probe_gpu()
        device = "gpu" if ok else "cpu"
        if not ok and a.device == "gpu":
            note = "GPU source not available here: " + why + " (using CPU)"
            print(note)
    run_window(side, device)
    return 0


if __name__ == "__main__":
    sys.exit(main())
