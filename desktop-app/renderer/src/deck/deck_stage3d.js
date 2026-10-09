// The 3D view of "/media-presentation" (three.js, WebGL): the relation between a CAMERA (the viewport) and a 3D scene with its model.
// A slide marked stage "3d" shows its 3D model in a neutral space that follows the company slide template (default environment
// "template": a light floor with a faint grid and soft light on the template's white; "template-dark" is the same on the template's
// navy, used behind title / topic slides; "studio", "opera" -- a theatre with curtains and spotlights -- and "space" are options), and the slide says where the camera is: a shot
// (preset front / three-quarter / left / right / back / top / wide / closeup, or azimuth / elevation / distance / fov, optionally
// focused on one named node of the model); a list of shots moves the camera from one to the next while the narration goes on.
// Changing slides is a camera move: "fly" pulls the camera back (or, for the same model, straight to the next shot). The viewer can
// still orbit (drag) and zoom (wheel) on top of the slide's shot; the offset is dropped when the slide changes. Everything flat (title,
// bullets, subtitles, tables, images, 2D overlays) is drawn by the caller on top of what compose() returns, so the words are always
// in front of the 3D.
//
// compose(ctx, state) is a function of the state it is given plus the viewer's own camera offsets (view), which are zero in an
// export -- so an MP4 shows exactly the slide's shots with a faint drift.
//
//   AiChatDeckStage3D.create() -> Promise<stage>   (rejects without WebGL: the deck then plays flat)
//   stage.compose(ctx, { width, height, T, phase:'body'|'transition', p, type:'fly'|'curtain'|'spin'|'fade'|'none', index, keepView?, rect?:{x,y,w,h},
//                        cur:{model, tv, t, key, shots:[{at, shot}], interactive, orbit}, prev:{...}|null, environment:'template'|'template-dark'|'studio'|'opera'|'space' })
//   rect = where on ctx (pixels) the view is drawn (a viewport inside the slide); without it the view fills width x height.
//   stage.view = {yaw, pitch, zoom}   stage.resetView()   stage.setPointerActive(bool)
//
// A model is {advanceTo(tv), root() -> THREE.Scene} (see scene3dVisual in ai_chat_deck_player.js).
(function (window) {
  'use strict';

  var FOV = 42;
  var STAGE_W = 24;           // width of the proscenium opening (opera environment)
  var DEG = Math.PI / 180;
  var MOVE_S = 1.2;           // seconds a camera move between two shots of one slide takes
  // Named shots: azimuth (deg, 0 = in front of the model, + = to its right), elevation (deg above the floor), distance (x the distance
  // that frames the whole model; < 1 closer).
  var PRESETS = {
    front: { az: 0, el: 8, dist: 1 }, 'three-quarter': { az: 32, el: 16, dist: 1 }, left: { az: -70, el: 10, dist: 1 },
    right: { az: 70, el: 10, dist: 1 }, back: { az: 180, el: 10, dist: 1 }, top: { az: 0, el: 78, dist: 1.05 },
    wide: { az: 20, el: 14, dist: 1.7 }, closeup: { az: 30, el: 14, dist: 0.45 }
  };
  var MODEL_MAX_H = 5.6, MODEL_MAX_W = 9.5;

  function loadScriptOnce(src) {
    return new Promise(function (resolve, reject) {
      if (window.THREE) { resolve(); return; }
      var script = document.createElement('script');
      script.src = src; script.async = true; script.onload = resolve;
      script.onerror = function () { reject(new Error('failed to load ' + src)); };
      document.head.appendChild(script);
    });
  }

  function clamp(x, a, b) { return Math.max(a, Math.min(b, x)); }
  function ease(p) { p = clamp(p, 0, 1); return p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2; }
  function lcg(seed) { var s = seed >>> 0; return function () { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; }; }

  function canvasTexture(THREE, w, h, paint, repeat) {
    var c = document.createElement('canvas'); c.width = w; c.height = h;
    paint(c.getContext('2d'), w, h);
    var t = new THREE.CanvasTexture(c); t.encoding = THREE.sRGBEncoding;
    if (repeat) { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(repeat[0], repeat[1]); }
    return t;
  }

  function create() {
    var urls = window.AiChatExportAssetUrls || {};
    // the 3D engine loads three.js itself: ask it, so the library is not loaded twice
    var ready = window.THREE ? Promise.resolve()
      : (window.AiChat3D && window.AiChat3D.ensureLibsLoaded ? window.AiChat3D.ensureLibsLoaded()
        : (urls.three ? loadScriptOnce(urls.three) : Promise.reject(new Error('three.js is not configured'))));
    return ready.then(function () {
      var THREE = window.THREE;
      var glCanvas = document.createElement('canvas'), renderer;
      try { renderer = new THREE.WebGLRenderer({ canvas: glCanvas, antialias: true, preserveDrawingBuffer: true }); } catch (e) { throw new Error('WebGL is not available'); }
      renderer.outputEncoding = THREE.sRGBEncoding;

      var scene = new THREE.Scene();
      scene.background = new THREE.Color(0x05070d);
      scene.fog = new THREE.Fog(0x05070d, 40, 90);
      var camera = new THREE.PerspectiveCamera(FOV, 16 / 9, 0.1, 300);

      var groups = { template: new THREE.Group(), 'template-dark': new THREE.Group(), opera: new THREE.Group(), studio: new THREE.Group(), space: new THREE.Group() };
      Object.keys(groups).forEach(function (k) { scene.add(groups[k]); });
      var common = new THREE.Group(); scene.add(common);

      // ---------------------------------------------------------------- the opera house
      var op = groups.opera;
      var plankTex = canvasTexture(THREE, 512, 512, function (g, w, h) {
        var rnd = lcg(5);
        for (var i = 0; i < 16; i++) {
          var l = 38 + rnd() * 10; g.fillStyle = 'hsl(26,48%,' + l + '%)'; g.fillRect(0, i * h / 16, w, h / 16 - 2);
          g.fillStyle = 'rgba(0,0,0,0.35)'; g.fillRect(0, i * h / 16 + h / 16 - 2, w, 2);
          for (var k = 0; k < 3; k++) { g.fillStyle = 'rgba(0,0,0,0.13)'; g.fillRect(rnd() * w, i * h / 16 + 4, 6 + rnd() * 80, 2); }
        }
      }, [3, 3]);
      var floor = new THREE.Mesh(new THREE.PlaneGeometry(30, 20), new THREE.MeshStandardMaterial({ map: plankTex, roughness: 0.42, metalness: 0.12 }));
      floor.rotation.x = -Math.PI / 2; floor.position.set(0, 0, -1); op.add(floor);
      var backdropTex = canvasTexture(THREE, 8, 512, function (g, w, h) {
        var grad = g.createLinearGradient(0, 0, 0, h); grad.addColorStop(0, '#0d2a45'); grad.addColorStop(0.55, '#0a1c30'); grad.addColorStop(1, '#040a12');
        g.fillStyle = grad; g.fillRect(0, 0, w, h);
      });
      var backdrop = new THREE.Mesh(new THREE.PlaneGeometry(40, 26), new THREE.MeshBasicMaterial({ map: backdropTex }));
      backdrop.position.set(0, 9, -10); op.add(backdrop);
      var strip = new THREE.Mesh(new THREE.PlaneGeometry(40, 0.1), new THREE.MeshBasicMaterial({ color: 0x77bd1d }));
      strip.position.set(0, 0.08, -9.95); op.add(strip);
      var gold = new THREE.MeshStandardMaterial({ color: 0xb08d3c, roughness: 0.35, metalness: 0.75 });
      var darkWood = new THREE.MeshStandardMaterial({ color: 0x1b1210, roughness: 0.7 });
      [-1, 1].forEach(function (sd) {
        var pillar = new THREE.Mesh(new THREE.BoxGeometry(1.6, 26, 1.8), darkWood); pillar.position.set(sd * (STAGE_W / 2 + 0.8), 11, 3); op.add(pillar);
        var trim = new THREE.Mesh(new THREE.BoxGeometry(0.22, 26, 2), gold); trim.position.set(sd * (STAGE_W / 2 - 0.05), 11, 3.1); op.add(trim);
      });
      var beam = new THREE.Mesh(new THREE.BoxGeometry(STAGE_W + 3.2, 2.4, 2), darkWood); beam.position.set(0, 12.6, 3); op.add(beam);
      var beamTrim = new THREE.Mesh(new THREE.BoxGeometry(STAGE_W, 0.28, 2.2), gold); beamTrim.position.set(0, 11.3, 3.1); op.add(beamTrim);

      function makeCurtain(side) {
        var geo = new THREE.PlaneGeometry(STAGE_W / 2, 24, 72, 1), pos = geo.attributes.position;
        for (var i = 0; i < pos.count; i++) { pos.setZ(i, Math.sin(pos.getX(i) * 4.6) * 0.42); }
        geo.computeVertexNormals();
        var mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0x8a0f1e, roughness: 0.85, side: THREE.DoubleSide }));
        mesh.position.set(side * STAGE_W / 4, 10.2, 2.4); mesh.userData.side = side; op.add(mesh); return mesh;
      }
      var curtains = [makeCurtain(-1), makeCurtain(1)];
      function setCurtains(c) { // c: 0 open (gathered at the sides) .. 1 closed
        var s = 0.26 + 0.74 * c;
        curtains.forEach(function (m) { m.scale.x = s; m.position.x = m.userData.side * (STAGE_W / 2 - (STAGE_W / 4) * s); });
      }

      // spotlights with faint light cones
      var spots = [[-7, 15, 6], [7, 15, 6], [0, 17, 3]];
      spots.forEach(function (sp) {
        var light = new THREE.SpotLight(0xfff0d6, 1.5, 60, 0.46, 0.65, 1.2);
        light.position.set(sp[0], sp[1], sp[2]); light.target.position.set(0, 0.5, -0.5);
        op.add(light); op.add(light.target);
        var len = Math.sqrt(sp[0] * sp[0] + (sp[1] - 0.5) * (sp[1] - 0.5) + (sp[2] + 0.5) * (sp[2] + 0.5));
        var geo = new THREE.ConeGeometry(Math.tan(0.46) * len, len, 32, 1, true); geo.rotateX(-Math.PI / 2);
        var cone = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: 0xfff0d6, transparent: true, opacity: 0.028, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
        cone.position.set(sp[0] / 2, (sp[1] + 0.5) / 2, (sp[2] - 0.5) / 2); cone.lookAt(0, 0.5, -0.5); op.add(cone);
      });
      op.add(new THREE.AmbientLight(0x4a5670, 0.85));
      var pool = new THREE.Mesh(new THREE.PlaneGeometry(13, 8), new THREE.MeshBasicMaterial({
        map: canvasTexture(THREE, 128, 128, function (g, w, h) { var r = g.createRadialGradient(w / 2, h / 2, 2, w / 2, h / 2, w / 2); r.addColorStop(0, 'rgba(255,240,214,0.55)'); r.addColorStop(1, 'rgba(255,240,214,0)'); g.fillStyle = r; g.fillRect(0, 0, w, h); }),
        transparent: true, blending: THREE.AdditiveBlending, depthWrite: false
      }));
      pool.rotation.x = -Math.PI / 2; pool.position.set(0, 0.03, -0.5); op.add(pool);

      // ---------------------------------------------------------------- studio and space
      var st = groups.studio;
      var studioFloor = new THREE.Mesh(new THREE.PlaneGeometry(120, 120), new THREE.MeshStandardMaterial({ color: 0x0a1a2a, roughness: 0.35, metalness: 0.4 }));
      studioFloor.rotation.x = -Math.PI / 2; st.add(studioFloor);
      var grid = new THREE.GridHelper(120, 60, 0x2a6fb0, 0x16314d); grid.position.y = 0.02; st.add(grid);
      st.add(new THREE.AmbientLight(0x6a7f99, 1.0)); var key = new THREE.DirectionalLight(0xffffff, 0.9); key.position.set(6, 12, 8); st.add(key);

      // ---------------------------------------------------------------- the company template (light and navy)
      var TEMPLATE_LOOK = {
        template: { bg: 0xf7fafc, floor: 0xe9eef3, grid: [0xc3cfda, 0xdfe6ec], amb: 1.0, key: 0.75, shadow: 'rgba(14,40,65,0.26)' },
        'template-dark': { bg: 0x0e2841, floor: 0x12304f, grid: [0x2e5f8f, 0x1b4166], amb: 0.9, key: 0.9, shadow: 'rgba(0,0,0,0.4)' }
      };
      Object.keys(TEMPLATE_LOOK).forEach(function (name) {
        var look = TEMPLATE_LOOK[name], g = groups[name];
        var fl = new THREE.Mesh(new THREE.PlaneGeometry(160, 160), new THREE.MeshStandardMaterial({ color: look.floor, roughness: 0.95, metalness: 0 }));
        fl.rotation.x = -Math.PI / 2; g.add(fl);
        var gr = new THREE.GridHelper(160, 80, look.grid[0], look.grid[1]); gr.position.y = 0.01; g.add(gr);
        var accent = new THREE.Mesh(new THREE.PlaneGeometry(160, 0.07), new THREE.MeshBasicMaterial({ color: 0x77bd1d })); // the template's green line, on the floor
        accent.rotation.x = -Math.PI / 2; accent.position.set(0, 0.02, -6); g.add(accent);
        g.add(new THREE.AmbientLight(0xffffff, look.amb)); var kl = new THREE.DirectionalLight(0xffffff, look.key); kl.position.set(6, 12, 8); g.add(kl);
        var blob = new THREE.Mesh(new THREE.PlaneGeometry(12, 8), new THREE.MeshBasicMaterial({
          map: canvasTexture(THREE, 128, 128, function (c, cw, ch) { var r = c.createRadialGradient(cw / 2, ch / 2, 2, cw / 2, ch / 2, cw / 2); r.addColorStop(0, look.shadow); r.addColorStop(1, 'rgba(0,0,0,0)'); c.fillStyle = r; c.fillRect(0, 0, cw, ch); }),
          transparent: true, depthWrite: false }));
        blob.rotation.x = -Math.PI / 2; blob.position.set(0, 0.03, -0.5); g.add(blob); // a soft contact shadow under the model
      });

      // ---------------------------------------------------------------- particles (deterministic)
      function particles(n, spread, size, color, seed, parent) {
        var r = lcg(seed), base = new Float32Array(n * 3);
        for (var i = 0; i < n; i++) { base[i * 3] = (r() - 0.5) * spread; base[i * 3 + 1] = r() * spread * 0.45; base[i * 3 + 2] = -r() * spread * 0.55 + 4; }
        var geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
        var pts = new THREE.Points(geo, new THREE.PointsMaterial({ color: color, size: size, transparent: true, opacity: 0.75, depthWrite: false }));
        pts.userData = { base: base, n: n, spread: spread }; parent.add(pts); return pts;
      }
      var dust = particles(150, 26, 0.09, 0xfff0d6, 7, op);
      var motes = particles(90, 30, 0.08, 0x9fd8ff, 13, st);
      var stars = particles(520, 160, 0.35, 0xffffff, 23, groups.space);
      function animateParticles(pts, T, speed) {
        var u = pts.userData, arr = pts.geometry.attributes.position.array, range = u.spread * 0.45;
        for (var i = 0; i < u.n; i++) {
          var y = (u.base[i * 3 + 1] + T * speed * (0.4 + (i % 7) / 9)) % range;
          arr[i * 3] = u.base[i * 3] + Math.sin(T * 0.22 + i) * 0.3; arr[i * 3 + 1] = y; arr[i * 3 + 2] = u.base[i * 3 + 2];
        }
        pts.geometry.attributes.position.needsUpdate = true;
      }

      var envName = '';
      function showEnvironment(name) {
        if (!groups[name]) { name = 'template'; }
        Object.keys(groups).forEach(function (k) { groups[k].visible = (k === name); });
        var bg = TEMPLATE_LOOK[name] ? TEMPLATE_LOOK[name].bg : (name === 'space' ? 0x000004 : (name === 'studio' ? 0x0a1a2a : 0x05070d));
        scene.background = new THREE.Color(bg); scene.fog.color.setHex(bg);
        envName = name;
      }
      showEnvironment('template');

      // ---------------------------------------------------------------- the viewer's own camera (drag / wheel); zero in an export
      // offsets ON TOP of the slide's own shot: radians around the model, radians up, and a zoom exponent (distance x e^-zoom)
      var view = { yaw: 0, pitch: 0, zoom: 0 };
      function resetView() { view.yaw = 0; view.pitch = 0; view.zoom = 0; }
      function clampView() {
        view.yaw = ((view.yaw + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
        view.pitch = clamp(view.pitch, -0.6, 1.2); view.zoom = clamp(view.zoom, -0.7, 1.5);
      }
      var lastIndex = null;

      // ---------------------------------------------------------------- the performer
      function fitOf(model, root) {
        if (model._fit) { return model._fit; }
        var box = new THREE.Box3().setFromObject(root), fit = { k: 1, cx: 0, cz: 0, minY: 0, h: 2, r: 2 };
        if (!box.isEmpty()) {
          var size = new THREE.Vector3(); box.getSize(size);
          var k = clamp(Math.min(MODEL_MAX_H / Math.max(size.y, 1e-3), MODEL_MAX_W / Math.max(size.x, size.z, 1e-3)), 1e-4, 1e4);
          // h = height on the floor, r = radius of the sphere around it (what the camera has to frame), both in stage units
          fit = { k: k, cx: (box.min.x + box.max.x) / 2, cz: (box.min.z + box.max.z) / 2, minY: box.min.y, h: size.y * k, r: Math.max(size.length() * k / 2, 0.5) };
        }
        model._fit = fit; return fit;
      }

      // pose the model on the stage; returns the root to render (or null)
      function pose(content, rotY, scaleMul) {
        if (!content || !content.model) { return null; }
        var model = content.model;
        model.advanceTo(content.tv);
        var root = model.root();
        if (root.background) { root.background = null; }
        var f = fitOf(model, root), k = f.k * scaleMul, c = Math.cos(rotY), sn = Math.sin(rotY);
        root.scale.set(k, k, k); root.rotation.set(0, rotY, 0);
        root.position.set(-k * (f.cx * c + f.cz * sn), -k * f.minY + 0.05, -0.5 - k * (-f.cx * sn + f.cz * c));
        root.updateMatrixWorld(true);
        return root;
      }

      // ---------------------------------------------------------------- the camera
      // The model as the camera sees it: the point in the middle of it and the radius that frames all of it.
      function metricOf(content) {
        if (!content || !content.model) { return { center: new THREE.Vector3(0, 2.8, -0.5), radius: 3.5 }; }
        var f = fitOf(content.model, content.model.root());
        return { center: new THREE.Vector3(0, 0.05 + f.h / 2, -0.5), radius: f.r };
      }

      // One shot -> numbers: where (az, el, d from `target`) and the lens. `root` (the posed model on show, or null) lets a shot focus on
      // a named node; without it (or when the name is not in the model) the shot looks at the whole model.
      function resolveShot(shot, m, root, aspect) {
        shot = shot || {};
        var base = PRESETS[shot.preset] || PRESETS['three-quarter'];
        var fov = clamp(shot.fov || FOV, 20, 80), halfV = fov * DEG / 2, half = Math.min(halfV, Math.atan(Math.tan(halfV) * aspect));
        var target = m.center, rad = m.radius * 0.85, mult = shot.distance != null ? shot.distance : (shot.focus ? 1 : base.dist);
        // focus: frame the named node (a rotating node's box is up to 1.4x too big, so 1.1 x half its diagonal leaves a little air)
        if (shot.focus && root) {
          var node = root.getObjectByName(shot.focus);
          if (node) {
            var box = new THREE.Box3().setFromObject(node);
            if (!box.isEmpty()) { var sz = new THREE.Vector3(); box.getSize(sz); target = box.getCenter(new THREE.Vector3()); rad = Math.max(sz.length() / 2, 0.25) * 1.1; }
          }
        }
        return { az: shot.azimuth != null ? shot.azimuth : base.az, el: shot.elevation != null ? shot.elevation : base.el, d: rad / Math.tan(half) * mult, fov: fov, target: target };
      }

      function angleLerp(a, b, u) { var d = ((b - a + 540) % 360) - 180; return a + d * u; }
      function lerpPose(A, B, u) {
        return { az: angleLerp(A.az, B.az, u), el: A.el + (B.el - A.el) * u, d: A.d + (B.d - A.d) * u, fov: A.fov + (B.fov - A.fov) * u,
                 target: A.target.clone().lerp(B.target, u) };
      }

      // The slide's camera at slide time t: the last shot that has begun, reached from the one before it with an eased move.
      function slidePose(content, t, root, aspect) {
        var m = metricOf(content), shots = (content && content.shots && content.shots.length) ? content.shots : [{ at: 0, shot: { preset: 'three-quarter' } }];
        var i = 0; for (var k = 0; k < shots.length; k++) { if (shots[k].at <= t + 1e-9) { i = k; } }
        var cur = resolveShot(shots[i].shot, m, root, aspect);
        if (i === 0) { return cur; }
        return lerpPose(resolveShot(shots[i - 1].shot, m, root, aspect), cur, ease((t - shots[i].at) / MOVE_S));
      }

      function applyPose(P, T, drift) {
        var az = P.az * DEG + view.yaw + (drift ? Math.sin(T * 0.23) * 0.03 : 0);
        var el = clamp(P.el * DEG + view.pitch + (drift ? Math.sin(T * 0.19) * 0.01 : 0), 0.03, 1.5);
        var d = P.d * Math.exp(-view.zoom);
        if (Math.abs(camera.fov - P.fov) > 1e-3) { camera.fov = P.fov; camera.updateProjectionMatrix(); }
        camera.position.set(P.target.x + Math.sin(az) * Math.cos(el) * d, P.target.y + Math.sin(el) * d, P.target.z + Math.cos(az) * Math.cos(el) * d);
        camera.lookAt(P.target);
      }

      var lastW = 0, lastH = 0, lastPose = null;

      function compose(ctx, stt) {
        var rc = stt.rect || { x: 0, y: 0, w: stt.width, h: stt.height };
        var w = Math.max(2, Math.round(rc.w)), h = Math.max(2, Math.round(rc.h));
        if (w !== lastW || h !== lastH) { renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix(); lastW = w; lastH = h; }
        var aspect = w / h;
        var wanted = stt.environment || 'template';
        if (wanted !== envName) { showEnvironment(wanted); }
        // the viewer's own offset belongs to the slide it was made on
        if (!stt.keepView && stt.index != null && stt.index !== lastIndex) { if (lastIndex !== null) { resetView(); } lastIndex = stt.index; }
        var T = stt.T, inTr = stt.phase === 'transition', p = stt.p, type = stt.type;
        if (envName !== 'opera' && type === 'curtain') { type = 'fly'; }
        animateParticles(dust, T, 0.12); animateParticles(motes, T, 0.2); animateParticles(stars, T, 0.02);

        var content = stt.cur, rot = 0, sc = 1, closed = 0, dim = 0;
        var tIn = content ? content.t || 0 : 0;
        if (inTr && type !== 'none') {
          var first = p < 0.5, half = first ? ease(p * 2) : 1 - ease((p - 0.5) * 2);
          var prevC = stt.prev || stt.cur;
          content = first ? prevC : stt.cur;
          if (type === 'curtain') { closed = half; }
          else if (type === 'spin') { rot = (first ? 1 : -1) * half * Math.PI; sc = Math.max(0.02, 1 - half); }
          else if (type === 'fade') { dim = half; }
          else if (type === 'fly') {
            var same = stt.prev && stt.cur && stt.prev.key && stt.prev.key === stt.cur.key;
            if (same) { content = stt.cur; }
          }
        }
        setCurtains(closed);
        var root = pose(content, rot, sc);
        if (closed > 0.97) { root = null; }

        // the camera
        var P, drift = !(content && content.orbit === false);
        if (inTr && type === 'fly') {
          var same2 = stt.prev && stt.cur && stt.prev.key && stt.prev.key === stt.cur.key;
          if (same2) {
            // one model, two shots: straight from where the old slide ended to where the new one starts, with a little pull-back on the way
            var A = slidePose(stt.prev, stt.prev.t || 0, null, aspect), B = slidePose(stt.cur, 0, root, aspect), u = ease(p);
            P = lerpPose(A, B, u); P.d *= 1 + 0.3 * Math.sin(Math.PI * u);
          } else if (p < 0.5) {
            var A1 = slidePose(content, content.t || 0, root, aspect), W1 = resolveShot({ preset: 'wide' }, metricOf(content), root, aspect);
            P = lerpPose(A1, W1, ease(p * 2));
          } else {
            var W2 = resolveShot({ preset: 'wide' }, metricOf(content), root, aspect), B2 = slidePose(content, 0, root, aspect);
            P = lerpPose(W2, B2, ease(p * 2 - 1));
          }
          if (!same2) { dim = clamp(1 - Math.abs(p - 0.5) / 0.12, 0, 1); } // the swap of models happens in the dark
        } else {
          P = slidePose(content, inTr ? (content === stt.cur ? 0 : (content && content.t) || 0) : tIn, root, aspect);
          // legacy: a model that asks for an auto-orbit swings around its shot
          if (content && typeof content.orbit === 'number' && content.orbit > 0 && !(content.shots && content.shots.length)) { P.az += Math.sin(2 * Math.PI * T / content.orbit) * 28; }
        }
        lastPose = P;
        applyPose(P, T, drift);

        renderer.autoClear = true;
        renderer.render(scene, camera);
        if (root) { renderer.autoClear = false; renderer.render(root, camera); renderer.autoClear = true; }
        ctx.drawImage(glCanvas, 0, 0, w, h, rc.x, rc.y, rc.w, rc.h);
        if (dim > 0) { ctx.fillStyle = (TEMPLATE_LOOK[envName] && envName === 'template' ? 'rgba(247,250,252,' : 'rgba(0,0,0,') + dim.toFixed(3) + ')'; ctx.fillRect(rc.x, rc.y, rc.w, rc.h); }
      }

      function dispose() { try { renderer.dispose(); } catch (e) { /* ignore */ } }

      return { compose: compose, dispose: dispose, presets: Object.keys(PRESETS), view: view, resetView: resetView, clampView: clampView, canvas: glCanvas, _internal: { renderer: renderer, scene: scene, camera: camera, pose: function () { return lastPose; } } };
    });
  }

  window.AiChatDeckStage3D = { create: create };
})(window);
