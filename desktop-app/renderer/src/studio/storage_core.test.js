// node renderer/src/studio/storage_core.test.js
const A = require('./asset_core.js'); const S = require('./storage_core.js'); const fs = require('fs'); const os = require('os'); const path = require('path');
let ok = 0, bad = 0; const check = (n, c, x) => { if (c) ok++; else { bad++; console.log('FAIL ' + n + (x !== undefined ? ' ' + JSON.stringify(x).slice(0, 400) : '')); } };
const u = (s) => new TextEncoder().encode(s); const eq = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;
const CP = { base: 'Qwen3-0.6B', rank: 8, alpha: 16, prompt_format_version: 3, tool_catalog_sha256: 'x'.repeat(64) };
const mkAsset = (name, big) => { const files = { 'data/a.jsonl': u('{"x":1}\n'), 'weights/w.bin': big || u('WWWW') }; return { manifest: A.createManifest({ kind: 'lora', name, files, compat: CP }), files }; };
(async () => {
    // 記憶體 store
    const mem = S.createMemoryStore(); await mem.put('a/b.txt', u('hi')); await mem.put('a/c.txt', u('yo')); await mem.put('z/d', u('1'));
    check('記憶體 store：get／list／delete', eq(await mem.get('a/b.txt'), u('hi')) && (await mem.list('a/')).join() === 'a/b.txt,a/c.txt' && (await mem.get('nope')) === null && (await mem.delete('a/b.txt')) === undefined && (await mem.get('a/b.txt')) === null);
    check('記憶體 store：取出是副本', (async () => { const x = await mem.get('a/c.txt'); x[0] = 0; return eq(await mem.get('a/c.txt'), u('yo')); })());
    let bk = false; try { await mem.put('../x', u('1')); } catch (_) { bk = true; } check('鍵不安全拒絕', bk);

    // 分塊：單筆不超過 chunkBytes，不進 FileCache 式的整筆大檔
    const kv = S.createMemoryStore(); const ch = S.createChunkedStore(kv, { chunkBytes: 1024 });
    const bigv = new Uint8Array(10000); for (let i = 0; i < bigv.length; i++) bigv[i] = (i * 13) & 255;
    await ch.put('k/big', bigv);
    let mx = 0; for (const k of await kv.list('')) mx = Math.max(mx, (await kv.get(k)).length);
    check('分塊：底層最大單筆 ≤ 1024', mx <= 1024, mx);
    check('分塊：讀回逐位元相同', eq(await ch.get('k/big'), bigv));
    check('分塊：list 不露出分塊鍵', (await ch.list('')).join() === 'k/big' && (await kv.list('')).length === 11);
    await ch.put('k/big', new Uint8Array(100)); check('分塊：覆寫時舊分塊被清掉', (await kv.list('')).length === 2 && (await ch.get('k/big')).length === 100);
    await ch.put('k/big', bigv); const chunkKey = (await kv.list('')).find((k) => /\.~c00003$/.test(k)); await kv.delete(chunkKey);
    check('分塊：有一塊被淘汰 → 視為不存在（回 null，不回半個檔）', (await ch.get('k/big')) === null);
    await ch.delete('k/big'); check('分塊：刪除連分塊一起清', (await kv.list('')).length === 0);

    // 兩處同步：沒有 fap
    const memOnly = S.createStorage({ memory: S.createMemoryStore() });
    const r0 = await memOnly.write('lora/x/f', u('1'));
    check('沒有 fap：只寫記憶體並標示資料可能遺失', r0.memory && !r0.fap && r0.dataMayBeLost === true && r0.reason === 'no-fap' && /遺失/.test(r0.warning), r0);
    check('fapState 說明原因', (await memOnly.fapState()).ok === false);

    // 有 fap（Node fs）
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fastudio-')); const root = path.join(tmp, '.floating-assistant', 'training');
    const fap = S.createNodeFsStore({ fs, path, root }); const memory = S.createMemoryStore();
    const st = S.createStorage({ memory, fap });
    const a = mkAsset('my-lora', new Uint8Array(3000).fill(7));
    const sv = await st.saveAsset(a);
    check('有 fap：兩處都寫、沒有遺失旗標', sv.ok && sv.written === 2 && sv.dataMayBeLost === false, sv);
    check('fap 實際落在 <fap>/.floating-assistant/training/<kind>/<name>/', fs.existsSync(path.join(root, 'lora', 'my-lora', 'manifest.json')) && fs.existsSync(path.join(root, 'lora', 'my-lora', 'weights', 'w.bin')));
    check('fap 資料夾自帶 .gitignore', fs.readFileSync(path.join(root, '.gitignore'), 'utf8') === '*\n');
    check('寫入沒留下暫存檔', fs.readdirSync(path.join(root, 'lora', 'my-lora')).every((n) => !/\.tmp-/.test(n)));
    check('記憶體也有一份', (await memory.list('lora/my-lora/')).length === 3);
    // 記憶體被清掉（瀏覽器清資料）→ 從 fap 讀回並回填
    for (const k of await memory.list('')) await memory.delete(k);
    const ld = await st.loadAsset('lora', 'my-lora'); check('記憶體清空後從 fap 讀回，sha256 通過', ld && ld.verify.ok && eq(ld.asset.files['weights/w.bin'], a.files['weights/w.bin']));
    check('讀 fap 後回填記憶體', (await memory.list('lora/my-lora/')).length === 3);
    check('listAssets 看得到', (await st.listAssets()).map((x) => x.kind + '/' + x.name).join() === 'lora/my-lora');
    // 只剩記憶體時資產也能列
    const bad1 = mkAsset('tampered'); bad1.files['weights/w.bin'] = u('EVIL');
    const sb = await st.saveAsset(bad1); check('儲存前核對：sha256 不符拒絕', !sb.ok && /sha256/.test(sb.error) && !fs.existsSync(path.join(root, 'lora', 'tampered')));
    // fap 上的檔被外部竄改 → 載入時 verify 不通過
    fs.writeFileSync(path.join(root, 'lora', 'my-lora', 'data', 'a.jsonl'), 'tampered'); await memory.delete('lora/my-lora/data/a.jsonl');
    const ld2 = await st.loadAsset('lora', 'my-lora'); check('fap 檔被改：載入回報 verify 不通過', ld2.verify.ok === false && ld2.verify.mismatched[0] === 'data/a.jsonl');
    // replace 會清掉舊檔
    const a2 = mkAsset('my-lora'); delete a2.files['weights/w.bin']; a2.manifest = A.createManifest({ kind: 'lora', name: 'my-lora', files: a2.files, compat: CP });
    await st.saveAsset(a2, { replace: true }); check('replace：舊檔從兩處清掉', !fs.existsSync(path.join(root, 'lora', 'my-lora', 'weights', 'w.bin')) && (await memory.list('lora/my-lora/weights/')).length === 0);
    // 沒權限
    const denied = { ...fap, permission: async () => 'prompt' };
    const st2 = S.createStorage({ memory: S.createMemoryStore(), fap: Object.assign(Object.create(fap), { permission: async () => 'prompt' }) });
    const rd = await st2.write('lora/y/f', u('1')); check('fap 沒授權（需要手勢）：只寫記憶體並標示', rd.fap === false && rd.dataMayBeLost && rd.reason === 'permission-prompt' && /手勢/.test(rd.warning), rd);
    check('沒授權時 fap 沒被寫', !fs.existsSync(path.join(root, 'lora', 'y')));
    // fap 寫入失敗（例如磁碟滿）
    const failing = Object.assign(Object.create(fap), { put: async () => { throw new Error('ENOSPC'); } });
    const st3 = S.createStorage({ memory: S.createMemoryStore(), fap: failing }); const rf = await st3.write('lora/z/f', u('1'));
    check('fap 寫入失敗：退回記憶體並標示遺失風險與原因', rf.memory && !rf.fap && rf.dataMayBeLost && rf.reason === 'fap-write-failed' && /ENOSPC/.test(rf.fapError), rf);
    // 讀取退路：fap 讀失敗就用記憶體
    const st4 = S.createStorage({ memory: S.createMemoryStore(), fap: Object.assign(Object.create(fap), { get: async () => { throw new Error('boom'); } }) });
    await st4.write('lora/q/f', u('ok')); check('fap 讀取失敗退回記憶體', eq(await st4.read('lora/q/f'), u('ok')));
    // 名稱／kind 驗證
    let e1 = ''; try { await st.loadManifest('lora', '../x'); } catch (e) { e1 = e.message; } check('資產名稱含 .. 拒絕', /名稱/.test(e1));
    let e2 = ''; try { await st.loadManifest('nope', 'x'); } catch (e) { e2 = e.message; } check('kind 不合法拒絕', /kind/.test(e2));
    // 刪除
    const dl = await st.deleteAsset('lora', 'my-lora'); check('刪除資產：兩處都清', dl.ok && !fs.existsSync(path.join(root, 'lora', 'my-lora', 'manifest.json')) && (await st.listAssets()).length === 0);
    // 注入分塊記憶體：資產大檔也能存
    const chunked = S.createChunkedStore(S.createMemoryStore(), { chunkBytes: 512 }); const st5 = S.createStorage({ memory: chunked });
    const bigA = mkAsset('big', new Uint8Array(5000).fill(9)); await st5.saveAsset(bigA); const ld5 = await st5.loadAsset('lora', 'big');
    check('記憶體層用分塊 store 存放大檔資產', ld5.verify.ok && ld5.asset.files['weights/w.bin'].length === 5000);
    fs.rmSync(tmp, { recursive: true, force: true });
    console.log(ok + ' passed, ' + bad + ' failed'); process.exit(bad ? 1 : 0);
})().catch((e) => { console.log('FAIL 例外 ' + (e && e.stack || e)); process.exit(1); });
