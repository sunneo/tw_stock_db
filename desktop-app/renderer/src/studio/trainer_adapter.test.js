// node renderer/src/studio/trainer_adapter.test.js
const A = require('./asset_core.js'); const F = require('./fatrain_core.js'); const T = require('./trainer_adapter.js'); const S = require('./storage_core.js');
let ok = 0, bad = 0; const check = (n, c, x) => { if (c) ok++; else { bad++; console.log('FAIL ' + n + (x !== undefined ? ' ' + JSON.stringify(x).slice(0, 400) : '')); } };
const mkBundle = (extra) => {
    const payload = Object.assign({
        domains: [{ name: '日誌分析', source: 'user', patterns: [{ id: 1, re: '\\d+\\s*ms', source: 'taught' }], tools: [{ name: 'parseLog', source: 'return 1;' }], states: { states: { a: {} } } }, { name: '單位換算', patterns: [] }],
        solutions: [{ fp: 'abc', problem: '把 3 公尺換成英尺', calls: [{ tool: 'convert', args: { v: 3 } }], created: 1700000000000 }],
        synonyms: { 公尺: ['米', 'm'] }
    }, extra || {});
    return { format: 'fa-offline-trainer', version: 2, exported_at: '2026-11-11T01:02:03.000Z', summary: { domains: 2, patterns: 1, tools: 1 }, payload, checksum: T.bundleHash(JSON.stringify(payload)) };
};
(async () => {
    const b = mkBundle({ turns: [{ at: 1, text: '你好' }], knowledge: { types: [], typed: [] } });
    const conv = T.bundleToAsset(b, { name: 'trainer-main' });
    check('bundle → 資產：kind=trainer、檔案配置', conv.ok && conv.asset.manifest.kind === 'trainer' && ['weights/domains.json', 'weights/knowledge.json', 'data/solutions.json', 'data/synonyms.json', 'data/turns.json'].every((p) => conv.asset.files[p]), conv);
    check('資產 manifest 合法、counts 正確', A.validateManifest(conv.asset.manifest).ok && conv.asset.manifest.counts.domains === 2 && conv.asset.manifest.counts.solutions === 1 && conv.asset.manifest.counts.turns === 1);
    const back = T.assetToBundle(conv.asset);
    check('資產 → bundle：payload 逐位元一致', back.ok && JSON.stringify(back.bundle.payload) === JSON.stringify(b.payload), back);
    check('往返後 checksum、版本、時間、摘要一致', back.bundle.checksum === b.checksum && back.bundle.version === 2 && back.bundle.exported_at === b.exported_at && JSON.stringify(back.bundle.summary) === JSON.stringify(b.summary));
    check('往返後整個 bundle 的 sha256 一致', A.sha256Hex(JSON.stringify(back.bundle)) === A.sha256Hex(JSON.stringify(b)));

    // 經 .fatrain 容器（含分片）再往返
    const ex = F.exportAsset(conv.asset, { shardBytes: 64 }); check('.fatrain 匯出（強制分片）', ex.ok && ex.sharded.length > 0, ex);
    const rd = F.readAsset(ex.bytes); check('.fatrain 讀回', rd.ok);
    const back2 = T.assetToBundle(rd.asset);
    check('bundle → 資產 → .fatrain → 資產 → bundle：sha256 一致', back2.ok && A.sha256Hex(JSON.stringify(back2.bundle)) === A.sha256Hex(JSON.stringify(b)), back2);

    // 經儲存層（記憶體＋分塊）再往返
    const st = S.createStorage({ memory: S.createChunkedStore(S.createMemoryStore(), { chunkBytes: 100 }) });
    await st.saveAsset(conv.asset); const ld = await st.loadAsset('trainer', 'trainer-main'); const back3 = T.assetToBundle(ld.asset);
    check('經儲存層往返 sha256 一致', back3.ok && A.sha256Hex(JSON.stringify(back3.bundle)) === A.sha256Hex(JSON.stringify(b)));

    // 沒有選填欄位的 bundle、含未知欄位的 bundle
    const b2 = mkBundle(); const c2 = T.bundleToAsset(b2); const r2 = T.assetToBundle(c2.asset);
    check('沒有 turns／knowledge 也能往返（不憑空多欄位）', r2.ok && !('turns' in r2.bundle.payload) && !('knowledge' in r2.bundle.payload) && A.sha256Hex(JSON.stringify(r2.bundle)) === A.sha256Hex(JSON.stringify(b2)));
    const b3 = mkBundle({ future_field: { a: [1, 2] } }); const c3 = T.bundleToAsset(b3);
    check('未知 payload 欄位保留並警告', c3.ok && c3.warnings.length === 1 && A.sha256Hex(JSON.stringify(T.assetToBundle(c3.asset).bundle)) === A.sha256Hex(JSON.stringify(b3)));

    // 負向
    check('拒絕：不是 trainer bundle', !T.bundleToAsset({ format: 'x' }).ok);
    check('拒絕：v1 舊格式（沒有 payload）並說明', /v1|舊版/.test(T.bundleToAsset({ format: 'fa-offline-trainer', version: 1, domains: [] }).error));
    check('拒絕：版本比支援的新', /新/.test(T.bundleToAsset(Object.assign(mkBundle(), { version: 3 })).error));
    const tb = mkBundle(); tb.payload.synonyms['公尺'] = ['被改過'];
    check('拒絕：bundle 內容被改（checksum 不符）', /checksum/.test(T.bundleToAsset(tb).error));
    const tampered = { manifest: conv.asset.manifest, files: Object.assign({}, conv.asset.files, { 'data/synonyms.json': new TextEncoder().encode('{"公尺":["x"]}') }) };
    check('拒絕：資產檔被改（sha256）不轉回 bundle', /sha256/.test(T.assetToBundle(tampered).error));
    check('拒絕：kind 不是 trainer', /trainer/.test(T.assetToBundle({ manifest: { kind: 'lora' }, files: {} }).error));
    check('拒絕：不是由 bundle 轉來的 trainer 資產', /extra\.bundle/.test(T.assetToBundle({ manifest: Object.assign({}, conv.asset.manifest, { extra: undefined }), files: conv.asset.files }).error));
    check('bundleHash 與 app 的 _faRepoHash 同演算法（djb2，36 進位:長度）', T.bundleHash('abc') === ((((5381 * 33 + 97) * 33 + 98) * 33 + 99) >>> 0).toString(36) + ':3');
    console.log(ok + ' passed, ' + bad + ' failed'); process.exit(bad ? 1 : 0);
})().catch((e) => { console.log('FAIL 例外 ' + (e && e.stack || e)); process.exit(1); });
