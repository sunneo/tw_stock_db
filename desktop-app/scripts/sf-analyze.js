#!/usr/bin/env node
// 音色庫分析：讀 sf2（或 piano-web 的 base64 js），輸出樣本數量、取樣率分布、
// 預設音色用到的樣本、完全相同／近似重複的樣本、未使用樣本、循環點資訊。
// 用法：node scripts/sf-analyze.js <檔案.sf2 | soundfont-gs-b64.js> [--json 輸出.json] [--corr 0.98]
'use strict';
const fs = require('fs');
const crypto = require('crypto');

function loadBuffer(p) {
  let buf = fs.readFileSync(p);
  if (buf.slice(0, 4).toString() === 'RIFF') return buf;
  const txt = buf.toString('latin1');
  const a = txt.indexOf('"'), b = txt.indexOf('"', a + 1);
  if (a < 0 || b - a < 1000) throw new Error('不是 sf2，也找不到 base64 字串');
  return Buffer.from(txt.slice(a + 1, b), 'base64');
}

function parseSf2(buf) {
  if (buf.slice(0, 4).toString() !== 'RIFF' || buf.slice(8, 12).toString() !== 'sfbk') throw new Error('不是 sf2');
  const out = { info: {}, chunks: {} };
  let pos = 12;
  while (pos < buf.length) {
    const id = buf.slice(pos, pos + 4).toString();
    const size = buf.readUInt32LE(pos + 4);
    if (id === 'LIST') {
      const type = buf.slice(pos + 8, pos + 12).toString();
      let p = pos + 12; const end = pos + 8 + size;
      while (p < end) {
        const cid = buf.slice(p, p + 4).toString();
        const csz = buf.readUInt32LE(p + 4);
        if (type === 'INFO') out.info[cid] = buf.slice(p + 8, p + 8 + csz).toString('latin1').replace(/\0.*$/, '');
        else out.chunks[cid] = { off: p + 8, size: csz };
        p += 8 + csz + (csz & 1);
      }
    }
    pos += 8 + size + (size & 1);
  }
  const rd = (name, rec, fn) => {
    const c = out.chunks[name]; const arr = [];
    if (!c) return arr;
    for (let o = c.off; o + rec <= c.off + c.size; o += rec) arr.push(fn(o));
    return arr;
  };
  const str = (o, n) => buf.slice(o, o + n).toString('latin1').replace(/\0.*$/, '');
  out.phdr = rd('phdr', 38, o => ({ name: str(o, 20), preset: buf.readUInt16LE(o + 20), bank: buf.readUInt16LE(o + 22), bagIdx: buf.readUInt16LE(o + 24) }));
  out.pbag = rd('pbag', 4, o => ({ genIdx: buf.readUInt16LE(o), modIdx: buf.readUInt16LE(o + 2) }));
  out.pgen = rd('pgen', 4, o => ({ oper: buf.readUInt16LE(o), amt: buf.readUInt16LE(o + 2), s: buf.readInt16LE(o + 2) }));
  out.inst = rd('inst', 22, o => ({ name: str(o, 20), bagIdx: buf.readUInt16LE(o + 20) }));
  out.ibag = rd('ibag', 4, o => ({ genIdx: buf.readUInt16LE(o), modIdx: buf.readUInt16LE(o + 2) }));
  out.igen = rd('igen', 4, o => ({ oper: buf.readUInt16LE(o), amt: buf.readUInt16LE(o + 2), s: buf.readInt16LE(o + 2) }));
  out.shdr = rd('shdr', 46, o => ({
    name: str(o, 20), start: buf.readUInt32LE(o + 20), end: buf.readUInt32LE(o + 24),
    loopStart: buf.readUInt32LE(o + 28), loopEnd: buf.readUInt32LE(o + 32), rate: buf.readUInt32LE(o + 36),
    pitch: buf.readUInt8(o + 40), correction: buf.readInt8(o + 41), link: buf.readUInt16LE(o + 42), type: buf.readUInt16LE(o + 44)
  }));
  out.shdr.pop(); // EOS
  out.phdr.pop(); out.inst.pop();
  out.smpl = out.chunks.smpl; out.sm24 = out.chunks.sm24 || null;
  return out;
}

