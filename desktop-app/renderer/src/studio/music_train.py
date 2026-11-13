#!/usr/bin/env python3
# 音樂作曲（music）訓練核心：從零開始的小型因果 Transformer（CPU，不需要 GPU）。
# 不是預訓練模型的微調：midigenai（約 1.13 億參數、授權的訓練資料未確認）太大，本機 CPU 不可行，所以換成很小的模型（約 0.3 百萬參數）。
# 資料：music_train_core.js gen 產生的符號（程式作曲的主旋律，有種子，見 music_train_core.js）。
#
# 子命令：
#   train --corpus <目錄> --out <目錄> [--steps --batch --lr --seed --d --layers --heads --ctx]
#         1) 訓練前：留出曲的 loss 與樣本（samples_before.jsonl）
#         2) 訓練：寫 log.jsonl
#         3) 訓練後：留出曲的 loss 與樣本（samples_after.jsonl）；寫 model.pt、config.json、vocab.json、train_meta.json
#         4) 樣本指標由 music_train_core.js decode 算（語法合格率、跳進合格率）
#   check --out <目錄>   從磁碟（新行程）重新載入 model.pt，用相同種子重新取樣，與 samples_after.jsonl 逐首比對
import argparse, hashlib, json, math, os, subprocess, sys, time

HERE = os.path.dirname(os.path.abspath(__file__))
CORE_JS = os.path.join(HERE, 'music_train_core.js')
BOS, EOS, PAD = 1, 2, 0

def sha256(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 20), b''):
            h.update(chunk)
    return h.hexdigest()

def build_model(V, d, layers, heads, ctx):
    import torch
    import torch.nn as nn

    class Tiny(nn.Module):
        def __init__(self):
            super().__init__()
            self.tok = nn.Embedding(V, d)
            self.pos = nn.Embedding(ctx, d)
            layer = nn.TransformerEncoderLayer(d_model=d, nhead=heads, dim_feedforward=4 * d, dropout=0.0, batch_first=True, norm_first=True)
            self.enc = nn.TransformerEncoder(layer, num_layers=layers, enable_nested_tensor=False)
            self.ln = nn.LayerNorm(d)
            self.head = nn.Linear(d, V, bias=False)
            self.register_buffer('mask', torch.triu(torch.full((ctx, ctx), float('-inf')), diagonal=1))

        def forward(self, x):
            T = x.shape[1]
            h = self.tok(x) + self.pos(torch.arange(T, device=x.device))[None]
            h = self.enc(h, mask=self.mask[:T, :T], is_causal=True)
            return self.head(self.ln(h))
    return Tiny()

def load_rows(path):
    return [json.loads(l) for l in open(path, encoding='utf-8') if l.strip()]

def batchify(rows, ctx):
    import torch
    L = min(ctx, max(len(r['ids']) for r in rows))
    x = torch.full((len(rows), L), PAD, dtype=torch.long)
    for i, r in enumerate(rows):
        ids = r['ids'][:L]
        x[i, :len(ids)] = torch.tensor(ids)
    return x

def eval_loss(model, rows, ctx):
    import torch
    import torch.nn.functional as F
    model.eval()
    tot, n = 0.0, 0
    with torch.no_grad():
        for s in range(0, len(rows), 32):
            x = batchify(rows[s:s + 32], ctx)
            logits = model(x[:, :-1])
            y = x[:, 1:]
            mask = y != PAD
            l = F.cross_entropy(logits.reshape(-1, logits.shape[-1]), y.reshape(-1), reduction='none')
            tot += float((l * mask.reshape(-1)).sum()); n += int(mask.sum())
    return tot / n

def sample_songs(model, styles, vocab_tokens, seed, ctx, max_len, per_style):
    # 每種風格取 per_style 首，溫度 1、無 top-k（誠實：不做任何挑選）；固定種子，同種子同結果
    import torch
    g = torch.Generator().manual_seed(seed)
    stid = {t: i for i, t in enumerate(vocab_tokens)}
    out = []
    model.eval()
    with torch.no_grad():
        for style in styles:
            for k in range(per_style):
                seq = [BOS, stid['S:' + style]]
                while len(seq) < max_len:
                    x = torch.tensor([seq[-ctx:]])
                    logits = model(x)[0, -1]
                    probs = torch.softmax(logits, dim=-1)
                    nxt = int(torch.multinomial(probs, 1, generator=g))
                    seq.append(nxt)
                    if nxt == EOS:
                        break
                out.append({'style': style, 'tokens': seq})
    return out

