// 行為分析的資料合併（embed-code-ui.js 與 renderer/src/behavior/tests 共用）：
//   behavior_patterns.json（Domain Resolver 匯入的原檔）＋ api_semantics.json
//   ＋ names_*.json（依檔名排序疊上去：C++／Rust／Go、Python／Java／JavaScript 補強、C#／Ruby／Lua；scripts/gen-name-tables*.py 產生）
"use strict";
const fs = require("fs"), path = require("path");

function load(root) {
  const dir = path.join(root, "renderer/src/behavior");
  const data = { patterns: JSON.parse(fs.readFileSync(path.join(dir, "behavior_patterns.json"), "utf8")), api: JSON.parse(fs.readFileSync(path.join(dir, "api_semantics.json"), "utf8")) };
  const P = data.patterns;
  for (const f of fs.readdirSync(dir).filter((n) => /^names_.*\.json$/.test(n)).sort()) {
    const ext = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
    for (const [cid, c] of Object.entries(ext.categories || {})) {
      const t0 = P.categories[cid] = P.categories[cid] || { label: c.label || cid, description: c.description || "", languages: {} };
      t0.languages = t0.languages || {};
      for (const [l, names] of Object.entries(c.languages || {})) t0.languages[l] = Array.from(new Set((t0.languages[l] || []).concat(names)));
    }
    for (const [l, fns] of Object.entries(ext.api || {})) data.api[l] = Object.assign(data.api[l] || {}, fns);
    for (const [l, cf] of Object.entries(ext.control_flow_nodes || {})) P.control_flow_nodes[l] = cf;
    for (const [sn, per] of Object.entries(ext.structural_signals || {})) { P.structural_signals[sn] = P.structural_signals[sn] || {}; Object.assign(P.structural_signals[sn], per); }
  }
  return data;
}
module.exports = { load };
