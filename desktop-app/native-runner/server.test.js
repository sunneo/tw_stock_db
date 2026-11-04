// 原生執行器階段 4 的單元測試（node 直接跑）：本機伺服器的綁定、金鑰、路由、保留埠。
// 注意：Node 16 需要 --experimental-fetch：node --experimental-fetch native-runner/server.test.js
// 用法：node native-runner/server.test.js
'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');
const { createNativeRunnerHost } = require('./host.js');
const { createServer, loadOrCreateKey, RESERVED_PORTS, BIND_HOST } = require('./server.js');

let ok = 0; const bad = [];
const check = (name, c, x) => { if (c) ok++; else { bad.push(name); console.log('FAIL', name, x === undefined ? '' : JSON.stringify(x).slice(0, 300)); } };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nr-srv-'));

(async () => {
    check('保留埠包含 17923（瀏覽器控制）', RESERVED_PORTS.indexOf(17923) >= 0);
    check('綁定位址固定為 127.0.0.1', BIND_HOST === '127.0.0.1');

    // 金鑰檔：第一次產生、之後沿用、格式為 64 個十六進位字元
    const kf = path.join(tmp, 'key.txt');
    const k1 = loadOrCreateKey(kf), k2 = loadOrCreateKey(kf);
    check('金鑰為 64 位十六進位，且第二次沿用同一把', /^[0-9a-f]{64}$/.test(k1) && k1 === k2);

    const host = createNativeRunnerHost({ childPath: path.join(__dirname, 'child.js'), progressFile: path.join(tmp, 'p.jsonl'), idleMs: 0, graceMs: 1000, handshakeMs: 5000 });

    // 保留埠：拒絕啟動並說明原因
    let rejected = null;
    try { await createServer({ host, port: 17923, key: k1 }); } catch (e) { rejected = e; }
    check('拒絕使用保留埠 17923 並說明原因', rejected && /17923/.test(rejected.message), rejected && rejected.message);

    const srv = await createServer({ host, port: 0, key: k1 });
    const base = 'http://127.0.0.1:' + srv.port;
    check('伺服器實際綁在 127.0.0.1', srv.server.address().address === '127.0.0.1', srv.server.address());

    const noKey = await fetch(base + '/v1/health');
    check('沒有金鑰回 401', noKey.status === 401, noKey.status);
    const badKey = await fetch(base + '/v1/health', { headers: { authorization: 'Bearer ' + '0'.repeat(64) } });
    check('錯誤金鑰回 401', badKey.status === 401, badKey.status);
    const health = await fetch(base + '/v1/health', { headers: { authorization: 'Bearer ' + k1 } });
    const hj = await health.json();
    check('正確金鑰的 health 回 200 與協定版本', health.status === 200 && hj.ok === true && hj.v === 1, hj);

    const run = await fetch(base + '/v1/run', { method: 'POST', headers: { authorization: 'Bearer ' + k1, 'content-type': 'application/json' }, body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }], fake: { reply: '好' } }) });
    const rj = await run.json();
    check('run 回 200 與文字', run.status === 200 && rj.ok === true && rj.text === '好', rj);

    const badJson = await fetch(base + '/v1/run', { method: 'POST', headers: { authorization: 'Bearer ' + k1 }, body: '{bad' });
    check('非 JSON 的 body 回 400', badJson.status === 400, badJson.status);

    const nf = await fetch(base + '/v1/nothing', { headers: { authorization: 'Bearer ' + k1 } });
    check('未知路由回 404', nf.status === 404, nf.status);

    const crash = await fetch(base + '/v1/run', { method: 'POST', headers: { authorization: 'Bearer ' + k1 }, body: JSON.stringify({ fake: { crash: true } }) });
    const cj = await crash.json();
    check('子程序崩潰時回 502 與 code=crashed（真實原因）', crash.status === 502 && cj.code === 'crashed', { s: crash.status, cj });

    await srv.close();
    host.dispose('測試');

    // 埠被占用：第二個伺服器拒絕，原因寫明 占用
    const first = await createServer({ host: createNativeRunnerHost({ childPath: path.join(__dirname, 'child.js'), progressFile: path.join(tmp, 'p2.jsonl'), idleMs: 0 }), port: 0, key: k1 });
    let occupied = null;
    try { await createServer({ host: createNativeRunnerHost({ childPath: path.join(__dirname, 'child.js'), progressFile: path.join(tmp, 'p3.jsonl'), idleMs: 0 }), port: first.port, key: k1 }); }
    catch (e) { occupied = e; }
    check('埠被占用時拒絕啟動並說明原因', occupied && /已被占用/.test(occupied.message), occupied && occupied.message);
    await first.close();

    console.log(ok + ' passed, ' + bad.length + ' failed', bad);
    process.exit(bad.length ? 1 : 0);
})().catch((e) => { console.log('FAIL 例外', e); process.exit(1); });
