// 話題偵測門檻校準（S8 步驟 D）。用法：node scripts/chat/topic_calibrate.js
// 讀 renderer/src/chat/topic_corpus.json，門檻 0.10 到 0.50（步長 0.05），同時設 sameThreshold 與 matchThreshold（同一個旋鈕）。
// 對每個門檻算：
//   - 該開沒開（漏判）：expectShift=true 但沒判轉移的比率。越低越好。
//   - 不該開卻開（誤開）：expectShift=false 但判轉移的比率。
//   - 明確延續句被誤開：類別 C（延續短句）中被誤開的比率。這是選門檻的硬限制：不超過 15%。
// 選擇規則（使用者決定「選速度快的方式，誤判寧可多開」）：在「明確延續句被誤開 ≤ 15%」的門檻中，選「該開沒開」最低者；
// 同樣低時選「不該開卻開」較低者（較少多開）。
// 語料是合成的（見 JSON 的說明），數字只代表這份語料，不代表真實對話的誤判率。
'use strict';
const fs = require('fs');
const path = require('path');
const L = require(path.join(__dirname, '..', '..', 'renderer', 'src', 'chat', 'topic_local.js'));

const corpusPath = path.join(__dirname, '..', '..', 'renderer', 'src', 'chat', 'topic_corpus.json');
const corpus = JSON.parse(fs.readFileSync(corpusPath, 'utf8'));
const cases = corpus.cases;

// 與 app 同一條路徑：目前話題的指紋 = 這則訊息之前的使用者訊息依序合併
function currentOf(history) {
  let fp = null;
  for (const h of history) fp = fp === null ? L.fingerprintOf(h) : L.mergeFingerprint(fp, h, L.DEFAULT_MAX_TERMS);
  return fp;
}

function evalAt(t) {
  const opts = { sameThreshold: t, matchThreshold: t };
  let pos = 0, miss = 0, neg = 0, falseOpen = 0, cont = 0, contFalseOpen = 0;
  const perCat = {};
  for (const c of cases) {
    const cur = currentOf(c.history);
    const predicted = L.detectShift(cur, [], c.message, opts).isShifted;
    const cat = c.cat;
    perCat[cat] = perCat[cat] || { n: 0, wrong: 0 };
    perCat[cat].n++;
    if (c.expectShift) { pos++; if (!predicted) { miss++; perCat[cat].wrong++; } }
    else { neg++; if (predicted) { falseOpen++; perCat[cat].wrong++; } }
    if (cat === 'C') { cont++; if (predicted) contFalseOpen++; }
  }
  return {
    t,
    missRate: pos ? miss / pos : 0, miss, pos,
    falseOpenRate: neg ? falseOpen / neg : 0, falseOpen, neg,
    contFalseOpenRate: cont ? contFalseOpen / cont : 0, contFalseOpen, cont,
    perCat,
  };
}

const thresholds = [];
for (let i = 0; i <= 8; i++) thresholds.push(Math.round((0.10 + i * 0.05) * 100) / 100);
const rows = thresholds.map(evalAt);

const pct = (x) => (x * 100).toFixed(1).padStart(5) + '%';
console.log('門檻  該開沒開(漏判)     不該開卻開(誤開)   明確延續句被誤開   分類錯誤(A/B/C/D/E)');
for (const r of rows) {
  const cats = ['A', 'B', 'C', 'D', 'E'].map((k) => (r.perCat[k] ? r.perCat[k].wrong + '/' + r.perCat[k].n : '-')).join(' ');
  console.log(r.t.toFixed(2) + '  ' + pct(r.missRate) + ' (' + r.miss + '/' + r.pos + ')   ' + pct(r.falseOpenRate) + ' (' + r.falseOpen + '/' + r.neg + ')   ' + pct(r.contFalseOpenRate) + ' (' + r.contFalseOpen + '/' + r.cont + ')   ' + cats);
}

const LIMIT = 0.15;
const feasible = rows.filter((r) => r.contFalseOpenRate <= LIMIT);
let chosen = null;
for (const r of feasible) {
  if (!chosen || r.missRate < chosen.missRate - 1e-12 || (Math.abs(r.missRate - chosen.missRate) < 1e-12 && r.falseOpenRate < chosen.falseOpenRate)) chosen = r;
}
console.log('');
console.log('明確延續句被誤開的上限：' + (LIMIT * 100) + '%');
console.log(chosen ? '選定門檻：' + chosen.t.toFixed(2) + '（該開沒開 ' + chosen.miss + '/' + chosen.pos + '，不該開卻開 ' + chosen.falseOpen + '/' + chosen.neg + '）' : '沒有符合上限的門檻');

module.exports = { evalAt, rows, chosen, thresholds };
if (require.main === module && process.argv.includes('--json')) console.log(JSON.stringify(rows.map((r) => ({ t: r.t, miss: r.missRate, falseOpen: r.falseOpenRate, cont: r.contFalseOpenRate }))));
