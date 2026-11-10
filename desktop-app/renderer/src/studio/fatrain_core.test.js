// node renderer/src/studio/fatrain_core.test.js
const A = require('./asset_core.js'); const F = require('./fatrain_core.js'); const S = require('./storage_core.js'); const zlib = require('zlib'); const cp = require('child_process'); const fs = require('fs'); const os = require('os'); const path = require('path');
let ok = 0, bad = 0; const check = (n, c, x) => { if (c) ok++; else { bad++; console.log('FAIL ' + n + (x !== undefined ? ' ' + JSON.stringify(x).slice(0, 400) : '')); } };
const u = (s) => new TextEncoder().encode(s);
const throws = (f, re) => { try { f(); return false; } catch (e) { return re ? re.test(e.message) : true; } };
(async () => {
    const CP = { base: 'Qwen3-0.6B', rank: 8, alpha: 16, prompt_format_version: 3, tool_catalog_sha256: 'x'.repeat(64) };
    const big = new Uint8Array(5000); for (let i = 0; i < big.length; i++) big[i] = (i * 7 + (i >> 5)) & 255;
    const mkAsset = (name, extra) => { const files = Object.assign({ 'data/a.jsonl': u('{"x":1}\n{"x":2}\n'), 'weights/adapter.safetensors': big, 'log.jsonl': u('') }, extra || {}); return { manifest: A.createManifest({ kind: 'lora', name, files, base: 'Qwen3-0.6B', compat: CP, counts: { examples: 2 } }), files }; };

    // crc32 與 zip 往返
    check('crc32 已知值', F.crc32(u('123456789')) === 0xcbf43926);
    const z = F.writeZip([{ name: 'a.txt', data: u('hello') }, { name: 'd/b.bin', data: big }]);
    const back = F.readZip(z); check('zip 存放式往返', back.length === 2 && Buffer.from(back[0].data).toString() === 'hello' && Buffer.compare(Buffer.from(back[1].data), Buffer.from(big)) === 0);
    const zd = F.writeZip([{ name: 'big.bin', data: big }], { deflateRaw: zlib.deflateRawSync });
    check('壓縮項目：沒給解壓函式要明確說', throws(() => F.readZip(zd), /inflateRaw/) && zd.length < big.length + 100);
    check('壓縮項目：注入解壓函式可讀', Buffer.compare(Buffer.from(F.readZip(zd, { inflateRaw: zlib.inflateRawSync })[0].data), Buffer.from(big)) === 0);
    check('zip：截斷拒絕', throws(() => F.readZip(z.subarray(0, z.length - 30)), /結尾|截斷|損毀|超出/));
    check('zip：項目被竄改 crc 拒絕', (() => { const c = z.slice(); c[40] ^= 1; return throws(() => F.readZip(c), /crc|損毀|大小/); })());
    check('zip：路徑跳脫（zip slip）拒絕寫入', throws(() => F.writeZip([{ name: '../x', data: u('1') }]), /不合法/));
    check('zip：讀到含 .. 的項目拒絕', (() => { const t = F.writeZip([{ name: 'a/bbb', data: u('1') }]); const s = Buffer.from(t); let i = s.indexOf('a/bbb'); while (i >= 0) { s.write('../bb', i); i = s.indexOf('a/bbb', i + 1); } return throws(() => F.readZip(new Uint8Array(s)), /不安全/); })());
    check('zip：太小不是 zip', throws(() => F.readZip(u('abc')), /太小/));
    // 與系統 zip 工具互通（Node 沒有內建 zip 讀取，用 python 的標準 zipfile 驗證寫出的容器；沒 python 就略過這一項）
    try {
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fatrain-')); const f = path.join(tmp, 't.zip'); fs.writeFileSync(f, z);
        const r = cp.spawnSync('python', ['-c', 'import zipfile,sys;z=zipfile.ZipFile(sys.argv[1]);print(z.testzip(),sorted(z.namelist()))', f], { encoding: 'utf8', windowsHide: true });
        if (r.status === 0) check('標準 zipfile 能讀我們寫的 zip', /None \['a.txt', 'd\/b.bin'\]/.test(r.stdout), r.stdout); fs.rmSync(tmp, { recursive: true, force: true });
    } catch (_) { /* 沒有 python 就略過 */ }

    // 匯出／inspect／匯入往返
    const asset = mkAsset('lora-a');
    const ex = F.exportAsset(asset); check('匯出成功', ex.ok && ex.name === 'lora-a.fatrain' && ex.sharded.length === 0, ex);
    const ins = F.inspect(ex.bytes); check('inspect：摘要', ins.ok && ins.summary.kind === 'lora' && ins.summary.files === 3 && ins.summary.counts.examples === 2 && ins.summary.base === 'Qwen3-0.6B' && !ins.asset, ins);
    const rd = F.readAsset(ex.bytes); check('讀回的檔案 sha256 一致', rd.ok && Object.keys(rd.asset.files).every((p) => A.sha256Hex(rd.asset.files[p]) === asset.manifest.sha256[p]));

    // 分片：shardBytes=1500 讓 5000 位元組的檔切 4 片
    const sh = F.exportAsset(asset, { shardBytes: 1500 }); check('分片：大檔被切開', sh.ok && sh.sharded[0] === 'weights/adapter.safetensors', sh);
    const shEntries = F.readZip(sh.bytes); check('分片：每片 ≤ 上限', shEntries.filter((e) => /\.part\d{4}$/.test(e.name)).length === 4 && shEntries.every((e) => e.data.length <= 1500 || e.name === 'manifest.json'));
    const shR = F.readAsset(sh.bytes); check('分片：讀回自動合併、sha256 一致', shR.ok && Buffer.compare(Buffer.from(shR.asset.files['weights/adapter.safetensors']), Buffer.from(big)) === 0 && !shR.asset.manifest.shards);
    check('分片：預設上限是 20MB', F.SHARD_BYTES === 20 * 1048576);
    check('分片：缺一片拒絕並指出', (() => { const es = F.readZip(sh.bytes).filter((e) => !/part0002$/.test(e.name)); const r = F.readAsset(F.writeZip(es)); return !r.ok && /part0002/.test(r.errors.join()); })());
    check('分片：某片被竄改拒絕（sha256）', (() => { const es = F.readZip(sh.bytes); es.find((e) => /part0001$/.test(e.name)).data[3] ^= 1; const r = F.readAsset(F.writeZip(es)); return !r.ok && /sha256/.test(r.errors.join()); })());

    // 竄改拒絕
    check('竄改：檔案內容被改（zip 重新封裝，crc 正確）→ sha256 拒絕', (() => { const es = F.readZip(ex.bytes); es.find((e) => e.name === 'data/a.jsonl').data[2] ^= 1; const r = F.readAsset(F.writeZip(es)); return !r.ok && /sha256/.test(r.errors.join()) && r.verify.mismatched[0] === 'data/a.jsonl'; })());
    check('竄改：多塞一個檔拒絕', (() => { const es = F.readZip(ex.bytes); es.push({ name: 'evil.js', data: u('x') }); const r = F.readAsset(F.writeZip(es)); return !r.ok && /多出/.test(r.errors.join()); })());
    check('竄改：缺 manifest', /manifest/.test(F.readAsset(F.writeZip([{ name: 'a', data: u('1') }])).errors[0]));
    check('竄改：manifest 不是 JSON', /JSON/.test(F.readAsset(F.writeZip([{ name: 'manifest.json', data: u('{oops') }])).errors[0]));
    check('匯出前核對：記憶體裡的檔案已被改過就不匯出', (() => { const a = mkAsset('x1'); a.files['data/a.jsonl'] = u('changed'); const r = F.exportAsset(a); return !r.ok && /sha256/.test(r.error); })());

    // 舊版 manifest 在容器裡升級
    check('舊版 v1 容器：匯入時升級並提示', (() => {
        const files = { 'data/a.jsonl': u('{"x":1}\n') }; const old = { format: 'fa-training-asset', version: 1, kind: 'lora', name: 'oldy', base: 'Qwen3-0.6B', rank: 8, hashes: A.hashFiles(files) };
        const r = F.readAsset(F.writeZip([{ name: 'manifest.json', data: u(JSON.stringify(old)) }, { name: 'data/a.jsonl', data: files['data/a.jsonl'] }]));
        return r.ok && r.migratedFrom === 1 && r.manifest.version === A.VERSION && r.manifest.compat.rank === 8 && /升級/.test(r.warnings.join());
    })());

    // 匯入：先 inspect 確認，才寫入
    const st = S.createStorage({ memory: S.createMemoryStore() });
    const p1 = await F.importAsset(ex.bytes, { storage: st });
    check('匯入：未確認只回摘要，不寫入', p1.ok && p1.needsConfirm && p1.plan.action === 'create' && (await st.list('')).length === 0, p1);
    const p2 = await F.importAsset(ex.bytes, { storage: st, confirmed: true });
    check('匯入：確認後寫入（沒 fap → 提示資料可能遺失）', p2.ok && p2.dataMayBeLost === true && (await st.listAssets()).length === 1, p2);
    const ld = await st.loadAsset('lora', 'lora-a'); check('匯入後讀回 sha256 一致', ld.verify.ok && Object.keys(asset.files).every((p) => Buffer.compare(Buffer.from(ld.asset.files[p]), Buffer.from(asset.files[p])) === 0));
    // 同名且相容 → 合併
    const more = mkAsset('lora-a', { 'data/b.jsonl': u('{"y":1}\n') });
    const exM = F.exportAsset(more); const pm = await F.importAsset(exM.bytes, { storage: st });
    check('匯入：同名且相容 → 計畫是合併', pm.needsConfirm && pm.plan.action === 'merge', pm);
    const pm2 = await F.importAsset(exM.bytes, { storage: st, confirmed: true }); const merged = await st.loadAsset('lora', 'lora-a');
    check('匯入：合併後兩個資料檔都在、manifest 驗證通過', pm2.ok && merged.verify.ok && !!merged.asset.files['data/b.jsonl'] && !!merged.asset.files['data/a.jsonl'] && A.validateManifest(merged.asset.manifest).ok, pm2);
    // 同名但 base 不同 → 拒絕並建議 fork
    const other = (() => { const files = { 'data/a.jsonl': u('z'), 'weights/w.bin': u('1') }; return { manifest: A.createManifest({ kind: 'lora', name: 'lora-a', files, compat: Object.assign({}, CP, { base: 'Llama-3' }) }), files }; })();
    const rj = await F.importAsset(F.exportAsset(other).bytes, { storage: st, confirmed: true });
    check('匯入：base 不同 → 拒絕並建議 fork、不改動原資料', !rj.ok && rj.rejected && rj.suggest === 'fork' && /基底模型/.test(rj.error) && rj.reasons[0].field === 'base', rj);
    const unchanged = await st.loadAsset('lora', 'lora-a'); check('拒絕後原資產沒被動到', unchanged.asset.manifest.compat.base === 'Qwen3-0.6B' && unchanged.verify.ok);
    const rjR = await F.importAsset(F.exportAsset(other).bytes, { storage: st, mode: 'fork', forkName: 'lora-a-llama', confirmed: true });
    const fkd = await st.loadManifest('lora', 'lora-a-llama'); check('匯入：fork 另存，parent 記來源', rjR.ok && fkd && fkd.parent.name === 'lora-a' && fkd.compat.base === 'Llama-3', rjR);
    check('匯入：fork 名稱已存在 → 要求換名', !(await F.importAsset(F.exportAsset(other).bytes, { storage: st, mode: 'fork', forkName: 'lora-a-llama', confirmed: true })).ok);
    const rp = await F.importAsset(F.exportAsset(other).bytes, { storage: st, mode: 'replace', confirmed: true });
    check('匯入：replace 整個取代（舊檔被清掉）', rp.ok && (await st.list('lora/lora-a/')).filter((k) => /adapter|b\.jsonl/.test(k)).length === 0 && (await st.loadManifest('lora', 'lora-a')).compat.base === 'Llama-3');
    check('匯入：壞檔回具體錯誤', /截斷|結尾|太小/.test((await F.importAsset(ex.bytes.subarray(0, 100), { storage: st, confirmed: true })).error));
    check('匯入：竄改過的檔在確認前就拒絕', !(await F.importAsset((() => { const es = F.readZip(ex.bytes); es[1].data[0] ^= 1; return F.writeZip(es); })(), { storage: st })).ok);

    // 分卷
    const vol = F.splitVolumes(ex.bytes, 'lora-a.fatrain', 2000);
    check('分卷：每卷 ≤ 上限、命名 .001', vol.length === Math.ceil(ex.bytes.length / 2000) && vol[0].name === 'lora-a.fatrain.001' && vol.every((v) => v.bytes.length <= 2000));
    check('分卷：合併後逐位元相同（亂序也行）', Buffer.compare(Buffer.from(F.joinVolumes(vol.slice().reverse())), Buffer.from(ex.bytes)) === 0);
    check('分卷：缺一卷拒絕', throws(() => F.joinVolumes([vol[0], vol[2]]), /缺少第 002/));
    console.log(ok + ' passed, ' + bad + ' failed'); process.exit(bad ? 1 : 0);
})().catch((e) => { console.log('FAIL 例外 ' + (e && e.stack || e)); process.exit(1); });
