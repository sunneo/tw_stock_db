// 原生執行包的建置工具（開發者用，不隨安裝包發佈）。見 DESIGN.TODO.native-runner.md 交接第 (2) 節。
// 用法：node scripts/native-runtime-pack.js <輸出資料夾> --ort-src <含 node_modules/onnxruntime-node 的資料夾> [--platform win32] [--arch x64]
// 只讀取本機檔案，不下載任何東西。執行包內容：nr-*.js（子程序程式）、onnxruntime-node 1.22.0（dist 與該平台的原生檔）、
// onnxruntime-common、manifest.json（每個檔案的大小與 md5，主程序載入前用來核對）。
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const RUNTIME_VERSION = '1.22.0-1';
const ORT_VERSION = '1.22.0';
const NR_FILES = ['nr-child.js', 'nr-host.js', 'nr-protocol.js', 'nr-gen-params.js', 'nr-template.js', 'nr-tokenizer.js'];

function parseArgs(argv) {
  const a = { out: null, ortSrc: null, platform: process.platform, arch: process.arch };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === '--ort-src') a.ortSrc = argv[++i];
    else if (v === '--platform') a.platform = argv[++i];
    else if (v === '--arch') a.arch = argv[++i];
    else if (!a.out) a.out = v;
  }
  if (!a.out || !a.ortSrc) throw new Error('用法：node scripts/native-runtime-pack.js <輸出資料夾> --ort-src <資料夾>');
  return a;
}

// 執行時不需要的檔案（原始碼對照、型別宣告、說明）不放進執行包，省下大小。
// DirectML 與 DXC 的 DLL 不放進執行包：產品不提供 DirectML（同一模型在 SkipSimplifiedLayerNormalization 失敗，見設計文件），用不到。
function skipFile(rel) { return /\.(map|ts)$|\.d\.ts$|(^|\/)(README|LICENSE)/i.test(rel) || /(^|\/)lib\//.test(rel) || /(DirectML|dxcompiler|dxil)\.dll$/i.test(rel); }

function copyTree(src, dst, rel, files) {
  const st = fs.statSync(src);
  if (!st.isDirectory() && skipFile(rel)) return;
  if (st.isDirectory()) {
    fs.mkdirSync(dst, { recursive: true });
    for (const name of fs.readdirSync(src)) copyTree(path.join(src, name), path.join(dst, name), path.join(rel, name), files);
  } else {
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
    files.push(rel.split(path.sep).join('/'));
  }
}

function pack(opts) {
  const root = path.join(__dirname, '..');
  const out = path.resolve(opts.out);
  const ortNode = path.join(opts.ortSrc, 'node_modules', 'onnxruntime-node');
  const ortCommon = path.join(opts.ortSrc, 'node_modules', 'onnxruntime-common');
  const ortVer = JSON.parse(fs.readFileSync(path.join(ortNode, 'package.json'), 'utf8')).version;
  if (ortVer !== ORT_VERSION) throw new Error('onnxruntime-node 版本是 ' + ortVer + '，產品固定 ' + ORT_VERSION + '，拒絕打包');
  const binDir = path.join(ortNode, 'bin', 'napi-v6', opts.platform, opts.arch);
  if (!fs.existsSync(binDir)) throw new Error('找不到原生檔資料夾：' + binDir);
  if (fs.existsSync(out) && fs.readdirSync(out).length) throw new Error('輸出資料夾不是空的：' + out);
  fs.mkdirSync(out, { recursive: true });
  const files = [];
  for (const f of NR_FILES) copyTree(path.join(root, f), path.join(out, f), f, files);
  copyTree(path.join(ortNode, 'package.json'), path.join(out, 'node_modules', 'onnxruntime-node', 'package.json'), 'node_modules/onnxruntime-node/package.json', files);
  copyTree(path.join(ortNode, 'dist'), path.join(out, 'node_modules', 'onnxruntime-node', 'dist'), 'node_modules/onnxruntime-node/dist', files);
  copyTree(binDir, path.join(out, 'node_modules', 'onnxruntime-node', 'bin', 'napi-v6', opts.platform, opts.arch), 'node_modules/onnxruntime-node/bin/napi-v6/' + opts.platform + '/' + opts.arch, files);
  copyTree(ortCommon, path.join(out, 'node_modules', 'onnxruntime-common'), 'node_modules/onnxruntime-common', files);
  const manifest = { runtimeVersion: RUNTIME_VERSION, ortVersion: ORT_VERSION, platform: opts.platform, arch: opts.arch, files: {}, totalBytes: 0 };
  for (const rel of files.sort()) {
    const buf = fs.readFileSync(path.join(out, ...rel.split('/')));
    manifest.files[rel] = { size: buf.length, md5: crypto.createHash('md5').update(buf).digest('hex') };
    manifest.totalBytes += buf.length;
  }
  fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}

if (require.main === module) {
  const m = pack(parseArgs(process.argv.slice(2)));
  console.log('執行包已建置：' + Object.keys(m.files).length + ' 個檔案，共 ' + (m.totalBytes / 1048576).toFixed(1) + ' MB（' + m.platform + '-' + m.arch + '）');
}

module.exports = { pack, RUNTIME_VERSION, ORT_VERSION, NR_FILES };
