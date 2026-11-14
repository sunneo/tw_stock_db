# -*- coding: utf-8 -*-
# 深色變體：只覆寫 style 與店名參數，行為委派給 main.py。
import importlib.util
import os

_here = os.path.dirname(os.path.abspath(__file__))


def build(win, spec, slots):
    spec_ = importlib.util.spec_from_file_location("guitpl_inventory_base", os.path.join(_here, "main.py"))
    mod = importlib.util.module_from_spec(spec_)
    spec_.loader.exec_module(mod)
    return mod.build(win, spec, slots)
