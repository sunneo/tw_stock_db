"""cpu-py 的全參數訓練（llm_full）：用 llm_scratch.py 自己的 LM，與 JS 的 fullParamStepDevice 同一套訓練步與超參數。

設計原則：兩條路徑（cudaweb、cpu-py）共用同一份「模型定義＋初始權重＋資料列」，後端只換運算。
  · 工作檔（由 JS 產生，見 llm_full_data.js）：
      job.json    {cfg:{V,d,L,H,kvH,F,T}, lr, wd, clip, steps, rows_file, init_file, out_dir, dtype, resume_dir?}
      init_file   params.f32（fa-f32 張量檔，名稱與 JS 相同：emb、nf、L<l>.<n1|n2|Wq|Wk|Wv|Wo|qn|kn|Wg|Wu|Wd>）
      rows_file   rows.json（每列 T+1 個詞元 id；第 k 步用第 (k-1) mod 列）
  · 訓練步：交叉熵（對 T 個位置取平均）→ 全域梯度範數裁剪（coef = min(1, clip/(norm+1e-6))）→ AdamW（decoupled wd、betas 0.9/0.999、eps 1e-8）。
  · 輸出（stdout，每行一個 JSON）：{"step","loss","ms"}；結尾 {"event":"done",...}。
  · 檢查點（checkpoint_core 格式 fa-ckpt，與 full_param_train.js 的 saveState 相同檔名）：
      ckpt.json、params.f32、opt_m.f32、opt_v.f32（sha256 寫進 ckpt.json）。續訓：--resume 指向該資料夾。
  · 亂數：這條訓練路徑沒有隨機抽樣（資料順序固定），所以檢查點不含亂數狀態；資料位置存 next_batch。

用法：python llm_full_cpu.py --job <job.json>
"""
import argparse
import hashlib
import json
import math
import os
import struct
import sys
import time

import torch
import torch.nn.functional as F

sys.stdout.reconfigure(encoding="utf-8")

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import llm_scratch as LS  # noqa: E402

FORMAT, VERSION = "fa-ckpt", 1
TENSOR_FILES = ["params.f32", "opt_m.f32", "opt_v.f32"]
KEYS = ["n1", "n2", "Wq", "Wk", "Wv", "Wo", "qn", "kn", "Wg", "Wu", "Wd"]


def emit(obj):
    print(json.dumps(obj, ensure_ascii=False), flush=True)


def sha256_bytes(b):
    return hashlib.sha256(b).hexdigest()


def encode_tensors(named):
    """fa-f32：4 位元組長度 + JSON 表頭（依名稱排序）+ 連續 float32（小端）。與 checkpoint_core.encodeTensors 相同。"""
    items = sorted(named, key=lambda kv: kv[0])
    meta, off, chunks = [], 0, []
    for name, t in items:
        flat = t.detach().reshape(-1).to(torch.float32).contiguous().numpy().astype("<f4").tobytes()
        n = len(flat) // 4
        meta.append({"name": name, "shape": [n], "offset": off, "length": n})
        off += n
        chunks.append(flat)
    head = json.dumps({"format": "fa-f32", "tensors": meta}, ensure_ascii=False).encode("utf-8")
    return struct.pack("<I", len(head)) + head + b"".join(chunks)


def decode_tensors(buf):
    hl = struct.unpack("<I", buf[:4])[0]
    head = json.loads(buf[4:4 + hl].decode("utf-8"))
    if head.get("format") != "fa-f32":
        raise ValueError("不是 fa-f32 張量檔")
    base = 4 + hl
    out = {}
    for m in head["tensors"]:
        raw = buf[base + m["offset"] * 4: base + (m["offset"] + m["length"]) * 4]
        out[m["name"]] = torch.tensor(list(struct.unpack("<%df" % m["length"], raw)), dtype=torch.float64)
    return out


def js_names(L):
    """固定的參數順序（與 JS eachParam 一致）。回傳 [(js 名稱, torch 參數名, 是否為權重矩陣需轉置)]。"""
    out = [("emb", "emb.weight", False), ("nf", "norm.weight", False)]
    tmap = {"Wq": "q", "Wk": "k", "Wv": "v", "Wo": "o", "Wg": "mlp.gate", "Wu": "mlp.up", "Wd": "mlp.down"}
    for l in range(L):
        p = "layers.%d." % l
        for k in KEYS:
            if k in tmap:
                out.append(("L%d.%s" % (l, k), p + tmap[k] + ".weight", True))
            else:
                out.append(("L%d.%s" % (l, k), p + {"n1": "n1", "n2": "n2", "qn": "qn", "kn": "kn"}[k] + ".weight", False))
    return out


def build(cfg, dtype):
    hd = cfg["d"] // cfg["H"]
    mc = LS.make_config(cfg["V"], "tiny", layers=cfg["L"], heads=cfg["H"], kv_heads=cfg["kvH"], head_dim=hd,
                        hidden=cfg["d"], intermediate=cfg["F"], rope_theta=10000.0, max_pos=max(64, cfg["T"] + 1), eps=1e-6)
    model = LS.build_model_classes()(mc)
    model = model.to(dtype)
    return model


def load_params(model, names, flat):
    """flat：{js 名稱: 1 維張量}（JS 的 [輸入, 輸出] 佈局）→ 寫進 torch 參數（nn.Linear 是 [輸出, 輸入]）。"""
    sd = dict(model.named_parameters())
    with torch.no_grad():
        for js, tn, tr in names:
            p = sd[tn]
            v = flat[js].to(p.dtype)
            if tr:
                p.copy_(v.reshape(p.shape[1], p.shape[0]).t())
            else:
                p.copy_(v.reshape(p.shape))


