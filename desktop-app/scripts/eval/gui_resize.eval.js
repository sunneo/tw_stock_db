// 用法同 gui_py_worker.eval.js。pygame 子集 set_mode(RESIZABLE)：按最大化鈕→視窗填滿終端機區域且程式收到 VIDEORESIZE→再按還原；
// 另以改視窗寬高模擬拖曳右下角（ResizeObserver 觸發），程式再收到一次 VIDEORESIZE。不是作業系統層級的滑鼠拖曳。
const PROGRAM = `import pygame
pygame.init()
s = pygame.display.set_mode((320, 200), pygame.RESIZABLE)
print("start", s.get_size(), flush=True)
clock = pygame.time.Clock()
sizes = []
while len(sizes) < 7:
    for ev in pygame.event.get():
        if ev.type == pygame.VIDEORESIZE:
            sizes.append(tuple(ev.size))
            print("resize", ev.size, flush=True)
    s.fill((0, 0, 80))
    pygame.display.flip()
    clock.tick(30)
print("end", sizes)
pygame.quit()
`;
const fa = window.fa;
const R = {};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 30000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { const v = fn(); if (v) return v; } catch (_) { /* 還沒就緒 */ } await wait(100); } return null; };
const termText = (session) => { const b = session.term.buffer.active; const out = []; for (let i = 0; i < b.length; i++) { const l = b.getLine(i); if (l) out.push(l.translateToString(true)); } return out.join('\n'); };
R.loaded = { scripts: Array.from(document.scripts).map((s) => s.src).filter((s) => /floating-assistant/.test(s)), has_py_worker: typeof fa._terminalRunPythonWorker === 'function' };
const t = await fa._createTerminalForAI({ name: 'resize-eval', initialCommand: '' });
const session = fa._resolveTerminalSession(t.id).session;
await wait(800);
await fa._runTerminalCommand(session, 'cd /work');
const fsStore = await fa._ensureTerminalFsStore(session, await fa._ensureBashWasmLoaded());
fa._writeBytesToTerminalFs(fsStore, '/work/rs.py', new TextEncoder().encode(PROGRAM));
const runP = fa._runTerminalCommand(session, 'python3 rs.py');
const gw = () => document.querySelector(".gui-window[data-window]"); const win = await until(gw);
R.window = !!win;
if (!win) return R;
const cv = () => document.querySelector(".gui-window[data-window] canvas"); const canvas = await until(cv);
R.canvas0 = canvas && (cv() ? [cv().width, cv().height] : null);
const box = (el) => { const r = el.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; };
R.attrs = { resizable: win.getAttribute('data-resizable'), has_max_button: !!win.querySelector('.gui-maximize') };
R.win0 = box(gw());
await wait(800);
const btn = (txt) => Array.from(document.querySelectorAll('.gui-window[data-window] .gui-titlebar button')).find((b) => b.textContent === txt);
{ const w = gw().getBoundingClientRect(); const bs = Array.from(gw().querySelectorAll('.gui-titlebar button')); const ti = gw().querySelector('.gui-titlebar span').getBoundingClientRect();
  R.layout = { title_left: Math.round(ti.left - w.left), button_lefts_from_right: bs.map((b) => Math.round(w.right - b.getBoundingClientRect().right)), close_is_last: bs[bs.length - 1].textContent === '×', buttons_right_of_title: bs.every((b) => b.getBoundingClientRect().left >= ti.left) }; }
const vp = [window.innerWidth, window.innerHeight];
R.viewport = vp; R.buttons = Array.from(document.querySelectorAll('.gui-window[data-window] .gui-titlebar button')).map((b) => b.textContent);
btn('☐').click(); await wait(1200);
R.win_maximized = box(gw()); R.canvas_maximized = (cv() ? [cv().width, cv().height] : null); R.covers_viewport = R.win_maximized[0] === vp[0] && R.win_maximized[1] === vp[1];
btn('❐').click(); await wait(1200);
R.win_restored = box(gw()); R.canvas_restored = (cv() ? [cv().width, cv().height] : null);
await Promise.race([runP, wait(20000)]);
await wait(300);
R.screen = termText(session).split('\n').filter((l) => l.trim()).slice(-8);
return R;
