#!/usr/bin/env python3
"""語音合成（Kokoro-82M）的離線訓練：只訓練「語音包」的風格偏移（256 維），其餘權重凍結。

為什麼只訓練風格偏移：Kokoro 的語音包就是 510×256 的 float32（`voices/<代號>.bin`，522,240 位元組），
推論時每段依音素數取一列當 ref_s。把訓練結果寫成同樣格式的 .bin，就能被既有的語音載入路徑使用，
不必重新匯出整個模型（完整微調見 DESIGN.offline-training-studio.md §14）。

子命令：
  make-teacher  用一個既有語音合成教師資料（文字、音訊、音素、時長），輸出 voice-sample 風格的 JSONL 配對。
  train         讀配對資料，訓練風格偏移；記錄 loss；輸出 voice .bin、摘要 JSON。
  synth         用 .bin（或內建 .pt）合成文字，輸出 WAV 與統計（長度、取樣率、RMS）。

損失：多解析度 STFT（頻譜收斂＋對數幅度 L1），對象是教師音訊。學生與教師用**同一組時長**對齊，
所以兩段音訊等長、可逐點比較（訓練時不用學生自己的時長預測器）。

執行環境：CPU，PyTorch，kokoro 0.9.4。所有隨機來源都固定種子。
"""
import argparse
import hashlib
import json
import os
import random
import sys
import time
import zlib

import numpy as np
import soundfile as sf
import torch
import torch.nn.functional as F

SR = 24000
N_VOICE_ROWS = 510
STYLE_DIM = 256
BIN_BYTES = N_VOICE_ROWS * STYLE_DIM * 4  # 522,240


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def seed_all(seed):
    random.seed(seed)
    np.random.seed(seed)
    torch.manual_seed(seed)


def load_model(config, weights):
    from kokoro import KModel

    m = KModel(repo_id="hexgrad/Kokoro-82M", config=config, model=weights)
    m.eval()
    for p in m.parameters():
        p.requires_grad_(False)
    return m


def load_pack(path):
    """讀 .pt（torch.save 的語音包）或 .bin（原始 float32，510×256）。回傳 (510, 1, 256) 的 float32 張量。"""
    if path.endswith(".pt"):
        pack = torch.load(path, weights_only=True).float()
    else:
        raw = np.fromfile(path, dtype="<f4")
        if raw.size * 4 != BIN_BYTES:
            raise ValueError(f"語音包大小不對：{path} 是 {raw.size * 4} 位元組，應為 {BIN_BYTES}")
        pack = torch.from_numpy(raw.reshape(N_VOICE_ROWS, 1, STYLE_DIM).copy())
    if tuple(pack.shape) != (N_VOICE_ROWS, 1, STYLE_DIM):
        raise ValueError(f"語音包形狀不對：{tuple(pack.shape)}")
    return pack


def write_bin(pack, path):
    arr = pack.detach().reshape(N_VOICE_ROWS, STYLE_DIM).cpu().numpy().astype("<f4")
    with open(path, "wb") as f:
        f.write(arr.tobytes())
    return os.path.getsize(path)


def phoneme_ids(m, ps):
    ids = [m.vocab[p] for p in ps if p in m.vocab]
    return torch.LongTensor([[0, *ids, 0]])


def forward(m, input_ids, ref_s, pred_dur=None):
    """與 kokoro KModel.forward_with_tokens 相同的計算，但不包 no_grad，且可傳入固定的時長（訓練用）。
    pred_dur 為 None 時用模型自己的時長預測（推論）。回傳 (audio, pred_dur)。"""
    input_lengths = torch.full((input_ids.shape[0],), input_ids.shape[-1], dtype=torch.long)
    text_mask = torch.arange(input_lengths.max()).unsqueeze(0).expand(input_lengths.shape[0], -1).type_as(input_lengths)
    text_mask = torch.gt(text_mask + 1, input_lengths.unsqueeze(1))
    bert_dur = m.bert(input_ids, attention_mask=(~text_mask).int())
    d_en = m.bert_encoder(bert_dur).transpose(-1, -2)
    s = ref_s[:, 128:]
    d = m.predictor.text_encoder(d_en, s, input_lengths, text_mask)
    if pred_dur is None:
        x, _ = m.predictor.lstm(d)
        duration = torch.sigmoid(m.predictor.duration_proj(x)).sum(axis=-1)
        pred_dur = torch.round(duration).clamp(min=1).long().squeeze()
    indices = torch.repeat_interleave(torch.arange(input_ids.shape[1]), pred_dur)
    aln = torch.zeros((input_ids.shape[1], indices.shape[0]))
    aln[indices, torch.arange(indices.shape[0])] = 1
    aln = aln.unsqueeze(0)
    en = d.transpose(-1, -2) @ aln
    F0_pred, N_pred = m.predictor.F0Ntrain(en, s)
    t_en = m.text_encoder(input_ids, input_lengths, text_mask)
    asr = t_en @ aln
    audio = m.decoder(asr, F0_pred, N_pred, ref_s[:, :128]).squeeze()
    return audio, pred_dur


