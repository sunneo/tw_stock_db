# -*- coding: utf-8 -*-
"""
nbody3d_cl.py -- the same 3D N-body gravity as nbody3d.py (a port of exams/nbody3d.c), but the whole physics step runs through standard
pyopencl on an OpenCL device instead of numpy / numba.cuda. The bodies stay in device buffers; each frame only the three position arrays are
read back for drawing. (llc/gpgpu/nbody3d_cl.ll is the same program written for lli.)

    GPU  the first GPU device (WebGPU or WebGL2 in the page, through the KIR device layer)
    CPU  the CPU device (OpenCL C compiled to wasm in the page)

Run:    python nbody3d_cl.py [N]                     N bodies (default 3072); a window with a 3D view
        python nbody3d_cl.py --device cpu|gpu|auto   start on a device ("auto" = the GPU device when there is one); the CPU / GPU buttons switch it
        python nbody3d_cl.py --bench [N]             no window: time every device for a few steps and compare with the numpy reference
        python nbody3d_cl.py --seed 5 --loops 500    random seed; frames per cycle (the C program uses 2000)

Same physics, controls and look as nbody3d.py (it imports the camera, overlay and parameter code from there, so keep the two files together).
The kernels are written so the GPU device can run them: one output buffer per kernel, float buffers, one dimension. Bodies are float4 (x y z mass), so a frame
is three kernels: one O(N^2) pass for the acceleration and potential, then the velocity and position updates; velocity and position buffers
ping-pong between two copies so a kernel never reads and writes the same buffer.
"""
import argparse
import sys
import time

import numpy as np
import pyopencl as cl

from nbody3d import (Cam, Sim, NUM_BODY, LOOP, MIN_VELOCITY, PARTICLE_SIZE_DEFAULT, BTN_CPU, BTN_GPU, SLIDER_SIM_Y, SLIDER_PARTICLE_Y,
                     glow_colors, hud_ops, in_slider, inside, slider_hit)

SRC = """
__kernel void accel(__global const float4 *p, __global float4 *a, int n, float soft2, float g)
{
    int i = get_global_id(0);
    if (i < n) {
        float xi = p[i].x;
        float yi = p[i].y;
        float zi = p[i].z;
        float ax = 0.0f;
        float ay = 0.0f;
        float az = 0.0f;
        float pt = 0.0f;
        for (int j = 0; j < n; j++) {
            if (j != i) {
                float dx = p[j].x - xi;
                float dy = p[j].y - yi;
                float dz = p[j].z - zi;
                float mj = p[j].w;
                float d2 = dx * dx + dy * dy + dz * dz + soft2;
                float inv = 1.0f / sqrt(d2);
                float s = g * mj * inv * inv * inv;
                ax += s * dx;
                ay += s * dy;
                az += s * dz;
                pt += mj * inv;
            }
        }
        a[i] = (float4)(ax, ay, az, pt);       /* acceleration sums in x y z, potential in w */
    }
}

__kernel void vel(__global const float4 *v, __global const float4 *a, __global float4 *vout, int n, float dt)
{
    int i = get_global_id(0);
    if (i < n) {
        float4 vv = v[i];
        float4 aa = a[i];
        vout[i] = (float4)(vv.x + aa.x * dt, vv.y + aa.y * dt, vv.z + aa.z * dt, 0.0f);
    }
}

__kernel void pos(__global const float4 *p, __global const float4 *v, __global float4 *pout, int n, float dt, float lo, float hi)
{
    int i = get_global_id(0);
    if (i < n) {
        float4 pp = p[i];
        float4 vv = v[i];
        float cx = vv.x;
        float cy = vv.y;
        float cz = vv.z;
        if (cx > hi) cx = (cx + hi) * 0.5f;      /* the C program's clampf: a value past a limit moves halfway back toward it */
        if (cx < lo) cx = (cx + lo) * 0.5f;
        if (cy > hi) cy = (cy + hi) * 0.5f;
        if (cy < lo) cy = (cy + lo) * 0.5f;
        if (cz > hi) cz = (cz + hi) * 0.5f;
        if (cz < lo) cz = (cz + lo) * 0.5f;
        pout[i] = (float4)(pp.x + cx * dt, pp.y + cy * dt, pp.z + cz * dt, pp.w);
    }
}
"""


