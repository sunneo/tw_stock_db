# -*- coding: utf-8 -*-
"""
pyopencl._cl 的後端（Floating Assistant）。

真的 pyopencl 是「純 Python 模組 ＋ C 擴充 `pyopencl._cl`」；Pyodide 沒有那個 C 擴充的 wheel。這個檔案提供 `_cl` 這一層，
裝成 `pyopencl/_cl.py`，放在真 pyopencl 的純 Python 檔案旁邊（不修改任何一個真檔案），底下接 ICD 載入器（renderer/src/gpu/cl_icd.js）。
設計與範圍見 DESIGN.pyopencl.md §3。介面以真 pyopencl 2026.1.5 的 `_cl.pyi` 為尺。

範圍（第一批）：平台／裝置／內容／佇列／緩衝區／程式／核心／事件、enqueue 的讀寫複製填滿與 nd_range、例外階層、常用列舉。
不支援（丟 pyopencl 的標準例外並說明，不默默降級）：SVM、Pipe、預編譯二進位程式、__local 參數、子緩衝區、
多維 NDRange、double／整數緩衝區（由載入器的驅動在 build 時回報）。
已知差異：USE_HOST_PTR 不與主機記憶體別名（等同 COPY_HOST_PTR，核心的輸出要用 enqueue_copy 讀回）。

列舉數值已用 Khronos 的 CL/cl.h 逐項核對（verify_enums.py）：一致 154、不符 0。唯一沒核對的是 status_code.PLATFORM_NOT_FOUND_KHR（-1001，
在 cl_ext.h，不在 cl.h）。只包含這一批用到的成員（cl.h 的 CL_DEVICE_* 就有 150 個、CL_KERNEL_* 38 個…），其餘待補。

傳輸：Pyodide 裡走 `_fa_opencl.call`（未在 Pyodide 實測）；一般 Python 用環境變數 FA_OPENCL_HOST 指向 cl_host_stdio.js（需要 node），
或 `_cl._set_transport(物件)`（物件要有 call(op, args, data) → (result, data)）。沒有任何傳輸時 get_platforms() 與真 pyopencl 沒有 ICD 時一樣丟 LogicError。
"""
import os
import struct
import subprocess
import sys

import numpy as np

__version__ = "0.1.0+fa-icd"

# ---------------------------------------------------------------------------------------------
# 列舉：普通類別（成員是 int 類別屬性），因為真 pyopencl 的 _monkeypatch.add_get_info 走 `info_class.__dict__`，
# 並且用 `status_code.to_string(code, default)`。
# ---------------------------------------------------------------------------------------------


def _enum(name, members, extra=None):
    ns = dict(members)
    names = {}
    for k, v in members.items():
        names.setdefault(v, k)

    def to_string(value, default="<unknown %d>"):
        n = names.get(int(value))
        return n if n is not None else (default % int(value) if "%" in default else default)
    ns["to_string"] = staticmethod(to_string)
    ns["__module__"] = __name__
    ns.update(extra or {})
    return type(name, (), ns)


# <<<GENERATED ENUMS（由 gen_cl_enums.py 產生，不要手改；數值取自 CL/cl.h 或存根的明確值）
status_code = _enum('status_code', {'SUCCESS': 0, 'DEVICE_NOT_FOUND': -1, 'DEVICE_NOT_AVAILABLE': -2, 'COMPILER_NOT_AVAILABLE': -3, 'MEM_OBJECT_ALLOCATION_FAILURE': -4, 'OUT_OF_RESOURCES': -5, 'OUT_OF_HOST_MEMORY': -6, 'PROFILING_INFO_NOT_AVAILABLE': -7, 'MEM_COPY_OVERLAP': -8, 'IMAGE_FORMAT_MISMATCH': -9, 'IMAGE_FORMAT_NOT_SUPPORTED': -10, 'BUILD_PROGRAM_FAILURE': -11, 'MAP_FAILURE': -12, 'INVALID_VALUE': -30, 'INVALID_DEVICE_TYPE': -31, 'INVALID_PLATFORM': -32, 'INVALID_DEVICE': -33, 'INVALID_CONTEXT': -34, 'INVALID_QUEUE_PROPERTIES': -35, 'INVALID_COMMAND_QUEUE': -36, 'INVALID_HOST_PTR': -37, 'INVALID_MEM_OBJECT': -38, 'INVALID_IMAGE_FORMAT_DESCRIPTOR': -39, 'INVALID_IMAGE_SIZE': -40, 'INVALID_SAMPLER': -41, 'INVALID_BINARY': -42, 'INVALID_BUILD_OPTIONS': -43, 'INVALID_PROGRAM': -44, 'INVALID_PROGRAM_EXECUTABLE': -45, 'INVALID_KERNEL_NAME': -46, 'INVALID_KERNEL_DEFINITION': -47, 'INVALID_KERNEL': -48, 'INVALID_ARG_INDEX': -49, 'INVALID_ARG_VALUE': -50, 'INVALID_ARG_SIZE': -51, 'INVALID_KERNEL_ARGS': -52, 'INVALID_WORK_DIMENSION': -53, 'INVALID_WORK_GROUP_SIZE': -54, 'INVALID_WORK_ITEM_SIZE': -55, 'INVALID_GLOBAL_OFFSET': -56, 'INVALID_EVENT_WAIT_LIST': -57, 'INVALID_EVENT': -58, 'INVALID_OPERATION': -59, 'INVALID_GL_OBJECT': -60, 'INVALID_BUFFER_SIZE': -61, 'INVALID_MIP_LEVEL': -62, 'PLATFORM_NOT_FOUND_KHR': -1001, 'MISALIGNED_SUB_BUFFER_OFFSET': -13, 'EXEC_STATUS_ERROR_FOR_EVENTS_IN_WAIT_LIST': -14, 'INVALID_GLOBAL_WORK_SIZE': -63, 'COMPILE_PROGRAM_FAILURE': -15, 'LINKER_NOT_AVAILABLE': -16, 'LINK_PROGRAM_FAILURE': -17, 'DEVICE_PARTITION_FAILED': -18, 'KERNEL_ARG_INFO_NOT_AVAILABLE': -19, 'INVALID_IMAGE_DESCRIPTOR': -65, 'INVALID_COMPILER_OPTIONS': -66, 'INVALID_LINKER_OPTIONS': -67, 'INVALID_DEVICE_PARTITION_COUNT': -68, 'INVALID_PIPE_SIZE': -69, 'INVALID_DEVICE_QUEUE': -70, 'INVALID_SPEC_ID': -71, 'MAX_SIZE_RESTRICTION_EXCEEDED': -72, 'ACCELERATOR_TYPE_NOT_SUPPORTED_INTEL': -1097, 'BUILD_ERROR': -2, 'BUILD_IN_PROGRESS': -3, 'BUILD_NONE': -1, 'CANCELLED_IMG': -1126, 'COMMAND_TERMINATED_ITSELF_WITH_FAILURE_ARM': -1108, 'CONTEXT_TERMINATED_KHR': -1121, 'DEVICE_PARTITION_FAILED_EXT': -1057, 'ECC_UNRECOVERED_IMG': -1130, 'GENERAL_FAULT_IMG': -1129, 'INCOMPATIBLE_COMMAND_QUEUE_KHR': -1140, 'INVALID_ACCELERATOR_DESCRIPTOR_INTEL': -1096, 'INVALID_ACCELERATOR_INTEL': -1094, 'INVALID_ACCELERATOR_TYPE_INTEL': -1095, 'INVALID_COMMAND_BUFFER_KHR': -1138, 'INVALID_GL_SHAREGROUP_REFERENCE_KHR': -1000, 'INVALID_MUTABLE_COMMAND_KHR': -1141, 'INVALID_PARTITION_COUNT_EXT': -1058, 'INVALID_PARTITION_NAME_EXT': -1059, 'INVALID_PROPERTY': -64, 'INVALID_SEMAPHORE_KHR': -1142, 'INVALID_SYNC_POINT_WAIT_LIST_KHR': -1139, 'PAGE_FAULT_IMG': -1127, 'PARTITION_BY_NAMES_LIST_END_EXT': -1, 'PARTITION_BY_NAMES_LIST_END_INTEL': -1, 'SAFETY_FAULT_IMG': -1128})
platform_info = _enum('platform_info', {'PROFILE': 0x900, 'VERSION': 0x901, 'NAME': 0x902, 'VENDOR': 0x903, 'EXTENSIONS': 0x904, 'HOST_TIMER_RESOLUTION': 0x905, 'NUMERIC_VERSION': 0x906, 'EXTENSIONS_WITH_VERSION': 0x907})
device_type = _enum('device_type', {'DEFAULT': 1, 'CPU': 2, 'GPU': 4, 'ACCELERATOR': 8, 'CUSTOM': 16, 'ALL': 0xffffffff})
device_info = _enum('device_info', {'TYPE': 0x1000, 'VENDOR_ID': 0x1001, 'MAX_COMPUTE_UNITS': 0x1002, 'MAX_WORK_ITEM_DIMENSIONS': 0x1003, 'MAX_WORK_GROUP_SIZE': 0x1004, 'MAX_WORK_ITEM_SIZES': 0x1005, 'PREFERRED_VECTOR_WIDTH_CHAR': 0x1006, 'PREFERRED_VECTOR_WIDTH_SHORT': 0x1007, 'PREFERRED_VECTOR_WIDTH_INT': 0x1008, 'PREFERRED_VECTOR_WIDTH_LONG': 0x1009, 'PREFERRED_VECTOR_WIDTH_FLOAT': 0x100a, 'PREFERRED_VECTOR_WIDTH_DOUBLE': 0x100b, 'MAX_CLOCK_FREQUENCY': 0x100c, 'ADDRESS_BITS': 0x100d, 'MAX_READ_IMAGE_ARGS': 0x100e, 'MAX_WRITE_IMAGE_ARGS': 0x100f, 'MAX_MEM_ALLOC_SIZE': 0x1010, 'IMAGE2D_MAX_WIDTH': 0x1011, 'IMAGE2D_MAX_HEIGHT': 0x1012, 'IMAGE3D_MAX_WIDTH': 0x1013, 'IMAGE3D_MAX_HEIGHT': 0x1014, 'IMAGE3D_MAX_DEPTH': 0x1015, 'IMAGE_SUPPORT': 0x1016, 'MAX_PARAMETER_SIZE': 0x1017, 'MAX_SAMPLERS': 0x1018, 'MEM_BASE_ADDR_ALIGN': 0x1019, 'MIN_DATA_TYPE_ALIGN_SIZE': 0x101a, 'SINGLE_FP_CONFIG': 0x101b, 'DOUBLE_FP_CONFIG': 0x1032, 'HALF_FP_CONFIG': 0x1033, 'GLOBAL_MEM_CACHE_TYPE': 0x101c, 'GLOBAL_MEM_CACHELINE_SIZE': 0x101d, 'GLOBAL_MEM_CACHE_SIZE': 0x101e, 'GLOBAL_MEM_SIZE': 0x101f, 'MAX_CONSTANT_BUFFER_SIZE': 0x1020, 'MAX_CONSTANT_ARGS': 0x1021, 'LOCAL_MEM_TYPE': 0x1022, 'LOCAL_MEM_SIZE': 0x1023, 'ERROR_CORRECTION_SUPPORT': 0x1024, 'PROFILING_TIMER_RESOLUTION': 0x1025, 'ENDIAN_LITTLE': 0x1026, 'AVAILABLE': 0x1027, 'COMPILER_AVAILABLE': 0x1028, 'EXECUTION_CAPABILITIES': 0x1029, 'QUEUE_PROPERTIES': 0x102a, 'QUEUE_ON_HOST_PROPERTIES': 0x102a, 'NAME': 0x102b, 'VENDOR': 0x102c, 'DRIVER_VERSION': 0x102d, 'VERSION': 0x102f, 'PROFILE': 0x102e, 'EXTENSIONS': 0x1030, 'PLATFORM': 0x1031, 'PREFERRED_VECTOR_WIDTH_HALF': 0x1034, 'HOST_UNIFIED_MEMORY': 0x1035, 'NATIVE_VECTOR_WIDTH_CHAR': 0x1036, 'NATIVE_VECTOR_WIDTH_SHORT': 0x1037, 'NATIVE_VECTOR_WIDTH_INT': 0x1038, 'NATIVE_VECTOR_WIDTH_LONG': 0x1039, 'NATIVE_VECTOR_WIDTH_FLOAT': 0x103a, 'NATIVE_VECTOR_WIDTH_DOUBLE': 0x103b, 'NATIVE_VECTOR_WIDTH_HALF': 0x103c, 'OPENCL_C_VERSION': 0x103d, 'COMPUTE_CAPABILITY_MAJOR_NV': 0x4000, 'COMPUTE_CAPABILITY_MINOR_NV': 0x4001, 'REGISTERS_PER_BLOCK_NV': 0x4002, 'WARP_SIZE_NV': 0x4003, 'GPU_OVERLAP_NV': 0x4004, 'KERNEL_EXEC_TIMEOUT_NV': 0x4005, 'INTEGRATED_MEMORY_NV': 0x4006, 'PROFILING_TIMER_OFFSET_AMD': 0x4036, 'TOPOLOGY_AMD': 0x4037, 'BOARD_NAME_AMD': 0x4038, 'GLOBAL_FREE_MEMORY_AMD': 0x4039, 'SIMD_PER_COMPUTE_UNIT_AMD': 0x4040, 'SIMD_WIDTH_AMD': 0x4041, 'SIMD_INSTRUCTION_WIDTH_AMD': 0x4042, 'WAVEFRONT_WIDTH_AMD': 0x4043, 'GLOBAL_MEM_CHANNELS_AMD': 0x4044, 'GLOBAL_MEM_CHANNEL_BANKS_AMD': 0x4045, 'GLOBAL_MEM_CHANNEL_BANK_WIDTH_AMD': 0x4046, 'LOCAL_MEM_SIZE_PER_COMPUTE_UNIT_AMD': 0x4047, 'LOCAL_MEM_BANKS_AMD': 0x4048, 'THREAD_TRACE_SUPPORTED_AMD': 0x4049, 'GFXIP_MAJOR_AMD': 0x404a, 'GFXIP_MINOR_AMD': 0x404b, 'AVAILABLE_ASYNC_QUEUES_AMD': 0x404c, 'PREFERRED_WORK_GROUP_SIZE_AMD': 0x4030, 'MAX_WORK_GROUP_SIZE_AMD': 0x4031, 'PREFERRED_CONSTANT_BUFFER_SIZE_AMD': 0x4033, 'PCIE_ID_AMD': 0x4034, 'LINKER_AVAILABLE': 0x103e, 'BUILT_IN_KERNELS': 0x103f, 'IMAGE_MAX_BUFFER_SIZE': 0x1040, 'IMAGE_MAX_ARRAY_SIZE': 0x1041, 'PARENT_DEVICE': 0x1042, 'PARTITION_MAX_SUB_DEVICES': 0x1043, 'PARTITION_PROPERTIES': 0x1044, 'PARTITION_AFFINITY_DOMAIN': 0x1045, 'PARTITION_TYPE': 0x1046, 'REFERENCE_COUNT': 0x1047, 'PREFERRED_INTEROP_USER_SYNC': 0x1048, 'PRINTF_BUFFER_SIZE': 0x1049, 'IMAGE_PITCH_ALIGNMENT': 0x104a, 'IMAGE_BASE_ADDRESS_ALIGNMENT': 0x104b, 'MAX_READ_WRITE_IMAGE_ARGS': 0x104c, 'MAX_GLOBAL_VARIABLE_SIZE': 0x104d, 'QUEUE_ON_DEVICE_PROPERTIES': 0x104e, 'QUEUE_ON_DEVICE_PREFERRED_SIZE': 0x104f, 'QUEUE_ON_DEVICE_MAX_SIZE': 0x1050, 'MAX_ON_DEVICE_QUEUES': 0x1051, 'MAX_ON_DEVICE_EVENTS': 0x1052, 'SVM_CAPABILITIES': 0x1053, 'GLOBAL_VARIABLE_PREFERRED_TOTAL_SIZE': 0x1054, 'MAX_PIPE_ARGS': 0x1055, 'PIPE_MAX_ACTIVE_RESERVATIONS': 0x1056, 'PIPE_MAX_PACKET_SIZE': 0x1057, 'PREFERRED_PLATFORM_ATOMIC_ALIGNMENT': 0x1058, 'PREFERRED_GLOBAL_ATOMIC_ALIGNMENT': 0x1059, 'PREFERRED_LOCAL_ATOMIC_ALIGNMENT': 0x105a, 'IL_VERSION': 0x105b, 'MAX_NUM_SUB_GROUPS': 0x105c, 'SUB_GROUP_INDEPENDENT_FORWARD_PROGRESS': 0x105d, 'NUMERIC_VERSION': 0x105e, 'EXTENSIONS_WITH_VERSION': 0x1060, 'ILS_WITH_VERSION': 0x1061, 'BUILT_IN_KERNELS_WITH_VERSION': 0x1062, 'ATOMIC_MEMORY_CAPABILITIES': 0x1063, 'ATOMIC_FENCE_CAPABILITIES': 0x1064, 'NON_UNIFORM_WORK_GROUP_SUPPORT': 0x1065, 'OPENCL_C_ALL_VERSIONS': 0x1066, 'PREFERRED_WORK_GROUP_SIZE_MULTIPLE': 0x1067, 'WORK_GROUP_COLLECTIVE_FUNCTIONS_SUPPORT': 0x1068, 'GENERIC_ADDRESS_SPACE_SUPPORT': 0x1069, 'OPENCL_C_FEATURES': 0x106f, 'DEVICE_ENQUEUE_CAPABILITIES': 0x1070, 'PIPE_SUPPORT': 0x1071, 'ME_VERSION_INTEL': 0x407e, 'EXT_MEM_PADDING_IN_BYTES_QCOM': 0x40a0, 'PAGE_SIZE_QCOM': 0x40a1, 'SPIR_VERSIONS': 0x40e0, 'SIMULTANEOUS_INTEROPS_INTEL': 0x4104, 'NUM_SIMULTANEOUS_INTEROPS_INTEL': 0x4105})
device_topology_type_amd = _enum('device_topology_type_amd', {})
device_fp_config = _enum('device_fp_config', {'DENORM': 1, 'INF_NAN': 2, 'ROUND_TO_NEAREST': 4, 'ROUND_TO_ZERO': 8, 'ROUND_TO_INF': 16, 'FMA': 32, 'SOFT_FLOAT': 64, 'CORRECTLY_ROUNDED_DIVIDE_SQRT': 128})
device_mem_cache_type = _enum('device_mem_cache_type', {'NONE': 0, 'READ_ONLY_CACHE': 1, 'READ_WRITE_CACHE': 2})
device_local_mem_type = _enum('device_local_mem_type', {'LOCAL': 0x119c, 'GLOBAL': 0x119b})
device_exec_capabilities = _enum('device_exec_capabilities', {'KERNEL': 1, 'NATIVE_KERNEL': 2})
device_svm_capabilities = _enum('device_svm_capabilities', {'COARSE_GRAIN_BUFFER': 1, 'FINE_GRAIN_BUFFER': 2, 'FINE_GRAIN_SYSTEM': 4, 'ATOMICS': 8})
command_queue_properties = _enum('command_queue_properties', {'_zero': 0, 'OUT_OF_ORDER_EXEC_MODE_ENABLE': 1, 'PROFILING_ENABLE': 2, 'ON_DEVICE': 4, 'ON_DEVICE_DEFAULT': 8})
context_info = _enum('context_info', {'REFERENCE_COUNT': 0x1080, 'DEVICES': 0x1081, 'PROPERTIES': 0x1082, 'NUM_DEVICES': 0x1083, 'INTEROP_USER_SYNC': 0x1085})
gl_context_info = _enum('gl_context_info', {})
context_properties = _enum('context_properties', {'PLATFORM': 0x1084, 'GL_CONTEXT_KHR': 0x2008, 'EGL_DISPLAY_KHR': 0x2009, 'GLX_DISPLAY_KHR': 0x200a, 'WGL_HDC_KHR': 0x200b, 'CGL_SHAREGROUP_KHR': 0x200c})
command_queue_info = _enum('command_queue_info', {'CONTEXT': 0x1090, 'DEVICE': 0x1091, 'REFERENCE_COUNT': 0x1092, 'PROPERTIES': 0x1093, 'PROPERTIES_ARRAY': 0x1098})
queue_properties = _enum('queue_properties', {'PROPERTIES': 0x1093, 'SIZE': 0x1094, 'DEVICE_DEFAULT': 0x1095})
mem_flags = _enum('mem_flags', {'READ_WRITE': 1, 'WRITE_ONLY': 2, 'READ_ONLY': 4, 'USE_HOST_PTR': 8, 'ALLOC_HOST_PTR': 16, 'COPY_HOST_PTR': 32, 'HOST_WRITE_ONLY': 128, 'HOST_READ_ONLY': 0x100, 'HOST_NO_ACCESS': 0x200, 'KERNEL_READ_AND_WRITE': 0x1000})
svm_mem_flags = _enum('svm_mem_flags', {'READ_WRITE': 1, 'WRITE_ONLY': 2, 'READ_ONLY': 4, 'SVM_FINE_GRAIN_BUFFER': 0x400, 'SVM_ATOMICS': 0x800})
channel_order = _enum('channel_order', {'R': 0x10b0, 'A': 0x10b1, 'RG': 0x10b2, 'RA': 0x10b3, 'RGB': 0x10b4, 'RGBA': 0x10b5, 'BGRA': 0x10b6, 'INTENSITY': 0x10b8, 'LUMINANCE': 0x10b9, 'ABGR': 0x10c3})
channel_type = _enum('channel_type', {'SNORM_INT8': 0x10d0, 'SNORM_INT16': 0x10d1, 'UNORM_INT8': 0x10d2, 'UNORM_INT16': 0x10d3, 'UNORM_SHORT_565': 0x10d4, 'UNORM_SHORT_555': 0x10d5, 'UNORM_INT_101010': 0x10d6, 'SIGNED_INT8': 0x10d7, 'SIGNED_INT16': 0x10d8, 'SIGNED_INT32': 0x10d9, 'UNSIGNED_INT8': 0x10da, 'UNSIGNED_INT16': 0x10db, 'UNSIGNED_INT32': 0x10dc, 'HALF_FLOAT': 0x10dd, 'FLOAT': 0x10de, 'UNORM_INT_101010_2': 0x10e0})
mem_object_type = _enum('mem_object_type', {'BUFFER': 0x10f0, 'IMAGE2D': 0x10f1, 'IMAGE3D': 0x10f2, 'IMAGE2D_ARRAY': 0x10f3, 'IMAGE1D': 0x10f4, 'IMAGE1D_ARRAY': 0x10f5, 'IMAGE1D_BUFFER': 0x10f6, 'PIPE': 0x10f7})
mem_properties = _enum('mem_properties', {'DEVICE_PRIVATE_ADDRESS_EXT': 0x5000})
mem_info = _enum('mem_info', {'TYPE': 0x1100, 'FLAGS': 0x1101, 'SIZE': 0x1102, 'HOST_PTR': 0x1103, 'MAP_COUNT': 0x1104, 'REFERENCE_COUNT': 0x1105, 'CONTEXT': 0x1106, 'ASSOCIATED_MEMOBJECT': 0x1107, 'OFFSET': 0x1108, 'USES_SVM_POINTER': 0x1109, 'PROPERTIES': 0x110a, 'DEVICE_ADDRESS_EXT': 0x5001})
image_info = _enum('image_info', {'FORMAT': 0x1110, 'ELEMENT_SIZE': 0x1111, 'ROW_PITCH': 0x1112, 'SLICE_PITCH': 0x1113, 'WIDTH': 0x1114, 'HEIGHT': 0x1115, 'DEPTH': 0x1116, 'ARRAY_SIZE': 0x1117, 'BUFFER': 0x1118, 'NUM_MIP_LEVELS': 0x1119, 'NUM_SAMPLES': 0x111a})
pipe_info = _enum('pipe_info', {'PACKET_SIZE': 0x1120, 'MAX_PACKETS': 0x1121, 'PROPERTIES': 0x1122})
pipe_properties = _enum('pipe_properties', {'PACKET_SIZE': 0x1120, 'MAX_PACKETS': 0x1121})
addressing_mode = _enum('addressing_mode', {'NONE': 0x1130, 'CLAMP_TO_EDGE': 0x1131, 'CLAMP': 0x1132, 'REPEAT': 0x1133, 'MIRRORED_REPEAT': 0x1134})
filter_mode = _enum('filter_mode', {'NEAREST': 0x1140, 'LINEAR': 0x1141})
sampler_info = _enum('sampler_info', {'REFERENCE_COUNT': 0x1150, 'CONTEXT': 0x1151, 'NORMALIZED_COORDS': 0x1152, 'ADDRESSING_MODE': 0x1153, 'FILTER_MODE': 0x1154, 'MIP_FILTER_MODE': 0x1155, 'LOD_MIN': 0x1156, 'LOD_MAX': 0x1157, 'PROPERTIES': 0x1158, 'MIP_FILTER_MODE_KHR': 0x1155, 'LOD_MIN_KHR': 0x1156, 'LOD_MAX_KHR': 0x1157})
sampler_properties = _enum('sampler_properties', {'NORMALIZED_COORDS': 0x1152, 'ADDRESSING_MODE': 0x1153, 'FILTER_MODE': 0x1154})
map_flags = _enum('map_flags', {'READ': 1, 'WRITE': 2, 'WRITE_INVALIDATE_REGION': 4})
program_info = _enum('program_info', {'REFERENCE_COUNT': 0x1160, 'CONTEXT': 0x1161, 'NUM_DEVICES': 0x1162, 'DEVICES': 0x1163, 'SOURCE': 0x1164, 'BINARY_SIZES': 0x1165, 'BINARIES': 0x1166, 'NUM_KERNELS': 0x1167, 'KERNEL_NAMES': 0x1168, 'IL': 0x1169, 'SCOPE_GLOBAL_CTORS_PRESENT': 0x116a, 'SCOPE_GLOBAL_DTORS_PRESENT': 0x116b})
program_build_info = _enum('program_build_info', {'STATUS': 0x1181, 'OPTIONS': 0x1182, 'LOG': 0x1183, 'BINARY_TYPE': 0x1184, 'GLOBAL_VARIABLE_TOTAL_SIZE': 0x1185})
program_binary_type = _enum('program_binary_type', {'NONE': 0, 'COMPILED_OBJECT': 1, 'LIBRARY': 2, 'EXECUTABLE': 4})
kernel_info = _enum('kernel_info', {'FUNCTION_NAME': 0x1190, 'NUM_ARGS': 0x1191, 'REFERENCE_COUNT': 0x1192, 'CONTEXT': 0x1193, 'PROGRAM': 0x1194, 'ATTRIBUTES': 0x1195})
kernel_arg_info = _enum('kernel_arg_info', {'ADDRESS_QUALIFIER': 0x1196, 'ACCESS_QUALIFIER': 0x1197, 'TYPE_NAME': 0x1198, 'TYPE_QUALIFIER': 0x1199, 'NAME': 0x119a})
kernel_arg_address_qualifier = _enum('kernel_arg_address_qualifier', {'GLOBAL': 0x119b, 'LOCAL': 0x119c, 'CONSTANT': 0x119d, 'PRIVATE': 0x119e})
kernel_arg_access_qualifier = _enum('kernel_arg_access_qualifier', {'READ_ONLY': 0x11a0, 'WRITE_ONLY': 0x11a1, 'READ_WRITE': 0x11a2, 'NONE': 0x11a3})
kernel_arg_type_qualifier = _enum('kernel_arg_type_qualifier', {'NONE': 0, 'CONST': 1, 'RESTRICT': 2, 'VOLATILE': 4, 'PIPE': 8})
kernel_work_group_info = _enum('kernel_work_group_info', {'WORK_GROUP_SIZE': 0x11b0, 'COMPILE_WORK_GROUP_SIZE': 0x11b1, 'LOCAL_MEM_SIZE': 0x11b2, 'PREFERRED_WORK_GROUP_SIZE_MULTIPLE': 0x11b3, 'PRIVATE_MEM_SIZE': 0x11b4, 'GLOBAL_WORK_SIZE': 0x11b5})
kernel_sub_group_info = _enum('kernel_sub_group_info', {'MAX_SUB_GROUP_SIZE_FOR_NDRANGE': 0x2033, 'SUB_GROUP_COUNT_FOR_NDRANGE': 0x2034, 'LOCAL_SIZE_FOR_SUB_GROUP_COUNT': 0x11b8, 'MAX_NUM_SUB_GROUPS': 0x11b9, 'COMPILE_NUM_SUB_GROUPS': 0x11ba})
event_info = _enum('event_info', {'COMMAND_QUEUE': 0x11d0, 'COMMAND_TYPE': 0x11d1, 'REFERENCE_COUNT': 0x11d2, 'COMMAND_EXECUTION_STATUS': 0x11d3, 'CONTEXT': 0x11d4})
command_type = _enum('command_type', {'NDRANGE_KERNEL': 0x11f0, 'TASK': 0x11f1, 'NATIVE_KERNEL': 0x11f2, 'READ_BUFFER': 0x11f3, 'WRITE_BUFFER': 0x11f4, 'COPY_BUFFER': 0x11f5, 'READ_IMAGE': 0x11f6, 'WRITE_IMAGE': 0x11f7, 'COPY_IMAGE': 0x11f8, 'COPY_IMAGE_TO_BUFFER': 0x11f9, 'COPY_BUFFER_TO_IMAGE': 0x11fa, 'MAP_BUFFER': 0x11fb, 'MAP_IMAGE': 0x11fc, 'UNMAP_MEM_OBJECT': 0x11fd, 'MARKER': 0x11fe, 'ACQUIRE_GL_OBJECTS': 0x11ff, 'RELEASE_GL_OBJECTS': 0x1200, 'READ_BUFFER_RECT': 0x1201, 'WRITE_BUFFER_RECT': 0x1202, 'COPY_BUFFER_RECT': 0x1203, 'USER': 0x1204, 'BARRIER': 0x1205, 'MIGRATE_MEM_OBJECTS': 0x1206, 'FILL_BUFFER': 0x1207, 'FILL_IMAGE': 0x1208, 'SVM_FREE': 0x1209, 'SVM_MEMCPY': 0x120a, 'SVM_MEMFILL': 0x120b, 'SVM_MAP': 0x120c, 'SVM_UNMAP': 0x120d, 'SVM_MIGRATE_MEM': 0x120e})
command_execution_status = _enum('command_execution_status', {'COMPLETE': 0, 'RUNNING': 1, 'SUBMITTED': 2, 'QUEUED': 3})
profiling_info = _enum('profiling_info', {'QUEUED': 0x1280, 'SUBMIT': 0x1281, 'START': 0x1282, 'END': 0x1283, 'COMPLETE': 0x1284})
mem_migration_flags = _enum('mem_migration_flags', {'HOST': 1, 'CONTENT_UNDEFINED': 2})
device_partition_property = _enum('device_partition_property', {'EQUALLY': 0x1086, 'BY_COUNTS': 0x1087, 'BY_COUNTS_LIST_END': 0, 'BY_AFFINITY_DOMAIN': 0x1088})
device_affinity_domain = _enum('device_affinity_domain', {'NUMA': 1, 'L4_CACHE': 2, 'L3_CACHE': 4, 'L2_CACHE': 8, 'L1_CACHE': 16, 'NEXT_PARTITIONABLE': 32})
device_atomic_capabilities = _enum('device_atomic_capabilities', {'ORDER_RELAXED': 1, 'ORDER_ACQ_REL': 2, 'ORDER_SEQ_CST': 4, 'SCOPE_WORK_ITEM': 8, 'SCOPE_WORK_GROUP': 16, 'SCOPE_DEVICE': 32, 'SCOPE_ALL_DEVICES': 64})
device_device_enqueue_capabilities = _enum('device_device_enqueue_capabilities', {'SUPPORTED': 1, 'REPLACEABLE_DEFAULT': 2})
version_bits = _enum('version_bits', {'MAJOR_BITS': 10, 'MINOR_BITS': 10, 'PATCH_BITS': 12, 'MAJOR_MASK': 0x3ff, 'MINOR_MASK': 0x3ff, 'PATCH_MASK': 0xfff})
khronos_vendor_id = _enum('khronos_vendor_id', {'CODEPLAY': 0x10004})
gl_object_type = _enum('gl_object_type', {'BUFFER': 0x2000, 'TEXTURE2D': 0x2001, 'TEXTURE3D': 0x2002, 'RENDERBUFFER': 0x2003})
gl_texture_info = _enum('gl_texture_info', {'TEXTURE_TARGET': 0x2004, 'MIPMAP_LEVEL': 0x2005})
program_kind = _enum('program_kind', {'UNKNOWN': 0, 'SOURCE': 0x1164, 'BINARY': 2, 'IL': 0x1169})
# 對不到標頭的成員（多半在 cl_ext.h／cl_gl.h，這些標頭沒下載）；沒有編造數值，所以這些成員在 _cl 裡不存在：
_UNRESOLVED = {'device_info': ['ATTRIBUTE_ASYNC_ENGINE_COUNT_NV', 'PCI_BUS_ID_NV', 'PCI_SLOT_ID_NV', 'PCI_DOMAIN_ID_NV', 'MAX_ATOMIC_COUNTERS_EXT'], 'device_topology_type_amd': ['PCIE'], 'context_properties': ['OFFLINE_DEVICES_AMD'], 'mem_flags': ['USE_PERSISTENT_MEM_AMD'], 'channel_order': ['Rx', 'RGx', 'RGBx']}
# GENERATED ENUMS>>>

