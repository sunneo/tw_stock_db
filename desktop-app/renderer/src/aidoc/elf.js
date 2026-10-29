// AIDoc debugging locator, part 4 (no DOM, no network): an address from a crash / backtrace -> function (ELF symbol table) -> file:line (DWARF .debug_line).
// The ELF is read in the browser straight from a File / Blob: only the section headers and the sections that are needed are read (File.slice),
// so a several-hundred-MB firmware image is never loaded as a whole. Nothing is stored in the project index (no schema change).
// Exposes `FaAidocElf` (browser, embedded into floating-assistant.js) and module.exports (node tests). Ported from the Redmine plugin redmine_ai_chat (ai_chat_aidoc_elf.js).
//   open(src, opts)            -> Promise<Elf>          src: File | Blob | ArrayBuffer | Uint8Array (opts.name for the file name)
//   Elf.info                   -> { bits, le, type, machine, machineName, entry, name, buildId, hasSymbols, hasLines, compressed, lo, hi, ... }
//   Elf.symbolAt(vaddr)        -> Promise<{ func, raw, value, size, off, inside } | null>
//   Elf.linesAt([vaddr...])    -> Promise<Map vaddr(string) -> { file, name, dir, line, col, isStmt }>
//   resolveFrames(elf, frames, versions, opts) -> Promise<{ items, notes, base, buildId:{level,msg}, module }>
//   applyToFrames(rep)         -> copy func / file / line of the ELF into the frames (the ELF is the authority for them)
//   parseModuleFrames(text)    -> frames for "#3 0x55.. (/path/prog+0x1171)" lines (ASan / sanitizer style) that the trace parser does not know
//   reportLines(rep)           -> markdown lines
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(); else root.FaAidocElf = factory(); })(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var MACHINES = { 3: 'x86', 8: 'MIPS', 20: 'PowerPC', 21: 'PowerPC64', 40: 'ARM', 62: 'x86-64', 183: 'AArch64', 243: 'RISC-V', 94: 'Xtensa', 247: 'BPF' };
  var MAX_SAFE = 9007199254740991;

  // ------------------------------------------------------------ byte source: a File / Blob is sliced, a buffer is viewed
  function source(x, name) {
    if (x && typeof x.slice === 'function' && typeof x.size === 'number' && typeof x.arrayBuffer === 'function') {
      return { name: name || x.name || '', size: x.size, read: function (off, len) {
        if (off < 0 || len < 0 || off + len > x.size) { return Promise.reject(new Error('ELF: read past the end of the file (offset ' + off + ', length ' + len + ', size ' + x.size + ')')); }
        return x.slice(off, off + len).arrayBuffer().then(function (b) { return new Uint8Array(b); });
      } };
    }
    var u8 = x instanceof Uint8Array ? x : new Uint8Array(x);
    return { name: name || '', size: u8.length, read: function (off, len) {
      if (off < 0 || len < 0 || off + len > u8.length) { return Promise.reject(new Error('ELF: read past the end of the file (offset ' + off + ', length ' + len + ', size ' + u8.length + ')')); }
      return Promise.resolve(u8.subarray(off, off + len));
    } };
  }

  function inflateZlib(bytes) {
    if (typeof DecompressionStream === 'undefined') { return Promise.reject(new Error('this browser has no DecompressionStream: cannot read compressed .debug_* sections')); }
    var rs = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'));
    return new Response(rs).arrayBuffer().then(function (b) { return new Uint8Array(b); });
  }

  function cstr(u8, off) {
    var e = off;
    while (e < u8.length && u8[e] !== 0) { e++; }
    var s = '';
    for (var i = off; i < e; i += 8192) { s += String.fromCharCode.apply(null, u8.subarray(i, Math.min(e, i + 8192))); }
    try { s = decodeURIComponent(escape(s)); } catch (_e) { /* not UTF-8: keep the bytes as latin1 */ }
    return s;
  }

  function hex(n) { return '0x' + (typeof n === 'bigint' ? n : BigInt(Math.max(0, Math.floor(n)))).toString(16); }
  function toBig(v) {
    if (typeof v === 'bigint') { return v; }
    if (typeof v === 'number') { return BigInt(Math.floor(v)); }
    var s = String(v).trim();
    return BigInt(/^0x/i.test(s) ? s : /^[0-9a-f]+$/i.test(s) && /[a-f]/i.test(s) ? '0x' + s : s);
  }

  // ------------------------------------------------------------ minimal Itanium demangler (nested / plain names only; anything else stays as it is)
  function demangle(raw) {
    var s = String(raw || '');
    var m;
    if (!/^_Z/.test(s)) { return s; }
    s = s.slice(2);
    var parts = [], i = 0;
    function ident() { var mm = /^(\d+)/.exec(s.slice(i)); if (!mm) { return null; } var n = +mm[1]; i += mm[1].length; var id = s.substr(i, n); if (id.length !== n) { return null; } i += n; return id; }
    if (s[0] === 'N') {
      i = 1;
      while (s[i] === 'K' || s[i] === 'V' || s[i] === 'r') { i++; }
      var id;
      while (i < s.length && s[i] !== 'E') {
        if ((id = ident()) === null) {
          if ((m = /^(C[123]|D[012])/.exec(s.slice(i)))) { var last = parts[parts.length - 1] || ''; parts.push((m[1][0] === 'D' ? '~' : '') + last); i += 2; continue; }
          return raw;
        }
        parts.push(id);
      }
      if (s[i] !== 'E') { return raw; }
    } else {
      var one = ident();
      if (one === null) { return raw; }
      parts.push(one);
    }
    return parts.join('::');
  }

  // ------------------------------------------------------------ ELF
  function openElf(srcLike, opts) {
    opts = opts || {};
    var src = source(srcLike, opts.name);
    var inflate = opts.inflate || inflateZlib;
    return src.read(0, Math.min(64, src.size)).then(function (h) {
      if (h.length < 52 || h[0] !== 0x7f || h[1] !== 0x45 || h[2] !== 0x4c || h[3] !== 0x46) { throw new Error('not an ELF file (the first bytes are not 7f 45 4c 46)'); }
      var bits = h[4] === 2 ? 64 : h[4] === 1 ? 32 : 0, le = h[5] === 1;
      if (!bits || (h[5] !== 1 && h[5] !== 2)) { throw new Error('unsupported ELF class / byte order'); }
      var dv = new DataView(h.buffer, h.byteOffset, h.byteLength);
      var u16 = function (o) { return dv.getUint16(o, le); }, u32 = function (o) { return dv.getUint32(o, le); };
      var u64 = function (o) { var lo = u32(le ? o : o + 4), hi = u32(le ? o + 4 : o); return hi * 4294967296 + lo; };
      var ptr = bits === 64 ? u64 : u32;
      var E = bits === 64 ? { type: 16, machine: 18, entry: 24, shoff: 40, shentsize: 58, shnum: 60, shstrndx: 62 } : { type: 16, machine: 18, entry: 24, shoff: 32, shentsize: 46, shnum: 48, shstrndx: 50 };
      var etype = u16(E.type), machine = u16(E.machine);
      var entry = bits === 64 ? dv.getBigUint64(E.entry, le) : BigInt(u32(E.entry));
      var shoff = ptr(E.shoff), shentsize = u16(E.shentsize), shnum = u16(E.shnum), shstrndx = u16(E.shstrndx);
      if (!shoff || !shentsize) { throw new Error('the ELF file has no section header table (stripped of sections): symbols and line numbers cannot be read'); }
      var firstP = shnum === 0 || shstrndx === 0xffff ? src.read(shoff, shentsize) : Promise.resolve(null);
      return firstP.then(function (s0) {
        if (s0) {
          var d0 = new DataView(s0.buffer, s0.byteOffset, s0.byteLength);
          var rd = function (o32, o64) { return bits === 64 ? (d0.getUint32(o64 + (le ? 4 : 0), le) * 4294967296 + d0.getUint32(o64 + (le ? 0 : 4), le)) : d0.getUint32(o32, le); };
          if (shnum === 0) { shnum = rd(20, 32); }
          if (shstrndx === 0xffff) { shstrndx = d0.getUint32(bits === 64 ? 40 : 24, le); }
        }
        if (shoff + shnum * shentsize > src.size) { throw new Error('the section header table runs past the end of the file (truncated download?)'); }
        return src.read(shoff, shnum * shentsize);
      }).then(function (tab) {
        var d = new DataView(tab.buffer, tab.byteOffset, tab.byteLength);
        var g32 = function (o) { return d.getUint32(o, le); };
        var g64 = function (o) { return d.getUint32(o + (le ? 4 : 0), le) * 4294967296 + d.getUint32(o + (le ? 0 : 4), le); };
        var big = function (o) { return bits === 64 ? d.getBigUint64(o, le) : BigInt(g32(o)); };
        var secs = [];
        for (var i = 0; i < shnum; i++) {
          var b = i * shentsize;
          secs.push(bits === 64
            ? { i: i, nameOff: g32(b), type: g32(b + 4), flags: g64(b + 8), addr: big(b + 16), offset: g64(b + 24), size: g64(b + 32), link: g32(b + 40), info: g32(b + 44), entsize: g64(b + 56), name: '' }
            : { i: i, nameOff: g32(b), type: g32(b + 4), flags: g32(b + 8), addr: big(b + 12), offset: g32(b + 16), size: g32(b + 20), link: g32(b + 24), info: g32(b + 28), entsize: g32(b + 36), name: '' });
        }
        var ss = secs[shstrndx];
        if (!ss) { throw new Error('bad section-name string table index'); }
        return src.read(ss.offset, ss.size).then(function (names) {
          secs.forEach(function (s) { s.name = cstr(names, s.nameOff); });
          return new Elf(src, { bits: bits, le: le, type: etype, machine: machine, entry: entry }, secs, inflate);
        });
      });
    });
  }

  function Elf(src, hdr, secs, inflate) {
    this.src = src; this.hdr = hdr; this.secs = secs; this.inflate = inflate;
    this._cache = {};
    var byName = {};
    secs.forEach(function (s) { if (!byName[s.name]) { byName[s.name] = s; } });
    this.byName = byName;
    var alloc = secs.filter(function (s) { return (s.flags & 2) && s.size > 0 && s.addr > 0n && s.type !== 8 || ((s.flags & 2) && s.size > 0 && s.type === 8 && s.addr > 0n); });
    var lo = null, hi = null;
    alloc.forEach(function (s) { var e = s.addr + BigInt(s.size); if (lo === null || s.addr < lo) { lo = s.addr; } if (hi === null || e > hi) { hi = e; } });
    this.alloc = alloc;
    var dbg = secs.filter(function (s) { return /^\.(?:z?debug_)/.test(s.name); });
    this.info = {
      bits: hdr.bits, le: hdr.le, type: hdr.type, typeName: hdr.type === 2 ? 'EXEC' : hdr.type === 3 ? 'DYN (PIE / shared object)' : hdr.type === 1 ? 'REL (object file)' : String(hdr.type),
      machine: hdr.machine, machineName: MACHINES[hdr.machine] || 'machine ' + hdr.machine, entry: hdr.entry, name: src.name, size: src.size,
      hasSymbols: !!(byName['.symtab'] || byName['.dynsym']), hasSymtab: !!byName['.symtab'],
      hasLines: !!(byName['.debug_line'] || byName['.zdebug_line']), compressed: dbg.some(function (s) { return (s.flags & 0x800) || /^\.zdebug/.test(s.name); }),
      debuglink: !!byName['.gnu_debuglink'], lo: lo, hi: hi, buildId: ''
    };
  }

  // the bytes of a section, decompressed when it is (SHF_COMPRESSED, or the old ".zdebug_" format)
  Elf.prototype.section = function (name) {
    var self = this, s = this.byName[name] || this.byName['.z' + name.slice(1)];
    if (!s || s.type === 8 || !s.size) { return Promise.resolve(null); }
    if (this._cache[s.name]) { return this._cache[s.name]; }
    var p = this.src.read(s.offset, s.size).then(function (raw) {
      var bits = self.hdr.bits, le = self.hdr.le;
      if (s.flags & 0x800) {
        var dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
        var ctype = dv.getUint32(0, le), hlen = bits === 64 ? 24 : 12;
        if (ctype !== 1) { throw new Error('section ' + s.name + ' is compressed with an unsupported method (ch_type=' + ctype + ', only zlib is supported; zstd needs a newer reader)'); }
        return self.inflate(raw.subarray(hlen));
      }
      if (/^\.zdebug/.test(s.name) && raw.length > 12 && raw[0] === 0x5a && raw[1] === 0x4c && raw[2] === 0x49 && raw[3] === 0x42) { return self.inflate(raw.subarray(12)); }
      return raw;
    });
    this._cache[s.name] = p;
    return p;
  };

  Elf.prototype.loadBuildId = function () {
    var self = this;
    if (this._bid) { return this._bid; }
    var s = this.byName['.note.gnu.build-id'];
    this._bid = (s ? this.section('.note.gnu.build-id') : Promise.resolve(null)).then(function (n) {
      if (!n || n.length < 16) { return ''; }
      var dv = new DataView(n.buffer, n.byteOffset, n.byteLength), le = self.hdr.le;
      var namesz = dv.getUint32(0, le), descsz = dv.getUint32(4, le), off = 12 + ((namesz + 3) & ~3), out = '';
      for (var i = 0; i < descsz && off + i < n.length; i++) { out += ('0' + n[off + i].toString(16)).slice(-2); }
      self.info.buildId = out;
      return out;
    });
    return this._bid;
  };

  // function symbols, sorted by address (names are read lazily from the string table)
  Elf.prototype.loadSymbols = function () {
    var self = this;
    if (this._syms) { return this._syms; }
    var symSec = this.byName['.symtab'] || this.byName['.dynsym'];
    if (!symSec) { this._syms = Promise.resolve({ addr: [], size: [], nameOff: [], rank: [], order: [], str: null, from: '' }); return this._syms; }
    var strSec = this.secs[symSec.link], bits = this.hdr.bits, le = this.hdr.le, arm = this.hdr.machine === 40;
    this._syms = Promise.all([this.src.read(symSec.offset, symSec.size), this.src.read(strSec.offset, strSec.size)]).then(function (r) {
      var buf = r[0], str = r[1], dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
      var esz = bits === 64 ? 24 : 16, n = Math.floor(buf.length / esz), addr = [], size = [], nameOff = [], rank = [];
      var execSec = {};
      self.secs.forEach(function (s) { if (s.flags & 4) { execSec[s.i] = 1; } });
      for (var i = 1; i < n; i++) {
        var b = i * esz, name, info, shndx, value, sz;
        if (bits === 64) {
          name = dv.getUint32(b, le); info = buf[b + 4]; shndx = dv.getUint16(b + 6, le);
          value = dv.getUint32(b + 8 + (le ? 4 : 0), le) * 4294967296 + dv.getUint32(b + 8 + (le ? 0 : 4), le);
          sz = dv.getUint32(b + 16 + (le ? 4 : 0), le) * 4294967296 + dv.getUint32(b + 16 + (le ? 0 : 4), le);
        } else {
          name = dv.getUint32(b, le); value = dv.getUint32(b + 4, le); sz = dv.getUint32(b + 8, le); info = buf[b + 12]; shndx = dv.getUint16(b + 14, le);
        }
        var type = info & 15, bind = info >> 4;
        if (!shndx || shndx >= 0xff00 || !value) { continue; }
        if (type !== 2 && type !== 10 && !(type === 0 && execSec[shndx])) { continue; }
        var nm = cstr(str, name);
        if (!nm || /^(?:\$[adxt]\b|\.L)/.test(nm)) { continue; }
        if (arm && type !== 0) { value = value - (value % 2); }
        addr.push(value); size.push(sz); nameOff.push(name);
        rank.push((type === 0 ? 0 : 4) + (bind === 1 ? 2 : bind === 2 ? 1 : 0));
      }
      var order = addr.map(function (_, i) { return i; }).sort(function (a, c) { return addr[a] - addr[c] || rank[c] - rank[a] || a - c; });
      return { addr: addr, size: size, nameOff: nameOff, rank: rank, order: order, str: str, from: symSec.name };
    });
    return this._syms;
  };

  // which symbol holds this address? inside=false when the nearest symbol before it ends earlier (the answer is then only a hint)
  Elf.prototype.symbolAt = function (vaddr) {
    var self = this;
    return this.loadSymbols().then(function (S) {
      var v = Number(vaddr);
      if (self.hdr.machine === 40) { v = v - (v % 2); }
      if (v > MAX_SAFE) { throw new Error('addresses above 2^53 are not supported by the symbol reader'); }
      var lo = 0, hi = S.order.length - 1, at = -1;
      while (lo <= hi) { var mid = (lo + hi) >> 1; if (S.addr[S.order[mid]] <= v) { at = mid; lo = mid + 1; } else { hi = mid - 1; } }
      if (at < 0) { return null; }
      // among symbols that start at the same address the best-ranked one is first in `order`
      var first = at;
      while (first > 0 && S.addr[S.order[first - 1]] === S.addr[S.order[at]]) { first--; }
      var k = S.order[first], inside = !S.size[k] || v < S.addr[k] + S.size[k];
      if (!inside) {
        // an enclosing symbol earlier in the table (a sized function that contains this address)?
        for (var j = first - 1, tries = 0; j >= 0 && tries < 64; j--, tries++) {
          var q = S.order[j];
          if (S.size[q] && v < S.addr[q] + S.size[q]) { k = q; inside = true; break; }
        }
      }
      var raw = cstr(S.str, S.nameOff[k]);
      return { raw: raw, func: demangle(raw), value: S.addr[k], size: S.size[k], off: v - S.addr[k], inside: inside, from: S.from };
    });
  };

  Elf.prototype.symbolByName = function (name) {
    return this.loadSymbols().then(function (S) {
      var best = -1;
      for (var i = 0; i < S.addr.length; i++) {
        var raw = cstr(S.str, S.nameOff[i]);
        if ((raw === name || demangle(raw) === name || demangle(raw).split('::').pop() === name) && (best < 0 || S.rank[i] > S.rank[best])) { best = i; }
      }
      return best < 0 ? null : { raw: cstr(S.str, S.nameOff[best]), value: S.addr[best], size: S.size[best] };
    });
  };

  // ------------------------------------------------------------ DWARF .debug_line
  function Reader(u8, le) {
    this.u = u8; this.dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength); this.le = le; this.p = 0;
  }
  Reader.prototype.u8 = function () { return this.u[this.p++]; };
  Reader.prototype.u16 = function () { var v = this.dv.getUint16(this.p, this.le); this.p += 2; return v; };
  Reader.prototype.u32 = function () { var v = this.dv.getUint32(this.p, this.le); this.p += 4; return v; };
  Reader.prototype.u64 = function () { var lo = this.dv.getUint32(this.p + (this.le ? 0 : 4), this.le), hi = this.dv.getUint32(this.p + (this.le ? 4 : 0), this.le); this.p += 8; return hi * 4294967296 + lo; };
  Reader.prototype.uleb = function () {
    var r = 0, mul = 1, b;
    do { b = this.u[this.p++]; r += (b & 0x7f) * mul; mul *= 128; } while (b & 0x80);
    return r;
  };
  Reader.prototype.sleb = function () {
    var r = 0, mul = 1, b;
    do { b = this.u[this.p++]; r += (b & 0x7f) * mul; mul *= 128; } while (b & 0x80);
    return (b & 0x40) ? r - mul : r;
  };
  Reader.prototype.cstr = function () { var s = cstr(this.u, this.p); var e = this.p; while (this.u[e] !== 0 && e < this.u.length) { e++; } this.p = e + 1; return s; };
  Reader.prototype.addrN = function (n) {
    var v = 0n;
    for (var i = 0; i < n; i++) { v |= BigInt(this.u[this.p + (this.le ? i : n - 1 - i)]) << BigInt(8 * i); }
    this.p += n; return v;
  };

  var DW_FORM = { string: 0x08, line_strp: 0x1f, strp: 0x0e, udata: 0x0f, data1: 0x0b, data2: 0x05, data4: 0x06, data8: 0x07, data16: 0x1e, block: 0x09, sdata: 0x0d, strx: 0x1a };

  function readForm(r, form, is64, strs) {
    switch (form) {
      case DW_FORM.string: return r.cstr();
      case DW_FORM.line_strp: case DW_FORM.strp: {
        var off = is64 ? r.u64() : r.u32(), sec = form === DW_FORM.line_strp ? strs.line_str : strs.str;
        return sec ? cstr(sec, off) : '<' + (form === DW_FORM.line_strp ? '.debug_line_str' : '.debug_str') + ' missing>';
      }
      case DW_FORM.udata: return r.uleb();
      case DW_FORM.sdata: return r.sleb();
      case DW_FORM.data1: return r.u8();
      case DW_FORM.data2: return r.u16();
      case DW_FORM.data4: return r.u32();
      case DW_FORM.data8: return r.u64();
      case DW_FORM.data16: r.p += 16; return null;
      case DW_FORM.block: { var n = r.uleb(); r.p += n; return null; }
      default: throw new Error('unsupported DW_FORM 0x' + form.toString(16) + ' in the .debug_line header');
    }
  }
  function readEntryTable(r, is64, strs) {
    var fc = r.u8(), fmt = [], i;
    for (i = 0; i < fc; i++) { fmt.push([r.uleb(), r.uleb()]); }
    var cnt = r.uleb(), out = [];
    for (i = 0; i < cnt; i++) {
      var e = { name: '', dir: 0 };
      for (var k = 0; k < fmt.length; k++) {
        var v = readForm(r, fmt[k][1], is64, strs);
        if (fmt[k][0] === 1) { e.name = v; } else if (fmt[k][0] === 2) { e.dir = v; }
      }
      out.push(e);
    }
    return out;
  }
  function joinPath(dir, name) {
    if (!name) { return ''; }
    if (name[0] === '/' || /^[A-Za-z]:[\\/]/.test(name) || !dir) { return name; }
    return dir.replace(/\/+$/, '') + '/' + name;
  }

  // One pass over .debug_line. `queries` are BigInt addresses; the answer for each is the row in force at that address (the last row whose address <= it
  // inside a sequence that covers it). Rows are only kept per sequence, so memory stays small however big the section is.
  function scanLines(u8, le, queries, strs, opts) {
    opts = opts || {};
    var r = new Reader(u8, le), res = new Map(), left = queries.length, stats = { units: 0, versions: {}, sequences: 0, vliw: false }, qmin = null, qmax = null;
    queries.forEach(function (q) { if (qmin === null || q < qmin) { qmin = q; } if (qmax === null || q > qmax) { qmax = q; } });
    while (r.p + 4 <= u8.length && left > 0) {
      var unitStart = r.p, len = r.u32(), is64 = false;
      if (len === 0xffffffff) { is64 = true; len = r.u64(); }
      var end = r.p + len;
      if (len === 0 || end > u8.length) { break; }
      var ver = r.u16();
      if (ver < 2 || ver > 5) { throw new Error('unsupported .debug_line version ' + ver + ' (unit at 0x' + unitStart.toString(16) + ')'); }
      stats.units++; stats.versions[ver] = (stats.versions[ver] || 0) + 1;
      var addrSize = 0;
      if (ver >= 5) { addrSize = r.u8(); r.u8(); }
      var hdrLen = is64 ? r.u64() : r.u32(), prog = r.p + hdrLen;
      var minInst = r.u8(), maxOps = ver >= 4 ? r.u8() : 1, defStmt = r.u8() !== 0, lineBase = r.u8(); if (lineBase > 127) { lineBase -= 256; }
      var lineRange = r.u8(), opBase = r.u8(), stdLens = [], i;
      for (i = 1; i < opBase; i++) { stdLens[i] = r.u8(); }
      var dirs = [], files = [];
      if (ver >= 5) {
        dirs = readEntryTable(r, is64, strs).map(function (e) { return e.name; });
        files = readEntryTable(r, is64, strs);
      } else {
        dirs = [''];
        for (var s; (s = r.cstr()) !== '';) { dirs.push(s); }
        files = [null];
        for (var nm; (nm = r.cstr()) !== '';) { var d = r.uleb(); r.uleb(); r.uleb(); files.push({ name: nm, dir: d }); }
      }
      if (maxOps > 1) { stats.vliw = true; }
      r.p = prog;
      var fileInfo = function (idx) {
        var f = files[idx];
        if (!f) { return { file: '', name: '', dir: '' }; }
        var dir = dirs[f.dir] || '';
        return { file: joinPath(dir, f.name), name: f.name, dir: dir };
      };

      // state machine
      var seg = null;
      var newSeg = function (base) { seg = { base: base, rel: [], file: [], line: [], col: [], stmt: [], end: -1 }; };
      var flush = function () {
        if (seg && seg.rel.length) {
          var endRel = seg.end >= 0 ? seg.end : seg.rel[seg.rel.length - 1];
          stats.sequences++;
          if (!(qmax < seg.base || qmin > seg.base + BigInt(endRel))) {
            for (var qi = 0; qi < queries.length; qi++) {
              var q = queries[qi], key = q.toString();
              if (res.has(key) && !opts.keepAll) { continue; }
              if (q < seg.base) { continue; }
              var rel = Number(q - seg.base);
              if (rel > endRel || (seg.end >= 0 && rel >= seg.end)) { continue; }
              // the last row with address <= rel (among rows at the same address the last one is the one in force, as addr2line does)
              var lo = 0, hi = seg.rel.length - 1, at = -1;
              while (lo <= hi) { var mid = (lo + hi) >> 1; if (seg.rel[mid] <= rel) { at = mid; lo = mid + 1; } else { hi = mid - 1; } }
              if (at < 0) { continue; }
              var pick = at;
              var fi = fileInfo(seg.file[pick]);
              res.set(key, { file: fi.file, name: fi.name, dir: fi.dir, line: seg.line[pick], col: seg.col[pick], isStmt: seg.stmt[pick], rowAddr: (seg.base + BigInt(seg.rel[pick])).toString(16) });
              left--;
            }
          }
        }
        seg = null;
      };
      var rel = 0, file = 1, line = 1, col = 0, stmt = defStmt;
      var emit = function () { if (!seg) { newSeg(0n); } seg.rel.push(rel); seg.file.push(file); seg.line.push(line); seg.col.push(col); seg.stmt.push(stmt); };
      var reset = function () { rel = 0; file = 1; line = 1; col = 0; stmt = defStmt; };
      reset();
      while (r.p < end && left > 0) {
        var op = r.u8();
        if (op >= opBase) {
          var adj = op - opBase;
          rel += Math.floor(adj / lineRange) * minInst; line += lineBase + (adj % lineRange);
          emit();
        } else if (op === 0) {
          var elen = r.uleb(), estart = r.p, sub = r.u8();
          if (sub === 1) { emit(); if (seg) { seg.end = rel; } flush(); reset(); }
          else if (sub === 2) {
            var a = r.addrN(elen - 1);
            if (seg && seg.rel.length) { flush(); }
            newSeg(a); rel = 0;
          }
          r.p = estart + elen;
        } else {
          switch (op) {
            case 1: emit(); break;
            case 2: rel += r.uleb() * minInst; break;
            case 3: line += r.sleb(); break;
            case 4: file = r.uleb(); break;
            case 5: col = r.uleb(); break;
            case 6: stmt = !stmt; break;
            case 7: break;
            case 8: rel += Math.floor((255 - opBase) / lineRange) * minInst; break;
            case 9: rel += r.u16(); break;
            case 10: case 11: break;
            case 12: r.uleb(); break;
            default: for (var k = 0; k < (stdLens[op] || 0); k++) { r.uleb(); }
          }
        }
      }
      flush();
      r.p = end;
    }
    return { found: res, stats: stats };
  }

  Elf.prototype.linesAt = function (vaddrs) {
    var self = this, qs = vaddrs.map(toBig);
    if (!this.info.hasLines) { return Promise.resolve({ found: new Map(), stats: null, none: 'no .debug_line section' }); }
    return Promise.all([this.section('.debug_line'), this.section('.debug_line_str'), (this.byName['.debug_str'] && this.byName['.debug_str'].size < 96 * 1048576) ? this.section('.debug_str') : Promise.resolve(null)]).then(function (r) {
      if (!r[0]) { return { found: new Map(), stats: null, none: 'the .debug_line section is empty' }; }
      var out = scanLines(r[0], self.hdr.le, qs, { line_str: r[1], str: r[2] });
      return out;
    });
  };

  // ------------------------------------------------------------ frames -> addresses -> function / file:line
  function baseName(p) { return String(p || '').replace(/\\/g, '/').split('/').pop(); }
  function numOf(s) { return s ? BigInt(/^0x/i.test(s) ? s : '0x' + s) : null; }

  // "#3 0x55d3c2a4b171 (/path/prog+0x1171)" (sanitizer style) and "#3 0x... in ?? (/path/prog+0x1171)"
  function parseModuleFrames(text) {
    var out = [];
    String(text || '').replace(/\r/g, '').split('\n').forEach(function (raw, i) {
      var m = /^\s*#(\d+)\s+(0x[0-9a-fA-F]+)\s+(?:in\s+\S+\s+)?\((\S+?)\+(0x[0-9a-fA-F]+)\)(?:\s*\(BuildId:\s*[0-9a-fA-F]+\))?\s*$/.exec(raw);
      if (m) { out.push({ n: 0, line_no: i + 1, raw: raw.trim(), fmt: 'asan-mod', func: '', qual: '', file: '', line: 0, col: 0, addr: m[2], off: m[4], module: m[3], lib: '', modOff: true }); }
    });
    return out;
  }

  function buildIdCheck(elfId, stackId) {
    if (!elfId) { return { level: 'unknown', msg: '這個 ELF 沒有 .note.gnu.build-id：無法確認它就是出事的那一版，行號僅供參考。' }; }
    if (!stackId) { return { level: 'unknown', msg: '堆疊沒有 build-id（ELF 是 `' + elfId.slice(0, 16) + '…`）：無法確認 ELF 是出事的那一版，請自行確認。' }; }
    var n = Math.min(elfId.length, stackId.length);
    if (n >= 8 && elfId.slice(0, n) === stackId.slice(0, n)) { return { level: 'ok', msg: '✅ 堆疊的 build-id 與這個 ELF 相同（`' + elfId.slice(0, 16) + '…`）。' }; }
    return { level: 'bad', msg: '⚠️ build-id 不同：堆疊是 `' + stackId + '`，這個 ELF 是 `' + elfId + '`。ELF 不是出事的那一版，下面的函式與行號不可信。' };
  }

  function resolveFrames(elf, frames, versions, opts) {
    opts = opts || {};
    versions = versions || {};
    var notes = [], info = elf.info, elfBase = baseName(info.name);
    var dyn = info.type === 3;
    // which frames belong to this ELF?
    var mods = {};
    frames.forEach(function (f) { if (f.module && f.addr) { mods[baseName(f.module)] = (mods[baseName(f.module)] || 0) + 1; } });
    var modNames = Object.keys(mods), want = opts.module ? baseName(opts.module) : elfBase;
    var matched = modNames.indexOf(want) >= 0;
    if (!matched && !opts.module && modNames.length === 1) { want = modNames[0]; matched = true; notes.push('ELF 檔名（' + (elfBase || '未命名') + '）與堆疊裡唯一的模組（' + want + '）不同：假設就是它。若不是，請改用 `--module=名稱`。'); }
    if (!matched && modNames.length) { notes.push('堆疊裡的模組是 ' + modNames.join('、') + '，沒有一個叫 `' + (want || elfBase) + '`：沒有 frame 屬於這個 ELF（可用 `--module=名稱` 指定）。'); }
    var mine = function (f) { return f.addr && (f.module ? baseName(f.module) === want : !modNames.length || f.fmt === 'gdb' || f.fmt === 'asan'); };

    return Promise.all([elf.loadBuildId(), elf.loadSymbols()]).then(function (pre) {
      var bid = buildIdCheck(pre[0], versions.build_id);
      var cand = frames.filter(mine);
      // the load base of a PIE: user > derived from "func+off" frames > module offsets > "addresses already look unrelocated"
      var base = null, baseHow = '';
      var step = Promise.resolve();
      if (!dyn) { base = 0n; baseHow = 'ET_EXEC：位址就是連結位址，不需要載入基底'; }
      else if (opts.base !== undefined && opts.base !== null && opts.base !== '') { base = toBig(opts.base); baseHow = '使用者指定 base=' + hex(base); }
      else {
        var votes = {};
        step = cand.reduce(function (chain, f) {
          return chain.then(function () {
            var a = numOf(f.addr);
            if (f.fmt === 'glibc' && !f.func && f.off) { var b1 = a - numOf(f.off); votes[b1.toString()] = (votes[b1.toString()] || 0) + 1; return null; }
            if (f.modOff && f.off) { var b2 = a - numOf(f.off); votes[b2.toString()] = (votes[b2.toString()] || 0) + 1; return null; }
            if (f.fmt === 'glibc' && f.func && f.off) {
              return elf.symbolByName(f.func).then(function (s) { if (s) { var b3 = a - (BigInt(s.value) + numOf(f.off)); votes[b3.toString()] = (votes[b3.toString()] || 0) + 1; } });
            }
            return null;
          });
        }, Promise.resolve()).then(function () {
          var ks = Object.keys(votes).sort(function (x, y) { return votes[y] - votes[x]; });
          if (ks.length) {
            base = BigInt(ks[0]);
            baseHow = '由堆疊裡的「函式+偏移」／「模組+偏移」推算出載入基底 ' + hex(base) + '（' + votes[ks[0]] + ' 個 frame 一致' + (ks.length > 1 ? '，另有 ' + (ks.length - 1) + ' 種不一致的值，已採多數' : '') + '）';
            if (base % 4096n !== 0n) { notes.push('⚠️ 推算的載入基底 ' + hex(base) + ' 不是 4096 的倍數：可能是 ELF 與堆疊版本不同，或函式同名但不是同一個。'); }
          } else if (cand.length && info.hi !== null && cand.every(function (f) { var a = numOf(f.addr); return a >= info.lo && a < info.hi; })) {
            base = 0n; baseHow = '堆疊的位址都落在 ELF 的位址範圍內（' + hex(info.lo) + '–' + hex(info.hi) + '），假設是未重定位的位址（base=0）';
          }
        });
      }
      return step.then(function () {
        if (dyn && base === null && cand.length) { notes.push('這是 PIE／共享物件，但堆疊沒有可推算載入基底的資訊（沒有 `函式+偏移`、`模組+偏移`），位址無法直接對應：請用 `--base=0x…` 指定載入基底（gdb：`info proc mappings`；/proc/PID/maps 的第一段起點）。只能查符號名稱的 frame 仍會列出。'); }
        else if (baseHow) { notes.push('載入基底：' + baseHow + '。'); }
        // vaddr per frame
        var items = cand.map(function (f) {
          var a = numOf(f.addr), v = null, how = '', callsite = f.n > 1 && !opts.exact;
          if (f.modOff && f.off) { v = numOf(f.off); how = '模組偏移'; }
          else if (f.fmt === 'glibc' && !f.func && f.off) { v = numOf(f.off); how = '模組偏移'; }
          else if (base !== null) { v = a - base; how = base === 0n ? '位址' : '位址 − 載入基底'; }
          return { frame: f, n: f.n, addr: a, vaddr: v, how: how, callsite: callsite, status: 'none', notes: [] };
        });
        var look = function (it) { return it.vaddr === null ? null : (it.callsite && it.vaddr > 0n ? it.vaddr - 1n : it.vaddr); };
        return Promise.all(items.map(function (it) {
          var v = look(it);
          if (v === null) { it.notes.push('無法換算成 ELF 內的位址（缺載入基底）'); return null; }
          if (info.lo !== null && (v < info.lo || v >= info.hi)) { it.notes.push('位址 ' + hex(v) + ' 不在 ELF 的位址範圍內（' + hex(info.lo) + '–' + hex(info.hi) + '）：載入基底不對，或這個 frame 屬於別的模組'); it.vaddr = null; return null; }
          return elf.symbolAt(v).then(function (s) { it.sym = s; });
        })).then(function () {
          var qs = items.filter(function (it) { return it.vaddr !== null; }).map(look);
          return (qs.length ? elf.linesAt(qs) : Promise.resolve({ found: new Map(), stats: null })).then(function (L) {
            items.forEach(function (it) {
              if (it.vaddr === null) { return; }
              var v = look(it), s = it.sym, ln = L.found.get(v.toString());
              it.lookup = v;
              if (s) {
                it.func = s.func; it.raw = s.raw; it.symOff = Number(it.vaddr) - s.value; it.symSize = s.size; it.inside = s.inside;
                if (!s.inside) { it.notes.push('最近的符號 `' + s.func + '` 大小只有 ' + s.size + ' 位元組，這個位址超出它：符號僅供參考'); }
              }
              if (ln && ln.line) { it.file = ln.file; it.line = ln.line; it.col = ln.col; it.dir = ln.dir; it.status = 'line'; }
              else if (s) { it.status = 'symbol'; it.notes.push(L.none ? 'ELF 沒有行號資訊（' + L.none + '）：只有函式名稱與偏移' : '.debug_line 沒有涵蓋這個位址：只有函式名稱與偏移'); }
              else { it.status = 'none'; it.notes.push('ELF 的符號表與行號都沒有涵蓋這個位址'); }
            });
            var n = { line: 0, symbol: 0, none: 0 };
            items.forEach(function (it) { n[it.status]++; });
            if (!info.hasSymbols) { notes.push('這個 ELF 沒有符號表（已 strip）。'); }
            else if (!info.hasSymtab) { notes.push('這個 ELF 已 strip：沒有 `.symtab`，只剩動態符號（`.dynsym`，只含匯出的函式），static／內部函式查不到名字。'); }
            if (!info.hasLines) { notes.push('這個 ELF 沒有 `.debug_line`' + (info.debuglink ? '（有 `.gnu_debuglink`：除錯資訊另存在別的檔案，請改選那個 debuginfo ELF）' : '') + '：只能給函式名稱 + 偏移，沒有行號。'); }
            if (L.stats && L.stats.vliw) { notes.push('⚠️ 偵測到 maximum_operations_per_instruction > 1（VLIW）：op_index 沒有處理，行號可能不準。'); }
            if (items.some(function (it) { return it.callsite && it.status === 'line'; })) { notes.push('第 2 個之後的 frame 是「返回位址」，查表時用位址 − 1（落在呼叫指令那一行，而不是下一行）。'); }
            return { items: items, notes: notes, base: base, baseHow: baseHow, buildId: bid, module: want, counts: n, stats: L.stats, info: info };
          });
        });
      });
    });
  }

  // the ELF is the authority for func / file / line of the frames it could resolve
  function applyToFrames(rep) {
    rep.items.forEach(function (it) {
      var f = it.frame;
      f.elf = it;
      if (it.func) {
        var parts = it.func.split('::');
        f.func = parts.pop(); f.qual = parts.join('::');
        if (window_cleanFunc) { f.func = window_cleanFunc(f.func); }
      }
      if (it.status === 'line') { f.file = it.file; f.line = it.line; f.col = it.col || 0; }
    });
    return rep;
  }
  var window_cleanFunc = null;
  function setCleanFunc(fn) { window_cleanFunc = fn; }

  function reportLines(rep) {
    var L = ['**ELF 位址解析**（`' + (rep.info.name || '未命名') + '`，' + rep.info.bits + ' 位元 ' + rep.info.machineName + '，' + rep.info.typeName + '；' + (rep.info.hasLines ? '有' : '沒有') + '行號、' + (rep.info.hasSymbols ? '有' : '沒有') + '符號）', '', rep.buildId.msg];
    rep.notes.forEach(function (n) { L.push(n); });
    L.push('');
    if (!rep.items.length) { L.push('沒有任何 frame 對應到這個 ELF。'); }
    rep.items.forEach(function (it) {
      var where = it.status === 'line' ? '`' + it.file + ':' + it.line + (it.col ? ':' + it.col : '') + '`' : it.status === 'symbol' ? '（沒有行號）' : '（解不出）';
      var sym = it.func ? '`' + it.func + '+' + hex(it.symOff) + '`' : '';
      L.push('- **#' + it.n + '** ' + hex(it.addr) + (it.vaddr !== null ? ' → ELF 位址 ' + hex(it.vaddr) : '') + ' ' + sym + ' ' + where + (it.notes.length ? ' — ' + it.notes.join('；') : ''));
    });
    return L;
  }

  var api = { open: openElf, resolveFrames: resolveFrames, applyToFrames: applyToFrames, parseModuleFrames: parseModuleFrames, reportLines: reportLines, buildIdCheck: buildIdCheck, demangle: demangle, scanLines: scanLines, setCleanFunc: setCleanFunc };
  try { var Tr = typeof FaAidocTrace !== 'undefined' ? FaAidocTrace : root.FaAidocTrace; if (Tr && Tr.cleanFunc) { setCleanFunc(Tr.cleanFunc); } } catch (e) { /* trace module not loaded: the plain name is used */ }
  return api;
});