def find_device(kind):
    want = cl.device_type.GPU if kind == "gpu" else cl.device_type.CPU
    for p in cl.get_platforms():
        for d in p.get_devices():
            if d.type & want:
                return d
    return None


class ClCompute(object):
    """Bodies in float4 device buffers (x y z mass; velocity; acceleration + potential) and the three kernels that advance them one frame."""

    def __init__(self, kind, n):
        dev = find_device(kind)
        if dev is None:
            raise RuntimeError("no %s OpenCL device" % kind.upper())
        self.kind, self.n, self.dev_name = kind, n, dev.name
        self.ctx = cl.Context([dev])
        self.q = cl.CommandQueue(self.ctx)
        prg = cl.Program(self.ctx, SRC).build()
        self.k = {name: cl.Kernel(prg, name) for name in ("accel", "vel", "pos")}
        mk = lambda: cl.Buffer(self.ctx, cl.mem_flags.READ_WRITE, n * 16)
        self.p = [mk(), mk()]            # x y z mass, two copies (ping-pong)
        self.v = [mk(), mk()]            # vx vy vz 0
        self.acc = mk()                  # ax ay az potential
        self.cur = 0

    def _read4(self, buf):
        out = np.empty((self.n, 4), np.float32)
        cl.enqueue_copy(self.q, out, buf)
        return out

    def upload(self, pos, vel, mass):
        self.cur = 0
        p4 = np.zeros((self.n, 4), np.float32); v4 = np.zeros((self.n, 4), np.float32)
        for a in range(3):
            p4[:, a] = pos[a]; v4[:, a] = vel[a]
        p4[:, 3] = mass
        cl.enqueue_copy(self.q, self.p[0], p4)
        cl.enqueue_copy(self.q, self.v[0], v4)
        self.q.finish()

    def step(self, dt, soft2, g, vmax):
        n, c, k, f32 = np.int32(self.n), self.cur, self.k, np.float32
        k["accel"].set_args(self.p[c], self.acc, n, f32(soft2), f32(g))
        cl.enqueue_nd_range_kernel(self.q, k["accel"], (self.n,), None)
        k["vel"].set_args(self.v[c], self.acc, self.v[1 - c], n, f32(dt))
        cl.enqueue_nd_range_kernel(self.q, k["vel"], (self.n,), None)
        k["pos"].set_args(self.p[c], self.v[1 - c], self.p[1 - c], n, f32(dt), f32(MIN_VELOCITY), f32(vmax))
        cl.enqueue_nd_range_kernel(self.q, k["pos"], (self.n,), None)
        self.cur = 1 - c

    def positions(self):
        p4 = self._read4(self.p[self.cur])                    # one read for all three coordinates
        return tuple(np.ascontiguousarray(p4[:, a]) for a in range(3))

    def velocities(self):
        v4 = self._read4(self.v[self.cur])
        return tuple(np.ascontiguousarray(v4[:, a]) for a in range(3))

    def potential(self):
        return np.ascontiguousarray(self._read4(self.acc)[:, 3])


class ClSim(Sim):
    """nbody3d.Sim with the physics on an OpenCL device. device is "cpu" or "gpu" (the OpenCL device kind)."""

    def __init__(self, n, device, seed=1, loops=LOOP):
        self.cl = ClCompute(device, n)
        self._center = None
        Sim.__init__(self, n, device, seed=seed, loops=loops)

    @property
    def center(self):
        if self._center is None:                    # the cluster center needs the potential: read it back only when asked (C key)
            self.pot = self.cl.potential()
            self._center = self.cluster_center()
        return self._center

    @center.setter
    def center(self, v):
        self._center = None

    def init_bodies(self):
        Sim.init_bodies(self)
        self.cl.upload((self.x, self.y, self.z), (self.vx, self.vy, self.vz), self.mass)

    def set_device(self, device):
        if device == self.device:
            return
        try:
            new = ClCompute(device, self.n)
        except Exception as e:
            self.note = "%s device not available here: %s" % (device.upper(), str(e)[:160])
            return
        pos, vel = self.cl.positions(), self.cl.velocities()
        new.upload(pos, vel, self.mass)
        self.cl, self.device = new, device

    def step(self):
        """One frame on the device, then the three positions come back for drawing. True when a cycle (LOOP frames) has just ended."""
        t0 = time.time()
        a0 = time.perf_counter()
        self.cl.step(self.dt, self.soft2, self.gravity, self.max_v)      # queues the three kernels
        a1 = time.perf_counter()
        self.x, self.y, self.z = self.cl.positions()                      # the read waits for them to finish, so this is where the device time shows
        self._center = None
        a2 = time.perf_counter()
        self.last_ms = (time.time() - t0) * 1000.0
        self.note_phases(enqueue=(a1 - a0) * 1000.0, readback=(a2 - a1) * 1000.0)
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


