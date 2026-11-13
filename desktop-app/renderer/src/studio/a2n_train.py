#!/usr/bin/env python3
# 音訊轉音符（audio_to_notes）的全參數微調核心（CPU，不需要 GPU）。
# 基底：Basic Pitch 的 nmp.onnx（Apache-2.0，230,444 位元組，36k 參數左右，SHA-256 2c3c1d14…59a0ec）。
# 做法：用 onnx2torch 轉成 torch 模組（與 onnxruntime 的輸出差 < 1e-6），在合成資料上微調 onset／note 兩個輸出，
#       再用 torch.onnx.export 匯回 ONNX（輸入形狀、輸出順序與原檔相同，basic_pitch.js 不需要改）。
#
# 子命令：
#   train --onnx <nmp.onnx> --train <資料目錄> --eval <資料目錄> --out <目錄> [--steps --batch --lr --seed]
#         1) 基底在驗證集上的預測 → pred_before/，用 a2n_train_core.js metrics 算 F1
#         2) 微調，寫 log.jsonl
#         3) 驗證集預測 → pred_after/，算 F1；匯出 model.onnx；用 onnxruntime 載入 model.onnx 重跑，比對與 torch 的差與基底的差
#   check --onnx <model.onnx> --base <nmp.onnx> --eval <資料目錄> --out <目錄>  （只做載入與比對，不訓練）
import argparse, hashlib, json, os, subprocess, sys, time
import types

HERE = os.path.dirname(os.path.abspath(__file__))
CORE_JS = os.path.join(HERE, 'a2n_train_core.js')

# ---- onnx2torch 相容補丁 ----
# (1) 這台機器的 torchvision 與 torch 的 C 擴充不符，onnx2torch 在 import 時會失敗；本模型不用 NMS／RoIAlign，所以用空模組代替。
# (2) onnx2torch 的 reflect 補邊只支援 3 維以內；Basic Pitch 的 CQT 前端在 5 維張量上做反射補邊，改成逐維取索引（與 ONNX Pad 語意相同）。
def _install_patches():
    tv = types.ModuleType('torchvision'); ops = types.ModuleType('torchvision.ops')
    ops.nms = None; ops.roi_align = None; tv.ops = ops
    sys.modules['torchvision'] = tv; sys.modules['torchvision.ops'] = ops
    import torch
    import torch.nn.functional as F
    from onnx2torch.node_converters import pad as _pad

    def _pad_forward(self, input_tensor, pads, constant_value=0.0):
        n = input_tensor.dim()
        p = [int(v) for v in pads.tolist()]
        begin, end = p[:n], p[n:]
        if self.mode == 'constant':
            tp = []
            for d in reversed(range(n)):
                tp.extend([begin[d], end[d]])
            return F.pad(input_tensor, pad=tp, mode='constant', value=float(constant_value or 0.0))
        out = input_tensor
        for d in range(n):
            b, e = begin[d], end[d]
            if b == 0 and e == 0:
                continue
            L = out.shape[d]
            i = torch.arange(-b, L + e)
            if self.mode == 'reflect':
                period = 2 * (L - 1)
                j = torch.remainder(i, period) if L > 1 else torch.zeros_like(i)
                j = torch.where(j >= L, period - j, j)
            else:
                j = i.clamp(0, L - 1)
            out = out.index_select(d, j)
        return out
    _pad.OnnxPadDynamic.forward = _pad_forward

def load_torch_model(onnx_path):
    _install_patches()
    import onnx2torch
    m = onnx2torch.convert(onnx_path)
    m.eval()
    return m

def sha256(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 20), b''):
            h.update(chunk)
    return h.hexdigest()

def read_index(data_dir):
    idx = json.load(open(os.path.join(data_dir, 'index.json'), encoding='utf-8'))
    assert idx['format'] == 'fa-a2n-synth' and idx['win'] == 43844 and idx['frames'] == 172 and idx['bins'] == 88, idx
    return idx

def load_clip(data_dir, i):
    import numpy as np
    x = np.fromfile(os.path.join(data_dir, 'clip_%d.f32' % i), dtype='<f4')
    on = np.fromfile(os.path.join(data_dir, 'clip_%d.onset.u8' % i), dtype=np.uint8).reshape(172, 88)
    nt = np.fromfile(os.path.join(data_dir, 'clip_%d.note.u8' % i), dtype=np.uint8).reshape(172, 88)
    return x, on.astype(np.float32), nt.astype(np.float32)

