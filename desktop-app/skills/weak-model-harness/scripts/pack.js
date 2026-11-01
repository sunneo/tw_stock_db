#!/usr/bin/env node
/* 把 skill 用到的核心複製進 scripts/vendor/，讓整個資料夾搬走也能跑（不依賴 repo）。
 *   node scripts/pack.js          複製
 * 載入順序：loop_core／harness 先找 ./vendor/，找不到才找 repo 內的來源。
 */
'use strict';
const fs = require('fs'); const path = require('path');
const root = path.join(__dirname, '..', '..', '..');
const files = [['renderer/src/recipe/recipe_core.js', 'recipe_core.js'], ['renderer/src/harness/experience_core.js', 'experience_core.js']];
const outDir = path.join(__dirname, 'vendor'); fs.mkdirSync(outDir, { recursive: true });
for (const [src, name] of files) { fs.copyFileSync(path.join(root, src), path.join(outDir, name)); console.log('已複製', name); }
