"""把 PEFT adapter 依 app 的槽版 layout.json 打成 lora.bin（與 make_lora_onnx.py 的 pack_bytes 同一套規則）。
這裡不 import make_lora_onnx.py（它頂層需要 onnx，這台環境沒有），規則逐行照抄：A 寫成 [din, r] 放在前 r 欄，B 寫成 [r, dout] 放在前 r 列並乘 alpha/r。
輸出：~/fa-work/native_check/bin/lora_bench.bin、lora_zero.bin（全零，同大小）。
用法：~/fa-work/venv/bin/python lora-train/native_check/pack_bench.py
"""
import json, os, numpy as np
from safetensors.numpy import load_file

HOME = os.path.expanduser('~')
LAYOUT = os.path.join(HOME, '.config/floating-assistant-desktop/native-lora/slot-model/ccf8734e59fdf7475b2dc0c117005e267a3a08342c1d951e0a79f0bce57bf62a/layout.json')
ADAPTER = os.environ.get('FA_ADAPTER') or os.path.join(HOME, '.config/floating-assistant-desktop/studio-host/bench-out')
TAG = os.environ.get('FA_TAG', 'bench')  # lora_<TAG>.bin
OUTD = os.path.join(HOME, 'fa-work/native_check/bin'); os.makedirs(OUTD, exist_ok=True)

lay = json.load(open(LAYOUT))
cfg = json.load(open(os.path.join(ADAPTER, 'adapter_config.json')))
r, scale = cfg['r'], cfg['lora_alpha'] / cfg['r']
assert r <= lay['rank'], (r, lay['rank'])
w = load_file(os.path.join(ADAPTER, 'adapter_model.safetensors'))
buf = bytearray(lay['total_bytes'])
for t in lay['tensors']:
    _, layer, proj, ab = t['name'].split('.')
    grp = 'self_attn' if proj in ('q_proj', 'k_proj', 'v_proj', 'o_proj') else 'mlp'
    m = w[f'base_model.model.model.layers.{layer}.{grp}.{proj}.lora_{ab}.weight'].astype(np.float32)
    arr = np.zeros(t['dims'], np.float32)
    if ab == 'A':
        arr[:, :r] = m.T
    else:
        arr[:r, :] = m.T * scale
    buf[t['offset']: t['offset'] + t['length']] = arr.tobytes()
open(os.path.join(OUTD, f'lora_{TAG}.bin'), 'wb').write(bytes(buf))
open(os.path.join(OUTD, 'lora_zero.bin'), 'wb').write(b'\0' * lay['total_bytes'])
print('rank', r, 'scale', scale, 'tensors', len(lay['tensors']), 'bytes', len(buf))
