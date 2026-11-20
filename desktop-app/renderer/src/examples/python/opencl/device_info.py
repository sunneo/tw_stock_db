"""列出 OpenCL 平台與裝置（標準 pyopencl）。第一個平台通常是 GPU（WebGPU／WebGL2），第二個是 CPU（OpenCL C → JS）。"""
import pyopencl as cl

for p in cl.get_platforms():
    print("平台：%s（%s，%s）" % (p.name, p.vendor, p.version))
    for d in p.get_devices():
        kind = "GPU" if d.type & cl.device_type.GPU else "CPU" if d.type & cl.device_type.CPU else str(d.type)
        print("  裝置：%s｜類型 %s｜工作群上限 %d｜區域記憶體 %d KB｜全域記憶體 %d MB" % (
            d.name, kind, d.max_work_group_size, d.local_mem_size // 1024, d.global_mem_size // (1 << 20)))
        print("        double 支援：%s｜圖像：%s｜SVM：%s" % ("cl_khr_fp64" in d.extensions, bool(d.image_support), d.svm_capabilities != 0))