def write_jsonl(path, rows):
    with open(path, 'w', encoding='utf-8') as f:
        for r in rows:
            f.write(json.dumps(r, ensure_ascii=False) + '\n')

def decode_metrics(samples_path, out_dir):
    r = subprocess.run(['node', CORE_JS, 'decode', samples_path, out_dir, '0'], check=True, capture_output=True, text=True)
    return json.loads(open(os.path.join(out_dir, 'metrics.json'), encoding='utf-8').read())

def cmd_train(a):
    import numpy as np, torch
    torch.manual_seed(a.seed); np.random.seed(a.seed); torch.set_num_threads(8)
    # CPU 上的 embedding 反向傳播（index_add）在多執行緒時順序不固定，會造成 1e-6 等級的差異；用確定性演算法消除
    torch.use_deterministic_algorithms(True)
    os.makedirs(a.out, exist_ok=True)
    vocab = json.load(open(os.path.join(a.corpus, 'vocab.json'), encoding='utf-8'))['tokens']
    V = len(vocab)
    train = load_rows(os.path.join(a.corpus, 'train.jsonl'))
    evals = load_rows(os.path.join(a.corpus, 'eval.jsonl'))
    styles = sorted(set(r['style'] for r in evals))
    model = build_model(V, a.d, a.layers, a.heads, a.ctx)
    nparams = sum(p.numel() for p in model.parameters())
    t0 = time.time()

    loss_before = eval_loss(model, evals, a.ctx)
    samp_before = sample_songs(model, styles, vocab, a.sample_seed, a.ctx, a.max_len, a.per_style)
    write_jsonl(os.path.join(a.out, 'samples_before.jsonl'), samp_before)
    print('before eval loss', round(loss_before, 4), flush=True)

    opt = torch.optim.AdamW(model.parameters(), lr=a.lr, weight_decay=0.0)
    rng = np.random.RandomState(a.seed)
    log = open(os.path.join(a.out, 'log.jsonl'), 'w', encoding='utf-8')
    step = 0
    model.train()
    while step < a.steps:
        order = rng.permutation(len(train))
        for s in range(0, len(order) - a.batch + 1, a.batch):
            if step >= a.steps:
                break
            x = batchify([train[j] for j in order[s:s + a.batch]], a.ctx)
            logits = model(x[:, :-1])
            y = x[:, 1:]
            loss = torch.nn.functional.cross_entropy(logits.reshape(-1, V), y.reshape(-1), ignore_index=PAD)
            opt.zero_grad(); loss.backward(); torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0); opt.step()
            step += 1
            rec = {'step': step, 'loss': round(float(loss.item()), 6)}
            log.write(json.dumps(rec) + '\n')
            if step % 100 == 0 or step == 1:
                log.flush(); print(json.dumps(rec), flush=True)
            model.train()
    log.close()

    loss_after = eval_loss(model, evals, a.ctx)
    samp_after = sample_songs(model, styles, vocab, a.sample_seed, a.ctx, a.max_len, a.per_style)
    write_jsonl(os.path.join(a.out, 'samples_after.jsonl'), samp_after)
    print('after eval loss', round(loss_after, 4), flush=True)

    torch.save(model.state_dict(), os.path.join(a.out, 'model.pt'))
    json.dump({'format': 'fa-music-tiny', 'version': 1, 'V': V, 'd': a.d, 'layers': a.layers, 'heads': a.heads, 'ctx': a.ctx, 'max_len': a.max_len, 'styles': styles},
              open(os.path.join(a.out, 'config.json'), 'w', encoding='utf-8'), indent=1)
    json.dump({'format': 'fa-music-vocab', 'version': 1, 'tokens': vocab}, open(os.path.join(a.out, 'vocab.json'), 'w', encoding='utf-8'), ensure_ascii=False)

    losses = [json.loads(l)['loss'] for l in open(os.path.join(a.out, 'log.jsonl'), encoding='utf-8')]
    m_before = decode_metrics(os.path.join(a.out, 'samples_before.jsonl'), os.path.join(a.out, 'metrics_before'))
    m_after = decode_metrics(os.path.join(a.out, 'samples_after.jsonl'), os.path.join(a.out, 'metrics_after'))
    meta = {'steps': a.steps, 'batch': a.batch, 'lr': a.lr, 'seed': a.seed, 'sample_seed': a.sample_seed, 'params': nparams,
            'd': a.d, 'layers': a.layers, 'heads': a.heads, 'ctx': a.ctx, 'max_len': a.max_len,
            'train_songs': len(train), 'eval_songs': len(evals), 'eval_loss_before': loss_before, 'eval_loss_after': loss_after,
            'eval_ppl_before': math.exp(loss_before), 'eval_ppl_after': math.exp(loss_after),
            'train_loss_first': losses[0], 'train_loss_last': losses[-1],
            'metrics_before': m_before, 'metrics_after': m_after,
            'model_sha256': sha256(os.path.join(a.out, 'model.pt')), 'model_bytes': os.path.getsize(os.path.join(a.out, 'model.pt')),
            'seconds': round(time.time() - t0, 1)}
    json.dump(meta, open(os.path.join(a.out, 'train_meta.json'), 'w', encoding='utf-8'), indent=1)
    print('done', json.dumps({k: meta[k] for k in ['eval_loss_before', 'eval_loss_after', 'train_loss_first', 'train_loss_last', 'metrics_before', 'metrics_after', 'seconds']}, ensure_ascii=False), flush=True)

