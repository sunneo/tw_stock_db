#!/usr/bin/env node
// 音色庫瘦身:node scripts/sf-slim.js <輸入.sf2> <輸出.sf2> [--max-rate=22050] [--report=報告.json] [--no-add-loop]
// 規則見 scripts/sf-loop.js(找每個樣本內部的 loop、截掉 loop 結尾後用不到的資料、持續音自動加 loop、再降取樣)。
// 只處理 GeneralUser GS 這類允許修改散布的音色庫;Roland 的樣本絕對不可使用。輸入輸出的音色庫放在 repo 外(大檔)。
'use strict';
const fs = require('fs'), cp = require('child_process'), loop = require('./sf-loop.js');

// SF3:每個樣本壓成 Ogg Vorbis(用 ffmpeg 的 libvorbis;quality -1..10,預設 3)。回 Buffer 或丟錯
function oggEncode(pcm16, rate, quality) { const r = cp.spawnSync('ffmpeg', ['-v', 'error', '-f', 's16le', '-ar', String(rate), '-ac', '1', '-i', '-', '-c:a', 'libvorbis', '-q:a', String(quality), '-f', 'ogg', '-'], { input: pcm16, maxBuffer: 64 << 20 }); if (r.status !== 0 || !r.stdout || !r.stdout.length) throw new Error('ffmpeg 編碼失敗:' + (r.stderr ? r.stderr.toString() : r.error)); return r.stdout; }

function readChunks(buf) { // 回傳 [{id, list?, data}] 頂層(RIFF 內)的 chunk 清單,LIST 內再展開一層
  const out = []; let pos = 12;
  while (pos + 8 <= buf.length) { const id = buf.toString('latin1', pos, pos + 4), size = buf.readUInt32LE(pos + 4); if (id === 'LIST') { const type = buf.toString('latin1', pos + 8, pos + 12), subs = []; let p = pos + 12; const end = pos + 8 + size; while (p + 8 <= end) { const cid = buf.toString('latin1', p, p + 4), csz = buf.readUInt32LE(p + 4); subs.push({ id: cid, data: buf.subarray(p + 8, p + 8 + csz) }); p += 8 + csz + (csz & 1); } out.push({ id, type, subs }); } else out.push({ id, data: buf.subarray(pos + 8, pos + 8 + size) }); pos += 8 + size + (size & 1); }
  return out;
}
function chunk(id, data) { const pad = data.length & 1 ? 1 : 0, b = Buffer.alloc(8 + data.length + pad); b.write(id, 0, 'latin1'); b.writeUInt32LE(data.length, 4); data.copy(b, 8); return b; }
function list(type, subs) { const body = Buffer.concat([Buffer.from(type, 'latin1')].concat(subs.map((s) => chunk(s.id, s.data)))); const b = Buffer.alloc(8 + body.length); b.write('LIST', 0, 'latin1'); b.writeUInt32LE(body.length, 4); body.copy(b, 8); return b; }

