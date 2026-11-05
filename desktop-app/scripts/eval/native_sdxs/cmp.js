const fs = require('fs'), path = require('path');
const rd = (d, n) => { const b = fs.readFileSync(path.join(d, n + '.bin')); return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)); };
const stat = (a, b) => { let mx = 0, se = 0, sp = 0; for (let i = 0; i < a.length; i++) { const d = a[i] - b[i]; if (Math.abs(d) > mx) mx = Math.abs(d); se += d * d; sp += b[i] * b[i]; } return { max_abs: +mx.toExponential(3), snr_db: +(10 * Math.log10((sp / a.length) / (se / a.length || 1e-30))).toFixed(1) }; };
const base = process.argv[2], others = process.argv.slice(3);
const A = rd(base, 'eps_native');
for (const o of others) { const B = rd(o, 'eps_native'); console.log(path.basename(base), 'vs', path.basename(o), 'eps', JSON.stringify(stat(B, A)), 'hs', JSON.stringify(stat(rd(o, 'hs_native'), rd(base, 'hs_native')))); }
