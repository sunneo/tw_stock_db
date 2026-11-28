'use strict';
// cpu-py 梯度資源（Node 端的配接器）：常駐一個 Python 工作者行程（hetero_cpu_grad.py），依協定收發。
// 給 hetero_resources.set.add 用：resource = await createCpuPyResource({...}) 之後 set.add(resource)。
// 這個檔只在 Node（測試與協調端的行程）裡跑；桌面版的 Electron 端另有橋接，走同一份協定。
//
//   createCpuPyResource({ id, python, cfg, dtype, rate?, script? }) → Promise<{ id, kind:'cpu-py', rate, impl }>
//     impl.gradient({ params, seqs }) → Promise<{ loss, n, grads, ms }>   （params 的鍵是 JS 名稱）
//     impl.close()
//
// 每次 gradient 會把參數寫成暫存檔（float64，回應的 names 順序）、序列寫成 JSON，梯度讀回成 Float64Array。
// ms 是這次呼叫的牆鐘時間（含 IPC 與檔案 IO），協調端用它量速率。
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const DEFAULT_SCRIPT = path.join(__dirname, 'hetero_cpu_grad.py');

function createCpuPyResource(opts) {
  const o = Object.assign({ script: DEFAULT_SCRIPT, rate: null }, opts || {});
  if (!o.python) throw new Error('需要 python 路徑');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fa-hetero-cpu-'));
  const child = spawn(o.python, [o.script], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let buf = '', stderr = '', seq = 0;
  const waiters = new Map();
  let dead = null;
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line) continue;
      let msg; try { msg = JSON.parse(line); } catch (e) { continue; }
      const w = waiters.get(msg.id);
      if (w) { waiters.delete(msg.id); w.resolve(msg); }
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (c) => { stderr = (stderr + c).slice(-4000); });
  const failAll = (why) => { dead = dead || why; for (const [, w] of waiters) w.reject(new Error(why)); waiters.clear(); };
  child.on('exit', (code) => failAll('cpu-py 工作者結束（代碼 ' + code + '）' + (stderr ? '：' + stderr.trim().split('\n').slice(-3).join(' | ') : '')));
  child.on('error', (e) => failAll('cpu-py 工作者啟動失敗：' + e.message));
  child.stdin.on('error', (e) => failAll('cpu-py 工作者的輸入已關閉：' + e.message));

  const call = (req) => {
    if (dead) return Promise.reject(new Error(dead));
    if (child.exitCode !== null || child.signalCode !== null) return Promise.reject(new Error('cpu-py 工作者已結束'));
    const id = ++seq;
    return new Promise((resolve, reject) => {
      waiters.set(id, { resolve, reject });
      child.stdin.write(JSON.stringify(Object.assign({ id }, req)) + '\n');
    });
  };

  let layout = null, total = 0, queue = Promise.resolve();
  const serial = (fn) => { const p = queue.then(fn, fn); queue = p.catch(() => {}); return p; };

  const init = call({ op: 'init', cfg: o.cfg, dtype: o.dtype || 'float64' }).then((r) => {
    if (!r.ok) throw new Error('cpu-py 初始化失敗：' + r.error);
    layout = r.names; total = layout.reduce((a, x) => a + x[1], 0);
  });

  // 線上格式：float32 工作者用 f32（一半位元組，工作者本來就以 f32 運算）；float64 工作者用 f64
  const wireArr = () => (o.dtype === 'float32' ? Float32Array : Float64Array);
  const impl = {
    gradient({ params, seqs }) {
      return serial(async () => {
        await init;
        const t0 = Date.now();
        const W = wireArr(), wb = W.BYTES_PER_ELEMENT;
        const pbuf = Buffer.alloc(total * wb);
        let off = 0;
        for (const [name, len] of layout) {
          const v = params[name];
          if (!v || v.length !== len) throw new Error('參數 ' + name + ' 長度不符');
          Buffer.from(W.from(v).buffer).copy(pbuf, off * wb);
          off += len;
        }
        const pf = path.join(dir, 'params.f64'), sf = path.join(dir, 'seqs.json'), gf = path.join(dir, 'grads.f64');
        fs.writeFileSync(pf, pbuf);
        fs.writeFileSync(sf, JSON.stringify(seqs));
        const t1 = Date.now();
        const r = await call({ op: 'grad', params_file: pf, seqs_file: sf, grads_file: gf });
        if (!r.ok) throw new Error('cpu-py 梯度失敗：' + r.error);
        const gb = fs.readFileSync(gf);
        if (gb.length !== total * wb) throw new Error('梯度檔長度 ' + gb.length + ' 與佈局 ' + total * wb + ' 不符');
        const wall = new W(total);
        Buffer.from(wall.buffer).set(gb);
        const all = Float64Array.from(wall);
        const grads = {}; off = 0;
        for (const [name, len] of layout) { grads[name] = all.slice(off, off + len); off += len; }
        return { loss: r.loss, n: r.n, grads, ms: Date.now() - t0, workerMs: r.ms, phases: { load: r.tLoad, fwdBwd: r.tFwdBwd, export: r.tExport, reqWrite: t1 - t0, reqRead: Date.now() - t1 } };
      });
    },
    close() {
      dead = dead || 'cpu-py 工作者已關閉';
      try { child.stdin.write(JSON.stringify({ op: 'quit' }) + '\n'); } catch (e) { /* 已結束 */ }
      try { child.kill(); } catch (e) { /* 已結束 */ }
    },
  };
  return init.then(() => ({ id: o.id, kind: 'cpu-py', rate: o.rate, layout, impl }));
}

module.exports = { createCpuPyResource, DEFAULT_SCRIPT };