def export_params(model, names):
    sd = dict(model.named_parameters())
    out = []
    for js, tn, tr in names:
        p = sd[tn].detach()
        out.append((js, p.t().reshape(-1) if tr else p.reshape(-1)))
    return out


def export_state(opt, model, names, key):
    sd = dict(model.named_parameters())
    out = []
    for js, tn, tr in names:
        st = opt.state.get(sd[tn], {})
        t = st.get(key)
        if t is None:
            t = torch.zeros_like(sd[tn].detach())
        out.append((js, t.t().reshape(-1) if tr else t.reshape(-1)))
    return out


def save_ckpt(out_dir, model, opt, names, step, next_batch, job):
    os.makedirs(out_dir, exist_ok=True)
    files = {
        "params.f32": encode_tensors(export_params(model, names)),
        "opt_m.f32": encode_tensors(export_state(opt, model, names, "exp_avg")),
        "opt_v.f32": encode_tensors(export_state(opt, model, names, "exp_avg_sq")),
    }
    for fn, buf in files.items():
        with open(os.path.join(out_dir, fn), "wb") as f:
            f.write(buf)
    ck = {
        "format": FORMAT, "version": VERSION, "step": int(step), "next_batch": int(next_batch), "dtype": "float32",
        "cfg": job["cfg"],
        "optimizer": {"name": "adamw", "lr": job["lr"], "b1": 0.9, "b2": 0.999, "eps": 1e-8, "wd": job["wd"], "clip": job["clip"]},
        "sha256": {fn: sha256_bytes(buf) for fn, buf in files.items()},
        "produced_by": "llm_full_cpu.py",
    }
    with open(os.path.join(out_dir, "ckpt.json"), "w", encoding="utf-8") as f:
        json.dump(ck, f, ensure_ascii=False, indent=1)
    return ck


def load_ckpt(in_dir, model, opt, names):
    with open(os.path.join(in_dir, "ckpt.json"), encoding="utf-8") as f:
        ck = json.load(f)
    if ck.get("format") != FORMAT or ck.get("version") != VERSION:
        raise ValueError("檢查點格式或版本不合")
    bufs = {}
    for fn in TENSOR_FILES:
        with open(os.path.join(in_dir, fn), "rb") as f:
            b = f.read()
        if sha256_bytes(b) != ck["sha256"].get(fn):
            raise ValueError("檢查點拒絕載入：%s（sha256 不符）" % fn)
        bufs[fn] = decode_tensors(b)
    load_params(model, names, bufs["params.f32"])
    sd = dict(model.named_parameters())
    for js, tn, tr in names:
        p = sd[tn]
        m = bufs["opt_m.f32"][js].to(p.dtype)
        v = bufs["opt_v.f32"][js].to(p.dtype)
        if tr:
            m = m.reshape(p.shape[1], p.shape[0]).t()
            v = v.reshape(p.shape[1], p.shape[0]).t()
        else:
            m = m.reshape(p.shape)
            v = v.reshape(p.shape)
        opt.state[p] = {"step": torch.tensor(float(ck["step"])), "exp_avg": m.clone(), "exp_avg_sq": v.clone()}
    return ck


def run(job):
    cfg = job["cfg"]
    dtype = torch.float64 if job.get("dtype") == "float64" else torch.float32
    T = cfg["T"]
    model = build(cfg, dtype)
    names = js_names(cfg["L"])
    load_params(model, names, decode_tensors(open(job["init_file"], "rb").read()))
    params = list(model.parameters())
    opt = torch.optim.AdamW(params, lr=job["lr"], betas=(0.9, 0.999), eps=1e-8, weight_decay=job["wd"])
    with open(job["rows_file"], encoding="utf-8") as f:
        rows = json.load(f)
    start_step, next_batch = 0, 0
    if job.get("resume_dir"):
        ck = load_ckpt(job["resume_dir"], model, opt, names)
        start_step, next_batch = ck["step"], ck["next_batch"]
        emit({"event": "resume", "step": start_step, "next_batch": next_batch})
    emit({"event": "start", "steps": job["steps"], "rows": len(rows), "start_step": start_step, "dtype": str(dtype)})
    pos = torch.arange(T).reshape(1, T)
    am = torch.ones(1, T, dtype=dtype)
    step = start_step
    for s in range(job["steps"]):
        idx = (next_batch + s) % len(rows)
        toks = torch.tensor(rows[idx], dtype=torch.long)
        t0 = time.perf_counter()
        logits, _ = model(toks[:T].reshape(1, T), am, pos)
        loss = F.cross_entropy(logits[0], toks[1:])
        opt.zero_grad(set_to_none=True)
        loss.backward()
        torch.nn.utils.clip_grad_norm_(params, job["clip"])
        opt.step()
        ms = (time.perf_counter() - t0) * 1000.0
        step += 1
        emit({"step": step, "loss": float(loss.detach()), "ms": round(ms, 3)})
    next_b = next_batch + job["steps"]
    if job.get("out_dir"):
        ck = save_ckpt(job["out_dir"], model, opt, names, step, next_b, job)
        emit({"event": "done", "ok": True, "step": step, "next_batch": next_b, "ckpt": job["out_dir"], "sha256": ck["sha256"]})
    else:
        emit({"event": "done", "ok": True, "step": step, "next_batch": next_b})


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--job", required=True)
    a = ap.parse_args()
    with open(a.job, encoding="utf-8") as f:
        job = json.load(f)
    run(job)


if __name__ == "__main__":
    main()
