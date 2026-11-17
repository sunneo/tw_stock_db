// node renderer/src/gpu/bench_run.test.js
// 基準執行器（假計時、假裝置、假 ORT）：暖機不計、量測 20 次、計時包含全部（由 run 回傳才算）、讓出主執行緒、取消不存半成品、
// 輸出不符就無效、ORT 失敗逐次記錄（不靜默）、ORT 會話 key 含後端與形狀、getData 可能是 promise、ONNX MatMul 圖結構正確。
const R = require('./bench_run.js'); const C = require('./bench_core.js');
let ok = 0, bad = 0; const check = (n, c, x) => { if (c) ok++; else { bad++; console.log('FAIL ' + n + (x === undefined ? '' : ' ' + JSON.stringify(x).slice(0, 240))); } };

// 假時鐘：每次 now() 前進 clock.step 的一步；run 會把時鐘推進 cost 毫秒
function fakeClock() { const c = { t: 0, step: 0 }; c.now = () => c.t; return c; }

(async () => {
    // 1. 輸入確定性；參考矩陣乘正確（2x2）
    {
        const x1 = R.makeMatmulInputs(4, 5, 6, 3), x2 = R.makeMatmulInputs(4, 5, 6, 3);
        check('1 同 seed 同資料', Array.from(x1.a).join() === Array.from(x2.a).join());
        const y = R.matmulRef(Float32Array.from([1, 2, 3, 4]), [2, 2], Float32Array.from([5, 6, 7, 8]), [2, 2]);
        check('1 參考矩陣乘', Array.from(y).join() === '19,22,43,50', Array.from(y));
    }
    // 2. ONNX 圖結構：用小的 protobuf 讀回來，檢查 MatMul(A,B→Y)、輸入／輸出形狀、opset 13、ir_version 8
    {
        const bytes = R.onnxMatMulBytes(3, 4, 5);
        const read = (buf) => { const out = []; let p = 0; const vi = () => { let v = 0, sh = 0, b; do { b = buf[p++]; v += (b & 127) * Math.pow(2, sh); sh += 7; } while (b & 128); return v; };
            while (p < buf.length) { const k = vi(), f = k >> 3, w = k & 7; if (w === 0) out.push({ f, v: vi() }); else if (w === 2) { const n = vi(); out.push({ f, b: buf.slice(p, p + n) }); p += n; } else throw new Error('wire ' + w); } return out; };
        const str = (b) => Buffer.from(b).toString('utf8');
        const top = read(bytes);
        check('2 ir_version=8', top.find((x) => x.f === 1).v === 8);
        const graph = read(top.find((x) => x.f === 7).b);
        const node = read(graph.find((x) => x.f === 1).b);
        check('2 節點 MatMul(A,B→Y)', str(node.filter((x) => x.f === 1).map((x) => x.b)[0]) === 'A' && str(node.filter((x) => x.f === 1)[1].b) === 'B' && str(node.find((x) => x.f === 2).b) === 'Y' && str(node.find((x) => x.f === 4).b) === 'MatMul');
        const inputs = graph.filter((x) => x.f === 11), outputs = graph.filter((x) => x.f === 12);
        check('2 兩個輸入、一個輸出', inputs.length === 2 && outputs.length === 1, [inputs.length, outputs.length]);
        const dims = (vi) => { const tt = read(read(read(vi.b).find((x) => x.f === 2).b).find((x) => x.f === 1).b); const shape = read(tt.find((x) => x.f === 2).b); return shape.filter((x) => x.f === 1).map((d) => read(d.b).find((x) => x.f === 1).v); };
        check('2 A 形狀 [3,4]', JSON.stringify(dims(inputs[0])) === '[3,4]', dims(inputs[0]));
        check('2 B 形狀 [4,5]', JSON.stringify(dims(inputs[1])) === '[4,5]', dims(inputs[1]));
        check('2 Y 形狀 [3,5]', JSON.stringify(dims(outputs[0])) === '[3,5]', dims(outputs[0]));
        const opset = read(top.find((x) => x.f === 8).b);
        check('2 opset 13', opset.find((x) => x.f === 2).v === 13);
    }
    // 3. 計時：暖機 3 次不計、量測 20 次；每個樣本＝run 前後時鐘差；讓出 23 次
    {
        const clk = fakeClock(); let yields = 0, calls = 0;
        const cand = { id: 'cudaweb', run: async () => { calls++; clk.t += 5 + (calls % 2); return Float32Array.from([1]); } };
        const rows = await R.runCase({ now: clk.now, yieldTo: async () => { yields++; }, isCancelled: () => false }, { op: 'matmul', shape: '1x1x1', ref: Float32Array.from([1]), candidates: [cand] });
        check('3 呼叫 23 次（3 暖機＋20 量測）', calls === 23, calls);
        check('3 有 20 個樣本', rows[0].stats.n === 20, rows[0].stats);
        check('3 讓出主執行緒 23 次', yields === 23, yields);
        check('3 樣本是 run 前後的時間差（5 或 6 ms）', rows[0].stats.p10 >= 5 && rows[0].stats.p90 <= 6, rows[0].stats);
        check('3 正確性通過、無錯誤', rows[0].errors === 0 && rows[0].relErr === 0, rows[0]);
    }
    // 4. 取消：在樣本之間檢查；取消的列不會有效，也不會存半成品
    {
        let calls = 0;
        const cand = { id: 'x', run: async () => { calls++; return Float32Array.from([1]); } };
        const rows = await R.runCase({ isCancelled: () => calls >= 5, yieldTo: async () => {} }, { op: 'matmul', shape: 's', ref: null, candidates: [cand, { id: 'y', run: async () => Float32Array.from([1]) }] });
        check('4 取消後不再呼叫', calls <= 6, calls);
        check('4 取消的列無效、標示 cancelled', rows.length === 1 && rows[0].cancelled === true && rows[0].valid === false, rows);
    }
    // 5. 輸出不符：整體相對誤差超過 TOL → 錯誤、無效，訊息寫出誤差
    {
        const ref = Float32Array.from([1, 2, 3]);
        const cand = { id: 'bad', run: async () => Float32Array.from([1, 2, 3.5]) };
        const rows = await R.runCase({ now: () => 0, yieldTo: async () => {} }, { op: 'matmul', shape: 's', ref, candidates: [cand] });
        check('5 輸出不符：無效、有錯誤', rows[0].valid === false && rows[0].errors >= 1 && rows[0].errorMsgs[0].includes('整體相對誤差'), rows[0]);
    }
    // 6. ORT 失敗：每次都記錄（不靜默）；只失敗一次也會讓該列無效
    {
        const rowsAll = await R.runCase({ now: () => 0, yieldTo: async () => {} }, { op: 'matmul', shape: 's', ref: null, candidates: [{ id: 'ort-webgpu', run: async () => { throw new Error('GPU 裝置遺失'); } }] });
        check('6 全部失敗：無效，錯誤數＝23，訊息保留', rowsAll[0].valid === false && rowsAll[0].errors === 23 && rowsAll[0].errorMsgs[0] === 'GPU 裝置遺失', rowsAll[0].errors);
        let n = 0;
        const rowsOne = await R.runCase({ now: () => 0, yieldTo: async () => {} }, { op: 'matmul', shape: 's', ref: null, candidates: [{ id: 'ort-wasm', run: async () => { n++; if (n === 10) throw new Error('暫時的'); return Float32Array.from([1]); } }] });
        check('6 只失敗一次：仍無效（不靜默地忽略）', rowsOne[0].valid === false && rowsOne[0].errors === 1, rowsOne[0]);
    }
    // 7. ORT 會話：後端 id 對應 EP（ort-webgpu→webgpu、ort-wasm→wasm）；快取 key 含運算、後端與形狀；getData 可能是 promise
    {
        const made = []; const fakeOrt = {
            Tensor: function (type, data, dims) { this.type = type; this.data = data; this.dims = dims; },
            InferenceSession: { create: async (bytes, opts) => { made.push({ ep: opts.executionProviders[0], n: bytes.length }); return { run: async (feeds) => { const a = feeds.A, b = feeds.B; const M = a.dims[0], K = a.dims[1], N = b.dims[1]; const y = R.matmulRef(a.data, [M, K], b.data, [K, N]); return { Y: { getData: async () => y } }; } }; } },
        };
        const cache = {};
        const f1 = R.ortMatmul(fakeOrt, 'ort-webgpu', 4, 5, 6, cache), f2 = R.ortMatmul(fakeOrt, 'ort-wasm', 4, 5, 6, cache);
        const x = R.makeMatmulInputs(4, 5, 6, 9);
        const y1 = await f1(x.a, x.b), y2 = await f2(x.a, x.b), y3 = await f1(x.a, x.b);
        check('7 ort-webgpu 用 webgpu EP、ort-wasm 用 wasm EP', made[0].ep === 'webgpu' && made[1].ep === 'wasm', made);
        check('7 同一後端同形狀只建一次會話', made.length === 2 && y3.length === y1.length, made.length);
        check('7 結果與參考一致（getData 是 promise）', C.relErr(y1, R.matmulRef(x.a, [4, 5], x.b, [5, 6])) < 1e-6 && C.relErr(y2, y1) === 0);
        const f3 = R.ortMatmul(fakeOrt, 'ort-webgpu', 4, 5, 7, cache); await f3(R.makeMatmulInputs(4, 5, 7, 1).a, R.makeMatmulInputs(4, 5, 7, 1).b);
        check('7 不同形狀另建會話', made.length === 3, made.length);
        const fNo = R.ortMatmul(undefined, 'ort-wasm', 2, 2, 2, {});
        let msg = ''; try { await fNo(Float32Array.from([1, 2, 3, 4]), Float32Array.from([1, 2, 3, 4])); } catch (e) { msg = e.message; }
        check('7 沒有 ORT：明確報錯（不假裝成功）', msg.includes('ORT 沒有載入'), msg);
    }
    // 8. 候選清單：cudaweb（mm.matmul）與兩個 ORT 後端；cudaweb 輸出與參考一致即有效
    {
        const env = { mm: { matmul: async (a, ad, b, bd) => ({ y: R.matmulRef(a, ad, b, bd) }) }, ort: null, cache: {}, seed: 4 };
        const spec = { M: 3, K: 4, N: 5 };
        const mc = R.matmulCandidates(spec, env);
        check('8 三個候選', mc.cands.map((c) => c.id).join() === 'cudaweb,ort-webgpu,ort-wasm', mc.cands.map((c) => c.id));
        const rows = await R.runCase({ now: () => 0, yieldTo: async () => {} }, { op: 'matmul', shape: '3x4x5', ref: mc.ref, candidates: [mc.cands[0]] });
        check('8 cudaweb 與參考一致，有效前的正確性通過', rows[0].errors === 0 && rows[0].relErr < 1e-6, rows[0]);
    }

    console.log('bench_run.test.js: ' + ok + ' passed, ' + bad + ' failed');
    process.exit(bad ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