def stft_loss(pred, target):
    """多解析度 STFT 損失：頻譜收斂 + 對數幅度 L1，取三組解析度平均。"""
    n = min(pred.shape[-1], target.shape[-1])
    pred, target = pred[..., :n], target[..., :n]
    total = 0.0
    for n_fft, hop in ((512, 128), (1024, 256), (256, 64)):
        win = torch.hann_window(n_fft)
        sp = torch.stft(pred, n_fft, hop, window=win, return_complex=True).abs().clamp(min=1e-5)
        st = torch.stft(target, n_fft, hop, window=win, return_complex=True).abs().clamp(min=1e-5)
        sc = torch.norm(st - sp, p="fro") / (torch.norm(st, p="fro") + 1e-7)
        mag = F.l1_loss(torch.log(sp), torch.log(st))
        total = total + sc + mag
    return total / 3.0


def read_jsonl(path):
    rows = []
    with open(path, encoding="utf-8") as f:
        for i, line in enumerate(f, 1):
            line = line.strip()
            if not line:
                continue
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError as e:
                raise ValueError(f"{path}:{i} 不是合法 JSON：{e}")
    return rows


def cmd_make_teacher(a):
    from kokoro import KPipeline

    seed_all(a.seed)
    m = load_model(a.config, a.weights)
    teacher = load_pack(a.teacher_voice)
    pipe = KPipeline(lang_code="a", model=m)
    texts = json.load(open(a.texts, encoding="utf-8"))
    os.makedirs(os.path.join(a.out, "audio"), exist_ok=True)
    rows = []
    for idx, text in enumerate(texts):
        # 先用 pipeline 取音素（只做文字處理，不做推論）
        ps = None
        for res in pipe(text, voice=teacher, model=m):
            ps = res.phonemes  # 單句通常只有一段；多段會在下方被拒絕
        if not ps or len(ps) > 500:
            raise ValueError(f"第 {idx} 句的音素數不合適：{len(ps or '')}（需要 1～500）")
        ids = phoneme_ids(m, ps)
        with torch.no_grad():
            audio, dur = forward(m, ids, teacher[len(ps) - 1])
        audio = audio.squeeze().cpu().numpy().astype(np.float32)
        wav = os.path.join("audio", f"{a.split}_{idx:03d}.wav")
        sf.write(os.path.join(a.out, wav), audio, SR, subtype="PCM_16")
        rows.append({
            "id": f"{a.split}_{idx:03d}",
            "text": text,
            "phonemes": ps,
            "audio": wav,
            "sr": SR,
            "pred_dur": [int(x) for x in dur.reshape(-1).tolist()],
            "split": a.split,
            "source": {"kind": "teacher", "model": "hexgrad/Kokoro-82M", "voice": os.path.basename(a.teacher_voice)},
        })
    with open(os.path.join(a.out, f"{a.split}.jsonl"), "w", encoding="utf-8") as f:
        for r in rows:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")
    print(json.dumps({"ok": True, "rows": len(rows), "out": a.out}, ensure_ascii=False))


def sample_loss(m, row, base_pack, delta, data_dir, target_cache):
    ps = row["phonemes"]
    ids = phoneme_ids(m, ps)
    ref = base_pack[len(ps) - 1] + delta  # 與 kokoro KPipeline.infer 相同：pack[len(ps)-1]，再加上可訓練的風格偏移
    if row["id"] not in target_cache:
        wav, sr = sf.read(os.path.join(data_dir, row["audio"]), dtype="float32")
        assert sr == SR, f"取樣率應為 {SR}，實際 {sr}"
        target_cache[row["id"]] = torch.from_numpy(wav)
    target = target_cache[row["id"]]
    dur = torch.tensor(row["pred_dur"], dtype=torch.long)
    # 解碼器的正弦源會抽隨機雜訊（torch.rand／randn），每句用固定種子，讓同一組參數的損失可重現
    torch.manual_seed(zlib.crc32(row["id"].encode("utf-8")) & 0x7FFFFFFF)
    audio, _ = forward(m, ids, ref.reshape(1, STYLE_DIM), pred_dur=dur)
    return stft_loss(audio.reshape(-1), target.reshape(-1))


def heldout_loss(m, rows, base_pack, delta, data_dir, cache):
    with torch.no_grad():
        vals = [float(sample_loss(m, r, base_pack, delta, data_dir, cache)) for r in rows]
    return float(np.mean(vals))


