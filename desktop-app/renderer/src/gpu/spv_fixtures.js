// SPIR-V 測試夾具（文字組合語言）：spv_js_test.js 直接組譯使用；scripts/gen-spv-fixtures.js 把它們寫成 .spv 二進位給 Python 與 .ll 的範例用。
// 形狀仿 clang＋llvm-spirv 對 OpenCL C 核心的輸出（Kernel 能力、Physical64、OpenCL 記憶體模型、內建變數以 Input 變數＋BuiltIn 裝飾）。
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.FaSpvFixtures = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';
const HEAD = `OpCapability Addresses
OpCapability Linkage
OpCapability Kernel
OpCapability Int64
OpCapability Int8
OpCapability Int16
OpCapability Vector16
OpCapability Float64
OpCapability ImageBasic
OpCapability ImageReadWrite
OpCapability Pipes
OpCapability LiteralSampler
OpCapability Int64Atomics
%ocl = OpExtInstImport "OpenCL.std"
OpMemoryModel Physical64 OpenCL
`;
const TYPES = `%void = OpTypeVoid
%bool = OpTypeBool
%uchar = OpTypeInt 8 0
%ushort = OpTypeInt 16 0
%uint = OpTypeInt 32 0
%ulong = OpTypeInt 64 0
%float = OpTypeFloat 32
%double = OpTypeFloat 64
%v2float = OpTypeVector %float 2
%v4float = OpTypeVector %float 4
%v4uint = OpTypeVector %uint 4
%v3ulong = OpTypeVector %ulong 3
%_ptr_In_v3ulong = OpTypePointer Input %v3ulong
%_ptr_CW_float = OpTypePointer CrossWorkgroup %float
%_ptr_CW_uint = OpTypePointer CrossWorkgroup %uint
%_ptr_WG_float = OpTypePointer Workgroup %float
%c0 = OpConstant %uint 0
%c1 = OpConstant %uint 1
%c2 = OpConstant %uint 2
%c32 = OpConstant %uint 32
%scope_wg = OpConstant %uint 2
%sem_wg = OpConstant %uint 272
%gid = OpVariable %_ptr_In_v3ulong Input
%lid = OpVariable %_ptr_In_v3ulong Input
%grp = OpVariable %_ptr_In_v3ulong Input
`;
const BUILTIN_DECO = `OpDecorate %gid BuiltIn GlobalInvocationId
OpDecorate %lid BuiltIn LocalInvocationId
OpDecorate %grp BuiltIn WorkgroupId
`;
const build = (entry, body, names = '') => HEAD + `OpEntryPoint Kernel %${entry} "${entry}"\n` + names + BUILTIN_DECO + TYPES + body;
const VADD = build('vadd', `%fn_vadd = OpTypeFunction %void %_ptr_CW_float %_ptr_CW_float %_ptr_CW_float %uint
%vadd = OpFunction %void None %fn_vadd
%a = OpFunctionParameter %_ptr_CW_float
%b = OpFunctionParameter %_ptr_CW_float
%c = OpFunctionParameter %_ptr_CW_float
%n = OpFunctionParameter %uint
%entry = OpLabel
%g3 = OpLoad %v3ulong %gid Aligned 32
%i = OpCompositeExtract %ulong %g3 0
%i32 = OpUConvert %uint %i
%ok = OpULessThan %bool %i32 %n
OpSelectionMerge %end None
OpBranchConditional %ok %body %end
%body = OpLabel
%pa = OpInBoundsPtrAccessChain %_ptr_CW_float %a %i
%va = OpLoad %float %pa Aligned 4
%pb = OpInBoundsPtrAccessChain %_ptr_CW_float %b %i
%vb = OpLoad %float %pb Aligned 4
%s = OpFAdd %float %va %vb
%pc = OpInBoundsPtrAccessChain %_ptr_CW_float %c %i
OpStore %pc %s Aligned 4
OpBranch %end
%end = OpLabel
OpReturn
OpFunctionEnd
`, 'OpName %a "a"\nOpName %b "b"\nOpName %c "c"\nOpName %n "n"\nOpDecorate %a FuncParamAttr NoCapture\nOpDecorate %c FuncParamAttr NoCapture\n');

const REDUCE = build('red', `%fn_red = OpTypeFunction %void %_ptr_CW_float %_ptr_CW_float %_ptr_WG_float
%red = OpFunction %void None %fn_red
%x = OpFunctionParameter %_ptr_CW_float
%out = OpFunctionParameter %_ptr_CW_float
%t = OpFunctionParameter %_ptr_WG_float
%entry = OpLabel
%l3 = OpLoad %v3ulong %lid Aligned 32
%l = OpCompositeExtract %ulong %l3 0
%g3 = OpLoad %v3ulong %gid Aligned 32
%g = OpCompositeExtract %ulong %g3 0
%px = OpInBoundsPtrAccessChain %_ptr_CW_float %x %g
%vx = OpLoad %float %px Aligned 4
%pt = OpInBoundsPtrAccessChain %_ptr_WG_float %t %l
OpStore %pt %vx Aligned 4
OpControlBarrier %scope_wg %scope_wg %sem_wg
%l32 = OpUConvert %uint %l
OpBranch %loop
%loop = OpLabel
%s = OpPhi %uint %c32 %entry %s2 %cont
%cmp = OpUGreaterThan %bool %s %c0
OpLoopMerge %exit %cont None
OpBranchConditional %cmp %body %exit
%body = OpLabel
%lt = OpULessThan %bool %l32 %s
OpSelectionMerge %after None
OpBranchConditional %lt %add %after
%add = OpLabel
%s64 = OpUConvert %ulong %s
%idx2 = OpIAdd %ulong %l %s64
%p2 = OpInBoundsPtrAccessChain %_ptr_WG_float %t %idx2
%v2 = OpLoad %float %p2 Aligned 4
%v1 = OpLoad %float %pt Aligned 4
%sum = OpFAdd %float %v1 %v2
OpStore %pt %sum Aligned 4
OpBranch %after
%after = OpLabel
OpControlBarrier %scope_wg %scope_wg %sem_wg
OpBranch %cont
%cont = OpLabel
%s2 = OpShiftRightLogical %uint %s %c1
OpBranch %loop
%exit = OpLabel
%is0 = OpIEqual %bool %l32 %c0
OpSelectionMerge %fin None
OpBranchConditional %is0 %wr %fin
%wr = OpLabel
%v0 = OpLoad %float %t Aligned 4
%gr3 = OpLoad %v3ulong %grp Aligned 32
%gr = OpCompositeExtract %ulong %gr3 0
%po = OpInBoundsPtrAccessChain %_ptr_CW_float %out %gr
OpStore %po %v0 Aligned 4
OpBranch %fin
%fin = OpLabel
OpReturn
OpFunctionEnd
`);
    return { HEAD, TYPES, BUILTIN_DECO, build, VADD, REDUCE };
});
