const MF = require('' + require('path').resolve(__dirname, '..', '..', '..', 'renderer') + '/src/algo/matrix_forms_core.js');
const S = MF.SR.count(2); console.log('count(2)：0+1=', S.add(1, 1), ' 1*1=', S.mul(1, 1), ' zero/one=', S.zero, S.one);
const step = (st, byte) => { let s = (st ^ byte) >>> 0; for (let i = 0; i < 8; i++) s = (s & 1) ? ((s >>> 1) ^ 0xEDB88320) >>> 0 : s >>> 1; return s >>> 0; };
// 39 維仿射狀態 (crc32 位元, byte 位元) → 32 位元：用單位向量探測組出 32×40 的 GF(2) 矩陣，再用 MF.matMul 在 count(2) 半環跑
const M = Array.from({ length: 32 }, () => Array(40).fill(0));
for (let j = 0; j < 32; j++) { const v = step(1 << j >>> 0, 0); for (let i = 0; i < 32; i++) M[i][j] = (v >>> i) & 1; }
for (let j = 0; j < 8; j++) { const v = step(0, 1 << j); for (let i = 0; i < 32; i++) M[i][32 + j] = (v >>> i) & 1; }
const crcM = (bytes) => { let s = Array.from({ length: 32 }, (_, i) => [1]); for (const b of bytes) { const x = s.concat(Array.from({ length: 8 }, (_, i) => [(b >> i) & 1])); s = MF.matMul(M, x, S); } let r = 0; for (let i = 0; i < 32; i++) if (s[i][0]) r |= 1 << i; return (r ^ 0xFFFFFFFF) >>> 0; };
const out = require('child_process').execSync("python3 -c \"import zlib;print(hex(zlib.crc32(b'123456789')))\"").toString().trim();
console.log('crc32(123456789) 矩陣版＝0x' + crcM([...Buffer.from('123456789')]).toString(16), '；zlib＝', out);