_CMD = {"kernel": command_type.NDRANGE_KERNEL, "read": command_type.READ_BUFFER, "write": command_type.WRITE_BUFFER,
        "copy": command_type.COPY_BUFFER}

# ---------------------------------------------------------------------------------------------
# 例外
# ---------------------------------------------------------------------------------------------


class _ErrorRecord:
    def __init__(self, msg, code, routine):
        self._msg, self._code, self._routine = msg, int(code), routine

    def routine(self):
        return self._routine

    def code(self):
        return self._code

    def what(self):
        return self._msg

    def is_out_of_memory(self):
        return self._code in (status_code.MEM_OBJECT_ALLOCATION_FAILURE, status_code.OUT_OF_HOST_MEMORY, status_code.OUT_OF_RESOURCES)


class Error(Exception):
    """真 pyopencl 的 _monkeypatch 假設 args[0] 是 _ErrorRecord，並替 code／routine／what 裝唯讀屬性、替 __str__ 換成它自己的版本；
    所以這裡不能把它們存成實例屬性（否則裝上唯讀屬性後建構會失敗），一律從 args[0] 讀。"""

    def __init__(self, *args):
        # 真的建構子只收一個 _ErrorRecord（pyopencl 的 Program._build_and_catch_errors 就這樣重建例外）；(routine, code, msg) 是內部方便寫法
        if len(args) == 1 and isinstance(args[0], _ErrorRecord):
            Exception.__init__(self, args[0])
        elif len(args) == 3:
            Exception.__init__(self, _ErrorRecord(args[2], args[1], args[0]))
        else:
            Exception.__init__(self, _ErrorRecord(" ".join(str(a) for a in args), 0, ""))

    @property
    def code(self):
        return self.args[0].code()

    @property
    def routine(self):
        return self.args[0].routine()

    @property
    def what(self):
        return self.args[0]

    def __str__(self):
        r = self.args[0]
        name = status_code.to_string(r.code(), "<unknown error %d>") if r.code() != 0 else ""
        head = ("%s failed: %s" % (r.routine(), name)) if r.routine() else name
        m = r.what()
        return head + ((" - " if head else "") + m if m else "")


class MemoryError(Error):
    pass


class LogicError(Error):
    pass


class RuntimeError(Error):
    pass


def _raise(routine, name, msg="", code=None):
    c = code if code is not None else getattr(status_code, name, -9999)
    if c in (status_code.MEM_OBJECT_ALLOCATION_FAILURE, status_code.OUT_OF_HOST_MEMORY, status_code.OUT_OF_RESOURCES):
        cls = MemoryError
    elif c <= -30:   # INVALID_VALUE（-30）以下一律 LogicError，含 KHR 擴充的 -1000／-1001（與真 pyopencl 一樣：常見的 LogicError: clGetPlatformIDs failed: PLATFORM_NOT_FOUND_KHR）
        cls = LogicError
    else:
        cls = RuntimeError
    raise cls(routine, c, msg)


# ---------------------------------------------------------------------------------------------
# 傳輸
# ---------------------------------------------------------------------------------------------

