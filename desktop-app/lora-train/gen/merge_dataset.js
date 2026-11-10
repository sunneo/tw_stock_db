#!/usr/bin/env node
/* Merge every domain generator's output into lora-train/data/{train,heldout}.jsonl.
 * Each gen_*.js module exports generate() -> rows[] following lora-train/schema.md's
 * unified format. This script does NOT invent or filter content beyond what schema.md
 * requires (valid split, required fields present, dedup by id) -- it reports counts
 * honestly rather than padding or silently dropping rows.
 */
const fs = require('fs');
const path = require('path');

const GEN_DIR = __dirname;
const DATA_DIR = path.join(__dirname, '..', 'data');

const GENERATORS = [
  'gen_tool_routing.js',
  'gen_colu.js',
  'gen_uml_design.js',
  'gen_think_stack.js',
  'gen_blockly_matrix.js',
  'gen_fn_template.js',
];

const REQUIRED_FIELDS = ['id', 'domain', 'stage', 'messages', 'completion', 'verified_by', 'split', 'source_file'];

async function loadGenerator(file) {
  const full = path.join(GEN_DIR, file);
  if (!fs.existsSync(full)) {
    return { file, rows: null, error: 'file does not exist yet' };
  }
  try {
    // clear require cache so re-running merge after editing a generator picks up changes
    delete require.cache[require.resolve(full)];
    const mod = require(full);
    if (typeof mod.generate !== 'function') {
      return { file, rows: null, error: 'module does not export generate()' };
    }
    // generate() may be sync (return an array) or async (return a Promise<array>) --
    // every generator so far uses async because the real production functions they
    // call (chooseTool/judge/...) are async, so always await.
    const rows = await mod.generate();
    if (!Array.isArray(rows)) {
      return { file, rows: null, error: 'generate() did not return an array (or a Promise of one)' };
    }
    return { file, rows, error: null };
  } catch (e) {
    return { file, rows: null, error: `threw: ${e && e.stack || e}` };
  }
}

function validateRow(row, file, idx) {
  const problems = [];
  for (const f of REQUIRED_FIELDS) {
    if (row[f] === undefined || row[f] === null || row[f] === '') problems.push(`missing ${f}`);
  }
  if (row.messages && !Array.isArray(row.messages)) problems.push('messages is not an array');
  if (row.split && row.split !== 'train' && row.split !== 'heldout') {
    problems.push(`split must be 'train' or 'heldout', got ${JSON.stringify(row.split)}`);
  }
  if (problems.length) return `${file}[${idx}] (id=${row.id || '?'}): ${problems.join('; ')}`;
  return null;
}

async function main() {
  fs.mkdirSync(DATA_DIR, { recursive: true });

  const allRows = [];
  const seenIds = new Set();
  const report = { perFile: {}, perDomainStage: {}, errors: [], duplicateIds: 0 };

  for (const file of GENERATORS) {
    const { rows, error } = await loadGenerator(file);
    if (error) {
      report.perFile[file] = { status: 'error', detail: error, rows: 0 };
      report.errors.push(`${file}: ${error}`);
      continue;
    }
    let kept = 0;
    let rejected = 0;
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const problem = validateRow(row, file, i);
      if (problem) {
        report.errors.push(problem);
        rejected++;
        continue;
      }
      if (seenIds.has(row.id)) {
        report.duplicateIds++;
        rejected++;
        continue;
      }
      seenIds.add(row.id);
      allRows.push(row);
      kept++;
      const key = `${row.domain}/${row.stage}`;
      report.perDomainStage[key] = (report.perDomainStage[key] || 0) + 1;
    }
    report.perFile[file] = { status: 'ok', rows: kept, rejected };
  }

  const trainRows = allRows.filter((r) => r.split === 'train');
  const heldoutRows = allRows.filter((r) => r.split === 'heldout');

  const trainPath = path.join(DATA_DIR, 'train.jsonl');
  const heldoutPath = path.join(DATA_DIR, 'heldout.jsonl');
  fs.writeFileSync(trainPath, trainRows.map((r) => JSON.stringify(r)).join('\n') + (trainRows.length ? '\n' : ''));
  fs.writeFileSync(heldoutPath, heldoutRows.map((r) => JSON.stringify(r)).join('\n') + (heldoutRows.length ? '\n' : ''));

  console.log('=== merge_dataset.js report ===');
  console.log('Per-generator file status:');
  for (const file of GENERATORS) {
    const info = report.perFile[file] || { status: 'missing', rows: 0 };
    console.log(`  ${file}: ${info.status} rows=${info.rows}${info.rejected ? ' rejected=' + info.rejected : ''}${info.detail ? ' (' + info.detail + ')' : ''}`);
  }
  console.log(`\nTotal valid rows: ${allRows.length} (train=${trainRows.length}, heldout=${heldoutRows.length})`);
  console.log(`Duplicate ids skipped: ${report.duplicateIds}`);
  console.log('\nRows per domain/stage:');
  for (const [key, n] of Object.entries(report.perDomainStage).sort()) {
    console.log(`  ${key}: ${n}`);
  }
  if (report.errors.length) {
    console.log(`\n${report.errors.length} row-level problem(s) (first 20 shown):`);
    for (const e of report.errors.slice(0, 20)) console.log(`  - ${e}`);
  }
  console.log(`\nWrote ${trainPath}`);
  console.log(`Wrote ${heldoutPath}`);
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
module.exports = { main };