def cmd_train(a):
    seed_all(a.seed)
    os.makedirs(a.out, exist_ok=True)
    m = load_model(a.config, a.weights)
    base = load_pack(a.base_voice)
    train_rows = read_jsonl(os.path.join(a.data, "train.jsonl"))
    held_rows = read_jsonl(os.path.join(a.data, "heldout.jsonl"))
    if not train_rows:
        raise SystemExit("訓練資料是空的")
    delta = torch.zeros(STYLE_DIM, requires_grad=True)
    opt = torch.optim.Adam([delta], lr=a.lr)
    cache = {}
    log_path = os.path.join(a.out, "log.jsonl")
    logf = open(log_path, "w", encoding="utf-8")

    def log(obj):
        logf.write(json.dumps(obj, ensure_ascii=False) + "\n")
        logf.flush()

    h0 = heldout_loss(m, held_rows, base, delta.detach(), a.data, cache)
    log({"event": "eval", "step": 0, "heldout_loss": h0})
    order_rng = random.Random(a.seed)
    t0 = time.time()
    step = 0
    while step < a.steps:
        perm = list(range(len(train_rows)))
        order_rng.shuffle(perm)
        for i in perm:
            if step >= a.steps:
                break
            step += 1
            opt.zero_grad()
            loss = sample_loss(m, train_rows[i], base, delta, a.data, cache)
            loss.backward()
            gnorm = float(delta.grad.norm())
            opt.step()
            log({"event": "train", "step": step, "row": train_rows[i]["id"], "loss": float(loss), "grad_norm": gnorm,
                 "elapsed_s": round(time.time() - t0, 2)})
            if step % a.eval_every == 0 or step == a.steps:
                h = heldout_loss(m, held_rows, base, delta.detach(), a.data, cache)
                log({"event": "eval", "step": step, "heldout_loss": h})
    h1 = heldout_loss(m, held_rows, base, delta.detach(), a.data, cache)
    logf.close()

    trained = base + delta.detach().reshape(1, 1, STYLE_DIM)
    bin_path = os.path.join(a.out, "voice_trained.bin")
    size = write_bin(trained, bin_path)
    torch.save({"delta": delta.detach(), "seed": a.seed, "lr": a.lr, "steps": a.steps}, os.path.join(a.out, "delta.pt"))
    train_losses = [json.loads(l) for l in open(log_path, encoding="utf-8") if '"train"' in l]
    summary = {
        "format": "fa-speech-style",
        "version": 1,
        "base_voice": os.path.basename(a.base_voice),
        "teacher": train_rows[0].get("source") or {},
        "trainable": {"name": "style_delta", "shape": [STYLE_DIM], "params": STYLE_DIM},
        "steps": step,
        "lr": a.lr,
        "seed": a.seed,
        "train_rows": len(train_rows),
        "heldout_rows": len(held_rows),
        "train_loss_first": train_losses[0]["loss"],
        "train_loss_last": train_losses[-1]["loss"],
        "heldout_loss_before": h0,
        "heldout_loss_after": h1,
        "voice_bin": {"file": "voice_trained.bin", "bytes": size, "sha256": sha256_file(bin_path)},
        "delta_sha256": hashlib.sha256(delta.detach().numpy().astype("<f4").tobytes()).hexdigest(),
        "elapsed_s": round(time.time() - t0, 1),
    }
    with open(os.path.join(a.out, "summary.json"), "w", encoding="utf-8") as f:
        json.dump(summary, f, ensure_ascii=False, indent=2)
    print(json.dumps(summary, ensure_ascii=False, indent=2))


def cmd_synth(a):
    from kokoro import KPipeline

    m = load_model(a.config, a.weights)
    pack = load_pack(a.voice)
    pipe = KPipeline(lang_code="a", model=m)
    chunks = []
    for res in pipe(a.text, voice=pack, model=m):
        chunks.append(res.output.audio.detach().cpu().numpy().astype(np.float32))
    audio = np.concatenate(chunks) if chunks else np.zeros(0, np.float32)
    sf.write(a.out, audio, SR, subtype="PCM_16")
    print(json.dumps({
        "voice": os.path.basename(a.voice),
        "out": a.out,
        "sr": SR,
        "samples": int(audio.shape[0]),
        "seconds": round(audio.shape[0] / SR, 3),
        "rms": round(float(np.sqrt(np.mean(audio ** 2))), 5) if audio.size else 0.0,
        "sha256": sha256_file(a.out),
    }, ensure_ascii=False))


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--config", required=False)
    ap.add_argument("--weights", required=False)
    sub = ap.add_subparsers(dest="cmd", required=True)

    t = sub.add_parser("make-teacher")
    t.add_argument("--texts", required=True)
    t.add_argument("--teacher-voice", required=True)
    t.add_argument("--out", required=True)
    t.add_argument("--split", default="train")
    t.add_argument("--seed", type=int, default=0)

    tr = sub.add_parser("train")
    tr.add_argument("--data", required=True, help="含 train.jsonl 與 heldout.jsonl 的資料夾")
    tr.add_argument("--base-voice", required=True)
    tr.add_argument("--out", required=True)
    tr.add_argument("--steps", type=int, default=40)
    tr.add_argument("--lr", type=float, default=5e-3)
    tr.add_argument("--seed", type=int, default=0)
    tr.add_argument("--eval-every", type=int, default=10)

    sy = sub.add_parser("synth")
    sy.add_argument("--voice", required=True, help=".bin 或 .pt 語音包")
    sy.add_argument("--text", required=True)
    sy.add_argument("--out", required=True)

    a = ap.parse_args()
    if not a.config or not a.weights:
        ap.error("需要 --config 與 --weights（Kokoro-82M 的 config.json 與 kokoro-v1_0.pth）")
    {"make-teacher": cmd_make_teacher, "train": cmd_train, "synth": cmd_synth}[a.cmd](a)


if __name__ == "__main__":
    sys.exit(main())
