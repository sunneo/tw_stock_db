// node lora-train/tool_catalog_compare.js <floating-assistant.js> <real_tools_all.json> <lora_registry_core.js>
// 離線比對「app 內建工具登記（vm 執行 _registerBuiltinAiTools 本體，工具替身＝no-op）」與「訓練端 real_tools_all.json」的 shape-v1 雜湊。
// 只是模擬：不含建構子其他登記、不含條件式模組（例如 computer_*），用來看兩邊的集合與形狀差在哪；不代表主程式執行時的真實值。
// 比對：app 的內建工具（_registerBuiltinAiTools 實際登記的名稱＋schema，以 vm 執行真的方法本體）
//       與訓練端 real_tools_all.json；兩邊都用同一個 shape-v1 函式（lora_registry_core.js）算雜湊。
const fs = require('fs'), path = require('path'), vm = require('vm'), crypto = require('crypto');
const APP = process.argv[2], LT = process.argv[3], REG = process.argv[4];
const SRC = fs.readFileSync(APP, 'utf8');
const Reg = require(REG);
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
function methodSource(name) {
    // 類別成員的收尾是獨占一行的 4 格「}」；方法本體到那一行為止（不逐字解析字串／正規表示式）
    const re = new RegExp('\\n    (async )?' + name + '\\(');
    const m = re.exec(SRC); if (!m) throw new Error('找不到方法 ' + name);
    const endAt = SRC.indexOf('\n    }\n', m.index + 1);
    if (endAt < 0) throw new Error('找不到 ' + name + ' 的收尾');
    return SRC.slice(m.index + 1, endAt + 6);
}
// 假的 this：tools 是真的登記表；其餘方法一律回傳 no-op 代理，讓登記時的條件判斷走預設分支
const tools = {};
function noop() { return new Proxy(function () {}, { get: (t, k) => (k === Symbol.toPrimitive ? () => '' : (k === 'length' ? 0 : noop())), apply: () => noop(), construct: () => noop() }); }
const self = new Proxy({ tools, register_openai_tool(name, desc, cb, schema) { tools[name] = { name, description: desc, parametersSchema: schema }; } }, {
    get: (t, k) => (k in t ? t[k] : noop()),
    set: (t, k, v) => { t[k] = v; return true; },
});
const ctx = { console: { log() {}, warn() {}, error() {} }, Promise, JSON, Set, Map, Math, Date, String, Number, Array, Object, TextEncoder, URL, setTimeout: () => 0, clearTimeout() {} };
vm.createContext(ctx);
const obj = vm.runInContext('({' + methodSource('_registerBuiltinAiTools') + '})', ctx);
ctx.BROWSER_SEARCH_SOURCES = ['wiki', 'stackoverflow', 'github', 'google', 'news', 'sourceforge', 'codeproject', 'deepwiki'];
for (let k = 0; k < 40; k++) {
    try { obj._registerBuiltinAiTools.call(self); break; }
    catch (e) {
        const mm = e && e.name === 'ReferenceError' && /(\w+) is not defined/.exec(e.message);
        if (!mm) throw e;
        ctx[mm[1]] = noop(); // 登記時用不到的模組常數：給替身，描述字串不進雜湊
    }
}
const appNames = Object.keys(tools);
const appShape = Reg.toolCatalogShapeText(appNames.map((n) => ({ name: n, parameters: tools[n].parametersSchema })));
// 訓練端：與 pack_adapter.js 相同的算法
const train = JSON.parse(fs.readFileSync(LT, 'utf8')).tools;
const trainShape = Reg.toolCatalogShapeText(train);
const tn = new Set(train.map((t) => t.name)), an = new Set(appNames);
const onlyTrain = [...tn].filter((n) => !an.has(n)), onlyApp = [...an].filter((n) => !tn.has(n));
// 同名但形狀不同（參數結構）
const byName = (arr) => new Map(arr.map((t) => [t.name, t]));
const tmap = byName(train), amap = new Map(appNames.map((n) => [n, { name: n, parameters: tools[n].parametersSchema }]));
const shapeDiff = [...an].filter((n) => tn.has(n)).filter((n) => JSON.stringify(Reg.toolCatalogShapeText([tmap.get(n)])) !== JSON.stringify(Reg.toolCatalogShapeText([amap.get(n)])));
console.log(JSON.stringify({
    app_registered_builtin: appNames.length, trainer_inventory: train.length,
    app_sha256: sha(appShape), trainer_sha256: sha(trainShape), equal: sha(appShape) === sha(trainShape),
    only_in_trainer: onlyTrain.length, only_in_app: onlyApp.length, shape_differs_same_name: shapeDiff.length,
    only_in_trainer_sample: onlyTrain.slice(0, 12), only_in_app_sample: onlyApp.slice(0, 12), shape_diff_sample: shapeDiff.slice(0, 12),
}, null, 1));
