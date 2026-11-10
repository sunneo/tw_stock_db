"""python onnxruntime cross-check of lora_ort_test.js (same model + lora.bin, same prompt ids): token ids must match."""
import json, os, sys, numpy as np, onnxruntime as ort
D = sys.argv[1] if len(sys.argv) > 1 else 'out/onnx'
ref = json.load(open(os.path.join(D, 'ort_node_result.json'))); ids = ref['ids']
def gen(model, steps=12):
    s = ort.InferenceSession(model, providers=['CPUExecutionProvider']); past = {f'past_key_values.{l}.{k}': np.zeros((1, 8, 0, 128), np.float32) for l in range(28) for k in ('key', 'value')}
    out, plen, nxt = [], 0, None; first = None
    for i in range(steps):
        q = ids if i == 0 else [nxt]; L = plen + len(q)
        r = s.run(None, {**past, 'input_ids': np.array([q], np.int64), 'attention_mask': np.ones((1, L), np.int64), 'position_ids': np.array([[plen + j for j in range(len(q))]], np.int64)})
        names = [o.name for o in s.get_outputs()]; d = dict(zip(names, r)); lg = d['logits'][0, -1]
        if i == 0: first = lg[:8].tolist()
        nxt = int(lg.argmax()); out.append(nxt); plen = L
        past = {f'past_key_values.{l}.{k}': d[f'present.{l}.{k}'] for l in range(28) for k in ('key', 'value')}
    return out, first
o, f = gen(os.path.join(D, 'run_r2', 'model_quantized.onnx'))
print('python ort tokens == node ort tokens (adapter r2):', o == ref['r2']); print('first-logit head python:', np.round(f, 3).tolist()); print('first-logit head node  :', np.round(ref['r2FirstLogitsHead'], 3).tolist())
