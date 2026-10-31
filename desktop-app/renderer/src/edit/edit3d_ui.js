// The screens of /edit-3d-model, built on the shared frame (edit_shell.js): the SCENE editor (a 3D viewer in the middle, the objects as a TREE on the left with the properties under it, the YAML source as a second tab that is
// editable and shown again the moment you go back to the viewer, the AI chat at the bottom) and the PART editor (one object alone, like a plastic kit: which face gets which picture or colour; opened by a double click on the object).
// Needs three.js (THREE, OrbitControls) on the page; the host passes buildNode(node) -> THREE.Object3D (the one render_3d_scene uses, so textures and shapes are the same everywhere).
//   FaEdit3dUI.mount({ id, state, spec, host, restoring, store, buildNode, keepTexture(blob)->Promise<ref>, openPart(obj), windowApi }) -> element (el._ed, see FaEditShell)
//   FaEdit3dUI.mountPart({ id, state, spec, host, buildNode, keepTexture, onDone(partSpec), onCancel() }) -> element
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(); else root.FaEdit3dUI = factory((root.FaEdit3d || (typeof FaEdit3d !== 'undefined' ? FaEdit3d : undefined)), (root.FaEdit3dPart || (typeof FaEdit3dPart !== 'undefined' ? FaEdit3dPart : undefined)), (root.FaEditShell || (typeof FaEditShell !== 'undefined' ? FaEditShell : undefined)), (root.FaEditStore || (typeof FaEditStore !== 'undefined' ? FaEditStore : undefined))); })(typeof self !== 'undefined' ? self : this, function (C, PC, Shell, Store) {
  'use strict';
  function h(tag, cls, text) { var e = document.createElement(tag); if (cls) { e.className = cls; } if (text != null) { e.textContent = text; } return e; }
  var ICON = { box: '🧊', sphere: '⚽', cylinder: '🥫', cone: '🔺', plane: '▭', torus: '🍩', polygon: '🔷', particles: '✨', line: '〰', group: '📁', light: '💡' };
  function slug(s) { return String(s || 'scene').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, '_').replace(/^_+|_+$/g, '').slice(0, 50) || 'scene'; }
  var deg = function (r) { return Math.round(r * 180 / Math.PI * 10) / 10; };
  var HEX = /^#[0-9a-fA-F]{6}$/;
  function hex(c, d) { c = String(c || ''); if (HEX.test(c)) { return c; } if (/^#[0-9a-fA-F]{3}$/.test(c)) { return '#' + c.slice(1).replace(/(.)/g, '$1$1'); } return d || '#888888'; }

  // ───────────────────────── the 3D stage: one canvas, orbit, picking, a highlight box ─────────────────────────
  // buildNode(node, presets) -> Object3D | null.   stage.rebuild(sceneDef) sceneDef = FaEdit3d.toScene(spec, { tags: true })
  function makeStage(opt) {
    var el = h('div', 'e3-stage'), canvas = h('canvas'), dirty = true, burst = 0, dead = false;
    el.style.cssText = 'position:relative;flex:1;min-height:340px;min-width:260px;background:#14171d;overflow:hidden'; canvas.style.cssText = 'position:absolute;left:0;top:0;width:100%;height:100%;display:block;touch-action:none'; el.appendChild(canvas);
    var renderer = null, webgl = true;
    try { renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true, preserveDrawingBuffer: true }); } catch (e) { webgl = false; }
    var ctx2d = !webgl && opt.raster ? canvas.getContext('2d') : null;   // no WebGL: the assistant's own software rasteriser draws the same scene (slower, no textures)
    if (!webgl && !ctx2d) { var msg = h('div', 'st', '這台機器的 WebGL 開不起來，3D 畫面無法顯示（還是可以用物件欄、屬性面板與 YAML 原始碼編輯）。'); msg.style.cssText = 'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;padding:20px;text-align:center;color:#c9d1d9'; el.appendChild(msg); }
    var scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(50, 1, 0.05, 6000), content = new THREE.Group(), helpers = new THREE.Group(), selGroup = new THREE.Group(); scene.add(content); scene.add(helpers); scene.add(selGroup);
    var controls = webgl || ctx2d ? new THREE.OrbitControls(camera, canvas) : null; if (controls) { controls.addEventListener('change', function () { dirty = true; if (opt.onView) { opt.onView(); } }); controls.screenSpacePanning = true; }
    var grid = null, showGrid = opt.grid !== false;
    function size() { var w = Math.max(40, el.clientWidth), hh = Math.max(40, el.clientHeight); if (renderer) { renderer.setPixelRatio(Math.min((window.__faRenderScale ? window.__faRenderScale() : 2), window.devicePixelRatio || 1)); renderer.setSize(w, hh, false); } else if (ctx2d) { canvas.width = w; canvas.height = hh; } camera.aspect = w / hh; camera.updateProjectionMatrix(); dirty = true; }
    var ro = typeof ResizeObserver === 'function' ? new ResizeObserver(function () { size(); }) : null; if (ro) { ro.observe(el); }
    function dispose(obj) { obj.traverse(function (o) { if (o.geometry && o.geometry.dispose) { o.geometry.dispose(); } var ms = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : []; ms.forEach(function (m) { ['map', 'emissiveMap'].forEach(function (k) { if (m[k] && m[k].dispose) { m[k].dispose(); } }); if (m.dispose) { m.dispose(); } }); }); }
    function clear(g) { while (g.children.length) { var c = g.children[0]; g.remove(c); dispose(c); } }
    var markers = [];
    function rebuild(def) {
      clear(content); clear(helpers); markers = []; scene.background = new THREE.Color(def.background || '#1a1d24');
      (def.lights || []).forEach(function (l) {
        var col = new THREE.Color(l.color || '#ffffff'), lt, mk;
        if (l.type === 'ambient') { lt = new THREE.AmbientLight(col, l.intensity != null ? l.intensity : 0.5); content.add(lt); if (l._src && opt.markers !== false) { mk = new THREE.Mesh(new THREE.OctahedronGeometry(0.14), new THREE.MeshBasicMaterial({ color: col })); mk.position.set(0, 3.2, 0); } }
        else { var p = l.position || [0, 3, 0]; lt = l.type === 'directional' ? new THREE.DirectionalLight(col, l.intensity != null ? l.intensity : 1) : new THREE.PointLight(col, l.intensity != null ? l.intensity : 1); lt.position.set(p[0], p[1], p[2]); content.add(lt); if (l._src && opt.markers !== false) { mk = new THREE.Mesh(l.type === 'directional' ? new THREE.ConeGeometry(0.16, 0.34, 8) : new THREE.SphereGeometry(0.14, 12, 8), new THREE.MeshBasicMaterial({ color: col })); mk.position.set(p[0], p[1], p[2]); } }
        if (mk) { mk.userData.src = l._src; mk.userData.marker = true; helpers.add(mk); markers.push(mk); }
      });
      (def.nodes || []).forEach(function (n) { var o = null; try { o = opt.buildNode(n); } catch (e) { o = null; } if (!o) { return; } o.userData.src = n._src; o.userData.skin = n._skin; content.add(o); });
      if (grid) { helpers.remove(grid); grid = null; } if (showGrid) { grid = new THREE.GridHelper(opt.gridSize || 20, opt.gridSize || 20, 0x586174, 0x2c3340); grid.userData.grid = true; helpers.add(grid); }
      dirty = true; burst = 90;   // textures load a moment later: draw every frame for a while
    }
    function applyCamera(cam, keepDist) {
      if (!cam) { return; } camera.position.set(cam.position[0], cam.position[1], cam.position[2]); camera.fov = cam.fov || 50; camera.updateProjectionMatrix();
      if (controls) { controls.target.set(cam.look_at[0], cam.look_at[1], cam.look_at[2]); controls.update(); } else { camera.lookAt(cam.look_at[0], cam.look_at[1], cam.look_at[2]); } dirty = true;
    }
    function getView() { var t = controls ? controls.target : new THREE.Vector3(0, 0, 0); return { position: [camera.position.x, camera.position.y, camera.position.z], target: [t.x, t.y, t.z], fov: camera.fov }; }
    function srcOf(o) { while (o) { if (o.userData && o.userData.src) { return o; } o = o.parent; } return null; }
    var ray = new THREE.Raycaster(), ptr = new THREE.Vector2();
    function pickAt(cx, cy, pred) {
      var r = canvas.getBoundingClientRect(); ptr.set(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1); ray.setFromCamera(ptr, camera);
      var list = []; content.children.forEach(function (c) { c.traverse(function (o) { if (o.isMesh || o.isPoints || o.isLine) { list.push(o); } }); }); markers.forEach(function (m) { list.push(m); });
      var hits = ray.intersectObjects(list, false); for (var i = 0; i < hits.length; i++) { var so = srcOf(hits[i].object); if (!so) { continue; } if (pred && !pred(so, hits[i])) { continue; } var nrm = hits[i].face ? hits[i].face.normal.clone().transformDirection(hits[i].object.matrixWorld) : new THREE.Vector3(0, 1, 0); return { src: so.userData.src, skin: so.userData.skin, point: hits[i].point.clone(), normal: nrm, object: so, distance: hits[i].distance }; }
      return null;
    }
    function groundPoint(cx, cy, y) { var r = canvas.getBoundingClientRect(); ptr.set(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1); ray.setFromCamera(ptr, camera); var pl = new THREE.Plane(new THREE.Vector3(0, 1, 0), -y), out = new THREE.Vector3(); return ray.ray.intersectPlane(pl, out) ? out : null; }
    function planePoint(cx, cy, point, normal) { var r = canvas.getBoundingClientRect(); ptr.set(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1); ray.setFromCamera(ptr, camera); var pl = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, point), out = new THREE.Vector3(); return ray.ray.intersectPlane(pl, out) ? out : null; }
    // the highlight box of a set of source ids
    function setSelection(ids) {
      clear(selGroup); dirty = true; if (!ids || !ids.length) { return; } var set = {}, box = new THREE.Box3(), any = false; ids.forEach(function (i) { set[i] = 1; });
      content.children.forEach(function (c) { if (set[c.userData.src] && !c.userData.skin) { box.expandByObject(c); any = true; } }); markers.forEach(function (m) { if (set[m.userData.src]) { box.expandByObject(m); any = true; } });
      if (any && !box.isEmpty()) { var bh = new THREE.Box3Helper(box, 0x2f81f7); bh.material.depthTest = false; bh.renderOrder = 999; selGroup.add(bh); }
    }
    function setGrid(on) { showGrid = on; if (grid) { helpers.remove(grid); dispose(grid); grid = null; } if (on) { grid = new THREE.GridHelper(opt.gridSize || 20, opt.gridSize || 20, 0x586174, 0x2c3340); helpers.add(grid); } dirty = true; }
    function frame(box) { if (!box || box.isEmpty()) { return; } var c = box.getCenter(new THREE.Vector3()), s = box.getSize(new THREE.Vector3()), R = Math.max(1, s.length() * 0.9), dir = camera.position.clone().sub(controls ? controls.target : c).normalize(); if (dir.lengthSq() < 0.001) { dir.set(0.5, 0.4, 1).normalize(); } camera.position.copy(c.clone().add(dir.multiplyScalar(R * 1.7))); if (controls) { controls.target.copy(c); controls.update(); } else { camera.lookAt(c); } dirty = true; }
    function fit() { var b = new THREE.Box3(); content.children.forEach(function (c) { if (!c.isLight) { b.expandByObject(c); } }); frame(b); }
    function draw() { if (renderer) { renderer.render(scene, camera); } else if (ctx2d) { try { opt.raster(scene, camera, ctx2d, canvas.width, canvas.height); } catch (e) { /* the next frame */ } } }
    function shot(type, q) { return new Promise(function (res) { var hv = helpers.visible, sv = selGroup.visible; helpers.visible = false; selGroup.visible = false; draw(); canvas.toBlob(function (b) { helpers.visible = hv; selGroup.visible = sv; dirty = true; res(b); }, type || 'image/png', q); }); }
    function tick() { if (dead) { return; } if (el.isConnected && (renderer || ctx2d) && el.clientWidth > 0 && (dirty || burst > 0)) { if (burst > 0) { burst--; } dirty = false; draw(); } requestAnimationFrame(tick); }
    function destroy() { dead = true; if (ro) { ro.disconnect(); } clear(content); clear(helpers); clear(selGroup); if (controls) { controls.dispose(); } if (renderer) { renderer.dispose(); } }
    setTimeout(size, 0); requestAnimationFrame(tick);
    return { el: el, canvas: canvas, camera: camera, controls: controls, scene: scene, content: content, rebuild: rebuild, applyCamera: applyCamera, getView: getView, pickAt: pickAt, groundPoint: groundPoint, planePoint: planePoint, setSelection: setSelection, setGrid: setGrid, fit: fit, frame: frame, shot: shot, destroy: destroy, size: size, dirty: function () { dirty = true; }, burst: function (n) { burst = n || 60; }, THREE: THREE };
  }

  // wrap skins (on a sphere, a cylinder side…) are painted into one texture: the base colour, then every skin at its place (u, v, w, h) of the 0..1 square
  function makeBaker(resolve) {
    var cache = {};
    function imgFor(url) { if (!url) { return null; } var c = cache[url]; if (c) { return c.ok ? c.img : null; } var rec = { ok: false, img: new Image() }; cache[url] = rec; rec.img.onload = function () { rec.ok = true; if (rec.onload) { rec.onload(); } }; rec.img.src = url; return null; }
    var pendingCb = null;
    return {
      bake: function (obj, wrap, res, mm) {
        var R = res || resolve, W = obj.mesh === 'sphere' || obj.mesh === 'cylinder' || obj.mesh === 'cone' ? 1024 : 512, H = obj.mesh === 'sphere' || obj.mesh === 'cylinder' || obj.mesh === 'cone' ? 512 : 512, cv = document.createElement('canvas'); cv.width = W; cv.height = H; var g = cv.getContext('2d');
        g.fillStyle = mm.color || '#cccccc'; g.fillRect(0, 0, W, H);
        wrap.forEach(function (k) {
          var w = k.w * W, hh = k.h * H, cx = k.u * W, cy = (1 - k.v) * H; g.save(); g.globalAlpha = k.opacity; g.translate(cx, cy); g.rotate(-k.rotate * Math.PI / 180);
          if (k.image) { var url = /^ref:/.test(k.image) ? (R ? R(k.image) : null) : k.image, im = imgFor(url); if (im) { g.drawImage(im, -w / 2, -hh / 2, w, hh); } else if (pendingCb) { var rec = cache[url]; if (rec) { rec.onload = pendingCb; } } } else { g.fillStyle = k.color; g.fillRect(-w / 2, -hh / 2, w, hh); }
          g.restore();
        });
        return { texture: cv.toDataURL('image/png'), color: '#ffffff' };
      },
      onImageReady: function (cb) { pendingCb = cb; }
    };
  }

  // ───────────────────────── the scene editor ─────────────────────────
  function mount(opt) {
    var host = opt.host || {}, store = opt.store || Store, resolve = function (ref) { return store ? store.imageUrl(String(ref).replace(/^ref:/, '')) : ''; }, baker = makeBaker(resolve), self_stage = null, ctxRef = null;
    var W = { validate: C.validate, applyEdits: C.applyEdits, editWords: C.editWords, list: C.list, find: C.find };
    return Shell.mount({
      id: opt.id, kind: 'edit-3d', title: '🧊 3D 場景編輯器', W: W, spec: opt.spec, state: opt.state, host: host, container: opt.container, restoring: opt.restoring, windowApi: opt.windowApi,
      tabs: [{ id: 'view', label: '🎲 場景', viewer: true }, { id: 'source', label: '🧾 YAML 原始碼' }],
      placeholder: '用說的擺：「在我的左前方放一個紅色的球」「把它移到桌子上面」「把桌子往右移 2 公尺」「把球貼上這張圖」（貼圖可以直接貼進來）；位置都是以你現在看的角度來說',
      intro: '我是 3D 場景的助手：你說要放什麼、放在哪裡，我就加一個新的物件，位置是用「你現在看的角度」算的——「我的左前方」就是相機看過去的左前方，「桌子的右邊」就是從你這邊看桌子的右邊。物件欄是樹狀的（可以把東西綁成群組）；雙擊物件欄的項目（或畫面裡的物件）可以進到「單一物件編輯」，像做塑膠模型一樣決定每個面貼什麼圖、塗什麼顏色。拖曳畫面空白處轉視角、滾輪縮放、右鍵平移；點物件選取、拖曳可以移動。「🧾 YAML 原始碼」分頁可以直接改場景，回到畫面就會立刻呈現。貼一張圖進來可以當選取物件的貼圖。每一步都能復原。',
      objectIcon: function (o) { return o.type === 'mesh' ? (ICON[o.mesh] || '◻') : (ICON[o.type] || '◻'); },
      objectInfo: function (o) { return o.type === 'mesh' ? C.MESHES[o.mesh] + (o.skins ? '・貼皮' : '') : o.type === 'light' ? ({ directional: '平行光', point: '點光源', ambient: '環境光' })[o.light] : '群組'; },
      treeRows: function (sp, collapsed) { var rows = C.tree(sp), out = [], hideBelow = -1; rows.forEach(function (r) { if (hideBelow >= 0) { if (r.depth > hideBelow) { return; } hideBelow = -1; } out.push(r); if (r.obj.type === 'group' && collapsed[r.obj.id]) { hideBelow = r.depth; } }); return out; },
      onObjectOpen: function (o) { if (o.type === 'mesh' && C.zonesOf(o.mesh).length && opt.openPart) { opt.openPart(o); } else if (ctxRef) { ctxRef.say('只有方塊、圓柱、圓錐、球、圓環與平面可以進到單一物件編輯貼皮'); } },
      parseCommands: C.parseCommands, promptOf: C.promptOf,
      exports: [{ id: 'scene', label: '場景 YAML（可直接播放）' }, { id: 'png', label: 'PNG 截圖' }, { id: 'yaml', label: '專案 YAML（原始碼）', chat: false }],
      runExport: async function (id, spec) {
        var name = slug(spec.title);
        if (id === 'png') { var b = await (self_stage && self_stage.shot ? self_stage.shot('image/png') : null); if (!b) { throw new Error('沒有畫面可以截圖'); } return { blob: b, name: name + '.png', mime: 'image/png' }; }
        if (id === 'yaml') { return { blob: new Blob([C.toYaml(spec)], { type: 'text/yaml' }), name: name + '.edit3d.yaml', mime: 'text/yaml' }; }
        var yml = C.toSceneYaml(spec, { resolve: resolve, bake: baker.bake }); return { blob: new Blob([yml], { type: 'text/yaml' }), name: name + '.3dscene.yaml', mime: 'text/yaml', sceneYaml: yml };
      },
      build: function (ctx) {
        ctxRef = ctx; var spec = null, sel = null, lastKey = '', lastCam = '', stage = null, mode = 'move', drag = null, viewWrap = h('div'), srcWrap = h('div'), lastSource = '', self = {}, pendingSel = false;
        viewWrap.style.cssText = 'display:flex;flex-direction:column;flex:1;min-height:0;min-width:0'; srcWrap.style.cssText = 'display:flex;flex-direction:column;gap:6px;flex:1';
        var bar = h('div', 'row'); bar.style.cssText = 'padding:4px 6px;gap:4px;flex:none;border-bottom:1px solid var(--bd)';
        var bOrigin = opt.origin && opt.updateOrigin ? h('button', null, '↩ 更新回原本的場景') : null; if (bOrigin) { bOrigin.title = '把目前的場景放回對話裡它原本的位置（取代那個 3D 場景）'; bOrigin.onclick = function () { var yml = C.toSceneYaml(spec, { resolve: resolve, bake: baker.bake }); opt.updateOrigin(yml).then(function (ok) { ctx.say(ok ? '已更新回原本的場景' : '找不到原本的場景'); }, function (e) { ctx.say('更新失敗：' + String((e && e.message) || e).slice(0, 60)); }); }; }
        var bMove = h('button', null, '✥ 移動'), bRot = h('button', null, '⟳ 轉'), bScl = h('button', null, '⤢ 縮放'), bGrid = h('button', null, '▦ 格線'), bFit = h('button', null, '⌖ 看全部'), bCam = h('button', null, '📷 存成預設視角'), hint = h('span', 'st', '');
        bMove.title = '拖曳選取的物件在地面上移動（按住 Shift 上下移）'; bRot.title = '左右拖曳：繞垂直軸轉'; bScl.title = '上下拖曳：放大縮小'; bFit.title = '把相機移到看得到所有東西'; bCam.title = '把目前的角度存成場景的視角（匯出的場景會用它）';
        [bMove, bRot, bScl, bGrid, bFit, bCam, bOrigin, hint].forEach(function (x) { if (x) { bar.appendChild(x); } });
        function modeBtns() { [[bMove, 'move'], [bRot, 'rot'], [bScl, 'scl']].forEach(function (p) { p[0].style.borderColor = mode === p[1] ? 'var(--acc)' : ''; }); }
        bMove.onclick = function () { mode = 'move'; modeBtns(); }; bRot.onclick = function () { mode = 'rot'; modeBtns(); }; bScl.onclick = function () { mode = 'scl'; modeBtns(); }; modeBtns();
        var grid = true; bGrid.onclick = function () { grid = !grid; if (stage) { stage.setGrid(grid); } };
        stage = makeStage({ buildNode: opt.buildNode, grid: true, gridSize: 20, raster: opt.raster }); self_stage = stage; viewWrap.appendChild(bar); viewWrap.appendChild(stage.el);
        bFit.onclick = function () { stage.fit(); }; bCam.onclick = function () { var v = stage.getView(); ctx.apply([{ op: 'set_camera', position: v.position, look_at: v.target, fov: v.fov }], '存下目前的視角', '', 'panel'); };
        baker.onImageReady(function () { rebuildNow(); });
        function allIds(id) { if (!id || !spec) { return []; } return [id].concat(C.descendants(spec, id).map(function (o) { return o.id; })); }
        function rebuildNow() { if (!spec) { return; } var def = C.toScene(spec, { tags: true, resolve: resolve, bake: baker.bake, hidden: false }); stage.rebuild(def); stage.setSelection(allIds(sel)); }
        // ───── picking and dragging in the viewer ─────
        var downAt = null;
        stage.canvas.addEventListener('pointerdown', function (ev) {
          if (ev.button !== 0) { return; } downAt = { x: ev.clientX, y: ev.clientY, hit: stage.pickAt(ev.clientX, ev.clientY), moved: false }; var hit = downAt.hit; if (!hit) { return; }
          var o = spec.objects[C.byId(spec, hit.src)]; if (!o) { return; } var target = ev.altKey && o.parent ? o.parent : o.id; if (target !== sel) { ctx.select(target); } var to = spec.objects[C.byId(spec, target)]; if (to.locked) { return; }
          if (stage.controls) { stage.controls.enabled = false; } var ids = allIds(target), objs = stage.content.children.filter(function (c) { return ids.indexOf(c.userData.src) >= 0; });
          var markersHit = hit.object && hit.object.userData && hit.object.userData.marker ? hit.object : null; if (markersHit) { objs = [markersHit]; }
          var b = C.worldBox(spec, to), p0 = b ? b.center : hit.point.toArray(), y0 = hit.point.y, start = ev.shiftKey && mode === 'move' ? stage.planePoint(ev.clientX, ev.clientY, hit.point, new stage.THREE.Vector3(stage.camera.position.x - hit.point.x, 0, stage.camera.position.z - hit.point.z).normalize()) : stage.groundPoint(ev.clientX, ev.clientY, y0);
          var pivot = C.worldT(spec, to).t, snap = objs.map(function (ob) { return { ob: ob, p: ob.position.clone(), r: ob.rotation.y, s: ob.scale.clone() }; });
          drag = { id: target, mode: ev.shiftKey && mode === 'move' ? 'vert' : mode, start: start, sx: ev.clientX, sy: ev.clientY, snap: snap, pivot: pivot, y0: y0, hitPoint: hit.point.clone(), moved: false, delta: [0, 0, 0], turn: 0, factor: 1 };
          try { stage.canvas.setPointerCapture(ev.pointerId); } catch (e) { /* a synthetic pointer: no capture */ } ev.stopPropagation();
        }, true);
        stage.canvas.addEventListener('pointermove', function (ev) {
          if (downAt && (Math.abs(ev.clientX - downAt.x) + Math.abs(ev.clientY - downAt.y) > 4)) { downAt.moved = true; }
          if (!drag) { return; } var T = stage.THREE;
          if (Math.abs(ev.clientX - drag.sx) + Math.abs(ev.clientY - drag.sy) > 3) { drag.moved = true; } if (!drag.moved) { return; }
          if (drag.mode === 'move') { var q = stage.groundPoint(ev.clientX, ev.clientY, drag.y0); if (!q || !drag.start) { return; } drag.delta = [q.x - drag.start.x, 0, q.z - drag.start.z]; drag.snap.forEach(function (s) { s.ob.position.set(s.p.x + drag.delta[0], s.p.y, s.p.z + drag.delta[2]); }); }
          else if (drag.mode === 'vert') { var vp = stage.planePoint(ev.clientX, ev.clientY, drag.hitPoint, new T.Vector3(stage.camera.position.x - drag.hitPoint.x, 0, stage.camera.position.z - drag.hitPoint.z).normalize()); if (!vp || !drag.start) { return; } drag.delta = [0, vp.y - drag.start.y, 0]; drag.snap.forEach(function (s) { s.ob.position.set(s.p.x, s.p.y + drag.delta[1], s.p.z); }); }
          else if (drag.mode === 'rot') { var a = (ev.clientX - drag.sx) * 0.01; drag.turn = a; drag.snap.forEach(function (s) { var dx = s.p.x - drag.pivot[0], dz = s.p.z - drag.pivot[2], c = Math.cos(a), sn = Math.sin(a); s.ob.position.set(drag.pivot[0] + dx * c + dz * sn, s.p.y, drag.pivot[2] - dx * sn + dz * c); s.ob.rotation.y = s.r + a; }); }
          else if (drag.mode === 'scl') { var f = Math.exp(-(ev.clientY - drag.sy) * 0.006); drag.factor = f; drag.snap.forEach(function (s) { var dx = s.p.x - drag.pivot[0], dy = s.p.y - drag.pivot[1], dz = s.p.z - drag.pivot[2]; s.ob.position.set(drag.pivot[0] + dx * f, drag.pivot[1] + dy * f, drag.pivot[2] + dz * f); s.ob.scale.copy(s.s).multiplyScalar(f); }); }
          stage.setSelection(allIds(drag.id)); stage.dirty();
        });
        function endDrag(ev) {
          if (stage.controls) { stage.controls.enabled = true; } var d = drag; drag = null;
          if (d && d.moved) {
            var o = spec.objects[C.byId(spec, d.id)], nm = o ? o.name : d.id;
            if (d.mode === 'move' || d.mode === 'vert') { ctx.apply([{ op: 'transform_object', id: d.id, move_world: d.delta.map(function (x) { return Math.round(x * 100) / 100; }) }], '移動 ' + nm, '', 'panel'); }
            else if (d.mode === 'rot') { ctx.apply([{ op: 'transform_object', id: d.id, turn: Math.round(d.turn * 180 / Math.PI * 10) / 10 }], '轉動 ' + nm, '', 'panel'); }
            else if (d.mode === 'scl') { ctx.apply([{ op: 'transform_object', id: d.id, scale: Math.round(d.factor * 1000) / 1000 }], '縮放 ' + nm, '', 'panel'); }
          } else if (d) { rebuildNow(); }
          else if (downAt && !downAt.moved && !downAt.hit) { ctx.select(null); }
          downAt = null;
        }
        stage.canvas.addEventListener('pointerup', endDrag); stage.canvas.addEventListener('pointercancel', endDrag);
        stage.canvas.addEventListener('dblclick', function (ev) { var hit = stage.pickAt(ev.clientX, ev.clientY); if (!hit) { return; } var o = spec.objects[C.byId(spec, hit.src)]; if (o && o.type === 'mesh' && C.zonesOf(o.mesh).length && opt.openPart) { opt.openPart(o); } });
        // ───── properties ─────
        function field(label, type, value, onChange, extra) {
          var l = h('label'), i = h('input'); i.type = type; i.value = value == null ? '' : value; if (extra && extra.step) { i.step = extra.step; } if (extra && extra.min != null) { i.min = extra.min; } if (extra && extra.max != null) { i.max = extra.max; } l.appendChild(document.createTextNode(label)); l.appendChild(i);
          i.onchange = function () { onChange(type === 'number' ? Number(i.value) : i.value); }; return l;
        }
        function vecRow(label, v, onChange, step, conv) { var l = h('div', 'row'); l.appendChild(h('span', 'st', label)); [0, 1, 2].forEach(function (k) { var i = h('input'); i.type = 'number'; i.step = step || 0.1; i.style.width = '64px'; i.value = conv ? conv.to(v[k]) : v[k]; i.onchange = function () { var nv = v.slice(); nv[k] = conv ? conv.from(Number(i.value)) : Number(i.value); onChange(nv); }; l.appendChild(i); }); return l; }
        function props() {
          var box = h('div'); box.style.cssText = 'display:flex;flex-direction:column;gap:6px';
          var o = sel ? spec.objects.filter(function (x) { return x.id === sel; })[0] : null;
          function upd(p, words) { ctx.apply([{ op: 'update_object', id: o.id, props: p }], words || ('改 ' + o.name), '', 'panel'); }
          if (!o) {
            box.appendChild(h('div', 'st', '場景'));
            box.appendChild(field('名稱', 'text', spec.title, function (v) { ctx.apply([{ op: 'set_title', text: v }], '標題改成「' + v + '」', '', 'panel'); }));
            box.appendChild(field('背景', 'color', hex(spec.background, '#1a1d24'), function (v) { ctx.apply([{ op: 'set_background', color: v }], '背景 ' + v, '', 'panel'); }));
            box.appendChild(field('視角廣度', 'number', spec.camera.fov, function (v) { ctx.apply([{ op: 'set_camera', fov: v }], '視角廣度 ' + v, '', 'panel'); }, { step: 5, min: 10, max: 120 }));
            var r = h('div', 'row'); [['正面', 'front'], ['背面', 'back'], ['左', 'left'], ['右', 'right'], ['上', 'top'], ['斜角', 'iso']].forEach(function (p) { var b = h('button', null, p[0]); b.onclick = function () { ctx.apply([{ op: 'set_camera', preset: p[1] }], '視角：' + p[0], '', 'panel'); }; r.appendChild(b); }); box.appendChild(h('div', 'st', '預設視角')); box.appendChild(r);
            box.appendChild(h('div', 'st', '點物件選取；拖曳移動；Alt+點選取它的群組。')); return box;
          }
          box.appendChild(h('div', 'st', o.name + '（' + (o.type === 'mesh' ? C.MESHES[o.mesh] : o.type === 'group' ? '群組' : '燈光') + '，' + o.id + '）'));
          box.appendChild(field('名稱', 'text', o.name, function (v) { ctx.apply([{ op: 'rename_object', id: o.id, name: v }], o.name + ' 改名為 ' + v, '', 'panel'); }));
          if (o.parent) { var up = h('button', null, '⬆ 選它的群組'); up.onclick = function () { ctx.select(o.parent); }; box.appendChild(up); }
          if (o.type === 'light') {
            var sl = h('select'); [['directional', '平行光'], ['point', '點光源'], ['ambient', '環境光']].forEach(function (p) { var op = h('option', null, p[1]); op.value = p[0]; if (o.light === p[0]) { op.selected = true; } sl.appendChild(op); }); sl.onchange = function () { upd({ light: sl.value }, o.name + ' 改成' + sl.options[sl.selectedIndex].text); }; var lr = h('label'); lr.appendChild(document.createTextNode('種類')); lr.appendChild(sl); box.appendChild(lr);
            box.appendChild(field('顏色', 'color', hex(o.color, '#ffffff'), function (v) { upd({ color: v }, o.name + ' 顏色 ' + v); })); box.appendChild(field('強度', 'number', o.intensity, function (v) { upd({ intensity: v }); }, { step: 0.1, min: 0 }));
            if (o.light !== 'ambient') { box.appendChild(vecRow('位置', o.position, function (v) { upd({ position: v }, o.name + ' 移動'); }, 0.5)); }
            return box;
          }
          box.appendChild(vecRow('位置', o.position, function (v) { upd({ position: v }, o.name + ' 移動'); }, 0.1)); box.appendChild(vecRow('旋轉°', o.rotation, function (v) { upd({ rotation: v }, o.name + ' 旋轉'); }, 5, { to: deg, from: function (d) { return d * Math.PI / 180; } }));
          if (o.type === 'group') { box.appendChild(field('縮放', 'number', o.scale, function (v) { upd({ scale: v }); }, { step: 0.1, min: 0.01 })); var ug = h('button', null, '解散群組'); ug.onclick = function () { ctx.apply([{ op: 'ungroup', id: o.id }], '解散 ' + o.name, '', 'panel'); }; box.appendChild(ug); }
          if (o.type === 'mesh') {
            if (o.size) { box.appendChild(vecRow(o.mesh === 'plane' ? '大小(寬,長)' : '大小', o.mesh === 'plane' ? [o.size[0], o.size[1], 0] : o.size, function (v) { upd({ size: o.mesh === 'plane' ? [v[0], v[1]] : v }, o.name + ' 大小'); }, 0.1)); }
            ['radius', 'height', 'tube_radius'].forEach(function (k) { if (o[k] != null) { box.appendChild(field({ radius: '半徑', height: '高度', tube_radius: '管徑' }[k], 'number', o[k], function (v) { var p = {}; p[k] = v; upd(p); }, { step: 0.1, min: 0.001 })); } });
            var m = o.material || {};
            box.appendChild(field('顏色', 'color', hex(m.color, '#4e79a7'), function (v) { upd({ material: { color: v } }, o.name + ' 顏色 ' + v); }));
            box.appendChild(field('金屬感', 'number', m.metalness, function (v) { upd({ material: { metalness: v } }, o.name + ' 金屬感'); }, { step: 0.1, min: 0, max: 1 })); box.appendChild(field('粗糙度', 'number', m.roughness, function (v) { upd({ material: { roughness: v } }, o.name + ' 粗糙度'); }, { step: 0.1, min: 0, max: 1 })); box.appendChild(field('不透明度', 'number', m.opacity == null ? 1 : m.opacity, function (v) { upd({ material: { opacity: v } }, o.name + ' 透明度'); }, { step: 0.1, min: 0.05, max: 1 }));
            var ts = h('select'); [['', '（無）'], ['water', '水'], ['grass', '草'], ['sand', '沙'], ['wood', '木'], ['brick', '磚']].forEach(function (p) { var op = h('option', null, p[1]); op.value = p[0]; ts.appendChild(op); }); var isRef = /^(ref:|data:|http)/.test(m.texture || ''); if (isRef) { var op2 = h('option', null, '我的貼圖'); op2.value = m.texture; ts.appendChild(op2); } ts.value = m.texture || ''; ts.onchange = function () { ctx.apply([{ op: 'set_material', id: o.id, texture: ts.value || '' }], o.name + ' 材質 ' + (ts.options[ts.selectedIndex].text), '', 'panel'); };
            var tl = h('label'); tl.appendChild(document.createTextNode('整個物件的貼圖')); tl.appendChild(ts); box.appendChild(tl);
            if (m.texture) { box.appendChild(field('重複', 'number', m.texture_repeat ? m.texture_repeat[0] : 1, function (v) { ctx.apply([{ op: 'set_material', id: o.id, texture_repeat: [v, v] }], o.name + ' 貼圖重複 ' + v, '', 'panel'); }, { step: 1, min: 0.1 })); }
            if (opt.keepTexture) { var fb = h('button', null, '📎 用圖片檔當貼圖…'), fi = h('input'); fi.type = 'file'; fi.accept = 'image/*'; fi.style.display = 'none'; fb.onclick = function () { fi.click(); }; fi.onchange = function () { var f = fi.files && fi.files[0]; fi.value = ''; if (!f) { return; } opt.keepTexture(f).then(function (ref) { ctx.apply([{ op: 'set_material', id: o.id, texture: 'ref:' + ref }], o.name + ' 貼上圖片', '', 'panel'); }, function (e) { ctx.say('貼圖失敗：' + String((e && e.message) || e).slice(0, 60)); }); }; box.appendChild(fb); box.appendChild(fi); }
            if (C.zonesOf(o.mesh).length && opt.openPart) { var pb = h('button', 'pri', '🎨 單一物件編輯（貼皮、上色）…'); pb.onclick = function () { opt.openPart(o); }; box.appendChild(pb); if (o.skins) { box.appendChild(h('div', 'st', '貼皮 ' + o.skins.length + ' 層：' + o.skins.map(function (k) { return C.ZONE_LABEL[k.zone]; }).join('、'))); } }
          }
          return box;
        }
        // ───── source (YAML) ─────
        var srcTa = h('textarea', 'code'); srcTa.rows = 18; srcTa.spellcheck = false; srcTa.style.flex = '1'; var srcRow = h('div', 'row'), bApply = h('button', 'pri', '▶ 套用並看畫面'), bRe = h('button', null, '↻ 放棄修改'), srcSt = h('span', 'st'); [bApply, bRe, srcSt].forEach(function (x) { srcRow.appendChild(x); });
        srcWrap.appendChild(h('div', 'st', '場景的 YAML（render_3d_scene 的格式，多了 id、name、parent、mesh: group、hidden、locked、skins）。可以直接改，改完按「套用並看畫面」或直接切回「場景」分頁。匯出「場景 YAML」會展平成 render_3d_scene 可以直接播放的樣子。'));
        srcWrap.appendChild(srcTa); srcWrap.appendChild(srcRow);
        function sourceNow() { return C.toYaml(spec); }
        var live = null; srcTa.addEventListener('input', function () { clearTimeout(live); live = setTimeout(function () { var r = C.fromYaml(srcTa.value); srcSt.className = 'st' + (r.ok ? '' : ' bad'); srcSt.textContent = r.ok ? (srcTa.value === lastSource ? '' : '有改動，還沒套用') : r.error; }, 300); });
        function applySource(quiet) {
          var text = srcTa.value; if (text === lastSource) { srcSt.className = 'st'; srcSt.textContent = quiet ? '' : '沒有改動'; return true; }
          var r = C.fromYaml(text); if (!r.ok) { srcSt.className = 'st bad'; srcSt.textContent = r.error; return false; }
          if (!r.spec.objects.length) { srcSt.className = 'st bad'; srcSt.textContent = '沒有可用的物件' + (r.problems[0] ? '：' + r.problems[0] : ''); return false; }
          ctx.commit(r.spec, '改寫原始碼（' + r.spec.objects.length + ' 個物件）', '', 'panel'); srcSt.className = 'st'; srcSt.textContent = '已套用' + (r.problems.length ? '（略過 ' + r.problems.length + ' 個不能用的項目：' + r.problems[0] + '）' : ''); return true;
        }
        bApply.onclick = function () { if (applySource(false)) { ctx.setTab('view'); rebuildNow(); } };
        bRe.onclick = function () { srcTa.value = lastSource = sourceNow(); srcSt.className = 'st'; srcSt.textContent = ''; };
        return {
          tabs: { view: viewWrap, source: srcWrap },
          env: function () { var v = stage.getView(); return { view: { position: v.position, target: v.target } }; },
          refresh: function (s, selId) {
            var key = JSON.stringify(s), camKey = JSON.stringify(s.camera), selChanged = selId !== sel; spec = s; sel = selId;
            if (key !== lastKey) { lastKey = key; rebuildNow(); } else if (selChanged) { stage.setSelection(allIds(sel)); }
            if (camKey !== lastCam) { lastCam = camKey; stage.applyCamera(s.camera); }
            ctx.setProps(props());
            if (document.activeElement !== srcTa) { srcTa.value = lastSource = sourceNow(); }
          },
          showTab: function (t) {
            if (t === 'source') { srcTa.value = lastSource = sourceNow(); srcSt.textContent = ''; srcSt.className = 'st'; }
            else { if (srcTa.value !== lastSource && !applySource(true)) { ctx.setTab('source'); return; } stage.size(); stage.dirty(); }
          },
          stage: stage, destroy: function () { stage.destroy(); }
        };
      }
    });
  }

  // ───────────────────────── the part editor: one object, its skins ─────────────────────────
  function mountPart(opt) {
    var host = opt.host || {}, store = opt.store || Store, resolve = function (ref) { return store ? store.imageUrl(String(ref).replace(/^ref:/, '')) : ''; }, baker = makeBaker(resolve), done = false;
    var W = { validate: PC.validate, applyEdits: PC.applyEdits, editWords: PC.editWords, list: PC.list, find: PC.find };
    var stageRef = null;
    var el = Shell.mount({
      id: opt.id, kind: 'edit-3d-part', title: '🎨 單一物件編輯', W: W, spec: opt.spec, state: opt.state, host: host, restoring: true, windowApi: opt.windowApi,
      tabs: [{ id: 'view', label: '🧩 模型', viewer: true }],
      placeholder: '用說的貼：「把正面貼上這張圖」（圖直接貼進來）「上面塗成藍色」「貼在右上角、小一點」「底色改成白色」「把它轉 45 度」；或在模型上點一下，選取的貼皮就移到那裡',
      intro: '這裡像在做塑膠模型：選一個面，貼上圖或塗上顏色，決定貼在那個面的哪裡、多大、轉幾度。在模型上點一下，選取的那一層貼皮就會移到你點的地方（也會換到那一面）；沒有選取貼皮時，點一下會告訴你點到哪一面。圖可以直接貼進對話框。做好按上面的「✔ 完成」就會把結果交回場景。',
      objectIcon: function (o) { return o.image ? '🖼' : '🎨'; }, objectInfo: function (o) { return PC.zoneLabel('', o.zone); },
      parseCommands: PC.parseCommands, promptOf: PC.promptOf,
      exports: [{ id: 'png', label: 'PNG 截圖' }],
      runExport: async function () { var b = stageRef ? await stageRef.shot('image/png') : null; if (!b) { throw new Error('沒有畫面可以截圖'); } return { blob: b, name: 'skin.png', mime: 'image/png' }; },
      build: function (ctx) {
        var spec = null, sel = null, stage = null, lastKey = '', viewWrap = h('div'), marker = null, info = h('span', 'st', '');
        viewWrap.style.cssText = 'display:flex;flex-direction:column;flex:1;min-height:0;min-width:0';
        var bar = h('div', 'row'); bar.style.cssText = 'padding:4px 6px;gap:4px;flex:none;border-bottom:1px solid var(--bd)'; var bFit = h('button', null, '⌖ 看全部'), bDone = h('button', 'pri', '✔ 完成，交回場景'), bCancel = h('button', null, '✕ 放棄修改'); [bFit, info].forEach(function (x) { bar.appendChild(x); });
        stage = makeStage({ buildNode: opt.buildNode, grid: false, markers: false, raster: opt.raster }); stageRef = stage; viewWrap.appendChild(bar); viewWrap.appendChild(stage.el);
        bFit.onclick = function () { stage.fit(); };
        bDone.onclick = function () { if (done) { return; } done = true; opt.onDone && opt.onDone(PC.validate(ctx.getSpec()).spec); }; bCancel.onclick = function () { if (done) { return; } done = true; opt.onCancel && opt.onCancel(); };
        baker.onImageReady(function () { rebuildNow(); });
        function objOf(s) { var b = s.base, o = { type: 'mesh', mesh: b.mesh, name: '模型', position: [0, 0, 0], rotation: [0, 0, 0], material: b.material, skins: s.objects.filter(function (k) { return k.visible; }).map(function (k) { return { id: 'k' + k.id.slice(1), name: k.name, zone: k.zone, image: k.image, color: k.color, u: k.u, v: k.v, w: k.w, h: k.h, rotate: k.rotate, opacity: k.opacity }; }) }; ['size', 'radius', 'height', 'tube_radius'].forEach(function (k) { if (b[k] != null) { o[k] = b[k]; } }); return C.validate({ objects: [o, { type: 'light', light: 'ambient', intensity: 0.65 }, { type: 'light', light: 'directional', position: [4, 7, 6], intensity: 0.95 }, { type: 'light', light: 'directional', position: [-5, 3, -4], intensity: 0.35 }] }).spec; }
        function rebuildNow() { if (!spec) { return; } var sc = objOf(spec); stage.rebuild(C.toScene(sc, { tags: true, resolve: resolve, bake: baker.bake })); drawOutline(); }
        var outline = null;
        function drawOutline() {
          var T = stage.THREE; if (outline) { stage.scene.remove(outline); outline = null; } var k = sel ? spec.objects.filter(function (x) { return x.id === sel; })[0] : null; if (!k) { stage.dirty(); return; }
          var sc = objOf(spec), o = sc.objects[0], F = C.zoneFrame(o, k.zone); if (!F) { stage.dirty(); return; } var R = C.rotMat(F.rot), w = F.w * k.w / 2, hh = F.h * k.h / 2, cu = (k.u - 0.5) * F.w, cv = (k.v - 0.5) * F.h, a = k.rotate * Math.PI / 180, ca = Math.cos(a), sa = Math.sin(a);
          var pts = [[-w, -hh], [w, -hh], [w, hh], [-w, hh]].map(function (p) { var lx = p[0] * ca - p[1] * sa + cu, ly = p[0] * sa + p[1] * ca + cv, wv = [R[0][0] * lx + R[0][1] * ly + F.c[0] + F.n[0] * 0.02, R[1][0] * lx + R[1][1] * ly + F.c[1] + F.n[1] * 0.02, R[2][0] * lx + R[2][1] * ly + F.c[2] + F.n[2] * 0.02]; return new T.Vector3(wv[0], wv[1], wv[2]); });
          var g = new T.BufferGeometry().setFromPoints(pts), ln = new T.LineLoop(g, new T.LineBasicMaterial({ color: 0x2f81f7, depthTest: false })); ln.renderOrder = 999; stage.scene.add(ln); outline = ln; stage.dirty();
        }
        // click on the model: the selected skin goes there (and to that face); nothing selected: say which face it is
        var downAt = null;
        stage.canvas.addEventListener('pointerdown', function (ev) { if (ev.button === 0) { downAt = { x: ev.clientX, y: ev.clientY }; } });
        stage.canvas.addEventListener('pointerup', function (ev) {
          if (!downAt || Math.abs(ev.clientX - downAt.x) + Math.abs(ev.clientY - downAt.y) > 4) { downAt = null; return; } downAt = null; var hit = stage.pickAt(ev.clientX, ev.clientY); if (!hit) { return; }
          var o = objOf(spec).objects[0], z = C.zoneAt(o, hit.point.toArray(), hit.normal.toArray()); if (!z) { return; } info.textContent = PC.zoneLabel('', z.zone) + '（' + z.u.toFixed(2) + '，' + z.v.toFixed(2) + '）';
          var k = sel ? spec.objects.filter(function (x) { return x.id === sel; })[0] : null; if (!k || k.locked) { return; }
          ctx.apply([{ op: 'update_object', id: k.id, props: { zone: z.zone, u: z.u, v: z.v } }], '把 ' + k.name + ' 移到' + PC.zoneLabel('', z.zone) + '（' + z.u.toFixed(2) + '，' + z.v.toFixed(2) + '）', '', 'panel');
        });
        function field(label, type, value, onChange, extra) { var l = h('label'), i = h('input'); i.type = type; i.value = value == null ? '' : value; if (extra && extra.step) { i.step = extra.step; } if (extra && extra.min != null) { i.min = extra.min; } if (extra && extra.max != null) { i.max = extra.max; } l.appendChild(document.createTextNode(label)); l.appendChild(i); i.onchange = function () { onChange(type === 'number' ? Number(i.value) : i.value); }; return l; }
        function props() {
          var box = h('div'); box.style.cssText = 'display:flex;flex-direction:column;gap:6px'; var k = sel ? spec.objects.filter(function (x) { return x.id === sel; })[0] : null;
          if (!k) {
            var m = spec.base.material; box.appendChild(h('div', 'st', '整個物件（底）'));
            box.appendChild(field('底色', 'color', hex(m.color, '#cccccc'), function (v) { ctx.apply([{ op: 'set_base', color: v }], '底色 ' + v, '', 'panel'); })); box.appendChild(field('金屬感', 'number', m.metalness, function (v) { ctx.apply([{ op: 'set_base', metalness: v }], '金屬感', '', 'panel'); }, { step: 0.1, min: 0, max: 1 })); box.appendChild(field('粗糙度', 'number', m.roughness, function (v) { ctx.apply([{ op: 'set_base', roughness: v }], '粗糙度', '', 'panel'); }, { step: 0.1, min: 0, max: 1 }));
            var ts = h('select'); [['', '（無）'], ['water', '水'], ['grass', '草'], ['sand', '沙'], ['wood', '木'], ['brick', '磚']].forEach(function (p) { var op = h('option', null, p[1]); op.value = p[0]; ts.appendChild(op); }); ts.value = /^(water|grass|sand|wood|brick)$/.test(m.texture || '') ? m.texture : ''; ts.onchange = function () { ctx.apply([{ op: 'set_base', texture: ts.value || '' }], '材質 ' + ts.options[ts.selectedIndex].text, '', 'panel'); }; var tl = h('label'); tl.appendChild(document.createTextNode('整個表面的材質')); tl.appendChild(ts); box.appendChild(tl);
            var zr = h('div', 'row'); C.zonesOf(spec.base.mesh).forEach(function (z) { var b = h('button', null, '＋ ' + C.ZONE_LABEL[z]); b.title = '在這一面新增一層上色貼皮'; b.onclick = function () { ctx.apply([{ op: 'add_object', object: { type: 'skin', zone: z, color: '#e53935', w: 0.6, h: 0.6 } }], '新增 ' + C.ZONE_LABEL[z] + ' 的貼皮', '', 'panel'); }; zr.appendChild(b); }); box.appendChild(h('div', 'st', '新增貼皮（選一個面）')); box.appendChild(zr); box.appendChild(h('div', 'st', '圖片：直接貼進下面的對話框，或把圖拖進來；說「貼在正面」就會貼到那一面。')); return box;
          }
          box.appendChild(h('div', 'st', k.name + '（' + k.id + '）'));
          box.appendChild(field('名稱', 'text', k.name, function (v) { ctx.apply([{ op: 'rename_object', id: k.id, name: v }], k.name + ' 改名為 ' + v, '', 'panel'); }));
          var zs = h('select'); C.zonesOf(spec.base.mesh).forEach(function (z) { var op = h('option', null, C.ZONE_LABEL[z]); op.value = z; if (z === k.zone) { op.selected = true; } zs.appendChild(op); }); zs.onchange = function () { ctx.apply([{ op: 'set_zone', id: k.id, zone: zs.value }], k.name + ' 換到' + C.ZONE_LABEL[zs.value], '', 'panel'); }; var zl = h('label'); zl.appendChild(document.createTextNode('貼在')); zl.appendChild(zs); box.appendChild(zl);
          if (k.image) { box.appendChild(h('div', 'st', '貼圖：' + (/^ref:/.test(k.image) ? '我的圖片' : k.image.slice(0, 30)))); var rm = h('button', null, '改成純色'); rm.onclick = function () { ctx.apply([{ op: 'update_object', id: k.id, props: { image: '', color: k.color || '#cccccc' } }], k.name + ' 改成純色', '', 'panel'); }; box.appendChild(rm); }
          box.appendChild(field('顏色' + (k.image ? '（沒有圖時）' : ''), 'color', hex(k.color, '#cccccc'), function (v) { ctx.apply([{ op: 'update_object', id: k.id, props: { color: v, image: '' } }], k.name + ' 顏色 ' + v, '', 'panel'); }));
          if (opt.keepTexture) { var fb = h('button', null, '📎 換成圖片檔…'), fi = h('input'); fi.type = 'file'; fi.accept = 'image/*'; fi.style.display = 'none'; fb.onclick = function () { fi.click(); }; fi.onchange = function () { var f = fi.files && fi.files[0]; fi.value = ''; if (!f) { return; } opt.keepTexture(f).then(function (ref) { ctx.apply([{ op: 'update_object', id: k.id, props: { image: 'ref:' + ref } }], k.name + ' 貼上圖片', '', 'panel'); }, function (e) { ctx.say('貼圖失敗：' + String((e && e.message) || e).slice(0, 60)); }); }; box.appendChild(fb); box.appendChild(fi); }
          [['中心 左右 u', 'u'], ['中心 上下 v', 'v'], ['寬（占那一面）', 'w'], ['高（占那一面）', 'h']].forEach(function (p) { box.appendChild(field(p[0], 'number', k[p[1]], function (v) { var pr = {}; pr[p[1]] = v; ctx.apply([{ op: 'update_object', id: k.id, props: pr }], k.name + ' ' + p[1] + '=' + v, '', 'panel'); }, { step: 0.05 })); });
          box.appendChild(field('旋轉°', 'number', k.rotate, function (v) { ctx.apply([{ op: 'update_object', id: k.id, props: { rotate: v } }], k.name + ' 旋轉', '', 'panel'); }, { step: 5 })); box.appendChild(field('不透明度', 'number', k.opacity, function (v) { ctx.apply([{ op: 'update_object', id: k.id, props: { opacity: v } }], k.name + ' 透明度', '', 'panel'); }, { step: 0.1, min: 0.05, max: 1 }));
          box.appendChild(h('div', 'st', '在模型上點一下，這一層就會移到那裡。')); return box;
        }
        return {
          tabs: { view: viewWrap }, bar: [bCancel, bDone],
          env: function () { return {}; },
          refresh: function (s, selId) { var key = JSON.stringify(s), changed = selId !== sel; spec = s; sel = selId; if (key !== lastKey) { lastKey = key; rebuildNow(); if (!outline && !stage._framed) { stage._framed = true; stage.fit(); } } else if (changed) { drawOutline(); } ctx.setProps(props()); },
          stage: stage, destroy: function () { stage.destroy(); }
        };
      }
    });
    return el;
  }
  return { mount: mount, mountPart: mountPart, makeStage: makeStage, makeBaker: makeBaker };
});
