// src/fs.mjs
var ERRNO = {
  EPERM: 1,
  ENOENT: 2,
  EIO: 5,
  EBADF: 9,
  EAGAIN: 11,
  ENOMEM: 12,
  EACCES: 13,
  EBUSY: 16,
  EEXIST: 17,
  EXDEV: 18,
  ENOTDIR: 20,
  EISDIR: 21,
  EINVAL: 22,
  ENFILE: 23,
  EMFILE: 24,
  EFBIG: 27,
  ENOSPC: 28,
  ESPIPE: 29,
  EROFS: 30,
  EMLINK: 31,
  EPIPE: 32,
  ENAMETOOLONG: 36,
  ENOSYS: 38,
  ENOTEMPTY: 39,
  ELOOP: 40
};
function fsError(code, path) {
  const err = new Error(path === void 0 ? code : `${code}: ${path}`);
  err.code = code;
  err.errno = ERRNO[code];
  if (path !== void 0) err.path = path;
  return err;
}
var S_IFMT = 61440;
var S_IFDIR = 16384;
var S_IFREG = 32768;
var S_IFCHR = 8192;
var isDir = (mode) => (mode & S_IFMT) === S_IFDIR;
var isChar = (mode) => (mode & S_IFMT) === S_IFCHR;
var DEFAULT_DIR_MODE = 493;
var DEFAULT_FILE_MODE = 420;
var ENC = new TextEncoder();
var EMPTY = new Uint8Array(0);
function normalize(path) {
  const parts = String(path).split("/").filter((x) => x && x !== ".");
  const stack = [];
  for (const part of parts) {
    if (part === "..") stack.pop();
    else stack.push(part);
  }
  return "/" + stack.join("/");
}
var parentOf = (path) => {
  const i = path.lastIndexOf("/");
  return i > 0 ? path.slice(0, i) : "/";
};
var baseOf = (path) => path.slice(path.lastIndexOf("/") + 1);
function memoryFs(files = {}) {
  return new MemoryFs(files);
}
var MemoryFs = class {
  constructor(files = {}) {
    this.nodes = /* @__PURE__ */ new Map();
    this.nextIno = 2;
    this.nodes.set("/", this.#dirNode(1));
    this.mkdirSync("/tmp");
    for (const [path, content] of Object.entries(files)) this.#seed(path, content);
  }
  // ---- construction helpers ----
  // An empty directory starts at nlink 2 (its name and its own '.'); every
  // subdirectory adds one for its '..'. Some tools stop descending once they
  // have seen nlink-2 subdirectories, so a constant 2 hides a whole subtree —
  // the same shape of bug as a constant ino.
  #dirNode(ino, mode = DEFAULT_DIR_MODE) {
    const now = Date.now();
    return {
      ino,
      nlink: 2,
      mode: S_IFDIR | mode & 4095,
      uid: 0,
      gid: 0,
      children: /* @__PURE__ */ new Set(),
      atimeMs: now,
      mtimeMs: now,
      ctimeMs: now,
      birthtimeMs: now
    };
  }
  #fileNode(ino, data, mutable, mode = DEFAULT_FILE_MODE) {
    const now = Date.now();
    return {
      ino,
      nlink: 1,
      mode: S_IFREG | mode & 4095,
      uid: 0,
      gid: 0,
      data,
      mutable,
      atimeMs: now,
      mtimeMs: now,
      ctimeMs: now,
      birthtimeMs: now
    };
  }
  // Mount one seed file, synthesizing its parent directories. `mutable: false`
  // marks the caller's buffer as borrowed — the first write copies it.
  #seed(path, content) {
    const abs = normalize(path.startsWith("/") ? path : `/${path}`);
    const segments = abs.split("/").filter(Boolean);
    let dir = "";
    for (let i = 0; i < segments.length - 1; i++) {
      dir = `${dir}/${segments[i]}`;
      const existing = this.#node(dir);
      if (!existing) this.mkdirSync(dir);
      else if (!isDir(existing.mode)) throw fsError("ENOTDIR", dir);
    }
    const clash = this.#node(abs);
    if (clash) {
      if (isDir(clash.mode)) throw fsError("EISDIR", abs);
      this.#detach(abs, clash);
      this.nodes.delete(abs);
    }
    let data, owned = true;
    if (typeof content === "string") data = ENC.encode(content);
    else if (ArrayBuffer.isView(content) || content instanceof ArrayBuffer) {
      data = ArrayBuffer.isView(content) ? new Uint8Array(content.buffer, content.byteOffset, content.byteLength) : new Uint8Array(content);
      owned = false;
    } else data = new Uint8Array(content ?? 0);
    const node = this.#fileNode(this.nextIno++, data, owned);
    this.nodes.set(abs, node);
    this.#attach(abs, node);
  }
  // ---- internals ----
  // An empty path is ENOENT, not the root: normalize('') collapses to '/', and
  // POSIX has never let '' name anything.
  #node(path) {
    return path === "" ? null : this.nodes.get(normalize(path)) ?? null;
  }
  #require(path) {
    const node = this.#node(path);
    if (!node) throw fsError("ENOENT", path);
    return node;
  }
  #requireDir(path) {
    const node = this.#require(path);
    if (!isDir(node.mode)) throw fsError("ENOTDIR", path);
    return node;
  }
  // A file about to be modified in place: seeded buffers are borrowed, so the
  // first write takes a private copy.
  #writable(node) {
    if (!node.mutable) {
      node.data = node.data.slice();
      node.mutable = true;
    }
    return node;
  }
  // Adding and removing a name are the only two places a directory's child
  // list, its nlink and its mtime change — kept together so they cannot drift.
  // A directory that gains an entry has been MODIFIED: leaving its mtime alone
  // is what makes a listing cache miss a deletion.
  #attach(abs, node) {
    const parent = this.#node(parentOf(abs));
    if (!parent || abs === "/") return;
    parent.children.add(baseOf(abs));
    if (isDir(node.mode)) parent.nlink++;
    this.#touched(parent);
  }
  #detach(abs, node) {
    const parent = this.#node(parentOf(abs));
    if (!parent || abs === "/") return;
    parent.children.delete(baseOf(abs));
    if (isDir(node.mode)) parent.nlink--;
    this.#touched(parent);
  }
  #touched(node, now = Date.now()) {
    node.mtimeMs = now;
    node.ctimeMs = now;
  }
  #stat(node) {
    return {
      ino: node.ino,
      nlink: node.nlink,
      size: node.data ? node.data.length : 0,
      mode: node.mode,
      uid: node.uid,
      gid: node.gid,
      atimeMs: node.atimeMs,
      mtimeMs: node.mtimeMs,
      ctimeMs: node.ctimeMs,
      birthtimeMs: node.birthtimeMs
    };
  }
  // ---- the contract ----
  statSync(path) {
    return this.#stat(this.#require(path));
  }
  readdirSync(path) {
    return [...this.#requireDir(path).children];
  }
  createFileSync(path, options = {}) {
    const abs = normalize(path);
    if (this.nodes.has(abs)) throw fsError("EEXIST", path);
    this.#requireDir(parentOf(abs));
    const node = this.#fileNode(this.nextIno++, EMPTY, false, options.mode ?? DEFAULT_FILE_MODE);
    if (options.uid !== void 0) node.uid = options.uid;
    if (options.gid !== void 0) node.gid = options.gid;
    this.nodes.set(abs, node);
    this.#attach(abs, node);
    return this.#stat(node);
  }
  mkdirSync(path, options = {}) {
    const abs = normalize(path);
    if (this.nodes.has(abs)) throw fsError("EEXIST", path);
    this.#requireDir(parentOf(abs));
    const node = this.#dirNode(this.nextIno++, options.mode ?? DEFAULT_DIR_MODE);
    this.nodes.set(abs, node);
    this.#attach(abs, node);
    return this.#stat(node);
  }
  rmdirSync(path) {
    const abs = normalize(path);
    const node = this.#requireDir(abs);
    if (abs === "/") throw fsError("EBUSY", path);
    if (node.children.size) throw fsError("ENOTEMPTY", path);
    this.nodes.delete(abs);
    this.#detach(abs, node);
  }
  unlinkSync(path) {
    const abs = normalize(path);
    const node = this.#require(abs);
    if (isDir(node.mode)) throw fsError("EISDIR", path);
    node.nlink--;
    node.ctimeMs = Date.now();
    this.nodes.delete(abs);
    this.#detach(abs, node);
  }
  renameSync(from, to) {
    const src = normalize(from), dst = normalize(to);
    const node = this.#require(src);
    this.#requireDir(parentOf(dst));
    if (src === dst) return;
    if (src === "/") throw fsError("EBUSY", from);
    if (isDir(node.mode) && dst.startsWith(`${src}/`)) throw fsError("EINVAL", to);
    const existing = this.#node(dst);
    if (existing) {
      if (isDir(existing.mode)) {
        if (!isDir(node.mode)) throw fsError("EISDIR", to);
        if (existing.children.size) throw fsError("ENOTEMPTY", to);
      } else if (isDir(node.mode)) throw fsError("ENOTDIR", to);
      existing.nlink--;
      this.nodes.delete(dst);
      this.#detach(dst, existing);
    }
    if (isDir(node.mode)) {
      const prefix = `${src}/`;
      for (const key of [...this.nodes.keys()]) {
        if (!key.startsWith(prefix)) continue;
        this.nodes.set(dst + key.slice(src.length), this.nodes.get(key));
        this.nodes.delete(key);
      }
    }
    this.#detach(src, node);
    this.nodes.delete(src);
    this.nodes.set(dst, node);
    this.#attach(dst, node);
    node.ctimeMs = Date.now();
  }
  linkSync(target, link) {
    const src = normalize(target), dst = normalize(link);
    const node = this.#require(src);
    if (isDir(node.mode)) throw fsError("EPERM", target);
    if (this.nodes.has(dst)) throw fsError("EEXIST", link);
    this.#requireDir(parentOf(dst));
    node.nlink++;
    node.ctimeMs = Date.now();
    this.nodes.set(dst, node);
    this.#attach(dst, node);
  }
  readSync(path, buffer, start, end) {
    const node = this.#require(path);
    if (isDir(node.mode)) throw fsError("EISDIR", path);
    const slice = node.data.subarray(start, end);
    const taken = Math.min(slice.length, buffer.length);
    buffer.set(slice.subarray(0, taken), 0);
    if (taken < buffer.length) buffer.fill(0, taken);
    node.atimeMs = Date.now();
  }
  writeSync(path, buffer, offset) {
    const node = this.#require(path);
    if (isDir(node.mode)) throw fsError("EISDIR", path);
    this.#writable(node);
    const end = offset + buffer.length;
    if (end > node.data.length) {
      const grown = new Uint8Array(end);
      grown.set(node.data, 0);
      node.data = grown;
    }
    node.data.set(buffer, offset);
    this.#touched(node);
  }
  // chmod, chown, utimes and truncate, all in one call — `metadata` is a
  // partial InodeLike and only the fields present apply.
  touchSync(path, metadata = {}) {
    const node = this.#require(path);
    if (metadata.size !== void 0 && !isDir(node.mode)) {
      const size = metadata.size;
      if (size !== node.data.length) {
        const next = new Uint8Array(size);
        next.set(node.data.subarray(0, Math.min(size, node.data.length)), 0);
        node.data = next;
        node.mutable = true;
      } else {
        this.#writable(node);
      }
      this.#touched(node);
    }
    if (metadata.mode !== void 0) node.mode = node.mode & S_IFMT | metadata.mode & 4095;
    if (metadata.uid !== void 0) node.uid = metadata.uid;
    if (metadata.gid !== void 0) node.gid = metadata.gid;
    if (metadata.atimeMs !== void 0) node.atimeMs = metadata.atimeMs;
    if (metadata.mtimeMs !== void 0) node.mtimeMs = metadata.mtimeMs;
    node.ctimeMs = metadata.ctimeMs !== void 0 ? metadata.ctimeMs : Date.now();
  }
  syncSync() {
  }
  // nothing behind memory to flush
};
var J_WORDS = 8;
var J_HEADER_BYTES = J_WORDS * 4;
var J_ERR_BYTES = 512;
var J_PREFIX = J_HEADER_BYTES + J_ERR_BYTES;
var J_DEFAULT_BYTES = 1 << 20;
var J_DEC = new TextDecoder();

