/* 不認識的東西（3D）：去 GitHub 找公開的 OBJ 模型（UMD，純函式，不碰網路、儲存；桌面版與網頁版共用）。測試 scripts/edit-tests/subject_3d.test.js；設計見 DESIGN.subject-research.md。
 * 梯子的第一階（使用者定的順序）：有現成的 OBJ 就直接用，不用再查描述、不用再找圖。
 *   ① 搜尋公開專案（api.github.com/search/repositories，不用金鑰；授權只收寬鬆的）→ ② 列專案的檔案樹找 .obj（名字要對得上）→ ③ 抓檔案（raw.githubusercontent.com）→ ④ 解析、縮減面數、擺正（置中、底面貼地、縮到合理大小）→ 變成編輯器的「自訂形狀」物件（跟匯入 OBJ、內建模型庫同一種東西）。
 * 另外：圖片轉出來的 2.5D 網格（第三階）也用這裡的 fit()／toObject()。 */
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(); else root.FaSubject3d = factory(); })(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  var LIM = { objBytes: 6 * 1024 * 1024, minObjBytes: 1500, maxFaces: 12000, maxVertices: 30000, repos: 3, trees: 3, repoKb: 600000 };
  var LICENSES = ['mit', 'apache-2.0', 'cc0-1.0', 'cc-by-4.0', 'cc-by-sa-4.0', 'unlicense', 'bsd-2-clause', 'bsd-3-clause', 'isc', 'zlib', 'artistic-2.0'];
  function str(v, n) { return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, n); }
  function words(en) { return String(en || '').toLowerCase().split(/[^a-z0-9]+/).filter(function (w) { return w.length > 1; }); }
  function stem(w) { return w.replace(/(es|s)$/, ''); }
  function hasWords(text, ws) { var t = String(text || '').toLowerCase().replace(/[_\-.]+/g, ' ').replace(/ies(?=\s|$)/g, 'y'); return ws.length > 0 && ws.every(function (w) { return t.indexOf(stem(w)) >= 0; }); }

  // ───── ① 搜尋公開專案
  function repoSearchUrl(subject) {
    var en = str(subject.en || subject.name, 60); return 'https://api.github.com/search/repositories?per_page=10&sort=stars&q=' + encodeURIComponent(en + ' obj in:name,description,topics');
  }
  // 只收授權寬鬆的、不是太大的專案；專案名稱／描述／主題要含這個東西的英文名字；星星多的先
  function pickRepos(json, subject) {
    var items = json && Array.isArray(json.items) ? json.items : [], ws = words(subject.en), out = [];
    items.forEach(function (r) {
      var lic = r && r.license ? String(r.license.spdx_id || '').toLowerCase() : 'none'; if (lic === 'noassertion') lic = 'none'; if (lic !== 'none' && LICENSES.indexOf(lic) < 0) return; if ((r.size || 0) > LIM.repoKb) return;   // 沒有標示授權的公開專案也收（使用者決定：公開的就可以），但寬鬆授權的排前面
      var hay = [r.name, r.description].concat(r.topics || []).join(' '); if (!hasWords(hay, ws)) return;
      out.push({ full: str(r.full_name, 120), branch: str(r.default_branch || 'main', 40), license: lic, stars: r.stargazers_count || 0, description: str(r.description, 100) });
    });
    out.sort(function (a, b) { return (a.license === 'none' ? 1 : 0) - (b.license === 'none' ? 1 : 0) || b.stars - a.stars; }); return out.slice(0, LIM.repos);
  }
  // ───── ② 檔案樹裡找 .obj：大小合理，路徑要含這個東西的名字（專案名稱對得上而且只有一個 .obj 也行）
  function treeUrl(repo) { return 'https://api.github.com/repos/' + repo.full + '/git/trees/' + encodeURIComponent(repo.branch) + '?recursive=1'; }
  function pickObj(treeJson, subject, repo) {
    var tree = treeJson && Array.isArray(treeJson.tree) ? treeJson.tree : [], ws = words(subject.en), cands = [];
    tree.forEach(function (e) { if (!e || e.type !== 'blob' || !/\.obj$/i.test(e.path || '')) return; if (!(e.size >= LIM.minObjBytes && e.size <= LIM.objBytes)) return; cands.push({ path: e.path, size: e.size }); });
    if (!cands.length) return null; var named = cands.filter(function (c) { return hasWords(c.path, ws); });
    if (named.length) { named.sort(function (a, b) { return a.path.split('/').length - b.path.split('/').length || a.size - b.size; }); return named[0]; }
    return cands.length === 1 && hasWords(repo.full + ' ' + repo.description, ws) ? cands[0] : null;
  }
  function rawUrl(repo, path) { return 'https://raw.githubusercontent.com/' + repo.full + '/' + encodeURIComponent(repo.branch) + '/' + String(path).split('/').map(encodeURIComponent).join('/'); }

  // ───── ④ 解析 OBJ：v／vt／f（v、v/vt、v/vt/vn、v//vn、負索引），多邊形扇形三角化；(位置, 貼圖座標) 相同的角合成同一個頂點，所以 uvs 和 vertices 一對一
  function parseObj(text, opt) {
    opt = opt || {}; var maxFaces = opt.maxFaces || LIM.maxFaces, P = [], T = [], key = {}, vertices = [], uvs = [], faces = [], hasUv = false, bad = 0, lines = String(text || '').split(/\r?\n/);
    function idx(s, n) { var i = parseInt(s, 10); if (!isFinite(i) || i === 0) return -1; return i < 0 ? n + i : i - 1; }
    function corner(tok) {
      var p = tok.split('/'), vi = idx(p[0], P.length), ti = p.length > 1 && p[1] !== '' ? idx(p[1], T.length) : -1; if (vi < 0 || vi >= P.length) return -1; var k = vi + '/' + ti, got = key[k];
      if (got === undefined) { got = vertices.length; key[k] = got; vertices.push(P[vi]); var t = ti >= 0 && ti < T.length ? T[ti] : null; if (t) hasUv = true; uvs.push(t || [0, 0]); } return got;
    }
    for (var i = 0; i < lines.length; i++) {
      var ln = lines[i]; if (!ln || ln.charCodeAt(0) === 35) continue; var c = ln.charAt(0);
      if (c === 'v' && ln.charAt(1) === ' ') { var a = ln.slice(2).trim().split(/\s+/); var x = +a[0], y = +a[1], z = +a[2]; if (!isFinite(x) || !isFinite(y) || !isFinite(z)) { bad++; P.push([0, 0, 0]); } else P.push([x, y, z]); if (P.length > 400000) return { ok: false, error: '頂點太多（超過 40 萬）' }; }
      else if (c === 'v' && ln.charAt(1) === 't') { var b = ln.slice(3).trim().split(/\s+/); T.push([+b[0] || 0, +b[1] || 0]); }
      else if (c === 'f' && (ln.charAt(1) === ' ' || ln.charAt(1) === '\t')) {
        var toks = ln.slice(2).trim().split(/\s+/), ids = []; for (var k = 0; k < toks.length; k++) { var v = corner(toks[k]); if (v >= 0) ids.push(v); }
        for (var m = 1; m + 1 < ids.length; m++) { if (ids[0] !== ids[m] && ids[m] !== ids[m + 1] && ids[0] !== ids[m + 1]) faces.push([ids[0], ids[m], ids[m + 1]]); }
      }
    }
    if (!faces.length || vertices.length < 3) return { ok: false, error: '這個 OBJ 沒有面' };
    var mesh = { vertices: vertices, faces: faces, uvs: hasUv ? uvs : null }; if (faces.length > maxFaces || vertices.length > LIM.maxVertices) { mesh = decimate(mesh, maxFaces); }
    return { ok: true, mesh: mesh, faces: mesh.faces.length, vertices: mesh.vertices.length, original: { faces: faces.length, vertices: vertices.length }, bad: bad };
  }
  // 縮減面數：頂點叢集（格子越來越粗，直到面數夠少）；貼圖座標取格子裡第一個頂點的
  function decimate(mesh, maxFaces) {
    var box = bbox(mesh.vertices), size = Math.max(box.max[0] - box.min[0], box.max[1] - box.min[1], box.max[2] - box.min[2]) || 1, res = 120, out = mesh;
    for (var round = 0; round < 8; round++) {
      var cell = size / res, map = {}, nv = [], nu = mesh.uvs ? [] : null, remap = new Array(mesh.vertices.length), nf = [], seen = {};
      for (var i = 0; i < mesh.vertices.length; i++) { var p = mesh.vertices[i], k = Math.floor((p[0] - box.min[0]) / cell) + ',' + Math.floor((p[1] - box.min[1]) / cell) + ',' + Math.floor((p[2] - box.min[2]) / cell), g = map[k]; if (g === undefined) { g = nv.length; map[k] = g; nv.push(p); if (nu) nu.push(mesh.uvs[i]); } remap[i] = g; }
      for (var f = 0; f < mesh.faces.length; f++) { var a = remap[mesh.faces[f][0]], b = remap[mesh.faces[f][1]], c = remap[mesh.faces[f][2]]; if (a === b || b === c || a === c) continue; var s = [a, b, c].sort(function (x, y) { return x - y; }).join(','); if (seen[s]) continue; seen[s] = 1; nf.push([a, b, c]); }
      out = { vertices: nv, faces: nf, uvs: nu }; if (nf.length <= maxFaces) break; res = Math.floor(res * 0.7);
    }
    return out;
  }
  function bbox(vs) { var mn = [1e30, 1e30, 1e30], mx = [-1e30, -1e30, -1e30]; for (var i = 0; i < vs.length; i++) for (var d = 0; d < 3; d++) { if (vs[i][d] < mn[d]) mn[d] = vs[i][d]; if (vs[i][d] > mx[d]) mx[d] = vs[i][d]; } return { min: mn, max: mx }; }
  // 擺正：x、z 置中、底面貼地（y 最小值＝0）、縮到最長邊 longest 公尺。Z 軸向上的模型（常見於 CAD／Blender 匯出）：高度方向在 z 又明顯比 y 長時轉成 y 向上
  function fit(mesh, longest, opt) {
    opt = opt || {};
    var vs = mesh.vertices, b = bbox(vs), ex = [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]], zUp = false;
    if (ex[2] > ex[1] * 1.6 && ex[2] > ex[0] * 1.2) { zUp = true; vs = vs.map(function (p) { return [p[0], p[2], -p[1]]; }); b = bbox(vs); ex = [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]]; }
    var L = Math.max(ex[0], ex[1], ex[2]) || 1, k = (longest || 0.3) / L, cx = (b.min[0] + b.max[0]) / 2, cz = (b.min[2] + b.max[2]) / 2, r = function (x) { return Math.round(x * 10000) / 10000; };
    // 圖片做出來的浮雕很薄：前後深度至少要有寬高較小那邊的 depthRatio 倍（東西才像立體的，不是一片板子）；以前後的中心為準放大
    var zk = 1; if (opt.depthRatio && !zUp) { var zEx = ex[2] * k, flat = Math.min(ex[0], ex[1]) * k; if (zEx > 0 && zEx < flat * opt.depthRatio) { zk = (flat * opt.depthRatio) / zEx; } }
    return { vertices: vs.map(function (p) { return [r((p[0] - cx) * k), r((p[1] - b.min[1]) * k), r((p[2] - cz) * k * zk)]; }), faces: mesh.faces, uvs: mesh.uvs ? mesh.uvs.map(function (t) { return [r(t[0]), r(t[1])]; }) : null, zUp: zUp, size_m: [r(ex[0] * k), r(ex[1] * k), r(ex[2] * k * zk)] };
  }
  // ───── 第三階：圖片 → 3D（沿用現有的圖片分解：四叉樹三角網格＋距離變換充氣成 2.5D，見 skills/image-decompose-redraw）
  // 分解出來的是「整張圖」一片有高低的板子（背景也被充氣）。要當一個東西放進場景，得先把背景切掉：背景色用圖的邊緣估（中位數），從邊緣往內填色（容許誤差內才算背景），剩下的是前景。
  // img：{ width, height, data: RGBA }；回 { mask: Uint8Array(1＝前景), fg: 前景占的比例, bg: [r,g,b] }
  function bgMask(img, tol) {
    var w = img.width, h = img.height, d = img.data, t = tol || 42, n = w * h, ring = [], i, x, y;
    function px(xx, yy) { var k = (yy * w + xx) * 4; return [d[k], d[k + 1], d[k + 2], d[k + 3]]; }
    for (x = 0; x < w; x++) { ring.push(px(x, 0)); ring.push(px(x, h - 1)); } for (y = 1; y < h - 1; y++) { ring.push(px(0, y)); ring.push(px(w - 1, y)); }
    function med(ix) { var a = ring.map(function (p) { return p[ix]; }).sort(function (p, q) { return p - q; }); return a[a.length >> 1]; }
    var bg = [med(0), med(1), med(2)], mask = new Uint8Array(n).fill(1), stack = [];
    function isBg(k) { var o = k * 4; if (d[o + 3] < 40) return true; var dr = d[o] - bg[0], dg = d[o + 1] - bg[1], db = d[o + 2] - bg[2]; return Math.sqrt(dr * dr + dg * dg + db * db) <= t; }
    function push(k) { if (mask[k] && isBg(k)) { mask[k] = 0; stack.push(k); } }
    for (x = 0; x < w; x++) { push(x); push((h - 1) * w + x); } for (y = 0; y < h; y++) { push(y * w); push(y * w + w - 1); }
    while (stack.length) { var k = stack.pop(), cx = k % w, cy = (k - cx) / w; if (cx > 0) push(k - 1); if (cx < w - 1) push(k + 1); if (cy > 0) push(k - w); if (cy < h - 1) push(k + w); }
    var fg = 0; for (i = 0; i < n; i++) fg += mask[i]; return { mask: mask, fg: fg / n, bg: bg };
  }
  // 圖分解出來的 scene3d（JSON）→ { mesh, texture }；沒有 polygon 節點就回 null
  function parseScene(text) {
    var j; try { j = JSON.parse(String(text || '')); } catch (e) { return null; } var nodes = j && Array.isArray(j.nodes) ? j.nodes : [], n = null; for (var i = 0; i < nodes.length; i++) if (nodes[i] && nodes[i].mesh === 'polygon' && Array.isArray(nodes[i].vertices) && Array.isArray(nodes[i].faces)) { n = nodes[i]; break; }
    if (!n || !n.uvs || n.uvs.length !== n.vertices.length) return null; var tex = n.material && typeof n.material.texture === 'string' && /^data:image\//.test(n.material.texture) ? n.material.texture : '';
    return { mesh: { vertices: n.vertices, faces: n.faces, uvs: n.uvs }, texture: tex, color: n.material && n.material.color || '' };
  }
  // 把背景的三角形切掉（三角形中心的貼圖座標落在背景就丟），再清掉沒用到的頂點。貼圖座標：u 往右、v 往上（v＝1 是圖的上緣）
  function cutBackground(mesh, mask, w, h) {
    var keep = [], used = {}, nv = [], nu = [], remap = {}, f, i;
    function fgAt(u, v) { var xx = Math.max(0, Math.min(w - 1, Math.floor(u * w))), yy = Math.max(0, Math.min(h - 1, Math.floor((1 - v) * h))); return mask[yy * w + xx] === 1; }
    for (f = 0; f < mesh.faces.length; f++) {
      var tri = mesh.faces[f], u = (mesh.uvs[tri[0]][0] + mesh.uvs[tri[1]][0] + mesh.uvs[tri[2]][0]) / 3, v = (mesh.uvs[tri[0]][1] + mesh.uvs[tri[1]][1] + mesh.uvs[tri[2]][1]) / 3;
      if (fgAt(u, v)) keep.push(tri);
    }
    keep.forEach(function (tri) { tri.forEach(function (vi) { if (remap[vi] === undefined) { remap[vi] = nv.length; nv.push(mesh.vertices[vi]); nu.push(mesh.uvs[vi]); } }); });
    return { vertices: nv, faces: keep.map(function (tri) { return [remap[tri[0]], remap[tri[1]], remap[tri[2]]]; }), uvs: nu, kept: keep.length, total: mesh.faces.length };
  }
  // ───── 用「瀏覽器控制」（使用者的 Chrome）搜尋：GitHub 程式碼搜尋（要登入，用使用者登入的 Chrome）、Google 圖片、imgur。網址、在頁面裡跑的抽取腳本（回 JSON 字串）與解析都在這裡，抓取由宿主端做
  function githubCodeSearchUrl(subject) { var en = words(subject.en || subject.name).join(' ') || str(subject.name, 40); return 'https://github.com/search?type=code&q=' + encodeURIComponent(en + ' extension:obj'); }
  var GH_EXTRACT_JS = '(()=>{const out={hrefs:[],login:false};const t=document.body?document.body.innerText:"";if(/Sign in to search code/i.test(t))out.login=true;' +
    'document.querySelectorAll(\'a[href*="/blob/"]\').forEach(a=>out.hrefs.push(a.getAttribute("href")));' +
    'try{const e=document.querySelector(\'script[data-target="react-app.embeddedData"]\');const j=JSON.parse(e.textContent);const rs=(j.payload&&j.payload.results)||[];rs.forEach(r=>{const repo=r.repo_nwo||(r.repo&&(r.repo.name_with_owner||(r.repo.repository&&r.repo.repository.name_with_owner)))||"";const ref=r.ref_name||r.commit_sha||"HEAD";if(repo&&r.path)out.hrefs.push("/"+repo+"/blob/"+ref+"/"+r.path);});}catch(e){}' +
    'out.ready=!!(out.hrefs.length||out.login||/did not match|No results/i.test(t));return JSON.stringify(out);})()';
  // 抽取結果 → { login, hits:[{ full, path, raw }] }：.obj 檔、路徑或專案名要含這個東西的名字、不重複；raw＝raw.githubusercontent.com 的網址（blob 後面的 ref/路徑原樣接上）
  function parseCodeHits(json, subject) {
    var j = json && typeof json === 'object' ? json : null; if (typeof json === 'string') { try { j = JSON.parse(json); } catch (e) { j = null; } } if (!j) return { login: false, hits: [] };
    var ws = words(subject.en), seen = {}, hits = [];
    (j.hrefs || []).forEach(function (h) { var m = /^(?:https:\/\/github\.com)?\/([^\/]+\/[^\/]+)\/blob\/(.+?)(?:[?#].*)?$/.exec(String(h || '')); if (!m) return; var rest = m[2], full = m[1]; if (!/\.obj$/i.test(rest)) return; var key = full + '/' + rest; if (seen[key]) return; if (!hasWords(full + ' ' + rest, ws)) return; seen[key] = 1; hits.push({ full: full, path: rest.slice(rest.indexOf('/') + 1), raw: 'https://raw.githubusercontent.com/' + full + '/' + rest.split('/').map(encodeURIComponent).join('/') }); });
    return { login: !!j.login, hits: hits.slice(0, 6) };
  }
  function googleImagesUrl(subject) { return 'https://www.google.com/search?tbm=isch&hl=en&safe=active&q=' + encodeURIComponent(str(subject.en || subject.name, 60) + ' png'); }
  var GOOGLE_EXTRACT_JS = '(()=>{const l=[...document.querySelectorAll("img")].filter(i=>i.naturalWidth>=120&&i.naturalHeight>=120&&i.alt&&i.src&&i.src.length<400000).slice(0,16).map(i=>({src:i.src,alt:i.alt.slice(0,80),w:i.naturalWidth,h:i.naturalHeight}));return JSON.stringify({imgs:l,ready:l.length>=4});})()';
  function parseImageList(json, source) {
    var j = json && typeof json === 'object' ? json : null; if (typeof json === 'string') { try { j = JSON.parse(json); } catch (e) { j = null; } } var out = [];
    ((j && j.imgs) || []).forEach(function (i) { if (i && /^(data:image\/(?:jpeg|png|webp);base64,|https:\/\/)/.test(String(i.src || ''))) out.push({ ref: i.src, title: str(i.alt, 80), source: source, license: '', creator: '' }); }); return out;
  }
  function imgurSearchUrl(subject) { return 'https://imgur.com/search?q=' + encodeURIComponent(str(subject.en || subject.name, 60)); }
  var IMGUR_EXTRACT_JS = '(()=>{const l=[...document.querySelectorAll("img")].filter(i=>/^https:\\/\\/i\\.imgur\\.com\\/[A-Za-z0-9]+[a-z]?\\.(?:jpg|png)/.test(i.src)&&i.naturalWidth>=90).slice(0,16).map(i=>({src:i.src,alt:i.alt.slice(0,80)}));return JSON.stringify({imgs:l,ready:l.length>=4});})()';
  // imgur 的縮圖是 <id>b.jpg（160 像素）；改成 <id>l.jpg（640 像素）
  function imgurLarge(list) { return list.map(function (x) { return Object.assign({}, x, { ref: String(x.ref).replace(/^(https:\/\/i\.imgur\.com\/[A-Za-z0-9]{7})[a-z]?(\.(?:jpg|png)).*$/, '$1l$2') }); }); }
  // 編輯器的物件（跟內建模型庫、匯入 OBJ 同一種：mesh:'polygon'）
  function toObject(subject, mesh, opt) {
    opt = opt || {}; var o = { type: 'mesh', mesh: 'polygon', name: str(subject.name, 24), material: { color: opt.color || '#c9c9c9', roughness: 0.6, metalness: 0.05 }, extra: { vertices: mesh.vertices, faces: mesh.faces } };
    if (mesh.uvs) o.extra.uvs = mesh.uvs; if (opt.texture) { o.material.texture = opt.texture; o.material.side = 'double'; } return o;   // 浮雕只有一面：兩面都畫，轉到背面不會看到空的
  }
  function assetNote(assets) { return assets && assets.length ? '已經找到現成的 3D 模型並由程式放進場景了：' + assets.map(function (a) { return '「' + a.name + '」'; }).join('、') + '（放在原點、底面貼地）。請用移動、旋轉、縮放、顏色（set_material）等動作安排它，不要再用圖元拼一個。' : ''; }

  return { LIM: LIM, LICENSES: LICENSES, repoSearchUrl: repoSearchUrl, pickRepos: pickRepos, treeUrl: treeUrl, pickObj: pickObj, rawUrl: rawUrl, parseObj: parseObj, decimate: decimate, fit: fit, toObject: toObject, bbox: bbox, githubCodeSearchUrl: githubCodeSearchUrl, GH_EXTRACT_JS: GH_EXTRACT_JS, parseCodeHits: parseCodeHits, googleImagesUrl: googleImagesUrl, GOOGLE_EXTRACT_JS: GOOGLE_EXTRACT_JS, parseImageList: parseImageList, imgurSearchUrl: imgurSearchUrl, IMGUR_EXTRACT_JS: IMGUR_EXTRACT_JS, imgurLarge: imgurLarge, bgMask: bgMask, parseScene: parseScene, cutBackground: cutBackground, assetNote: assetNote };
});
