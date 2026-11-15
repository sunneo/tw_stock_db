# -*- coding: utf-8 -*-
# PyTorch 小型 MLP 訓練迴圈（常見寫法，原封不動）：不 import cudaweb，直接 import torch。
# 在 GPU 相容層下，torch 由墊片提供（第一階段：numpy 資料容器，cuda 裝置的 matmul 前向走 GPU 橋接）。
import numpy as np
import torch
import torch.nn as nn
import torch.optim as optim

torch.manual_seed(0)
device = "cuda" if torch.cuda.is_available() else "cpu"

rng = np.random.RandomState(0)
X_np = rng.randn(120, 4).astype(np.float32)
y_np = (X_np[:, 0] + X_np[:, 1] > 0).astype(np.int64) + (X_np[:, 2] > 0.5).astype(np.int64)

X = torch.tensor(X_np).to(device)
y = torch.tensor(y_np).to(device)

model = nn.Sequential(nn.Linear(4, 16), nn.ReLU(), nn.Linear(16, 3)).to(device)
loss_fn = nn.CrossEntropyLoss()
opt = optim.AdamW(model.parameters(), lr=5e-2)

losses = []
for epoch in range(120):
    opt.zero_grad()
    out = model(X)
    loss = loss_fn(out, y)
    loss.backward()
    opt.step()
    losses.append(loss.item())
    if epoch % 40 == 0:
        print("第 %d 輪 損失 %.4f" % (epoch, loss.item()))

with torch.no_grad():
    logits = model(X).numpy()
acc = float((logits.argmax(axis=1) == y_np).mean())
print("最後損失低於第一輪：", bool(losses[-1] < losses[0]))
print("訓練準確率 ≥ 0.8：", bool(acc >= 0.8), "（%.3f）" % acc)
print("裝置：", device)