class _StdioTransport(object):
    """一般 Python 用：啟動 `node cl_host_stdio.js`，以框架（4 位元組 JSON 長度、4 位元組資料長度、JSON、資料）收發。"""

    def __init__(self, script, node="node"):
        self._p = subprocess.Popen([node, script], stdin=subprocess.PIPE, stdout=subprocess.PIPE)
        self._id = 0

    def _read(self, n):
        out = b""
        while len(out) < n:
            c = self._p.stdout.read(n - len(out))
            if not c:
                raise RuntimeError("clHost", status_code.OUT_OF_RESOURCES, "後端程序結束了")
            out += c
        return out

    def call(self, op, args=None, data=None):
        import json
        self._id += 1
        h = json.dumps({"id": self._id, "op": op, "args": args or {}}).encode("utf-8")
        d = bytes(data) if data is not None else b""
        self._p.stdin.write(struct.pack("<II", len(h), len(d)) + h + d)
        self._p.stdin.flush()
        hl, dl = struct.unpack("<II", self._read(8))
        res = json.loads(self._read(hl).decode("utf-8"))
        payload = self._read(dl) if dl else None
        return res["result"], payload

    def close(self):
        try:
            self._p.stdin.close()
            self._p.wait(timeout=5)
        except Exception:
            self._p.kill()


class _PyodideTransport(object):
    """Pyodide 裡：_fa_opencl.call(op, jsonString, Uint8Array|undefined) → Promise<{json, data}>。（尚未在 Pyodide 實測。）"""

    def call(self, op, args=None, data=None):
        import json
        from pyodide.ffi import run_sync, to_js
        import _fa_opencl
        r = run_sync(_fa_opencl.call(op, json.dumps(args or {}), to_js(bytes(data)) if data is not None else None))
        payload = bytes(r.data.to_py()) if getattr(r, "data", None) is not None else None
        return json.loads(str(r.json)), payload


_transport = None


def _set_transport(t):
    global _transport
    _transport = t


def _get_transport():
    global _transport
    if _transport is None:
        if sys.platform == "emscripten":
            _transport = _PyodideTransport()
        elif os.environ.get("FA_OPENCL_HOST"):
            _transport = _StdioTransport(os.environ["FA_OPENCL_HOST"], os.environ.get("FA_OPENCL_NODE", "node"))
    return _transport


_ROUTINE = {"platforms": "clGetPlatformIDs", "devices": "clGetDeviceIDs", "ctx_create": "clCreateContext", "queue_create": "clCreateCommandQueue",
            "buf_create": "clCreateBuffer", "buf_write": "clEnqueueWriteBuffer", "buf_read": "clEnqueueReadBuffer", "buf_copy": "clEnqueueCopyBuffer",
            "buf_fill": "clEnqueueFillBuffer", "prog_create": "clCreateProgramWithSource", "prog_build": "clBuildProgram",
            "kernel_create": "clCreateKernel", "kernel_set_arg": "clSetKernelArg", "nd_range": "clEnqueueNDRangeKernel", "finish": "clFinish"}


def _call(op, args=None, data=None):
    t = _get_transport()
    if t is None:
        _raise("clGetPlatformIDs", "PLATFORM_NOT_FOUND_KHR", "沒有 OpenCL 後端（Pyodide 以外請設 FA_OPENCL_HOST 指向 cl_host_stdio.js）")
    res, payload = t.call(op, args or {}, data)
    err = res.get("error") if isinstance(res, dict) else None
    if err:
        _raise(_ROUTINE.get(op, op), err.get("name", "OUT_OF_RESOURCES"), err.get("msg", ""), err.get("code"))
    return res, payload


# ---------------------------------------------------------------------------------------------
# 物件
# ---------------------------------------------------------------------------------------------

class _Handle(object):
    """所有物件的共同部分：控制代碼 h、相等與雜湊、release、屬性後備（真 pyopencl 的 _monkeypatch 會替類別加上唯讀屬性，所以這裡只在屬性缺少時才查 get_info）。"""
    _info_enums = ()
    _h = None

    @property
    def int_ptr(self):
        return self._h

    def __eq__(self, other):
        return type(other) is type(self) and other._h == self._h

    def __ne__(self, other):
        return not self.__eq__(other)

    def __hash__(self):
        return hash((type(self).__name__, self._h))

    @staticmethod
    def from_int_ptr(int_ptr_value, retain=True):
        _raise("from_int_ptr", "INVALID_VALUE", "這個後端不支援 from_int_ptr（物件在宿主那邊，不是真的指標）")

    def release(self):
        h, self._h = self._h, None
        if h is not None:
            try:
                _call("release", {"h": h})
            except Exception:
                pass

    def __getattr__(self, name):
        if not name.startswith("_"):
            up = name.upper()
            for en in type(self)._info_enums:
                if up in en.__dict__:
                    return self.get_info(en.__dict__[up])
        raise AttributeError(name)


def _info_error(routine, param):
    _raise(routine, "INVALID_VALUE", "不支援的查詢參數 0x%x" % int(param))


class Platform(_Handle):
    _info_enums = (platform_info,)

    def __init__(self, rec):
        self._h, self._rec = rec["h"], rec

    def get_info(self, param):
        key = {platform_info.PROFILE: "profile", platform_info.VERSION: "version", platform_info.NAME: "name", platform_info.VENDOR: "vendor",
               platform_info.EXTENSIONS: "extensions"}.get(int(param))
        if key is None:
            _info_error("clGetPlatformInfo", param)
        return self._rec[key]

    def get_devices(self, device_type=device_type.ALL):
        dt = int(device_type)
        name = "ALL" if dt == device_type_ALL else {1: "DEFAULT", 2: "CPU", 4: "GPU", 8: "ACCELERATOR"}.get(dt)
        if name is None:
            _raise("clGetDeviceIDs", "INVALID_DEVICE_TYPE")
        res, _ = _call("devices", {"platform": self._h, "type": name})
        return [Device(d, self) for d in res["devices"]]

    def __repr__(self):
        return "<pyopencl.Platform '%s' holding <fa-icd %d>>" % (self._rec["name"], self._h)


device_type_ALL = int(device_type.ALL)


class Device(_Handle):
    _info_enums = (device_info,)

    def __init__(self, rec, platform):
        self._h, self._rec, self._platform = rec["h"], rec, platform

    def get_info(self, param):
        p, r = int(param), self._rec
        simple = {device_info.NAME: "name", device_info.VENDOR: "vendor", device_info.VERSION: "version", device_info.DRIVER_VERSION: "driver_version",
                  device_info.PROFILE: "profile", device_info.EXTENSIONS: "extensions", device_info.MAX_WORK_GROUP_SIZE: "max_work_group_size",
                  device_info.MAX_WORK_ITEM_SIZES: "max_work_item_sizes", device_info.MAX_WORK_ITEM_DIMENSIONS: "max_work_item_dimensions",
                  device_info.MAX_COMPUTE_UNITS: "max_compute_units", device_info.GLOBAL_MEM_SIZE: "global_mem_size",
                  device_info.MAX_MEM_ALLOC_SIZE: "max_mem_alloc_size", device_info.AVAILABLE: "available",
                  device_info.COMPILER_AVAILABLE: "compiler_available", device_info.ADDRESS_BITS: "address_bits",
                  device_info.LOCAL_MEM_SIZE: "local_mem_size", device_info.LOCAL_MEM_TYPE: "local_mem_type", device_info.MAX_PARAMETER_SIZE: "max_parameter_size",
                  device_info.MAX_CLOCK_FREQUENCY: "max_clock_frequency", device_info.MAX_CONSTANT_BUFFER_SIZE: "max_constant_buffer_size",
                  device_info.ENDIAN_LITTLE: "endian_little", device_info.IMAGE_SUPPORT: "image_support",
                  device_info.ERROR_CORRECTION_SUPPORT: "error_correction_support", device_info.GLOBAL_MEM_CACHELINE_SIZE: "global_mem_cacheline_size",
                  device_info.GLOBAL_MEM_CACHE_SIZE: "global_mem_cache_size", device_info.GLOBAL_MEM_CACHE_TYPE: "global_mem_cache_type",
                  device_info.MEM_BASE_ADDR_ALIGN: "mem_base_addr_align", device_info.MIN_DATA_TYPE_ALIGN_SIZE: "min_data_type_align_size",
                  device_info.PROFILING_TIMER_RESOLUTION: "profiling_timer_resolution", device_info.MAX_CONSTANT_ARGS: "max_constant_args",
                  device_info.MAX_SAMPLERS: "max_samplers", device_info.SVM_CAPABILITIES: "svm_capabilities", device_info.MAX_PIPE_ARGS: "max_pipe_args",
                  device_info.IMAGE2D_MAX_WIDTH: "image2d_max_width", device_info.IMAGE2D_MAX_HEIGHT: "image2d_max_height", device_info.IMAGE3D_MAX_WIDTH: "image3d_max_width",
                  device_info.IMAGE3D_MAX_HEIGHT: "image3d_max_height", device_info.IMAGE3D_MAX_DEPTH: "image3d_max_depth", device_info.IMAGE_MAX_BUFFER_SIZE: "image_max_buffer_size",
                  device_info.IMAGE_MAX_ARRAY_SIZE: "image_max_array_size", device_info.MAX_READ_IMAGE_ARGS: "max_read_image_args", device_info.MAX_WRITE_IMAGE_ARGS: "max_write_image_args",
                  device_info.MAX_READ_WRITE_IMAGE_ARGS: "max_read_write_image_args", device_info.IMAGE_PITCH_ALIGNMENT: "image_pitch_alignment", device_info.IMAGE_BASE_ADDRESS_ALIGNMENT: "image_base_address_alignment",
                  device_info.PIPE_MAX_ACTIVE_RESERVATIONS: "pipe_max_active_reservations", device_info.PIPE_MAX_PACKET_SIZE: "pipe_max_packet_size", device_info.PIPE_SUPPORT: "pipe_support"}
        if p in simple:
            return r[simple[p]]
        if p == device_info.TYPE:
            return {"CPU": device_type.CPU, "GPU": device_type.GPU}.get(r["type"], device_type.DEFAULT)
        if p == device_info.PLATFORM:
            return self._platform
        if p == device_info.VENDOR_ID:
            return 0
        if p == device_info.OPENCL_C_VERSION:
            return "OpenCL C 1.2"
        _info_error("clGetDeviceInfo", param)

    def __repr__(self):
        return "<pyopencl.Device '%s' on '%s'>" % (self._rec["name"], self._platform._rec["name"])


def _parse_context_properties(properties):
    """cl.Context 的 properties：[(鍵, 值), …]（或攤平的 [鍵, 值, …]）。PLATFORM 取平台；GL_CONTEXT_KHR 等 GL 屬性要與目前 GL 上下文相符
    （值來自 pyopencl.tools.get_gl_sharing_context_properties，在網頁上由 fa_pyopencl 用我們的 GL 上下文回應），不符＝INVALID_GL_SHAREGROUP_REFERENCE_KHR。"""
    if not properties:
        return [], None, False
    items = list(properties)
    if items and not isinstance(items[0], (tuple, list)):
        items = [(items[k], items[k + 1]) for k in range(0, len(items) - 1, 2) if items[k] != 0]
    props, platform, gl = [], None, False
    gl_keys = tuple(getattr(context_properties, n) for n in ("GL_CONTEXT_KHR", "EGL_DISPLAY_KHR", "GLX_DISPLAY_KHR", "WGL_HDC_KHR", "CGL_SHAREGROUP_KHR")
                    if hasattr(context_properties, n))   # CGL_SHAREGROUP_KHR 在 cl_gl_ext.h（沒下載），有就用
    ctx_handle = None
    for k, v in items:
        k = int(k)
        if k == context_properties.PLATFORM:
            if not isinstance(v, Platform):
                _raise("clCreateContext", "INVALID_PLATFORM", "PLATFORM 屬性的值要是 Platform 物件")
            platform = v
        elif k in gl_keys:
            gl = True
            if k == context_properties.GL_CONTEXT_KHR:
                ctx_handle = int(v)
        else:
            _raise("clCreateContext", "INVALID_PROPERTY", "不認得的 context 屬性 0x%x" % k)
        props.append((k, v))
    if gl:
        try:
            import fa_opengl_platform as P
            cur = P.interop_context_handle()
        except ImportError:
            cur = 0
        if not cur or ctx_handle != cur:
            _raise("clCreateContext", "INVALID_GL_SHAREGROUP_REFERENCE_KHR", "GL_CONTEXT_KHR（%s）不是目前的 GL 上下文（%s）——要先建立 GL 上下文，並用 get_gl_sharing_context_properties() 取得屬性" % (ctx_handle, cur or "沒有"))
    return props, platform, gl


class Context(_Handle):
    _info_enums = (context_info,)

    def __init__(self, devices=None, properties=None, dev_type=None):
        props, want_platform, gl_shared = _parse_context_properties(properties)
        if devices is None:   # 與真 pyopencl 一樣：依 dev_type（預設全部）找第一個有裝置的平台（properties 有 PLATFORM 就用它），用它的第一個裝置
            devices = []
            for p in ([want_platform] if want_platform is not None else get_platforms()):
                try:
                    devices = p.get_devices(device_type.ALL if dev_type is None else dev_type)[:1]
                except Error:
                    devices = []
                if devices:
                    break
            if not devices:
                _raise("clCreateContext", "DEVICE_NOT_FOUND", "沒有可用的裝置")
        if not devices:
            _raise("clCreateContext", "INVALID_VALUE", "devices 是空的")
        if want_platform is not None and any(d._platform != want_platform for d in devices):
            _raise("clCreateContext", "INVALID_PLATFORM", "properties 的 PLATFORM 與 devices 不是同一個平台")
        res, _ = _call("ctx_create", {"devices": [d._h for d in devices]})
        self._h, self._devices, self._props, self._gl_shared = res["h"], list(devices), props, gl_shared

    def get_info(self, param):
        p = int(param)
        if p == context_info.DEVICES:
            return list(self._devices)
        if p == context_info.NUM_DEVICES:
            return len(self._devices)
        if p == context_info.REFERENCE_COUNT:
            return 1
        if p == context_info.PROPERTIES:   # 與真的一樣：[鍵, 值, 鍵, 值, …, 0]
            flat = []
            for k, v in self._props:
                flat += [k, v._h if isinstance(v, Platform) else int(v)]
            return flat + [0] if flat else []
        _info_error("clGetContextInfo", param)

    def set_default_device_command_queue(self, device, queue):
        if queue._ctx is not self and queue._ctx != self:
            _raise("clSetDefaultDeviceCommandQueue", "INVALID_COMMAND_QUEUE", "佇列不屬於這個內容")
        self._default_queues = getattr(self, "_default_queues", {})
        self._default_queues[device._h] = queue   # 沒有裝置端的 enqueue（OpenCL 2.0 的 device-side queue），所以只記下來

    def __repr__(self):
        return "<pyopencl.Context at fa-icd %s on %s>" % (self._h, ", ".join("<%s>" % d._rec["name"] for d in self._devices))


class CommandQueue(_Handle):
    _info_enums = (command_queue_info,)

    def __init__(self, context, device=None, properties=0):
        props = int(properties or 0)
        if props & command_queue_properties.OUT_OF_ORDER_EXEC_MODE_ENABLE:
            _raise("clCreateCommandQueue", "INVALID_QUEUE_PROPERTIES", "這個後端只有循序佇列")
        if device is None:
            device = context._devices[0]
        res, _ = _call("queue_create", {"ctx": context._h, "device": device._h, "profiling": bool(props & command_queue_properties.PROFILING_ENABLE)})
        self._h, self._ctx, self._dev, self._props = res["h"], context, device, props

    def get_info(self, param):
        p = int(param)
        if p == command_queue_info.CONTEXT:
            return self._ctx
        if p == command_queue_info.DEVICE:
            return self._dev
        if p == command_queue_info.REFERENCE_COUNT:
            return 1
        if p == command_queue_info.PROPERTIES:
            return self._props
        _info_error("clGetCommandQueueInfo", param)

    def flush(self):
        return None

    def finish(self):
        _call("finish", {"queue": self._h})

    def _finalize(self):
        self.release()

    def __del__(self):
        try:
            self.release()
        except Exception:
            pass


class Event(_Handle):
    _info_enums = (event_info,)

    def __init__(self, rec, queue):
        self._h, self._rec, self._queue = rec["h"], rec, queue

    def wait(self):
        return None   # 這個後端的操作都已完成

    def get_info(self, param):
        p = int(param)
        if p == event_info.COMMAND_EXECUTION_STATUS:
            return command_execution_status.COMPLETE
        if p == event_info.COMMAND_QUEUE:
            return self._queue
        if p == event_info.COMMAND_TYPE:
            return _CMD.get(self._rec["cmd"], command_type.MARKER)
        if p == event_info.REFERENCE_COUNT:
            return 1
        if p == event_info.CONTEXT:
            return self._queue._ctx
        _info_error("clGetEventInfo", param)

    def get_profiling_info(self, param):
        if not (self._queue._props & command_queue_properties.PROFILING_ENABLE):
            _raise("clGetEventProfilingInfo", "PROFILING_INFO_NOT_AVAILABLE", "佇列沒有開 PROFILING_ENABLE")
        key = {profiling_info.QUEUED: "queued", profiling_info.SUBMIT: "queued", profiling_info.START: "start", profiling_info.END: "end"}.get(int(param))
        if key is None:
            _info_error("clGetEventProfilingInfo", param)
        return int(self._rec[key])

    @property
    def profile(self):
        ev = self

        class _P(object):
            def __getattr__(self, n):
                return ev.get_profiling_info(getattr(profiling_info, n.upper()))
        return _P()

    def set_callback(self, command_exec_callback_type, pfn_event_notify):
        pfn_event_notify(command_execution_status.COMPLETE)

    def __del__(self):
        try:
            self.release()
        except Exception:
            pass


NannyEvent = Event


def wait_for_events(events):
    return None


