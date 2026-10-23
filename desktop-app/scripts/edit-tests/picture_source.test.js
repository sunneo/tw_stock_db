// node test/edit_shell/picture_source.test.js -- web pictures for the editors: search (Commons, then Openverse), load (browser, then the server relay)
const P = require('../../renderer/src/edit/picture_source.js');
let ok = 0; const bad = [];
function check(name, cond, extra) { if (cond) ok++; else bad.push(name + (extra !== undefined ? ' ' + JSON.stringify(extra) : '')); }
const jsonRes = (o, status) => ({ ok: (status || 200) < 400, status: status || 200, json: async () => o });
const blobRes = (mime, status) => ({ ok: (status || 200) < 400, status: status || 200, blob: async () => ({ type: mime, size: 10 }), json: async () => ({ error: 'relay says no' }) });
const commons = { query: { pages: { 1: { title: 'File:Airbus A330 wing.jpg', imageinfo: [{ mime: 'image/jpeg', width: 3000, height: 2000, thumburl: 'https://t/1.jpg', url: 'https://f/1.jpg', descriptionurl: 'https://c/1', extmetadata: { LicenseShortName: { value: 'CC BY-SA 3.0' }, Artist: { value: '<a href="//x">Sergey &amp; Co</a>' } } }] },
  2: { title: 'File:Airplane logo.svg', imageinfo: [{ mime: 'image/svg+xml', width: 100, height: 100, thumburl: 'https://t/2.png', url: 'https://f/2.svg', extmetadata: {} }] }, 3: { title: 'File:Sound.ogg', imageinfo: [{ mime: 'audio/ogg', url: 'https://f/3.ogg' }] } } } };
(async () => {
  const urlsSeen = [];
  let S = P.make({ fetch: async (u) => { urlsSeen.push(u); if (/commons\.wikimedia/.test(u)) return jsonRes(commons); throw new Error('x'); } });
  let r = await S.search('airplane wing');
  check('search: Commons answers, only pictures are kept, the title is cleaned, licence and author are stripped of html', r.ok && r.results.length === 2 && r.results[0].title === 'Airbus A330 wing' && r.results[0].license === 'CC BY-SA 3.0' && r.results[0].creator === 'Sergey & Co' && r.results[0].source === 'commons', r);
  check('search: the better match for the query comes first (and a logo does not beat it)', r.results[0].title === 'Airbus A330 wing');
  check('search: the Commons request is for bitmap files in the file namespace, with CORS origin=*', /gsrnamespace=6/.test(urlsSeen[0]) && /origin=\*/.test(urlsSeen[0]) && /filetype%3Abitmap/.test(urlsSeen[0]));
  S = P.make({ fetch: async (u) => { if (/commons/.test(u)) throw new Error('offline'); return jsonRes({ results: [{ title: 'Airplane Wing', thumbnail: 'https://o/t', url: 'https://o/full.jpg', width: 680, height: 1024, license: 'by-sa', license_version: '2.0', creator: 'Michael', foreign_landing_url: 'https://flickr/x' }] }); } });
  r = await S.search('airplane wing');
  check('search: when Commons fails Openverse is tried, the failure is reported', r.ok && r.results[0].source === 'openverse' && r.results[0].license === 'BY-SA 2.0' && r.tried[0].ok === false && r.tried[0].source === 'commons', r);
  S = P.make({ fetch: async () => { throw new Error('network down'); } });
  r = await S.search('cat');
  check('search: both fail -> a clear error that names each source, no exception', !r.ok && /commons: network down/.test(r.error) && /openverse: network down/.test(r.error), r);
  check('search: an empty query is refused', !(await P.make({ fetch: async () => jsonRes({}) }).search('  ')).ok);
  S = P.make({ fetch: async (u) => { if (/commons/.test(u)) return jsonRes({ query: { pages: {} } }); return jsonRes({ results: [] }); } });
  r = await S.search('qwertyuiop');
  check('search: nothing found says so', !r.ok && /nothing/.test(r.error), r);
  // load
  S = P.make({ fetch: async (u, o) => blobRes('image/png'), relayUrl: '/relay' });
  let l = await S.load('https://site/a.png');
  check('load: the browser reads it when the site allows it', l.via === 'browser' && l.mime === 'image/png');
  const calls = [];
  S = P.make({ fetch: async (u, o) => { calls.push(u); if (/^\/relay/.test(u)) return blobRes('image/jpeg'); throw new TypeError('Failed to fetch'); }, relayUrl: '/relay' });
  l = await S.load('https://site/a b.jpg?x=1');
  check('load: a site that blocks the browser (CORS) goes through the server relay with the address encoded', l.via === 'server' && /^\/relay\?url=https%3A%2F%2Fsite%2Fa%20b\.jpg%3Fx%3D1$/.test(calls[1]), calls);
  S = P.make({ fetch: async (u) => { if (/^\/relay/.test(u)) return blobRes('', 502); throw new TypeError('Failed to fetch'); }, relayUrl: '/relay' });
  let err = null; try { await S.load('https://site/a.png'); } catch (e) { err = e; }
  check('load: the relay\'s own reason is passed on', err && /relay says no/.test(err.message), err && err.message);
  S = P.make({ fetch: async () => { throw new TypeError('Failed to fetch'); } }); err = null; try { await S.load('https://site/a.png'); } catch (e) { err = e; }
  check('load: no relay configured -> says the browser cannot read it', err && /no server relay/.test(err.message));
  S = P.make({ fetch: async () => blobRes('text/html'), relayUrl: '/relay' }); err = null; try { l = await S.load('https://site/page'); } catch (e) { err = e; }
  check('load: a page that is not a picture is not accepted (browser and relay both)', !l || err, l);
  check('load: only web addresses and data: pictures', await P.make({ fetch: async () => blobRes('image/png') }).load('file:///etc/passwd').then(() => false, () => true));
  check('urls: addresses are found in a sentence and trailing punctuation is cut', JSON.stringify(P.urls('請抓 https://a.com/x.png，還有 http://b.org/y.jpg。')) === '["https://a.com/x.png","http://b.org/y.jpg"]', P.urls('請抓 https://a.com/x.png，還有 http://b.org/y.jpg。'));
  console.log(bad.length ? 'FAILED:\n  ' + bad.join('\n  ') : 'picture_source: ' + ok + ' passed'); process.exit(bad.length ? 1 : 0);
})();
