# -*- coding: utf-8 -*-
# 假裝置的耗時比較：串列（提交→等 GPU→做 CPU）與重疊（提交→做 CPU→才等 GPU）。
# Python 端走真正的 fa_gpu.call_async／AsyncHandle／cupy.matmul_async；只有宿主（JS 端）換成假的：
# 每條 stream 一個工作執行緒，每筆矩陣乘先睡 GPU_MS 秒（模擬 GPU 延遲）再用 numpy 算結果。
# 用法：python renderer/src/gpu/async_overlap_fake_bench.py
import os
import sys
import threading
import time
import queue

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.abspath(os.path.join(HERE, "..", "pybridge")))

import fa_gpu  # noqa: E402

GPU_MS = 0.30   # 模擬每筆矩陣乘的 GPU 延遲（秒）
ROUNDS = 6      # 每種模式跑幾輪
N = 64          # 矩陣大小


class FakeDevice(object):
    def __init__(self):
        self._lock = threading.Lock()
        self._streams = {}
        self._handles = {}
        self._seq = 0

    def _worker(self, sid):
        q = queue.Queue()

        def run():
            while True:
                hid, body = q.get()
                time.sleep(GPU_MS)  # 模擬 GPU 延遲（工作執行緒裡睡，不影響主執行緒）
                try:
                    a = body["args"]
                    m, k, n = a["m"], a["k"], a["n"]
                    A = np.asarray(a["a"], dtype=np.float64).reshape(m, k)
                    B = np.asarray(a["b"], dtype=np.float64).reshape(k, n)
                    res = (A @ B).reshape(-1).tolist()
                    self._handles[hid]["result"] = {"result": res, "layer": "假裝置", "reason": ""}
                except Exception as e:  # 假裝置的錯誤也要存到句柄上
                    self._handles[hid]["error"] = e
                self._handles[hid]["done"].set()

        t = threading.Thread(target=run, daemon=True)
        t.start()
        return q

    def submit(self, body, stream):
        with self._lock:
            self._seq += 1
            hid = self._seq
            if stream not in self._streams:
                self._streams[stream] = self._worker(stream)
            self._handles[hid] = {"done": threading.Event(), "result": None, "error": None}
            self._streams[stream].put((hid, body))
        return {"handle": hid, "stream": stream}

    def wait(self, hid):
        h = self._handles[hid]
        h["done"].wait()
        if h["error"] is not None:
            raise fa_gpu.GpuCompatError(str(h["error"]))
        return h["result"]


DEV = FakeDevice()


def fake_arpc(name, args):
    if name == "submit":
        return DEV.submit(args["body"], args["stream"])
    if name == "wait":
        return DEV.wait(args["handle"])
    if name == "query":
        return "done" if DEV._handles[args["handle"]]["done"].is_set() else "pending"
    if name == "forget":
        return {"ok": True}
    raise AssertionError("假裝置沒有實作：" + name)


fa_gpu._arpc = fake_arpc


CPU_N = [60000]  # main() 會校正成「一輪 CPU 工作約等於一筆 GPU 延遲」，否則重疊的效果會被雜訊淹沒


def cpu_work():
    s = 0.0
    for i in range(CPU_N[0]):
        s += (i % 7) * 0.5
    return s


def calibrate_cpu():
    t0 = time.perf_counter()
    cpu_work()
    per = time.perf_counter() - t0
    CPU_N[0] = max(1000, int(CPU_N[0] * (GPU_MS / per)))
    return CPU_N[0]


def run_serial(A, B):
    t0 = time.perf_counter()
    for _ in range(ROUNDS):
        h = fa_gpu.call_async("matmul", _args(A, B), stream=1)
        h.wait()          # 先等 GPU
        cpu_work()        # 再做 CPU
    return time.perf_counter() - t0


def run_overlap(A, B):
    t0 = time.perf_counter()
    for _ in range(ROUNDS):
        h = fa_gpu.call_async("matmul", _args(A, B), stream=2)
        cpu_work()        # 提交後立刻做 CPU，GPU 同時在跑
        h.wait()          # 最後才等
    return time.perf_counter() - t0


def _args(A, B):
    return {"a": A.reshape(-1).tolist(), "b": B.reshape(-1).tolist(), "m": N, "k": N, "n": N}


def main():
    rng = np.random.RandomState(1)
    A = rng.rand(N, N)
    B = rng.rand(N, N)
    n = calibrate_cpu()
    # 先暖機，避免第一次執行的載入成本算進去
    run_serial(A, B)
    t_serial = run_serial(A, B)
    t_overlap = run_overlap(A, B)
    t_cpu_only = time.perf_counter()
    for _ in range(ROUNDS):
        cpu_work()
    t_cpu_only = time.perf_counter() - t_cpu_only
    print("假 GPU 延遲：每筆 %.0f 毫秒，共 %d 輪，矩陣 %d×%d，CPU 迴圈 %d 次（校正為約等於一筆 GPU 延遲）" % (GPU_MS * 1000, ROUNDS, N, N, n))
    print("只做 CPU：%.3f 秒" % t_cpu_only)
    print("串列：%.3f 秒" % t_serial)
    print("重疊：%.3f 秒" % t_overlap)
    print("省下：%.3f 秒（重疊比串列快 %.0f%%）" % (t_serial - t_overlap, 100.0 * (t_serial - t_overlap) / t_serial))


if __name__ == "__main__":
    main()
