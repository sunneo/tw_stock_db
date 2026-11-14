# -*- coding: utf-8 -*-
# 客製化的 .py：延伸 demo/notes 時，這個檔案取代原本的進入函式；沒有額外行為就委派給原本的。
import importlib.util
import os

_here = os.path.dirname(os.path.abspath(__file__))


def build(win, spec, slots):
    spec_ = importlib.util.spec_from_file_location("guitpl_demo_notes_base", os.path.join(_here, "notes.py"))
    mod = importlib.util.module_from_spec(spec_)
    spec_.loader.exec_module(mod)
    return mod.build(win, spec, slots)
