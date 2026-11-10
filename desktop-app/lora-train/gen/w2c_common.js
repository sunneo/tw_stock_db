'use strict';
/* gen_when2call.js / gen_natural.js / gen_colu_full.js 共用：工具清單載入、Hermes tools 格式、值合成。 */
const path = require('path');
const crypto = require('crypto');
const SRC = 'lora-train/data/real_tools_all.json';
const DATA = require(path.join(__dirname, '..', 'data', 'real_tools_all.json'));
const TOOLS = (DATA.tools || DATA).filter((t) => t.name && t.description && t.parameters);
const BY_NAME = Object.fromEntries(TOOLS.map((t) => [t.name, t]));
const TRAIN_POOL = TOOLS.filter((t) => !t.heldout);

function rng(seed) { let h = crypto.createHash('md5').update(String(seed)).digest(); let i = 0; return () => { if (i > 12) { h = crypto.createHash('md5').update(h).digest(); i = 0; } const v = h.readUInt32LE(i) / 4294967296; i += 4; return v; }; }
const pick = (rand, arr) => arr[Math.floor(rand() * arr.length)];
const shuffle = (rand, arr) => { const a = arr.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const firstSentence = (d) => String(d || '').replace(/\s+/g, ' ').split(/[。！？\n]/)[0].trim();
const firstClause = (d) => firstSentence(d).split(/[，、；:：（(]/)[0].trim();
const family = (name) => name.split('_')[0];
const groupOf = (t) => t.domain || family(t.name);

// 模型實際看到的工具格式：描述截成 ≤60 字（對齊對照設計的 summarize），參數 schema 完整保留
const toolSpec = (t) => ({ type: 'function', function: { name: t.name, description: firstSentence(t.description).slice(0, 60), parameters: t.parameters } });
const toolCall = (name, args) => '<tool_call>\n' + JSON.stringify({ name, arguments: args }) + '\n</tool_call>';

const SIMPLE = (s) => s && (s.enum ? true : ['string', 'integer', 'number', 'boolean'].includes(Array.isArray(s.type) ? s.type[0] : s.type));
function requiredOf(t) { const p = t.parameters.properties || {}; const r = t.parameters.required || []; return r.filter((k) => p[k]); }
// 必填參數都是簡單型別才可程式合成；否則回報未覆蓋原因
function coverageOf(t) {
    const p = t.parameters.properties || {};
    for (const k of requiredOf(t)) if (!SIMPLE(p[k])) return { ok: false, why: 'required ' + k + ' type=' + JSON.stringify(p[k].type) };
    if (firstClause(t.description).length < 3) return { ok: false, why: 'no usable intent' };
    return { ok: true };
}

const HINT = {
    row: ['3', '5', '12'], col: ['B', 'C', '價格', '姓名'], find: ['舊版', 'TODO', 'foo'], repl: ['新版', 'DONE', 'bar'], text: ['今天開會討論預算', 'Hello world', '會議紀錄'],
    query: ['Rust borrow checker', '台北捷運路線', 'python asyncio'], url: ['https://example.com/docs', 'https://github.com'], key: ['Enter', 'Tab', 'Escape'], keys: ['ctrl+c', 'alt+tab'],
    name: ['摘要', 'Sheet2', 'Summary'], goal: ['打開首頁並截圖'], path: ['報告.txt', 'notes/todo.md'], title: ['第三季報告', 'Meeting notes'], sheet: ['Sheet1', '總表', 'Data'], id: ['b12', 'w3'], window_id: ['w1', 'w3'], element_id: ['e7', 'btn1'], host: ['192.168.1.20'],
};
const WORDS = ['蘋果', '預算表', 'report', '第三季', 'Alice', '標題A', 'done', 'v2024'];
function synthValue(key, schema, rand) {
    if (schema.enum) return pick(rand, schema.enum);
    const ty = Array.isArray(schema.type) ? schema.type[0] : schema.type;
    if (ty === 'integer') return 1 + Math.floor(rand() * 20);
    if (ty === 'number') return pick(rand, [0.5, 1.5, 2, 3.5, 10]);
    if (ty === 'boolean') return true;
    return String(pick(rand, HINT[key] || WORDS));
}
function synthArgs(t, rand) { const p = t.parameters.properties || {}; const a = {}; for (const k of requiredOf(t)) a[k] = synthValue(k, p[k], rand); return a; }
const phrase = (k, v) => (typeof v === 'string' ? k + '是「' + v + '」' : typeof v === 'boolean' ? k + '設為 ' + v : k + '是 ' + v);

// 2~8 個工具：目標＋同家族干擾＋隨機干擾（干擾只取訓練池），打亂
function toolList(target, rand, nMin, nMax) {
    const n = nMin + Math.floor(rand() * (nMax - nMin + 1));
    const fam = shuffle(rand, TRAIN_POOL.filter((x) => x.name !== target.name && family(x.name) === family(target.name)));
    const chosen = [target]; for (const x of fam.slice(0, Math.min(2, n - 1))) chosen.push(x);
    while (chosen.length < n) { const x = pick(rand, TRAIN_POOL); if (!chosen.includes(x) && x.name !== target.name) chosen.push(x); }
    return shuffle(rand, chosen);
}
const SYS = 'You are the assistant of floating-assistant. Use a tool only when one of the listed tools fits the request; give every required argument exactly as the user stated it. If a required value is missing, ask for it. For small talk answer directly. If no tool fits, or the requested tool is not in the list, say so briefly and never guess or keep searching.';
const sysMsg = () => ({ role: 'system', content: SYS });
// 對齊對照設計的列格式：task/kind/group/tool/seen
function tag(r, task, kind) { r.task = task; r.kind = kind; r.group = r.meta.group; r.tool = r.meta.tool || null; r.seen = r.meta.tool && BY_NAME[r.meta.tool] && BY_NAME[r.meta.tool].heldout ? 'unseen' : 'seen'; r.prefill = r.prefill || ''; return r; }
module.exports = { SYS, sysMsg, tag, SRC, TOOLS, BY_NAME, TRAIN_POOL, rng, pick, shuffle, firstSentence, firstClause, family, groupOf, toolSpec, toolCall, requiredOf, coverageOf, synthArgs, synthValue, phrase, toolList };
