# python estimate.py <train.jsonl> <eval.jsonl> <base_dir_or_hf_id> -- ESTIMATE of run time (linear scaling from one reference measurement, not a benchmark).
# Reference (other 24-core Xeon machine, fp32 torch-cpu): SFT ~67 tokens/s, eval ~11 s per row. Our own laptop (14 threads) measured ~43 s per 8-row step.
import os, sys
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))
from lora_common import read_jsonl, normalize, encode
from transformers import AutoTokenizer
tr, ev, base = sys.argv[1:4]; cores = int(os.environ.get('LORA_THREADS', os.cpu_count() or 1)); sc = cores / 24.0
tok = AutoTokenizer.from_pretrained(base)
rows = [normalize(r) for r in read_jsonl(tr)]; T = sum(len(encode(tok, x)[0]) for x in rows)
ep = int(os.environ.get('SFT_EPOCHS', 2)); sft_h = T * ep / (67 * sc) / 3600
pairs = min(sum(1 for x in rows if x.get('rejected')), int(os.environ.get('DPO_MAX', 400))); avg = T / max(1, len(rows))
dpo_h = pairs * avg * 3 * 2 / (67 * sc) / 3600 * int(os.environ.get('DPO_EPOCHS', 1))
n_ev = len(read_jsonl(ev)) // int(os.environ.get('LORA_EVAL_EVERY', 1)); ev_h = n_ev * 11 * 2 / sc / 3600   # base + tuned in one eval pass
print(f'cores {cores}  train rows {len(rows)}  tokens {T}  eval rows {n_ev}  dpo pairs {pairs}')
print(f'ESTIMATE (linear in cores, +-50%): SFT {sft_h:.1f} h | DPO {dpo_h:.1f} h | eval(base+tuned) {ev_h:.1f} h x 2 | total {sft_h + dpo_h + 2 * ev_h:.1f} h')
