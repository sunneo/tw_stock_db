// 零拷貝畫面與執行期選路（真實 Electron）：gl3d 與 pygame（一般、OPENGL）都經 fa_present.Presenter：一個 process 只量一次（零拷貝 ImageBitmap 與 PNG 各跑約 1 秒，
// 量「頁面實際畫出的幀率」），結果存在頁面端（所有程式共用）與 GPU 相容層的速率紀錄。驗證：第一支程式量了兩條路、選的是不慢於另一條 80% 的那條；之後的程式不再量、直接沿用；畫面真的有內容（解開畫布截圖數像素）。
// 用法：FA_DEBUG_EVAL_FILE=scripts/eval/present_real.eval.js xvfb-run -a node_modules/electron/dist/electron . --no-sandbox --use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader --user-data-dir=$(mktemp -d)
const fa = window.fa; const R = {}; const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const tool = async (name, args) => JSON.parse(await fa.tools[name].callback.call(fa, JSON.stringify(args)));
async function drawnPixels(jid) {   // 畫布截圖（頁面端 toDataURL）解開，數跟背景不同的像素
  const sh = await tool('job_gui', { job_id: jid, action: 'screenshot', canvas: 0 }); if (!sh.ok) return -1;
  const job = fa._jobTable().get(jid), rt = await fa._ensureBashWasmLoaded(), fsx = await fa._ensureTerminalFsStore(job.session, rt); const w = (await tool('job_gui', { job_id: jid, action: 'snapshot' })).windows[0].id;
  const bytes = fa._terminalSandboxFileBytes(fsx, '/work/shot-' + w + '.png'); const bmp = await createImageBitmap(new Blob([bytes])), oc = new OffscreenCanvas(bmp.width, bmp.height), cx = oc.getContext('2d'); cx.drawImage(bmp, 0, 0);
  const d = cx.getImageData(0, 0, bmp.width, bmp.height).data; let diff = 0; for (let i = 0; i < d.length; i += 4) if (Math.abs(d[i] - d[0]) + Math.abs(d[i + 1] - d[1]) + Math.abs(d[i + 2] - d[2]) > 40) diff++; return diff;
}
async function runCase(name, code, ratesExpr) {
  const j = await tool('job_run', { lang: 'python', code: code + `\nprint('RATES', ${ratesExpr})\nimport time; time.sleep(25)\n`, detach: true, timeout_s: 120 }); let s, waited = 0;
  do { await wait(500); waited += 500; s = await tool('job_gui', { job_id: j.job_id, action: 'snapshot' }); } while (waited < 90000 && !/RATES/.test(s.output || '') && s.running);
  const m = /RATES (\S+) ([\d.]+) ([\d.]+) (\d+)/.exec(s.output || ''); const e = m ? { mode: m[1], bitmap_fps: +m[2], png_fps: +m[3], probed: +m[4] === 2 } : { err: (s.output || '').slice(-300) };
  e.drawn_pixels = await drawnPixels(j.job_id); await tool('job_stop', { job_id: j.job_id }); R[name] = e;
}
await runCase('gl3d', `
import time, gui, gl3d, array, random
w = gui.Window('t', 700); v = gl3d.View(w, 640, 480, fps=0)
random.seed(1); v.buffer('pts', array.array('f', [random.uniform(-1, 1) for _ in range(9000)]))
t = time.perf_counter()
while time.perf_counter() - t < 4.5:
    f = v.frame(); f.points('pts', 3000, stride=12, size=6.0); v.show(f)
`, "v._p.mode, v._p.rate.get('bitmap', 0), v._p.rate.get('png', 0), len(v._p.rate)");
await runCase('pygame_2d', `
import pygame, time, fa_pygame
pygame.init(); scr = pygame.display.set_mode((640, 480)); t = time.perf_counter(); n = 0
while time.perf_counter() - t < 4.5:
    scr.fill((10, 10, 40)); pygame.draw.circle(scr, (255, 200, 0), (60 + (n * 5) % 500, 240), 40); pygame.draw.rect(scr, (0, 180, 255), (20, 20, 120, 60)); pygame.display.flip(); n += 1
`, "fa_pygame._ST['presenter'].mode, fa_pygame._ST['presenter'].rate.get('bitmap', 0), fa_pygame._ST['presenter'].rate.get('png', 0), len(fa_pygame._ST['presenter'].rate)");
await runCase('pygame_gl', `
import time, pygame, fa_pygame
from pygame.locals import DOUBLEBUF, OPENGL
from OpenGL.GL import *
from OpenGL.GLU import *
pygame.init(); pygame.display.set_mode((640, 480), DOUBLEBUF | OPENGL)
glMatrixMode(GL_PROJECTION); gluPerspective(45, 640 / 480.0, 0.1, 50); glMatrixMode(GL_MODELVIEW); glEnable(GL_DEPTH_TEST)
t = time.perf_counter(); n = 0
while time.perf_counter() - t < 4.5:
    glClearColor(0.1, 0.1, 0.2, 1); glClear(GL_COLOR_BUFFER_BIT | GL_DEPTH_BUFFER_BIT); glLoadIdentity(); glTranslatef(0, 0, -5); glRotatef(n * 2, 1, 1, 0)
    glBegin(GL_TRIANGLES); glColor3f(1, 0, 0); glVertex3f(-1, -1, 0); glColor3f(0, 1, 0); glVertex3f(1, -1, 0); glColor3f(0, 0, 1); glVertex3f(0, 1, 0); glEnd()
    pygame.display.flip(); n += 1
`, "fa_pygame._ST['presenter'].mode, fa_pygame._ST['presenter'].rate.get('bitmap', 0), fa_pygame._ST['presenter'].rate.get('png', 0), len(fa_pygame._ST['presenter'].rate)");
const first = R.gl3d.probed && R.gl3d.mode && R.gl3d.drawn_pixels > 1000 && (R.gl3d.mode === 'bitmap' ? R.gl3d.bitmap_fps : R.gl3d.png_fps) >= 0.8 * Math.max(R.gl3d.bitmap_fps, R.gl3d.png_fps);
const reuse = (e) => e.probed === false && e.mode === R.gl3d.mode && e.drawn_pixels > 1000;   // 之後的程式：沒有量測、沿用同一個結果
R.pref = await tool('job_list', {}) && fa._presentPathMem;
R.ok = !!first && reuse(R.pygame_2d) && reuse(R.pygame_gl) && !!R.pref && R.pref.mode === R.gl3d.mode;
console.log('PRESENT_RESULT ' + JSON.stringify(R));
return R;
