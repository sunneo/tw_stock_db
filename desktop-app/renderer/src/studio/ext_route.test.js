// node renderer/src/studio/ext_route.test.js —— /api/ext/* 路由：只有桌面版；參數轉給主行程；主行程拒絕時回 409 並寫紀錄；未知子路由回 404
// 主行程用假的 call 代替（真的訓練已在 ext_job_core 與主行程的實測裡跑過，這裡只測路由接線）
const Storage = require('./storage_core.js');
const { createServer } = require('./studio_server_core.js');
let ok = 0, bad = 0; const check = (n, c, x) => { if (c) ok++; else { bad++; console.log('FAIL ' + n, x === undefined ? '' : JSON.stringify(x).slice(0, 300)); } };

function mk(desktop, hostOps) {
  const storage = Storage.createStorage({ memory: Storage.createMemoryStore() });
  const calls = [];
  const h = { storage, desktop, now: () => 1000, prefsGet: () => ({}), prefsSet: () => {}, download: async () => {}, pickFile: async () => null, pickFiles: async () => null,
    call: async (op, p) => { calls.push([op, p]); return hostOps && hostOps[op] ? hostOps[op](p) : { ok: true }; },
    workDir: async () => '/ud/studio' };
  const srv = createServer(h); srv.setPush(() => {});
  const req = async (m, path, body) => { const r = await srv.route(m, new URL('http://mock.local' + path), body); return { s: r.s || 200, j: r.j }; };
  return { req, calls };
}

(async () => {
  // 網頁版：一律 400，不碰主行程
  const web = mk(false, {});
  let r = await web.req('POST', '/api/ext/start', { type: 'music', name: 'a' });
  check('網頁版不能啟動外部訓練（400）', r.s === 400 && web.calls.length === 0, r);

  const t = mk(true, {
    studio_ext_check: (p) => ({ ok: p.type === 'music', type: p.type, errors: p.type === 'music' ? [] : ['不認得'] }),
    studio_ext_start: (p) => (p.name === 'dup' ? { ok: false, error: '輸出資料夾已有內容' } : { ok: true, jobId: 'ext1', outDir: '/ud/studio-ext/music/' + p.name, steps: [{ id: 'gen' }] }),
    studio_ext_status: (p) => ({ ok: true, jobId: p.jobId, state: 'running', step: 3, loss: 2.5, steps: [{ id: 'train', label: '訓練作曲模型', state: 'running' }] }),
    studio_ext_stop: () => ({ ok: true }),
  });
  r = await t.req('POST', '/api/ext/start', { type: 'music', name: 'demo', params: { steps: 1500 } });
  check('啟動：參數原樣轉給主行程（studio_ext_start）', r.s === 200 && r.j.jobId === 'ext1' && t.calls[0][0] === 'studio_ext_start' && t.calls[0][1].params.steps === 1500, { r, calls: t.calls });
  check('啟動後記住最近的工作（之後的 status 不帶 jobId 也能讀）', (await t.req('GET', '/api/ext/status')).j.jobId === 'ext1');
  r = await t.req('POST', '/api/ext/start', { type: 'music', name: 'dup' });
  check('主行程拒絕 → 409 並帶原因', r.s === 409 && /已有內容/.test(r.j.error), r);
  r = await t.req('GET', '/api/ext/check?type=music');
  check('檢查：Query 轉給 studio_ext_check', r.s === 200 && r.j.ok === true && t.calls.some((c) => c[0] === 'studio_ext_check' && c[1].type === 'music'), r);
  r = await t.req('POST', '/api/ext/check', { type: 'image' });
  check('檢查未接線的型別：回 ok:false 與原因', r.s === 200 && r.j.ok === false, r);
  r = await t.req('GET', '/api/ext/status?jobId=ext1');
  check('狀態：回 running、步數與損失', r.s === 200 && r.j.state === 'running' && r.j.step === 3 && r.j.loss === 2.5, r);
  r = await t.req('POST', '/api/ext/stop', { jobId: 'ext1' });
  check('停止：轉給 studio_ext_stop', r.s === 200 && t.calls.some((c) => c[0] === 'studio_ext_stop' && c[1].jobId === 'ext1'), r);
  r = await t.req('GET', '/api/ext/nope');
  check('未知子路由 → 404', r.s === 404, r);

  console.log(ok + ' 項通過，' + bad + ' 項失敗');
  process.exitCode = bad ? 1 : 0;
})();
