// KIR 裝置的 nbody 幀鏈（與 nbody3d_cl.ll 的 accel_cl 相同的順序）：加速度（4 核心，輸入是打包的 view，輸出 accpot 寫進下一組的 pot 段）→
// 速度（平面緩衝區）→ 位置（寫進下一組打包的 x、y、z 段）→ 每幀讀回一次（打包）。逐幀與 JS 參考（同一公式）比對。
// 由 scripts/eval/kir_nbody_chain.build.js 產生。
const SRC = __SRC__;
const load = (src) => new Function('module', 'require', 'self', src)(undefined, undefined, window);
load(SRC.kir); load(SRC.gen); load(SRC.webgl); load(SRC.front);
const K = window.FaKir, W = window.FaKirWebGL2, FR = window.FaClFront;
const R = {};
const cv = document.createElement('canvas'); cv.width = 64; cv.height = 64;
const gl = cv.getContext('webgl2');
R.supports = !!gl && W.supportsWebGL2(gl);
if (R.supports) {
    const kernels = {}; for (const k of FR.parseKernels(SRC.nbody).kernels) kernels[k.name] = k;
    const N = 512, G = 0.8, e2 = 0.01, dt = 0.01, vmax = 5.0, FRAMES = 20;
    let seed = 7; const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);
    const X0 = new Float32Array(N), Y0 = new Float32Array(N), Z0 = new Float32Array(N), MS = new Float32Array(N), V0 = [new Float32Array(N), new Float32Array(N), new Float32Array(N)];
    for (let i = 0; i < N; i++) { X0[i] = rnd() * 10; Y0[i] = rnd() * 10; Z0[i] = rnd() * 10; MS[i] = 200 + rnd() * 100; V0[0][i] = (rnd() - 0.5) * 2; V0[1][i] = (rnd() - 0.5) * 2; V0[2][i] = (rnd() - 0.5) * 2; }
    const scal0 = { n: N, G, e2 }, sv0 = { n: N, dt }, sp0 = { n: N, dt, vmax };
    // 參考：同一組核心在 KIR 的 JS 後端（runJs，每一步 Math.fround）依同樣的順序跑；裝置（float32 紋理）應與它幾乎一致
    const ref = [];
    {
        const names4 = ['accx', 'accy', 'accz', 'accpot'];
        const P = [0, 1].map(() => ({ x: new Float32Array(N), y: new Float32Array(N), z: new Float32Array(N), pot: new Float32Array(N) }));
        const Vp = [0, 1].map(() => ({ x: new Float32Array(N), y: new Float32Array(N), z: new Float32Array(N) }));
        P[0].x.set(X0); P[0].y.set(Y0); P[0].z.set(Z0); Vp[0].x.set(V0[0]); Vp[0].y.set(V0[1]); Vp[0].z.set(V0[2]);
        const A = { x: new Float32Array(N), y: new Float32Array(N), z: new Float32Array(N) };
        for (let f = 0; f < FRAMES; f++) {
            const p = f % 2, nx = 1 - p;
            const xin = { x: P[p].x, y: P[p].y, z: P[p].z, ms: MS };
            K.runJs(kernels.accx, { ...xin, ax: A.x }, scal0, N);
            K.runJs(kernels.accy, { ...xin, ay: A.y }, scal0, N);
            K.runJs(kernels.accz, { ...xin, az: A.z }, scal0, N);
            K.runJs(kernels.accpot, { ...xin, pot: P[nx].pot }, scal0, N);
            K.runJs(kernels.kvx, { vx: Vp[p].x, ax: A.x, ovx: Vp[nx].x }, sv0, N);
            K.runJs(kernels.kvy, { vy: Vp[p].y, ay: A.y, ovy: Vp[nx].y }, sv0, N);
            K.runJs(kernels.kvz, { vz: Vp[p].z, az: A.z, ovz: Vp[nx].z }, sv0, N);
            K.runJs(kernels.kpx, { x: P[p].x, vx: Vp[nx].x, ox: P[nx].x }, sp0, N);
            K.runJs(kernels.kpy, { y: P[p].y, vy: Vp[nx].y, oy: P[nx].y }, sp0, N);
            K.runJs(kernels.kpz, { z: P[p].z, vz: Vp[nx].z, oz: P[nx].z }, sp0, N);
            ref.push({ x: [P[nx].x.slice(), P[nx].y.slice(), P[nx].z.slice()], pot: P[nx].pot.slice() });
        }
    }
    const dev = W.createDevice(gl);
    const packs = [dev.allocPacked(N, 4), dev.allocPacked(N, 4)];
    const pv = packs.map((pk) => [0, 1, 2, 3].map((k) => dev.view(pk, k)));   // [x, y, z, pot]
    const vel = [0, 1].map(() => [dev.alloc(N, 'f32'), dev.alloc(N, 'f32'), dev.alloc(N, 'f32')]);
    const ax = [dev.alloc(N, 'f32'), dev.alloc(N, 'f32'), dev.alloc(N, 'f32')], ms = dev.alloc(N, 'f32');
    dev.upload(pv[0][0], X0); dev.upload(pv[0][1], Y0); dev.upload(pv[0][2], Z0);
    dev.upload(ms, MS);
    dev.upload(vel[0][0], V0[0]); dev.upload(vel[0][1], V0[1]); dev.upload(vel[0][2], V0[2]);
    const scal = scal0, sv = sv0, sp = sp0;
    const maxErrs = [];
    let t0 = performance.now(), dlCount = 0;
    for (let f = 0; f < FRAMES; f++) {
        const p = f % 2, nx = 1 - p;
        const xin = { x: pv[p][0], y: pv[p][1], z: pv[p][2], ms };
        dev.dispatch(kernels.accx, { ...xin }, ax[0], scal, N);
        dev.dispatch(kernels.accy, { ...xin }, ax[1], scal, N);
        dev.dispatch(kernels.accz, { ...xin }, ax[2], scal, N);
        dev.dispatch(kernels.accpot, { ...xin }, pv[nx][3], scal, N);
        dev.dispatch(kernels.kvx, { vx: vel[p][0], ax: ax[0] }, vel[nx][0], sv, N);
        dev.dispatch(kernels.kvy, { vy: vel[p][1], ay: ax[1] }, vel[nx][1], sv, N);
        dev.dispatch(kernels.kvz, { vz: vel[p][2], az: ax[2] }, vel[nx][2], sv, N);
        dev.dispatch(kernels.kpx, { x: pv[p][0], vx: vel[nx][0] }, pv[nx][0], sp, N);
        dev.dispatch(kernels.kpy, { y: pv[p][1], vy: vel[nx][1] }, pv[nx][1], sp, N);
        dev.dispatch(kernels.kpz, { z: pv[p][2], vz: vel[nx][2] }, pv[nx][2], sp, N);
        // 每幀一次讀回：下一組的打包（x、y、z、pot）
        const all = dev.download(packs[nx]); dlCount++;
        const r = ref[f];
        let e = 0;
        for (let i = 0; i < N; i++) {
            e = Math.max(e, Math.abs(all[i] - r.x[0][i]), Math.abs(all[N + i] - r.x[1][i]), Math.abs(all[2 * N + i] - r.x[2][i]), Math.abs(all[3 * N + i] - r.pot[i]));
        }
        maxErrs.push(+e.toExponential(2));
    }
    gl.finish();
    R.chain = { N, frames: FRAMES, downloads: dlCount, max_err_per_frame: maxErrs, worst: Math.max(...maxErrs.map(Number)), ms_per_frame: +((performance.now() - t0) / FRAMES).toFixed(2) };
    R.chain.ok = R.chain.worst <= 1e-3;
}
console.log('KIR_NBODY_CHAIN ' + JSON.stringify(R));
return R;
