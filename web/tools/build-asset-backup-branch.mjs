#!/usr/bin/env node
// ============================================================
// tw_stock_db 客製: 2026-09-16
// 通用版的「大型二進位資源→orphan分支」打包工具，從
// build-whisper-backup-branch.mjs（whisper-model-backup分支的專用版）抽出
// 共用邏輯改寫成generic：不寫死抓哪個模型，改成吃一個本機來源目錄（遞迴
// 掃描），逐檔案切成PART_SIZE（預設20MB）份、產生manifest.json、建立
// single-commit的orphan分支、force-push。使用者明確要求「這種branch是
// always force push，只放這類套件，一個binary一個branch」——這支工具就是
// 拿來重複套用這個慣例的通用版，之後任何新的大型二進位資源（bash/python/
// C compiler to wasm/nodejs等執行環境）都用同一支工具，不用每次照抄一份
// whisper那樣的專用腳本。
//
// 用法：
//   node web/tools/build-asset-backup-branch.mjs --source <dir> --branch <name> --subdir <name>
//     # 只切割+產生manifest到staging，不碰git
//   ... --commit    # 額外建好orphan分支並commit（不push）
//   ... --commit --push   # 連force-push一起做（會動到公開repo，慎用）
//   ... --part-size <bytes>   # 選填，預設20MB（20*1024*1024）
//   ... --readme "<純文字說明>"   # 選填，寫進分支README.md開頭那段說明
//
// 產生的manifest.json格式跟WHISPER_MODEL_BACKUP_FILES / _prefetchWhisperModelFromRepo
// 讀的格式完全對齊：{ generated_at, part_size, files: [{path, size, sha256, parts}] }
// ——floating-assistant.js讀取端（見_fetchAssetBackupFile的說明）兩邊共用同一套
// 合併邏輯，不用為每個新資源各自刻一份解析程式碼。
// ============================================================
import { createHash } from 'node:crypto';
import { mkdir, writeFile, rm, readFile, readdir, stat } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
const DEFAULT_PART_SIZE = 20 * 1024 * 1024;

function parseArgs(argv) {
    const out = { commit: false, push: false, partSize: DEFAULT_PART_SIZE, readme: '' };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--source') out.source = argv[++i];
        else if (a === '--branch') out.branch = argv[++i];
        else if (a === '--subdir') out.subdir = argv[++i];
        else if (a === '--part-size') out.partSize = Number(argv[++i]);
        else if (a === '--readme') out.readme = argv[++i];
        else if (a === '--commit') out.commit = true;
        else if (a === '--push') out.push = true;
    }
    if (!out.source || !out.branch || !out.subdir) {
        console.error('用法: node build-asset-backup-branch.mjs --source <dir> --branch <name> --subdir <name> [--part-size N] [--commit] [--push] [--readme "..."]');
        process.exit(1);
    }
    return out;
}

function sh(cmd, cmdArgs, cwd) {
    return execFileSync(cmd, cmdArgs, { cwd, stdio: ['ignore', 'pipe', 'inherit'] }).toString().trim();
}

// 遞迴列出source目錄底下所有檔案的相對路徑（用'/'分隔，跨平台一致，manifest
// 裡的path就是這個相對路徑，也是_fetchAssetBackupFile()組URL時的路徑片段）。
async function walkFiles(dir, base = dir) {
    const entries = await readdir(dir, { withFileTypes: true });
    let out = [];
    for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
            out = out.concat(await walkFiles(full, base));
        } else if (e.isFile()) {
            out.push(path.relative(base, full).split(path.sep).join('/'));
        }
    }
    return out;
}

