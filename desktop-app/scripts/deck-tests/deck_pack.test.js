// node test/media/deck_pack.test.js -- opening a .deckpack and the older .deck.zip (AiChatDeckPack.open), and collecting assets for an export, against a fake browser
// (the real JSZip, the real js-yaml, the real deck core; Session / Player are recorded, not run).
const path = require('path');
const JSZip = require('jszip');
const yaml = require('js-yaml');
const Core = require('../../renderer/src/deck/deck_core.js');
let ok = 0; const bad = [];
function check(n, c, x) { if (c) ok++; else bad.push(n + (x !== undefined ? ' ' + JSON.stringify(x).slice(0, 300) : '')); }

let blobSeq = 0;
const made = [];
global.Blob = class { constructor(parts, o) { this.parts = parts; this.type = (o && o.type) || ''; } };
const fakeDocument = { createElement: () => ({ style: {}, remove() {}, className: '', textContent: '' }) };
const sessions = [];
class FakeSession { constructor(deck, raw, url) { this.deck = deck; this.raw = raw; this.url = url; sessions.push(this); } }
class FakePlayer { constructor(session, container) { this.session = session; this.container = container; } }
function install() {
  global.window = global; global.document = fakeDocument;
  global.URL = { createObjectURL: (b) => { const u = 'blob:fake/' + (++blobSeq); made.push({ u, type: b.type }); return u; } };
  global.AiChatMarkdown = { pptxKit: { ensureLibs: () => { global.JSZip = JSZip; return Promise.resolve(); } } };
  global.AiChat2D = { ensureJsYamlLoaded: () => { global.jsyaml = yaml; return Promise.resolve(); } };
  global.AiChatDeckCore = Core;
  global.AiChatDeck = { Session: FakeSession, Player: FakePlayer };
  global.AiChatFileSink = { CLIENT_FILE_PREFIX: 'client-file/' };
}
install();
const Pack = require('../../renderer/src/deck/deck_pack.js') && global.AiChatDeckPack;

const DECK = { deck: { title: 'T', lang: 'zh-TW' }, chapters: [{ title: 'c', slides: [
  { id: 's1', title: 'one', narration: '第一句。', visual: { kind: 'image', src: 'assets/001.png' } },
  { id: 's2', title: 'two', narration: '第二句。', visual: { kind: 'quiz', question: 'q', options: ['a', 'b'], answer: 0 } },
  { id: 's3', title: 'three', narration: '第三句。', visual: { kind: 'terminal', commands: ['ls'] } }] }] };
const container = { children: [], appendChild(e) { this.children.push(e); } };

