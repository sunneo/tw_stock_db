// node scripts/deck-tests/deck_starters.test.js -- /edit-media-presentation 起手式：空白簡報（只有標題頁）、三頁介紹；沒有最近簡報時的起始面板與指令
const fs = require('fs');
const path = require('path');
const E = require('../../renderer/src/deck/deck_edit_core.js');
let ok = 0; const bad = [];
function check(name, cond, extra) { if (cond) ok++; else bad.push(name + (extra !== undefined ? ' ' + JSON.stringify(extra).slice(0, 400) : '')); }
const canon = (o) => JSON.stringify(o, (k, v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.keys(v).sort().reduce((a, x) => { a[x] = v[x]; return a; }, {}) : v));
const HOST = fs.readFileSync(path.join(__dirname, '..', '..', 'renderer', 'src', 'deck', 'deck_edit_host.js'), 'utf8');

// ── 核心：起手式清單與內容
const ids = E.listStarters().map((s) => s.id);
check('starters: exactly blank and intro3 (the old "last" placeholder is gone)', canon(ids) === canon(['blank', 'intro3']), ids);
check('starters: each one has a label and a one-line desc', E.listStarters().every((s) => s.label && s.desc && s.desc.indexOf('\n') < 0), E.listStarters());

const blank = E.starter('blank');
check('blank: one chapter with exactly one slide, a title page', E.slides(blank).length === 1 && E.slides(blank)[0].slide.layout === 'title', E.slides(blank));
check('blank: a title page has a subtitle to replace', E.slides(blank)[0].slide.subtitle === '副標題寫在這裡', E.slides(blank)[0].slide);
const i3 = E.starter('intro3');
check('intro3: three slides in order: title, bullets, closing', E.slides(i3).length === 3 && E.slides(i3).map((o) => o.slide.layout).join() === 'title,content,title', E.slides(i3).map((o) => o.slide.layout));
check('intro3: the middle page has three bullets and narration', E.slides(i3)[1].slide.bullets.length === 3 && E.slides(i3)[1].slide.narration.length > 0, E.slides(i3)[1].slide);
check('starter: unknown id returns null (the caller falls back to blank)', E.starter('nope') === null && E.starter('') !== null);
check('starter: empty id means blank', canon(E.toDoc(E.starter(''))) === canon(E.toDoc(blank)));
check('starter: every starter survives a doc round trip (what the editor saves and reopens)', ['blank', 'intro3'].every((id) => canon(E.toDoc(E.fromDoc(E.toDoc(E.starter(id))))) === canon(E.toDoc(E.starter(id)))));
check('starter: validate keeps the slides (no problems dropped)', ['blank', 'intro3'].every((id) => E.slides(E.validate(E.starter(id)).spec).length === E.slides(E.starter(id)).length));

// ── 桌面版指令（原始碼）：起手式 id 先於「最近的簡報」；沒有最近的簡報時說明列出起手式
check('host: a starter id opens a new deck even when a recent deck exists', /const st = FaDeckEdit\.listStarters\(\)\.filter\(\(s\) => s\.id === a\.toLowerCase\(\)\)\[0\];\s*if \(st\) \{ const res0 = await r\._edOpen\('edit-media-presentation', \{ starter: st\.id \}\)/.test(HOST));
check('host: the starter check runs before the recent-deck lookup', HOST.indexOf('if (st) { const res0') < HOST.indexOf('let url = idLike'));
check('host: no recent deck and no argument shows the help with the starter list', /if \(!url\) \{ r\._pushAssistantMessage\(H\.KINDS\['edit-media-presentation'\]\.help\(FaDeckEdit\.listStarters\(\)\), null\); \}/.test(HOST));
check('host: help appends the starter lines, and only when there are starters', /startersText = \(starters\) => \(starters && starters\.length \?/.test(HOST) && /\+ startersText\(starters\),/.test(HOST));
check('host: a recent deck still opens on no argument (the original behavior)', /else \{ const res = await r\._deckEditOpen\(url, request\)/.test(HOST));

console.log('deck_starters: ' + ok + ' passed' + (bad.length ? ', ' + bad.length + ' FAILED:\n - ' + bad.join('\n - ') : '')); process.exit(bad.length ? 1 : 0);