// 產生器編號：41 = instrument, 53 = sampleID
function zonesOf(gens, bags, from, to) {
  const zones = [];
  for (let b = from; b < to; b++) {
    const g0 = bags[b].genIdx, g1 = bags[b + 1] ? bags[b + 1].genIdx : gens.length;
    zones.push(gens.slice(g0, g1));
  }
  return zones;
}

function analyze(buf, opts) {
  const sf = parseSf2(buf);
  const nS = sf.shdr.length;
  const samples = sf.shdr.map((h, i) => ({ i, ...h, len: Math.max(0, h.end - h.start) }));
  // 樣本 → 預設音色
  const instSamples = sf.inst.map((ins, k) => {
    const next = sf.inst[k + 1] ? sf.inst[k + 1].bagIdx : sf.ibag.length - 1;
    const set = new Set();
    for (const z of zonesOf(sf.igen, sf.ibag, ins.bagIdx, next)) {
      const g = z.find(x => x.oper === 53); if (g) set.add(g.amt);
    }
    return set;
  });
  const presetSamples = sf.phdr.map((ph, k) => {
    const next = sf.phdr[k + 1] ? sf.phdr[k + 1].bagIdx : sf.pbag.length - 1;
    const set = new Set();
    for (const z of zonesOf(sf.pgen, sf.pbag, ph.bagIdx, next)) {
      const g = z.find(x => x.oper === 41);
      if (g && instSamples[g.amt]) for (const s of instSamples[g.amt]) set.add(s);
    }
    return { ph, set };
  });
  const used = new Set(); presetSamples.forEach(p => p.set.forEach(s => used.add(s)));
  // 取樣資料（16 位元）
  const pcm = (s) => new Int16Array(buf.buffer.slice(buf.byteOffset + sf.smpl.off + s.start * 2, buf.byteOffset + sf.smpl.off + s.end * 2));
  // 完全相同
  const byHash = new Map();
  for (const s of samples) {
    if (!s.len) continue;
    const h = crypto.createHash('sha1').update(buf.slice(sf.smpl.off + s.start * 2, sf.smpl.off + s.end * 2)).digest('hex');
    s.hash = h; if (!byHash.has(h)) byHash.set(h, []); byHash.get(h).push(s.i);
  }
  const exactGroups = [...byHash.values()].filter(a => a.length > 1);
  let exactSaved = 0; exactGroups.forEach(g => g.slice(1).forEach(i => exactSaved += samples[i].len * 2));
  // 近似重複：同原始音高、長度相近，取前 N 點正規化後算相關係數
  const N = 4096, thr = opts.corr;
  const finger = new Map();
  const fp = (s) => {
    if (finger.has(s.i)) return finger.get(s.i);
    const d = pcm(s), n = Math.min(N, d.length), a = new Float32Array(N);
    let e = 0; for (let k = 0; k < n; k++) { a[k] = d[k]; e += a[k] * a[k]; }
    e = Math.sqrt(e) || 1; for (let k = 0; k < n; k++) a[k] /= e;
    finger.set(s.i, a); return a;
  };
  const buckets = new Map();
  for (const s of samples) { if (s.len < 256 || (s.type & 0x8000)) continue; const key = s.pitch; if (!buckets.has(key)) buckets.set(key, []); buckets.get(key).push(s); }
  const near = [], seen = new Set(exactGroups.flat().slice(0, 0));
  for (const list of buckets.values()) {
    for (let a = 0; a < list.length; a++) for (let b = a + 1; b < list.length; b++) {
      const x = list[a], y = list[b];
      if (x.hash === y.hash) continue;
      const r = x.len / y.len; if (r > 1.5 || r < 0.667) continue;
      const fa = fp(x), fb = fp(y); let c = 0; for (let k = 0; k < N; k++) c += fa[k] * fb[k];
      if (c >= thr) near.push({ a: x.i, b: y.i, corr: +c.toFixed(4), bytesB: y.len * 2 });
    }
  }
  const rateDist = {}; let totalBytes = 0, usedBytes = 0, loopCount = 0, loopBytesTail = 0;
  for (const s of samples) {
    rateDist[s.rate] = (rateDist[s.rate] || 0) + 1; totalBytes += s.len * 2;
    if (used.has(s.i)) usedBytes += s.len * 2;
    if (s.loopEnd > s.loopStart + 1 && s.loopEnd <= s.end) { loopCount++; loopBytesTail += Math.max(0, s.end - s.loopEnd) * 2; }
  }
  const resampleBytes = {};
  for (const cap of [32000, 22050, 16000]) resampleBytes[cap] = Math.round(samples.reduce((t, s) => t + s.len * 2 * Math.min(1, cap / s.rate), 0));
  return {
    resampleBytes,
    info: sf.info, fileBytes: buf.length, hasSm24: !!sf.sm24,
    sampleCount: nS, presetCount: sf.phdr.length, instrumentCount: sf.inst.length,
    totalSampleBytes: totalBytes, usedSampleBytes: usedBytes,
    unusedSamples: samples.filter(s => !used.has(s.i)).map(s => ({ i: s.i, name: s.name, bytes: s.len * 2 })),
    rateDist, loopedSamples: loopCount, bytesAfterLoopEnd: loopBytesTail,
    exactDuplicateGroups: exactGroups.map(g => g.map(i => samples[i].name)), exactDuplicateSavedBytes: exactSaved,
    nearDuplicates: near.map(n => ({ a: samples[n.a].name, b: samples[n.b].name, corr: n.corr, bytesB: n.bytesB })),
    nearDuplicateSavedBytesUpperBound: near.reduce((t, n) => t + n.bytesB, 0),
    presets: presetSamples.map(p => ({ bank: p.ph.bank, preset: p.ph.preset, name: p.ph.name, samples: [...p.set].map(i => samples[i].name) })),
    largestSamples: samples.slice().sort((a, b) => b.len - a.len).slice(0, 15).map(s => ({ name: s.name, bytes: s.len * 2, rate: s.rate }))
  };
}