class MemoryObjectHolder(_Handle):
    _info_enums = (mem_info,)

    def get_info(self, param):
        p = int(param)
        if p == mem_info.SIZE:
            return self._size
        if p == mem_info.FLAGS:
            return self._flags
        if p == mem_info.CONTEXT:
            return self._ctx
        if p == mem_info.TYPE:
            return getattr(self, "_mtype", mem_object_type.BUFFER)   # 圖像在 __init__ 設 _mtype（真 pyopencl 層的屬性綁在基底類別的 get_info 上，所以要在這裡判斷）
        if p == mem_info.MAP_COUNT or p == 0:
            return 0
        if hasattr(mem_info, "OFFSET") and p == mem_info.OFFSET:
            return self._offset
        if hasattr(mem_info, "ASSOCIATED_MEMOBJECT") and p == mem_info.ASSOCIATED_MEMOBJECT:
            return self._parent
        if p == mem_info.REFERENCE_COUNT:
            return 1
        _info_error("clGetMemObjectInfo", param)

    def get_host_array(self, shape, dtype, order="C"):
        _raise("get_host_array", "INVALID_VALUE", "USE_HOST_PTR 不與主機記憶體別名，這個後端沒有主機陣列")

    def __del__(self):
        try:
            self.release()
        except Exception:
            pass


class MemoryObject(MemoryObjectHolder):
    pass


def _byte_view(buf):
    """主機緩衝的位元組視圖（可寫就可寫）。接受任何「連續」的陣列——C 連續、或 F 連續（pyopencl.array 轉置後自己配的接收陣列就是 F 連續）；
    真的不連續（有跨步間隙）丟 INVALID_HOST_PTR，與真 C++ 層（PyBUF_ANY_CONTIGUOUS）一樣。"""
    try:
        return memoryview(buf).cast("B")
    except (TypeError, ValueError):
        a = np.asarray(buf)
        if a.flags.f_contiguous:
            return memoryview(a.T).cast("B")   # F 連續的轉置是 C 連續，同一塊記憶體
        _raise("clEnqueueCopy", "INVALID_HOST_PTR", "主機陣列不是連續的記憶體（shape %s、strides %s）" % (a.shape, a.strides))


def _as_bytes(buf):
    return bytes(_byte_view(buf))


class Buffer(MemoryObject):
    def __init__(self, context, flags, size=0, hostbuf=None, properties=None):
        flags = int(flags)
        if properties:
            _raise("clCreateBufferWithProperties", "INVALID_PROPERTY", "不支援緩衝區 properties")
        data = None
        if hostbuf is not None:
            data = _as_bytes(hostbuf)
            if not size:
                size = len(data)
            if len(data) < size:
                _raise("clCreateBuffer", "INVALID_HOST_PTR", "hostbuf（%d 位元組）比 size（%d）小" % (len(data), size))
            data = data[:size]
        elif flags & (mem_flags.COPY_HOST_PTR | mem_flags.USE_HOST_PTR):
            _raise("clCreateBuffer", "INVALID_HOST_PTR", "COPY_HOST_PTR／USE_HOST_PTR 需要 hostbuf")
        if not size:
            _raise("clCreateBuffer", "INVALID_BUFFER_SIZE", "size 要大於 0")
        res, _ = _call("buf_create", {"ctx": context._h, "flags": flags, "size": int(size)}, data)
        self._h, self._ctx, self._size, self._flags = res["h"], context, int(size), flags

    _parent = None
    _offset = 0

    def get_sub_region(self, origin, size, flags=0):
        """子緩衝區：與父緩衝區共用同一塊記憶體（寫一邊另一邊看得到）。可以當核心參數、可以 enqueue_copy。"""
        if self._parent is not None:
            _raise("clCreateSubBuffer", "INVALID_MEM_OBJECT", "子緩衝區的子緩衝區不合法")
        res, _ = _call("buf_sub", {"mem": self._h, "origin": int(origin), "size": int(size), "flags": int(flags)})
        sub = Buffer.__new__(Buffer)
        sub._h, sub._ctx, sub._size, sub._flags = res["h"], self._ctx, int(size), int(flags) or self._flags
        sub._parent, sub._offset = self, int(origin)
        return sub

    def __getitem__(self, arg):
        if not isinstance(arg, slice):
            _raise("clCreateSubBuffer", "INVALID_VALUE", "要用切片，例如 buf[16:48]")
        start, stop, step = arg.indices(self._size)
        if step != 1:
            _raise("clCreateSubBuffer", "INVALID_VALUE", "切片的步長要是 1")
        return self.get_sub_region(start, stop - start)

    def __repr__(self):
        return "<pyopencl.Buffer of size %d at fa-icd %s>" % (self._size, self._h)


def _include_dirs(options):
    import shlex
    toks = shlex.split(options) if options else []
    dirs = []
    for k, tk in enumerate(toks):
        if tk == "-I" and k + 1 < len(toks):
            dirs.append(toks[k + 1])
        elif tk.startswith("-I") and len(tk) > 2:
            dirs.append(tk[2:])
    return dirs


def _expand_includes(src, options, _depth=0, _once=None):
    """把 `#include <x>`／`#include "x"` 依 -I 目錄內嵌進原始碼。前端（宿主）沒有檔案系統，所以由 Python 端做，
    與真的 OpenCL 驅動「在 build 時依 -I 讀標頭」同一個語意。`#pragma once` 只展開一次；標頭沒找到＝BUILD_PROGRAM_FAILURE。"""
    import re
    if "#include" not in src and "# include" not in src:
        return src
    if _depth > 16:
        _raise("clBuildProgram", "BUILD_PROGRAM_FAILURE", "#include 巢狀太深（遞迴？）")
    dirs = _include_dirs(options)
    once = _once if _once is not None else set()
    out = []
    for line in src.split("\n"):
        m = re.match(r'\s*#\s*include\s*([<"])([^>"]+)[>"]', line)
        if not m:
            out.append(line)
            continue
        name, found = m.group(2), None
        for d in dirs:
            cand = os.path.join(d, name)
            if os.path.isfile(cand):
                found = cand
                break
        if found is None:
            _raise("clBuildProgram", "BUILD_PROGRAM_FAILURE", "找不到標頭 %s（-I 路徑：%s）" % (name, ", ".join(dirs) or "沒有"))
        real = os.path.realpath(found)
        if real in once:
            continue
        with open(found, encoding="utf-8", errors="replace") as f:
            text = f.read()
        if re.search(r"^\s*#\s*pragma\s+once", text, re.M):
            once.add(real)
        out.append(_expand_includes(text, options, _depth + 1, once))
    return "\n".join(out)


_BIN_MAGIC = b"FAKIR1\n"   # 這個後端的「二進位」＝魔術標頭＋OpenCL C 原始碼（JIT 後端的可攜表示，像 SPIR／PTX 文字）；讓 pyopencl 的磁碟編譯快取能運作


class _Program(_Handle):
    def __init__(self, context, src, binaries=None):
        # 兩種建構：_Program(ctx, 原始碼) 與 _Program(ctx, devices, binaries)（pyopencl 的編譯快取從磁碟讀回時用；src 在這裡是 devices）
        self._from_binary = False
        if binaries is not None:
            bins = list(binaries)
            if not bins or any(not bytes(b).startswith(_BIN_MAGIC) for b in bins):
                _raise("clCreateProgramWithBinary", "INVALID_BINARY", "不是這個後端產生的二進位（要以 %r 開頭）" % _BIN_MAGIC)
            src = bytes(bins[0])[len(_BIN_MAGIC):]
            self._from_binary = True
        if isinstance(src, (bytes, bytearray)):
            src = bytes(src).decode("utf-8")
        res, _ = _call("prog_create", {"ctx": context._h, "src": src})
        self._h, self._ctx, self._src, self._built, self._log, self._options, self._kernels = res["h"], context, src, False, "", "", []

    @staticmethod
    def create_with_built_in_kernels(context, devices, kernel_names):
        _raise("clCreateProgramWithBuiltInKernels", "INVALID_VALUE", "這個後端沒有內建核心")

    def kind(self):
        return program_kind.BINARY if self._from_binary else program_kind.SOURCE

    def _build(self, options=b"", devices=None):
        opt = options.decode("utf-8") if isinstance(options, (bytes, bytearray)) else str(options or "")
        self._options = opt
        try:
            expanded = _expand_includes(self._src, opt)   # 真的驅動也是在 build 時依 -I 讀標頭
        except Error:
            self._built = False
            raise
        try:
            res, _ = _call("prog_build", {"prog": self._h, "options": opt, "src": expanded if expanded != self._src else None})
        except Error:
            self._built = False
            info, _ = _call("prog_info", {"prog": self._h})   # build log 給 get_build_info(LOG)（真 pyopencl 的 Program.build 會讀它）
            self._log = info.get("log", "")
            raise
        self._built, self._log, self._kernels = True, res.get("log", ""), list(res["kernels"])

    def get_build_info(self, device, param):
        p = int(param)
        if p == program_build_info.LOG:
            return self._log
        if p == program_build_info.OPTIONS:
            return self._options
        if p == program_build_info.STATUS:
            return 0 if self._built else -2
        _info_error("clGetProgramBuildInfo", param)

    def get_info(self, param):
        p = int(param)
        if p == program_info.KERNEL_NAMES:
            if not self._built:
                _raise("clGetProgramInfo", "INVALID_PROGRAM_EXECUTABLE", "程式還沒有 build")
            return ";".join(self._kernels)
        if p == program_info.NUM_KERNELS:
            return len(self._kernels)
        if p == program_info.BINARIES:
            if not self._built:
                _raise("clGetProgramInfo", "INVALID_PROGRAM_EXECUTABLE", "程式還沒有 build")
            return [_BIN_MAGIC + self._src.encode("utf-8") for _ in self._ctx._devices]
        if p == program_info.BINARY_SIZES:
            return [len(_BIN_MAGIC) + len(self._src.encode("utf-8")) for _ in self._ctx._devices]
        if p == program_info.SOURCE:
            return self._src
        if p == program_info.CONTEXT:
            return self._ctx
        if p == program_info.DEVICES:
            return list(self._ctx._devices)
        if p == program_info.NUM_DEVICES:
            return len(self._ctx._devices)
        if p == program_info.REFERENCE_COUNT:
            return 1
        _info_error("clGetProgramInfo", param)

    def compile(self, options=b"", devices=None, headers=[]):
        """分開編譯：headers＝[(名稱, Program), …]，源碼裡的 #include <名稱> 以那個程式的源碼取代；之後用 link 連結成可執行程式。
        這個後端的「編譯物件」就是展開 #include 之後的源碼（連結時合併）；語法與型別錯誤在 compile 就回報（與真的編譯器一樣）。"""
        opt = options.decode("utf-8") if isinstance(options, (bytes, bytearray)) else str(options or "")
        src = self._src
        for name, hp in headers:   # 先換掉 headers 提供的標頭，剩下的 #include 再依 -I 找
            hsrc = hp._src if isinstance(hp, _Program) else getattr(hp, "_prg", hp)._src
            import re as _re
            src = _re.sub(r'^\s*#\s*include\s*[<"]%s[>"].*$' % _re.escape(name), lambda m: hsrc, src, flags=_re.M)
        src = _expand_includes(src, opt)
        probe, err = _Program(self._ctx, src), None
        try:
            probe._build(opt.encode())   # 試編譯：錯誤在這裡就回報
        except Error as e:
            err = e
        if err is not None:
            self._built = False
            self._log = probe._log
            _raise("clCompileProgram", "COMPILE_PROGRAM_FAILURE", probe._log)
        self._compiled_src, self._log = src, probe._log
        self._compiled = True

    @staticmethod
    def link(context, programs, options=b"", devices=None):
        """連結：把幾個已 compile 的程式合併成一個可執行程式（源碼串接；同名核心重複會在 build 時報錯）。"""
        parts = []
        for pr in programs:
            if not isinstance(pr, _Program):
                pr = getattr(pr, "_prg", pr)
            parts.append(getattr(pr, "_compiled_src", None) or pr._src)
        linked = _Program(context, "\n".join(parts))
        try:
            linked._build(options)
        except Error:
            _raise("clLinkProgram", "LINK_PROGRAM_FAILURE", linked._log)
        return linked

    def set_specialization_constant(self, spec_id, buffer):
        _raise("clSetProgramSpecializationConstant", "INVALID_OPERATION", "OpenCL 2.2 的功能")

    def all_kernels(self):
        return [Kernel(self, n) for n in self._kernels]

    def __del__(self):
        try:
            self.release()
        except Exception:
            pass


def _create_program_with_il(context, il):
    _raise("clCreateProgramWithIL", "INVALID_VALUE", "不支援 IL（SPIR-V）程式")


def _is_vector_type(t):
    import re
    return re.match(r"^(char|uchar|short|ushort|int|uint|long|ulong|float|double)(2|3|4|8|16)$", t) is not None


# 核心純量參數的型別名（KIR 驅動用 i32／f32；clc 驅動用 OpenCL C 的型別名）→ (整數或浮點, 位元組數, numpy 型別名)
_SCALAR_DTYPE = {"i32": ("i", 4, "int32"), "f32": ("f", 4, "float32"), "int": ("i", 4, "int32"), "uint": ("i", 4, "uint32"), "long": ("i", 8, "int64"),
                 "ulong": ("i", 8, "uint64"), "short": ("i", 2, "int16"), "ushort": ("i", 2, "uint16"), "char": ("i", 1, "int8"), "uchar": ("i", 1, "uint8"),
                 "float": ("f", 4, "float32"), "double": ("f", 8, "float64")}


_VEC_BASE_NP = {"char": "i1", "uchar": "u1", "short": "i2", "ushort": "u2", "int": "i4", "uint": "u4", "long": "i8", "ulong": "u8", "float": "f4", "double": "f8"}


def _vector_arg_values(spec, arg):
    """核心的向量純量參數（float2、int4…）：接受 numpy 向量 dtype 的純量（np.void，例如 cltypes.float4）、複數（complex64 → float2）、
    numpy 陣列、位元組（pyopencl 的呼叫器用 struct.pack 出來的）、list／tuple；回傳 [元素, …]。"""
    import re
    m = re.match(r"^(char|uchar|short|ushort|int|uint|long|ulong|float|double)(2|3|4|8|16)$", spec["type"])
    base, n = m.group(1), int(m.group(2))
    dt = np.dtype(_VEC_BASE_NP[base])
    if isinstance(arg, (list, tuple)):
        vals = np.array(arg, dtype=dt)
    else:
        raw = bytes(arg) if isinstance(arg, (bytes, bytearray)) else np.asarray(arg).tobytes()
        if len(raw) < n * dt.itemsize:
            _raise("clSetKernelArg", "INVALID_ARG_SIZE", "參數 %s 要 %d 個 %s（%d 位元組），得到 %d 位元組" % (spec["name"], n, base, n * dt.itemsize, len(raw)))
        vals = np.frombuffer(raw[:n * dt.itemsize], dtype=dt)
    if len(vals) != n:
        _raise("clSetKernelArg", "INVALID_ARG_SIZE", "參數 %s 要 %d 個元素，得到 %d" % (spec["name"], n, len(vals)))
    return vals.tolist()


class LocalMemory(object):
    def __init__(self, size):
        self.size = size


# struct 風格的型別字元（pyopencl 的呼叫器用 pack('f', x) 與 BUF_PACK_TYPECHARS）→ numpy 型別
_PACK_DTYPE = {"c": "S1", "b": "i1", "B": "u1", "h": "i2", "H": "u2", "i": "i4", "I": "u4", "l": "l", "L": "L", "q": "i8", "Q": "u8", "f": "f4", "d": "f8"}