def load_model(out):
    import torch
    cfg = json.load(open(os.path.join(out, 'config.json'), encoding='utf-8'))
    m = build_model(cfg['V'], cfg['d'], cfg['layers'], cfg['heads'], cfg['ctx'])
    m.load_state_dict(torch.load(os.path.join(out, 'model.pt'), map_location='cpu', weights_only=True))
    m.eval()
    return m, cfg

def cmd_check(a):
    # 新行程、從磁碟載入、同樣的取樣種子：要與訓練時的樣本逐首相同
    import torch
    torch.set_num_threads(8)
    torch.use_deterministic_algorithms(True)
    m, cfg = load_model(a.out)
    vocab = json.load(open(os.path.join(a.out, 'vocab.json'), encoding='utf-8'))['tokens']
    evals = load_rows(os.path.join(a.corpus, 'eval.jsonl')) if a.corpus else None
    styles = cfg['styles']
    samp = sample_songs(m, styles, vocab, a.sample_seed, cfg['ctx'], cfg['max_len'], a.per_style)
    ref = load_rows(os.path.join(a.out, 'samples_after.jsonl'))
    same = sum(1 for x, y in zip(samp, ref) if x['tokens'] == y['tokens'])
    diff_before = None
    rb = load_rows(os.path.join(a.out, 'samples_before.jsonl'))
    diff_before = sum(1 for x, y in zip(samp, rb) if x['tokens'] == y['tokens'])
    print(json.dumps({'reloaded_songs_identical_to_training_run': same, 'of': len(samp), 'identical_to_untrained_run': diff_before}))
    write_jsonl(os.path.join(a.out, 'samples_reloaded.jsonl'), samp)

if __name__ == '__main__':
    p = argparse.ArgumentParser()
    sub = p.add_subparsers(dest='cmd', required=True)
    t = sub.add_parser('train')
    t.add_argument('--corpus', required=True); t.add_argument('--out', required=True)
    t.add_argument('--steps', type=int, default=1500); t.add_argument('--batch', type=int, default=16); t.add_argument('--lr', type=float, default=1e-3)
    t.add_argument('--seed', type=int, default=0); t.add_argument('--sample_seed', type=int, default=123)
    t.add_argument('--d', type=int, default=128); t.add_argument('--layers', type=int, default=2); t.add_argument('--heads', type=int, default=4)
    t.add_argument('--ctx', type=int, default=320); t.add_argument('--max_len', type=int, default=320); t.add_argument('--per_style', type=int, default=4)
    c = sub.add_parser('check'); c.add_argument('--out', required=True); c.add_argument('--corpus', default=None)
    c.add_argument('--sample_seed', type=int, default=123); c.add_argument('--per_style', type=int, default=4)
    a = p.parse_args()
    if a.cmd == 'train':
        cmd_train(a)
    else:
        cmd_check(a)
