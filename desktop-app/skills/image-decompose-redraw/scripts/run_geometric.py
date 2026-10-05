# -*- coding: utf-8 -*-
"""純幾何軌道的命令列入口（不需要 Vision Model）。

用法：
  python run_geometric.py 輸入圖.png --out 輸出資料夾 [--max-side 384] [--max-leaves 3000] [--preview]

輸出（都在 --out 底下，檔名以輸入檔名為前綴）：
  <name>.svg          向量重繪（三角形，依景深由遠到近排列）
  <name>.mesh.json    2.5D 網格（頂點 xyz、UV、頂點顏色、面、區域與景深順序）
  <name>.obj / mesh.mtl / <name>.texture.png    可直接丟進 3D 軟體的貼圖網格
  <name>.preview.png  （加 --preview）正面與左右各轉 15° 的重畫，檢查立體感與視差
最後一行印出 JSON 摘要（區域數、三角形數、耗時…）。
"""
import argparse
import json
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from idr import Params, decompose, save_all  # noqa: E402
from idr.resample import render_view  # noqa: E402


def main(argv=None):
    ap = argparse.ArgumentParser(description="Image-Decompose-Redraw：純幾何 2.5D 軌道")
    ap.add_argument("image")
    ap.add_argument("--out", default="idr_out")
    ap.add_argument("--max-side", type=int, default=384)
    ap.add_argument("--max-leaves", type=int, default=3000)
    ap.add_argument("--var-thresh", type=float, default=20.0)
    ap.add_argument("--min-size", type=int, default=4)
    ap.add_argument("--tau-edge", type=float, default=6.0)
    ap.add_argument("--tau-color", type=float, default=12.0)
    ap.add_argument("--amplitude", type=float, default=0.8)
    ap.add_argument("--welded", action="store_true", help="單片連續網格（2D↔3D 完全一對一，但沒有區域之間的景深落差）")
    ap.add_argument("--vision", choices=["off", "auto", "on"], default="off", help="auto：有支援讀圖的模型就用它決定前後順序，否則退回純幾何")
    ap.add_argument("--preview", action="store_true")
    a = ap.parse_args(argv)
    p = Params(max_side=a.max_side, max_leaves=a.max_leaves, var_thresh=a.var_thresh, min_size=a.min_size,
               tau_edge=a.tau_edge, tau_color=a.tau_color, amplitude=a.amplitude, separate_regions=not a.welded)
    res = decompose(a.image, p, vision=a.vision)
    name = os.path.splitext(os.path.basename(a.image))[0]
    files = save_all(res, a.out, name)
    if a.preview:
        from PIL import Image
        views = [render_view(res.mesh, res.rgb, np.radians(yaw), 0.0) for yaw in (-15, 0, 15)]
        bg = np.array([0.92, 0.92, 0.92])
        tiles = [v[..., :3] * v[..., 3:4] + bg * (1 - v[..., 3:4]) for v in views]
        files["preview"] = os.path.join(a.out, name + ".preview.png")
        Image.fromarray((np.clip(np.concatenate(tiles, 1), 0, 1) * 255).astype(np.uint8)).save(files["preview"])
    print(json.dumps({"files": files, "stats": res.stats}, ensure_ascii=False))


if __name__ == "__main__":
    main()