// src/shim.mjs
var WasiExit = class extends Error {
  constructor(code) {
    super("exit " + code);
    this.code = code;
  }
};
var NEW_FILE = Object.freeze({ mode: DEFAULT_FILE_MODE, uid: 0, gid: 0 });
var NEW_DIR = Object.freeze({ mode: DEFAULT_DIR_MODE, uid: 0, gid: 0 });
var ENC2 = new TextEncoder();
var DEC = new TextDecoder();
var EMPTY2 = new Uint8Array(0);
var errnoName = (n) => Object.keys(E).find((k) => E[k] === n) || String(n);
var E = { SUCCESS: 0, BADF: 8, EXIST: 20, INTR: 27, INVAL: 28, IO: 29, ISDIR: 31, NOENT: 44, NOSPC: 51, NOSYS: 52, NOTDIR: 54, NOTEMPTY: 55, PERM: 63, NOTCAPABLE: 76, AGAIN: 6, SPIPE: 70 };
var FT = { CHAR: 2, DIR: 3, REG: 4 };
var WASI_ERRNO = {
  EPERM: 63,
  ENOENT: 44,
  EIO: 29,
  EBADF: 8,
  EACCES: 2,
  EBUSY: 10,
  EEXIST: 20,
  EXDEV: 75,
  ENOTDIR: 54,
  EISDIR: 31,
  EINVAL: 28,
  ENFILE: 41,
  EMFILE: 33,
  ENOSPC: 51,
  EROFS: 69,
  EMLINK: 34,
  ENOSYS: 52,
  ENOTEMPTY: 55,
  ELOOP: 32,
  ENAMETOOLONG: 37,
  EAGAIN: 6,
  ENOMEM: 48,
  EFBIG: 22,
  ESPIPE: 70,
  EPIPE: 64
};
var wasiErrno = (err) => WASI_ERRNO[err && err.code] ?? E.IO;
var DEV_DEV = 2n;
var DEV_DIR_INO = 1;
var DEV_NULL = { read: () => EMPTY2, write: () => {
} };
var devRead = (r) => typeof r === "number" ? { data: EMPTY2, errno: r } : { data: r || EMPTY2, errno: 0 };
var HOST_LINE_MAX = 1 << 20;
var HOST_QUEUE_MAX = 1 << 24;
var WasiShim = class {
  constructor({ args = ["busybox"], env = {}, files = {}, fs, stdout, stderr, input, builtins, host, requests }) {
    this.args = args;
    this.env = Object.entries(env).map(([k, v]) => `${k}=${v}`);
    this.stdout = stdout || (() => {
    });
    this.stderr = stderr || this.stdout;
    this.input = input;
    this.builtins = builtins;
    this.host = host;
    this.requests = requests;
    this.mem = null;
    this.view = null;
    this.u8 = null;
    for (const path of Object.keys(files || {})) {
      const abs = normalize(path.startsWith("/") ? path : `/${path}`);
      if (ownsDevPath(abs)) throw new Error(`files: '${abs}' is under /dev, which is the shim's device overlay \u2014 the file would be mounted and then hidden by it`);
    }
    this.store = fs || memoryFs(files);
    if (fs) seedInto(this.store, files);
    this.bootMs = Date.now();
    this.devices = /* @__PURE__ */ new Map();
    this.nextDevIno = DEV_DIR_INO + 1;
    this.addDevice("/dev/null", DEV_NULL);
    this.addDevice("/dev/host", this.hostDevice());
    this.addDevice("/dev/hostreq", this.requestDevice());
    this.fds = /* @__PURE__ */ new Map();
    this.fds.set(0, { type: "stdin" });
    this.fds.set(1, { type: "stdout" });
    this.fds.set(2, { type: "stderr" });
    this.fds.set(3, { type: "dir", path: "/", preopen: true });
    this.nextFd = 4;
    this.pipes = [];
  }
  bindMemory(memory) {
    this.mem = memory;
    this.refresh();
  }
  refresh() {
    this.view = new DataView(this.mem.buffer);
    this.u8 = new Uint8Array(this.mem.buffer);
  }
  dv() {
    if (this.view.buffer !== this.mem.buffer) this.refresh();
    return this.view;
  }
  bytes() {
    if (this.u8.buffer !== this.mem.buffer) this.refresh();
    return this.u8;
  }
  imports() {
    const w = this;
    const p1 = {
      args_sizes_get: (cnt, sz) => {
        const b = w.args.map(strBytes);
        w.dv().setUint32(cnt, b.length, true);
        w.dv().setUint32(sz, b.reduce((a, x) => a + x.length + 1, 0), true);
        return 0;
      },
      args_get: (av, buf) => {
        let p = buf;
        for (const a of w.args.map(strBytes)) {
          w.dv().setUint32(av, p, true);
          av += 4;
          w.bytes().set(a, p);
          p += a.length;
          w.bytes()[p++] = 0;
        }
        return 0;
      },
      environ_sizes_get: (cnt, sz) => {
        const b = w.env.map(strBytes);
        w.dv().setUint32(cnt, b.length, true);
        w.dv().setUint32(sz, b.reduce((a, x) => a + x.length + 1, 0), true);
        return 0;
      },
      environ_get: (ev, buf) => {
        let p = buf;
        for (const a of w.env.map(strBytes)) {
          w.dv().setUint32(ev, p, true);
          ev += 4;
          w.bytes().set(a, p);
          p += a.length;
          w.bytes()[p++] = 0;
        }
        return 0;
      },
      // Clock 0 is REALTIME (wall clock); 1/2/3 (monotonic, cputimes) must
      // never step backwards, which Date.now() can — use performance.now().
      clock_time_get: (id, prec, out) => {
        const ns = BigInt(Math.round((id === 0 ? Date.now() : performance.now()) * 1e6));
        w.dv().setBigUint64(out, ns, true);
        return 0;
      },
      // The one unambiguous flush point. A store that buffers — anything
      // persistent — has nowhere else to learn the run is over, and a failure
      // here is data loss, so it is reported rather than swallowed. It must
      // not replace the exit: the caller is waiting for a WasiExit.
      proc_exit: (code) => {
        try {
          w.store.syncSync();
        } catch (e) {
          w.stderr(strBytes(`wasi-sh: flushing the filesystem failed: ${e && e.message || e}
`));
        }
        throw new WasiExit(code);
      },
      sched_yield: () => 0,
      random_get: (buf, len) => {
        const a = w.bytes().subarray(buf, buf + len);
        if (globalThis.crypto && globalThis.crypto.getRandomValues) {
          for (let o = 0; o < len; o += 65536) globalThis.crypto.getRandomValues(a.subarray(o, Math.min(o + 65536, len)));
        } else {
          for (let i = 0; i < len; i++) a[i] = Math.random() * 256 | 0;
        }
        return 0;
      },
      fd_close: (fd) => {
        const f = w.fds.get(fd);
        w.fds.delete(fd);
        if (f && f.type === "pipe") w.gcPipe(f.pipe);
        return 0;
      },
      fd_fdstat_get: (fd, out) => {
        const f = w.fds.get(fd);
        if (!f) return E.BADF;
        const ft = f.type === "dir" ? FT.DIR : f.type === "file" ? FT.REG : FT.CHAR;
        w.dv().setUint8(out, ft);
        w.dv().setUint16(out + 2, 0, true);
        w.dv().setBigUint64(out + 8, ~0n, true);
        w.dv().setBigUint64(out + 16, ~0n, true);
        return 0;
      },
      fd_fdstat_set_flags: (fd, flags) => {
        const f = w.fds.get(fd);
        if (f) f.nonblock = (flags & 4) !== 0;
        return 0;
      },
      fd_prestat_get: (fd, out) => {
        const f = w.fds.get(fd);
        if (!f || !f.preopen) return E.BADF;
        w.dv().setUint8(out, 0);
        w.dv().setUint32(out + 4, strBytes(f.path).length, true);
        return 0;
      },
      fd_prestat_dir_name: (fd, buf, len) => {
        const f = w.fds.get(fd);
        if (!f || !f.preopen) return E.BADF;
        w.bytes().set(strBytes(f.path).subarray(0, len), buf);
        return 0;
      },
      fd_filestat_get: (fd, out) => {
        const f = w.fds.get(fd);
        if (!f) return E.BADF;
        const st = !f.gone && f.path !== void 0 && w.statAt(f.path) || w.anonStat(f);
        w.writeFilestat(out, st);
        return 0;
      },
      path_filestat_get: (fd, flags, pathp, plen, out) => {
        const { st, errno } = w.statOf(w.resolve(fd, w.str(pathp, plen)));
        if (!st) return errno;
        w.writeFilestat(out, st);
        return 0;
      },
      path_open: (fd, dflags, pathp, plen, oflags, rb, ri, fdflags, out) => {
        const path = w.resolve(fd, w.str(pathp, plen));
        let { st, errno } = w.statOf(path);
        if (!st) {
          if (!(oflags & 1)) return errno;
          if (w.ownsPath(path)) return E.PERM;
          try {
            st = w.store.createFileSync(path, NEW_FILE);
          } catch (e) {
            return wasiErrno(e);
          }
        } else if (oflags & 1 && oflags & 4) return E.EXIST;
        const device = w.devices.get(path);
        if (device && device.open) {
          const e = device.open();
          if (e) return e;
        }
        if (!device && !isDir(st.mode) && oflags & 8) {
          try {
            w.store.touchSync(path, { size: 0 });
          } catch (e) {
            return wasiErrno(e);
          }
        }
        const nfd = w.nextFd++;
        if (isDir(st.mode)) w.fds.set(nfd, { type: "dir", path });
        else w.fds.set(nfd, { type: "file", path, device, pos: { v: 0 }, append: (fdflags & 1) !== 0 });
        w.dv().setUint32(out, nfd, true);
        return 0;
      },
      // fd_read/fd_write are the iovec scatter/gather around readFd/writeFd —
      // the per-fd-type routing lives there so host builtins can reach it too
      // (see the __host_builtin_run hook and the readFd/writeFd comments).
      fd_read: (fd, iovs, n, out) => {
        const f = w.fds.get(fd);
        if (!f) return E.BADF;
        const bufs = w.iovecs(iovs, n);
        const { data, errno } = w.readFd(fd, bufs.reduce((a, b) => a + b.length, 0), f.nonblock);
        let o = 0;
        for (const b of bufs) {
          const take = Math.min(b.length, data.length - o);
          b.set(data.subarray(o, o + take));
          o += take;
          if (o >= data.length) break;
        }
        w.dv().setUint32(out, o, true);
        return errno;
      },
      // A failing writeFd used to be impossible past the BADF check, so its
      // return value was dropped. A store can genuinely refuse — read-only,
      // out of space, a revoked directory handle — and reporting those bytes
      // as written is silent data loss. Stop at the failure and report the
      // count that did land, exactly as a short write(2) does.
      fd_write: (fd, iovs, n, out) => {
        const f = w.fds.get(fd);
        if (!f) return E.BADF;
        const bufs = w.iovecs(iovs, n);
        if (f.device) {
          const b = bufs.length === 1 ? bufs[0] : joinBytes(bufs);
          if (!b.length) {
            w.dv().setUint32(out, 0, true);
            return 0;
          }
          const errno = w.writeFd(fd, b);
          w.dv().setUint32(out, errno ? 0 : b.length, true);
          return errno;
        }
        let total = 0;
        for (const b of bufs) {
          const errno = w.writeFd(fd, b);
          if (!errno) {
            total += b.length;
            continue;
          }
          w.dv().setUint32(out, total, true);
          return total ? 0 : errno;
        }
        w.dv().setUint32(out, total, true);
        return 0;
      },
      // An unseekable fd is ESPIPE, as lseek says. A pipe keeps its offset on
      // the pipe object and the stdin ring has none, so moving their cell was
      // invisible — but SUCCESS is not: lseek() is how a program asks whether
      // an fd can seek, and stdio calls it when it gives back a buffered read
      // (the applet drain in build/ash-forkfree.patch). A file redirected onto
      // fd 0 is a file, not the ring — dup2 copies the record — so `head -1 <
      // f` still seeks.
      // A negative result is EINVAL and leaves the offset alone, as lseek does.
      // Without the check a rewind past the start makes every later read ask
      // the store for a range it will zero-fill, and the guest gets fabricated
      // NUL bytes reported as a successful read.
      fd_seek: (fd, off, whence, out) => {
        const f = w.fds.get(fd);
        if (!f) return E.BADF;
        if (f.type === "pipe" || f.type === "stdin" || f.type === "stdout" || f.type === "stderr") return E.SPIPE;
        const p = w.pos(f);
        const sz = w.sizeOf(f);
        off = Number(off);
        const next = whence === 0 ? off : whence === 1 ? p.v + off : sz + off;
        if (!Number.isFinite(next) || next < 0) return E.INVAL;
        p.v = next;
        w.dv().setBigUint64(out, BigInt(p.v), true);
        return 0;
      },
      fd_readdir: (fd, buf, len, cookie, out) => {
        const f = w.fds.get(fd);
        if (!f || f.type !== "dir") return E.BADF;
        let ents;
        try {
          ents = w.readdirAt(f.path);
        } catch (e) {
          return wasiErrno(e);
        }
        let p = buf;
        let idx = Number(cookie);
        let written = 0;
        for (; idx < ents.length; idx++) {
          const name = ents[idx];
          const nb = strBytes(name);
          const child = w.statAt(joinPath(f.path, name));
          const need = 24 + nb.length;
          if (p + need > buf + len) break;
          w.dv().setBigUint64(p, BigInt(idx + 1), true);
          w.dv().setBigUint64(p + 8, BigInt(child ? child.ino : 0), true);
          w.dv().setUint32(p + 16, nb.length, true);
          w.dv().setUint8(p + 20, child && isDir(child.mode) ? FT.DIR : FT.REG);
          w.bytes().set(nb, p + 24);
          p += need;
          written += need;
        }
        w.dv().setUint32(out, written, true);
        return 0;
      },
      // ---- writable-FS ops (rm/mkdir/rmdir/mv and friends) ----
      path_unlink_file: (fd, pathp, plen) => w.removeNode(w.resolve(fd, w.str(pathp, plen)), false),
      path_remove_directory: (fd, pathp, plen) => w.removeNode(w.resolve(fd, w.str(pathp, plen)), true),
      path_create_directory: (fd, pathp, plen) => w.makeDir(w.resolve(fd, w.str(pathp, plen))),
      path_rename: (fd, pathp, plen, nfd, npathp, nplen) => {
        const from = w.resolve(fd, w.str(pathp, plen)), to = w.resolve(nfd, w.str(npathp, nplen));
        const { st, errno } = w.statOf(from);
        if (!st) return errno;
        if (st.device || w.ownsPath(from) || w.ownsPath(to)) return E.PERM;
        const tp = w.statOf(parentOf2(to));
        if (!tp.st) return tp.errno ?? E.NOENT;
        if (!isDir(tp.st.mode)) return E.NOTDIR;
        if (from === to) return 0;
        const replaced = w.statAt(to);
        let cell = null;
        try {
          if (replaced && !isDir(replaced.mode)) cell = w.snapshotOpenFds(to, replaced);
          w.store.renameSync(from, to);
        } catch (e) {
          return wasiErrno(e);
        }
        w.adoptSnapshot(to, cell);
        w.retargetOpenFds(from, to);
        return 0;
      },
      // touch lands here, and now it means something: mtime is a field of the
      // store, so `touch f` moves it instead of quietly doing nothing.
      // fstflags: 1=ATIM 2=ATIM_NOW 4=MTIM 8=MTIM_NOW; times are nanoseconds.
      path_filestat_set_times: (fd, flags, pathp, plen, atim, mtim, fstflags = 0) => {
        const path = w.resolve(fd, w.str(pathp, plen));
        const { st, errno } = w.statOf(path);
        if (!st) return errno ?? E.NOENT;
        if (st.device) return 0;
        const now = Date.now(), meta = {};
        if (fstflags & 1) meta.atimeMs = Number(atim) / 1e6;
        if (fstflags & 2) meta.atimeMs = now;
        if (fstflags & 4) meta.mtimeMs = Number(mtim) / 1e6;
        if (fstflags & 8) meta.mtimeMs = now;
        try {
          w.store.touchSync(path, meta);
        } catch (e) {
          return wasiErrno(e);
        }
        return 0;
      },
      // No symlinks exist in this FS: readlink's EINVAL means "not a symlink".
      path_readlink: () => E.INVAL,
      path_symlink: () => E.NOSYS,
      path_link: () => E.NOSYS,
      poll_oneoff: (subs, events, nsubs, out) => {
        let timeoutMs = null, clockUD = null, stdinUD = null, otherRead = null, devUD = null, devPoll = null;
        for (let i = 0; i < nsubs; i++) {
          const s = subs + i * 48;
          const ud = w.dv().getBigUint64(s, true);
          const tag = w.dv().getUint8(s + 8);
          if (tag === 0) {
            const t = w.dv().getBigUint64(s + 24, true);
            timeoutMs = Number(t) / 1e6;
            clockUD = ud;
          } else if (tag === 1) {
            const fd = w.dv().getUint32(s + 16, true);
            const f = w.fds.get(fd);
            if (f && f.type === "stdin") stdinUD = ud;
            else if (f && f.device && f.device.poll) {
              devUD = ud;
              devPoll = f.device;
            } else otherRead = ud;
          }
        }
        let nev = 0;
        const emitRead = (ud) => {
          const ev = events + nev * 32;
          w.dv().setBigUint64(ev, ud, true);
          w.dv().setUint16(ev + 8, 0, true);
          w.dv().setUint8(ev + 10, 1);
          w.dv().setBigUint64(ev + 16, 64n, true);
          w.dv().setUint16(ev + 24, 0, true);
          nev++;
        };
        const emitClock = (ud) => {
          const ev = events + nev * 32;
          w.dv().setBigUint64(ev, ud, true);
          w.dv().setUint16(ev + 8, 0, true);
          w.dv().setUint8(ev + 10, 0);
          nev++;
        };
        if (otherRead !== null) emitRead(otherRead);
        if (devPoll) {
          const ready = devPoll.poll(nev > 0 || stdinUD !== null ? 0 : timeoutMs);
          if (ready) emitRead(devUD);
          else if (timeoutMs != null) emitClock(clockUD);
          else emitRead(devUD);
        }
        if (stdinUD !== null) {
          const closed = () => w.input && w.input.closed && w.input.closed();
          const canPark = !!(w.input && w.input.winchPending);
          const waitMs = nev > 0 || timeoutMs == null && !canPark ? 0 : timeoutMs;
          const ready = w.input && (w.input.pollReadable(waitMs) || closed());
          if (ready) emitRead(stdinUD);
          else if (timeoutMs != null) emitClock(clockUD);
          else if (nev === 0 && canPark && w.input.winchPending()) {
            w.dv().setUint32(out, 0, true);
            return E.INTR;
          } else emitRead(stdinUD);
        } else if (otherRead === null && devPoll === null && timeoutMs != null) {
          if (w.input && w.input.wait) w.input.wait(timeoutMs);
          emitClock(clockUD);
        }
        w.dv().setUint32(out, nev, true);
        return 0;
      }
    };
    return {
      wasi_snapshot_preview1: p1,
      env: {
        __host_pipe: (fdptr) => {
          const idx = w.pipes.length;
          w.pipes.push({ chunks: [], off: 0 });
          const r = w.nextFd++, wr = w.nextFd++;
          w.fds.set(r, { type: "pipe", pipe: idx });
          w.fds.set(wr, { type: "pipe", pipe: idx });
          w.dv().setUint32(fdptr, r, true);
          w.dv().setUint32(fdptr + 4, wr, true);
          return 0;
        },
        // F_DUPFD: lowest free fd >= minfd, sharing the source's backing.
        __host_dup: (fd, minfd) => {
          const src = w.fds.get(fd);
          if (!src) return -1;
          let n = Math.max(minfd, 4);
          while (w.fds.has(n)) n++;
          if (n >= w.nextFd) w.nextFd = n + 1;
          w.fds.set(n, { ...src, preopen: false });
          return n;
        },
        __host_dup2: (oldfd, newfd) => {
          const src = w.fds.get(oldfd);
          if (!src) return -1;
          const prev = w.fds.get(newfd);
          if (newfd >= w.nextFd) w.nextFd = newfd + 1;
          w.fds.set(newfd, { ...src, preopen: false });
          if (prev && prev.type === "pipe") w.gcPipe(prev.pipe);
          return newfd;
        },
        __host_trace: () => {
        },
        // debug hook (present in traced builds; harmless)
        // Terminal geometry for a RUNNING guest. env is frozen at spawn and
        // there are no signals, so size and resize travel through the stdin
        // ring's winsize slots (see ring.mjs) and surface here:
        //   __host_winsize -> ioctl(TIOCGWINSZ) reads the live rows/cols
        //   __host_winch   -> the guest's poll point turns a pending resize
        //                     into a synthesized SIGWINCH (fires `trap WINCH`)
        // Both degrade to "no info" when input has no winsize (run() mode).
        __host_winsize: (rowsPtr, colsPtr) => {
          const ws = w.input && w.input.winsize ? w.input.winsize() : { rows: 0, cols: 0 };
          w.dv().setUint32(rowsPtr, ws.rows >>> 0, true);
          w.dv().setUint32(colsPtr, ws.cols >>> 0, true);
        },
        __host_winch: () => w.input && w.input.takeWinch && w.input.takeWinch() ? 1 : 0,
        // The cooperative interrupt, read by the GUEST rather than raised at
        // it: a monotonic count the applet in flight compares against the value
        // it started at (build/shim/wasistubs.c, build/applet-interrupt.patch).
        // Nothing is consumed here, so an interrupt posted while no applet is
        // running has nobody to cancel and cancels nobody. Degrades to a
        // constant 0 without an interrupt channel — run(), a fixed stdin — which
        // is the same "no info" contract the two hooks above have.
        __host_interrupt: () => w.input && w.input.interruptCount ? w.input.interruptCount() : 0,
        // ---- host builtins: the shell's command namespace, extended in JS ----
        // ash resolves a name against functions, builtins, then the applet
        // table; these two hooks sit where the PATH search (which can never
        // succeed here — the FS has no permission bits) used to lead to "not
        // found". See build/ash-hostbuiltin.patch and build/shim/wasistubs.c.
        //   lookup -> a PREDICATE: find_command, `type` and `command -v` all
        //             need an answer WITHOUT running anything
        //   run    -> execute; the return value becomes $?
        // Absent `builtins`, both answer "no such command" and the shell is
        // byte-for-byte what it was — the same "degrade to no info" contract
        // __host_winsize follows above.
        __host_builtin_lookup: (namePtr, len) => {
          if (!w.builtins) return 0;
          try {
            return w.builtins.lookup(len > 0 ? w.str(namePtr, len) : w.cstr(namePtr)) ? 1 : 0;
          } catch {
            return 0;
          }
        },
        // The handler runs ON THE GUEST'S OWN STACK, mid-import. argv/env/cwd
        // are copied out of linear memory first; stdio goes through the fd
        // TABLE, so a pipeline stage, a redirect and a $(...) capture all land
        // where the shell put them.
        __host_builtin_run: (cwdPtr, argc, argvPtr, envpPtr) => {
          if (!w.builtins) return -1;
          const argv = w.cstrv(argvPtr, argc > 0 ? argc : 4096);
          const name = argv[0] || "";
          const cwd = w.cstr(cwdPtr) || "/";
          const intr0 = w.input && w.input.interruptCount ? w.input.interruptCount() : null;
          const ctx = {
            argv,
            cwd,
            // The guest's LIVE environ (exports plus this command's VAR=x
            // prefixes), not the spawn-time env — this.env is frozen at
            // construction, which is exactly why the hook passes envp at all.
            env: envpPtr ? envObj(w.cstrv(envpPtr)) : envObj(w.env),
            // Blocking, regardless of any O_NONBLOCK `read -t` left on fd 0.
            // Empty means EOF. The slice matters: readFd may hand back a view
            // into a caller-mounted buffer.
            stdin: (max = 65536) => w.readFd(0, max, false).data.slice(),
            // writeFd answers an errno and this used to drop it, so a write
            // a device REFUSED looked delivered — a builtin replying through
            // /dev/host on a session with no port returned success with
            // nothing sent. It throws now, which the containment below turns
            // into a failed command and a non-zero $?: the two things a script
            // can act on. Nothing else here can fail — a pipe with no reader
            // buffers rather than EPIPE, fork-free.
            stdout: (b) => {
              const e = w.writeFd(1, bytesOf(b));
              if (e) throw new Error(`write to stdout failed: ${errnoName(e)}`);
            },
            stderr: (b) => {
              const e = w.writeFd(2, bytesOf(b));
              if (e) throw new Error(`write to stderr failed: ${errnoName(e)}`);
            },
            fs: w.hostFs(cwd),
            // Has a ^C landed since this command started? Cooperative and
            // POLLED: the handler runs on the guest's own stack, so nothing
            // can unwind it from outside and there is no safe point but the
            // ones the handler itself chooses. A long loop checks it and
            // returns 130 (128+SIGINT), which is what a shell script reads as
            // "interrupted" in `$?`.
            //
            // It does NOT end a blocking ctx.stdin(): that read parks in
            // Atomics.wait and an interrupt wakes the wait but does not make
            // bytes appear, so the read parks again. A builtin that wants to
            // be interruptible while waiting for input must read with its own
            // timeout and check between attempts.
            interrupted: () => intr0 !== null && w.input.interruptCount() !== intr0
          };
          let status;
          try {
            status = w.builtins.run(ctx);
          } catch (e) {
            if (e instanceof WasiExit) return e.code & 255;
            w.writeFd(2, strBytes(`${name}: ${e && e.message || e}
`));
            return 1;
          }
          if (status && typeof status.then === "function") {
            status.catch(() => {
            });
            w.writeFd(2, strBytes(`${name}: handler returned a Promise; host builtins must be synchronous (do async setup once in serve({ async builtins() {...} }))
`));
            return 1;
          }
          const n = Number(status);
          return Number.isFinite(n) ? n & 255 : 0;
        }
      }
    };
  }
  // ---- helpers ----
  // stat across the device overlay and the store, keeping WHY it failed. A
  // store refuses for reasons that are not "missing" — EACCES, a directory
  // handle the user revoked — and collapsing those to ENOENT tells the guest a
  // comfortable lie it will act on. Every FS import starts here, so /dev never
  // reaches a store and a store's exception never escapes into the guest.
  statOf(path) {
    const dev = this.deviceStat(path);
    if (dev) return { st: dev };
    if (this.ownsPath(path)) return { st: null, errno: E.NOENT };
    try {
      return { st: this.store.statSync(path) };
    } catch (e) {
      return { st: null, errno: wasiErrno(e) };
    }
  }
  // The same, for the many callers that only need "is anything there".
  statAt(path) {
    return this.statOf(path).st;
  }
  // /dev belongs to the overlay whole, not entry by entry: a store with its
  // own /dev is shadowed entirely rather than half-visible, so nothing can be
  // written to a name that `ls /dev` will never show.
  ownsPath(path) {
    return ownsDevPath(path);
  }
  // Register a character device in the /dev overlay:
  //   read(max,owner,nonblock) -> bytes | errno    write(bytes,owner) -> errno | undefined
  //   open() -> errno | 0   (refuse the open; the port's EPERM)
  //   poll(ms) -> bool      (optional; true when a read would not block)
  // The inode is assigned HERE, which is the whole point — a device is one
  // entry in one map, so `ls /dev`, stat and open cannot describe different
  // sets of names.
  addDevice(path, dev) {
    const p = normalize(path);
    if (parentOf2(p) !== "/dev") throw new Error(`addDevice: '${p}' must be a name directly under /dev, the only namespace the overlay owns`);
    if (typeof dev.read !== "function" && typeof dev.write !== "function") throw new Error(`addDevice: '${p}' implements neither read nor write`);
    this.devices.set(p, {
      ino: this.nextDevIno++,
      read: typeof dev.read === "function" ? (max, owner, nonblock) => devRead(dev.read(max, owner, nonblock)) : () => ({ data: EMPTY2, errno: 0 }),
      write: typeof dev.write === "function" ? (b, owner) => dev.write(b, owner) : () => E.PERM,
      open: typeof dev.open === "function" ? () => dev.open() : null,
      // Optional, and its PRESENCE is the signal — exactly as input.winchPending's
      // is. A device with no poll() is readable the moment it is asked, which is
      // true of everything the overlay held until now; one that can make a read
      // WAIT has to be asked first, or the wait lands in the read that follows
      // and nothing there can end it. See poll_oneoff.
      poll: typeof dev.poll === "function" ? (ms) => !!dev.poll(ms) : null
    });
    return this;
  }
  deviceStat(path) {
    if (path === "/dev") return this.devNode(DEV_DIR_INO, true);
    const dev = this.devices.get(path);
    return dev ? this.devNode(dev.ino, false) : null;
  }
  devNode(ino, dir) {
    const t = this.bootMs;
    return {
      ino,
      nlink: 1,
      size: 0,
      mode: dir ? S_IFDIR | 493 : S_IFCHR | 438,
      uid: 0,
      gid: 0,
      atimeMs: t,
      mtimeMs: t,
      ctimeMs: t,
      device: true
    };
  }
  // What an fd with no live path reports to fstat. An unlinked-but-open file
  // is still a REGULAR file with its size — reporting a character device would
  // fail every S_ISREG check in exactly the case the snapshot exists to save —
  // and nlink 0 is what a real one says.
  anonStat(f) {
    const t = this.bootMs, gone = f && f.gone;
    return {
      ino: 0,
      nlink: gone ? 0 : 1,
      size: gone ? gone.data.length : 0,
      mode: gone ? S_IFREG | 420 : f && f.type === "dir" ? S_IFDIR | 493 : S_IFCHR | 438,
      uid: 0,
      gid: 0,
      atimeMs: t,
      mtimeMs: t,
      ctimeMs: t,
      device: !gone
    };
  }
  // Directory entries, with /dev grafted onto the root.
  readdirAt(path) {
    if (path === "/dev") return [...this.devices.keys()].map((p) => p.slice(p.lastIndexOf("/") + 1));
    const names = this.store.readdirSync(path);
    if (path !== "/") return names;
    return names.includes("dev") ? names : ["dev", ...names];
  }
  sizeOf(f) {
    if (f.gone) return f.gone.data.length;
    if (f.path === void 0) return 0;
    const st = this.statAt(f.path);
    return st ? st.size : 0;
  }
  // POSIX keeps an unlinked file readable through every fd still open on it.
  // The store is path-addressed and forgets it the moment the name goes, so
  // the bytes move onto the fds that still care — in a SHARED CELL, for the
  // same reason `pos` is one: dup/dup2 copy the record with {...src}, and two
  // fds on one open description must not drift apart when a write grows it.
  //
  // The one divergence: with nlink > 1 the file still exists under its other
  // name, and writes through this fd will not reach it. The guest cannot make
  // a hard link (path_link is ENOSYS), so only an embedder's pre-linked store
  // can get here.
  //
  // Two phases, because the removal that motivates it can still fail: taking
  // the snapshot must not commit anything, or a store that refuses the unlink
  // leaves live fds writing into a phantom and reporting success.
  snapshotOpenFds(path, st) {
    let wanted = false;
    for (const f of this.fds.values()) if (f.path === path && f.type === "file" && !f.gone) {
      wanted = true;
      break;
    }
    if (!wanted) return null;
    const bytes = new Uint8Array(st.size);
    if (st.size) this.store.readSync(path, bytes, 0, st.size);
    return { data: bytes };
  }
  adoptSnapshot(path, cell) {
    if (!cell) return;
    for (const f of this.fds.values()) if (f.path === path && f.type === "file" && !f.gone) f.gone = cell;
  }
  // A rename does not disturb an open fd: it follows the file, not the name.
  // Path-addressed fds have to be told, subtree and all.
  retargetOpenFds(from, to) {
    const prefix = `${from}/`;
    for (const f of this.fds.values()) {
      if (f.path === void 0) continue;
      if (f.path === from) f.path = to;
      else if (f.path.startsWith(prefix)) f.path = to + f.path.slice(from.length);
    }
  }
  // Read up to `max` bytes from one fd, routing on the fd TABLE TYPE — fd_read's
  // whole body minus the iovec scatter. Returns { data, errno }:
  //   errno 0, data non-empty -> bytes
  //   errno 0, data empty     -> true EOF
  //   errno E.AGAIN           -> nothing yet; the caller must retry
  // `nonblock` is passed in rather than read off the fd so a host builtin can
  // take the blocking path even while `read -t` has fd 0 flagged O_NONBLOCK.
  // `data` may be a view into an FS node or into whatever input.read() returned
  // — copy it before retaining (ctx.stdin does).
  // Read from an `input`-shaped source: stdin, or the inbound request channel,
  // which is the same contract aimed the other way. Returns { data, errno } as
  // readFd does.
  //
  // No data. A BLOCKING read must wait — else `while read` sees failure and the
  // loop ends one line early. A NON-blocking read gets EAGAIN so `read -t`
  // timeout logic runs. A CLOSED source reads 0 bytes with SUCCESS — true EOF,
  // which is what ends the loop.
  readInput(src, max, nonblock) {
    let data = src ? src.read(max) : EMPTY2;
    if (data.length === 0) {
      if (!nonblock && src && src.readBlocking) {
        data = src.readBlocking(max);
      }
      if (data.length === 0) {
        return { data: EMPTY2, errno: src && src.closed && src.closed() ? 0 : E.AGAIN };
      }
    }
    return { data, errno: 0 };
  }
  readFd(fd, max, nonblock) {
    const f = this.fds.get(fd);
    if (!f) return { data: EMPTY2, errno: E.BADF };
    if (f.type === "stdin") return this.readInput(this.input, max, nonblock);
    if (f.device) return f.device.read(max, this.pos(f), !!nonblock);
    if (f.type === "pipe") {
      const pi = this.pipes[f.pipe];
      if (!pi) return { data: EMPTY2, errno: 0 };
      let avail = -pi.off;
      for (const c of pi.chunks) avail += c.length;
      const outb = new Uint8Array(Math.max(0, Math.min(max, avail)));
      let got = 0;
      while (got < outb.length && pi.chunks.length) {
        const c = pi.chunks[0];
        const take = Math.min(outb.length - got, c.length - pi.off);
        outb.set(c.subarray(pi.off, pi.off + take), got);
        pi.off += take;
        got += take;
        if (pi.off === c.length) {
          pi.chunks.shift();
          pi.off = 0;
        }
      }
      return { data: outb, errno: 0 };
    }
    if (f.type === "file") {
      const p = this.pos(f);
      if (f.gone) {
        const take2 = Math.min(max, f.gone.data.length - p.v);
        if (take2 <= 0) return { data: EMPTY2, errno: 0 };
        const data2 = f.gone.data.subarray(p.v, p.v + take2);
        p.v += take2;
        return { data: data2, errno: 0 };
      }
      const { st, errno } = this.statOf(f.path);
      if (!st) return { data: EMPTY2, errno: errno == null || errno === E.NOENT ? 0 : errno };
      const take = Math.min(max, st.size - p.v);
      if (take <= 0) return { data: EMPTY2, errno: 0 };
      const data = new Uint8Array(take);
      try {
        this.store.readSync(f.path, data, p.v, p.v + take);
      } catch (e) {
        return { data: EMPTY2, errno: wasiErrno(e) };
      }
      p.v += take;
      return { data, errno: 0 };
    }
    return { data: EMPTY2, errno: 0 };
  }
  // Write one buffer to one fd, routing on the fd TABLE TYPE — fd_write's whole
  // body minus the iovec gather. Host builtins go through it so their fd 1/fd 2
  // land wherever the shell last dup2'd them: a pipeline stage, a `> file`, a
  // $(...) capture. Calling this.stdout() instead would print `cmd | grep x`
  // straight to the terminal and hand grep an empty pipe — the same
  // fd-number-vs-fd-type mistake poll_oneoff already made once (see its
  // comment). Bytes are always COPIED: worker.mjs posts stdout with a transfer
  // list, which would detach a handler's reused scratch buffer.
  writeFd(fd, b) {
    const f = this.fds.get(fd);
    if (!f) return E.BADF;
    if (f.type === "stdout") this.stdout(b.slice());
    else if (f.type === "stderr") this.stderr(b.slice());
    else if (f.device) return f.device.write(b, this.pos(f)) || 0;
    else if (f.type === "pipe") {
      const pi = this.pipes[f.pipe];
      if (pi && b.length) pi.chunks.push(b.slice());
    } else if (f.type === "file") {
      const p = this.pos(f);
      if (f.gone) {
        const start2 = f.append ? f.gone.data.length : p.v, end = start2 + b.length;
        if (end > f.gone.data.length) {
          const grown = new Uint8Array(end);
          grown.set(f.gone.data);
          f.gone.data = grown;
        }
        f.gone.data.set(b, start2);
        p.v = end;
        return 0;
      }
      let start = p.v;
      if (f.append) {
        const st = this.statAt(f.path);
        if (!st) return E.NOENT;
        start = st.size;
      }
      try {
        this.store.writeSync(f.path, b, start);
      } catch (e) {
        return wasiErrno(e);
      }
      p.v = start + b.length;
    }
    return 0;
  }
  // The seek offset of an fd, as a SHARED CELL. POSIX gives dup/dup2 one file
  // offset per open file description, not per fd, and __host_dup/__host_dup2
  // copy the descriptor with {...src} — so a plain `off` number gave every dup
  // a private offset. Two real corruptions came from that: `cmd > f 2>&1` had
  // fd 1 and fd 2 both writing from 0 and overwriting each other, and the
  // fork-free evalpipe's fcntl(F_DUPFD,10)/dup2 save-restore REWOUND a
  // file-backed stdin between pipeline stages. Sharing the cell fixes both.
  // Lazy for non-file fds: pipes keep their offset on the pipe object and
  // stdio has none. fd_seek refuses both with ESPIPE, but a device still needs
  // a cell — /dev/host reads it as the identity of the open description an
  // exchange belongs to, not as an offset.
  pos(f) {
    return f.pos || (f.pos = { v: 0 });
  }
  // mkdir, shared by path_create_directory and a host builtin's ctx.fs.mkdir.
  makeDir(path) {
    if (this.statAt(path)) return E.EXIST;
    if (this.ownsPath(path)) return E.PERM;
    try {
      this.store.mkdirSync(path, NEW_DIR);
    } catch (e) {
      return wasiErrno(e);
    }
    return 0;
  }
  // The FS as a small stable surface for host builtins, bound to the command's
  // cwd. Deliberately NOT the store itself: a builtin that held the store
  // could seek past this seam into whatever the embedder mounted, and the
  // narrow view is the same shape whichever store is underneath. read() copies
  // for the same reason writes never touched a mounted buffer — a builtin must
  // not be able to scribble one through the back door.
  hostFs(cwd) {
    const w = this;
    const abs = (p) => {
      const s = String(p);
      return normalize(s.startsWith("/") ? s : `${cwd.replace(/\/$/, "")}/${s}`);
    };
    return {
      resolve: abs,
      read(p) {
        const path = abs(p);
        const st = w.statAt(path);
        if (!st || isDir(st.mode) || st.device) return null;
        const out = new Uint8Array(st.size);
        try {
          if (st.size) w.store.readSync(path, out, 0, st.size);
        } catch {
          return null;
        }
        return out;
      },
      write(p, data) {
        const path = abs(p);
        const st = w.statAt(path);
        if (st && (isDir(st.mode) || st.device)) return false;
        if (!st && w.ownsPath(path)) return false;
        const bytes = typeof data === "string" ? strBytes(data) : new Uint8Array(data);
        try {
          if (!st) w.store.createFileSync(path, NEW_FILE);
          if (bytes.length) w.store.writeSync(path, bytes, 0);
          w.store.touchSync(path, { size: bytes.length });
        } catch {
          return false;
        }
        return true;
      },
      exists(p) {
        return !!w.statAt(abs(p));
      },
      stat(p) {
        const st = w.statAt(abs(p));
        return st ? { type: isDir(st.mode) ? "dir" : "file", size: st.size } : null;
      },
      // The one store call here that can throw on its own: statAt already
      // swallows a failure into null, and a builtin gets null from every other
      // method rather than an exception through the middle of its run.
      list(p) {
        const path = abs(p);
        const st = w.statAt(path);
        if (!st || !isDir(st.mode)) return null;
        try {
          return w.readdirAt(path);
        } catch {
          return null;
        }
      },
      mkdir(p) {
        return w.makeDir(abs(p)) === 0;
      },
      remove(p) {
        const path = abs(p);
        const st = w.statAt(path);
        return st ? w.removeNode(path, isDir(st.mode)) === 0 : false;
      }
    };
  }
  // ---- the host port: /dev/host ----
  // One capability object, one virtual device, verbs instead of per-feature
  // plumbing. A request is a LINE written to /dev/host — a verb, optionally a
  // space and a payload — and the answer is read back from the same name:
  //
  //   printf 'clipboard.read\n' > /dev/host
  //   paste=$(cat /dev/host)
  //
  // Line framing rather than write boundaries, because a write boundary is not
  // one: stdio splits a large payload at its buffer size and the guest's own
  // `printf` decides where. A blank line is nothing; a line with no verb is a
  // malformed request and fails the write.
  //
  // The buffers belong to the SHIM, not to the fd. Those are two commands, two
  // opens and two closes — and a fork-free shell restores a redirection with
  // dup2, so a device fd frequently vanishes without fd_close ever seeing it.
  // Nothing here can be per-descriptor and survive.
  //
  // Security is a property of the port: no `host` and every capability is
  // absent, refused at open. Hand over one implementing only `clipboard.*` and
  // that is the whole of what a script can reach.
  hostDevice() {
    const w = this;
    let pending = EMPTY2;
    let response = [];
    let responseLen = 0;
    let writer = null;
    const complain = (verb, msg) => {
      w.stderr(strBytes(`/dev/host: ${verb}: ${msg}
`));
    };
    const dispatch = (line) => {
      if (!line.length) return 0;
      let sp = line.indexOf(32);
      if (sp < 0) sp = line.length;
      const verb = DEC.decode(line.subarray(0, sp));
      if (!verb) {
        complain("", "a request line must start with a verb");
        return E.INVAL;
      }
      const payload = line.slice(Math.min(sp + 1, line.length));
      let out;
      try {
        out = w.host.request(verb, payload);
      } catch (e) {
        complain(verb, e && e.message || e);
        return E.IO;
      }
      if (out && typeof out.then === "function") {
        out.catch(() => {
        });
        complain(verb, "the port returned a Promise; a host verb must be synchronous, because the guest is a wasm frame below this call and there is nothing to await into (do async setup once, in serve({ async host() {\u2026} }))");
        return E.IO;
      }
      const bytes = responseBytes(out);
      if (bytes === null) {
        complain(verb, "the port answered with something that is not bytes (expected a Uint8Array, a string, or nothing)");
        return E.IO;
      }
      if (bytes.length) {
        response.push(bytes.slice());
        responseLen += bytes.length;
      }
      if (responseLen > HOST_QUEUE_MAX) return E.NOSPC;
      return 0;
    };
    return {
      // Refused at OPEN, not at the first read: `cat /dev/host` has to say
      // "Permission denied" where a script can see it, rather than hand back a
      // silent EOF that reads as an empty answer.
      open: () => w.host ? 0 : E.PERM,
      read(max) {
        if (!responseLen) return EMPTY2;
        const take = Math.min(max, responseLen);
        const out = new Uint8Array(take);
        let off = 0;
        while (off < take) {
          const c = response[0], n = Math.min(take - off, c.length);
          out.set(c.subarray(0, n), off);
          off += n;
          if (n === c.length) response.shift();
          else response[0] = c.subarray(n);
        }
        responseLen -= take;
        return out;
      },
      write(b, owner) {
        if (!w.host) return E.PERM;
        if (owner !== writer) {
          writer = owner;
          pending = EMPTY2;
          response = [];
          responseLen = 0;
        }
        const buf = pending.length ? concatBytes(pending, b) : b;
        let start = 0, errno = 0;
        for (; ; ) {
          const nl = buf.indexOf(10, start);
          if (nl < 0) break;
          errno = dispatch(buf.subarray(start, nl));
          start = nl + 1;
          if (errno) break;
        }
        pending = !errno && start < buf.length ? buf.slice(start) : EMPTY2;
        if (pending.length > HOST_LINE_MAX) {
          pending = EMPTY2;
          errno = E.INVAL;
        }
        if (errno) {
          response = [];
          responseLen = 0;
        }
        return errno;
      }
    };
  }
  // The inbound half of the port: requests the HOST hands to a RUNNING guest.
  //
  // Nothing can be delivered to a live session by postMessage — a running guest
  // owns its worker and its event loop never turns — so the channel is shared
  // memory the guest reads at a blocking point. Which is why this is a device
  // and not a verb: a verb is the guest calling out, and here the guest is
  // WAITING TO BE TOLD.
  //
  // Framing is the vocabulary the outbound half already settled: a request is a
  // LINE. So the whole of a dev server is
  //
  //     while read -r req <&3; do handle "$req"; done 3< /dev/hostreq
  //
  // Redirected on the LOOP rather than with `exec`, because a failed `exec`
  // redirection ends a non-interactive shell outright — the refusal below is
  // worth more when the script is still there to act on it.
  //
  // and the two things it has to be told, it is told in the shell's own terms:
  //
  //   EPERM at open   this session can never receive a request. The loop
  //                   refuses to start, rather than parking forever on one.
  //   EOF at read     no more requests are coming. `read` returns non-zero and
  //                   the loop ends, exactly as it does on a closed pipe.
  //
  // There is no third answer, and that is deliberate: every other way an
  // inbound request can fail — a line with a newline in it, one too big for the
  // channel — is refused AT THE PRODUCER, where there is something to be done
  // about it. The guest has no write to fail and no $? to reach, so an error it
  // could only report by reading is an error it cannot act on.
  //
  // The reply goes back out through /dev/host, as an ordinary verb. One
  // direction per device, and no second vocabulary.
  requestDevice() {
    const w = this;
    return {
      open: () => w.requests ? 0 : E.PERM,
      // Offered unconditionally, because its PRESENCE is what stops poll_oneoff
      // calling this fd readable and putting the wait in the read behind it.
      // True at end-of-stream too — the read is what reports EOF.
      // Guarded like every other reach into an injected object: a channel
      // missing a method would throw out of a wasm import, which unwinds the
      // whole guest stack and kills the shell over a typo in an option.
      poll: (ms) => {
        const q = w.requests;
        if (!q || !q.pollReadable) return true;
        return q.pollReadable(ms) || !!(q.closed && q.closed());
      },
      read(max, owner, nonblock) {
        if (!w.requests) return E.PERM;
        const r = w.readInput(w.requests, max, nonblock);
        return r.errno || r.data;
      }
      // No write half at all: the answer to a request is an outbound verb, and
      // addDevice's default says what a missing half means — nothing that may
      // be written, EPERM.
    };
  }
  // Drop a pipe's buffers once no fd references it (close/dup2 both funnel here).
  gcPipe(idx) {
    for (const f of this.fds.values()) if (f.type === "pipe" && f.pipe === idx) return;
    this.pipes[idx] = null;
  }
  // path_unlink_file / path_remove_directory: wantDir picks which is legal.
  removeNode(path, wantDir) {
    const { st, errno } = this.statOf(path);
    if (!st) return errno;
    if (wantDir !== isDir(st.mode)) return wantDir ? E.NOTDIR : E.INVAL;
    if (st.device) return E.PERM;
    try {
      if (wantDir) this.store.rmdirSync(path);
      else {
        const cell = this.snapshotOpenFds(path, st);
        this.store.unlinkSync(path);
        this.adoptSnapshot(path, cell);
      }
    } catch (e) {
      return wasiErrno(e);
    }
    return 0;
  }
  str(p, len) {
    return DEC.decode(this.bytes().subarray(p, p + len));
  }
  // NUL-terminated C string. Everything WASI hands us is (ptr,len); the host
  // builtin hooks are the first imports taking a bare char*, so there is no
  // length to pair with the pointer. The scan ends at the NUL or at the end of
  // linear memory, whichever comes first — a bad pointer costs one memchr and
  // cannot spin past the end comparing `undefined !== 0`. It must NOT end at a
  // byte budget: an argument longer than one would arrive shorter and still
  // well-formed, which is a wrong value rather than a failure, and a command
  // line carrying an encoded payload is exactly that argument.
  cstr(p) {
    if (!p) return "";
    const u = this.bytes();
    const e = u.indexOf(0, p);
    return DEC.decode(u.subarray(p, e < 0 ? u.length : e));
  }
  // NULL-terminated char** (argv, envp). Each element re-enters cstr, which
  // re-fetches the byte view, so a memory.grow mid-walk cannot leave us stale.
  // `cap` counts ELEMENTS, and the walk also stops at the end of memory: a
  // vector with no terminator is a bad pointer, not a long argv.
  cstrv(p, cap = 4096) {
    const out = [];
    if (!p) return out;
    const end = this.bytes().length - 4;
    for (let q = p; out.length < cap && q <= end; q += 4) {
      const s = this.dv().getUint32(q, true);
      if (!s) break;
      out.push(this.cstr(s));
    }
    return out;
  }
  iovecs(iovs, n) {
    const out = [];
    for (let i = 0; i < n; i++) {
      const buf = this.dv().getUint32(iovs + i * 8, true);
      const l = this.dv().getUint32(iovs + i * 8 + 4, true);
      out.push(this.bytes().subarray(buf, buf + l));
    }
    return out;
  }
  // Resolve a path given at an fd. A relative one is resolved against a
  // DIRECTORY, and against nothing else — which matters because of what fd 3
  // is. wasi-libc scans the preopen table once at startup, finds '/' at fd 3,
  // and from then on turns every absolute path in the program into a RELATIVE
  // one addressed through that number. A shell that redirects onto fd 3
  // (`exec 3< file`, or a `while read <&3` loop) has not asked for openat — it
  // has taken the root out from under every later open in the session, and
  // resolving against the file sitting there produced paths like
  // /data.txt/tmp/a: "nonexistent directory" for a directory that is right
  // there. Falling back to the root is what the preopen still means; a file or
  // a device is not a base and never was.
  resolve(fd, path) {
    if (path.startsWith("/")) return normalize(path);
    const f = this.fds.get(fd);
    const base = f && f.type === "dir" && f.path || "/";
    return normalize(base.replace(/\/$/, "") + "/" + path);
  }
  // Introspection for tests and debugging, in the shape the private FS map
  // used to have. `data` is a getter because reading a whole file to answer a
  // stat would be absurd; nothing on a hot path goes through here.
  lookup(path) {
    const st = this.statAt(path);
    if (!st) return null;
    const w = this, abs = normalize(path);
    return {
      type: isDir(st.mode) ? "dir" : isChar(st.mode) ? "char" : "reg",
      ino: st.ino,
      size: st.size,
      get data() {
        const out = new Uint8Array(st.size);
        if (st.size && !st.device) w.store.readSync(abs, out, 0, st.size);
        return out;
      }
    };
  }
  // filestat: dev, ino, filetype, nlink, size, then atim/mtim/ctim in
  // NANOSECONDS. The times used to be three zeroes, which is invisible until
  // something caches by mtime and never notices an edit.
  writeFilestat(out, st) {
    const d = this.dv();
    d.setBigUint64(out, st.device ? DEV_DEV : 1n, true);
    d.setBigUint64(out + 8, BigInt(st.ino || 0), true);
    d.setUint8(out + 16, isDir(st.mode) ? FT.DIR : isChar(st.mode) ? FT.CHAR : FT.REG);
    d.setBigUint64(out + 24, BigInt(st.nlink ?? 1), true);
    d.setBigUint64(out + 32, BigInt(st.size || 0), true);
    d.setBigUint64(out + 40, msToNs(st.atimeMs), true);
    d.setBigUint64(out + 48, msToNs(st.mtimeMs), true);
    d.setBigUint64(out + 56, msToNs(st.ctimeMs), true);
  }
};
function strBytes(s) {
  return ENC2.encode(s);
}
function bytesOf(b) {
  return typeof b === "string" ? strBytes(b) : b || EMPTY2;
}
function concatBytes(a, b) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}
function joinBytes(list) {
  let n = 0;
  for (const b of list) n += b.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const b of list) {
    out.set(b, o);
    o += b.length;
  }
  return out;
}
function responseBytes(out) {
  if (out == null) return EMPTY2;
  if (typeof out === "string") return strBytes(out);
  if (out instanceof Uint8Array) return out;
  if (out instanceof ArrayBuffer) return new Uint8Array(out);
  if (ArrayBuffer.isView(out)) return new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
  return null;
}
function envObj(list) {
  const o = {};
  for (const kv of list) {
    const i = kv.indexOf("=");
    if (i > 0) o[kv.slice(0, i)] = kv.slice(i + 1);
  }
  return o;
}
function parentOf2(p) {
  const s = p.lastIndexOf("/");
  return s > 0 ? p.slice(0, s) : "/";
}
function ownsDevPath(p) {
  return p === "/dev" || p.startsWith("/dev/");
}
function joinPath(dir, name) {
  return dir === "/" ? `/${name}` : `${dir}/${name}`;
}
function msToNs(ms) {
  return BigInt(Math.round((ms || 0) * 1e6));
}
function seedInto(store, files) {
  const present = (path) => {
    try {
      store.statSync(path);
      return true;
    } catch {
      return false;
    }
  };
  for (const [path, content] of Object.entries(files || {})) {
    const abs = normalize(path.startsWith("/") ? path : "/" + path);
    const segs = abs.split("/").filter(Boolean);
    let dir = "";
    for (let i = 0; i < segs.length - 1; i++) {
      dir = `${dir}/${segs[i]}`;
      if (!present(dir)) store.mkdirSync(dir, NEW_DIR);
    }
    if (!present(abs)) store.createFileSync(abs, NEW_FILE);
    const bytes = bytesOf(content);
    if (bytes.length) store.writeSync(abs, bytes, 0);
    store.touchSync(abs, { size: bytes.length });
  }
}

