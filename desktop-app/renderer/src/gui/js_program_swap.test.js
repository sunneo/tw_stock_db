// node 的 swap 與 canvas：用假的頁面（swap.* 用 Map 模擬 IndexedDB、gui.* 記錄並餵事件）跑 shim 與 examples/node 的範例。
// Run: node renderer/src/gui/js_program_swap.test.js
const fs = require('fs'), path = require('path'), vm = require('vm');
const src = fs.readFileSync(path.join(__dirname, 'js_program.js'), 'utf8');
let ok = 0; const bad = [];
const check = (n, c, x) => { if (c) ok++; else bad.push(n + (x !== undefined ? ' ' + JSON.stringify(x).slice(0, 200) : '')); };
// 取出 programShim 的文字
const shimSrc = src.slice(src.indexOf('function programShim'), src.indexOf('function buildSrcdoc'));
function runProgram(code, host) {
  return new Promise((resolve) => {
    const listeners = [], parent = { postMessage(m) { host(m, (reply) => setImmediate(() => listeners.forEach((l) => l({ source: parent, data: reply }))), resolve); } };
    const win = { addEventListener: (t, f) => listeners.push(f) }; win.window = win; win.parent = parent;
    const ctx = vm.createContext(Object.assign(win, { parent, console: {}, btoa: (s) => Buffer.from(s, 'latin1').toString('base64'), atob: (s) => Buffer.from(s, 'base64').toString('latin1'), setTimeout, Promise, Math, Date, JSON, Object, Array, Uint8Array, Float32Array, Float64Array, Int32Array, Uint32Array, Int16Array, Uint16Array, Int8Array, String, Number, Error, isNaN }));
    vm.runInContext(shimSrc + '\nprogramShim(' + JSON.stringify(code) + ');', ctx);
  });
}
function makeHost(script) {
  const disk = new Map(); let n = 0; const st = { draws: 0, maxOps: 0, puts: 0, gets: 0, done: null, log: [], waits: 0, ids: 0 };
  const host = (m, reply, finish) => {
    if (m.__log) { st.log.push(m.__log.m); return; }
    if (m.__done) { st.done = m.__done; finish(st); return; }
    const g = m.__gui; if (!g) return; const a = g.args || {}; let res = null, err = null;
    if (g.op === 'swap.put') { const id = 'k' + (++n); disk.set(id, a.b64); st.puts++; res = { id, size: a.b64.length }; }
    else if (g.op === 'swap.get') { st.gets++; if (!disk.has(a.id)) err = '不存在'; else res = { b64: disk.get(a.id) }; }
    else if (g.op === 'swap.drop') { disk.delete(a.id); res = { ok: true }; }
    else if (g.op === 'swap.close') { disk.clear(); res = { ok: true }; }
    else if (g.op === 'swap.stats') res = { items: disk.size, hotBytes: 0, diskBytes: [...disk.values()].reduce((s, b) => s + b.length, 0), limit: 0, pages: disk.size };
    else if (g.op === 'gui.draw') { st.draws++; st.maxOps = Math.max(st.maxOps, a.ops.length); }
    else if (g.op === 'gui.wait') res = script(st, a);
    reply(err ? { __reply: { rid: g.rid, ok: false, error: err } } : { __reply: { rid: g.rid, ok: true, result: res } });
  };
  st.disk = disk; return { host, st };
}
(async () => {
  // 1. swap 基本：超過熱區的陣列讀寫一致
  let h = makeHost(() => null);
  let r = await runProgram(`
    await swap.hotMB(0.0625);
    const a = swap.array(100000, 'f32'), data = new Float32Array(100000); for (let i = 0; i < data.length; i++) data[i] = i * 0.5;
    await a.set(0, data);
    const mid = await a.get(30000, 5); console.log(Array.from(mid).join(','));
    await a.set(99990, new Float32Array([7, 8, 9]));
    const all = await a.get(0); let bad = 0; for (let i = 0; i < all.length; i++) { const e = i >= 99990 && i < 99993 ? 7 + i - 99990 : i * 0.5; if (all[i] !== e) bad++; }
    console.log('bad=' + bad);
    const z = swap.array(1000, 'u8'); console.log('zero=' + (await z.get(0)).reduce((s, v) => s + v, 0));
    await a.map((b) => { for (let i = 0; i < b.length; i++) b[i] = 1; }); console.log('sum=' + (await a.get(0)).reduce((s, v) => s + v, 0));
    let e = ''; try { await a.get(99999, 5); } catch (x) { e = x.message; } console.log('err=' + e);
    const s = await swap.stats(); console.log('writes>0=' + (s.writes > 0) + ' reads>0=' + (s.reads > 0));
  `, h.host);
  check('swap 程式正常結束', r.done && r.done.ok, r.done);
  const L = r.log.join('|');
  check('跨頁讀正確', /^15000,15000\.5,15001,15001\.5,15002/.test(r.log[0]), r.log[0]);
  check('整個陣列一致', r.log[1] === 'bad=0', r.log[1]);
  check('沒寫過是 0', r.log[2] === 'zero=0');
  check('map 寫回', r.log[3] === 'sum=100000', r.log[3]);
  check('越界有錯誤', /outside/.test(r.log[4] || ''), r.log[4]);
  check('熱區小所以真的寫出與讀回', /writes>0=true reads>0=true/.test(L), L.slice(-80));
  check('結束時 swap.close 清掉頁面', r.disk.size === 0 && r.puts > 0, r.disk.size);
  // 2. 範例
  const ex = path.join(__dirname, '..', 'examples', 'node');
  // swap_demo：點「開始」一次，再關閉
  let step = 0; h = makeHost((st, a) => { step++; return step === 1 ? { event: 'click', node: 'n6' } : { event: 'close' }; });
  r = await runProgram(fs.readFileSync(path.join(ex, 'gui/swap_demo.js'), 'utf8').replace("'64'", "'3'"), h.host);
  check('swap_demo 完成', r.done && r.done.ok, r.done); 
  // snake：餵 frame 與按鍵 60 次再關閉
  let k = 0; h = makeHost(() => { k++; if (k > 80) return { event: 'close' }; return k % 7 === 0 ? { event: 'key', value: { key: ['ArrowDown', 'ArrowLeft', 'ArrowUp', 'ArrowRight'][k % 4], down: true } } : { event: 'frame' }; });
  r = await runProgram(fs.readFileSync(path.join(ex, 'game/snake.js'), 'utf8'), h.host);
  check('snake 完成並有畫面、指令數 ≤ 200', r.done && r.done.ok && r.draws > 30 && r.maxOps <= 200, [r.done, r.draws, r.maxOps]);
  // life_swap：縮小棋盤加速（N=1024 太慢），跑 6 個世代
  k = 0; h = makeHost(() => { k++; return k > 8 ? { event: 'close' } : { event: 'frame' }; });
  r = await runProgram(fs.readFileSync(path.join(ex, 'game/life_swap.js'), 'utf8').replace('const N = 1024', 'const N = 128').replace('swap.hotMB(1)', 'swap.hotMB(0.004)').replace('512 + y', '64 + y').replace('512 + x', '64 + x').replace('ox = 496, oy = 500', 'ox = 48, oy = 52'), h.host);
  check('life_swap 完成、有用 swap 讀寫、指令數 ≤ 200', r.done && r.done.ok && r.puts > 0 && r.gets > 0 && r.maxOps <= 200, [r.done, r.puts, r.gets, r.maxOps]);
  const lastText = r.log; 
  console.log(bad.length ? 'FAILED:\n  ' + bad.join('\n  ') : 'js_program_swap: ' + ok + ' passed'); process.exit(bad.length ? 1 : 0);
})().catch((e) => { console.log('EXCEPTION', e && e.stack || e); process.exit(1); });
