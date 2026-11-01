// node scripts/music-tests/midi_remote.test.js -- MIDI co-editing over the real collab layer (in-memory transport): share, join, event-level merge
if (typeof Blob === 'undefined') global.Blob = require('buffer').Blob;
const R = require('../../renderer/src/remote/rg_core.js');
const C = require('../../renderer/src/remote/rg_collab.js');
const P = require('../../renderer/src/remote/rg_patch.js');
const M = require('../../renderer/src/music/midi_core.js');
const E = require('../../renderer/src/music/midi_edit.js');
let ok = 0; const bad = [];
function check(name, cond, extra) { if (cond) ok++; else bad.push(name + (extra !== undefined ? ' ' + JSON.stringify(extra).slice(0, 300) : '')); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
class Hub {
    constructor() { this.ch = new Map(); }
    transport() {
        const hub = this; let name = null, id = null;
        return {
            async connect(channel, nodeId, h) { name = channel; id = nodeId; if (!hub.ch.has(name)) hub.ch.set(name, new Map()); hub.ch.get(name).set(id, { h, meta: null }); },
            async track(payload) { hub.ch.get(name).get(id).meta = payload; hub.sync(name); },
            async send(payload) { for (const [nid, m] of hub.ch.get(name)) if (nid !== id) setTimeout(() => m.h.onBroadcast(JSON.parse(JSON.stringify(payload))), 0); },
            async disconnect() { hub.ch.get(name) && hub.ch.get(name).delete(id); hub.sync(name); },
        };
    }
    sync(name) { const st = {}; for (const [nid, m] of this.ch.get(name)) if (m.meta) st[nid] = [Object.assign({ presence_ref: nid }, m.meta)]; for (const [, m] of this.ch.get(name)) setTimeout(() => m.h.onPresence(JSON.parse(JSON.stringify(st))), 0); }
}

(async () => {
    const keys = await R.deriveKeys('Tr0ub4dor&3-xyzQ', '12345678', 2000); const hub = new Hub();
    const mk = (name, kind) => new R.Room({ transport: hub.transport(), keys, self: { name, kind }, settleMs: 30 });
    const rooms = { h: mk('小明', 'desktop'), a: mk('阿華', 'web') };
    for (const k in rooms) await rooms[k].join(); await sleep(200);
    const kinds = (k) => (k === 'edit-midi' ? { remote: { sync: 'patch', patchKeys: E.PATCH_KEYS, methods: {} } } : null);
    const cs = {}; for (const k in rooms) { cs[k] = new C.Collab({ room: rooms[k], kinds, gate: async () => '', allow: () => '' }); cs[k].slow = 0.2; }
    let s = M.emptySong(); s = M.addTrack(s, '旋律', 0); s = M.addTrack(s, '貝斯', 33);
    [60, 62, 64].forEach((n, i) => { s = M.addNote(s, 0, { t: i * 480, d: 400, n, v: 90 }); });
    const hs = cs.h.share({ sid: 'm1', kind: 'edit-midi', title: '合奏', spec: E.toDoc(s), keys: E.PATCH_KEYS });
    const items = (await cs.a.list(300)).filter((it) => it.kind === 'edit-midi'); check('list shows the shared MIDI', items.length === 1 && items[0].title === '合奏', items);
    const pa = await cs.a.join(items[0].host, 'm1', { kind: 'edit-midi' }); await sleep(100);
    check('joiner gets the same song', JSON.stringify(E.fromDoc(pa.spec).tracks[0].notes.map((n) => n.n)) === '[60,62,64]');
    // 兩人同時改不同的地方
    const base = pa.spec;
    const aSong = E.apply(E.fromDoc(base), { act: 'transpose', semitones: 12, track: 0 }).song; const aDoc = E.reId(base, aSong);
    const hBase = hs.spec; const hSong = E.apply(E.fromDoc(hBase), { act: 'add_note', track: 1, beat: 0, beats: 1, pitch: 'C2' }).song; const hDoc = E.reId(hBase, hSong);
    const ra = pa.propose(P.diff(base, aDoc, E.PATCH_KEYS), { summary: 'transpose' }); const rh = hs.propose(P.diff(hBase, hDoc, E.PATCH_KEYS), { summary: 'add_note' });
    await Promise.all([ra, rh]); await sleep(150);
    const fa = E.fromDoc(pa.spec), fh = E.fromDoc(hs.spec);
    check('both edits survive on both sides', fa.tracks[0].notes.map((n) => n.n).join() === '72,74,76' && fa.tracks[1].notes.length === 1 && JSON.stringify(fa) === JSON.stringify(fh), [fa.tracks.map((t) => t.notes.length), fh.tracks.map((t) => t.notes.length)]);
    // 參與者刪一個音符,主持機看得到
    const cur = pa.spec; const dSong = E.apply(E.fromDoc(cur), { act: 'remove_notes', track: 0, fromBeat: 0, toBeat: 0.5 }).song;
    await pa.propose(P.diff(cur, E.reId(cur, dSong), E.PATCH_KEYS), { summary: 'remove' }); await sleep(100);
    check('a deletion reaches the host', E.fromDoc(hs.spec).tracks[0].notes.length === 2);
    console.log(bad.length ? 'FAIL\n' + bad.join('\n') : 'ok'); console.log(ok + ' passed, ' + bad.length + ' failed'); process.exit(bad.length ? 1 : 0);
})().catch((e) => { console.log('FAIL ' + e.stack); process.exit(1); });