def available(kind):
    return find_device(kind) is not None


def bench(n, steps, seed):
    print("N-body %d bodies, %d steps per device (pyopencl)" % (n, steps))
    ref = Sim(n, "cpu", seed=seed)
    for _ in range(steps):
        ref.step()
    for kind in ("cpu", "gpu"):
        if not available(kind):
            print("%s: no such OpenCL device" % kind); continue
        try:
            s = ClSim(n, kind, seed=seed)
            times = []
            for _ in range(steps):
                s.step(); times.append(s.last_ms)
        except Exception as e:
            print("%s: failed (%s)" % (kind, str(e)[:200])); continue
        diff = float(max(np.abs(s.x - ref.x).max(), np.abs(s.y - ref.y).max(), np.abs(s.z - ref.z).max()))
        print("%s (%s): %.1f ms per step (median); largest position difference from numpy: %.2e" % (kind, s.cl.dev_name, sorted(times)[len(times) // 2], diff))


def run_window(n, device, seed, loops):
    import gui
    import gl3d
    sim = ClSim(n, device, seed=seed, loops=loops)
    cam = Cam()
    cam.snapshot = (sim.max_x / 2.0, sim.max_y / 2.0, sim.max_z / 2.0)   # centered from the first frame
    size = PARTICLE_SIZE_DEFAULT
    w = gui.Window("[3D] NBody-Simulation (OpenCL)", width=800, height=620, resizable=True)
    layers = w.stack(grow=1)
    view = gl3d.View(w, 780, 560, fps=60, parent=layers)
    hud = w.canvas(780, 560, fps=0, parent=layers, transparent=True)
    view.camera.fovy, view.camera.near, view.camera.far = 0.78, 0.1, 5000.0
    view.buffer("col", glow_colors(n))
    pressed = None
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
        view.camera.eye = lambda: e
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
            else: cam.key(k, sim.center if k in ("c", "C") else (0.0, 0.0, 0.0))
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
                    sim.set_device("cpu" if inside(x, y, BTN_CPU) else "gpu")
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
            if sim.step() and cam.tracking:
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
    ap = argparse.ArgumentParser(description="3D N-body gravity (port of nbody3d.c) on OpenCL devices through pyopencl")
    ap.add_argument("n", nargs="?", type=int, default=NUM_BODY, help="number of bodies (default %d)" % NUM_BODY)
    ap.add_argument("--device", choices=["cpu", "gpu", "auto"], default="auto")
    ap.add_argument("--bench", action="store_true")
    ap.add_argument("--steps", type=int, default=5, help="steps per device in --bench")
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--loops", type=int, default=LOOP, help="frames per cycle before the parameters are randomized again")
    a = ap.parse_args(argv)
    n = max(16, min(8192, a.n))
    if a.bench:
        bench(min(n, 1024) if a.n == NUM_BODY else n, max(1, a.steps), a.seed); return 0
    device = "gpu" if a.device in ("gpu", "auto") and available("gpu") else "cpu"
    if a.device == "gpu" and device != "gpu":
        print("no GPU OpenCL device here (using the CPU device)")
    run_window(n, device, a.seed, max(1, a.loops))
    return 0


if __name__ == "__main__":
    sys.exit(main())