if (require.main === module) {
  const args = process.argv.slice(2);
  if (!args[0]) { console.error('用法：node scripts/sf-analyze.js <檔案> [--json 輸出.json] [--corr 0.98]'); process.exit(1); }
  const ji = args.indexOf('--json'), ci = args.indexOf('--corr');
  const rep = analyze(loadBuffer(args[0]), { corr: ci >= 0 ? +args[ci + 1] : 0.98 });
  if (ji >= 0) fs.writeFileSync(args[ji + 1], JSON.stringify(rep, null, 1));
  const mb = n => (n / 1048576).toFixed(2) + ' MB';
  console.log(`名稱 ${rep.info.INAM}  檔案 ${mb(rep.fileBytes)}  24位元擴充 ${rep.hasSm24}`);
  console.log(`樣本 ${rep.sampleCount} 個，共 ${mb(rep.totalSampleBytes)}；預設音色 ${rep.presetCount}，樂器 ${rep.instrumentCount}`);
  console.log(`被預設音色用到 ${mb(rep.usedSampleBytes)}；未使用樣本 ${rep.unusedSamples.length} 個 ${mb(rep.unusedSamples.reduce((t, s) => t + s.bytes, 0))}`);
  console.log('取樣率分布', JSON.stringify(rep.rateDist));
  console.log(`循環樣本 ${rep.loopedSamples} 個；循環終點後多餘 ${mb(rep.bytesAfterLoopEnd)}`);
  console.log(`完全相同群組 ${rep.exactDuplicateGroups.length}，可省 ${mb(rep.exactDuplicateSavedBytes)}`);
  console.log(`近似重複配對 ${rep.nearDuplicates.length}，上限可省 ${mb(rep.nearDuplicateSavedBytesUpperBound)}（相關係數 >= ${ci >= 0 ? args[ci + 1] : 0.98}，僅供參考）`);
  console.log('全部降到上限取樣率後的大小（粗估，未壓縮）', Object.entries(rep.resampleBytes).map(([k, v]) => `${k}Hz:${mb(v)}`).join(', '));
  console.log('最大樣本', rep.largestSamples.slice(0, 8).map(s => `${s.name}:${mb(s.bytes)}`).join(', '));
}
module.exports = { analyze, parseSf2, loadBuffer };