def predict_dir(model, data_dir, out_dir, batch=8):
    # 寫出 clip_i.onset.f32／clip_i.note.f32（172×88，float32 小端）給 a2n_train_core.js metrics 讀
    import numpy as np, torch
    os.makedirs(out_dir, exist_ok=True)
    idx = read_index(data_dir)
    clips = idx['clips']
    with torch.no_grad():
        for s in range(0, len(clips), batch):
            ch = clips[s:s + batch]
            x = torch.from_numpy(np.stack([load_clip(data_dir, c['i'])[0] for c in ch])).reshape(len(ch), 43844, 1)
            onset, note, _contour = model(x)
            for k, c in enumerate(ch):
                onset[k].numpy().astype('<f4').tofile(os.path.join(out_dir, 'clip_%d.onset.f32' % c['i']))
                note[k].numpy().astype('<f4').tofile(os.path.join(out_dir, 'clip_%d.note.f32' % c['i']))
    return len(clips)

def run_metrics(pred_dir, data_dir, thr=0.5):
    r = subprocess.run(['node', CORE_JS, 'metrics', pred_dir, data_dir, str(thr)], check=True, capture_output=True, text=True)
    return json.loads(r.stdout)

def ort_outputs(onnx_path, data_dir, n=4):
    import numpy as np, onnxruntime as ort
    s = ort.InferenceSession(onnx_path, providers=['CPUExecutionProvider'])
    name = s.get_inputs()[0].name
    idx = read_index(data_dir)
    outs = []
    for c in idx['clips'][:n]:
        x = load_clip(data_dir, c['i'])[0].reshape(1, 43844, 1).astype(np.float32)
        outs.append(s.run(None, {name: x}))
    return outs

def wbce(p, t, pos_w):
    # 加權二元交叉熵（p 已是機率）。正例（起音、音符幀）極少，pos_w>1 讓正例不被壓成 0。
    import torch
    eps = 1e-6
    p = p.clamp(eps, 1 - eps)
    return -(pos_w * t * torch.log(p) + (1 - t) * torch.log(1 - p)).mean()

def cmd_train(a):
    import numpy as np, torch
    import torch.nn.functional as F
    torch.manual_seed(a.seed); np.random.seed(a.seed); torch.set_num_threads(8)
    os.makedirs(a.out, exist_ok=True)
    model = load_torch_model(a.onnx)
    tr_idx = read_index(a.train)
    t0 = time.time()
    predict_dir(model, a.eval, os.path.join(a.out, 'pred_before'))
    before = run_metrics(os.path.join(a.out, 'pred_before'), a.eval)
    print('before', json.dumps(before), flush=True)

    # 凍結 CQT 前端（名稱含 cq_t2010v2 的固定濾波器組）：它的 Sqrt／Log 在零振幅處會得到 NaN 梯度；
    # 這一段是訊號處理，不是要學的部分。只微調它後面的卷積主幹與輸出頭。
    frozen = 0
    for name, prm in model.named_parameters():
        if 'cq_t2010v2' in name:
            prm.requires_grad_(False); frozen += prm.numel()
    trainable = [prm for prm in model.parameters() if prm.requires_grad]
    print('frozen CQT front end params', frozen, 'trainable', sum(prm.numel() for prm in trainable), flush=True)
    model.train()
    opt = torch.optim.AdamW(trainable, lr=a.lr, weight_decay=0.0)
    rng = np.random.RandomState(a.seed)
    clips = tr_idx['clips']
    log = open(os.path.join(a.out, 'log.jsonl'), 'w', encoding='utf-8')
    step = 0
    while step < a.steps:
        order = rng.permutation(len(clips))
        for s in range(0, len(order) - a.batch + 1, a.batch):
            if step >= a.steps:
                break
            ch = [clips[j] for j in order[s:s + a.batch]]
            loaded = [load_clip(a.train, c['i']) for c in ch]
            x = torch.from_numpy(np.stack([l[0] for l in loaded])).reshape(len(ch), 43844, 1)
            yo = torch.from_numpy(np.stack([l[1] for l in loaded]))
            yn = torch.from_numpy(np.stack([l[2] for l in loaded]))
            onset, note, _c = model(x)
            loss = wbce(onset, yo, a.pos_w_onset) + wbce(note, yn, a.pos_w_note)
            opt.zero_grad(); loss.backward(); opt.step()
            step += 1
            rec = {'step': step, 'loss': round(float(loss.item()), 6)}
            log.write(json.dumps(rec) + '\n'); log.flush()
            if step % 20 == 0 or step == 1:
                print(json.dumps(rec), flush=True)
    log.close()
    model.eval()
    predict_dir(model, a.eval, os.path.join(a.out, 'pred_after'))
    after = run_metrics(os.path.join(a.out, 'pred_after'), a.eval)
    print('after', json.dumps(after), flush=True)

    # 匯出回 ONNX（輸入名稱與形狀同原檔；批次維可變）
    model_path = os.path.join(a.out, 'model.onnx')
    dummy = torch.zeros(1, 43844, 1)
    in_name = 'serving_default_input_2:0'
    torch.onnx.export(model, (dummy,), model_path, input_names=[in_name],
                      output_names=['onset', 'note', 'contour'],
                      dynamic_axes={in_name: {0: 'batch'}, 'onset': {0: 'batch'}, 'note': {0: 'batch'}, 'contour': {0: 'batch'}},
                      opset_version=17, dynamo=False)
    chk = check_export(model, model_path, a.onnx, a.eval, a.out)
    losses = [json.loads(l)['loss'] for l in open(os.path.join(a.out, 'log.jsonl'), encoding='utf-8')]
    meta = {'base': 'Basic Pitch nmp.onnx', 'base_sha256': sha256(a.onnx), 'steps': a.steps, 'pos_w_onset': a.pos_w_onset, 'pos_w_note': a.pos_w_note, 'batch': a.batch, 'lr': a.lr, 'seed': a.seed,
            'train_clips': len(clips), 'eval_clips': len(read_index(a.eval)['clips']),
            'params_total': sum(p.numel() for p in model.parameters()), 'params_frozen_cqt': frozen, 'params_trainable': sum(p.numel() for p in trainable),
            'loss_first': losses[0], 'loss_last': losses[-1], 'before': before, 'after': after,
            'export': chk, 'model_sha256': sha256(model_path), 'model_bytes': os.path.getsize(model_path),
            'seconds': round(time.time() - t0, 1)}
    json.dump(meta, open(os.path.join(a.out, 'train_meta.json'), 'w', encoding='utf-8'), indent=1)
    print('done', json.dumps({k: meta[k] for k in ['loss_first', 'loss_last', 'before', 'after', 'export', 'seconds']}), flush=True)

