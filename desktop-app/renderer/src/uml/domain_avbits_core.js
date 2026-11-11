/* 領域包：影音壓縮階段 1「位元級基礎」（H.264 位元流的最底層）。格式見 domain_registry_core.js；範圍與判題對照見 DESIGN.blockly-curriculum.md §5。
 * 家族：Exp-Golomb（ue／se 解碼與編碼，符號慣例、尾位元是槽位）、Annex B 的 NAL 切分（3／4 位元組起始碼）、防競爭位元組（00 00 03）的插入與移除、
 *       RBSP 尾位元（停止位元的位置）、SPS／PPS／slice header 的欄位解析與寫出（基線＋高階 profile 的 SPS 附加欄位、poc type 0／1／2、裁切）。
 * 位元流以 '0'／'1' 字串展開（MSB 先），輔助操作 av_* 互相呼叫，跟 domain_inflate_core.js 同一做法。
 * 誠實限制：只涵蓋 SPS 不含 VUI 的欄位（VUI 之後的欄位不解析，也不寫出）；slice header 只解 I／P slice（slice_type 0、2、5、7）與 poc type 0／2，不解參考圖重排與加權預測表（遇到時拒絕）；位元流用字串展開，只適合小資料。 */
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(); else root.FaDomainAvbits = factory(); })(typeof self !== 'undefined' ? self : this, function () {
    'use strict';
    const L = (src) => src.replace(/^\n/, '').replace(/\n\s*$/, '').split('\n');
    const HELP = {
        av_bits: { params: ['data'], py: L(`
return "".join(format(x, "08b") for x in data)`) },
        av_ue: { params: ['bits', 'p'], py: L(`
z = 0
while bits[p + z] == "0":
    z += 1
v = (1 << z) - 1
if z:
    v += int(bits[p + z + 1:p + 2 * z + 1], 2)
return v, p + 2 * z + 1`) },
        av_se: { params: ['bits', 'p'], py: L(`
k, p = av_ue(bits, p)
if k % 2:
    return (k + 1) // 2, p
return -(k // 2), p`) },
        av_u: { params: ['bits', 'p', 'n'], py: L(`
return (int(bits[p:p + n], 2) if n else 0), p + n`) },
        av_unesc: { params: ['data'], py: L(`
out = bytearray()
z = 0
for b in data:
    if z >= 2 and b == 3:
        z = 0
        continue
    out.append(b)
    z = z + 1 if b == 0 else 0
return bytes(out)`) },
        av_esc: { params: ['data'], py: L(`
out = bytearray()
z = 0
for b in data:
    if z >= 2 and b <= 3:
        out.append(3)
        z = 0
    out.append(b)
    z = z + 1 if b == 0 else 0
if out and out[-1] == 0:
    out.append(3)
return bytes(out)`) },
        // Annex B 位元組流切成 NAL（含 1 位元組標頭；前一個 NAL 結尾的 0x00 屬於 4 位元組起始碼的 zero_byte，要剝掉）
        av_nals: { params: ['data'], py: L(`
res = []
starts = []
i = 0
while i + 2 < len(data):
    if data[i] == 0 and data[i + 1] == 0 and data[i + 2] == 1:
        starts.append(i + 3)
        i += 3
    else:
        i += 1
for k in range(len(starts)):
    e = starts[k + 1] - 3 if k + 1 < len(starts) else len(data)
    nal = data[starts[k]:e]
    while nal and nal[-1] == 0:
        nal = nal[:-1]
    res.append(bytes(nal))
return res`) },
        av_sps: { params: ['rbsp'], py: L(`
bits = av_bits(rbsp)
p = 0
d = {}
d["profile"], p = av_u(bits, p, 8)
d["cflags"], p = av_u(bits, p, 8)
d["level"], p = av_u(bits, p, 8)
d["id"], p = av_ue(bits, p)
d["chroma"] = 1
if d["profile"] in (100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135):
    d["chroma"], p = av_ue(bits, p)
    if d["chroma"] == 3:
        _, p = av_u(bits, p, 1)
    _, p = av_ue(bits, p)
    _, p = av_ue(bits, p)
    _, p = av_u(bits, p, 1)
    sm, p = av_u(bits, p, 1)
    if sm:
        for i in range(8 if d["chroma"] != 3 else 12):
            pr, p = av_u(bits, p, 1)
            if pr:
                last = 8
                nxt = 8
                for j in range(16 if i < 6 else 64):
                    if nxt != 0:
                        dl, p = av_se(bits, p)
                        nxt = (last + dl + 256) % 256
                    last = last if nxt == 0 else nxt
d["log2_fn"], p = av_ue(bits, p)
d["log2_fn"] += 4
d["poc"], p = av_ue(bits, p)
d["log2_poc"] = 0
if d["poc"] == 0:
    d["log2_poc"], p = av_ue(bits, p)
    d["log2_poc"] += 4
elif d["poc"] == 1:
    _, p = av_u(bits, p, 1)
    _, p = av_se(bits, p)
    _, p = av_se(bits, p)
    n, p = av_ue(bits, p)
    for i in range(n):
        _, p = av_se(bits, p)
d["refs"], p = av_ue(bits, p)
d["gaps"], p = av_u(bits, p, 1)
wm, p = av_ue(bits, p)
hm, p = av_ue(bits, p)
d["fmo"], p = av_u(bits, p, 1)
if not d["fmo"]:
    _, p = av_u(bits, p, 1)
_, p = av_u(bits, p, 1)
cr, p = av_u(bits, p, 1)
cl = cr_ = ct = cb = 0
if cr:
    cl, p = av_ue(bits, p)
    cr_, p = av_ue(bits, p)
    ct, p = av_ue(bits, p)
    cb, p = av_ue(bits, p)
cux = 1 if d["chroma"] in (0, 3) else 2
cuy = (1 if d["chroma"] in (0, 3) else 2) * (2 - d["fmo"])
d["w"] = (wm + 1) * 16 - cux * (cl + cr_)
d["h"] = (2 - d["fmo"]) * (hm + 1) * 16 - cuy * (ct + cb)
d["mbw"] = wm + 1
d["mbh"] = (2 - d["fmo"]) * (hm + 1)
return d`) },
        av_pps: { params: ['rbsp'], py: L(`
bits = av_bits(rbsp)
p = 0
d = {}
d["id"], p = av_ue(bits, p)
d["sps"], p = av_ue(bits, p)
d["cabac"], p = av_u(bits, p, 1)
d["bottom"], p = av_u(bits, p, 1)
d["groups"], p = av_ue(bits, p)
d["groups"] += 1
d["ref0"], p = av_ue(bits, p)
d["ref0"] += 1
d["ref1"], p = av_ue(bits, p)
d["ref1"] += 1
d["wp"], p = av_u(bits, p, 1)
d["wbp"], p = av_u(bits, p, 2)
q, p = av_se(bits, p)
d["qp"] = 26 + q
qs, p = av_se(bits, p)
d["qs"] = 26 + qs
d["cqp"], p = av_se(bits, p)
d["dbf"], p = av_u(bits, p, 1)
d["cip"], p = av_u(bits, p, 1)
d["red"], p = av_u(bits, p, 1)
return d`) },
        // 解第一個 slice 的標頭（NAL 含標頭位元組）；回傳 dict
        av_slice: { params: ['nal', 'sps', 'pps'], py: L(`
bits = av_bits(av_unesc(nal[1:]))
p = 0
d = {}
d["type"] = nal[0] & 31
d["ref_idc"] = (nal[0] >> 5) & 3
d["first_mb"], p = av_ue(bits, p)
st, p = av_ue(bits, p)
d["slice_type"] = st % 5
d["pps"], p = av_ue(bits, p)
d["frame_num"], p = av_u(bits, p, sps["log2_fn"])
if not sps["fmo"]:
    f, p = av_u(bits, p, 1)
    if f:
        _, p = av_u(bits, p, 1)
if d["type"] == 5:
    d["idr_id"], p = av_ue(bits, p)
if sps["poc"] == 0:
    d["poc_lsb"], p = av_u(bits, p, sps["log2_poc"])
if d["slice_type"] == 1:
    _, p = av_u(bits, p, 1)
if d["slice_type"] == 0:
    ov, p = av_u(bits, p, 1)
    d["nref"] = pps["ref0"]
    if ov:
        n, p = av_ue(bits, p)
        d["nref"] = n + 1
    rm, p = av_u(bits, p, 1)
    if rm:
        while True:
            op, p = av_ue(bits, p)
            if op == 3:
                break
            _, p = av_ue(bits, p)
if d["ref_idc"]:
    if d["type"] == 5:
        _, p = av_u(bits, p, 1)
        _, p = av_u(bits, p, 1)
    else:
        am, p = av_u(bits, p, 1)
        if am:
            while True:
                op, p = av_ue(bits, p)
                if op == 0:
                    break
                if op in (1, 3):
                    _, p = av_ue(bits, p)
                if op == 2:
                    _, p = av_ue(bits, p)
                if op == 3 or op == 6:
                    _, p = av_ue(bits, p)
                if op == 4:
                    _, p = av_ue(bits, p)
if pps["cabac"] and d["slice_type"] != 2:
    d["cabac_init"], p = av_ue(bits, p)
dq, p = av_se(bits, p)
d["qp"] = pps["qp"] + dq
if pps["dbf"]:
    d["dbf_idc"], p = av_ue(bits, p)
    if d["dbf_idc"] != 1:
        a, p = av_se(bits, p)
        b, p = av_se(bits, p)
        d["alpha"] = a * 2
        d["beta"] = b * 2
return d`) }
    };
    const pick = (names) => names.map((n) => ({ name: n, params: HELP[n].params, py: HELP[n].py }));
    function make(PAR) {
        const { S, code } = PAR.dsl;
        const D = (id, algo, label, slots, py, extra) => Object.assign({ id, algo, paradigm: 'binary-format', label, slots, py }, extra || {});
        const hexIn = (I) => I.inputs.length === 1 && I.inputs[0].k === 'hex';
        const listIn = (I) => I.inputs.length === 1 && I.inputs[0].k === 'list';
        const hx = (N) => N.s[0];
        const lst = (N) => N.ls[0];
        const numIn = (I) => I.inputs.length === 1 && (I.inputs[0].k === 'list' || (I.inputs[0].k === 'str' && I.inputs[0].raw));
        const nums = (N, I) => (I.inputs[0].k === 'list' ? lst(N) : '[int(t) for t in ' + N.s[0] + '.split()]');
        const skeletons = [
            D('av.eg-decode', 'av-eg-decode', 'Exp-Golomb 連續解碼：位元流（十六進位，MSB 先）依序是 ue(v) 或 se(v)，解到只剩 RBSP 尾位元（1 再接 0）為止，每個值一行或以空格分隔；se 的符號慣例（k 為奇數取正）與尾位元寫法由窮舉挑',
                [S('kind', '種類', [['ue', 'ue'], ['se', 'se']]), S('tail', '結尾', [['trail', 'trail'], ['zero', 'zero']])],
                (c, N) => code(['data = bytes.fromhex(' + hx(N) + '.strip())', 'bits = av_bits(data)', 'end = len(bits.rstrip("0")) - 1' + (c.tail === 'trail' ? '' : ' + 1'), 'p = 0', 'res = []', 'while p < end' + (c.tail === 'trail' ? '' : ' and "1" in bits[p:]') + ':', '    v, p = ' + (c.kind === 'ue' ? 'av_ue' : 'av_se') + '(bits, p)', '    res.append(v)', 'print(*res)']),
                { shape: hexIn, limit: 6, helpers: () => pick(['av_bits', 'av_ue', 'av_se']) }),
            D('av.eg-encode', 'av-eg-encode', 'Exp-Golomb 連續編碼：一串整數依序編成 ue(v) 或 se(v)（se：正數 v→2v-1、非正 v→-2v），串起來後補 RBSP 尾位元（1 再補 0 到位元組邊界）或只補 0，輸出十六進位小寫',
                [S('kind', '種類', [['ue', 'ue'], ['se', 'se']]), S('tail', '補齊', [['trail', 'trail'], ['zero', 'zero']])],
                (c, N, I) => code(['bits = ""', 'for v in ' + nums(N, I) + ':', c.kind === 'ue' ? '    k = v + 1' : '    k = 2 * v - 1 if v > 0 else -2 * v + 1', '    n = k.bit_length()', '    bits += "0" * (n - 1) + format(k, "b")', c.tail === 'trail' ? 'bits += "1"' : 'pass', 'bits += "0" * (-len(bits) % 8)', 'print(int(bits, 2).to_bytes(len(bits) // 8, "big").hex() if bits else "")']),
                { shape: numIn, limit: 6 }),
            D('av.nal-split', 'av-nal-split', 'Annex B 位元組流切成 NAL 單元：起始碼 00 00 01 或 00 00 00 01；每個 NAL 的第一個位元組是標頭（forbidden_zero_bit、nal_ref_idc 2 位元、nal_unit_type 5 位元）；輸出每個 NAL 的類型與位元組數（含標頭、不含起始碼）',
                [S('out', '輸出', [['ts', 'ts'], ['t', 't'], ['n', 'n'], ['trs', 'trs']])],
                (c, N) => code(['data = bytes.fromhex(' + hx(N) + '.strip())', 'nals = av_nals(data)'].concat({
                    ts: ['for n in nals:', '    print(n[0] & 31, len(n))'], t: ['print(*[n[0] & 31 for n in nals])'], n: ['print(len(nals))'],
                    trs: ['for n in nals:', '    print(n[0] & 31, (n[0] >> 5) & 3, len(n))']
                }[c.out])),
                { shape: hexIn, limit: 6, helpers: () => pick(['av_nals']) }),
            D('av.esc-remove', 'av-esc-remove', '防競爭位元組移除：NAL 負載（十六進位）中每個 00 00 03，把 03 去掉，得到 RBSP；輸出十六進位小寫',
                [S('o', '輸出', [['hex', 'hex'], ['len', 'len']])],
                (c, N) => code(['data = bytes.fromhex(' + hx(N) + '.strip())', 'r = av_unesc(data)', c.o === 'hex' ? 'print(r.hex())' : 'print(len(r))']),
                { shape: hexIn, limit: 4, helpers: () => pick(['av_unesc']) }),
            D('av.esc-insert', 'av-esc-insert', '防競爭位元組插入：RBSP 中只要出現 00 00 緊接著 00、01、02、03 之一，就在中間插入 03；若 RBSP 以 00 結尾，結尾要補 03；輸出十六進位小寫',
                [S('o', '輸出', [['hex', 'hex'], ['len', 'len']])],
                (c, N) => code(['data = bytes.fromhex(' + hx(N) + '.strip())', 'r = av_esc(data)', c.o === 'hex' ? 'print(r.hex())' : 'print(len(r))']),
                { shape: hexIn, limit: 4, helpers: () => pick(['av_esc']) }),
            D('av.rbsp-trailing', 'av-rbsp-trailing', 'RBSP 尾位元：資料最後一個值為 1 的位元是 rbsp_stop_one_bit，其後到位元組邊界全為 0；輸出有效負載的位元數（停止位元之前的位元數），或是停止位元所在的位元組索引與其內部位元位置',
                [S('o', '輸出', [['bits', 'bits'], ['pos', 'pos'], ['pad', 'pad']])],
                (c, N) => code(['data = bytes.fromhex(' + hx(N) + '.strip())', 'bits = av_bits(data)', 'n = len(bits.rstrip("0")) - 1'].concat({ bits: ['print(n)'], pos: ['print(n // 8, n % 8)'], pad: ['print(len(bits) - n - 1)'] }[c.o])),
                { shape: hexIn, limit: 6, helpers: () => pick(['av_bits']) }),
            D('av.sps-parse', 'av-sps-parse', 'SPS 解析：輸入是含起始碼的 Annex B 位元流（或單一 NAL），找出類型 7 的 NAL，去防競爭位元組後解 profile_idc、constraint 旗標、level_idc、seq_parameter_set_id、log2_max_frame_num、pic_order_cnt_type、max_num_ref_frames、寬與高（像素，含裁切）',
                [S('f', '輸出欄位', [['wh', 'wh'], ['pl', 'pl'], ['all', 'all'], ['mb', 'mb'], ['plw', 'plw']])],
                (c, N) => code(['data = bytes.fromhex(' + hx(N) + '.strip())', 'nals = av_nals(data) if data[:3] == b"\\x00\\x00\\x01" or data[:4] == b"\\x00\\x00\\x00\\x01" else [data]', 'sn = [n for n in nals if n[0] & 31 == 7][0]', 'd = av_sps(av_unesc(sn[1:]))'].concat({
                    wh: ['print(d["w"], d["h"])'], pl: ['print(d["profile"], d["level"], d["id"])'], mb: ['print(d["mbw"], d["mbh"])'], plw: ['print(d["profile"], d["level"], d["w"], d["h"])'],
                    all: ['print(d["profile"], d["level"], d["id"], d["log2_fn"], d["poc"], d["refs"], d["w"], d["h"])']
                }[c.f])),
                { shape: hexIn, limit: 8, helpers: () => pick(['av_bits', 'av_ue', 'av_se', 'av_u', 'av_unesc', 'av_nals', 'av_sps']) }),
            D('av.sps-write', 'av-sps-write', 'SPS 寫出（基線，無 VUI）：輸入一行整數（profile_idc level_idc sps_id 寬 高 參考幀數）；依序寫 profile、constraint 旗標位元組、level、ue(sps_id)、ue(log2_max_frame_num-4)=0、ue(poc_type)=2、ue(參考幀數)、gaps=0、寬高（巨集區塊數減一，高不足 16 的倍數時以裁切補，裁切單位 2 像素）、frame_mbs_only=1、direct_8x8=1、裁切旗標、vui=0、尾位元；加上起始碼 00 00 00 01 與標頭 0x67、防競爭位元組；輸出十六進位',
                [S('cf', 'constraint 旗標位元組', [['c0', '0xc0'], ['00', '0x00'], ['e0', '0xe0']]), S('sc', '起始碼', [['4', 'b"\\x00\\x00\\x00\\x01"'], ['3', 'b"\\x00\\x00\\x01"'], ['none', 'b""']])],
                (c, N, I) => code(['pr, lv, sid, w, h, nr = ' + nums(N, I) + '[:6]', 'def ue(v):', '    k = v + 1', '    return "0" * (k.bit_length() - 1) + format(k, "b")', 'bits = format(pr, "08b") + format(' + c.cf + ', "08b") + format(lv, "08b")', 'bits += ue(sid) + ue(0) + ue(2) + ue(nr) + "0"', 'bits += ue((w + 15) // 16 - 1) + ue((h + 15) // 16 - 1) + "1" + "1"', 'cr = (w % 16 != 0) or (h % 16 != 0)', 'if cr:', '    bits += "1" + ue(0) + ue((16 - w % 16) % 16 // 2) + ue(0) + ue((16 - h % 16) % 16 // 2)', 'else:', '    bits += "0"', 'bits += "0" + "1"', 'bits += "0" * (-len(bits) % 8)', 'rb = int(bits, 2).to_bytes(len(bits) // 8, "big")', 'print((' + c.sc + ' + b"\\x67" + av_esc(rb)).hex())']),
                { shape: numIn, limit: 12, helpers: () => pick(['av_esc']) }),
            D('av.pps-parse', 'av-pps-parse', 'PPS 解析：輸入是含起始碼的位元流（或單一 NAL），找出類型 8 的 NAL，去防競爭位元組後解 pic_parameter_set_id、seq_parameter_set_id、entropy_coding_mode_flag、num_ref_idx_l0_default_active、pic_init_qp（26 加偏移）、chroma_qp_index_offset、deblocking_filter_control_present_flag',
                [S('f', '輸出欄位', [['all', 'all'], ['qp', 'qp'], ['cabac', 'cabac'], ['ids', 'ids']])],
                (c, N) => code(['data = bytes.fromhex(' + hx(N) + '.strip())', 'nals = av_nals(data) if data[:3] == b"\\x00\\x00\\x01" or data[:4] == b"\\x00\\x00\\x00\\x01" else [data]', 'pn = [n for n in nals if n[0] & 31 == 8][0]', 'd = av_pps(av_unesc(pn[1:]))'].concat({
                    all: ['print(d["id"], d["sps"], d["cabac"], d["ref0"], d["qp"], d["cqp"], d["dbf"])'], qp: ['print(d["qp"], d["cqp"])'], cabac: ['print(d["cabac"])'], ids: ['print(d["id"], d["sps"])']
                }[c.f])),
                { shape: hexIn, limit: 8, helpers: () => pick(['av_bits', 'av_ue', 'av_se', 'av_u', 'av_unesc', 'av_nals', 'av_pps']) }),
            D('av.pps-write', 'av-pps-write', 'PPS 寫出（基線）：輸入一行整數（pps_id sps_id pic_init_qp chroma_qp_offset ref_idx_l0 deblocking_control）；依序寫 ue(pps_id)、ue(sps_id)、entropy_coding_mode=0、bottom_field_pic_order=0、ue(slice_groups-1)=0、ue(ref_idx_l0-1)、ue(0)、weighted_pred=0、weighted_bipred_idc=00、se(pic_init_qp-26)、se(0)、se(chroma_qp_offset)、deblocking_control、constrained_intra=0、redundant_pic_cnt=0、尾位元；標頭 0x68，起始碼 00 00 00 01，防競爭位元組；輸出十六進位',
                [S('sc', '起始碼', [['4', 'b"\\x00\\x00\\x00\\x01"'], ['3', 'b"\\x00\\x00\\x01"'], ['none', 'b""']]), S('hd', '標頭位元組', [['68', '0x68'], ['48', '0x48']])],
                (c, N, I) => code(['pid, sid, qp, cq, rf, dc = ' + nums(N, I) + '[:6]', 'def ue(v):', '    k = v + 1', '    return "0" * (k.bit_length() - 1) + format(k, "b")', 'def se(v):', '    return ue(2 * v - 1 if v > 0 else -2 * v)', 'bits = ue(pid) + ue(sid) + "0" + "0" + ue(0) + ue(rf - 1) + ue(0) + "0" + "00" + se(qp - 26) + se(0) + se(cq) + str(dc) + "0" + "0" + "1"', 'bits += "0" * (-len(bits) % 8)', 'rb = int(bits, 2).to_bytes(len(bits) // 8, "big")', 'print((' + c.sc + ' + bytes([' + c.hd + ']) + av_esc(rb)).hex())']),
                { shape: numIn, limit: 8, helpers: () => pick(['av_esc']) }),
            D('av.slice-header', 'av-slice-header', 'slice header 解析：輸入是含 SPS、PPS 與一個 slice 的 Annex B 位元流；用 SPS 的 log2_max_frame_num 與 poc type、PPS 的旗標解第一個 slice 的 first_mb_in_slice、slice_type（取模 5：0=P、2=I）、pic_parameter_set_id、frame_num、IDR 的 idr_pic_id、slice_qp（pic_init_qp 加 slice_qp_delta）',
                [S('f', '輸出欄位', [['fq', 'fq'], ['all', 'all'], ['ts', 'ts'], ['q', 'q']])],
                (c, N) => code(['data = bytes.fromhex(' + hx(N) + '.strip())', 'nals = av_nals(data)', 'sps = av_sps(av_unesc([n for n in nals if n[0] & 31 == 7][0][1:]))', 'pps = av_pps(av_unesc([n for n in nals if n[0] & 31 == 8][0][1:]))', 'sl = [n for n in nals if n[0] & 31 in (1, 5)][0]', 'd = av_slice(sl, sps, pps)'].concat({
                    fq: ['print(d["frame_num"], d["qp"])'], q: ['print(d["qp"])'], ts: ['print(d["slice_type"], d["type"])'],
                    all: ['print(d["first_mb"], d["slice_type"], d["pps"], d["frame_num"], d.get("idr_id", -1), d["qp"])']
                }[c.f])),
                { shape: hexIn, limit: 8, helpers: () => pick(['av_bits', 'av_ue', 'av_se', 'av_u', 'av_unesc', 'av_nals', 'av_sps', 'av_pps', 'av_slice']) })
        ];
        const ALL = (...parts) => new RegExp('^' + parts.map((x) => String.raw`(?=[\s\S]*` + x + ')').join(''), 'i');
        const algos = [
            { key: 'av-sps-write', re: ALL('SPS', '(?:寫出|組出|產生|編成|產出)', '(?:profile_idc|profile)'), veto: /解析|解出|解讀/ },
            { key: 'av-pps-write', re: ALL('PPS', '(?:寫出|組出|產生|編成|產出)', '(?:pic_init_qp|pic_parameter_set_id)'), veto: /解析|解出|解讀/ },
            { key: 'av-slice-header', re: ALL('slice\s*(?:header|標頭)', '(?:解析|解出|解讀)'), veto: /寫出|組出/ },
            { key: 'av-sps-parse', re: ALL('(?:SPS|序列參數集)', '(?:解析|解出|解讀|找)'), veto: /寫出|組出|slice\s*(?:header|標頭)/i },
            { key: 'av-pps-parse', re: ALL('(?:PPS|圖像參數集)', '(?:解析|解出|解讀|找)'), veto: /寫出|組出|slice\s*(?:header|標頭)|SPS|序列參數集/i },
            { key: 'av-esc-insert', re: ALL('防競爭位元組', '(?:插入|加入|補上|加上)'), veto: /移除|去掉|還原/ },
            { key: 'av-esc-remove', re: ALL('防競爭位元組', '(?:移除|去掉|去除|還原|刪除)'), veto: /插入|加入|補上/ },
            { key: 'av-eg-encode', re: ALL('(?:Exp-Golomb|指數哥倫布|哥倫布|ue\(v\)|se\(v\))', '(?:編碼|編成|串起來|連接成|印出十六進位|輸出十六進位)'), veto: /解碼|解出|還原|解析/ },
            { key: 'av-eg-decode', re: ALL('(?:Exp-Golomb|指數哥倫布|哥倫布|ue\(v\)|se\(v\))', '(?:解碼|解出|還原|解析)'), veto: /編成|串起來|連接成/ },
            { key: 'av-rbsp-trailing', re: ALL('(?:RBSP|rbsp)', '(?:尾位元|停止位元|stop_one_bit|trailing)'), veto: /Exp-Golomb|指數哥倫布|哥倫布|ue\(v\)|se\(v\)|編成|串起來/i },
            { key: 'av-nal-split', re: ALL('NAL', '(?:Annex\s*B|起始碼|位元組流|串流)', '(?:切|分隔|拆|列出|統計|幾個|多少|共有|類型)'), veto: /防競爭位元組(?:插入|移除)|去掉防競爭/ }
        ].map((x) => Object.assign(x, { pri: true }));
        const paradigms = {}; for (const sk of skeletons) paradigms[sk.algo] = ['binary-format'];
        return { id: 'avbits', label: '影音壓縮 1：位元級基礎（Exp-Golomb、NAL、防競爭位元組、RBSP 尾位元、SPS／PPS／slice header）', requires: [], judge: { checker: 'tokens', timeoutMs: 30000 }, algos, paradigms, skeletons };
    }
    return { make, HELP };
});
