#!/usr/bin/env python
"""Merge several slot-shaped lora.bin files into ONE lora.bin by stacking them along the rank axis (numpy only, no onnx needed).

Math: one adapter contributes  dW_k = A_k @ B_k  with A_k [in, r_k], B_k [r_k, out].
      Stacking A = [A_1 | A_2 | ...] (columns) and B = [w_1*B_1 ; w_2*B_2 ; ...] (rows) gives  A @ B = sum_k w_k * A_k @ B_k  exactly.
So the merged file has the SAME layout as the slot (rank R) and needs no graph change. Capacity rule: sum of effective ranks <= R,
otherwise the adapter that does not fit is REJECTED with an explicit reason (never silently truncated).
The JS twin lives in main-ext.js (NRL.mergeSlots); tests/native/native_lora_merge.test.js checks the two give byte-identical output.
"""
import json
import sys
import numpy as np

ALIGN = 64


def _views(buf, layout):
    out = []
    for t in layout["tensors"]:
        n = int(np.prod(t["dims"]))
        arr = np.frombuffer(buf, dtype="<f4", count=n, offset=t["offset"]).reshape(t["dims"])
        out.append((t, arr))
    return out


def effective_rank(buf, layout):
    """Highest used rank index + 1: A column j used if any nonzero in column j; B row j used if any nonzero in row j."""
    r = 0
    for t, arr in _views(buf, layout):
        ab = t["name"].rsplit(".", 1)[1]
        nz = np.any(arr != 0, axis=0) if ab == "A" else np.any(arr != 0, axis=1)
        idx = np.nonzero(nz)[0]
        if idx.size:
            r = max(r, int(idx[-1]) + 1)
    return r


def merge_slots(layout, items):
    """items: [{'id', 'buf' (bytes), 'weight' (float, default 1)}] in priority order.
    Returns {'buf', 'items': [{'id','applied','rank','offset','weight','reason'}], 'rank_used', 'rank_slot'}."""
    R = layout["rank"]
    total = layout["total_bytes"]
    out = bytearray(total)
    res, used = [], 0
    placed = []
    for it in items:
        buf, w = it["buf"], float(it.get("weight", 1.0))
        if len(buf) != total:
            res.append({"id": it["id"], "applied": False, "code": "slot_mismatch", "reason": f"size {len(buf)} != slot {total}"})
            continue
        if not (np.isfinite(w) and 0 < w <= 8):
            res.append({"id": it["id"], "applied": False, "code": "bad_weight", "reason": f"weight {w} must be finite and in (0, 8]"})
            continue
        r = effective_rank(buf, layout)
        if r == 0:
            res.append({"id": it["id"], "applied": False, "code": "empty_adapter", "reason": "all-zero adapter (identity); nothing to merge"})
            continue
        if used + r > R:
            res.append({"id": it["id"], "applied": False, "code": "rank_capacity",
                        "reason": f"rank capacity: slot {R}, used {used}, this adapter needs {r}; rejected (not truncated)"})
            continue
        placed.append((buf, w, r, used))
        res.append({"id": it["id"], "applied": True, "rank": r, "offset": used, "weight": w})
        used += r
    srcs = [({tt["name"]: a for tt, a in _views(buf, layout)}, w, r, off) for buf, w, r, off in placed]
    for t in layout["tensors"]:
        n = int(np.prod(t["dims"]))
        dst = np.frombuffer(out, dtype="<f4", count=n, offset=t["offset"]).reshape(t["dims"])
        ab = t["name"].rsplit(".", 1)[1]
        for named, w, r, off in srcs:
            a = named[t["name"]]
            if ab == "A":
                dst[:, off:off + r] = a[:, :r]
            else:
                dst[off:off + r, :] = a[:r, :] * np.float32(w)
    return {"buf": bytes(out), "items": res, "rank_used": used, "rank_slot": R}


def main(argv):
    if len(argv) < 4:
        sys.exit("usage: lora_slots.py <layout.json> <out lora.bin> <lora.bin[:weight]>...")
    layout = json.load(open(argv[1]))
    items = []
    for s in argv[3:]:
        tail = s.rsplit(":", 1)[1] if ":" in s else ""
        p, w = (s.rsplit(":", 1)[0], tail) if tail.replace(".", "", 1).isdigit() else (s, "")
        items.append({"id": p, "buf": open(p, "rb").read(), "weight": float(w) if w else 1.0})
    r = merge_slots(layout, items)
    open(argv[2], "wb").write(r["buf"])
    print(json.dumps({"items": r["items"], "rank_used": r["rank_used"], "rank_slot": r["rank_slot"]}, ensure_ascii=False))
    if not any(i["applied"] for i in r["items"]):
        sys.exit(2)


if __name__ == "__main__":
    main(sys.argv)