def check_export(model, model_path, base_onnx, eval_dir, out_dir):
    # 用 onnxruntime 載入匯出的檔案：與 torch 比（應幾乎相同），與原始基底比（應不同）
    import numpy as np, torch
    ft = ort_outputs(model_path, eval_dir, n=4)
    bs = ort_outputs(base_onnx, eval_dir, n=4)
    torch_out = []
    with torch.no_grad():
        for c in read_index(eval_dir)['clips'][:4]:
            x = torch.from_numpy(load_clip(eval_dir, c['i'])[0]).reshape(1, 43844, 1)
            o, n_, _c = model(x)
            torch_out.append((o.numpy(), n_.numpy()))
    d_torch = max(float(np.max(np.abs(ft[k][0] - torch_out[k][0]))) for k in range(4))
    d_torch = max(d_torch, max(float(np.max(np.abs(ft[k][1] - torch_out[k][1]))) for k in range(4)))
    d_base = max(float(np.max(np.abs(ft[k][0] - bs[k][0]))) for k in range(4))
    return {'ort_vs_torch_max_abs': d_torch, 'ort_ft_vs_base_max_abs': d_base,
            'ort_outputs_shape': [list(o.shape) for o in ft[0]], 'input_name': 'serving_default_input_2:0'}

def cmd_check(a):
    ft = ort_outputs(a.onnx, a.eval, n=4); bs = ort_outputs(a.base, a.eval, n=4)
    import numpy as np
    d = max(float(np.max(np.abs(ft[k][0] - bs[k][0]))) for k in range(4))
    print(json.dumps({'ort_loads': True, 'ft_vs_base_max_abs_onset': d, 'shapes': [list(o.shape) for o in ft[0]]}))

if __name__ == '__main__':
    p = argparse.ArgumentParser()
    sub = p.add_subparsers(dest='cmd', required=True)
    t = sub.add_parser('train')
    t.add_argument('--onnx', required=True); t.add_argument('--train', required=True); t.add_argument('--eval', required=True); t.add_argument('--out', required=True)
    t.add_argument('--pos_w_onset', type=float, default=1.0); t.add_argument('--pos_w_note', type=float, default=1.0)
    t.add_argument('--steps', type=int, default=200); t.add_argument('--batch', type=int, default=4); t.add_argument('--lr', type=float, default=1e-4); t.add_argument('--seed', type=int, default=0)
    c = sub.add_parser('check'); c.add_argument('--onnx', required=True); c.add_argument('--base', required=True); c.add_argument('--eval', required=True); c.add_argument('--out', default='.')
    a = p.parse_args()
    if a.cmd == 'train':
        cmd_train(a)
    else:
        cmd_check(a)
