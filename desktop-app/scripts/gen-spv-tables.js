// node scripts/gen-spv-tables.js <SPIRV-Headers 的 include/spirv/unified1 目錄> — 從 Khronos SPIRV-Headers 的 JSON 文法產生 renderer/src/gpu/spv_tables.js
// （核心指令的編號與運算元種類、列舉值、OpenCL.std 擴充指令的編號）。產生的檔案是資料，不手改；SPIR-V 版本升級時重新產生。
const fs = require('fs'), path = require('path');
const dir = process.argv[2]; if (!dir) { console.error('用法：node scripts/gen-spv-tables.js <unified1 目錄>'); process.exit(2); }
const core = JSON.parse(fs.readFileSync(path.join(dir, 'spirv.core.grammar.json'), 'utf8')), ocl = JSON.parse(fs.readFileSync(path.join(dir, 'extinst.opencl.std.100.grammar.json'), 'utf8'));
const kinds = (ops) => (ops || []).map((o) => o.kind + (o.quantifier || ''));
const ops = {}; for (const i of core.instructions) ops[i.opname.replace(/^Op/, 'Op')] = [i.opcode, kinds(i.operands)];
const enums = {};
for (const k of core.operand_kinds) {
    if (k.category !== 'ValueEnum' && k.category !== 'BitEnum') continue;
    const e = {}; if (k.category === 'BitEnum') e.__bit = 1;
    for (const v of k.enumerants) { const val = typeof v.value === 'string' ? parseInt(v.value, 16) : v.value; const ps = kinds(v.parameters); e[v.enumerant] = ps.length ? [val, ps] : val; }
    enums[k.kind] = e;
}
const oclOps = {}; for (const i of ocl.instructions) oclOps[i.opname] = [i.opcode, kinds(i.operands)];
const out = '// 由 scripts/gen-spv-tables.js 從 Khronos SPIRV-Headers（unified1，SPIR-V ' + core.major_version + '.' + core.minor_version + ' rev ' + core.revision + '）產生；是資料，不要手改。\n' +
    '(function (root, factory) {\n    if (typeof module === \'object\' && module.exports) module.exports = factory();\n    else root.FaSpvTables = factory();\n})(typeof self !== \'undefined\' ? self : this, function () {\n    \'use strict\';\n' +
    '    return ' + JSON.stringify({ version: [core.major_version, core.minor_version], magic: parseInt(core.magic_number, 16), ops, enums, oclOps }) + ';\n});\n';
fs.writeFileSync(path.join(__dirname, '..', 'renderer', 'src', 'gpu', 'spv_tables.js'), out);
console.log('寫出 spv_tables.js：' + Object.keys(ops).length + ' 個指令、' + Object.keys(enums).length + ' 種列舉、' + Object.keys(oclOps).length + ' 個 OpenCL.std 指令，' + out.length + ' 位元組');
