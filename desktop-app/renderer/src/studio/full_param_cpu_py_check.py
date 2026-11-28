"""cpu-py 對拍（P1 S3）：用 llm_scratch.py 自己的 LM（build_model_classes）跑同一份初始權重與同一批資料，
與 fixture（PyTorch 參考，fp64）比對步 1 的損失與全部梯度。

llm_scratch 的密集 Block 一律有 qk-norm 與分組查詢；對應 fixture 變體 gqa_qkn。
llm_scratch 預設 rope_theta＝1e6，這裡覆寫成 10000（與 JS 與參考相同）。

用法：python full_param_cpu_py_check.py <fixture: gqa_qkn 的 json>
"""
import json
import os
import sys

import torch
import torch.nn.functional as F

sys.stdout.reconfigure(encoding="utf-8")

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import llm_scratch as LS  # noqa: E402


def main():
    fx = json.load(open(sys.argv[1], encoding="utf-8"))
    cfg_fx = fx["cfg"]
    assert fx["variant"] == "gqa_qkn", "cpu-py 對拍只對 llm_scratch 的變體（有 qk-norm 與 GQA）"
    V, d, H, kvH, Fd, T, L = cfg_fx["V"], cfg_fx["d"], cfg_fx["H"], cfg_fx["kvH"], cfg_fx["F"], cfg_fx["T"], cfg_fx["L"]
    hd = d // H
    cfg = LS.make_config(V, "tiny", layers=L, heads=H, kv_heads=kvH, head_dim=hd, hidden=d, intermediate=Fd,
                         rope_theta=10000.0, max_pos=max(64, T + 1), eps=1e-6)
    model = LS.build_model_classes()(cfg).double()
    # llm_scratch 的 cos/sin 表在建構時以 float32 算（inv 與 arange 都 .float()），.double() 不會還原精度。
    # 這裡可選擇以 float64 重建（--rope64），用來區分「公式不同」與「表的精度」。
    if "--rope64" in sys.argv:
        half = hd // 2
        inv = 1.0 / (cfg["rope_theta"] ** (torch.arange(0, hd, 2, dtype=torch.float64) / hd))
        tt = torch.arange(cfg["max_pos"], dtype=torch.float64)
        fr = torch.outer(tt, inv)
        emb = torch.cat([fr, fr], dim=-1)
        model.cos_t = emb.cos()
        model.sin_t = emb.sin()

    def T_(x, shape):
        return torch.tensor(x, dtype=torch.float64).reshape(shape)

    init = fx["init"]
    sd = {}
    sd["emb.weight"] = T_(init["emb"], (V, d))
    sd["norm.weight"] = T_(init["nf"], (d,))
    for i, Lw in enumerate(init["layers"]):
        p = "layers.%d." % i
        sd[p + "n1.weight"] = T_(Lw["n1"], (d,))
        sd[p + "n2.weight"] = T_(Lw["n2"], (d,))
        # 基底 W 在 fixture 是 [輸入, 輸出]（y = x·W）；nn.Linear 的 weight 是 [輸出, 輸入]，故轉置
        sd[p + "q.weight"] = T_(Lw["Wq"], (d, d)).t()
        sd[p + "k.weight"] = T_(Lw["Wk"], (d, kvH * hd)).t()
        sd[p + "v.weight"] = T_(Lw["Wv"], (d, kvH * hd)).t()
        sd[p + "o.weight"] = T_(Lw["Wo"], (d, d)).t()
        sd[p + "qn.weight"] = T_(Lw["qn"], (hd,))
        sd[p + "kn.weight"] = T_(Lw["kn"], (hd,))
        sd[p + "mlp.gate.weight"] = T_(Lw["Wg"], (d, Fd)).t()
        sd[p + "mlp.up.weight"] = T_(Lw["Wu"], (d, Fd)).t()
        sd[p + "mlp.down.weight"] = T_(Lw["Wd"], (Fd, d)).t()
    missing, unexpected = model.load_state_dict(sd, strict=False)
    # 只允許 buffer（cos_t、sin_t 是非持久的）缺少
    real_missing = [k for k in missing if not k.endswith("_t")]
    assert not real_missing and not unexpected, ("對不上", real_missing, unexpected)

    tokens = torch.tensor(fx["batches"][0], dtype=torch.long)
    ids = tokens[:T].reshape(1, T)
    tgt = tokens[1:]
    am = torch.ones(1, T, dtype=torch.float64)
    pos = torch.arange(T).reshape(1, T)
    model.zero_grad()
    logits, _ = model(ids, am, pos)
    loss = F.cross_entropy(logits[0], tgt)
    loss.backward()
    ref_loss = fx["perStep"][0]["loss"]

    # 梯度對照（把 llm_scratch 的參數名對回 fixture 的名字，nn.Linear 的梯度要轉回 [輸入, 輸出]）
    def g_of(name):
        return model.get_parameter(name).grad.detach()
    pairs = {"emb": g_of("emb.weight"), "nf": g_of("norm.weight")}
    for i in range(L):
        p = "layers.%d." % i
        pairs["L%d.n1" % i] = g_of(p + "n1.weight")
        pairs["L%d.n2" % i] = g_of(p + "n2.weight")
        pairs["L%d.Wq" % i] = g_of(p + "q.weight").t()
        pairs["L%d.Wk" % i] = g_of(p + "k.weight").t()
        pairs["L%d.Wv" % i] = g_of(p + "v.weight").t()
        pairs["L%d.Wo" % i] = g_of(p + "o.weight").t()
        pairs["L%d.qn" % i] = g_of(p + "qn.weight")
        pairs["L%d.kn" % i] = g_of(p + "kn.weight")
        pairs["L%d.Wg" % i] = g_of(p + "mlp.gate.weight").t()
        pairs["L%d.Wu" % i] = g_of(p + "mlp.up.weight").t()
        pairs["L%d.Wd" % i] = g_of(p + "mlp.down.weight").t()
    worst = (0.0, "")
    for name, gt in pairs.items():
        ref = torch.tensor(fx["step1Grads"][name], dtype=torch.float64).reshape(gt.shape)
        dif = float((gt.detach().reshape(-1) - ref.reshape(-1)).abs().max())
        if dif > worst[0]:
            worst = (dif, name)
    print("cpu-py（llm_scratch.LM）步1損失 =", float(loss.detach()), " 參考 =", ref_loss, " 差 =", abs(float(loss.detach()) - ref_loss))
    print("cpu-py 步1 梯度（%d 個參數群）最大絕對誤差 = %.3e，最差 = %s" % (len(pairs), worst[0], worst[1]))
    # 門檻：P1 的 f32 門檻 1e-5（llm_scratch 的 RoPE 表是 float32 建的，見 --rope64 的診斷）
    ok = abs(float(loss.detach()) - ref_loss) < 1e-5 and worst[0] < 1e-5
    print("結果：", "通過" if ok else "未通過")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