async function main() {
    const opts = parseArgs(process.argv.slice(2));
    const sourceDir = path.resolve(opts.source);
    const staging = path.join(__dirname, `_asset-backup-staging-${opts.branch}`);
    const stageSub = path.join(staging, opts.subdir);

    console.log(`# 資源備份分支建置：${opts.branch}（來源：${sourceDir}）`);
    await rm(staging, { recursive: true, force: true });
    await mkdir(stageSub, { recursive: true });

    const relFiles = (await walkFiles(sourceDir)).sort();
    if (!relFiles.length) throw new Error(`來源目錄 ${sourceDir} 底下沒有任何檔案`);

    const manifestFiles = [];
    let totalBytes = 0;
    for (const rel of relFiles) {
        const buf = await readFile(path.join(sourceDir, rel));
        totalBytes += buf.length;
        const sha256 = createHash('sha256').update(buf).digest('hex');
        const entry = { path: rel, size: buf.length, sha256, parts: null };
        const destPath = path.join(stageSub, rel);
        await mkdir(path.dirname(destPath), { recursive: true });
        if (buf.length > opts.partSize) {
            const n = Math.ceil(buf.length / opts.partSize);
            for (let i = 0; i < n; i++) {
                const slice = buf.subarray(i * opts.partSize, (i + 1) * opts.partSize);
                await writeFile(destPath + '.part' + String(i).padStart(3, '0'), slice);
            }
            entry.parts = n;
            console.log(`  ${rel}: ${(buf.length / 1048576).toFixed(2)} MB → 切成 ${n} 份`);
        } else {
            await writeFile(destPath, buf);
            console.log(`  ${rel}: ${(buf.length / 1048576).toFixed(2)} MB`);
        }
        manifestFiles.push(entry);
    }

    const manifest = {
        generated_at: new Date().toISOString(),
        part_size: opts.partSize,
        files: manifestFiles,
    };
    await writeFile(path.join(stageSub, 'manifest.json'), JSON.stringify(manifest, null, 2));
    await writeFile(path.join(staging, 'README.md'),
        `# ${opts.branch}\n\n${opts.readme || `Single-commit binary asset backup, generated by build-asset-backup-branch.mjs from ${path.basename(sourceDir)}.`}\n\n` +
        `Files split into ${(opts.partSize / 1048576).toFixed(0)}MB parts where needed (see \`${opts.subdir}/manifest.json\`). ` +
        `This branch is force-pushed on regeneration — it holds exactly one binary asset, nothing else, and carries no history.\n`);

    console.log(`\n# staging 完成：${staging}（合計 ${(totalBytes / 1048576).toFixed(1)} MB，${relFiles.length} 個檔案）`);

    if (!opts.commit) {
        console.log(`\n下一步：加 --commit 建 orphan 分支，再加 --push 才會 force-push。`);
        return;
    }

    const tmpClone = path.join(staging, '_repo');
    const originUrl = sh('git', ['-C', REPO_ROOT, 'remote', 'get-url', 'origin']);
    console.log(`\n# clone ${originUrl} → ${tmpClone}`);
    await rm(tmpClone, { recursive: true, force: true });
    sh('git', ['clone', '--no-checkout', '--depth', '1', originUrl, tmpClone]);
    sh('git', ['-C', tmpClone, 'checkout', '--orphan', opts.branch]);
    sh('git', ['-C', tmpClone, 'rm', '-rf', '--quiet', '--ignore-unmatch', '.']);
    sh('cp', ['-r', stageSub, path.join(tmpClone, opts.subdir)]);
    await writeFile(path.join(tmpClone, 'README.md'), await readFile(path.join(staging, 'README.md')));
    sh('git', ['-C', tmpClone, 'add', '-A']);
    sh('git', ['-C', tmpClone, 'commit', '-m', `${opts.branch} — ${manifest.generated_at}`]);
    console.log(`\n# orphan 分支 ${opts.branch} 已在 ${tmpClone} 建好並 commit`);

    if (opts.push) {
        console.log(`\n# force-push ${opts.branch} → origin`);
        sh('git', ['-C', tmpClone, 'push', '--force', 'origin', opts.branch]);
        console.log('# 完成');
    } else {
        console.log(`\n要 push 請執行：\n  git -C "${tmpClone}" push --force origin ${opts.branch}`);
    }
}

main().catch((err) => { console.error('\n[失敗]', err); process.exit(1); });
