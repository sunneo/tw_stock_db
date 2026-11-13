#!/usr/bin/env python3
# 語音辨識（speech_recognition）的 LoRA 訓練核心（桌面版、純處理器 CPU，不需要 GPU）。
# 基底：openai/whisper-tiny（39M 參數，比 base 更小，本機 CPU 可行）。只在 q_proj／v_proj 掛 LoRA。
#
# 子命令：
#   prep  --parquet <檔> --out <目錄>        把 LibriSpeech 類 parquet（audio.bytes 為 FLAC）解成 16 kHz 單聲道 WAV，寫 data.jsonl
#   train --base <目錄> --data <data.jsonl> --out <目錄> [--steps --batch --lr --rank --alpha --seed]
#         先在驗證集上跑基底（hyp_before.json），再訓練 LoRA，寫 adapter、log.jsonl、hyp_after.json、report.json
#   check --base <目錄> --adapter <目錄> --data <data.jsonl> --hyp <hyp_after.json>
#         從磁碟重新載入基底＋adapter，重跑驗證集，確認輸出與訓練後一致、與基底不同（實測用）
#
# 資料格式（data.jsonl，每行一筆）：{"id":"…","audio":"相對於 data.jsonl 的 wav 路徑","text":"參考文字","split":"train"|"eval"}
# 切分規則與 sr_train_core.js 的 splitRows 相同：列號 % 4 == 0 為 eval，其餘 train。
import argparse, hashlib, json, os, random, subprocess, sys, time

def sha256(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 20), b''):
            h.update(chunk)
    return h.hexdigest()

def normalize(s):
    # 與 sr_train_core.js 的 normalizeText 相同：小寫、去標點（保留撇號）、壓縮空白
    import re
    s = re.sub(r"[^\w' ]|_", ' ', s.lower())
    return re.sub(r'\s+', ' ', s).strip()

def seed_all(seed):
    import numpy as np
    import torch
    random.seed(seed); np.random.seed(seed); torch.manual_seed(seed)
    torch.set_num_threads(8)

def cmd_prep(a):
    import pyarrow.parquet as pq
    os.makedirs(os.path.join(a.out, 'wav'), exist_ok=True)
    table = pq.read_table(a.parquet).to_pylist()
    rows = []
    for i, r in enumerate(table):
        wav = os.path.join(a.out, 'wav', r['id'] + '.wav')
        if not os.path.exists(wav):
            subprocess.run(['ffmpeg', '-loglevel', 'error', '-y', '-i', 'pipe:0', '-ac', '1', '-ar', '16000', wav],
                           input=r['audio']['bytes'], check=True)
        rows.append({'id': r['id'], 'audio': os.path.join('wav', r['id'] + '.wav'), 'text': r['text'],
                     'split': 'eval' if i % 4 == 0 else 'train'})
    with open(os.path.join(a.out, 'data.jsonl'), 'w', encoding='utf-8') as f:
        for r in rows:
            f.write(json.dumps(r, ensure_ascii=False) + '\n')
    print(json.dumps({'rows': len(rows), 'train': sum(r['split'] == 'train' for r in rows),
                      'eval': sum(r['split'] == 'eval' for r in rows)}))

def load_rows(data_path):
    base_dir = os.path.dirname(os.path.abspath(data_path))
    rows = [json.loads(l) for l in open(data_path, encoding='utf-8') if l.strip()]
    for r in rows:
        r['abs'] = os.path.join(base_dir, r['audio'])
    return rows

def load_audio(path):
    import numpy as np
    import wave
    with wave.open(path, 'rb') as w:
        assert w.getframerate() == 16000 and w.getnchannels() == 1 and w.getsampwidth() == 2, path
        raw = w.readframes(w.getnframes())
    return np.frombuffer(raw, dtype='<i2').astype(np.float32) / 32768.0

def transcribe(model, processor, rows, batch=8):
    import torch
    out = []
    model.eval()
    with torch.no_grad():
        for i in range(0, len(rows), batch):
            chunk = rows[i:i + batch]
            feats = processor.feature_extractor([load_audio(r['abs']) for r in chunk], sampling_rate=16000, return_tensors='pt').input_features
            ids = model.generate(feats, language='en', task='transcribe', max_new_tokens=120)
            for r, t in zip(chunk, processor.batch_decode(ids, skip_special_tokens=True)):
                out.append({'id': r['id'], 'ref': r['text'], 'hyp': t.strip()})
    return out

