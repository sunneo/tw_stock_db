"""異質訓練的 cpu-py 梯度工作者（P1c-2 第二半）。只算梯度，不更新參數、不做 AdamW（那是協調端的事）。

協定：stdin 每行一個 JSON 請求，stdout 每行一個 JSON 回應（stdout 只放協定；錯誤也走回應，不印到 stdout）。
  {"op":"init","id":0,"cfg":{V,d,L,H,kvH,F,T},"dtype":"float64"|"float32"}
      → {"id":0,"ok":true,"names":[["emb",長度],["nf",長度],["L0.n1",長度],...]}   回傳參數順序（協調端依此打包）
  {"op":"grad","id":1,"params_file":"...","seqs_file":"...","grads_file":"..."}
      params_file：小端序，依 init 回傳的 names 順序連續排列（JS 佈局）；dtype 為 float32 時線上格式也是 f32（一半的位元組），float64 時是 f64
      seqs_file：JSON，[[T+1 個詞元], ...]
      grads_file：寫出 float64 小端序，同樣的順序（JS 佈局，平均後、裁剪前）
      → {"id":1,"ok":true,"loss":平均損失,"n":序列數}
  {"op":"quit"}

梯度定義：每個序列的損失＝該序列 T 個位置的交叉熵平均；回傳的梯度是「這批序列的損失平均」的梯度（除以本批序列數）。
協調端再依序列數加權，得到整批平均。模型定義、佈局與 llm_full_cpu.py 相同（直接沿用 build／load_params／js_names）。
"""
import json
import os
import sys
import time

import numpy as np
import torch
import torch.nn.functional as F

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import llm_full_cpu as C  # noqa: E402


def write_reply(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def main():
    st = {"cfg": None, "dtype": None, "model": None, "names": None, "sd": None}
    for raw in sys.stdin:
        line = raw.strip()
        if not line:
            continue
        req = json.loads(line)
        rid = req.get("id")
        op = req.get("op")
        if op == "quit":
            break
        try:
            if op == "init":
                cfg = req["cfg"]
                dtype = torch.float64 if req.get("dtype") == "float64" else torch.float32
                model = C.build(cfg, dtype)
                names = C.js_names(cfg["L"])
                sd = dict(model.named_parameters())
                st.update({"cfg": cfg, "dtype": dtype, "model": model, "names": names, "sd": sd})
                layout = [[js, int(sd[tn].numel())] for js, tn, _tr in names]
                write_reply({"id": rid, "ok": True, "names": layout})
            elif op == "grad":
                if st["model"] is None:
                    raise RuntimeError("尚未 init")
                model, names, sd, cfg, dtype = st["model"], st["names"], st["sd"], st["cfg"], st["dtype"]
                t0 = time.perf_counter()
                with open(req["params_file"], "rb") as f:
                    raw_bytes = f.read()
                wire = "<f4" if dtype == torch.float32 else "<f8"
                flat64 = np.frombuffer(raw_bytes, dtype=wire)
                flat = {}
                off = 0
                for js, tn, _tr in names:
                    n = int(sd[tn].numel())
                    flat[js] = torch.from_numpy(np.array(flat64[off:off + n], dtype=np.float64))
                    off += n
                if off != flat64.size:
                    raise RuntimeError("參數長度 %d 與佈局 %d 不符" % (flat64.size, off))
                C.load_params(model, names, flat)
                t1 = time.perf_counter()
                with open(req["seqs_file"], encoding="utf-8") as f:
                    seqs = json.load(f)
                if not seqs:
                    raise RuntimeError("沒有序列")
                T = cfg["T"]
                pos = torch.arange(T).reshape(1, T)
                am = torch.ones(1, T, dtype=dtype)
                model.zero_grad(set_to_none=True)
                n = len(seqs)
                loss_sum = 0.0
                for row in seqs:
                    toks = torch.tensor(row, dtype=torch.long)
                    if toks.numel() != T + 1:
                        raise RuntimeError("序列長度 %d 應為 T+1=%d" % (toks.numel(), T + 1))
                    logits, _ = model(toks[:T].reshape(1, T), am, pos)
                    loss = F.cross_entropy(logits[0], toks[1:])
                    (loss / n).backward()
                    loss_sum += float(loss.detach())
                t2 = time.perf_counter()
                parts = []
                for js, tn, tr in names:
                    p = sd[tn]
                    g = p.grad if p.grad is not None else torch.zeros_like(p)
                    v = g.detach().t().reshape(-1) if tr else g.detach().reshape(-1)
                    parts.append(v.to(torch.float32 if wire == "<f4" else torch.float64).contiguous().numpy())
                out = np.concatenate(parts).astype(wire, copy=False)
                with open(req["grads_file"], "wb") as f:
                    f.write(out.tobytes())
                t3 = time.perf_counter()
                write_reply({"id": rid, "ok": True, "loss": loss_sum / n, "n": n,
                             "ms": (t3 - t0) * 1000.0,
                             "tLoad": (t1 - t0) * 1000.0, "tFwdBwd": (t2 - t1) * 1000.0, "tExport": (t3 - t2) * 1000.0})
            else:
                raise RuntimeError("未知的 op：%s" % op)
        except Exception as e:  # 錯誤走協定回應，協調端會把這個資源標記離線
            write_reply({"id": rid, "ok": False, "error": "%s: %s" % (type(e).__name__, e)})


if __name__ == "__main__":
    main()
