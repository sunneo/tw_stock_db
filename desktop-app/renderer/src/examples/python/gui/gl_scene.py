# -*- coding: utf-8 -*-
"""
gl_scene.py -- the smallest 3D / OpenGL-style example: a lit cube and sphere on a grid floor, with an orbit camera, drawn on the real GPU
through the window's WebGL2 canvas (the gl3d module). It also shows how to add your own GLSL program.

Run:    python gl_scene.py
Keys:   drag = turn the camera, Ctrl+wheel = zoom (click the picture once first), buttons: Spin on/off, Wireframe-ish lines on/off,
        "Custom shader" swaps the cube's program for one written right here (a procedural stripe shader).
How it works: gl3d.View makes a gl canvas and registers the built-in programs (flat, lit, points, dots). You upload vertex data once with
        view.buffer(name, data), then each frame build a command list (view.frame() ... view.show(f)). The commands are checked by the
        window bridge and drawn by the page with WebGL2: clear, use program, uniforms, attributes, draw.
"""
import math
import sys
import time

import gui
import gl3d

# A custom program: the vertex shader passes the position through, the fragment shader paints stripes that move with time.
STRIPE_VS = """#version 300 es
in vec3 pos; in vec3 nrm; in vec3 col; uniform mat4 mvp; uniform mat3 nmat; out vec3 vn; out vec3 vp;
void main(){ vn = nmat * nrm; vp = pos; gl_Position = mvp * vec4(pos, 1.0); }"""
STRIPE_FS = """#version 300 es
precision mediump float; in vec3 vn; in vec3 vp; uniform vec3 tint; uniform vec3 light; uniform float time; out vec4 o;
void main(){
  float d = max(dot(normalize(vn), normalize(light)), 0.0);
  float s = 0.5 + 0.5 * sin(18.0 * (vp.x + vp.y + vp.z) + time * 3.0);
  vec3 base = mix(vec3(0.15, 0.2, 0.6), vec3(1.0, 0.8, 0.2), s);
  o = vec4(base * (0.3 + 0.7 * d), 1.0);
}"""


def main():
    w = gui.Window("3D scene (WebGL2)", width=620, height=520, resizable=True)
    bar = w.row(role="toolbar")
    b_spin = w.button("Spin: on", parent=bar)
    b_grid = w.button("Grid: on", parent=bar)
    b_shader = w.button("Custom shader", parent=bar)
    status = w.label("drag to turn, Ctrl+wheel to zoom", role="muted")
    view = gl3d.View(w, 580, 400, fps=30, grow=1, camera=gl3d.Camera(dist=5.5, yaw=0.7, pitch=0.45))
    view.program("stripe", STRIPE_VS, STRIPE_FS)

    cube = gl3d.cube(1.2, color=(1.0, 1.0, 1.0))
    ball = gl3d.sphere(0.7, 28, color=(1.0, 1.0, 1.0))
    view.buffer("cube", cube.vertices); view.buffer("cube_i", cube.indices, cube.index_type)
    view.buffer("ball", ball.vertices); view.buffer("ball_i", ball.indices, ball.index_type)
    grid = gl3d.grid_lines(4, 0.5, y=-0.7)
    view.buffer("grid", grid)
    view.buffer("axes", gl3d.axes_lines(1.6))

    spin, show_grid, custom = True, True, False
    t0 = time.time()
    while not w.closed:
        ev = w.poll()
        if ev is None:
            time.sleep(0.005)
            continue
        kind = ev.get("event")
        if kind == "close":
            break
        if kind == "click":
            n = ev.get("node")
            if n == b_spin: spin = not spin; w.set(b_spin, text="Spin: " + ("on" if spin else "off"))
            elif n == b_grid: show_grid = not show_grid; w.set(b_grid, text="Grid: " + ("on" if show_grid else "off"))
            elif n == b_shader: custom = not custom; w.set(b_shader, text="Built-in shader" if custom else "Custom shader")
            continue
        res = view.handle(ev)
        if res == "glerror":
            w.set(status, text="shader error: " + view.errors[-1])
        if res != "frame":
            continue
        t = time.time() - t0
        a = t * 0.8 if spin else 0.0
        f = view.frame()
        if show_grid:
            f.lines("flat", "grid", len(grid) // 6)
        f.lines("flat", "axes", 6)
        model = gl3d.mat4_mul(gl3d.mat4_translate(-1.2, 0.0, 0.0), gl3d.mat4_mul(gl3d.mat4_rotate_y(a), gl3d.mat4_rotate_x(a * 0.6)))
        if custom:
            f.use("stripe").uf("time", t).uf("tint", 1, 1, 1).uf("light", 0.5, 0.8, 0.6)
            f.uf("mvp", *gl3d.mat4_mul(f.vp, model)).uf("nmat", *gl3d.mat3_normal(model))
            f.attr("pos", "cube", 3, 36, 0).attr("nrm", "cube", 3, 36, 12).attr("col", "cube", 3, 36, 24)
            f.index("cube_i").draw("triangles", 0, cube.index_count)
        else:
            f.mesh("lit", "cube", "cube_i", cube.index_count, model=model, color=(0.95, 0.6, 0.2))
        bob = gl3d.mat4_translate(1.2, 0.15 * math.sin(t * 2.0), 0.0)
        f.mesh("lit", "ball", "ball_i", ball.index_count, model=bob, color=(0.3, 0.7, 1.0))
        view.show(f)


if __name__ == "__main__":
    sys.exit(main())
