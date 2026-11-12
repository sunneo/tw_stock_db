"""HF 參考：fp32 基底＋bench adapter（merge_and_unload）；用 prompts.js 產生的 ids 做貪婪解碼 16 token。
輸出：~/fa-work/native_check/hf_tokens.json、hf_first_logits.bin（每題第一步 logits，float32，concatenate）。
用法：~/fa-work/venv/bin/python lora-train/native_check/hf_ref.py
"""
import json, os, numpy as np, torch
from transformers import AutoModelForCausalLM
from peft import PeftModel

HOME = os.path.expanduser('~')
OUT = os.path.join(HOME, 'fa-work/native_check')
BASE = os.path.join(HOME, 'fa-work/models/Qwen3-0.6B')
ADAPTER = os.path.join(HOME, '.config/floating-assistant-desktop/studio-host/bench-out')
STEPS = 16
torch.set_num_threads(8)

ids_doc = json.load(open(os.path.join(OUT, 'ids.json')))
import sys
BASE_ONLY = '--base-only' in sys.argv  # 不套 adapter：當作 q8 基底的量化對照
PFX = 'hf_base_' if BASE_ONLY else 'hf_'
model = AutoModelForCausalLM.from_pretrained(BASE, dtype=torch.float32)
if not BASE_ONLY:
    model = PeftModel.from_pretrained(model, ADAPTER).merge_and_unload()
model = model.eval()

tokens, first = [], []
with torch.no_grad():
    for row in ids_doc['rows']:
        x = torch.tensor([row['ids']], dtype=torch.long)
        out = model(input_ids=x, use_cache=True)
        first.append(out.logits[0, -1].float().numpy())
        past = out.past_key_values
        nxt = int(out.logits[0, -1].argmax())
        gen = [nxt]
        for _ in range(STEPS - 1):
            o = model(input_ids=torch.tensor([[nxt]]), past_key_values=past, use_cache=True)
            past = o.past_key_values
            nxt = int(o.logits[0, -1].argmax())
            gen.append(nxt)
        tokens.append(gen)
        print('hf row', row['i'], gen, flush=True)

np.concatenate(first).astype('<f4').tofile(os.path.join(OUT, PFX + 'first_logits.bin'))
json.dump({'base': BASE, 'adapter': None if BASE_ONLY else ADAPTER, 'dtype': 'float32 ' + ('base only' if BASE_ONLY else 'merged'), 'steps': STEPS, 'tokens': tokens},
          open(os.path.join(OUT, PFX + 'tokens.json'), 'w'))
print('done')