class Kernel(_Handle):
    _info_enums = (kernel_info,)
    _gen_enqueue = None
    _gen_set_args = None

    def __init__(self, program, name):
        prog = getattr(program, "_prg", program)
        res, _ = _call("kernel_create", {"prog": prog._h, "name": name})
        self._h, self._prog, self._name, self._args = res["h"], prog, name, res["args"]
        self._program_obj = program

    def get_info(self, param):
        p = int(param)
        if p == kernel_info.FUNCTION_NAME:
            return self._name
        if p == kernel_info.NUM_ARGS:
            return len(self._args)
        if p == kernel_info.CONTEXT:
            return self._prog._ctx
        if p == kernel_info.PROGRAM:
            return self._program_obj
        if p == kernel_info.ATTRIBUTES:
            return ""
        if p == kernel_info.REFERENCE_COUNT:
            return 1
        _info_error("clGetKernelInfo", param)

    def get_work_group_info(self, param, device):
        """（真 pyopencl 的 _monkeypatch 會包一層快取。）這個後端是一維逐元素核心：不分工作群，數值是保守的固定值。"""
        p = int(param)
        d = device
        if p == kernel_work_group_info.WORK_GROUP_SIZE:
            return d._rec["max_work_group_size"]
        if p == kernel_work_group_info.PREFERRED_WORK_GROUP_SIZE_MULTIPLE:
            return 1
        if p in (kernel_work_group_info.LOCAL_MEM_SIZE, kernel_work_group_info.PRIVATE_MEM_SIZE):
            return 0
        if p in (kernel_work_group_info.COMPILE_WORK_GROUP_SIZE, kernel_work_group_info.GLOBAL_WORK_SIZE):
            return [0, 0, 0]
        _info_error("clGetKernelWorkGroupInfo", param)

    def clone(self):
        k = Kernel(self._program_obj, self._name)
        k._gen_enqueue, k._gen_set_args = self._gen_enqueue, self._gen_set_args
        return k

    def set_arg(self, index, arg):
        if not (0 <= index < len(self._args)):
            _raise("clSetKernelArg", "INVALID_ARG_INDEX", "核心 %s 只有 %d 個參數" % (self._name, len(self._args)))
        spec = self._args[index]
        svm_map = self.__dict__.setdefault("_svm", {})
        svm_map.pop(index, None)
        if isinstance(arg, SVMPointer):
            if spec["kind"] != "buf":
                _raise("clSetKernelArgSVMPointer", "INVALID_ARG_VALUE", "參數 %s 不是指標，不能傳 SVM 指標" % spec["name"])
            a, off = _svm_resolve(int(arg.svm_ptr), "clSetKernelArgSVMPointer")
            _call("kernel_set_arg", {"kernel": self._h, "index": index, "mem": a._as_buffer(off, a._size - off) if off else a._buf_h})
            svm_map[index] = a
            return
        if isinstance(arg, LocalMemory):
            if spec["kind"] != "local":
                _raise("clSetKernelArg", "INVALID_ARG_VALUE", "參數 %s 不是 __local 指標，不能傳 LocalMemory（這個驅動只有 OpenCL C 前端支援 __local）" % spec["name"])
            _call("kernel_set_arg", {"kernel": self._h, "index": index, "local": int(arg.size)})
            return
        if spec["kind"] == "local":
            _raise("clSetKernelArg", "INVALID_ARG_SIZE", "參數 %s 是 __local 指標，要傳 LocalMemory(位元組數)" % spec["name"])
        if spec["kind"] == "pipe":
            if not isinstance(arg, Pipe):
                _raise("clSetKernelArg", "INVALID_MEM_OBJECT", "參數 %s 要傳 Pipe，得到 %s" % (spec["name"], type(arg).__name__))
            _call("kernel_set_arg", {"kernel": self._h, "index": index, "mem": arg._h})
            return
        if isinstance(arg, Pipe):
            _raise("clSetKernelArg", "INVALID_MEM_OBJECT", "參數 %s 不是 pipe，不能傳 Pipe" % spec["name"])
        if spec["kind"] == "image":
            if not isinstance(arg, Image):
                _raise("clSetKernelArg", "INVALID_MEM_OBJECT", "參數 %s 要傳 Image，得到 %s" % (spec["name"], type(arg).__name__))
            _call("kernel_set_arg", {"kernel": self._h, "index": index, "mem": arg._h})
            return
        if spec["kind"] == "buf":
            if isinstance(arg, Image):
                _raise("clSetKernelArg", "INVALID_MEM_OBJECT", "參數 %s 是緩衝區指標，不能傳圖像" % spec["name"])
            if not isinstance(arg, MemoryObjectHolder):
                _raise("clSetKernelArg", "INVALID_MEM_OBJECT", "參數 %s 要傳 Buffer，得到 %s" % (spec["name"], type(arg).__name__))
            _call("kernel_set_arg", {"kernel": self._h, "index": index, "mem": arg._h})
            return
        if isinstance(arg, MemoryObjectHolder):
            _raise("clSetKernelArg", "INVALID_ARG_SIZE", "參數 %s 是純量，不能傳緩衝區" % spec["name"])
        if isinstance(arg, Sampler):
            if spec["type"] != "uint":
                _raise("clSetKernelArg", "INVALID_SAMPLER", "參數 %s（%s）不是 sampler_t" % (spec["name"], spec["type"]))
            _call("kernel_set_arg", {"kernel": self._h, "index": index, "scalar": arg._bits})
            return
        if _is_vector_type(spec["type"]):
            _call("kernel_set_arg", {"kernel": self._h, "index": index, "scalar": _vector_arg_values(spec, arg)})
            return
        if spec["type"] == "struct":   # struct 傳值（例如複數 cfloat_t）：numpy 純量（complex64、結構化 np.void）或位元組
            raw = bytes(arg) if isinstance(arg, (bytes, bytearray)) else np.asarray(arg).tobytes()
            if spec.get("size") and len(raw) != spec["size"]:
                _raise("clSetKernelArg", "INVALID_ARG_SIZE", "參數 %s（struct）要 %d 位元組，得到 %d" % (spec["name"], spec["size"], len(raw)))
            _call("kernel_set_arg", {"kernel": self._h, "index": index, "scalar": list(raw)})
            return
        a = np.asarray(arg)
        if a.ndim != 0 and a.size != 1:
            _raise("clSetKernelArg", "INVALID_ARG_SIZE", "純量參數 %s 要傳單一個 numpy 純量" % spec["name"])
        want = _SCALAR_DTYPE.get(spec["type"])
        if want is None:
            _raise("clSetKernelArg", "INVALID_ARG_VALUE", "參數 %s 的型別 %s 這個後端不認得" % (spec["name"], spec["type"]))
        wk, wsz, wname = want
        if a.dtype.itemsize != wsz or (a.dtype.kind in "iub") != (wk == "i"):   # 大小要對；整數與浮點不能混（真 OpenCL 只看大小，但會把位元重新解讀，這裡寧可明確報錯）
            _raise("clSetKernelArg", "INVALID_ARG_SIZE", "參數 %s 要是 %s（%d 位元組），得到 %s——請用 numpy.%s(...)" % (spec["name"], wname, wsz, a.dtype, wname))
        _call("kernel_set_arg", {"kernel": self._h, "index": index, "scalar": a.item()})

    def set_args(self, *args):
        if self._gen_set_args is not None:
            return self._gen_set_args(self, *args)
        for i, a in enumerate(args):
            self.set_arg(i, a)

    # ---- pyopencl 的 set_scalar_arg_dtypes 產生的呼叫器用到的私有方法（真 _cl 的 C++ 類別提供）----
    def _set_enqueue_and_set_args(self, enqueue, set_args):   # pyopencl.invoker.generate_enqueue_and_set_args 回傳的兩個產生出來的函式
        self._gen_enqueue, self._gen_set_args = enqueue, set_args

    def _set_arg_multi(self, seq):   # (idx, 物件, idx, 物件, …)
        for k in range(0, len(seq), 2):
            self.set_arg(seq[k], seq[k + 1])

    def _set_arg_buf(self, index, data):   # 原始位元組（pack 的結果）→ 依核心參數的型別解讀
        spec = self._args[index]
        if spec["kind"] == "scalar" and spec["type"] == "struct":
            if spec.get("size") and len(data) != spec["size"]:
                _raise("clSetKernelArg", "INVALID_ARG_SIZE", "參數 %s（struct）要 %d 位元組，得到 %d" % (spec["name"], spec["size"], len(data)))
            _call("kernel_set_arg", {"kernel": self._h, "index": index, "scalar": list(bytes(data))})
            return
        if spec["kind"] == "scalar" and _is_vector_type(spec["type"]):
            _call("kernel_set_arg", {"kernel": self._h, "index": index, "scalar": _vector_arg_values(spec, bytes(data))})
            return
        want = _SCALAR_DTYPE.get(spec["type"]) if spec["kind"] == "scalar" else None
        if want is None:
            _raise("clSetKernelArg", "INVALID_ARG_VALUE", "參數 %s 不是純量" % spec["name"])
        if len(data) != want[1]:
            _raise("clSetKernelArg", "INVALID_ARG_SIZE", "參數 %s 要 %d 位元組，得到 %d" % (spec["name"], want[1], len(data)))
        self.set_arg(index, np.frombuffer(bytes(data), dtype=want[2])[0])

    def _set_arg_buf_multi(self, seq):   # (idx, 位元組, idx, 位元組, …)
        for k in range(0, len(seq), 2):
            self._set_arg_buf(seq[k], seq[k + 1])

    def _set_arg_buf_pack_multi(self, seq):   # (idx, 型別字元(bytes), 值, …)
        for k in range(0, len(seq), 3):
            tc = seq[k + 1].decode() if isinstance(seq[k + 1], (bytes, bytearray)) else seq[k + 1]
            self.set_arg(seq[k], np.array(seq[k + 2], dtype=_PACK_DTYPE[tc])[()])

    def get_arg_info(self, index, param_name):
        if not (0 <= index < len(self._args)):
            _raise("clGetKernelArgInfo", "INVALID_ARG_INDEX", "核心 %s 只有 %d 個參數" % (self._name, len(self._args)))
        spec, p = self._args[index], int(param_name)
        if p == kernel_arg_info.NAME:
            return spec["name"]
        if p == kernel_arg_info.ADDRESS_QUALIFIER:
            return {"buf": kernel_arg_address_qualifier.GLOBAL, "local": kernel_arg_address_qualifier.LOCAL}.get(spec["kind"], kernel_arg_address_qualifier.PRIVATE)
        if p == kernel_arg_info.ACCESS_QUALIFIER:
            return kernel_arg_access_qualifier.NONE
        if p == kernel_arg_info.TYPE_NAME:
            tn = {"i32": "int", "f32": "float"}.get(spec["type"], spec["type"])   # KIR 驅動用 i32／f32，其餘用 OpenCL C 的型別名
            return tn + "*" if spec["kind"] != "scalar" else tn
        if p == kernel_arg_info.TYPE_QUALIFIER:
            return kernel_arg_type_qualifier.CONST if spec.get("access") == "in" else kernel_arg_type_qualifier.NONE
        _info_error("clGetKernelArgInfo", param_name)

    def get_sub_group_info(self, device, param, input_value=None):
        """沒有 SIMD 子群組：每個子群組就是 1 個工作項（OpenCL 規定的合法最小值）。"""
        p = int(param)
        if p == kernel_sub_group_info.MAX_SUB_GROUP_SIZE_FOR_NDRANGE:
            return 1
        if p == kernel_sub_group_info.SUB_GROUP_COUNT_FOR_NDRANGE:
            n = 1
            for x in (input_value if input_value is not None else ()):
                n *= int(x)
            return n
        if p == kernel_sub_group_info.LOCAL_SIZE_FOR_SUB_GROUP_COUNT:
            return [int(input_value), 1, 1]
        if p == kernel_sub_group_info.MAX_NUM_SUB_GROUPS:
            return device._rec["max_work_group_size"]
        if p == kernel_sub_group_info.COMPILE_NUM_SUB_GROUPS:
            return 0
        _info_error("clGetKernelSubGroupInfo", param)

    def __call__(self, queue, global_work_size, local_work_size, *args, **kwargs):
        if self._gen_enqueue is not None:   # 呼叫過 set_scalar_arg_dtypes：用 pyopencl 產生的呼叫器
            return self._gen_enqueue(self, queue, global_work_size, local_work_size, *args, **kwargs)
        wait_for = kwargs.pop("wait_for", None)
        g_times_l = kwargs.pop("g_times_l", False)
        allow_empty_ndrange = kwargs.pop("allow_empty_ndrange", False)
        global_offset = kwargs.pop("global_offset", None)
        if kwargs:
            raise TypeError("不認得的參數：%s" % ", ".join(kwargs))
        self.set_args(*args)
        return enqueue_nd_range_kernel(queue, self, global_work_size, local_work_size, global_offset, wait_for,
                                       g_times_l=g_times_l, allow_empty_ndrange=allow_empty_ndrange)

    def __del__(self):
        try:
            self.release()
        except Exception:
            pass


# ---------------------------------------------------------------------------------------------
# 模組函式
# ---------------------------------------------------------------------------------------------

def get_platforms():
    res, _ = _call("platforms")
    if not res["platforms"]:
        _raise("clGetPlatformIDs", "PLATFORM_NOT_FOUND_KHR")
    return [Platform(p) for p in res["platforms"]]


def get_cl_header_version():
    return (2, 0)   # 真 pyopencl 層只拿它決定要不要啟用 SVM 的程式碼（_monkeypatch／array／tools）；執行期版本照裝置回報


def have_gl():
    return True   # GL 互通（cl_khr_gl_sharing 的 GLBuffer）：緩衝區走 fa_opengl_platform 的 interop 鉤子；圖像與紋理不支援


def _sizeof_size_t():
    return 8   # 這個後端的 OpenCL C 前端把 size_t 當 64 位元（ulong）


def bitlog2(x):
    return int(x).bit_length() - 1


def enqueue_nd_range_kernel(queue, kernel, global_work_size, local_work_size, global_offset=None, wait_for=None,
                            g_times_l=False, allow_empty_ndrange=False):   # pyi 寫成關鍵字專用，但 pyopencl 的呼叫器是位置傳入
    gws = [int(x) for x in global_work_size]
    lws = None if local_work_size is None else [int(x) for x in local_work_size]
    goff = None if global_offset is None else [int(x) for x in global_offset]
    if lws is not None and len(lws) != len(gws):
        _raise("clEnqueueNDRangeKernel", "INVALID_WORK_DIMENSION", "global 與 local 的維度不同")
    if g_times_l and lws is not None:
        gws = [g * l for g, l in zip(gws, lws)]
    if any(g == 0 for g in gws):
        if allow_empty_ndrange:
            return Event({"h": -1, "cmd": "kernel", "queued": 0, "start": 0, "end": 0}, queue)
        _raise("clEnqueueNDRangeKernel", "INVALID_GLOBAL_WORK_SIZE", "global size 不能是 0")
    svms = list(dict.fromkeys(getattr(kernel, "_svm", {}).values()))   # 帶 SVM 參數：啟動前推、啟動後拉（見 SVM 區塊說明）
    for a in svms:
        a._push(queue)
    res, _ = _call("nd_range", {"queue": queue._h, "kernel": kernel._h, "global": gws, "local": lws, "offset": goff})
    for a in svms:
        a._pull(queue)
    return Event(res["event"], queue)


def _wr(queue, res):
    return Event(res["event"], queue)


def _enqueue_read_buffer(queue, mem, hostbuf, src_offset=0, wait_for=None, is_blocking=True):
    mv = _byte_view(hostbuf)
    res, payload = _call("buf_read", {"queue": queue._h, "mem": mem._h, "offset": int(src_offset), "size": len(mv)})
    mv[:] = payload
    return _wr(queue, res)


def _enqueue_write_buffer(queue, mem, hostbuf, dst_offset=0, wait_for=None, is_blocking=True):
    res, _ = _call("buf_write", {"queue": queue._h, "mem": mem._h, "offset": int(dst_offset)}, _as_bytes(hostbuf))
    return _wr(queue, res)


def _enqueue_copy_buffer(queue, src, dst, byte_count=-1, src_offset=0, dst_offset=0, wait_for=None):
    size = None if byte_count in (-1, None) else int(byte_count)
    if size is None:
        size = min(src._size - int(src_offset), dst._size - int(dst_offset))
    res, _ = _call("buf_copy", {"queue": queue._h, "src": src._h, "dst": dst._h, "size": size, "src_offset": int(src_offset), "dst_offset": int(dst_offset)})
    return _wr(queue, res)


def _enqueue_fill_buffer(queue, mem, pattern, offset, size, wait_for=None):
    res, _ = _call("buf_fill", {"queue": queue._h, "mem": mem._h, "offset": int(offset), "size": int(size)}, _as_bytes(pattern))
    return _wr(queue, res)


# ---------------------------------------------------------------------------------------------
# 配置器與記憶體池（pyopencl.array 與 tools 靠它們配置緩衝區）
# ---------------------------------------------------------------------------------------------

class NameVersion(object):
    def __init__(self, version=0, name=""):
        self.version, self.name = version, name


class AllocatorBase(object):
    def __call__(self, size):
        raise NotImplementedError


class DeferredAllocator(AllocatorBase):
    """每次呼叫配置一個 Buffer（真 pyopencl 的 DeferredAllocator：不保證配置當下就有實體記憶體）。"""

    def __init__(self, context, mem_flags=mem_flags.READ_WRITE):
        self._context, self._flags = context, mem_flags

    def __call__(self, size):
        return Buffer(self._context, self._flags, size)


class ImmediateAllocator(AllocatorBase):
    """同 DeferredAllocator，但接受佇列（真的會在配置時確保記憶體可用；這個後端的緩衝區本來就是配置時建立，所以行為相同）。"""

    def __init__(self, queue, mem_flags=mem_flags.READ_WRITE):
        self._queue, self._context, self._flags = queue, queue._ctx, mem_flags

    def __call__(self, size):
        return Buffer(self._context, self._flags, size)


class PooledBuffer(MemoryObjectHolder):
    """MemoryPool 配置出來的區塊。release() 把區塊還給池子（留著重用），不是真的釋放。"""

    def __init__(self, pool, buf, bin_nr):
        self._pool, self._buf, self._bin = pool, buf, bin_nr
        self._h, self._ctx, self._size, self._flags = buf._h, buf._ctx, buf._size, buf._flags

    def release(self):
        pool, self._pool = self._pool, None
        if pool is None:
            _raise("PooledBuffer.release", "INVALID_VALUE", "區塊已經還給池子了")
        pool._return(self._buf, self._bin)

    def bind_to_queue(self, queue):
        return None

    def unbind_from_queue(self):
        return None

    def __del__(self):
        if getattr(self, "_pool", None) is not None:
            try:
                self.release()
            except Exception:
                pass


class MemoryPool(AllocatorBase):
    """依大小分箱的緩衝區池（與真 pyopencl 的 MemoryPool 同一個分箱規則：指數加 leading_bits_in_bin_id 位元的尾數；
    箱號與 alloc_size 的算法照 pyopencl／pycuda 的 memory_pool.hpp 憑記憶寫，**沒有對照原始碼逐值驗證**，測試只驗不變式）。
    執行期優化：被還回來的區塊留在池裡，下次同一箱的配置直接重用（裝置端緩衝區與其內容狀態一併重用，省掉重新配置）。"""

    def __init__(self, allocator, leading_bits_in_bin_id=4):
        self._alloc, self._mb = allocator, int(leading_bits_in_bin_id)
        self._free, self._active, self._held_bytes, self._active_bytes, self._holding = {}, 0, 0, 0, True

    @staticmethod
    def _shl(x, s):
        return x << s if s >= 0 else x >> -s

    def bin_number(self, size):
        size = int(size)
        if size <= 0:
            return 0
        mb = self._mb
        l = bitlog2(size)
        shifted = self._shl(size, mb - l)
        return (l << mb) | (shifted & ((1 << mb) - 1))

    def alloc_size(self, bin_nr):
        mb = self._mb
        exponent, mantissa = bin_nr >> mb, bin_nr & ((1 << mb) - 1)
        ones = self._shl(1, exponent - mb)
        if ones:
            ones -= 1
        head = self._shl((1 << mb) | mantissa, exponent - mb)
        return head | ones

    def allocate(self, size):
        size = int(size)
        b = self.bin_number(size)
        lst = self._free.get(b)
        if lst:
            buf = lst.pop()
            self._held_bytes -= buf._size
        else:
            buf = self._alloc(self.alloc_size(b))
        self._active += 1
        self._active_bytes += buf._size
        return PooledBuffer(self, buf, b)

    __call__ = allocate

    def _return(self, buf, b):
        self._active -= 1
        self._active_bytes -= buf._size
        if self._holding:
            self._free.setdefault(b, []).append(buf)
            self._held_bytes += buf._size
        else:
            buf.release()

    @property
    def held_blocks(self):
        return sum(len(v) for v in self._free.values())

    @property
    def active_blocks(self):
        return self._active

    @property
    def managed_bytes(self):
        return self._held_bytes + self._active_bytes

    @property
    def active_bytes(self):
        return self._active_bytes

    def free_held(self):
        for lst in self._free.values():
            for buf in lst:
                buf.release()
        self._free, self._held_bytes = {}, 0

    def stop_holding(self):
        self._holding = False
        self.free_held()

    def __del__(self):
        try:
            self.free_held()
        except Exception:
            pass


class UserEvent(Event):
    def __init__(self, context):
        self._h, self._rec, self._queue, self._status = -1, {"h": -1, "cmd": "user", "queued": 0, "start": 0, "end": 0}, None, command_execution_status.QUEUED

    def set_status(self, status):
        self._status = status

    def get_info(self, param):
        if int(param) == event_info.COMMAND_EXECUTION_STATUS:
            return self._status
        return Event.get_info(self, param)