(async () => {
  // ---- name / extension
  check('isPackFile: .deckpack and .deck.zip, not .zip / .vtt / .srt', Pack.isPackFile('x.deckpack') && Pack.isPackFile('X.DECKPACK') && Pack.isPackFile('Git_patch.deck.zip') && !Pack.isPackFile('a.zip') && !Pack.isPackFile('a.vtt') && !Pack.isPackFile('a.srt'));

  // ---- a .deckpack
  const zip = new JSZip();
  zip.file('manifest.json', JSON.stringify({ format: 'ai-chat-deckpack', version: 1, title: 'T', slides: 3 }));
  zip.file('deck.yaml', yaml.dump(DECK));
  zip.file('assets/001.png', new Uint8Array([1, 2, 3]));
  zip.file('audio/01-s1.mp3', new Uint8Array([9, 9]));
  zip.file('audio/03-s3.mp3', new Uint8Array([8]));
  const snap = { cols: 80, rows: 24, cursor: { x: 2, y: 1 }, bg: '#000000', fg: '#ffffff', lines: [[{ t: '$ ls', fg: null, bg: null }], []] };
  zip.file('results.json', JSON.stringify({ version: 1, items: { 's2#0': { selected: [0], text: '', result: { score: 1, points: 10, got: 10, correct: true, feedback: 'ok' }, response: { selected: [0] } } }, terminals: { 's3#0': snap } }));
  const player = await Pack.open(await zip.generateAsync({ type: 'uint8array' }), container);
  const s = player.session;
  check('pack: a Player is made on a Session built from the pack', player instanceof FakePlayer && s instanceof FakeSession && container._deckPlayer === player);
  check('pack: the relative asset path became a blob url of the right type', s.deck.slides[0].visual.src.startsWith('blob:fake/') && made.some((m) => m.u === s.deck.slides[0].visual.src && m.type === 'image/png'), s.deck.slides[0].visual);
  check('pack: the narration is kept per slide id (decoded later, no TTS)', s.packAudio.s1 && s.packAudio.s1.byteLength === 2 && s.packAudio.s3.byteLength === 1 && !s.packAudio.s2);
  check('pack: the answers come back keyed slide id # n', s.packResults['s2#0'].result.got === 10 && s.packResults['s2#0'].selected[0] === 0);
  check('pack: the last screen of each terminal comes back with its colours', s.packTerminals['s3#0'].lines[0][0].t === '$ ls' && s.packTerminals['s3#0'].bg === '#000000');
  check('pack: the deck on the session is a normal, validated deck', s.deck.slides.length === 3 && s.deck.slides[1].visual.kind === 'quiz' && s.deck.slides[1].visual.wait === true);

  // ---- the older .deck.zip (description + narration + subtitles, no manifest)
  const old = new JSZip();
  old.file('Demo.deck.yaml', yaml.dump({ deck: { title: 'Old' }, chapters: [{ title: 'c', slides: [{ title: 'a', narration: '舊的。', visual: { kind: 'image', src: 'https://redmine.example/attachments/download/1/x.png' } }, { title: 'b', narration: '第二。' }] }] }));
  old.file('audio/01-s1.mp3', new Uint8Array([7, 7, 7]));
  old.file('Demo.srt', '1\n00:00:00,000 --> 00:00:01,000\nx\n'); old.file('README.txt', 'x');
  const p2 = await Pack.open(await old.generateAsync({ type: 'uint8array' }), { appendChild() {} });
  check('legacy .deck.zip: opens, urls untouched, narration by slide id, no saved answers', p2.session.deck.slides.length === 2 && p2.session.deck.slides[0].visual.src === 'https://redmine.example/attachments/download/1/x.png' && p2.session.packAudio.s1.byteLength === 3 && Object.keys(p2.session.packResults).length === 0, p2.session.packAudio);

  // ---- refusals
  let err = null; const junk = new JSZip(); junk.file('hello.txt', 'x');
  try { await Pack.open(await junk.generateAsync({ type: 'uint8array' }), { appendChild() {} }); } catch (e) { err = e; }
  check('a zip that is no presentation is refused with a clear message', err && /not a presentation file/.test(err.message), err && err.message);
  err = null; const wrong = new JSZip(); wrong.file('manifest.json', JSON.stringify({ format: 'something-else', version: 1 })); wrong.file('deck.yaml', 'x: 1');
  try { await Pack.open(await wrong.generateAsync({ type: 'uint8array' }), { appendChild() {} }); } catch (e) { err = e; }
  check('a pack of another format is refused', err && /not a deck pack/.test(err.message), err && err.message);
  err = null; const newer = new JSZip(); newer.file('manifest.json', JSON.stringify({ format: 'ai-chat-deckpack', version: 99 })); newer.file('deck.yaml', 'x: 1');
  try { await Pack.open(await newer.generateAsync({ type: 'uint8array' }), { appendChild() {} }); } catch (e) { err = e; }
  check('a pack made by a newer version says so', err && /newer version/.test(err.message), err && err.message);

  // ---- export side: collectAssets rewrites urls to assets/NNN.ext and keeps what it could not fetch
  const doc = { chapters: [{ slides: [{ visual: { kind: 'image', images: [{ src: 'https://r/a/1.png' }, { src: 'https://r/a/2.jpg?x=1' }] } }, { visual: { kind: 'group', items: [{ kind: 'svg', src: '/attachments/download/5/f.svg' }, { kind: 'image', src: 'https://r/a/1.png' }, { kind: 'image', src: 'https://r/missing.png' }] } }, { visual: { kind: 'image', src: 'data:image/png;base64,AAAA' } }] }] };
  const fetched = [];
  const col = await Pack.collectAssets(doc, (u) => { fetched.push(u); return /missing/.test(u) ? Promise.reject(new Error('HTTP 404')) : Promise.resolve({ type: 'image/png', u }); });
  const vis = col.doc.chapters[0].slides.map((x) => x.visual);
  check('collect: each distinct url is fetched once', fetched.length === 4 && new Set(fetched).size === 4, fetched);
  check('collect: urls are rewritten to assets/NNN.ext (same file, same path), data: uris untouched', vis[0].images[0].src === vis[1].items[1].src && /^assets\/\d{3}\.png$/.test(vis[0].images[0].src) && /^assets\/\d{3}\.jpg$/.test(vis[0].images[1].src) && /\.svg$/.test(vis[1].items[0].src) && vis[2].src.startsWith('data:'), vis);
  check('collect: a file that could not be fetched keeps its url and is listed', vis[1].items[2].src === 'https://r/missing.png' && col.warnings.length === 1 && /404/.test(col.warnings[0]) && col.files.length === 3);

  console.log('deck_pack: ' + ok + ' passed' + (bad.length ? ', ' + bad.length + ' FAILED:\n  ' + bad.join('\n  ') : ''));
  process.exit(bad.length ? 1 : 0);
})().catch((e) => { console.log('CRASH ' + (e.stack || e)); process.exit(1); });