// 不能動的樣本編號:用到「鬆開琴鍵後才繼續播 loop 之後的尾段」(sampleModes = 3),或用起訖／loop 位移產生器(0～4、12、45、50)的,截尾或改 loop 會改變實際播放範圍
function releaseTailSamples(pdta) {
  const get = (id) => (pdta.subs.find((x) => x.id === id) || { data: Buffer.alloc(0) }).data, inst = get('inst'), ibag = get('ibag'), igen = get('igen'), set = new Set();
  const ni = inst.length / 22 - 1;
  for (let i = 0; i < ni; i++) {
    const b0 = inst.readUInt16LE(i * 22 + 20), b1 = inst.readUInt16LE((i + 1) * 22 + 20); let globalMode = 0;
    for (let z = b0; z < b1; z++) {
      const g0 = ibag.readUInt16LE(z * 4), g1 = ibag.readUInt16LE((z + 1) * 4); let mode = null, sid = -1, offs = false;
      for (let g = g0; g < g1; g++) { const oper = igen.readUInt16LE(g * 4), amt = igen.readUInt16LE(g * 4 + 2); if (oper === 54) mode = amt; else if (oper === 53) sid = amt; else if ((oper <= 4 || oper === 12 || oper === 45 || oper === 50) && amt) offs = true; }
      if (sid < 0) { if (mode != null) globalMode = mode; continue; }
      if (offs || ((mode == null ? globalMode : mode) & 3) === 3) set.add(sid);
    }
  }
  return set;
}
function slimBank(buf, opts) {
  const top = readChunks(buf); const sdta = top.find((c) => c.id === 'LIST' && c.type === 'sdta'), pdta = top.find((c) => c.id === 'LIST' && c.type === 'pdta');
  const smpl = sdta.subs.find((s) => s.id === 'smpl').data, shdrC = pdta.subs.find((s) => s.id === 'shdr');
  if (sdta.subs.some((s) => s.id === 'sm24')) throw new Error('這個音色庫有 24 位元樣本(sm24),sf-slim 還不支援');
  const n = shdrC.data.length / 46 - 1; const relTail = releaseTailSamples(pdta); const stats = { samples: n, releaseTail: relTail.size, actions: {}, bytesBefore: smpl.length, bytesAfter: 0, stereo: 0 }; const pieces = [], hdrs = [], per = [];
  let off = 0; const ZERO = Buffer.alloc(46 * 2);
  for (let i = 0; i < n; i++) {
    const r = shdrC.data.subarray(i * 46, i * 46 + 46), name = r.toString('latin1', 0, 20).replace(/\0.*$/, '');
    const st = r.readUInt32LE(20), en = r.readUInt32LE(24), sl = r.readUInt32LE(28), el = r.readUInt32LE(32), rate = r.readUInt32LE(36), type = r.readUInt16LE(44);
    const len = Math.max(0, en - st); const x = new Float32Array(len); for (let k = 0; k < len; k++) x[k] = smpl.readInt16LE((st + k) * 2) / 32768;
    const linked = type !== 1 && type !== 0x8001; if (linked) stats.stereo++;
    const hasLoop = el > sl + 8; const res = (linked || relTail.has(i) || (opts.noAddLoop && !hasLoop)) ? { data: x, hdr: { startLoop: hasLoop ? sl - st : 0, endLoop: hasLoop ? el - st : 0, rate }, action: 'keep' } : loop.slim(x, rate, { startLoop: hasLoop ? sl - st : 0, endLoop: hasLoop ? el - st : 0 }, { maxRate: opts.maxRate, hiShareDb: opts.hiShareDb, noGuard: opts.noGuard });
    const out = Buffer.alloc(res.data.length * 2); for (let k = 0; k < res.data.length; k++) out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(res.data[k] * 32768))), k * 2);
    const nh = Buffer.from(r); const ns = off, ne = off + res.data.length; nh.writeUInt32LE(ns, 20); nh.writeUInt32LE(ne, 24);
    const hl = res.hdr.endLoop > res.hdr.startLoop + 8; nh.writeUInt32LE(ns + (hl ? res.hdr.startLoop : 0), 28); nh.writeUInt32LE(ns + (hl ? res.hdr.endLoop : 0), 32); nh.writeUInt32LE(res.hdr.rate, 36);
    if (opts.sf3) { const ogg = oggEncode(out, res.hdr.rate, opts.quality == null ? 3 : opts.quality); nh.writeUInt32LE(off, 20); nh.writeUInt32LE(off + ogg.length, 24); nh.writeUInt32LE(hl ? res.hdr.startLoop : 0, 28); nh.writeUInt32LE(hl ? res.hdr.endLoop : 0, 32); nh.writeUInt16LE(type | 0x10, 44); pieces.push(ogg); off += ogg.length; stats.oggBytes = (stats.oggBytes || 0) + ogg.length; }
    else { pieces.push(out, ZERO.subarray(0, 92)); off = ne + 46; }
    hdrs.push(nh);
    const key = res.action.replace(/\+down/, ''); stats.actions[key] = (stats.actions[key] || 0) + 1; per.push({ name, action: res.action, before: len, after: res.data.length, rate: res.hdr.rate });
  }
  hdrs.push(shdrC.data.subarray(n * 46, n * 46 + 46)); const smplNew = Buffer.concat(pieces); stats.bytesAfter = smplNew.length;
  let info = top.find((c) => c.id === 'LIST' && c.type === 'INFO'); if (opts.sf3 && info) { const ifil = info.subs.find((x) => x.id === 'ifil'); if (ifil) { const b = Buffer.from(ifil.data); b.writeUInt16LE(3, 0); ifil.data = b; } }
  const sdtaNew = list('sdta', sdta.subs.map((s) => (s.id === 'smpl' ? { id: 'smpl', data: smplNew } : s)));
  const pdtaNew = list('pdta', pdta.subs.map((s) => (s.id === 'shdr' ? { id: 'shdr', data: Buffer.concat(hdrs) } : s)));
  const parts = top.map((c) => (c === sdta ? sdtaNew : c === pdta ? pdtaNew : c.id === 'LIST' ? list(c.type, c.subs) : chunk(c.id, c.data)));
  const body = Buffer.concat([Buffer.from('sfbk')].concat(parts)); const head = Buffer.alloc(8); head.write('RIFF', 0, 'latin1'); head.writeUInt32LE(body.length, 4);
  return { buf: Buffer.concat([head, body]), stats, per };
}

module.exports = { slimBank, readChunks };
if (require.main === module) {
  const a = process.argv.slice(2), pos = a.filter((x) => !x.startsWith('--')), opt = {}; a.filter((x) => x.startsWith('--')).forEach((x) => { const m = /^--([^=]+)(?:=(.*))?$/.exec(x); opt[m[1]] = m[2] === undefined ? true : m[2]; });
  if (pos.length < 2) { console.error('用法: node scripts/sf-slim.js <輸入.sf2> <輸出.sf2> [--max-rate=22050] [--report=報告.json] [--no-add-loop] [--sf3 [--quality=3]] [--hi-share-db=-35 高頻多的樣本不降取樣] [--no-guard 不做逐樣本波形檢查]'); process.exit(1); }
  const r = slimBank(fs.readFileSync(pos[0]), { maxRate: opt['max-rate'] ? Number(opt['max-rate']) : 0, noAddLoop: !!opt['no-add-loop'], sf3: !!opt.sf3, quality: opt.quality == null ? null : Number(opt.quality), hiShareDb: opt['hi-share-db'] == null ? null : Number(opt['hi-share-db']), noGuard: !!opt['no-guard'] });
  fs.writeFileSync(pos[1], r.buf); if (opt.report) fs.writeFileSync(opt.report, JSON.stringify(r, (k, v) => (k === 'buf' ? undefined : v), 1));
  console.log(JSON.stringify(r.stats), '\n輸出 ' + r.buf.length + ' 位元組(原 ' + fs.statSync(pos[0]).size + ')');
}
