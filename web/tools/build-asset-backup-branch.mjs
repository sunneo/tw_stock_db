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
// 2026-09-16補充：使用者這次要求「新工具（jq-wasm/xq用的XML parser）共用
// 1個新branch」，跟「一個binary一個branch」的既有規則並存——差別是「這次
// 新增的這幾個小工具彼此共用1個新branch」，不是要推翻既有bash-wasm-backup/
// pyodide-backup各自獨立的既有安排。這裡新增支援：`--source`/`--subdir`
// 可以重複出現多組（依出現順序配對，每個`--source`開一組新的pair、緊接著
// 的`--subdir`填進同一組），全部pair各自切割+產生manifest到各自的
// `staging/<subdir>/`，但只做**一次**`--orphan`+commit，讓多個工具的內容
// 一起進同一個single-commit分支。只給一組`--source`/`--subdir`時行為跟
// 改動前完全一樣（現有bash-wasm-backup/pyodide-backup的重建流程不受影響）。
//
// 用法：
//   node web/tools/build-asset-backup-branch.mjs --source <dir> --branch <name> --subdir <name>
//     # 只切割+產生manifest到staging，不碰git
//   ... --source <dir2> --subdir <name2>   # 可重複多組，全部進同一個branch
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
import { mkdir, writeFile, rm, readFile, readdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
const DEFAULT_PART_SIZE = 20 * 1024 * 1024;

function parseArgs(argv) {
    const out = { commit: false, push: false, partSize: DEFAULT_PART_SIZE, readme: '', pairs: [] };
    let current = null;
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--source') {
            current = { source: argv[++i], subdir: null };
            out.pairs.push(current);
        } else if (a === '--subdir') {
            if (!current) { console.error('用法錯誤：--subdir 必須緊接在對應的 --source 之後'); process.exit(1); }
            current.subdir = argv[++i];
        } else if (a === '--branch') out.branch = argv[++i];
        else if (a === '--part-size') out.partSize = Number(argv[++i]);
        else if (a === '--readme') out.readme = argv[++i];
        else if (a === '--commit') out.commit = true;
        else if (a === '--push') out.push = true;
    }
    if (!out.branch || !out.pairs.length || out.pairs.some(p => !p.source || !p.subdir)) {
        console.error('用法: node build-asset-backup-branch.mjs --source <dir> --branch <name> --subdir <name> [--source <dir2> --subdir <name2> ...] [--part-size N] [--commit] [--push] [--readme "..."]');
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

// 把一組{source,subdir}切割+產生manifest，寫進staging/<subdir>/底下。
// 回傳這組的統計數字，給main()彙總log用。
async function stageOnePair(pair, staging, partSize) {
    const sourceDir = path.resolve(pair.source);
    const stageSub = path.join(staging, pair.subdir);
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
        if (buf.length > partSize) {
            const n = Math.ceil(buf.length / partSize);
            for (let i = 0; i < n; i++) {
                const slice = buf.subarray(i * partSize, (i + 1) * partSize);
                await writeFile(destPath + '.part' + String(i).padStart(3, '0'), slice);
            }
            entry.parts = n;
            console.log(`  [${pair.subdir}] ${rel}: ${(buf.length / 1048576).toFixed(2)} MB → 切成 ${n} 份`);
        } else {
            await writeFile(destPath, buf);
            console.log(`  [${pair.subdir}] ${rel}: ${(buf.length / 1048576).toFixed(2)} MB`);
        }
        manifestFiles.push(entry);
    }

    const manifest = {
        generated_at: new Date().toISOString(),
        part_size: partSize,
        files: manifestFiles,
    };
    await writeFile(path.join(stageSub, 'manifest.json'), JSON.stringify(manifest, null, 2));
    return { subdir: pair.subdir, sourceDir, totalBytes, fileCount: relFiles.length, generatedAt: manifest.generated_at };
}

async function main() {
    const opts = parseArgs(process.argv.slice(2));
    const staging = path.join(__dirname, `_asset-backup-staging-${opts.branch}`);

    console.log(`# 資源備份分支建置：${opts.branch}（${opts.pairs.length} 組來源）`);
    await rm(staging, { recursive: true, force: true });

    const results = [];
    for (const pair of opts.pairs) {
        results.push(await stageOnePair(pair, staging, opts.partSize));
    }

    const generatedAt = new Date().toISOString();
    const summaryLines = results.map(r => `- \`${r.subdir}/\`：來源 ${path.basename(r.sourceDir)}，${r.fileCount} 個檔案，${(r.totalBytes / 1048576).toFixed(1)} MB`);
    await writeFile(path.join(staging, 'README.md'),
        `# ${opts.branch}\n\n${opts.readme || 'Single-commit binary asset backup, generated by build-asset-backup-branch.mjs.'}\n\n` +
        `這個branch可能同時裝著多個彼此獨立的小型資源（各自一個子資料夾），每個子資料夾底下都有自己的\`manifest.json\`（切成${(opts.partSize / 1048576).toFixed(0)}MB份數，需要時才切）：\n\n` +
        summaryLines.join('\n') + '\n\n' +
        `This branch is force-pushed on regeneration — it carries no history, only the current snapshot of the resources listed above.\n`);

    const totalBytes = results.reduce((s, r) => s + r.totalBytes, 0);
    const totalFiles = results.reduce((s, r) => s + r.fileCount, 0);
    console.log(`\n# staging 完成：${staging}（合計 ${(totalBytes / 1048576).toFixed(1)} MB，${totalFiles} 個檔案，${results.length} 組來源）`);

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
    for (const pair of opts.pairs) {
        sh('cp', ['-r', path.join(staging, pair.subdir), path.join(tmpClone, pair.subdir)]);
    }
    await writeFile(path.join(tmpClone, 'README.md'), await readFile(path.join(staging, 'README.md')));
    sh('git', ['-C', tmpClone, 'add', '-A']);
    sh('git', ['-C', tmpClone, 'commit', '-m', `${opts.branch} — ${generatedAt}`]);
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