# ---------------------------------------------------------------------------------------------
# 圖像與取樣器（OpenCL C 前端的 read_image*／write_image*）。圖像在載入器裡是一塊緊密排列的緩衝區加格式描述；核心只走主機路線（clc）。
# 支援：IMAGE1D／1D_ARRAY／2D／2D_ARRAY／3D；所有「非打包」的通道型別（UNORM／SNORM 8／16、SIGNED／UNSIGNED 8／16／32、HALF_FLOAT、FLOAT）
# 與通道順序（R A RG RA RGBA BGRA ARGB INTENSITY LUMINANCE Rx RGx），以及打包型別 565／555／101010（配 RGB／RGBx）；IMAGE1D_BUFFER 與緩衝區共用記憶體。
# 不支援（如實回報，不假裝）：mip 層級與多重取樣。
# ---------------------------------------------------------------------------------------------
_CH_ORDER_NAMES = ["R", "A", "RG", "RA", "RGB", "RGBA", "BGRA", "ARGB", "INTENSITY", "LUMINANCE", "Rx", "RGx", "RGBx"]
_CH_TYPE_NAMES = ["SNORM_INT8", "SNORM_INT16", "UNORM_INT8", "UNORM_INT16", "UNORM_SHORT_565", "UNORM_SHORT_555", "UNORM_INT_101010",
                  "SIGNED_INT8", "SIGNED_INT16", "SIGNED_INT32", "UNSIGNED_INT8", "UNSIGNED_INT16", "UNSIGNED_INT32", "HALF_FLOAT", "FLOAT"]
_CH_COUNT = {"R": 1, "A": 1, "RG": 2, "RA": 2, "RGB": 3, "RGBA": 4, "BGRA": 4, "ARGB": 4, "INTENSITY": 1, "LUMINANCE": 1, "Rx": 2, "RGx": 3, "RGBx": 4}
_CH_BYTES = {"SNORM_INT8": 1, "UNORM_INT8": 1, "SIGNED_INT8": 1, "UNSIGNED_INT8": 1, "SNORM_INT16": 2, "UNORM_INT16": 2, "SIGNED_INT16": 2,
             "UNSIGNED_INT16": 2, "HALF_FLOAT": 2, "SIGNED_INT32": 4, "UNSIGNED_INT32": 4, "FLOAT": 4,
             "UNORM_SHORT_565": 2, "UNORM_SHORT_555": 2, "UNORM_INT_101010": 4}
_CH_PACKED = ("UNORM_SHORT_565", "UNORM_SHORT_555", "UNORM_INT_101010")


def _elem_size(order, ctype):
    if ctype in _CH_PACKED:
        return _CH_BYTES[ctype]
    return _CH_COUNT.get(order, 0) * _CH_BYTES.get(ctype, 0)
_IMG_TYPE_NAME = {0x10f1: "image2d", 0x10f2: "image3d", 0x10f3: "image2d_array", 0x10f4: "image1d", 0x10f5: "image1d_array", 0x10f6: "image1d_buffer"}


def _order_name(v):
    i = int(v) - 0x10b0
    return _CH_ORDER_NAMES[i] if 0 <= i < len(_CH_ORDER_NAMES) else None


def _type_name(v):
    i = int(v) - 0x10d0
    return _CH_TYPE_NAMES[i] if 0 <= i < len(_CH_TYPE_NAMES) else None


class ImageFormat(object):
    def __init__(self, channel_order=0, channel_data_type=0):
        self.channel_order, self.channel_data_type = int(channel_order), int(channel_data_type)

    @property
    def channel_count(self):
        return _CH_COUNT.get(_order_name(self.channel_order), 0)

    @property
    def dtype_size(self):
        return _CH_BYTES.get(_type_name(self.channel_data_type), 0)

    @property
    def itemsize(self):
        return _elem_size(_order_name(self.channel_order), _type_name(self.channel_data_type))


class ImageDescriptor(object):
    def __init__(self):
        self.image_type, self._shape, self._pitches = mem_object_type.IMAGE2D, (0, 0, 0), (0, 0)
        self.num_mip_levels, self.num_samples, self.buffer = 0, 0, None

    @property
    def shape(self):
        return tuple(self._shape) + (0,) * (3 - len(self._shape))

    @shape.setter
    def shape(self, value):
        value = tuple(int(x) for x in value)
        if not 1 <= len(value) <= 3:
            _raise("ImageDescriptor", "INVALID_VALUE", "shape 要有 1–3 個元素")
        self._shape = value

    @property
    def array_size(self):
        t = int(self.image_type)
        return self._shape[-1] if t in (mem_object_type.IMAGE1D_ARRAY, mem_object_type.IMAGE2D_ARRAY) and len(self._shape) else 0

    @array_size.setter
    def array_size(self, value):
        pass

    @property
    def pitches(self):
        return self._pitches

    @pitches.setter
    def pitches(self, value):
        self._pitches = (tuple(int(x) for x in value) + (0, 0))[:2]


def _image_geometry(desc):
    """描述 → (載入器的型別名, w, h, d)。陣列型別的層數放在最後一維（1D 陣列在 h、2D 陣列在 d）。"""
    t = int(desc.image_type)
    name = _IMG_TYPE_NAME.get(t)
    sh = tuple(desc._shape)
    if name is None:
        _raise("clCreateImage", "INVALID_IMAGE_DESCRIPTOR", "不認得的圖像型別 0x%x" % t)
    if name == "image1d_buffer" and desc.buffer is None:
        _raise("clCreateImage", "INVALID_IMAGE_DESCRIPTOR", "IMAGE1D_BUFFER 要給 buffer")
    need = {"image1d": 1, "image1d_buffer": 1, "image2d": 2, "image3d": 3, "image1d_array": 2, "image2d_array": 3}[name]
    if len(sh) != need or any(x <= 0 for x in sh):
        _raise("clCreateImage", "INVALID_IMAGE_SIZE", "%s 需要 %d 個正整數的尺寸，得到 %s" % (name, need, sh))
    return name, sh[0], (sh[1] if need >= 2 else 1), (sh[2] if need == 3 else 1)


def _region3(v, default):
    v = tuple(int(x) for x in v)
    return v + (default,) * (3 - len(v))


def _pack_region(hostmv, region, elem, row_pitch, slice_pitch):
    """主機陣列（可能有 row／slice pitch）→ 緊密排列的 region 位元組（x 最快）"""
    w, h, d = region
    rowb = w * elem
    rp = int(row_pitch) or rowb
    sp = int(slice_pitch) or rp * h
    if rp == rowb and sp == rowb * h:
        n = rowb * h * d
        if len(hostmv) < n:
            _raise("clEnqueueWriteImage", "INVALID_VALUE", "主機緩衝（%d 位元組）比 region（%d）小" % (len(hostmv), n))
        return bytes(hostmv[:n])
    out = bytearray()
    for z in range(d):
        for y in range(h):
            o = z * sp + y * rp
            if o + rowb > len(hostmv):
                _raise("clEnqueueWriteImage", "INVALID_VALUE", "主機緩衝太小（pitch 之下 region 需要更多位元組）")
            out += hostmv[o:o + rowb]
    return bytes(out)


def _unpack_region(hostmv, data, region, elem, row_pitch, slice_pitch):
    w, h, d = region
    rowb = w * elem
    rp = int(row_pitch) or rowb
    sp = int(slice_pitch) or rp * h
    if rp == rowb and sp == rowb * h:
        if len(hostmv) < len(data):
            _raise("clEnqueueReadImage", "INVALID_VALUE", "主機緩衝（%d 位元組）比 region（%d）小" % (len(hostmv), len(data)))
        hostmv[:len(data)] = data
        return
    for z in range(d):
        for y in range(h):
            o, i = z * sp + y * rp, (z * h + y) * rowb
            if o + rowb > len(hostmv):
                _raise("clEnqueueReadImage", "INVALID_VALUE", "主機緩衝太小（pitch 之下 region 需要更多位元組）")
            hostmv[o:o + rowb] = data[i:i + rowb]


class Image(MemoryObject):
    _info_enums = (mem_info, image_info)
    _parent = None
    _offset = 0

    def __init__(self, context, flags, format, shape=None, pitches=None, hostbuf=None, is_array=False, buffer=None, *, desc=None, _through_create_image=False):
        if desc is None:
            if shape is None:
                if hostbuf is None:
                    _raise("clCreateImage", "INVALID_VALUE", "'shape' 沒給時要給 hostbuf")
                shape = tuple(hostbuf.shape)
            shape = tuple(int(x) for x in shape)
            desc = ImageDescriptor()
            desc.buffer = buffer
            desc.image_type = {1: mem_object_type.IMAGE1D_BUFFER if buffer is not None else mem_object_type.IMAGE1D, 2: mem_object_type.IMAGE1D_ARRAY if is_array else mem_object_type.IMAGE2D,
                               3: mem_object_type.IMAGE2D_ARRAY if is_array else mem_object_type.IMAGE3D}.get(len(shape))
            if desc.image_type is None:
                _raise("clCreateImage", "INVALID_IMAGE_DESCRIPTOR", "圖像不能有 %d 維" % len(shape))
            desc.shape = shape
            desc.pitches = pitches or (0, 0)
        self._init_from(context, flags, format, desc, hostbuf)

    @staticmethod
    def _custom_init(h, context, flags, format, a, b=None, c=None):
        if isinstance(a, ImageDescriptor):
            h._init_from(context, flags, format, a, b)
        else:   # 舊式：(shape, pitches, hostbuf)
            d = ImageDescriptor()
            a = tuple(a)
            d.image_type = {2: mem_object_type.IMAGE2D, 3: mem_object_type.IMAGE3D}.get(len(a))
            if d.image_type is None:
                _raise("clCreateImage2D", "INVALID_IMAGE_DESCRIPTOR", "舊式建構只支援 2D／3D")
            d.shape, d.pitches = a, (b or (0, 0))
            h._init_from(context, flags, format, d, c)

    def _init_from(self, context, flags, format, desc, hostbuf):
        flags = int(flags)
        name, w, h, d = _image_geometry(desc)
        if (desc.buffer is not None) != (name == "image1d_buffer"):
            _raise("clCreateImage", "INVALID_IMAGE_DESCRIPTOR", "只有 IMAGE1D_BUFFER 帶 buffer")
        order, ctype = _order_name(format.channel_order), _type_name(format.channel_data_type)
        data = None
        if hostbuf is not None or flags & (mem_flags.COPY_HOST_PTR | mem_flags.USE_HOST_PTR):
            if hostbuf is None:
                _raise("clCreateImage", "INVALID_HOST_PTR", "COPY_HOST_PTR／USE_HOST_PTR 需要 hostbuf")
            elem = _elem_size(order, ctype)
            data = _pack_region(_byte_view(hostbuf), (w, h, d), elem, *(tuple(desc.pitches) + (0, 0))[:2]) if elem else None
        res, _ = _call("img_create", {"ctx": context._h, "flags": flags, "type": name, "w": w, "h": h, "d": d, "order": order, "chType": ctype, "buffer": desc.buffer._h if desc.buffer is not None else None}, data)
        self._h, self._ctx, self._flags, self._size = res["h"], context, flags, int(res["size"])
        self._format, self._elem, self._name, self._dims = ImageFormat(format.channel_order, format.channel_data_type), int(res["elem"]), name, (w, h, d)
        self._mtype, self._buffer = {v: k for k, v in _IMG_TYPE_NAME.items()}[name], desc.buffer

    def get_info(self, param):
        if int(param) == mem_info.TYPE:
            return self._mtype
        if 0x1110 <= int(param) <= 0x111a:   # image_info 的範圍：`.width` 之類的屬性後備走 get_info
            return self.get_image_info(param)
        return MemoryObjectHolder.get_info(self, param)

    def get_image_info(self, param):
        p, (w, h, d) = int(param), self._dims
        arr = self._name.endswith("_array")
        if p == image_info.FORMAT:
            return self._format
        if p == image_info.ELEMENT_SIZE:
            return self._elem
        if p == image_info.ROW_PITCH:
            return w * self._elem
        if p == image_info.SLICE_PITCH:
            return w * h * self._elem if self._name in ("image3d", "image2d_array", "image1d_array") else 0
        if p == image_info.WIDTH:
            return w
        if p == image_info.HEIGHT:
            return h if self._name in ("image2d", "image3d", "image2d_array") else 0
        if p == image_info.DEPTH:
            return d if self._name == "image3d" else 0
        if p == image_info.ARRAY_SIZE:
            return (h if self._name == "image1d_array" else d) if arr else 0
        if p == image_info.BUFFER:
            return self._buffer
        if p in (image_info.NUM_MIP_LEVELS, image_info.NUM_SAMPLES):
            return 0
        _info_error("clGetImageInfo", param)

    def __repr__(self):
        return "<pyopencl.Image %s %dx%dx%d %s>" % (self._name, self._dims[0], self._dims[1], self._dims[2], self._format)


class Sampler(_Handle):
    """取樣器是一個位元欄位（正規化座標｜定址模式｜過濾模式），核心端的 sampler_t 就是 uint——不需要宿主端的物件。"""
    _ADDR = {int(addressing_mode.NONE): 0, int(addressing_mode.CLAMP_TO_EDGE): 2, int(addressing_mode.CLAMP): 4, int(addressing_mode.REPEAT): 6, int(addressing_mode.MIRRORED_REPEAT): 8}
    _FILT = {int(filter_mode.NEAREST): 16, int(filter_mode.LINEAR): 32}
    _info_enums = (sampler_info,)

    def __init__(self, context, *args):
        if len(args) == 1:
            props = list(args[0])
            if props and props[-1] == 0:
                props = props[:-1]
            if len(props) % 2:
                _raise("clCreateSamplerWithProperties", "INVALID_VALUE", "properties 要是（鍵, 值）成對")
            kv = {int(props[i]): props[i + 1] for i in range(0, len(props), 2)}
            norm = kv.get(int(sampler_properties.NORMALIZED_COORDS), True)
            addr = kv.get(int(sampler_properties.ADDRESSING_MODE), addressing_mode.CLAMP)
            filt = kv.get(int(sampler_properties.FILTER_MODE), filter_mode.NEAREST)
        elif len(args) == 3:
            norm, addr, filt = args
        else:
            _raise("clCreateSampler", "INVALID_VALUE", "Sampler(context, normalized_coords, addressing_mode, filter_mode) 或 Sampler(context, properties)")
        if int(addr) not in self._ADDR or int(filt) not in self._FILT:
            _raise("clCreateSampler", "INVALID_VALUE", "不認得的定址或過濾模式")
        self._ctx, self._norm, self._addr, self._filt = context, bool(norm), int(addr), int(filt)
        self._bits = (1 if self._norm else 0) | self._ADDR[self._addr] | self._FILT[self._filt]
        self._h = -3

    def release(self):
        pass

    def get_info(self, param):
        p = int(param)
        if p == sampler_info.REFERENCE_COUNT:
            return 1
        if p == sampler_info.CONTEXT:
            return self._ctx
        if p == sampler_info.NORMALIZED_COORDS:
            return self._norm
        if p == sampler_info.ADDRESSING_MODE:
            return self._addr
        if p == sampler_info.FILTER_MODE:
            return self._filt
        _info_error("clGetSamplerInfo", param)

    def __eq__(self, other):
        return isinstance(other, Sampler) and (other._bits, other._ctx) == (self._bits, self._ctx)

    def __hash__(self):
        return hash(("Sampler", self._bits))


class Pipe(MemoryObject):
    """OpenCL 2.0 的 Pipe：只有核心能讀寫（規格也是）；核心用 read_pipe／write_pipe（含 reserve 版本）。"""
    _info_enums = (mem_info, pipe_info)

    def __init__(self, context, flags, packet_size, max_packets, properties=()):
        _svm_check_pipe(context)
        res, _ = _call("pipe_create", {"ctx": context._h, "flags": int(flags), "packet_size": int(packet_size), "max_packets": int(max_packets)})
        self._h, self._ctx, self._flags, self._size = res["h"], context, int(flags), int(res["size"])
        self._packet_size, self._max_packets, self._mtype = int(packet_size), int(max_packets), mem_object_type.PIPE

    def get_pipe_info(self, param):
        p = int(param)
        if p == pipe_info.PACKET_SIZE:
            return self._packet_size
        if p == pipe_info.MAX_PACKETS:
            return self._max_packets
        if p == pipe_info.PROPERTIES:
            return []
        _info_error("clGetPipeInfo", param)

    def get_info(self, param):
        if 0x1120 <= int(param) <= 0x1122:
            return self.get_pipe_info(param)
        return MemoryObjectHolder.get_info(self, param)


def _svm_check_pipe(context):
    if not any(d.get_info(device_info.MAX_PIPE_ARGS) > 0 for d in context.devices):
        _raise("clCreatePipe", "INVALID_OPERATION", "這個裝置不支援 Pipe（max_pipe_args＝0；用 clc 或 GPU 驅動的裝置）")


def _need_image(m, routine):
    if not isinstance(m, Image):
        _raise(routine, "INVALID_MEM_OBJECT", "要傳圖像（Image），得到 %s" % type(m).__name__)
    return m


def _enqueue_read_image(queue, mem, origin, region, hostbuf, row_pitch=0, slice_pitch=0, wait_for=None, is_blocking=True):
    _need_image(mem, "clEnqueueReadImage")
    rg = _region3(region, 1)
    res, data = _call("img_read", {"queue": queue._h, "mem": mem._h, "origin": list(_region3(origin, 0)), "region": list(rg)})
    _unpack_region(_byte_view(hostbuf), data, rg, mem._elem, row_pitch, slice_pitch)
    return _wr(queue, res)


def _enqueue_write_image(queue, mem, origin, region, hostbuf, row_pitch=0, slice_pitch=0, wait_for=None, is_blocking=True):
    _need_image(mem, "clEnqueueWriteImage")
    rg = _region3(region, 1)
    res, _ = _call("img_write", {"queue": queue._h, "mem": mem._h, "origin": list(_region3(origin, 0)), "region": list(rg)},
                   _pack_region(_byte_view(hostbuf), rg, mem._elem, row_pitch, slice_pitch))
    return _wr(queue, res)


