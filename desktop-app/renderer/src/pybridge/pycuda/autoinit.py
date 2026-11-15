# -*- coding: utf-8 -*-
"""pycuda.autoinit 墊片：import 時初始化（與 pycuda.autoinit 相同用法），提供 device。"""
from . import driver

driver.init()
device = driver.Device(0)
