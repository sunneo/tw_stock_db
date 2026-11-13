// 內建 LoRA 下載（main-ext.js 的 BLT，DESIGN.lora-training.md §33 批 1）。
// 用本機 http 檔案伺服器代替 GitHub：正常下載、分片不符、整檔不符、HTTP 錯誤（含重試）、轉址、逾時、清單退回快取、清單格式錯、刪除。
// 沒測到的：真 GitHub 網路、真 Electron 的 IPC（見 §33 的探針）。
'use strict';
const fs = require('fs'), os = require('os'), path = require('path'), crypto = require('crypto'), http = require('http');
const root = path.join(__dirname, '..', '..');
const { _BLT: BLT } = require(path.join(root, 'main-ext.js'));

let ok = 0; const bad = [];
const check = (n, c, x) => { if (c) ok++; else { bad.push(n); console.log('FAIL', n, x === undefined ? '' : JSON.stringify(x).slice(0, 400)); } };
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

// 假的 fatrain：兩片，共 1500 位元組
const pA = crypto.randomBytes(1000), pB = crypto.randomBytes(500);
const whole = Buffer.concat([pA, pB]);
const ID = 'toy-r4', DIR = 'toy-r4';
const serve = {}; // 路徑 → {status, body, delayMs, location}
let server, base;

function manifest(over) {
    const m = {
        format: 'fa-lora-builtin', version: 1, base_url: base + '/', entries: [{
            id: ID, name: ID, version: '1.0.0', size: whole.length, sha256: sha(whole), dir: DIR,
            parts: [{ file: ID + '.fatrain.part00', size: pA.length, sha256: sha(pA) }, { file: ID + '.fatrain.part01', size: pB.length, sha256: sha(pB) }],
            domains: ['toy'], gate: { pass: true, reason: '測試' }, defaultOn: true, limits: [],
        }],
    };
    return Object.assign(m, over || {});
}
function setDefaults() {
    for (const k of Object.keys(serve)) delete serve[k];
    serve['/builtin.json'] = { body: () => Buffer.from(JSON.stringify(manifest())) };
    serve['/' + DIR + '/' + ID + '.fatrain.part00'] = { body: () => pA };
    serve['/' + DIR + '/' + ID + '.fatrain.part01'] = { body: () => pB };
}

function startServer() {
    return new Promise((res) => {
        server = http.createServer((req, rs) => {
            const r = serve[req.url.split('?')[0]];
            if (!r) { rs.writeHead(404); return rs.end('nope'); }
            if (r.location) { rs.writeHead(302, { location: r.location }); return rs.end(); }
            const send = () => { if (r.status && r.status !== 200) { rs.writeHead(r.status); return rs.end('x'); } const b = r.body(); rs.writeHead(200, { 'content-length': b.length }); rs.end(b); };
            if (r.delayMs) setTimeout(send, r.delayMs); else send();
        });
        server.listen(0, '127.0.0.1', () => { base = 'http://127.0.0.1:' + server.address().port; res(); });
    });
}

