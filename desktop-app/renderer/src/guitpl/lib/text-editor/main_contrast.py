# -*- coding: utf-8 -*-
# 高對比文字編輯器：只換配色，行為委派給 main.py。
import importlib.util
import os

_here = os.path.dirname(os.path.abspath(__file__))


def build(win, spec, slots):
    spec_ = importlib.util.spec_from_file_location("guitpl_text_editor_main_base", os.path.join(_here, "main.py"))
    mod = importlib.util.module_from_spec(spec_)
    spec_.loader.exec_module(mod)
    return mod.build(win, spec, slots)
