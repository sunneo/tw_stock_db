#!/usr/bin/env node
// 工具目錄「快照」：主程式建構子呼叫 _registerBuiltinAiTools() 時登記的內建工具（名稱＋參數結構）。
// 訓練端（pack_adapter.js）與主程式（floating-assistant.js 的 _toolCatalogSha256）都對「同一份快照」呼叫
// lora_registry_core.js 的 toolCatalogHash（同一個正規化函式）。快照由這支腳本從原始碼產生，存在 data/app_snapshot_tools.json。
//
// 產生方式：vm 執行 floating-assistant.js 裡 _registerBuiltinAiTools 的方法本體。工具登記表是真的；
// 其他 this 成員是 no-op 代理，所以登記時「依執行期狀態分支」的地方只走替身的分支（這是已知的近似，見 DESIGN §29）。
//
// 用法：
//   node lora-train/tool_snapshot.js            # 只印出數量
//   node lora-train/tool_snapshot.js --write    # 寫入 lora-train/data/app_snapshot_tools.json（原始碼改了工具後要重寫）
const fs = require('fs'), path = require('path'), vm = require('vm');
const APP_FILE = path.join(__dirname, '..', 'renderer', 'src', 'floating-assistant.js');
const SNAPSHOT_FILE = path.join(__dirname, 'data', 'app_snapshot_tools.json');
const REGISTER_METHOD = '_registerBuiltinAiTools';

// 抽出類別內的一個方法（4 格縮排的成員宣告；收尾是獨占一行的 4 格「}」）
function methodSource(src, name) {
    const re = new RegExp('\\n    (async )?' + name + '\\(');
    const m = re.exec(src); if (!m) throw new Error('找不到方法 ' + name);
    const endAt = src.indexOf('\n    }\n', m.index + 1);
    if (endAt < 0) throw new Error('找不到 ' + name + ' 的收尾');
    return src.slice(m.index + 1, endAt + 6);
}

// 執行 _registerBuiltinAiTools，回傳 [{name, parameters}]（登記順序；沒有參數結構的工具為 null）
function snapshotFromSource(src) {
    const tools = {};
    const noop = () => new Proxy(function () {}, { get: (t, k) => (k === Symbol.toPrimitive ? () => '' : k === 'length' ? 0 : noop()), apply: () => noop(), construct: () => noop() });
    const self = new Proxy({ tools, register_openai_tool(name, desc, cb, schema) { tools[name] = { description: desc, callback: cb, parametersSchema: schema }; } }, {
        get: (t, k) => (k in t ? t[k] : noop()),
        set: (t, k, v) => { t[k] = v; return true; },
    });
    const ctx = { console: { log() {}, warn() {}, error() {} }, Promise, JSON, Set, Map, Math, Date, String, Number, Array, Object, TextEncoder, URL, setTimeout: () => 0, clearTimeout() {} };
    ctx.BROWSER_SEARCH_SOURCES = ['wiki', 'stackoverflow', 'github', 'google', 'news', 'sourceforge', 'codeproject', 'deepwiki']; // 模組常數（登記時只用於描述字串）
    vm.createContext(ctx);
    const obj = vm.runInContext('({' + methodSource(src, REGISTER_METHOD) + '})', ctx);
    for (let k = 0; k < 40; k++) {
        try { obj[REGISTER_METHOD].call(self); break; }
        catch (e) {
            const mm = e && e.name === 'ReferenceError' && /(\w+) is not defined/.exec(e.message);
            if (!mm) throw e;
            ctx[mm[1]] = noop(); // 其他模組常數：給替身，描述字串不進雜湊
        }
    }
    return Object.keys(tools).map((n) => ({ name: n, parameters: tools[n].parametersSchema == null ? null : tools[n].parametersSchema }));
}

module.exports = { APP_FILE, SNAPSHOT_FILE, REGISTER_METHOD, methodSource, snapshotFromSource };

if (require.main === module) {
    const tools = snapshotFromSource(fs.readFileSync(APP_FILE, 'utf8'));
    if (process.argv.includes('--write')) {
        fs.writeFileSync(SNAPSHOT_FILE, JSON.stringify({ source: 'renderer/src/floating-assistant.js', method: REGISTER_METHOD, count: tools.length, tools }, null, 1) + '\n');
        console.log('wrote ' + SNAPSHOT_FILE + ' (' + tools.length + ' tools)');
    } else console.log(JSON.stringify({ count: tools.length }));
}