def cmd_train(a):
    import torch
    from transformers import WhisperForConditionalGeneration, WhisperProcessor
    from peft import LoraConfig, get_peft_model
    import numpy as np
    seed_all(a.seed)
    os.makedirs(a.out, exist_ok=True)
    rows = load_rows(a.data)
    train = [r for r in rows if r['split'] == 'train']
    evals = [r for r in rows if r['split'] == 'eval']
    processor = WhisperProcessor.from_pretrained(a.base)
    model = WhisperForConditionalGeneration.from_pretrained(a.base, dtype=torch.float32)
    model.config.forced_decoder_ids = None
    t0 = time.time()
    hyp_before = transcribe(model, processor, evals)
    json.dump(hyp_before, open(os.path.join(a.out, 'hyp_before.json'), 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    print('base eval done', round(time.time() - t0, 1), 's', flush=True)

    # 訓練目標：參考文字以小寫、去標點（與 sr_train_core.js 的 normalizeText 相同），加上 Whisper 的語言／任務前綴
    tok = processor.tokenizer
    tok.set_prefix_tokens(language='english', task='transcribe')
    sot = model.config.decoder_start_token_id

    def label_ids(text):
        ids = tok(normalize(text)).input_ids
        return ids[1:] if ids and ids[0] == sot else ids

    model = get_peft_model(model, LoraConfig(r=a.rank, lora_alpha=a.alpha, target_modules=['q_proj', 'v_proj'],
                                              lora_dropout=0.0, bias='none'))
    trainable = sum(p.numel() for p in model.parameters() if p.requires_grad)
    total = sum(p.numel() for p in model.parameters())
    print('trainable', trainable, 'of', total, flush=True)
    opt = torch.optim.AdamW([p for p in model.parameters() if p.requires_grad], lr=a.lr, weight_decay=0.0)
    rng = np.random.RandomState(a.seed)
    feats_cache = {}
    def feats_of(r):
        if r['id'] not in feats_cache:
            feats_cache[r['id']] = processor.feature_extractor(load_audio(r['abs']), sampling_rate=16000, return_tensors='pt').input_features[0]
        return feats_cache[r['id']]
    log = open(os.path.join(a.out, 'log.jsonl'), 'w', encoding='utf-8')
    step = 0
    model.train()
    while step < a.steps:
        order = rng.permutation(len(train))
        for s in range(0, len(order) - a.batch + 1, a.batch):
            if step >= a.steps:
                break
            batch = [train[j] for j in order[s:s + a.batch]]
            x = torch.stack([feats_of(r) for r in batch])
            labs = [label_ids(r['text']) for r in batch]
            L = max(len(l) for l in labs)
            y = torch.full((len(labs), L), -100, dtype=torch.long)
            for i, l in enumerate(labs):
                y[i, :len(l)] = torch.tensor(l)
            loss = model(input_features=x, labels=y).loss
            opt.zero_grad()
            loss.backward()
            opt.step()
            step += 1
            rec = {'step': step, 'loss': round(float(loss.item()), 6)}
            log.write(json.dumps(rec) + '\n'); log.flush()
            print(json.dumps(rec), flush=True)
    log.close()
    model.save_pretrained(os.path.join(a.out, 'adapter'))
    hyp_after = transcribe(model, processor, evals)
    json.dump(hyp_after, open(os.path.join(a.out, 'hyp_after.json'), 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    losses = [json.loads(l)['loss'] for l in open(os.path.join(a.out, 'log.jsonl'), encoding='utf-8')]
    meta = {'base': os.path.basename(os.path.normpath(a.base)), 'steps': a.steps, 'batch': a.batch, 'lr': a.lr,
            'rank': a.rank, 'alpha': a.alpha, 'seed': a.seed, 'target_modules': ['q_proj', 'v_proj'],
            'trainable_params': trainable, 'total_params': total, 'train_rows': len(train), 'eval_rows': len(evals),
            'loss_first': losses[0], 'loss_last': losses[-1], 'seconds': round(time.time() - t0, 1),
            'adapter_sha256': {f: sha256(os.path.join(a.out, 'adapter', f)) for f in os.listdir(os.path.join(a.out, 'adapter'))}}
    json.dump(meta, open(os.path.join(a.out, 'train_meta.json'), 'w', encoding='utf-8'), indent=1)
    print('train done', json.dumps(meta)[:300], flush=True)

def cmd_check(a):
    import torch
    from transformers import WhisperForConditionalGeneration, WhisperProcessor
    from peft import PeftModel
    seed_all(0)
    rows = [r for r in load_rows(a.data) if r['split'] == 'eval']
    processor = WhisperProcessor.from_pretrained(a.base)
    base = WhisperForConditionalGeneration.from_pretrained(a.base, dtype=torch.float32)
    base.config.forced_decoder_ids = None
    model = PeftModel.from_pretrained(base, a.adapter)
    hyp = transcribe(model, processor, rows)
    ref_hyp = {h['id']: h['hyp'] for h in json.load(open(a.hyp, encoding='utf-8'))}
    same = sum(1 for h in hyp if ref_hyp.get(h['id']) == h['hyp'])
    print(json.dumps({'reloaded_matches_training_run': same, 'of': len(hyp)}))
    json.dump(hyp, open(os.path.join(a.adapter, '..', 'hyp_reloaded.json'), 'w', encoding='utf-8'), ensure_ascii=False, indent=1)

if __name__ == '__main__':
    p = argparse.ArgumentParser()
    sub = p.add_subparsers(dest='cmd', required=True)
    q = sub.add_parser('prep'); q.add_argument('--parquet', required=True); q.add_argument('--out', required=True)
    t = sub.add_parser('train'); t.add_argument('--base', required=True); t.add_argument('--data', required=True); t.add_argument('--out', required=True)
    t.add_argument('--steps', type=int, default=40); t.add_argument('--batch', type=int, default=4); t.add_argument('--lr', type=float, default=1e-3)
    t.add_argument('--rank', type=int, default=8); t.add_argument('--alpha', type=int, default=16); t.add_argument('--seed', type=int, default=0)
    c = sub.add_parser('check'); c.add_argument('--base', required=True); c.add_argument('--adapter', required=True); c.add_argument('--data', required=True); c.add_argument('--hyp', required=True)
    a = p.parse_args()
    {'prep': cmd_prep, 'train': cmd_train, 'check': cmd_check}[a.cmd](a)
