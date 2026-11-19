// 真的 pygame-ce（pip）接 GUI 橋接（真實 Electron）：範例遊戲原封不動執行、畫面進畫布、鍵盤與滑鼠事件進真的 pygame 事件佇列。
// 用法：FA_DEBUG_EVAL_FILE=scripts/eval/pygame_real.eval.js xvfb-run -a node_modules/electron/dist/electron . --no-sandbox --use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader --user-data-dir=$(mktemp -d)
const fa = window.fa; const R = {}; const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const tool = async (name, args) => JSON.parse(await fa.tools[name].callback.call(fa, JSON.stringify(args)));
// 1. 最小程式：真的 pygame 的 API（convert、Event、Rect、key／mouse 狀態）
let r = await tool('job_run', { lang: 'python', timeout_s: 120, code: `
import pygame
print('pygame', pygame.version.ver, pygame.__file__)
pygame.init()
scr = pygame.display.set_mode((120, 80))
img = pygame.Surface((10, 10)).convert_alpha(); img.fill((9, 9, 9, 255))
scr.fill((10, 20, 30)); scr.blit(img, (5, 5)); pygame.draw.polygon(scr, (200, 0, 0), [(0, 0), (30, 0), (0, 30)]); pygame.display.flip()
clock = pygame.time.Clock(); n = 0; keys = []
for _ in range(40):
    for e in pygame.event.get():
        if e.type == pygame.KEYDOWN: keys.append(pygame.key.name(e.key))
        if e.type == pygame.QUIT: n = -1
    clock.tick(60); n += 1
print('frames', n, 'keys', keys, 'pressed_left', bool(pygame.key.get_pressed()[pygame.K_LEFT]))
` });
R.min = { exit: r.exit_code, out: (r.output || '').trim().slice(-300) };
// 2. 遊戲範例（原封不動）：打磚塊
const src = FA_PY_EXAMPLES['python/game/breakout.py'];
r = await tool('job_run', { lang: 'python', code: src, detach: true, timeout_s: 90 }); const jid = r.job_id; await wait(2500);
let g = await tool('job_gui', { job_id: jid, action: 'snapshot' }); const cv = g.windows[0] && g.windows[0].nodes.find((n) => n.kind === 'canvas');
R.breakout = { running: g.running, windows: g.windows.length, canvas: cv && [cv.width, cv.height], err: g.running ? null : (g.output || '').slice(-400) };
if (cv) {
  const k = await tool('job_gui', { job_id: jid, action: 'key', node: cv.id, value: { key: 'ArrowLeft', down: true }, wait_ms: 600 }); R.breakout.key_ok = k.ok === true;
  await tool('job_gui', { job_id: jid, action: 'key', node: cv.id, value: { key: 'ArrowLeft', down: false }, wait_ms: 100 });
  await tool('job_gui', { job_id: jid, action: 'mouse', node: cv.id, value: { kind: 'move', x: 200, y: 300, button: 0 }, wait_ms: 300 });
  const sh = await tool('job_gui', { job_id: jid, action: 'screenshot', canvas: 0 }); R.breakout.shot = sh.ok ? sh.screenshot.bytes : sh.error;
}
r = await tool('job_stop', { job_id: jid }); await wait(500);
R.breakout.stopped = !(await tool('job_list', {})).jobs.find((j) => j.job_id === jid).running;
// 3. 其他範例各跑 3 秒，確認不丟例外
R.examples = {};
for (const name of ['python/game/missile_command.py', 'python/game/platformer.py', 'python/game/racing.py', 'python/game/rpg.py', 'python/game/arpg.py']) {
  const j = await tool('job_run', { lang: 'python', code: FA_PY_EXAMPLES[name], detach: true, timeout_s: 60 }); await wait(2500);
  const s = await tool('job_gui', { job_id: j.job_id, action: 'snapshot' }); R.examples[name.split('/').pop()] = { running: s.running, windows: s.windows.length, err: s.running ? undefined : (s.output || '').slice(-200) };
  await tool('job_stop', { job_id: j.job_id });
}
R.ok = R.min.exit === 0 && /frames 40/.test(R.min.out) && R.breakout.running && R.breakout.windows === 1 && R.breakout.key_ok && R.breakout.stopped && Object.values(R.examples).every((e) => e.running && e.windows === 1);
console.log('PG_RESULT ' + JSON.stringify(R));
return R;
