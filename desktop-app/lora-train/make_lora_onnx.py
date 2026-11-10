#!/usr/bin/env python
"""LoRA as a separate small patch file for the q8 Qwen3-0.6B ONNX graph (our own implementation).

Idea: after quantization, every target linear (28 layers x q/k/v/o/gate/up/down = 196) gets a side branch
        y = y_base + (x @ A) @ B
whose A [in, R] and B [R, out] are initializers stored as EXTERNAL data in a separate file `lora.bin`
(fixed layout, rank slot R). The big base file never changes; swapping the adapter = swapping lora.bin and
re-creating the session. An all-zero lora.bin is the identity (output equals the plain base graph).
The surgery must happen AFTER quantization, otherwise A/B would be quantized.

  build:  python make_lora_onnx.py build <model_quantized.onnx> <out_dir> [--rank 16]
          -> out_dir/model_quantized.onnx (+ layout.json, lora.bin all zeros)
  pack:   python make_lora_onnx.py pack <peft_adapter_dir> <layout.json> <lora.bin>
          -> rewrites lora.bin from a PEFT adapter (rank <= slot; alpha/r folded into B; unused rank rows zero)
"""
import json, os, sys
import numpy as np
import onnx
from onnx import TensorProto, helper

PROJ = [("attn", "self_attn", "q_proj"), ("attn", "self_attn", "k_proj"), ("attn", "self_attn", "v_proj"),
        ("attn", "self_attn", "o_proj"), ("mlp", "mlp", "gate_proj"), ("mlp", "mlp", "up_proj"), ("mlp", "mlp", "down_proj")]
ALIGN = 64


def arg(flag, default=None):
    return sys.argv[sys.argv.index(flag) + 1] if flag in sys.argv else default


def build(src, out_dir, rank):
    model = onnx.load(src)
    g = model.graph
    os.makedirs(out_dir, exist_ok=True)
    inits = {i.name: i for i in g.initializer}
    producer = {o: idx for idx, n in enumerate(g.node) for o in n.output}
    quant = {n.name: n for n in g.node if n.op_type == "MatMulInteger"}
    layers = sorted({int(n.name.split("/layers.")[1].split("/")[0]) for n in g.node if n.op_type == "MatMulInteger" and "/layers." in n.name})
    tensors, off, hits = [], 0, 0
    after = {}  # node index -> nodes to insert right after it

    def external(name, dims):
        nonlocal off
        t = TensorProto()
        t.name, t.data_type = name, TensorProto.FLOAT
        t.dims.extend(dims)
        t.data_location = TensorProto.EXTERNAL
        nbytes = int(np.prod(dims)) * 4
        for k, v in (("location", "lora.bin"), ("offset", str(off)), ("length", str(nbytes))):
            e = t.external_data.add()
            e.key, e.value = k, v
        tensors.append({"name": name, "dims": list(dims), "offset": off, "length": nbytes})
        off += (nbytes + ALIGN - 1) // ALIGN * ALIGN
        return t

    for L in layers:
        for grp, hf_grp, proj in PROJ:
            base = f"/model/layers.{L}/{grp}/{proj}/MatMul"
            mi = quant.get(base + "_quant")
            y = base + "/output_0"
            if mi is None or y not in producer:
                raise SystemExit(f"target not found (expected a quantize_dynamic q8 graph): {base}")
            x = mi.input[0]
            assert x.endswith("_quantized"), x
            x = x[: -len("_quantized")]
            din, dout = list(inits[mi.input[1]].dims)
            tag = f"lora.{L}.{proj}"
            a, b = external(f"{tag}.A", [din, rank]), external(f"{tag}.B", [rank, dout])
            g.initializer.extend([a, b])
            idx = producer[y]
            node = g.node[idx]
            node.output[list(node.output).index(y)] = y + "_base"
            after[idx] = [
                helper.make_node("MatMul", [x, a.name], [tag + ".h"], name=tag + ".mmA"),
                helper.make_node("MatMul", [tag + ".h", b.name], [tag + ".d"], name=tag + ".mmB"),
                helper.make_node("Add", [y + "_base", tag + ".d"], [y], name=tag + ".add"),
            ]
            hits += 1
    nodes = []
    for i, n in enumerate(g.node):
        nodes.append(n)
        nodes.extend(after.get(i, []))
    del g.node[:]
    g.node.extend(nodes)
    onnx.save(model, os.path.join(out_dir, "model_quantized.onnx"))
    json.dump({"rank": rank, "total_bytes": off, "tensors": tensors}, open(os.path.join(out_dir, "layout.json"), "w"))
    open(os.path.join(out_dir, "lora.bin"), "wb").write(b"\0" * off)
    print(f"targets={hits} lora.bin={off} bytes -> {out_dir}")


def pack(adapter_dir, layout_path, out_path):
    from safetensors.numpy import load_file
    lay = json.load(open(layout_path))
    cfg = json.load(open(os.path.join(adapter_dir, "adapter_config.json")))
    r, scale = cfg["r"], cfg["lora_alpha"] / cfg["r"]
    if r > lay["rank"]:
        raise SystemExit(f"adapter rank {r} > slot {lay['rank']}")
    w = load_file(os.path.join(adapter_dir, "adapter_model.safetensors"))
    buf = bytearray(lay["total_bytes"])
    for t in lay["tensors"]:
        _, layer, proj, ab = t["name"].split(".")
        grp = "self_attn" if proj in ("q_proj", "k_proj", "v_proj", "o_proj") else "mlp"
        m = w[f"base_model.model.model.layers.{layer}.{grp}.{proj}.lora_{ab}.weight"].astype(np.float32)  # A [r,in]  B [out,r]
        arr = np.zeros(t["dims"], np.float32)
        if ab == "A":
            arr[:, :r] = m.T
        else:
            arr[:r, :] = m.T * scale
        buf[t["offset"]: t["offset"] + t["length"]] = arr.tobytes()
    open(out_path, "wb").write(buf)
    print(f"packed {out_path} {len(buf)} bytes (rank {r}, scale {scale})")


if __name__ == "__main__":
    if len(sys.argv) < 2 or sys.argv[1] not in ("build", "pack"):
        sys.exit(__doc__)
    if sys.argv[1] == "build":
        build(sys.argv[2], sys.argv[3], int(arg("--rank", 16)))
    else:
        pack(sys.argv[2], sys.argv[3], sys.argv[4])
