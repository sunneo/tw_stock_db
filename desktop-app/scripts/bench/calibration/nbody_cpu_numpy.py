# 校準：nbody3d.py 的 CPU 路徑（numpy 向量化）每一幀的時間。函式與 python/gpgpu/nbody3d.py 的 pairwise_cpu 逐字相同。
# 每幀 = pairwise_cpu（O(N²)）＋積分（同原檔的 step 內容）。量 N=3072 與 1024、4096。
import time, json, sys
import numpy as np

def pairwise_cpu(px, py, pz, m, soft2, gcoef, block=256):
    n = px.shape[0]
    sx = np.empty(n, np.float32); sy = np.empty(n, np.float32); sz = np.empty(n, np.float32); pot = np.empty(n, np.float32)
    soft2 = np.float32(soft2); gcoef = np.float32(gcoef)
    for a in range(0, n, block):
        b = min(n, a + block)
        dx = px[None, :] - px[a:b, None]
        dy = py[None, :] - py[a:b, None]
        dz = pz[None, :] - pz[a:b, None]
        inv = 1.0 / np.sqrt(dx * dx + dy * dy + dz * dz + soft2)
        s = gcoef * m[None, :] * inv * inv * inv
        sx[a:b] = (s * dx).sum(axis=1); sy[a:b] = (s * dy).sum(axis=1); sz[a:b] = (s * dz).sum(axis=1)
        pot[a:b] = (m[None, :] * inv).sum(axis=1) - m[a:b] / np.sqrt(soft2)
    return sx, sy, sz, pot

def frame(state, n):
    x, y, z, vx, vy, vz, m = state
    sx, sy, sz, pot = pairwise_cpu(x, y, z, m, 0.5, 1.0)
    dt = np.float32(0.02)
    vx += sx * dt; vy += sy * dt; vz += sz * dt
    x += vx * dt; y += vy * dt; z += vz * dt
    return pot

def run(n, reps=7):
    rng = np.random.default_rng(1)
    state = [rng.uniform(0, 100, n).astype(np.float32) for _ in range(3)]
    state += [np.zeros(n, np.float32) for _ in range(3)]
    state.append(rng.uniform(200, 299, n).astype(np.float32))
    frame(state, n)  # 暖機
    ts = []
    for _ in range(reps):
        t0 = time.perf_counter(); frame(state, n); ts.append((time.perf_counter() - t0) * 1000.0)
    ts.sort(); med = ts[len(ts) // 2]
    flops = 20.0 * n * n
    return {"N": n, "msPerFrameMedian": round(med, 3), "msMin": round(ts[0], 3), "msMax": round(ts[-1], 3),
            "gflopsAt20perPair": round(flops / (med * 1e-3) / 1e9, 3)}

if __name__ == "__main__":
    out = {"python": sys.version.split()[0], "numpy": np.__version__, "results": [run(n) for n in (1024, 3072, 4096)]}
    print("[nbody-cpu-numpy] " + json.dumps(out))