// src/ring.mjs
var CTRL_WORDS = 8;
var HEADER_BYTES = CTRL_WORDS * 4;
var ENC3 = new TextEncoder();
function frameRequest(request) {
  const bytes = typeof request === "string" ? ENC3.encode(request) : request instanceof Uint8Array ? request : new Uint8Array(request);
  if (!bytes.length) throw new Error("host request: empty. A request is a line with something on it; a blank line is not a request.");
  const nl = bytes.indexOf(10);
  if (nl >= 0) {
    throw new Error(
      `host request: contains a newline at byte ${nl}, and a request is one line \u2014 delivering it would forge a second request out of the remainder. Encode the payload (percent, base64, JSON) or pass a handle the guest fetches with a verb.`
    );
  }
  const out = new Uint8Array(bytes.length + 1);
  out.set(bytes);
  out[bytes.length] = 10;
  return out;
}

// src/options.mjs
var DEFAULT_ENV = {
  PATH: "/",
  HOME: "/",
  TERM: "xterm-256color",
  LANG: "C.UTF-8"
};
var DEFAULT_WASM_URL = new URL("../dist/busybox.wasm", import.meta.url);
function resolveArgv({ args, command, script } = {}, mountAt = "/main.sh") {
  if (args) return { argv: args, extraFiles: {} };
  if (command != null) return { argv: ["busybox", "sh", "-c", command], extraFiles: {} };
  if (script != null) return { argv: ["busybox", "sh", mountAt], extraFiles: { [mountAt]: script } };
  return { argv: ["busybox", "sh"], extraFiles: {} };
}
function mergeEnv(user = {}) {
  return { ...DEFAULT_ENV, ...user };
}
var isNode = typeof process !== "undefined" && !!process.versions?.node && typeof importScripts === "undefined" && typeof window === "undefined";
async function resolveWasm(wasm = DEFAULT_WASM_URL) {
  if (wasm instanceof WebAssembly.Module) return wasm;
  if (typeof Response !== "undefined" && wasm instanceof Response) return compileResponse(wasm);
  if (wasm instanceof ArrayBuffer || ArrayBuffer.isView(wasm)) return WebAssembly.compile(wasm);
  if (isNode) {
    const { readFile } = await import("node:fs/promises");
    return WebAssembly.compile(await readFile(wasm instanceof URL ? wasm : new URL(wasm, `file://${process.cwd()}/`)));
  }
  return compileResponse(await fetch(wasm));
}
async function compileResponse(res) {
  if (!res.ok) throw new Error(`failed to fetch wasm: ${res.status} ${res.statusText} (${res.url})`);
  if (WebAssembly.compileStreaming) {
    try {
      return await WebAssembly.compileStreaming(res.clone());
    } catch {
    }
  }
  return WebAssembly.compile(await res.arrayBuffer());
}
async function resolveWasmForWorker(wasm = DEFAULT_WASM_URL) {
  if (wasm instanceof WebAssembly.Module) return { module: wasm };
  if (typeof Response !== "undefined" && wasm instanceof Response) {
    return { wasmBytes: new Uint8Array(await wasm.arrayBuffer()) };
  }
  if (wasm instanceof ArrayBuffer) return { wasmBytes: new Uint8Array(wasm.slice(0)) };
  if (ArrayBuffer.isView(wasm)) return { wasmBytes: new Uint8Array(wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength)) };
  if (isNode) {
    const { readFile } = await import("node:fs/promises");
    const buf = await readFile(wasm instanceof URL ? wasm : new URL(wasm, `file://${process.cwd()}/`));
    return { wasmBytes: new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength) };
  }
  const res = await fetch(wasm);
  if (!res.ok) throw new Error(`failed to fetch wasm: ${res.status} ${res.statusText} (${res.url})`);
  return { wasmBytes: new Uint8Array(await res.arrayBuffer()) };
}
var ENC4 = new TextEncoder();
function toBytes(data) {
  if (data == null) return new Uint8Array(0);
  return typeof data === "string" ? ENC4.encode(data) : data;
}
function hostBuiltins(spec) {
  if (!spec) return void 0;
  if (typeof spec.lookup === "function" && typeof spec.run === "function") return spec;
  const pick = (name) => Object.hasOwn(spec, name) && typeof spec[name] === "function" ? spec[name] : null;
  return {
    lookup: (name) => pick(name) != null,
    run(ctx) {
      const fn = pick(ctx.argv[0]);
      if (!fn) {
        ctx.stderr(`${ctx.argv[0]}: not found
`);
        return 127;
      }
      return fn(ctx);
    }
  };
}
async function resolveBuiltins(spec) {
  if (!spec) return void 0;
  return hostBuiltins(typeof spec === "function" ? await spec() : spec);
}
function hostPort(spec) {
  if (!spec) return void 0;
  if (typeof spec.request === "function") {
    const others = Object.keys(spec).filter((k) => k !== "request" && typeof spec[k] === "function");
    if (others.length) {
      throw new Error(
        `host: this object has a request() alongside ${others.join(", ")}, so it reads as both a port and a verb map \u2014 and the two hand their handler (verb, payload) and (payload, verb) respectively, which is a bug that looks like working code. Say which: if it is a verb MAP, rename the \`request\` verb or wrap it in a port whose request() dispatches the map; if it is a PORT, request() must be the only function it owns \u2014 put the rest on a prototype or close over them.`
      );
    }
    return spec;
  }
  return {
    request(verb, payload) {
      if (!Object.hasOwn(spec, verb) || typeof spec[verb] !== "function") throw new Error("no such verb");
      return spec[verb](payload, verb);
    }
  };
}
function toRequestBytes(list) {
  if (list == null) return void 0;
  const items = Array.isArray(list) ? list : [list];
  const framed = items.map(frameRequest);
  let total = 0;
  for (const f of framed) total += f.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const f of framed) {
    out.set(f, off);
    off += f.length;
  }
  return out;
}
function fixedRequests(bytes) {
  return bytes === void 0 ? void 0 : fixedInput(bytes);
}
async function resolveHost(spec) {
  if (!spec) return void 0;
  return hostPort(typeof spec === "function" ? await spec() : spec);
}
function fixedInput(data) {
  const bytes = toBytes(data);
  let off = 0;
  return {
    pollReadable: () => off < bytes.length,
    read(max) {
      const take = bytes.subarray(off, Math.min(off + max, bytes.length));
      off += take.length;
      return take;
    },
    readBlocking(max) {
      return this.read(max);
    },
    wait: () => {
    },
    closed: () => off >= bytes.length
  };
}

