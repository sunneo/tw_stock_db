#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""驗證 calendar.json 與 themes/*：格式、日期、資產齊全、每個套版 <= 1MB。有錯誤就以非 0 結束。"""
import datetime
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MAX_THEME_BYTES = 1024 * 1024
errors = []


def err(msg):
    errors.append(msg)


def load(rel):
    with open(os.path.join(ROOT, rel), encoding="utf-8") as f:
        return json.load(f)


def d(s):
    try:
        return datetime.date.fromisoformat(s)
    except Exception:
        return None


cal = load("calendar.json")
theme_ids = set()
for t in cal.get("themes", []):
    tid = t["id"]
    theme_ids.add(tid)
    tdir = os.path.join(ROOT, "themes", tid)
    if not os.path.isfile(os.path.join(tdir, "theme.json")):
        err("缺少 themes/%s/theme.json" % tid)
        continue
    total = 0
    for name in os.listdir(tdir):
        total += os.path.getsize(os.path.join(tdir, name))
    if total > MAX_THEME_BYTES:
        err("套版 %s 共 %d bytes，超過 1MB 上限" % (tid, total))
    th = load("themes/%s/theme.json" % tid)
    for key in ("id", "name", "version", "lead", "greeting", "accent", "light", "dark", "regions"):
        if key not in th:
            err("themes/%s/theme.json 缺少欄位 %s" % (tid, key))
    if th.get("id") != tid:
        err("themes/%s/theme.json 的 id 不一致" % tid)
    regions = th.get("regions") or {}
    for rname in ("top", "bottom", "body"):
        r = regions.get(rname)
        if not r:
            err("themes/%s 缺少區域 %s" % (tid, rname))
            continue
        assets = [fr.get("asset") for fr in r.get("frames", [])] + ([r["asset"]] if r.get("asset") else [])
        if not assets:
            err("themes/%s 區域 %s 沒有任何資產" % (tid, rname))
        for fn in assets:
            if not fn or not os.path.isfile(os.path.join(tdir, fn)):
                err("themes/%s 缺少資產 %s" % (tid, fn))
        offs = [fr.get("offset") for fr in r.get("frames", [])]
        if offs and offs != sorted(offs):
            err("themes/%s 區域 %s 的 frames 要依 offset 由小到大排序" % (tid, rname))
    if not re.match(r"^#[0-9a-fA-F]{6}$", th.get("accent", "")):
        err("themes/%s accent 不是 #rrggbb" % tid)

seen = set()
for f in cal.get("festivals", []):
    fid = f.get("id")
    if fid in seen:
        err("festival id 重複：%s" % fid)
    seen.add(fid)
    if f.get("theme") not in theme_ids:
        err("festival %s 指向不存在的套版 %s" % (fid, f.get("theme")))
    a, b = d(f.get("start", "")), d(f.get("end", ""))
    if not a or not b or b < a:
        err("festival %s 日期不合法：%s ~ %s" % (fid, f.get("start"), f.get("end")))
    if not isinstance(f.get("lead"), int) or not (0 <= f["lead"] <= 30):
        err("festival %s lead 要是 0~30 的整數" % fid)
    if not isinstance(f.get("priority"), int):
        err("festival %s priority 要是整數" % fid)
    if not f.get("source"):
        err("festival %s 缺少 source" % fid)

if errors:
    print("檢查失敗：")
    for e in errors:
        print(" -", e)
    sys.exit(1)
print("檢查通過：%d 個套版、%d 個節慶" % (len(theme_ids), len(seen)))
