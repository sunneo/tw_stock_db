#!/usr/bin/env node
// 渲染程序接線的編排測試（不開視窗、不用真 GPU）：從 floating-assistant.js 取出真正的 _nrHeadStart 等方法與嵌入的 FA_HEAD_SRC，
// 用記憶體內的假信箱（rawfs）與假 navigator 驗證：沒開關／沒有 WebGPU／執行包太舊／準備失敗 → 回傳 null 並寫原因；
// 通過時會接上輪詢，請求檔被處理成 .res（沒有 GPU 時是 error），請求檔被移除。
// 用法：node scripts/eval/cudaweb_head_renderer_mock.js
'use strict';
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..', '..');
const src = fs.readFileSync(path.join(root, 'renderer/src/floating-assistant.js'), 'utf8').replace(/\r\n/g, '\n');

function constOf(name) {
  const m = src.match(new RegExp('const ' + name + ' = (".*");\\n'));
  if (!m) throw new Error('找不到嵌入常數 ' + name);
  return JSON.parse(m[1]);
}
const FA_HEAD_SRC = constOf('FA_HEAD_SRC');
const FA_GPU_CORE_SRC = constOf('FA_GPU_CORE_SRC');

// 抽出 _nrGpuHeadOn … _nrRunNative 之前的方法（用原始碼文字，確保測的是真正的程式）
const a = src.indexOf('    _nrGpuHeadOn() {'), b = src.indexOf('    async _nrRunNative(a, cb, gen) {');
if (a < 0 || b < 0) throw new Error('找不到 lm_head 方法區段');
const methods = src.slice(a, b);
const Ctor = new Function('FA_HEAD_SRC', 'FA_GPU_CORE_SRC', 'return class T {\n' + methods + '\n};');

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('ok  ' + msg); } else { fail++; console.log('FAIL ' + msg); } };

// 假信箱
function makeBox() {
  const files = new Map();
  const rawfs = {
    readdir: async (dir) => [...files.keys()].filter((k) => k.startsWith(dir + '/')).map((k) => ({ name: k.slice(dir.length + 1), isFile: true })),
    readFile: async (p, enc) => {
      if (!files.has(p)) throw new Error('ENOENT ' + p);
      const v = files.get(p);
      return enc === 'base64' ? { base64: Buffer.from(v, 'latin1').toString('base64') } : { text: v };
    },
    writeFile: async (p, o) => { files.set(p, o.text != null ? o.text : Buffer.from(o.base64, 'base64').toString('latin1')); },
    remove: async (p) => { files.delete(p); },
  };
  return { files, rawfs };
}

function makeInstance(opts) {
  const box = makeBox();
  global.window = { desktopAPI: { rawfs: box.rawfs } };
  global.self = global.window;
  global.navigator = opts.navigator;
  const T = Ctor(FA_HEAD_SRC, FA_GPU_CORE_SRC);
  const inst = new T();
  inst.advancedSettings = { nrGpuHead: opts.flag };
  inst._nrBox = async () => '/box';
  inst._nrCall = opts.call;
  return { inst, box };
}

(async () => {
  const bin = Buffer.alloc(4 * 8, 0).toString('latin1'); // V=4,K=8 的 q8 權重（每個位元組一格）
  const prepOk = { ok: true, cached: true, dir: '/d', bin: '/d/lm_q8.bin', meta: { V: 4, K: 8, zp: 128, scale: 0.01, bytes: 32 } };
  const files = { '/d/lm_q8.bin': bin };

  // 1) 開關關閉 → null，不問主程序
  {
    let called = 0;
    const { inst } = makeInstance({ flag: 'off', navigator: {}, call: async () => { called++; return {}; } });
    const hd = await inst._nrHeadStart();
    ok(hd === null && called === 0 && inst._nrLastHeadWhy === '', '開關關閉：回傳 null、不問主程序、沒有原因');
  }
  // 2) 沒有 WebGPU 不再提前放棄（WebGL2 退路在每個詞元內選層）：照常問主程序，後面的步驟決定原因
  {
    const { inst } = makeInstance({ flag: 'on', navigator: {}, call: async (op) => (op === 'head_status' ? { ok: true, supported: true } : op === 'head_prepare' ? { ok: false, message: '讀不到模型檔' } : {}) });
    const hd = await inst._nrHeadStart();
    ok(hd === null && /讀不到模型檔/.test(inst._nrLastHeadWhy), '沒有 WebGPU 不提前放棄，照常準備（原因取自準備步驟）：' + inst._nrLastHeadWhy);
  }
  // 3) 執行包太舊（head_status 不支援）
  {
    const { inst } = makeInstance({ flag: 'on', navigator: { gpu: {} }, call: async (op) => (op === 'head_status' ? { ok: true, supported: false } : {}) });
    const hd = await inst._nrHeadStart();
    ok(hd === null && /執行包需更新/.test(inst._nrLastHeadWhy), '執行包太舊：回傳 null 並提示更新：' + inst._nrLastHeadWhy);
  }
  // 4) 準備失敗（head_prepare 回錯）
  {
    const { inst } = makeInstance({ flag: 'on', navigator: { gpu: {} }, call: async (op) => (op === 'head_status' ? { ok: true, supported: true } : { ok: false, code: 'no_model', message: '讀不到模型檔' }) });
    const hd = await inst._nrHeadStart();
    ok(hd === null && /準備 lm_head 失敗：讀不到模型檔/.test(inst._nrLastHeadWhy), '準備失敗：回傳 null 並寫真實原因：' + inst._nrLastHeadWhy);
  }
  // 5) 全部就緒：接上輪詢；一個請求檔進來，沒有 WebGPU 的 GPU 介面 → .res 應為 error，.req 應被移除
  {
    const { inst, box } = makeInstance({ flag: 'on', navigator: { gpu: { requestAdapter: async () => null } },
      call: async (op) => {
        if (op === 'head_status') return { ok: true, supported: true };
        if (op === 'head_prepare') return prepOk;
        return {};
      } });
    box.files.set('/d/lm_q8.bin', bin);
    // 讓 loadWeights 讀得到 bin：假信箱的 readFile 只認 box 內的檔，這裡把 bin 放進同一個表
    const origRead = box.rawfs.readFile;
    box.rawfs.readFile = async (p, enc) => (files[p] !== undefined ? (enc === 'base64' ? { base64: Buffer.from(files[p], 'latin1').toString('base64') } : { text: files[p] }) : origRead(p, enc));
    const hd = await inst._nrHeadStart();
    ok(hd && typeof hd.stop === 'function', '全部就緒：回傳 { stop }');
    const hidden = Buffer.alloc(32, 0).toString('base64');
    box.files.set('/box/head-r1-1.req', JSON.stringify({ hidden }));
    let res = null;
    for (let i = 0; i < 400 && !res; i++) { await new Promise((r) => setTimeout(r, 5)); res = box.files.get('/box/head-r1-1.res') || null; }
    hd && hd.stop();
    ok(res !== null, '輪詢有處理請求：產生 head-r1-1.res');
    let o = null; try { o = JSON.parse(res); } catch (_) { o = null; }
    ok(o && typeof o.error === 'string' && o.error.length > 0, '沒有 WebGPU 的 T1：.res 是 error（子程序會退回 CPU）：' + (o && o.error ? o.error.slice(0, 60) : '無'));
    ok(!box.files.has('/box/head-r1-1.req'), '處理完的請求檔已移除');
  }
  console.log('\n' + pass + ' 項通過，' + fail + ' 項失敗');
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.error('測試執行錯誤：', e && e.stack || e); process.exitCode = 1; });
