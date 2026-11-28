"""異質訓練的 PyTorch 參考（測試用，不在執行路徑上）。讀一份工作 JSON，把結果寫到 job["out"]。

  mode "grad"：整批（seqs）一次前向反向，損失＝各序列交叉熵的平均；輸出逐名稱梯度（JS 佈局，裁剪前）。
  mode "train"：steps 是每步的序列清單；每步用 torch.optim.AdamW（與協定相同的超參數）＋ clip_grad_norm_；輸出最終參數。

工作 JSON：{mode, dtype:"float64"|"float32", cfg, init:{名稱:[數字…]}, seqs?, steps?, lr?, wd?, clip?, out}
"""
import json
import os
import sys

import torch
import torch.nn.functional as F

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import llm_full_cpu as C  # noqa: E402


def main():
    job = json.load(open(sys.argv[1], encoding="utf-8"))
    dtype = torch.float64 if job["dtype"] == "float64" else torch.float32
    cfg = job["cfg"]
    model = C.build(cfg, dtype)
    names = C.js_names(cfg["L"])
    flat = {k: torch.tensor(v, dtype=torch.float64).to(dtype) for k, v in job["init"].items()}
    C.load_params(model, names, flat)
    params = list(model.parameters())
    T = cfg["T"]
    pos = torch.arange(T).reshape(1, T)
    am = torch.ones(1, T, dtype=dtype)

    def seq_loss(row):
        toks = torch.tensor(row, dtype=torch.long)
        logits, _ = model(toks[:T].reshape(1, T), am, pos)
        return F.cross_entropy(logits[0], toks[1:])

    res = {}
    if job["mode"] == "grad":
        model.zero_grad(set_to_none=True)
        seqs = job["seqs"]
        losses = [seq_loss(r) for r in seqs]
        loss = sum(losses) / len(losses)
        loss.backward()
        sd = dict(model.named_parameters())
        grads = {}
        for js, tn, tr in names:
            g = sd[tn].grad.detach()
            v = g.t().reshape(-1) if tr else g.reshape(-1)
            grads[js] = v.double().tolist()
        res = {"loss": float(loss.detach()), "grads": grads}
    elif job["mode"] == "train":
        opt = torch.optim.AdamW(params, lr=job["lr"], betas=(0.9, 0.999), eps=1e-8, weight_decay=job["wd"])
        for step_seqs in job["steps"]:
            opt.zero_grad(set_to_none=True)
            losses = [seq_loss(r) for r in step_seqs]
            loss = sum(losses) / len(losses)
            loss.backward()
            torch.nn.utils.clip_grad_norm_(params, job["clip"])
            opt.step()
        sd = dict(model.named_parameters())
        out = {}
        for js, tn, tr in names:
            p = sd[tn].detach()
            v = p.t().reshape(-1) if tr else p.reshape(-1)
            out[js] = v.double().tolist()
        res = {"params": out}
    else:
        raise SystemExit("未知的 mode：%s" % job["mode"])
    with open(job["out"], "w", encoding="utf-8") as f:
        json.dump(res, f)


if __name__ == "__main__":
    main()
