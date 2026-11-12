// node renderer/src/studio/tool_catalog_equal.test.js
// 斷言：主程式的工具清單雜湊（floating-assistant.js 的 _toolCatalogSha256，vm 執行真的方法本體）
// 與訓練端的工具清單雜湊（pack_adapter.js 用的 lora_registry_core.toolCatalogHash＋data/app_snapshot_tools.json）
// 對同一份輸入算出的值相等。兩邊用同一個正規化函式（toolCatalogShapeText）與同一份快照。
// 限制：主程式的執行期分支（依設定、登入狀態而定）在這裡以替身走預設分支，見 lora-train/tool_snapshot.js 與 DESIGN §29。
const fs = require('fs'), path = require('path'), vm = require('vm'), crypto = require('crypto');
const R = require('./lora_registry_core.js');
const Asset = require('./asset_core.js');
const TS = require('../../../lora-train/tool_snapshot.js');
const SRC = fs.readFileSync(TS.APP_FILE, 'utf8');
const SNAP = JSON.parse(fs.readFileSync(TS.SNAPSHOT_FILE, 'utf8'));
let ok = 0, bad = 0; const check = (n, c, x) => { if (c) ok++; else { bad++; console.log('FAIL ' + n + (x === undefined ? '' : ' ' + JSON.stringify(x).slice(0, 240))); } };

(async () => {
    // 0) 快照檔與原始碼一致（原始碼改了工具而沒重寫快照，這裡就會失敗；重寫：node lora-train/tool_snapshot.js --write）
    const fresh = TS.snapshotFromSource(SRC);
    check('快照檔與 floating-assistant.js 目前的登記一致', JSON.stringify(fresh) === JSON.stringify(SNAP.tools), { fresh: fresh.length, snap: SNAP.tools.length });
    check('快照非空', SNAP.tools.length > 0);

    // 1) 主程式側：真的 _toolCatalogSha256 方法本體，this＝快照登記出來的工具表（與 register_openai_tool 的儲存格式相同）
    const tools = {};
    for (const t of SNAP.tools) tools[t.name] = { description: '', callback: () => {}, parametersSchema: t.parameters == null ? undefined : t.parameters };
    const ctx = { FaStudio: { FaLoraRegistry: R, FaStudioAsset: Asset }, TextEncoder, Promise, Array, Set, Map, Object, JSON };
    vm.createContext(ctx);
    const M = vm.runInContext('({' + TS.methodSource(SRC, '_toolCatalogSha256') + '})', ctx);
    const self = { _builtinToolNameSnapshot: new Set(SNAP.tools.map((t) => t.name)), tools };
    const hApp = await M._toolCatalogSha256.call(self);

    // 2) 訓練端：pack_adapter.js 的算法（node crypto）對同一份快照檔
    const shaBytes = (u8) => crypto.createHash('sha256').update(u8).digest('hex');
    const hTrain = R.toolCatalogHash(JSON.parse(fs.readFileSync(TS.SNAPSHOT_FILE, 'utf8')).tools, shaBytes);

    check('主程式與訓練端的工具清單雜湊相等', hApp === hTrain, { hApp, hTrain });
    check('雜湊是 64 位元十六進位', typeof hApp === 'string' && /^[0-9a-f]{64}$/.test(hApp));
    check('主程式的 sha256Hex 與 node crypto 算出相同結果（同一份位元組）', Asset.sha256Hex(new TextEncoder().encode(R.toolCatalogShapeText(SNAP.tools))) === shaBytes(Buffer.from(R.toolCatalogShapeText(SNAP.tools), 'utf8')));
    check('格式名稱是 shape-v2', R.TOOL_HASH_SCHEME === 'shape-v2');

    // 3) 敏感度：少一個工具或改一個參數型別，雜湊就會變（否則這個雜湊檢不出漂移）
    const fewer = SNAP.tools.slice(1);
    check('少一個工具 → 雜湊不同', R.toolCatalogHash(fewer, shaBytes) !== hTrain);
    const mut = JSON.parse(JSON.stringify(SNAP.tools)); const pr = mut.find((t) => t.parameters && t.parameters.properties && Object.keys(t.parameters.properties).length);
    if (pr) { const k = Object.keys(pr.parameters.properties)[0]; pr.parameters.properties[k] = Object.assign({}, pr.parameters.properties[k], { type: 'integer__x' }); }
    check('改一個參數型別 → 雜湊不同', pr && R.toolCatalogHash(mut, shaBytes) !== hTrain);
    // 4) 說明文字不進雜湊（描述含平台插值，執行時與訓練端不會逐字相同）
    const described = SNAP.tools.map((t) => Object.assign({}, t, { description: '任意說明 ' + Math.random() }));
    check('說明文字不影響雜湊', R.toolCatalogHash(described, shaBytes) === hTrain);
})().then(() => { console.log(ok + ' passed, ' + bad + ' failed'); process.exit(bad ? 1 : 0); }, (e) => { console.error(e); process.exit(1); });
