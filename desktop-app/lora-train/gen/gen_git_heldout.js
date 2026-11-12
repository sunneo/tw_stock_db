#!/usr/bin/env node
'use strict';
/*
 * group/git 留出列擴充（toolcall v2，見 EVAL_CRITERIA_v2.md「group/git 要擴到至少 20 列」）。
 *
 * 做法：git_* 工具（7 個，其中只有 git_inspect 是 heldout 工具；其餘 6 個是訓練池的「已見工具」）
 * 的新說法，全部是訓練資料裡沒有的句子（腳本會和 train 檔逐字比對，有重複就中止）。
 * 每列的 gold 是一個 <tool_call>，參數必須符合工具 schema（未知參數、缺必填、enum 錯都丟掉）。
 * 說法是人工寫的口語句，不是程式模板，所以不會和訓練題的模板句撞上。
 *
 * 用法（在 lora-train 目錄下）：
 *   node gen/gen_git_heldout.js <out_heldout_git.jsonl> <out_heldout_toolcall_v2.jsonl> <heldout_toolcall_v1.jsonl> [train files...]
 *
 * 輸出：只含新增的 git 留出列；另外把 v1 留出（528 列）＋新列寫成 v2 留出檔。
 */
const fs = require('fs');
const path = require('path');
const C = require('./w2c_common.js');

// [工具名, 使用者說法, 參數]。參數只放使用者原話有的值（格式照工具說明：fap:<名稱>）。
const PHRASES = [
    ['git_status', '請看一下 fap:專案A 的 git 狀態', { ref: 'fap:專案A' }],
    ['git_status', 'fap:報告 這個資料夾有哪些還沒 commit 的變更？', { ref: 'fap:報告' }],
    ['git_status', 'check git status of fap:tools-repo', { ref: 'fap:tools-repo' }],
    ['git_status', '看看 fap:預算表 現在改了什麼', { ref: 'fap:預算表' }],

    ['git_log', '列出 fap:專案A 最近的 commit 紀錄', { ref: 'fap:專案A' }],
    ['git_log', 'show the commit history of fap:報告', { ref: 'fap:報告' }],
    ['git_log', 'fap:預算表 的提交記錄給我看', { ref: 'fap:預算表' }],
    ['git_log', 'what were the latest commits in fap:tools-repo?', { ref: 'fap:tools-repo' }],

    ['git_pull', '把 fap:專案A 從遠端拉最新版', { ref: 'fap:專案A' }],
    ['git_pull', 'pull the latest changes for fap:報告', { ref: 'fap:報告' }],
    ['git_pull', 'fap:預算表 幫我 git pull 一下', { ref: 'fap:預算表' }],
    ['git_pull', 'update fap:tools-repo from its remote', { ref: 'fap:tools-repo' }],

    ['git_push', '把 fap:專案A 的提交推到遠端', { ref: 'fap:專案A' }],
    ['git_push', 'push fap:報告 to the remote', { ref: 'fap:報告' }],
    ['git_push', 'fap:預算表 推上去吧', { ref: 'fap:預算表' }],
    ['git_push', 'push the commits of fap:tools-repo', { ref: 'fap:tools-repo' }],

    ['git_commit', '在 fap:專案A 提交，訊息是 修正排版', { ref: 'fap:專案A', message: '修正排版' }],
    ['git_commit', 'commit fap:報告 with message "fix typo"', { ref: 'fap:報告', message: 'fix typo' }],
    ['git_commit', 'fap:預算表 幫我 commit，說明寫 更新數字', { ref: 'fap:預算表', message: '更新數字' }],
    ['git_commit', 'commit the changes in fap:tools-repo with message update readme', { ref: 'fap:tools-repo', message: 'update readme' }],

    ['git_clone', '把 https://github.com/example/demo.git clone 到 fap:專案A', { ref: 'fap:專案A', url: 'https://github.com/example/demo.git' }],
    ['git_clone', 'clone https://github.com/example/notes.git into fap:報告', { ref: 'fap:報告', url: 'https://github.com/example/notes.git' }],
    ['git_clone', '幫我把 https://github.com/example/budget.git 下載到 fap:預算表', { ref: 'fap:預算表', url: 'https://github.com/example/budget.git' }],
    ['git_clone', 'fap:tools-repo 請 clone https://github.com/example/tools.git', { ref: 'fap:tools-repo', url: 'https://github.com/example/tools.git' }],
];