// src/run.mjs
var DEC2 = new TextDecoder();
async function run(options = {}) {
  const inline = options.inline ?? typeof Worker === "undefined";
  return inline ? runInline(options) : runInWorker(options);
}
async function runInline(options) {
  const { argv, extraFiles } = resolveArgv(options);
  const module = await resolveWasm(options.wasm);
  const chunks = { stdout: [], stderr: [] };
  const sink = (channel) => (bytes) => {
    chunks[channel].push(bytes);
    if (options.onOutput) options.onOutput(bytes, channel);
  };
  const shim = new WasiShim({
    args: argv,
    env: mergeEnv(options.env),
    files: { ...extraFiles, ...options.files || {} },
    fs: options.fs,
    stdout: sink("stdout"),
    stderr: sink("stderr"),
    input: fixedInput(options.stdin),
    requests: fixedRequests(toRequestBytes(options.requests)),
    builtins: await resolveBuiltins(options.builtins),
    host: await resolveHost(options.host)
  });
  const instance = await WebAssembly.instantiate(module, shim.imports());
  shim.bindMemory(instance.exports.memory);
  let exitCode = 0;
  try {
    instance.exports._start();
  } catch (e) {
    if (e instanceof WasiExit) exitCode = e.code;
    else throw e;
  }
  return {
    stdout: decodeAll(chunks.stdout),
    stderr: decodeAll(chunks.stderr),
    exitCode
  };
}
function decodeAll(list) {
  if (list.length === 0) return "";
  if (list.length === 1) return DEC2.decode(list[0]);
  let total = 0;
  for (const c of list) total += c.length;
  const merged = new Uint8Array(total);
  let off = 0;
  for (const c of list) {
    merged.set(c, off);
    off += c.length;
  }
  return DEC2.decode(merged);
}
async function runInWorker(options) {
  if (options.fs && !options.worker && !options.workerUrl) {
    throw new Error(
      "run({ fs }) needs a worker that registers the store: a filesystem cannot be structured-cloned into a Worker. Either pass inline:true to run on the calling thread, or call serve({ fs }) from 'wasi-sh/worker' in a worker module and pass it as workerUrl."
    );
  }
  if (options.host && !options.worker && !options.workerUrl) {
    throw new Error(
      "run({ host }) needs a worker that registers the port: a capability object cannot be structured-cloned into a Worker. Either pass inline:true to run on the calling thread, or call serve({ host }) from 'wasi-sh/worker' in a worker module and pass it as workerUrl."
    );
  }
  if (options.builtins && !options.worker && !options.workerUrl) {
    throw new Error(
      "run({ builtins }) needs a worker that registers them: handler functions cannot be structured-cloned into a Worker. Either pass inline:true to run on the calling thread, or write a worker module that calls serve({ builtins }) from 'wasi-sh/worker' and pass it as workerUrl. See the host builtins section of the wasi-sh README."
    );
  }
  const { argv, extraFiles } = resolveArgv(options);
  const wasm = await resolveWasmForWorker(options.wasm);
  const worker = options.worker || (options.workerUrl ? new Worker(options.workerUrl, { type: "module" }) : new Worker(new URL("./worker.mjs", import.meta.url), { type: "module" }));
  const chunks = { stdout: [], stderr: [] };
  const result = new Promise((resolve, reject) => {
    worker.addEventListener("message", (e) => {
      const m = e.data;
      if (m.type === "out") {
        const bytes = new Uint8Array(m.bytes);
        chunks[m.channel].push(bytes);
        if (options.onOutput) options.onOutput(bytes, m.channel);
      } else if (m.type === "exit") {
        resolve({
          stdout: decodeAll(chunks.stdout),
          stderr: decodeAll(chunks.stderr),
          exitCode: m.code
        });
      } else if (m.type === "error") {
        reject(new Error(m.msg));
      }
    });
    worker.addEventListener("error", (e) => reject(e.error || new Error(e.message || "worker error")));
  });
  const msg = {
    ...wasm,
    // { module } or { wasmBytes }
    files: { ...extraFiles, ...options.files || {} },
    args: argv,
    env: mergeEnv(options.env),
    stdin: toBytes(options.stdin),
    // Bytes, so they structured-clone into a stock worker exactly as stdin
    // does — the whole channel is data here, and none of it is a live object.
    requests: toRequestBytes(options.requests)
  };
  worker.postMessage(msg, msg.wasmBytes ? [msg.wasmBytes.buffer] : []);
  try {
    return await result;
  } finally {
    if (!options.worker) worker.terminate();
  }
}
export {
  MemoryFs,
  memoryFs,
  run
};