def _enqueue_copy_image(queue, src, dest, src_origin, dest_origin, region, wait_for=None):
    _need_image(src, "clEnqueueCopyImage")
    _need_image(dest, "clEnqueueCopyImage")
    res, _ = _call("img_copy", {"queue": queue._h, "src": src._h, "dst": dest._h, "src_origin": list(_region3(src_origin, 0)),
                                "dst_origin": list(_region3(dest_origin, 0)), "region": list(_region3(region, 1))})
    return _wr(queue, res)


def _enqueue_copy_image_to_buffer(queue, src, dest, origin, region, offset, wait_for=None):
    _need_image(src, "clEnqueueCopyImageToBuffer")
    res, _ = _call("img_to_buf", {"queue": queue._h, "img": src._h, "buf": dest._h, "origin": list(_region3(origin, 0)), "region": list(_region3(region, 1)), "offset": int(offset)})
    return _wr(queue, res)


def _enqueue_copy_buffer_to_image(queue, src, dest, offset, origin, region, wait_for=None):
    _need_image(dest, "clEnqueueCopyBufferToImage")
    res, _ = _call("buf_to_img", {"queue": queue._h, "buf": src._h, "img": dest._h, "origin": list(_region3(origin, 0)), "region": list(_region3(region, 1)), "offset": int(offset)})
    return _wr(queue, res)


def enqueue_fill_image(queue, mem, color, origin, region, wait_for=None):
    _need_image(mem, "clEnqueueFillImage")
    c = np.asarray(color).reshape(-1)
    if c.size != 4:
        _raise("clEnqueueFillImage", "INVALID_VALUE", "color 要有 4 個分量（RGBA），得到 %d 個" % c.size)
    kind = "f" if c.dtype.kind == "f" else ("i" if c.dtype.kind == "i" else "ui")
    res, _ = _call("img_fill", {"queue": queue._h, "mem": mem._h, "origin": list(_region3(origin, 0)), "region": list(_region3(region, 1)), "color": [x.item() for x in c], "kind": kind})
    return _wr(queue, res)


class _ImageMap(bytearray):
    """enqueue_map_image 的 base：release 時若 map 帶寫入旗標，把內容寫回圖像"""

    def _init(self, queue, mem, origin, region, flags):
        self._queue, self._mem, self._origin, self._region, self._flags, self._released = queue, mem, origin, region, int(flags), False
        return self

    def release(self, queue=None, wait_for=None):
        if self._released:
            _raise("clEnqueueUnmapMemObject", "INVALID_VALUE", "這個 map 已經 release 過了")
        self._released = True
        q = queue or self._queue
        if self._flags & (map_flags.WRITE | map_flags.WRITE_INVALIDATE_REGION):
            res, _ = _call("img_write", {"queue": q._h, "mem": self._mem._h, "origin": list(self._origin), "region": list(self._region)}, bytes(self))
            return Event(res["event"], q)
        return _done_event(q, "unmap")


def enqueue_map_image(queue, img, flags, origin, region, shape, dtype, order="C", strides=None, wait_for=None, is_blocking=True):
    _need_image(img, "clEnqueueMapImage")
    dt, org, rg, flags = np.dtype(dtype), _region3(origin, 0), _region3(region, 1), int(flags)
    nbytes = rg[0] * rg[1] * rg[2] * img._elem
    shape = tuple(int(x) for x in (shape if hasattr(shape, "__iter__") else (shape,)))
    if int(np.prod(shape, dtype=np.int64)) * dt.itemsize > nbytes:
        _raise("clEnqueueMapImage", "INVALID_VALUE", "shape × dtype 比 region 大")
    mm = _ImageMap(nbytes)._init(queue, img, org, rg, flags)
    if not (flags & map_flags.WRITE_INVALIDATE_REGION):
        res, data = _call("img_read", {"queue": queue._h, "mem": img._h, "origin": list(org), "region": list(rg)})
        mm[:] = data
        ev = Event(res["event"], queue)
    else:
        ev = _done_event(queue, "map")
    row_pitch = rg[0] * img._elem
    arr = np.ndarray(shape, dtype=dt, buffer=mm, order=order, strides=strides)
    return arr, ev, row_pitch, row_pitch * rg[1]


def get_supported_image_formats(context, flags, image_type):
    if not any(d.get_info(device_info.IMAGE_SUPPORT) for d in context.devices):
        return []   # 沒有圖像支援的裝置（KIR 驅動）：真的 OpenCL 也是回空清單
    res, _ = _call("img_formats", {"type": int(image_type)})
    return [ImageFormat(0x10b0 + _CH_ORDER_NAMES.index(o), 0x10d0 + _CH_TYPE_NAMES.index(t)) for o, t in res["formats"]]


# ---------------------------------------------------------------------------------------------
# OpenGL 互通（cl_khr_gl_sharing 的 GLBuffer、GLTexture［GL_TEXTURE_2D］、GLRenderBuffer）
# GL 的緩衝區在 WebGL2（GPU）裡，OpenCL 的緩衝區在載入器的驅動裡，兩邊是兩塊記憶體；acquire／release 就是兩者之間的同步點（與標準的語意相同：
# 核心只能在 acquire 與 release 之間使用 GL 緩衝區）。優化：GL 端用修訂號、CL 端用內容版本號，沒變的方向不傳輸——連續多幀「acquire、核心、release」
# 只有第一次 acquire 會把 GL 內容讀進來，之後只有 CL 真的寫過才寫回 GL。
# 需要 fa_opengl_platform（PyOpenGL 的平台後端）；沒有就明確報錯。pyopencl.tools.get_gl_sharing_context_properties() 在 Pyodide 上（sys.platform 是
# emscripten）會丟 NotImplementedError、在 Linux 要 GLX：這個後端的 Context 不需要 GL 屬性，直接 Context(devices=[dev]) 即可（DESIGN.pyopencl.md §9）。
# ---------------------------------------------------------------------------------------------

def _gl_platform():
    try:
        import fa_opengl_platform as P
    except ImportError:
        _raise("clCreateFromGLBuffer", "INVALID_OPERATION", "GL 互通需要 fa_opengl_platform（PyOpenGL 的平台後端）；沒有 GL 上下文")
    return P


class GLBuffer(MemoryObject):
    def __init__(self, context, flags, bufobj):
        P = _gl_platform()
        info = P.interop_buffer_info(int(bufobj))
        if info is None:
            _raise("clCreateFromGLBuffer", "INVALID_GL_OBJECT", "GL 緩衝區 %s 不存在（要是 glGenBuffers 回傳的名字）" % bufobj)
        if info[0] <= 0:
            _raise("clCreateFromGLBuffer", "INVALID_GL_OBJECT", "GL 緩衝區 %s 還沒有資料（先 glBufferData）" % bufobj)
        res, _ = _call("buf_create", {"ctx": context._h, "flags": int(flags), "size": int(info[0])})
        self._h, self._ctx, self._size, self._flags = res["h"], context, int(info[0]), int(flags)
        self._gl_name, self._gl_rev, self._cl_ver, self._acquired = int(bufobj), None, None, False

    def get_gl_object_info(self):
        return (gl_object_type.BUFFER, self._gl_name)

    def __repr__(self):
        return "<pyopencl.GLBuffer of GL buffer %d, size %d>" % (self._gl_name, self._size)


_GL_FMT_NUM = lambda f: (0x10b0 + _CH_ORDER_NAMES.index(f[0]), 0x10d0 + _CH_TYPE_NAMES.index(f[1]))   # noqa: E731


class _GLImage(Image):
    """GL 紋理／renderbuffer 對應的 CL 圖像：一般的 Image，外加 acquire／release 時與 GL 端同步（見上方的修訂號機制）"""

    def _gl_setup(self, context, flags, info, kind, name, level):
        P = _gl_platform()
        fmt = P.GL_INTEROP_FORMATS.get(info[2])
        if fmt is None:
            _raise("clCreateFromGL" + kind, "INVALID_IMAGE_FORMAT_DESCRIPTOR", "GL 內部格式 0x%x 沒有對應的 CL 圖像格式（支援 RGBA8／RGBA16F／RGBA32F／R8／R32F／RG8／RG32F）" % info[2])
        desc = ImageDescriptor()
        desc.image_type, desc.shape = mem_object_type.IMAGE2D, (info[0], info[1])
        self._init_from(context, flags, ImageFormat(*_GL_FMT_NUM(fmt)), desc, None)
        self._gl_name, self._gl_level, self._gl_internal, self._gl_rev, self._cl_ver, self._acquired = int(name), int(level), info[2], None, None, False

    def _gl_info(self, P):
        raise NotImplementedError


class GLTexture(_GLImage):
    def __init__(self, context, flags, texture_target, miplevel, texture, dims=2):
        P = _gl_platform()
        if int(texture_target) != 0x0DE1 or int(dims) != 2:
            _raise("clCreateFromGLTexture", "INVALID_VALUE", "只支援 GL_TEXTURE_2D（texture_target＝0x0DE1、dims＝2）；得到 target 0x%x、dims %s" % (int(texture_target), dims))
        info = P.interop_texture_info(int(texture), int(miplevel))
        if info is None:
            _raise("clCreateFromGLTexture", "INVALID_GL_OBJECT", "GL 紋理 %s 的第 %s 層不存在或還沒有資料（先 glTexImage2D）" % (texture, miplevel))
        self._gl_setup(context, flags, info, "Texture", texture, miplevel)

    def _gl_info(self, P):
        return P.interop_texture_info(self._gl_name, self._gl_level)

    def _gl_read(self, P):
        return P.interop_texture_read(self._gl_name, self._gl_level)

    def _gl_write(self, P, data):
        return P.interop_texture_write(self._gl_name, data, self._gl_level)

    def get_gl_object_info(self):
        return (gl_object_type.TEXTURE2D, self._gl_name)

    def get_gl_texture_info(self, param):
        p = int(param)
        if p == gl_texture_info.TEXTURE_TARGET:
            return 0x0DE1
        if p == gl_texture_info.MIPMAP_LEVEL:
            return self._gl_level
        _info_error("clGetGLTextureInfo", param)

    def __repr__(self):
        return "<pyopencl.GLTexture of GL texture %d level %d, %dx%d>" % (self._gl_name, self._gl_level, self._dims[0], self._dims[1])


class GLRenderBuffer(_GLImage):
    def __init__(self, context, flags, renderbuffer):
        P = _gl_platform()
        info = P.interop_renderbuffer_info(int(renderbuffer))
        if info is None:
            _raise("clCreateFromGLRenderbuffer", "INVALID_GL_OBJECT", "GL renderbuffer %s 不存在或還沒有 glRenderbufferStorage" % renderbuffer)
        self._gl_setup(context, flags, info, "Renderbuffer", renderbuffer, 0)

    def _gl_info(self, P):
        return P.interop_renderbuffer_info(self._gl_name)

    def _gl_read(self, P):
        return P.interop_renderbuffer_read(self._gl_name)

    def _gl_write(self, P, data):
        return P.interop_renderbuffer_write(self._gl_name, data)

    def get_gl_object_info(self):
        return (gl_object_type.RENDERBUFFER, self._gl_name)

    def __repr__(self):
        return "<pyopencl.GLRenderBuffer of GL renderbuffer %d, %dx%d>" % (self._gl_name, self._dims[0], self._dims[1])


def _gl_event(queue, name):
    return Event({"h": -1, "cmd": name, "queued": 0, "start": 0, "end": 0}, queue)


_GL_OBJECTS = (GLBuffer, GLTexture, GLRenderBuffer)


def enqueue_acquire_gl_objects(queue, mem_objects, wait_for=None):
    P = _gl_platform()
    for m in mem_objects:
        if not isinstance(m, _GL_OBJECTS):
            _raise("clEnqueueAcquireGLObjects", "INVALID_GL_OBJECT", "只有 GLBuffer／GLTexture／GLRenderBuffer 能 acquire（得到 %s）" % type(m).__name__)
        if m._acquired:
            _raise("clEnqueueAcquireGLObjects", "INVALID_OPERATION", "這個 %s 已經 acquire 過了（要先 release）" % type(m).__name__)
        if isinstance(m, GLBuffer):
            info = P.interop_buffer_info(m._gl_name)
            if info is None:
                _raise("clEnqueueAcquireGLObjects", "INVALID_GL_OBJECT", "GL 緩衝區 %d 已被刪除" % m._gl_name)
            if info[0] != m._size:
                _raise("clEnqueueAcquireGLObjects", "INVALID_GL_OBJECT", "GL 緩衝區 %d 的大小從 %d 變成 %d（glBufferData 重新指定過），要重新建立 GLBuffer" % (m._gl_name, m._size, info[0]))
            if m._gl_rev != info[1]:   # GL 端有新內容（或第一次）：從 GPU 讀進來；沒變就跳過
                _call("buf_write", {"queue": queue._h, "mem": m._h, "offset": 0}, P.interop_read(m._gl_name))
                m._gl_rev = info[1]
        else:
            info = m._gl_info(P)
            if info is None:
                _raise("clEnqueueAcquireGLObjects", "INVALID_GL_OBJECT", "GL 物件 %d 已被刪除或沒有資料" % m._gl_name)
            if (info[0], info[1]) != tuple(m._dims[:2]) or info[2] != m._gl_internal:
                _raise("clEnqueueAcquireGLObjects", "INVALID_GL_OBJECT", "GL 物件 %d 的尺寸或格式改變了（重新指定過儲存），要重新建立 %s" % (m._gl_name, type(m).__name__))
            if m._gl_rev != info[3]:
                _call("img_write", {"queue": queue._h, "mem": m._h, "origin": [0, 0, 0], "region": [info[0], info[1], 1]}, m._gl_read(P))
                m._gl_rev = info[3]
        m._cl_ver = _call("buf_version", {"mem": m._h})[0]["ver"]
        m._acquired = True
    return _gl_event(queue, "acquire_gl")


def enqueue_release_gl_objects(queue, mem_objects, wait_for=None):
    P = _gl_platform()
    for m in mem_objects:
        if not isinstance(m, _GL_OBJECTS):
            _raise("clEnqueueReleaseGLObjects", "INVALID_GL_OBJECT", "只有 GLBuffer／GLTexture／GLRenderBuffer 能 release（得到 %s）" % type(m).__name__)
        if not m._acquired:
            _raise("clEnqueueReleaseGLObjects", "INVALID_OPERATION", "這個 %s 沒有 acquire 過" % type(m).__name__)
        if _call("buf_version", {"mem": m._h})[0]["ver"] != m._cl_ver:   # CL 端真的寫過：寫回 GL；沒寫過就不傳輸
            if isinstance(m, GLBuffer):
                _, data = _call("buf_read", {"queue": queue._h, "mem": m._h, "offset": 0, "size": m._size})
                m._gl_rev = P.interop_write(m._gl_name, data)
            else:
                _, data = _call("img_read", {"queue": queue._h, "mem": m._h, "origin": [0, 0, 0], "region": [m._dims[0], m._dims[1], 1]})
                m._gl_rev = m._gl_write(P, data)
        m._acquired = False
    return _gl_event(queue, "release_gl")


def _unsupported_class(name, why):
    def __init__(self, *a, **k):
        _raise(name, "INVALID_OPERATION", why)

    def _info(self, *a, **k):   # 真 pyopencl 的 _monkeypatch 要求這些類別有 get_info 類方法才能替它們裝屬性
        _raise(name, "INVALID_OPERATION", why)
    ns = {"__init__": __init__, "__module__": __name__, "get_info": _info}
    if name == "Image":
        ns["get_image_info"] = _info
    if name == "Pipe":
        ns["get_pipe_info"] = _info
    return type(name, (MemoryObject,) if name in ("Image", "Pipe") else (object,), ns)


for _n, _why in (("DevicePointerEXT", "不支援 cl_ext_buffer_device_address"),
                 ("DeviceTopologyAmd", "AMD 擴充，不支援"), ("_TestMemoryPool", "pyopencl 內部測試用")):
    globals()[_n] = _unsupported_class(_n, _why)


# ---------------------------------------------------------------------------------------------
# SVM（共享虛擬記憶體，粗粒度緩衝區等級）。實作方式：SVM 區塊的「主機端」是真的記憶體（ctypes 配置，svm_ptr 是它的位址，numpy 直接建在上面，
# 所以 pyopencl 的 svm_empty／csvm_empty／SVM(...) 與 __array_interface__ 都照常運作）；裝置端是載入器裡的一塊緩衝區。
# 同步：核心帶 SVM 參數的那次啟動前，若主機端內容變了（crc32）就推上去；啟動後若裝置端版本變了就拉回來。佇列循序且同步，所以主機端在每次
# 啟動完成後都是最新的——這滿足（也超過）粗粒度 SVM 的契約（map／unmap 之間才能存取）；裝置回報的能力只有 COARSE_GRAIN_BUFFER。
# 不支援：細粒度（FINE_GRAIN_*）與 SVM 原子（裝置不回報這些能力）。
# ---------------------------------------------------------------------------------------------
import ctypes as _ct
import zlib as _zlib

_SVM_REGISTRY = {}   # 起始位址 → SVMAllocation


def _svm_check_device(context, routine):
    if not any(d.get_info(device_info.SVM_CAPABILITIES) & device_svm_capabilities.COARSE_GRAIN_BUFFER for d in context.devices):
        _raise(routine, "INVALID_OPERATION", "這個裝置不支援 SVM（svm_capabilities＝0；用 clc 或 GPU 驅動的裝置）")


def _svm_resolve(ptr, routine):
    """位址 → (SVMAllocation, 位元組偏移)；不在任何 SVM 區塊內就是 INVALID_ARG_VALUE（沒有細粒度系統 SVM）"""
    for base, a in _SVM_REGISTRY.items():
        if base <= ptr < base + a._size:
            return a, ptr - base
    _raise(routine, "INVALID_ARG_VALUE", "位址 0x%x 不在任何 SVM 區塊裡（這個裝置只有粗粒度 SVM，沒有 FINE_GRAIN_SYSTEM）" % ptr)