// 與 gen_natural.js 的 valid() 相同的判準：未知參數、enum 不合、缺必填都丟掉
function valid(t, args) {
    const p = t.parameters.properties || {}; const req = t.parameters.required || [];
    for (const k of Object.keys(args)) {
        if (!p[k]) return 'unknown param ' + k;
        if (p[k].enum && !p[k].enum.includes(args[k])) return 'bad enum ' + k + '=' + args[k];
    }
    for (const k of req) if (!(k in args)) return 'missing required ' + k;
    return null;
}

function trainTexts(files) {
    const set = new Set();
    for (const f of files) {
        if (!fs.existsSync(f)) continue;
        for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
            if (!line.trim()) continue;
            let r; try { r = JSON.parse(line); } catch (e) { continue; }
            if (r.split && r.split !== 'train') continue;
            for (const m of r.messages || []) if (m.role === 'user') set.add(String(m.content).trim());
        }
    }
    return set;
}

function build() {
    const rows = []; const dropped = [];
    PHRASES.forEach(([name, text, args], idx) => {
        const t = C.BY_NAME[name];
        if (!t) { dropped.push(name + ': 工具不存在'); return; }
        const bad = valid(t, args);
        if (bad) { dropped.push(name + '[' + idx + ']: ' + bad); return; }
        const rand = C.rng('git_heldout:' + name + ':' + idx);
        const list = C.toolList(t, rand, 3, 7);
        rows.push({
            id: 'heldout_git:' + name + ':' + idx,
            domain: 'natural', stage: 'natural_call',
            messages: [C.sysMsg(), { role: 'user', content: text }],
            tools: list.map(C.toolSpec),
            completion: C.toolCall(name, args),
            verified_by: 'program_ground_truth', split: 'heldout',
            source_file: 'lora-train/gen/gen_git_heldout.js',
            meta: { behavior: 'call', tool: name, group: C.groupOf(t), check: { kind: 'call', name, args }, phrasing_index: idx, tool_heldout: !!t.heldout },
            task: 'natural', kind: 'call', group: C.groupOf(t), tool: name, seen: t.heldout ? 'unseen' : 'seen', prefill: '',
        });
    });
    return { rows, dropped };
}

function main() {
    const [outGit, outV2, v1File, ...trainFiles] = process.argv.slice(2);
    if (!outGit || !outV2 || !v1File) {
        console.error('用法: node gen/gen_git_heldout.js <out_heldout_git.jsonl> <out_heldout_toolcall_v2.jsonl> <heldout_toolcall_v1.jsonl> [train files...]');
        process.exit(2);
    }
    const { rows, dropped } = build();
    if (dropped.length) { console.error('丟掉：\n  ' + dropped.join('\n  ')); process.exit(1); }
    const tr = trainTexts(trainFiles);
    const clash = rows.filter((r) => tr.has(r.messages[1].content.trim()));
    if (clash.length) { console.error('與訓練題逐字重複，中止：' + clash.map((r) => r.id).join(', ')); process.exit(1); }
    fs.writeFileSync(outGit, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
    const v1 = fs.readFileSync(v1File, 'utf8');
    const v1Rows = v1.split('\n').filter((l) => l.trim());
    fs.writeFileSync(outV2, v1Rows.join('\n') + '\n' + rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
    const gitCount = (lines) => lines.map((l) => JSON.parse(l)).filter((r) => (r.group || (r.meta || {}).family) === 'git').length;
    console.error('[gen_git_heldout] 新增 ' + rows.length + ' 列（git 組）；v1 留出 ' + v1Rows.length + ' 列；v2 留出 ' + (v1Rows.length + rows.length) + ' 列；v2 內 group/git 共 ' + gitCount(v1Rows.concat(rows.map((r) => JSON.stringify(r)))) + ' 列');
}

if (require.main === module) main();
module.exports = { PHRASES, build, valid };