(async () => {
    await startServer();
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'blt-test-'));
    const mk = (extra) => BLT.create(Object.assign({ fs, path, crypto, userData: tmpRoot, manifestUrl: base + '/builtin.json', timeoutMs: 300, totalMs: 20000, retries: 1 }, extra || {}));
    const outFile = path.join(tmpRoot, 'builtin-lora', ID + '.fatrain');

    // 1. 正常：下載、逐片核對、寫入、狀態
    setDefaults();
    let b = mk();
    let r = await b.fetchBuiltin(ID);
    check('1 ok', r.ok === true, r);
    check('1 bytes on disk', r.ok && fs.readFileSync(outFile).equals(whole));
    check('1 no partial left', !fs.existsSync(outFile + '.partial'));
    const st = b.status();
    check('1 status downloaded size', st.downloaded[ID] === whole.length, st);
    check('1 progress done', st.progress[ID] && st.progress[ID].state === 'done' && st.progress[ID].part === 2, st.progress);
    check('1 manifest cached', fs.existsSync(path.join(tmpRoot, 'builtin-lora', 'manifest.json')));

    // 2. 分片校驗不符：伺服器給錯的第二片
    setDefaults(); serve['/' + DIR + '/' + ID + '.fatrain.part01'] = { body: () => crypto.randomBytes(500) };
    fs.rmSync(outFile, { force: true });
    b = mk(); r = await b.fetchBuiltin(ID);
    check('2 part_mismatch', r.ok === false && r.code === 'part_mismatch', r);
    check('2 nothing written', !fs.existsSync(outFile));
    check('2 human text', typeof r.message === 'string' && r.message.indexOf('校驗不符') >= 0, r);

    // 3. 整檔校驗不符：清單的總 sha256 錯（分片都對）
    setDefaults(); serve['/builtin.json'] = { body: () => Buffer.from(JSON.stringify(manifest({ entries: [Object.assign(manifest().entries[0], { sha256: '0'.repeat(64) })] }))) };
    b = mk(); r = await b.fetchBuiltin(ID);
    check('3 total_mismatch', r.ok === false && r.code === 'total_mismatch', r);
    check('3 nothing written', !fs.existsSync(outFile));

    // 4. HTTP 404 在分片上：重試後回 http，白話說明含狀態碼
    setDefaults(); serve['/' + DIR + '/' + ID + '.fatrain.part00'] = { status: 404 };
    b = mk(); r = await b.fetchBuiltin(ID);
    check('4 http error', r.ok === false && r.code === 'http', r);
    check('4 human has status', r.message && r.message.indexOf('404') >= 0, r);

    // 5. 轉址：分片 part00 轉到另一個路徑
    setDefaults(); serve['/' + DIR + '/' + ID + '.fatrain.part00'] = { location: '/moved/part00' }; serve['/moved/part00'] = { body: () => pA };
    fs.rmSync(outFile, { force: true });
    b = mk(); r = await b.fetchBuiltin(ID);
    check('5 redirect followed', r.ok === true, r);

    // 6. 逾時：分片延遲 1 秒，逾時上限 300 毫秒，重試後回 timeout
    setDefaults(); serve['/' + DIR + '/' + ID + '.fatrain.part00'] = { body: () => pA, delayMs: 1000 };
    fs.rmSync(outFile, { force: true });
    b = mk(); const t0 = Date.now(); r = await b.fetchBuiltin(ID);
    check('6 timeout', r.ok === false && r.code === 'timeout', r);
    check('6 bounded time', Date.now() - t0 < 3000, Date.now() - t0);

    // 7. 清單抓不到、有快取：退回快取並說明（先用正常清單產生快取）
    setDefaults(); fs.rmSync(outFile, { force: true });
    b = mk(); await b.fetchBuiltin(ID); fs.rmSync(outFile, { force: true });
    const b2 = mk({ manifestUrl: base + '/missing.json' });
    const lm = await b2.loadManifest();
    check('7 cache fallback', lm.ok === true && lm.source === 'cache' && lm.note.indexOf('快取') >= 0, lm);
    r = await b2.fetchBuiltin(ID);
    check('7 download with cache manifest', r.ok === true && fs.existsSync(outFile), r);

    // 8. 清單抓不到、沒有快取：回 no_manifest
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'blt-empty-'));
    const b3 = BLT.create({ fs, path, crypto, userData: empty, manifestUrl: base + '/missing.json', timeoutMs: 300, retries: 0 });
    r = await b3.fetchBuiltin(ID);
    check('8 no manifest', r.ok === false && (r.code === 'network' || r.code === 'http'), r);
    check('8 message says no cache', r.message && r.message.indexOf('快取') >= 0, r);

    // 9. 清單格式錯（缺 sha256）：bad_manifest，不下載
    setDefaults(); serve['/builtin.json'] = { body: () => Buffer.from(JSON.stringify({ format: 'fa-lora-builtin', base_url: base + '/', entries: [{ id: ID, dir: DIR, parts: [{ file: 'x', size: 1, sha256: 'bad' }] }] })) };
    fs.rmSync(outFile, { force: true });
    b = mk({ manifestUrl: base + '/builtin.json' }); r = await b.fetchBuiltin(ID);
    check('9 bad manifest', r.ok === false && r.code === 'bad_manifest', r);

    // 10. 不認得的 id、不合法的 id
    setDefaults(); b = mk();
    r = await b.fetchBuiltin('no-such'); check('10 no_entry', r.ok === false && r.code === 'no_entry', r);
    r = await b.fetchBuiltin('../etc'); check('10 bad_id', r.ok === false && r.code === 'bad_id', r);

    // 11. 刪除：下載後刪掉，狀態不再列出；刪不存在的也不出錯
    setDefaults(); fs.rmSync(outFile, { force: true }); b = mk();
    await b.fetchBuiltin(ID);
    check('11 status has it', !!b.status().downloaded[ID]);
    r = b.remove(ID); check('11 removed', r.ok && r.removed === true, r);
    check('11 gone from status', !b.status().downloaded[ID]);
    r = b.remove(ID); check('11 remove twice ok', r.ok && r.removed === false, r);

    // 12. handle() 分派：builtin_status／builtin_manifest／未知操作
    r = await b.handle('builtin_status', {}); check('12 status op', r.ok === true && typeof r.downloaded === 'object', r);
    r = await b.handle('builtin_manifest', {}); check('12 manifest op', r.ok === true && r.manifest && r.manifest.entries.length === 1, r);
    r = await b.handle('builtin_nope', {}); check('12 bad op', r.ok === false && r.code === 'bad_op', r);

    // 13. 白話文字：每個代碼都有可讀訊息，沒有英文錯誤碼外露
    for (const c of ['network', 'timeout', 'part_mismatch', 'total_mismatch', 'no_entry', 'bad_manifest', 'write_failed']) {
        const m = BLT.humanError(c, ID, 404);
        check('13 human ' + c, typeof m === 'string' && m.length > 10 && m.indexOf('undefined') < 0 && m.indexOf('{status}') < 0, m);
    }

    server.close();
    fs.rmSync(tmpRoot, { recursive: true, force: true }); fs.rmSync(empty, { recursive: true, force: true });
    console.log('builtin_lora: ' + ok + ' 通過，' + bad.length + ' 失敗' + (bad.length ? '：' + bad.join('、') : ''));
    process.exit(bad.length ? 1 : 0);
})().catch((e) => { console.error('ERROR', e); process.exit(2); });
