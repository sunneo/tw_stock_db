#!/usr/bin/env node
// ============================================================
// tw_stock_db 客製: 2026-09-11
// 把 floating-assistant.js transcribe_media 用的 Whisper 模型（dtype=q8 的
// onnx-community/whisper-base）從 HuggingFace 抓下來、大檔切成 20MB 一份，
// 產生一個 single-commit 的 orphan 分支 `whisper-model-backup`，當 HuggingFace
// 直抓失敗時的退路來源（floating-assistant.js 的 _prefetchWhisperModelFromRepo
// 會讀這個分支的 manifest.json、把 part 合併回來塞進 transformers-cache）。
//
// 用法：
//   node web/tools/build-whisper-backup-branch.mjs            # 只下載+切割+產 manifest 到 staging
//   node web/tools/build-whisper-backup-branch.mjs --commit   # 額外在暫存 clone 裡建好 orphan 分支並 commit（不 push）
//   node web/tools/build-whisper-backup-branch.mjs --commit --push   # 連 force-push 一起做（會動到公開 repo，慎用）
//
// 檔案清單、切割大小、HF base、分支名、目錄名要跟 floating-assistant.js 的
// WHISPER_MODEL_BACKUP_FILES / WHISPER_MODEL_BACKUP_PART_SIZE /
// WHISPER_HF_RESOLVE_BASE / FA_ASSET_URLS.whisperModelBackupBase 對齊。
// ============================================================
import { createHash } from 'node:crypto';
import { mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { get as httpsGet } from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MODEL_ID = 'onnx-community/whisper-base';
const DTYPE = 'q8';
const HF_BASE = `https://huggingface.co/${MODEL_ID}/resolve/main/`;
const PART_SIZE = 20 * 1024 * 1024;
const BRANCH = 'whisper-model-backup';
const SUBDIR = 'whisper-base-q8';
const FILES = [
    'config.json',
    'preprocessor_config.json',
    'tokenizer_config.json',
    'tokenizer.json',
    'generation_config.json',
    'onnx/encoder_model_quantized.onnx',
    'onnx/decoder_model_merged_quantized.onnx',
];

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');           // D:\Downloads\videos-嗨投資
const STAGING = path.join(__dirname, '_whisper-backup-staging');
const STAGE_SUB = path.join(STAGING, SUBDIR);

const args = process.argv.slice(2);
const DO_COMMIT = args.includes('--commit');
const DO_PUSH = args.includes('--push');

function sh(cmd, cmdArgs, cwd) {
    return execFileSync(cmd, cmdArgs, { cwd, stdio: ['ignore', 'pipe', 'inherit'] }).toString().trim();
}

function fetchBuffer(url, redirectsLeft = 5) {
    return new Promise((resolve, reject) => {
        httpsGet(url, (res) => {
            if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
                res.resume();
                if (redirectsLeft <= 0) return reject(new Error('too many redirects'));
                const next = new URL(res.headers.location, url).toString();
                return resolve(fetchBuffer(next, redirectsLeft - 1));
            }
            if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode} for ${url}`)); }
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => resolve(Buffer.concat(chunks)));
            res.on('error', reject);
        }).on('error', reject);
    });
}

async function download(relPath) {
    process.stdout.write(`  下載 ${relPath} … `);
    const buf = await fetchBuffer(HF_BASE + relPath);
    console.log(`${(buf.length / 1048576).toFixed(2)} MB`);
    return buf;
}

async function main() {
    console.log(`# Whisper 備份分支建置：${MODEL_ID} (dtype=${DTYPE})`);
    await rm(STAGING, { recursive: true, force: true });
    await mkdir(STAGE_SUB, { recursive: true });
    await mkdir(path.join(STAGE_SUB, 'onnx'), { recursive: true });

    const manifestFiles = [];
    for (const rel of FILES) {
        const buf = await download(rel);
        const sha256 = createHash('sha256').update(buf).digest('hex');
        const entry = { path: rel, size: buf.length, sha256, parts: null };
        if (buf.length > PART_SIZE) {
            const n = Math.ceil(buf.length / PART_SIZE);
            for (let i = 0; i < n; i++) {
                const slice = buf.subarray(i * PART_SIZE, (i + 1) * PART_SIZE);
                await writeFile(path.join(STAGE_SUB, rel + '.part' + String(i).padStart(3, '0')), slice);
            }
            entry.parts = n;
            console.log(`    → 切成 ${n} 份`);
        } else {
            await writeFile(path.join(STAGE_SUB, rel), buf);
        }
        manifestFiles.push(entry);
    }

    const manifest = {
        model: MODEL_ID,
        dtype: DTYPE,
        hf_base: HF_BASE,
        part_size: PART_SIZE,
        generated_at: new Date().toISOString(),
        files: manifestFiles,
    };
    await writeFile(path.join(STAGE_SUB, 'manifest.json'), JSON.stringify(manifest, null, 2));
    await writeFile(path.join(STAGING, 'README.md'),
        `# ${BRANCH}\n\nSingle-commit backup of the Whisper \`${DTYPE}\` model (\`${MODEL_ID}\`) used by ` +
        `floating-assistant.js \`transcribe_media\`. Large files split into ${PART_SIZE / 1048576}MB parts.\n\n` +
        `Consumed by \`_prefetchWhisperModelFromRepo()\` when the HuggingFace fetch fails. ` +
        `Regenerate with \`node web/tools/build-whisper-backup-branch.mjs --commit --push\`.\n`);

    const totalMB = manifestFiles.reduce((a, f) => a + f.size, 0) / 1048576;
    console.log(`\n# staging 完成：${STAGING}  (合計 ${totalMB.toFixed(1)} MB)`);

    if (!DO_COMMIT) {
        console.log(`\n下一步：加 --commit 建 orphan 分支，再加 --push 才會 force-push。`);
        return;
    }

    // 在暫存 clone 裡做 orphan 分支，不碰使用者目前的工作樹
    const tmpClone = path.join(STAGING, '_repo');
    const originUrl = sh('git', ['-C', REPO_ROOT, 'remote', 'get-url', 'origin']);
    console.log(`\n# clone ${originUrl} → ${tmpClone}`);
    await rm(tmpClone, { recursive: true, force: true });
    sh('git', ['clone', '--no-checkout', '--depth', '1', originUrl, tmpClone]);
    sh('git', ['-C', tmpClone, 'checkout', '--orphan', BRANCH]);
    sh('git', ['-C', tmpClone, 'rm', '-rf', '--quiet', '--ignore-unmatch', '.']);
    // 複製 staging 內容進 clone
    sh(process.platform === 'win32' ? 'xcopy' : 'cp',
        process.platform === 'win32'
            ? [STAGE_SUB.replace(/\//g, '\\'), path.join(tmpClone, SUBDIR).replace(/\//g, '\\'), '/E', '/I', '/Y', '/Q']
            : ['-r', STAGE_SUB, path.join(tmpClone, SUBDIR)]);
    await writeFile(path.join(tmpClone, 'README.md'), await readFile(path.join(STAGING, 'README.md')));
    sh('git', ['-C', tmpClone, 'add', '-A']);
    sh('git', ['-C', tmpClone, 'commit', '-m', `Whisper ${DTYPE} model backup (${MODEL_ID}) — ${manifest.generated_at}`]);
    console.log(`\n# orphan 分支 ${BRANCH} 已在 ${tmpClone} 建好並 commit`);

    if (DO_PUSH) {
        console.log(`\n# force-push ${BRANCH} → origin`);
        sh('git', ['-C', tmpClone, 'push', '--force', 'origin', BRANCH]);
        console.log('# 完成');
    } else {
        console.log(`\n要 push 請執行：\n  git -C "${tmpClone}" push --force origin ${BRANCH}`);
    }
}

main().catch((err) => { console.error('\n[失敗]', err); process.exit(1); });