class SVMPointer(object):
    @property
    def svm_ptr(self):
        raise NotImplementedError

    @property
    def size(self):
        return None

    @property
    def buf(self):
        n = self.size
        if n is None:
            _raise("SVMPointer.buf", "INVALID_VALUE", "這個 SVM 指標沒有大小")
        return np.frombuffer((_ct.c_uint8 * n).from_address(int(self.svm_ptr)), dtype=np.uint8)

    def map(self, queue, *, flags, is_blocking=True, wait_for=None, size=None):
        from pyopencl import SVMMap
        return SVMMap(self, np.asarray(self.buf), queue, _enqueue_svm_map(queue, is_blocking, flags, self, wait_for, size))

    def map_ro(self, queue, *, is_blocking=True, wait_for=None, size=None):
        return self.map(queue, flags=map_flags.READ, is_blocking=is_blocking, wait_for=wait_for, size=size)

    def map_rw(self, queue, *, is_blocking=True, wait_for=None, size=None):
        return self.map(queue, flags=map_flags.READ | map_flags.WRITE, is_blocking=is_blocking, wait_for=wait_for, size=size)

    def _enqueue_unmap(self, queue, wait_for=None):
        return _enqueue_svm_unmap(queue, self, wait_for)

    def as_buffer(self, ctx, flags=None, size=None):
        a, off = _svm_resolve(int(self.svm_ptr), "as_buffer")
        return a._as_buffer(off, size if size is not None else (self.size or a._size - off))


class SVM(SVMPointer):
    def __init__(self, arg):
        self._mem = arg
        a = np.asarray(arg)
        if not (a.flags.c_contiguous or a.flags.f_contiguous):
            _raise("SVM", "INVALID_VALUE", "SVM(...) 要連續的記憶體")
        self._ptr, self._nbytes = int(a.__array_interface__["data"][0]), int(a.nbytes)

    @property
    def mem(self):
        return self._mem

    @property
    def svm_ptr(self):
        return self._ptr

    @property
    def size(self):
        return self._nbytes

    def map(self, queue, *, flags, is_blocking=True, wait_for=None, size=None):
        from pyopencl import SVMMap
        return SVMMap(self, self._mem, queue, _enqueue_svm_map(queue, is_blocking, flags, self, wait_for, size))

    def map_ro(self, queue, *, is_blocking=True, wait_for=None, size=None):
        return self.map(queue, flags=map_flags.READ, is_blocking=is_blocking, wait_for=wait_for, size=size)

    def map_rw(self, queue, *, is_blocking=True, wait_for=None, size=None):
        return self.map(queue, flags=map_flags.READ | map_flags.WRITE, is_blocking=is_blocking, wait_for=wait_for, size=size)

    def __eq__(self, other):
        return isinstance(other, SVM) and other._ptr == self._ptr and other._nbytes == self._nbytes

    def __hash__(self):
        return hash(("SVM", self._ptr, self._nbytes))


class SVMAllocation(SVMPointer):
    def __init__(self, context, size, alignment, flags, queue=None):
        _svm_check_device(context, "clSVMAlloc")
        size, alignment = int(size), max(int(alignment or 0), 16)
        if size <= 0:
            _raise("clSVMAlloc", "INVALID_VALUE", "size 要大於 0")
        if alignment & (alignment - 1):
            _raise("clSVMAlloc", "INVALID_VALUE", "alignment 要是 2 的次方")
        if int(flags) & (svm_mem_flags.SVM_FINE_GRAIN_BUFFER | svm_mem_flags.SVM_ATOMICS):
            _raise("clSVMAlloc", "INVALID_VALUE", "裝置只有粗粒度 SVM，沒有 SVM_FINE_GRAIN_BUFFER／SVM_ATOMICS")
        self._raw = (_ct.c_char * (size + alignment))()   # 零初始化
        self._ptr = (_ct.addressof(self._raw) + alignment - 1) & ~(alignment - 1)
        self._size, self._ctx, self._flags, self._queue_bound = size, context, int(flags), queue
        res, _ = _call("buf_create", {"ctx": context._h, "flags": int(mem_flags.READ_WRITE), "size": size})
        self._buf_h, self._crc, self._ver, self._subs, self._live = res["h"], None, None, {}, True
        _SVM_REGISTRY[self._ptr] = self

    @property
    def svm_ptr(self):
        return self._ptr

    @property
    def size(self):
        return self._size

    @property
    def _queue(self):
        return self._queue_bound

    def bind_to_queue(self, queue):
        self._queue_bound = queue

    def unbind_from_queue(self):
        self._queue_bound = None

    def release(self):
        if not self._live:
            return
        self._live = False
        _SVM_REGISTRY.pop(self._ptr, None)
        for h in [self._buf_h] + list(self._subs.values()):
            try:
                _call("release", {"h": h})
            except Exception:  # noqa: BLE001
                pass

    def enqueue_release(self, queue=None, wait_for=None):
        self.release()
        return _done_event(queue or self._queue_bound, "svm_free")

    def __del__(self):
        try:
            self.release()
        except Exception:  # noqa: BLE001
            pass

    def __eq__(self, other):
        return isinstance(other, SVMAllocation) and other._ptr == self._ptr

    def __hash__(self):
        return hash(("SVMAllocation", self._ptr))

    # ---- 同步（見檔頭說明）
    def _cur_ver(self):
        return _call("buf_version", {"mem": self._buf_h})[0]["ver"]

    def _push(self, queue):
        data = _ct.string_at(self._ptr, self._size)
        crc = _zlib.crc32(data)
        if crc != self._crc:
            _call("buf_write", {"queue": queue._h, "mem": self._buf_h, "offset": 0}, data)
            self._crc, self._ver = crc, self._cur_ver()

    def _pull(self, queue):
        v = self._cur_ver()
        if v != self._ver:
            _, data = _call("buf_read", {"queue": queue._h, "mem": self._buf_h, "offset": 0, "size": self._size})
            _ct.memmove(self._ptr, data, self._size)
            self._crc, self._ver = _zlib.crc32(data), v

    def _as_buffer(self, off, size):
        if off == 0 and size == self._size:
            return self._buf_h
        key = (off, size)
        if key not in self._subs:
            self._subs[key] = _call("buf_sub", {"mem": self._buf_h, "origin": off, "size": size, "flags": 0})[0]["h"]
        return self._subs[key]


class SVMAllocator(object):
    def __init__(self, context, alignment=0, flags=1, queue=None):
        _svm_check_device(context, "SVMAllocator")
        self._ctx, self._alignment, self._flags, self._queue = context, alignment, flags, queue

    def __call__(self, size):
        return SVMAllocation(self._ctx, size, self._alignment, self._flags, self._queue)


class PooledSVM(SVMPointer):
    def __init__(self, pool, alloc, req):
        self._pool, self._alloc, self._req, self._out = pool, alloc, int(req), True

    @property
    def svm_ptr(self):
        return self._alloc._ptr

    @property
    def size(self):
        return self._req

    def release(self):
        if self._out:
            self._out = False
            self._pool._give_back(self._alloc)

    def enqueue_release(self):
        self.release()

    def bind_to_queue(self, queue):
        self._alloc.bind_to_queue(queue)

    def unbind_from_queue(self):
        self._alloc.unbind_from_queue()

    def __eq__(self, other):
        return isinstance(other, PooledSVM) and other._alloc is self._alloc

    def __hash__(self):
        return hash(("PooledSVM", self._alloc._ptr))

    def __del__(self):
        try:
            self.release()
        except Exception:  # noqa: BLE001
            pass


class SVMPool(object):
    """依 2 的次方分箱的簡單池：釋放的區塊留在池裡（held），同箱的下次配置直接重用。"""

    def __init__(self, allocator, leading_bits_in_bin_id=4):
        self._alloc_fn, self._held, self._active = allocator, {}, {}
        self._stopped = False

    def bin_number(self, size):
        return max(int(size) - 1, 1).bit_length()

    def alloc_size(self, bin_nr):
        return 1 << int(bin_nr)

    def __call__(self, size):
        b = self.bin_number(size)
        lst = self._held.get(b)
        a = lst.pop() if lst else self._alloc_fn(self.alloc_size(b))
        self._active[id(a)] = (a, b)
        return PooledSVM(self, a, size)

    def _give_back(self, a):
        _, b = self._active.pop(id(a), (None, self.bin_number(a._size)))
        if self._stopped:
            a.release()
        else:
            self._held.setdefault(b, []).append(a)

    @property
    def held_blocks(self):
        return sum(len(v) for v in self._held.values())

    @property
    def active_blocks(self):
        return len(self._active)

    @property
    def managed_bytes(self):
        return sum(a._size for a, _ in self._active.values()) + sum(a._size for v in self._held.values() for a in v)

    @property
    def active_bytes(self):
        return sum(a._size for a, _ in self._active.values())

    def free_held(self):
        for v in self._held.values():
            for a in v:
                a.release()
        self._held = {}

    def stop_holding(self):
        self._stopped = True
        self.free_held()


def _svm_n(dst_or_src, byte_count, others=()):
    n = byte_count
    if n is None:
        sizes = [x.size for x in (dst_or_src,) + tuple(others) if x.size is not None]
        n = min(sizes) if sizes else None
    if n is None:
        _raise("clEnqueueSVMMemcpy", "INVALID_VALUE", "要給 byte_count（兩邊都沒有大小）")
    return int(n)


def _enqueue_svm_memcpy(queue, is_blocking, dst, src, wait_for=None, byte_count=None):
    n = _svm_n(dst, byte_count, (src,))
    for p in (dst, src):
        if p.size is not None and n > p.size:
            _raise("clEnqueueSVMMemcpy", "INVALID_VALUE", "byte_count %d 超過區塊大小 %d" % (n, p.size))
    _ct.memmove(int(dst.svm_ptr), int(src.svm_ptr), n)
    return _done_event(queue, "svm_memcpy")


def _enqueue_svm_memfill(queue, dst, pattern, byte_count=None, wait_for=None):
    pat = _as_bytes(pattern)
    n = _svm_n(dst, byte_count)
    if not pat or n % len(pat):
        _raise("clEnqueueSVMMemFill", "INVALID_VALUE", "byte_count 要是 pattern 長度的整數倍")
    _ct.memmove(int(dst.svm_ptr), pat * (n // len(pat)), n)
    return _done_event(queue, "svm_memfill")


def _enqueue_svm_map(queue, is_blocking, flags, svm, wait_for=None, size=None):
    return _done_event(queue, "svm_map")   # 主機端永遠是最新的（見檔頭），map 不需要傳輸


def _enqueue_svm_unmap(queue, svm, wait_for=None):
    return _done_event(queue, "svm_unmap")   # 下次核心啟動前會依 crc32 把主機端的改動推上裝置


def _enqueue_svm_migrate_mem(queue, svms, flags=None, wait_for=None):
    return _done_event(queue, "svm_migrate")


# ---------------------------------------------------------------------------------------------
# 標記、屏障、等待、遷移：這個後端的佇列是循序、操作都已完成，所以這些只是回傳一個已完成的事件（語意上就是「前面的都做完了」）
# ---------------------------------------------------------------------------------------------

def _done_event(queue, name):
    return Event({"h": -1, "cmd": name, "queued": 0, "start": 0, "end": 0}, queue)


def _enqueue_marker_with_wait_list(queue, wait_for=None):
    return _done_event(queue, "marker")


def _enqueue_marker(queue):
    return _done_event(queue, "marker")


def _enqueue_wait_for_events(queue, wait_for=None):
    return None


def _enqueue_barrier_with_wait_list(queue, wait_for=None):
    return _done_event(queue, "barrier")


def _enqueue_barrier(queue):
    return _done_event(queue, "barrier")


def enqueue_migrate_mem_objects(queue, mem_objects, flags=0, wait_for=None):
    for m in mem_objects:
        if not isinstance(m, MemoryObjectHolder):
            _raise("clEnqueueMigrateMemObjects", "INVALID_MEM_OBJECT", "要傳記憶體物件")
    return _done_event(queue, "migrate")   # 裝置駐留由載入器依需要決定；這裡只是提示，沒有可遷移的獨立裝置記憶體


# ---------------------------------------------------------------------------------------------
# map：緩衝區（沒有真的映射；讀進一份主機記憶體，release 時寫回——語意與 map／unmap 相同，成本是兩次複製）
# ---------------------------------------------------------------------------------------------

class MemoryMap(bytearray):
    """enqueue_map_buffer 回傳的陣列的 base（numpy 陣列建在它上面）。release()（或離開 with）時，若 map 時帶了寫入旗標就寫回緩衝區。"""

    def _init(self, queue, mem, offset, flags):
        self._queue, self._mem, self._offset, self._flags, self._released = queue, mem, int(offset), int(flags), False
        return self

    def release(self, queue=None, wait_for=None):
        if self._released:
            _raise("clEnqueueUnmapMemObject", "INVALID_VALUE", "這個 map 已經 release 過了")
        self._released = True
        q = queue or self._queue
        if self._flags & (map_flags.WRITE | map_flags.WRITE_INVALIDATE_REGION):
            res, _ = _call("buf_write", {"queue": q._h, "mem": self._mem._h, "offset": self._offset}, bytes(self))
            return Event(res["event"], q)
        return _done_event(q, "unmap")


def enqueue_map_buffer(queue, buf, flags, offset, shape, dtype, order="C", strides=None, wait_for=None, is_blocking=True):
    dt = np.dtype(dtype)
    shape = tuple(int(x) for x in (shape if hasattr(shape, "__iter__") else (shape,)))
    nbytes = int(np.prod(shape, dtype=np.int64)) * dt.itemsize
    if offset < 0 or offset + nbytes > buf._size:
        _raise("clEnqueueMapBuffer", "INVALID_VALUE", "map 的範圍（offset %d + %d 位元組）超出緩衝區（%d）" % (offset, nbytes, buf._size))
    flags = int(flags)
    mm = MemoryMap(nbytes)._init(queue, buf, offset, flags)
    if not (flags & map_flags.WRITE_INVALIDATE_REGION):   # 要讀的內容才從緩衝區取；INVALIDATE 表示整段會被覆寫，不必讀
        res, data = _call("buf_read", {"queue": queue._h, "mem": buf._h, "offset": int(offset), "size": nbytes})
        mm[:] = data
        ev = Event(res["event"], queue)
    else:
        ev = _done_event(queue, "map")
    arr = np.ndarray(shape, dtype=dt, buffer=mm, order=order, strides=strides)   # base 直接是 MemoryMap（與真 pyopencl 一樣：arr.base.release()）
    return arr, ev


# ---------------------------------------------------------------------------------------------
# 矩形（3D）緩衝區讀寫與複製：origin／region 的第一維是位元組；pitches＝(row_pitch, slice_pitch)，沒給就是緊密排列
# ---------------------------------------------------------------------------------------------

def _rect_rows(origin, region, pitches):
    origin = tuple(int(x) for x in origin) + (0,) * (3 - len(origin))
    region = tuple(int(x) for x in region) + (1,) * (3 - len(region))
    rp = int(pitches[0]) if pitches and pitches[0] else region[0]
    sp = int(pitches[1]) if pitches and len(pitches) > 1 and pitches[1] else region[1] * rp
    rows = []
    for z in range(region[2]):
        for y in range(region[1]):
            rows.append((origin[0] + (origin[1] + y) * rp + (origin[2] + z) * sp, region[0]))
    return rows


def _rect_check(mem_size, rows, what):
    for off, n in rows:
        if off < 0 or off + n > mem_size:
            _raise("clEnqueueBufferRect", "INVALID_VALUE", "%s：矩形超出範圍（位元組 %d..%d，大小 %d）" % (what, off, off + n, mem_size))


def _enqueue_read_buffer_rect(queue, mem, hostbuf, buffer_origin, host_origin, region, buffer_pitches=None, host_pitches=None, wait_for=None, is_blocking=True):
    mv = _byte_view(hostbuf)
    brows, hrows = _rect_rows(buffer_origin, region, buffer_pitches), _rect_rows(host_origin, region, host_pitches)
    _rect_check(mem._size, brows, "緩衝區")
    _rect_check(len(mv), hrows, "主機陣列")
    res, data = _call("buf_read", {"queue": queue._h, "mem": mem._h, "offset": 0, "size": mem._size})
    for (bo, n), (ho, _) in zip(brows, hrows):
        mv[ho:ho + n] = data[bo:bo + n]
    return Event(res["event"], queue)


def _enqueue_write_buffer_rect(queue, mem, hostbuf, buffer_origin, host_origin, region, buffer_pitches=None, host_pitches=None, wait_for=None, is_blocking=True):
    src = bytes(_byte_view(hostbuf))
    brows, hrows = _rect_rows(buffer_origin, region, buffer_pitches), _rect_rows(host_origin, region, host_pitches)
    _rect_check(mem._size, brows, "緩衝區")
    _rect_check(len(src), hrows, "主機陣列")
    _, cur = _call("buf_read", {"queue": queue._h, "mem": mem._h, "offset": 0, "size": mem._size})   # 讀－改－寫：只覆蓋矩形，其餘保留
    cur = bytearray(cur)
    for (bo, n), (ho, _) in zip(brows, hrows):
        cur[bo:bo + n] = src[ho:ho + n]
    res, _ = _call("buf_write", {"queue": queue._h, "mem": mem._h, "offset": 0}, bytes(cur))
    return Event(res["event"], queue)


def _enqueue_copy_buffer_rect(queue, src, dst, src_origin, dst_origin, region, src_pitches=None, dst_pitches=None, wait_for=None):
    srows, drows = _rect_rows(src_origin, region, src_pitches), _rect_rows(dst_origin, region, dst_pitches)
    _rect_check(src._size, srows, "來源")
    _rect_check(dst._size, drows, "目的")
    _, sdata = _call("buf_read", {"queue": queue._h, "mem": src._h, "offset": 0, "size": src._size})
    _, ddata = _call("buf_read", {"queue": queue._h, "mem": dst._h, "offset": 0, "size": dst._size}) if dst is not src else (None, sdata)
    out = bytearray(ddata)
    for (so, n), (do, _) in zip(srows, drows):
        out[do:do + n] = sdata[so:so + n]
    res, _ = _call("buf_write", {"queue": queue._h, "mem": dst._h, "offset": 0}, bytes(out))
    return Event(res["event"], queue)


def enqueue_copy_buffer_p2p_amd(platform, queue, src, dst, size=None, wait_for=None):
    return _enqueue_copy_buffer(queue, src, dst, -1 if size is None else size, 0, 0, wait_for)   # 這個後端只有一個裝置，點對點就是一般的緩衝區複製


def unload_platform_compiler(platform):
    return None   # 編譯器常駐在載入器裡，沒有可卸載的東西


def _unsupported(name):
    def f(*a, **k):
        _raise(name, "INVALID_OPERATION", "這個後端（第一批）不支援 %s" % name)
    f.__name__ = name
    return f


for _n in ("get_gl_context_info_khr", "get_apple_cgl_share_group"):
    globals()[_n] = _unsupported(_n)
