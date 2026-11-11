#!/usr/bin/env python
"""網頁版 LoRA 訓練（逐層引擎，onnxruntime-web）的獨立 PyTorch 參考實作。

為什麼是這支：本機沒有 Qwen3-0.6B 的 PyTorch 基底權重，所以參考實作直接用「同一份量化 ONNX 的權重」
（由 scripts/webgpu-train/export-ref.js 匯出 weights.bin／weights.json，uint8 整張量縮放與零點，反量化成 float32）
在 PyTorch 裡用標準算子（autograd）重寫 Qwen3 的前向，與 JS 端的圖產生器／逐層引擎完全獨立。
比對的是「圖產生器＋引擎」是否算對，不是 HuggingFace 模型本身（那一層用真模型的前向交叉熵比，見設計文件 §5.6）。

用法：python webtrain_ref.py <匯出資料夾> <steps> <lr> <輸出json> [threads=2]
同一份 init.bin／seqs.json；第 i 步使用 seqs[i % n]；Adam(β=0.9/0.999, eps=1e-8)，LoRA 縮放 = alpha/rank = 2。
"""
import json, math, sys, time
import numpy as np
import torch

D, H, KV, HD, FF = 1024, 16, 8, 128, 3072


def main():
    dirp, steps, lr, out = sys.argv[1], int(sys.argv[2]), float(sys.argv[3]), sys.argv[4]
    torch.set_num_threads(int(sys.argv[5]) if len(sys.argv) > 5 else 2)
    idx = json.load(open(dirp + '/weights.json', encoding='utf8'))
    meta = json.load(open(dirp + '/meta.json', encoding='utf8'))
    seqs = json.load(open(dirp + '/seqs.json', encoding='utf8'))
    mm = np.memmap(dirp + '/weights.bin', dtype=np.uint8, mode='r')
    rank, T = meta['rank'], meta['T']
    s = idx['alpha'] / rank

    def W(key):
        e = idx['u8'][key]
        n = int(np.prod(e['shape']))
        a = np.array(mm[e['offset']:e['offset'] + n]).reshape(e['shape']).astype(np.float32)
        return torch.from_numpy((a - e['zp']) * e['scale'])

    def F(key):
        e = idx['f32'][key]
        return torch.tensor(e['data'], dtype=torch.float32).reshape(e['shape'])

    embed = W('embed')                      # [V, D]
    layers = []
    for l in range(idx['layers']):
        L = {k: W('l%d.%s' % (l, k)) for k in ['q', 'k', 'v', 'o', 'gate', 'up', 'down']}
        for g in ['n1', 'n2', 'qn', 'kn']:
            L[g] = F('l%d.%s' % (l, g))
        layers.append(L)
    fnorm = F('final_norm')
    cos, sin = F('cos'), F('sin')           # [256, 64]

    # LoRA 參數（init.bin：float32 串接，順序同 meta.params）
    flat = np.fromfile(dirp + '/init.bin', dtype=np.float32)
    params = {}
    off = 0
    for p in meta['params']:
        n = int(np.prod(p['shape']))
        params[p['name']] = torch.nn.Parameter(torch.from_numpy(flat[off:off + n].copy()).reshape(p['shape']))
        off += n
    plist = list(params.values())
    opt = torch.optim.Adam(plist, lr=lr, betas=(0.9, 0.999), eps=1e-8)

    mask = torch.triu(torch.full((T, T), -1e9), diagonal=1)
    C = torch.cat([cos[:T], cos[:T]], dim=-1)[:, None, :]   # [T,1,128]
    S = torch.cat([sin[:T], sin[:T]], dim=-1)[:, None, :]

    def rms(x, g):
        return x * torch.rsqrt((x * x).mean(-1, keepdim=True) + 1e-6) * g

    def rope(x):                             # x: [T, heads, 128]，rotate-half
        x1, x2 = x[..., :HD // 2], x[..., HD // 2:]
        return torch.cat([x1 * C[..., :HD // 2] - x2 * S[..., :HD // 2], x2 * C[..., HD // 2:] + x1 * S[..., HD // 2:]], dim=-1)

    def lin(x, l, k):
        return x @ layers[l][k] + s * ((x @ params['l%d.%s.A' % (l, k)]) @ params['l%d.%s.B' % (l, k)])

    def forward(ids, tgt):
        x = embed[torch.tensor(ids)]
        for l in range(idx['layers']):
            L = layers[l]
            n1 = rms(x, L['n1'])
            q = rope(rms(lin(n1, l, 'q').view(T, H, HD), L['qn']))
            k = rope(rms(lin(n1, l, 'k').view(T, KV, HD), L['kn']))
            v = lin(n1, l, 'v').view(T, KV, HD)
            qh = q.transpose(0, 1)                                   # [16,T,128]
            kh = k.transpose(0, 1).repeat_interleave(H // KV, dim=0)  # [16,T,128]
            vh = v.transpose(0, 1).repeat_interleave(H // KV, dim=0)
            p = torch.softmax(qh @ kh.transpose(1, 2) / math.sqrt(HD) + mask, dim=-1)
            ctx = (p @ vh).transpose(0, 1).reshape(T, H * HD)
            h1 = x + lin(ctx, l, 'o')
            n2 = rms(h1, L['n2'])
            x = h1 + lin(torch.nn.functional.silu(lin(n2, l, 'gate')) * lin(n2, l, 'up'), l, 'down')
        logits = rms(x, fnorm) @ embed.t()
        return torch.nn.functional.cross_entropy(logits, torch.tensor(tgt))

    res = {'steps': [], 'torch': torch.__version__, 'threads': torch.get_num_threads()}
    for i in range(steps):
        sq = seqs[i % len(seqs)]
        t0 = time.time()
        opt.zero_grad()
        loss = forward(sq['ids'], sq['tgt'])
        loss.backward()
        gn = math.sqrt(sum(float((p.grad ** 2).sum()) for p in plist))
        opt.step()
        res['steps'].append({'step': i + 1, 'loss': float(loss), 'gradNorm': gn, 'sec': round(time.time() - t0, 2)})
        print(json.dumps(res['steps'][-1]), flush=True)
        json.dump(res, open(out, 'w'))


if __name__ == '__main__':
    main()
