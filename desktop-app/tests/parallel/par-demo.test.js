'use strict';
// 平行排程的真執行檢查：gcc -fopenmp 的區塊 DCT（各排程）與 python 多行程的檔案壓縮（各排程）。
// 每個平行版的輸出必須與循序版逐位元相同；沒有 gcc 或 python3 就明確印出略過的原因，不假裝通過。
const assert = require('assert'), cp = require('child_process'), fs = require('fs'), os = require('os'), path = require('path');
const DIR = __dirname, TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'par-demo-'));
const PY = process.env.FA_PYTHON || 'python3.13';
let n = 0, skipped = [];
const has = (cmd, args) => { const r = cp.spawnSync(cmd, args, { encoding: 'utf8' }); return r.status === 0; };
try {
    if (has('gcc', ['-fopenmp', '--version'])) {
        const bin = path.join(TMP, 'block_dct_omp');
        const b = cp.spawnSync('gcc', ['-O2', '-fopenmp', path.join(DIR, 'block_dct_omp.c'), '-o', bin, '-lm'], { encoding: 'utf8' });
        assert.strictEqual(b.status, 0, b.stderr);
        const run = (mode) => cp.spawnSync(bin, [mode, '512', '512', '7'], { encoding: 'utf8', env: Object.assign({}, process.env, { OMP_NUM_THREADS: '2' }) }).stdout;
        const want = run('seq');
        assert.match(want, /hash [0-9a-f]{16}\nnonzero \d+\nsse \d+ psnr [\d.]+/);
        for (const m of ['static', 'cyclic', 'chunk4', 'dynamic4', 'guided']) { assert.strictEqual(run(m), want, 'C 排程 ' + m + ' 與循序不同'); n++; }
    } else skipped.push('gcc -fopenmp（找不到）');
    if (has(PY, ['--version'])) {
        const sha = (mode) => cp.spawnSync(PY, ['-I', path.join(DIR, 'chunk_zlib_mp.py'), mode, '2', '2', '64'], { encoding: 'utf8' }).stdout.split('\n');
        const want = sha('seq');
        assert.strictEqual(want[2], 'roundtrip_ok');
        for (const m of ['block', 'cyclic', 'dynamic']) { const got = sha(m); assert.deepStrictEqual(got.slice(0, 3), want.slice(0, 3), 'python 排程 ' + m + ' 與循序不同'); n++; }
    } else skipped.push(PY + '（找不到）');
} finally { fs.rmSync(TMP, { recursive: true, force: true }); }
if (skipped.length) console.log('略過：' + skipped.join('、'));
console.log(n + ' 組排程與循序逐位元相同（真執行）'); console.log(n + ' passed, 0 failed');
