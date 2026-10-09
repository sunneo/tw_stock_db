// Interactive 3D scene viewer for render_3d_scene tool results. A "scene"
// is a declarative YAML document (see scene_tools.rb) describing primitive
// meshes/lights/camera/a fixed set of built-in animations -- there is
// deliberately NO way to embed arbitrary JavaScript in a scene file. This
// plugin already draws that exact line for custom Function "browser_action"s
// (a fixed, closed action vocabulary instead of eval, see skill_function_tools.rb):
// an AI-authored scene file is just as reachable by a prompt-injection attack
// as AI-authored function metadata is, so the same boundary applies here --
// running injected script in the user's authenticated Redmine session is a
// real risk a purely declarative format has no way to carry.
//
// three.js + OrbitControls + js-yaml are vendored (assets/javascripts/vendor/)
// and lazy-loaded only the first time a scene actually appears on screen,
// matching how pdfmake/pptxgenjs are already lazy-loaded for exports (see
// ai_chat_markdown.js).
(function (window) {
  'use strict';

  var SCENE_URL_RE = /\.3dscene\.yaml(\?.*)?$/i;
  var libsPromise = null;
  var mounted = [];

  function isSceneUrl(url) {
    return typeof url === 'string' && SCENE_URL_RE.test(url);
  }

  function loadScriptOnce(src) {
    return new Promise(function (resolve, reject) {
      if (!src) { reject(new Error('missing script url')); return; }
      var script = document.createElement('script');
      script.src = src;
      script.async = true;
      script.onload = resolve;
      script.onerror = function () { reject(new Error('failed to load ' + src)); };
      document.head.appendChild(script);
    });
  }

  function ensureLibsLoaded() {
    if (libsPromise) { return libsPromise; }
    var urls = window.AiChatExportAssetUrls || {};
    if (!urls.three || !urls.orbitControls || !urls.jsYaml) {
      return Promise.reject(new Error('3D viewer assets are not configured (window.AiChatExportAssetUrls missing three/orbitControls/jsYaml).'));
    }
    libsPromise = loadScriptOnce(urls.three)
      .then(function () { return loadScriptOnce(urls.orbitControls); })
      .then(function () { return loadScriptOnce(urls.jsYaml); });
    return libsPromise;
  }

  // Only needed for 3MF export (a zip container) -- lazy-loaded on first
  // use, same vendor script ai_chat_markdown.js already loads for PPTX
  // export (pptxgen.min.js also expects a global JSZip).
  var jszipPromise = null;
  function ensureJSZipLoaded() {
    if (jszipPromise) { return jszipPromise; }
    var urls = window.AiChatExportAssetUrls || {};
    if (!urls.jszip) { return Promise.reject(new Error('3MF export assets are not configured (window.AiChatExportAssetUrls missing jszip).')); }
    jszipPromise = loadScriptOnce(urls.jszip);
    return jszipPromise;
  }

  // ------------------------------------------------------- scene building

  var MESH_BUILDERS = {
    box: function (n) {
      var s = n.size || [1, 1, 1];
      return new THREE.BoxGeometry(s[0], s[1], s[2]);
    },
    sphere: function (n) { return new THREE.SphereGeometry(n.radius || 0.5, 24, 16); },
    cylinder: function (n) {
      var rt = n.radius_top != null ? n.radius_top : (n.radius != null ? n.radius : 0.5);
      var rb = n.radius_bottom != null ? n.radius_bottom : (n.radius != null ? n.radius : 0.5);
      return new THREE.CylinderGeometry(rt, rb, n.height || 1, 24);
    },
    cone: function (n) { return new THREE.ConeGeometry(n.radius || 0.5, n.height || 1, 24); },
    plane: function (n) { var s = n.size || [1, 1]; return new THREE.PlaneGeometry(s[0], s[1]); },
    torus: function (n) { return new THREE.TorusGeometry(n.radius || 0.5, n.tube || 0.15, 12, 32); },
    // Arbitrary shape from an explicit vertex/triangle-face list -- for
    // anything the fixed primitives above can't express. scene_tools.rb
    // already validated vertices/faces are well-formed and in range, so
    // this just flattens them into a real BufferGeometry the same way
    // three.js's own primitive geometries are represented internally.
    polygon: function (n) {
      var geometry = new THREE.BufferGeometry();
      var positions = new Float32Array(n.vertices.length * 3);
      n.vertices.forEach(function (v, i) {
        positions[i * 3] = v[0]; positions[i * 3 + 1] = v[1]; positions[i * 3 + 2] = v[2];
      });
      geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      var indices = [];
      n.faces.forEach(function (f) { indices.push(f[0], f[1], f[2]); });
      geometry.setIndex(indices);
      geometry.computeVertexNormals();
      return geometry;
    }
  };

  // ---------------------------------------------------- procedural textures
  //
  // Small hand-drawn repeating patterns (a real, working substitute for
  // needing to fetch external texture image files, which this plugin
  // deliberately avoids -- see the vendoring note at the top of this file).
  // Each returns a THREE.CanvasTexture built from a tiny offscreen 2D
  // canvas; "repeat" tiles it across the surface via THREE's own
  // RepeatWrapping rather than drawing a bigger canvas.
  var TEXTURE_PATTERNS = {
    grass: function (ctx, size) {
      ctx.fillStyle = '#4a8c3f';
      ctx.fillRect(0, 0, size, size);
      for (var i = 0; i < 90; i++) {
        ctx.fillStyle = i % 2 === 0 ? '#5aa04a' : '#3d7a34';
        ctx.fillRect(Math.random() * size, Math.random() * size, 2, 2);
      }
    },
    water: function (ctx, size) {
      ctx.fillStyle = '#2266aa';
      ctx.fillRect(0, 0, size, size);
      ctx.strokeStyle = '#4488cc';
      ctx.lineWidth = 2;
      for (var y = 6; y < size; y += 10) {
        ctx.beginPath();
        for (var x = 0; x <= size; x += 4) { ctx.lineTo(x, y + Math.sin(x / 6) * 3); }
        ctx.stroke();
      }
    },
    sand: function (ctx, size) {
      ctx.fillStyle = '#e0c98f';
      ctx.fillRect(0, 0, size, size);
      for (var i = 0; i < 200; i++) {
        ctx.fillStyle = i % 2 === 0 ? '#d4b878' : '#ecd9a6';
        ctx.fillRect(Math.random() * size, Math.random() * size, 1, 1);
      }
    },
    tile: function (ctx, size) {
      ctx.fillStyle = '#cfcfcf';
      ctx.fillRect(0, 0, size, size);
      ctx.strokeStyle = '#999999';
      ctx.lineWidth = 2;
      ctx.strokeRect(1, 1, size - 2, size - 2);
    },
    wood: function (ctx, size) {
      ctx.fillStyle = '#a0703a';
      ctx.fillRect(0, 0, size, size);
      ctx.strokeStyle = '#8a5c2c';
      ctx.lineWidth = 1;
      for (var y = 4; y < size; y += 8) {
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(size, y); ctx.stroke();
      }
    },
    brick: function (ctx, size) {
      ctx.fillStyle = '#8a4a3a';
      ctx.fillRect(0, 0, size, size);
      ctx.strokeStyle = '#5c2f24';
      ctx.lineWidth = 2;
      var rowH = size / 4;
      for (var row = 0; row < 4; row++) {
        var offset = (row % 2) * (size / 2);
        ctx.beginPath(); ctx.moveTo(0, row * rowH); ctx.lineTo(size, row * rowH); ctx.stroke();
        for (var x = -size / 2; x < size * 1.5; x += size / 2) {
          ctx.beginPath(); ctx.moveTo(x + offset, row * rowH); ctx.lineTo(x + offset, (row + 1) * rowH); ctx.stroke();
        }
      }
    },
    stone: function (ctx, size) {
      ctx.fillStyle = '#8a8a8a';
      ctx.fillRect(0, 0, size, size);
      for (var i = 0; i < 40; i++) {
        ctx.fillStyle = i % 2 === 0 ? '#7a7a7a' : '#9c9c9c';
        var w = 6 + Math.random() * 10;
        ctx.fillRect(Math.random() * size, Math.random() * size, w, w * 0.6);
      }
    }
  };

  function buildProceduralTexture(name) {
    var size = 64;
    var canvas = document.createElement('canvas');
    canvas.width = size; canvas.height = size;
    var ctx = canvas.getContext('2d');
    TEXTURE_PATTERNS[name](ctx, size);
    var texture = new THREE.CanvasTexture(canvas);
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    return texture;
  }

  // A real, vendored photographic texture (assets/images/, see
  // window.AiChatExportAssetUrls) -- unlike TEXTURE_PATTERNS above, this
  // isn't a hand-drawn canvas pattern, it's an actual bundled image, but it
  // is still fetched from THIS server's own plugin assets, never an
  // external URL, matching this file's own "no external texture fetches"
  // rule (see file header). Named ("earth", ...) exactly like
  // TEXTURE_PATTERNS so a scene author picks it the same way
  // (material.texture:"earth"); the mapping to which AiChatExportAssetUrls
  // key backs each name lives here, one small closed table, not a generic
  // "any texture name resolves to any asset url" mechanism.
  var BUILTIN_PHOTO_TEXTURE_ASSET_KEYS = { earth: 'earthTexture' };
  var builtinPhotoTextureCache = {};

  // Loaded once and cached module-wide (not per-scene like
  // loadSharedAttachmentTexture's cache) -- this is the SAME one vendored
  // image no matter how many different scenes/renders reference "earth"
  // across the whole page's lifetime, exactly like three.js/mermaid.js
  // themselves are lazy-loaded once and reused. Returns a clone per call
  // (three.js Texture#clone() shares the decoded image, no second fetch)
  // so per-node texture_repeat/uv settings never fight over one shared
  // Texture object's own offset/repeat state.
  function loadBuiltinPhotoTexture(name) {
    var assetKey = BUILTIN_PHOTO_TEXTURE_ASSET_KEYS[name];
    if (!assetKey) { return null; }

    if (!builtinPhotoTextureCache[name]) {
      var url = (window.AiChatExportAssetUrls || {})[assetKey];
      builtinPhotoTextureCache[name] = url
        ? new Promise(function (resolve, reject) {
          new THREE.TextureLoader().load(url, resolve, undefined, function () { reject(new Error('failed to load built-in texture ' + name)); });
        })
        : Promise.reject(new Error('built-in texture "' + name + '" asset url is not configured'));
    }
    return builtinPhotoTextureCache[name].then(function (tex) { return tex.clone(); });
  }

  // "texture" given as a direct http(s)/data: image url instead of a named
  // pattern -- see scene_tools.rb's TEXTURE_URL_RE for why this is allowed
  // at all (parity with the reference implementation, and no new risk
  // beyond an ordinary chat image embed). Caching is per-buildScene-call
  // (the caller passes its own local textureCache, shared with the
  // uploaded-zip case below) rather than module-wide like
  // loadBuiltinPhotoTexture's cache -- a URL is scene-specific, not a
  // fixed vendored asset every scene on the page would reuse.
  function isTextureUrl(texture) {
    return typeof texture === 'string' && /^(?:https?:|data:image\/)/i.test(texture);
  }

  function loadUrlTexture(cache, url) {
    if (!cache[url]) {
      cache[url] = new Promise(function (resolve, reject) {
        new THREE.TextureLoader().load(url, resolve, undefined, function () { reject(new Error('failed to load texture ' + url)); });
      });
    }
    return cache[url].then(function (tex) { return tex.clone(); });
  }

  // A real image the user uploaded as a zip (see ai_chat_textures_controller.rb)
  // instead of a procedural pattern -- takes precedence over "texture" when
  // both are given (checked by the caller). Returns a Promise since loading
  // an actual image is inherently async, unlike the synchronous canvas
  // patterns above.
  function loadAttachmentTexture(attachmentId, entryPath) {
    var urls = window.AiChatTextureAssetUrls || {};
    if (!urls.base) { return Promise.reject(new Error('texture asset base url is not configured')); }

    var url = urls.base.replace('__ATTACHMENT_ID__', attachmentId) + '?entry=' + encodeURIComponent(entryPath);
    return new Promise(function (resolve, reject) {
      new THREE.TextureLoader().load(url, resolve, undefined, function () { reject(new Error('failed to load texture ' + url)); });
    });
  }

  // Loads (or reuses, via cache) one shared attachment image, then returns
  // an independent CLONE for this specific node -- e.g. several components
  // photographed on the same circuit board all reference the very same
  // uploaded photo (one real material source), but each one typically
  // needs its own crop of that photo (texture_uv_offset/texture_uv_scale
  // below) without disturbing any other node's crop of the same image.
  // three.js's own Texture#clone() shares the underlying decoded image
  // (no second network fetch) while keeping offset/repeat/wrap independent
  // per clone -- exactly this use case is what it exists for.
  function loadSharedAttachmentTexture(cache, attachmentId, entryPath) {
    var key = attachmentId + '::' + entryPath;
    if (!cache[key]) { cache[key] = loadAttachmentTexture(attachmentId, entryPath); }
    return cache[key].then(function (tex) { return tex.clone(); });
  }

  // Applies an optional crop of a texture atlas -- e.g. one photo of a
  // circuit board shared across several component meshes, each showing a
  // different rectangular region of it. Switches to ClampToEdgeWrapping
  // whenever a crop is actually requested, since tiling/wrapping at a crop
  // boundary would bleed into whatever is next to it in the source image;
  // plain repeat (the floor/wall tiling use case) is untouched otherwise.
  // defaultRepeat lets a caller whose texture is a single wrap-once photo
  // (a built-in "earth"-style texture, see loadBuiltinPhotoTexture) avoid
  // the [4,4] tiling default meant for repeating floor/wall patterns --
  // tiling an equirectangular planet photo 4x4 would show four garbled
  // little earths instead of one, so that caller passes [1,1] instead.
  // An explicit mat.texture_repeat always wins regardless, same as before.
  function applyTextureRegion(texture, mat, defaultRepeat) {
    var repeat = mat.texture_repeat || defaultRepeat || [4, 4];
    var hasRegion = !!(mat.texture_uv_offset || mat.texture_uv_scale);
    if (hasRegion) {
      var offset = mat.texture_uv_offset || [0, 0];
      var scale = mat.texture_uv_scale || [1, 1];
      texture.wrapS = THREE.ClampToEdgeWrapping;
      texture.wrapT = THREE.ClampToEdgeWrapping;
      texture.offset.set(offset[0], offset[1]);
      texture.repeat.set(scale[0], scale[1]);
    } else {
      texture.wrapS = THREE.RepeatWrapping;
      texture.wrapT = THREE.RepeatWrapping;
      texture.repeat.set(repeat[0], repeat[1]);
    }
    texture.needsUpdate = true;
    return texture;
  }

  // Fixed, closed animation vocabulary (see file header) -- each returns a
  // function(dt) that mutates the mesh in place, called once per frame.
  var ANIMATION_BUILDERS = {
    spin: function (mesh, anim) {
      var axis = new THREE.Vector3().fromArray(anim.axis || [0, 1, 0]).normalize();
      var speed = anim.speed != null ? anim.speed : 0.5;
      return function (dt) { mesh.rotateOnAxis(axis, speed * dt); };
    },
    bounce: function (mesh, anim) {
      var axis = anim.axis || [0, 1, 0];
      var amplitude = anim.amplitude != null ? anim.amplitude : 0.3;
      var speed = anim.speed != null ? anim.speed : 1.0;
      var base = mesh.position.clone();
      var t0 = 0;
      return function (dt) {
        t0 += dt;
        var offset = Math.sin(t0 * speed) * amplitude;
        mesh.position.set(base.x + axis[0] * offset, base.y + axis[1] * offset, base.z + axis[2] * offset);
      };
    },
    // "parent" (optional, a string naming another node's id/name) switches
    // the orbit center from a fixed world coordinate to that node's CURRENT
    // position, re-read every frame via meshesByName -- this is what lets a
    // satellite orbit a moving body (the moon orbiting an orbiting earth,
    // which can itself orbit the sun, chaining arbitrarily deep) instead of
    // just a fixed point in space. meshesByName is only populated once ALL
    // of a scene's nodes have been built (see buildScene's two-pass split
    // below) specifically so a "parent" can appear anywhere in the nodes
    // array, including after its orbiting child. Fully backward compatible:
    // with no "parent" (the overwhelming majority of existing scenes),
    // parentMesh is always null and behavior is byte-for-byte identical to
    // before this was added -- always the fixed "center". Mirrors the
    // reference implementation's own _build3DAnimatorForNode orbit case
    // (ref-ai/floating-assistant.js) field-for-field.
    orbit: function (mesh, anim, meshesByName) {
      var parentId = typeof anim.parent === 'string' ? anim.parent : null;
      var parentMesh = (parentId && meshesByName) ? meshesByName[parentId] : null;
      var staticCenter = anim.center || [0, mesh.position.y, 0];
      var initialCx = parentMesh ? parentMesh.position.x : staticCenter[0];
      var initialCz = parentMesh ? parentMesh.position.z : staticCenter[2];
      var dx0 = mesh.position.x - initialCx;
      var dz0 = mesh.position.z - initialCz;
      var radius = anim.radius != null ? anim.radius : (Math.sqrt(dx0 * dx0 + dz0 * dz0) || 1);
      var speed = anim.speed != null ? anim.speed : 0.5;
      var angle0 = Math.atan2(dz0, dx0);
      var t0 = 0;
      return function (dt) {
        t0 += dt;
        var angle = angle0 + t0 * speed;
        var cx = parentMesh ? parentMesh.position.x : staticCenter[0];
        var cz = parentMesh ? parentMesh.position.z : staticCenter[2];
        mesh.position.set(cx + Math.cos(angle) * radius, mesh.position.y, cz + Math.sin(angle) * radius);
      };
    }
  };

  // Accepts either this format's own long-standing nested-object shape
  // (animation: {type, radius, speed, center, ...}) or the reference
  // implementation's flat shape (animation: "orbit" as a bare string, plus
  // separate sibling fields animation_speed/animation_radius/
  // animation_center/animation_parent/animation_amplitude/animation_axis on
  // the node itself) -- see ai_chat_3d_viewer.js's file header on why the
  // two diverged and this reconciles them so a scene authored against
  // either schema renders correctly here. Returns null if there's no
  // animation at all.
  function normalizeAnimation(n) {
    var raw = n.animation;
    if (!raw) { return null; }
    if (typeof raw === 'string') {
      return {
        type: raw,
        axis: n.animation_axis,
        speed: n.animation_speed,
        amplitude: n.animation_amplitude,
        radius: n.animation_radius,
        center: n.animation_center,
        parent: n.animation_parent
      };
    }
    return (typeof raw === 'object') ? raw : null;
  }

  // ------------------------------------------------------- particle effects
  //
  // A fixed, closed set of preset per-particle behaviors (see file header
  // for why there is no way to script custom physics here) -- each preset
  // is a real, working simulation (gravity, cooling colors, mutual
  // gravitational attraction for "nbody", etc.), not a fake/decorative
  // stand-in. All six share one THREE.Points object per node; the position/
  // color BufferAttributes are mutated in place every frame and the update
  // function is pushed into the same `animators` array every other
  // animation already uses, so it runs identically whether the frame is
  // actually drawn by WebGL or by the software rasterizer fallback (see
  // rasterFrame's own particle-drawing branch below).
  function lerpColorInto(colors, i, c1, c2, f) {
    var t = Math.max(0, Math.min(1, f));
    colors[i * 3] = c1.r + (c2.r - c1.r) * t;
    colors[i * 3 + 1] = c1.g + (c2.g - c1.g) * t;
    colors[i * 3 + 2] = c1.b + (c2.b - c1.b) * t;
  }

  function setColorInto(colors, i, c) {
    colors[i * 3] = c.r; colors[i * 3 + 1] = c.g; colors[i * 3 + 2] = c.b;
  }

  var PARTICLE_BUILDERS = {
    // Sprays outward/up from origin under gravity, cooling from color1
    // (e.g. white-hot) to color2 (e.g. dark red) as each particle ages,
    // respawning at origin once it expires -- a grinder/chainsaw shower.
    spark: {
      respawn: function (i, s, origin) {
        s.positions[i * 3] = origin[0]; s.positions[i * 3 + 1] = origin[1]; s.positions[i * 3 + 2] = origin[2];
        var angle = Math.random() * Math.PI * 2;
        var out = 0.3 + Math.random() * 0.7;
        s.velocities[i * 3] = Math.cos(angle) * out;
        s.velocities[i * 3 + 1] = 1.5 + Math.random() * 1.5;
        s.velocities[i * 3 + 2] = Math.sin(angle) * out;
        s.ages[i] = 0;
        s.maxAges[i] = 0.4 + Math.random() * 0.5;
      },
      init: function (count, origin) {
        var s = { positions: new Float32Array(count * 3), colors: new Float32Array(count * 3), velocities: new Float32Array(count * 3), ages: new Float32Array(count), maxAges: new Float32Array(count) };
        for (var i = 0; i < count; i++) { PARTICLE_BUILDERS.spark.respawn(i, s, origin); s.ages[i] = Math.random() * s.maxAges[i]; }
        return s;
      },
      step: function (s, dt, speed, origin, spread, c1, c2) {
        var gravity = -3.0;
        for (var i = 0; i < s.ages.length; i++) {
          s.ages[i] += dt * speed;
          if (s.ages[i] > s.maxAges[i]) { PARTICLE_BUILDERS.spark.respawn(i, s, origin); }
          s.velocities[i * 3 + 1] += gravity * dt * speed;
          s.positions[i * 3] += s.velocities[i * 3] * dt * speed * spread;
          s.positions[i * 3 + 1] += s.velocities[i * 3 + 1] * dt * speed * spread;
          s.positions[i * 3 + 2] += s.velocities[i * 3 + 2] * dt * speed * spread;
          lerpColorInto(s.colors, i, c1, c2, s.ages[i] / s.maxAges[i]);
        }
      }
    },
    // Rises with turbulence, color1 at the base fading to color2 at the tip.
    flame: {
      respawn: function (i, s, origin) {
        var r = Math.random() * 0.3;
        var a = Math.random() * Math.PI * 2;
        s.positions[i * 3] = origin[0] + Math.cos(a) * r;
        s.positions[i * 3 + 1] = origin[1];
        s.positions[i * 3 + 2] = origin[2] + Math.sin(a) * r;
        s.velocities[i * 3] = (Math.random() - 0.5) * 0.4;
        s.velocities[i * 3 + 1] = 0.8 + Math.random() * 0.6;
        s.velocities[i * 3 + 2] = (Math.random() - 0.5) * 0.4;
        s.ages[i] = 0;
        s.maxAges[i] = 0.6 + Math.random() * 0.5;
      },
      init: function (count, origin) {
        var s = { positions: new Float32Array(count * 3), colors: new Float32Array(count * 3), velocities: new Float32Array(count * 3), ages: new Float32Array(count), maxAges: new Float32Array(count) };
        for (var i = 0; i < count; i++) { PARTICLE_BUILDERS.flame.respawn(i, s, origin); s.ages[i] = Math.random() * s.maxAges[i]; }
        return s;
      },
      step: function (s, dt, speed, origin, spread, c1, c2) {
        for (var i = 0; i < s.ages.length; i++) {
          s.ages[i] += dt * speed;
          if (s.ages[i] > s.maxAges[i]) { PARTICLE_BUILDERS.flame.respawn(i, s, origin); }
          s.velocities[i * 3] += (Math.random() - 0.5) * 0.5 * dt;
          s.velocities[i * 3 + 2] += (Math.random() - 0.5) * 0.5 * dt;
          s.positions[i * 3] += s.velocities[i * 3] * dt * speed * spread;
          s.positions[i * 3 + 1] += s.velocities[i * 3 + 1] * dt * speed;
          s.positions[i * 3 + 2] += s.velocities[i * 3 + 2] * dt * speed * spread;
          lerpColorInto(s.colors, i, c1, c2, s.ages[i] / s.maxAges[i]);
        }
      }
    },
    // Slow, wide, gentle drift -- covers both a smoke plume and a cold-air/
    // AC-vent mist look (same mechanic, just pick paler colors for mist).
    mist: {
      respawn: function (i, s, origin) {
        var r = Math.random() * 0.4;
        var a = Math.random() * Math.PI * 2;
        s.positions[i * 3] = origin[0] + Math.cos(a) * r;
        s.positions[i * 3 + 1] = origin[1];
        s.positions[i * 3 + 2] = origin[2] + Math.sin(a) * r;
        s.velocities[i * 3] = (Math.random() - 0.5) * 0.3;
        s.velocities[i * 3 + 1] = 0.2 + Math.random() * 0.2;
        s.velocities[i * 3 + 2] = (Math.random() - 0.5) * 0.3;
        s.ages[i] = 0;
        s.maxAges[i] = 2.5 + Math.random() * 2;
        s.phase[i] = Math.random() * Math.PI * 2;
      },
      init: function (count, origin) {
        var s = { positions: new Float32Array(count * 3), colors: new Float32Array(count * 3), velocities: new Float32Array(count * 3), ages: new Float32Array(count), maxAges: new Float32Array(count), phase: new Float32Array(count) };
        for (var i = 0; i < count; i++) { PARTICLE_BUILDERS.mist.respawn(i, s, origin); s.ages[i] = Math.random() * s.maxAges[i]; }
        return s;
      },
      step: function (s, dt, speed, origin, spread, c1, c2) {
        for (var i = 0; i < s.ages.length; i++) {
          s.ages[i] += dt * speed;
          if (s.ages[i] > s.maxAges[i]) { PARTICLE_BUILDERS.mist.respawn(i, s, origin); }
          var sway = Math.sin(s.ages[i] * 1.5 + s.phase[i]) * 0.15;
          s.positions[i * 3] += (s.velocities[i * 3] + sway) * dt * speed * spread;
          s.positions[i * 3 + 1] += s.velocities[i * 3 + 1] * dt * speed;
          s.positions[i * 3 + 2] += (s.velocities[i * 3 + 2] + sway) * dt * speed * spread;
          lerpColorInto(s.colors, i, c1, c2, s.ages[i] / s.maxAges[i]);
        }
      }
    },
    // Perpetual bouncing via a closed-form parabola-ish curve -- never
    // settles, deterministic, loops forever with no state to drift/decay.
    bounce: {
      init: function (count, origin, spread) {
        var s = { positions: new Float32Array(count * 3), colors: new Float32Array(count * 3), baseX: new Float32Array(count), baseZ: new Float32Array(count), amp: new Float32Array(count), freq: new Float32Array(count), phase: new Float32Array(count), t: 0 };
        for (var i = 0; i < count; i++) {
          s.baseX[i] = origin[0] + (Math.random() - 0.5) * 2 * spread;
          s.baseZ[i] = origin[2] + (Math.random() - 0.5) * 2 * spread;
          s.amp[i] = 0.4 + Math.random() * 0.8;
          s.freq[i] = 1.5 + Math.random() * 1.5;
          s.phase[i] = Math.random() * Math.PI * 2;
        }
        return s;
      },
      step: function (s, dt, speed, origin, spread, c1) {
        s.t += dt * speed;
        for (var i = 0; i < s.amp.length; i++) {
          s.positions[i * 3] = s.baseX[i];
          s.positions[i * 3 + 1] = origin[1] + s.amp[i] * Math.abs(Math.sin(s.t * s.freq[i] + s.phase[i]));
          s.positions[i * 3 + 2] = s.baseZ[i];
          setColorInto(s.colors, i, c1); // bounce has no aging/gradient, just a flat color
        }
      }
    },
    // Repeating bursts radiating outward from origin under gravity, fading
    // out, restarting on a fixed cycle -- several staggered groups for a
    // larger count so more than one burst is visible at once.
    firework: {
      init: function (count, origin, spread) {
        var s = { dirs: new Float32Array(count * 3), groupPhase: new Float32Array(count), positions: new Float32Array(count * 3), colors: new Float32Array(count * 3), t: 0, cycle: 2.5 };
        var groupSize = 15;
        var groups = Math.max(1, Math.ceil(count / groupSize));
        for (var i = 0; i < count; i++) {
          var theta = Math.random() * Math.PI * 2;
          var phi = Math.acos(2 * Math.random() - 1);
          s.dirs[i * 3] = Math.sin(phi) * Math.cos(theta);
          s.dirs[i * 3 + 1] = Math.abs(Math.cos(phi));
          s.dirs[i * 3 + 2] = Math.sin(phi) * Math.sin(theta);
          s.groupPhase[i] = (Math.floor(i / groupSize) % groups) * (s.cycle / groups);
        }
        s.spread = spread;
        return s;
      },
      step: function (s, dt, speed, origin, spread, c1, c2) {
        s.t += dt * speed;
        for (var i = 0; i < s.groupPhase.length; i++) {
          var localT = (s.t + s.groupPhase[i]) % s.cycle;
          var phase = localT / s.cycle; // 0..1 across one burst-and-fade cycle
          var dist = phase * 4 * s.spread;
          s.positions[i * 3] = origin[0] + s.dirs[i * 3] * dist;
          s.positions[i * 3 + 1] = origin[1] + s.dirs[i * 3 + 1] * dist - 2 * phase * phase * s.spread;
          s.positions[i * 3 + 2] = origin[2] + s.dirs[i * 3 + 2] * dist;
          lerpColorInto(s.colors, i, c1, c2, phase);
        }
      }
    },
    // A real (small-N, softened) mutual-gravity simulation -- particles
    // actually attract each other and drift/orbit/clump; O(n^2) per frame,
    // fine at the low particle counts this preset is capped to.
    nbody: {
      init: function (count, origin, spread) {
        var s = { positions: new Float32Array(count * 3), colors: new Float32Array(count * 3), velocities: new Float32Array(count * 3), masses: new Float32Array(count) };
        for (var i = 0; i < count; i++) {
          var r = spread * (0.3 + Math.random() * 0.7);
          var theta = Math.random() * Math.PI * 2;
          var phi = Math.acos(2 * Math.random() - 1);
          var x = r * Math.sin(phi) * Math.cos(theta);
          var y = r * Math.sin(phi) * Math.sin(theta);
          var z = r * Math.cos(phi);
          s.positions[i * 3] = origin[0] + x; s.positions[i * 3 + 1] = origin[1] + y; s.positions[i * 3 + 2] = origin[2] + z;
          s.velocities[i * 3] = -z * 0.3; s.velocities[i * 3 + 1] = 0; s.velocities[i * 3 + 2] = x * 0.3;
          s.masses[i] = 0.5 + Math.random();
        }
        return s;
      },
      step: function (s, dt, speed, origin, spread, c1, c2) {
        var n = s.masses.length;
        var g = 0.4, softening = 0.2;
        var ax = new Float32Array(n), ay = new Float32Array(n), az = new Float32Array(n);
        for (var i = 0; i < n; i++) {
          for (var j = i + 1; j < n; j++) {
            var dx = s.positions[j * 3] - s.positions[i * 3];
            var dy = s.positions[j * 3 + 1] - s.positions[i * 3 + 1];
            var dz = s.positions[j * 3 + 2] - s.positions[i * 3 + 2];
            var distSq = dx * dx + dy * dy + dz * dz + softening * softening;
            var f = g / (distSq * Math.sqrt(distSq));
            var fi = f * s.masses[j], fj = f * s.masses[i];
            ax[i] += dx * fi; ay[i] += dy * fi; az[i] += dz * fi;
            ax[j] -= dx * fj; ay[j] -= dy * fj; az[j] -= dz * fj;
          }
        }
        for (var k = 0; k < n; k++) {
          s.velocities[k * 3] += ax[k] * dt * speed;
          s.velocities[k * 3 + 1] += ay[k] * dt * speed;
          s.velocities[k * 3 + 2] += az[k] * dt * speed;
          s.positions[k * 3] += s.velocities[k * 3] * dt * speed;
          s.positions[k * 3 + 1] += s.velocities[k * 3 + 1] * dt * speed;
          s.positions[k * 3 + 2] += s.velocities[k * 3 + 2] * dt * speed;
          var vmag = Math.sqrt(s.velocities[k * 3] * s.velocities[k * 3] + s.velocities[k * 3 + 1] * s.velocities[k * 3 + 1] + s.velocities[k * 3 + 2] * s.velocities[k * 3 + 2]);
          lerpColorInto(s.colors, k, c1, c2, Math.min(1, vmag / 2));
        }
      }
    },
    // Composes a new preset from PARTICLE_BEHAVIOR_TYPES (see
    // scene_tools.rb's matching server-side validation) instead of one of
    // the fixed named presets above -- still a fixed, non-executable
    // vocabulary of motion primitives, just recombined per scene. Reads
    // `behaviors` (the raw particle_behavior array, passed as this
    // builder's extra 4th/8th argument -- every other preset ignores it).
    custom: {
      findBehavior: function (behaviors, type) {
        for (var i = 0; i < behaviors.length; i++) { if (behaviors[i].type === type) { return behaviors[i]; } }
        return null;
      },
      // Random unit vector within "angleRad" of "dir" -- shared by "emit"
      // and "launch_burst"'s post-burst scatter.
      randomConeDirection: function (dir, angleRad) {
        var base = new THREE.Vector3(dir[0], dir[1], dir[2]).normalize();
        var z = Math.cos(angleRad) + (1 - Math.cos(angleRad)) * Math.random();
        var phi = Math.random() * Math.PI * 2;
        var sinTheta = Math.sqrt(Math.max(0, 1 - z * z));
        var up = Math.abs(base.y) < 0.99 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
        var tangent = new THREE.Vector3().crossVectors(up, base).normalize();
        var bitangent = new THREE.Vector3().crossVectors(base, tangent);
        var result = new THREE.Vector3()
          .addScaledVector(tangent, sinTheta * Math.cos(phi))
          .addScaledVector(bitangent, sinTheta * Math.sin(phi))
          .addScaledVector(base, z);
        return [result.x, result.y, result.z];
      },
      init: function (count, origin, spread, behaviors) {
        behaviors = behaviors || [];
        var s = {
          positions: new Float32Array(count * 3), colors: new Float32Array(count * 3),
          velocities: new Float32Array(count * 3), ages: new Float32Array(count), maxAges: new Float32Array(count),
          phase: new Float32Array(count) // 0 = normal/rising, 1 = burst (only meaningful with launch_burst)
        };
        var self = PARTICLE_BUILDERS.custom;
        var launchBurst = self.findBehavior(behaviors, 'launch_burst');
        var emit = self.findBehavior(behaviors, 'emit');
        var respawn = self.findBehavior(behaviors, 'respawn');

        for (var i = 0; i < count; i++) {
          s.positions[i * 3] = origin[0]; s.positions[i * 3 + 1] = origin[1]; s.positions[i * 3 + 2] = origin[2];
          if (launchBurst) {
            s.phase[i] = 0;
            s.ages[i] = Math.random() * (launchBurst.rise_time != null ? launchBurst.rise_time : 2.0);
          } else {
            if (emit) {
              var dir = emit.direction || [0, 1, 0];
              var angle = (emit.spread_angle != null ? emit.spread_angle : 20) * Math.PI / 180;
              var speedRange = emit.speed || [0.5, 1.5];
              var v = self.randomConeDirection(dir, angle);
              var sp = speedRange[0] + Math.random() * (speedRange[1] - speedRange[0]);
              s.velocities[i * 3] = v[0] * sp; s.velocities[i * 3 + 1] = v[1] * sp; s.velocities[i * 3 + 2] = v[2] * sp;
            }
            var maxAgeRange = respawn ? (respawn.max_age || [0.5, 1.0]) : null;
            s.maxAges[i] = maxAgeRange ? (maxAgeRange[0] + Math.random() * (maxAgeRange[1] - maxAgeRange[0])) : Infinity;
            s.ages[i] = isFinite(s.maxAges[i]) ? Math.random() * s.maxAges[i] : 0;
          }
        }
        return s;
      },
      step: function (s, dt, speed, origin, spread, c1, c2, behaviors) {
        behaviors = behaviors || [];
        var self = PARTICLE_BUILDERS.custom;
        var gravity = self.findBehavior(behaviors, 'gravity');
        var drift = self.findBehavior(behaviors, 'drift');
        var colorFade = self.findBehavior(behaviors, 'color_fade');
        var emit = self.findBehavior(behaviors, 'emit');
        var respawn = self.findBehavior(behaviors, 'respawn');
        var launchBurst = self.findBehavior(behaviors, 'launch_burst');

        var gDir = gravity ? (gravity.direction || [0, -1, 0]) : null;
        var gStrength = gravity && gravity.strength != null ? gravity.strength : (gravity ? 1 : 0);
        var turbulence = drift && drift.turbulence != null ? drift.turbulence : (drift ? 0.3 : 0);
        var fadeFrom = colorFade ? new THREE.Color(colorFade.from || '#ffffff') : c1;
        var fadeTo = colorFade ? new THREE.Color(colorFade.to || '#000000') : c2;

        for (var i = 0; i < s.ages.length; i++) {
          s.ages[i] += dt * speed;

          if (launchBurst) {
            var riseTime = launchBurst.rise_time != null ? launchBurst.rise_time : 2.0;
            var riseHeight = launchBurst.rise_height != null ? launchBurst.rise_height : 6;
            var burstSpeedRange = launchBurst.burst_speed || [2, 4];
            var burstMaxAge = respawn && respawn.max_age ? (respawn.max_age[0] + Math.random() * (respawn.max_age[1] - respawn.max_age[0])) : 1.5;

            if (s.phase[i] === 0) {
              // Rising -- every particle shares the identical climbing
              // position (no per-particle spread) so the group reads as
              // one bright point/shell, not a spray, until it bursts.
              var climb = Math.min(1, s.ages[i] / riseTime) * riseHeight;
              s.positions[i * 3] = origin[0];
              s.positions[i * 3 + 1] = origin[1] + climb;
              s.positions[i * 3 + 2] = origin[2];
              if (s.ages[i] >= riseTime) {
                s.phase[i] = 1;
                s.ages[i] = 0;
                s.maxAges[i] = burstMaxAge;
                var dir = self.randomConeDirection([0, 1, 0], Math.PI); // full sphere scatter
                var sp = burstSpeedRange[0] + Math.random() * (burstSpeedRange[1] - burstSpeedRange[0]);
                s.velocities[i * 3] = dir[0] * sp; s.velocities[i * 3 + 1] = dir[1] * sp; s.velocities[i * 3 + 2] = dir[2] * sp;
              } else {
                setColorInto(s.colors, i, fadeFrom);
                continue;
              }
            }

            // Bursting -- normal velocity integration + gravity below,
            // then loop back to another rise once this burst ages out.
            if (s.ages[i] > s.maxAges[i]) {
              s.phase[i] = 0;
              s.ages[i] = 0;
              s.positions[i * 3] = origin[0]; s.positions[i * 3 + 1] = origin[1]; s.positions[i * 3 + 2] = origin[2];
              s.velocities[i * 3] = 0; s.velocities[i * 3 + 1] = 0; s.velocities[i * 3 + 2] = 0;
              continue;
            }
          } else if (respawn && s.ages[i] > s.maxAges[i]) {
            s.positions[i * 3] = origin[0]; s.positions[i * 3 + 1] = origin[1]; s.positions[i * 3 + 2] = origin[2];
            s.ages[i] = 0;
            if (emit) {
              var edir = emit.direction || [0, 1, 0];
              var eangle = (emit.spread_angle != null ? emit.spread_angle : 20) * Math.PI / 180;
              var espeedRange = emit.speed || [0.5, 1.5];
              var ev = self.randomConeDirection(edir, eangle);
              var esp = espeedRange[0] + Math.random() * (espeedRange[1] - espeedRange[0]);
              s.velocities[i * 3] = ev[0] * esp; s.velocities[i * 3 + 1] = ev[1] * esp; s.velocities[i * 3 + 2] = ev[2] * esp;
            }
          }

          if (gravity) {
            s.velocities[i * 3] += gDir[0] * gStrength * dt * speed;
            s.velocities[i * 3 + 1] += gDir[1] * gStrength * dt * speed;
            s.velocities[i * 3 + 2] += gDir[2] * gStrength * dt * speed;
          }
          if (drift) {
            s.velocities[i * 3] += (Math.random() - 0.5) * turbulence * dt;
            s.velocities[i * 3 + 2] += (Math.random() - 0.5) * turbulence * dt;
          }
          s.positions[i * 3] += s.velocities[i * 3] * dt * speed * spread;
          s.positions[i * 3 + 1] += s.velocities[i * 3 + 1] * dt * speed * spread;
          s.positions[i * 3 + 2] += s.velocities[i * 3 + 2] * dt * speed * spread;

          var frac = isFinite(s.maxAges[i]) && s.maxAges[i] > 0 ? Math.min(1, s.ages[i] / s.maxAges[i]) : 0;
          lerpColorInto(s.colors, i, fadeFrom, fadeTo, frac);
        }
      }
    }
  };

  var MAX_PARTICLE_COUNT = 2000;
  var MAX_NBODY_PARTICLES = 60; // O(n^2) per frame -- kept low for real-time performance, not a hard schema limit

  function buildParticleSystem(n) {
    var preset = PARTICLE_BUILDERS[n.particle_preset] ? n.particle_preset : 'spark';
    var requested = n.particle_count || 100;
    var count = Math.max(1, Math.min(requested, preset === 'nbody' ? MAX_NBODY_PARTICLES : MAX_PARTICLE_COUNT));
    var origin = n.position || [0, 0, 0];
    var spread = n.particle_spread != null ? n.particle_spread : 1;
    var speed = n.particle_speed != null ? n.particle_speed : 1;
    var size = n.particle_size != null ? n.particle_size : 0.1;
    var mat = n.material || {};
    var color1 = new THREE.Color(mat.color || '#ffffff');
    var color2 = new THREE.Color(mat.color2 || mat.color || '#ffffff');

    var behaviors = Array.isArray(n.particle_behavior) ? n.particle_behavior : [];
    var builder = PARTICLE_BUILDERS[preset];
    var state = builder.init(count, origin, spread, behaviors);

    var geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(state.positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(state.colors, 3));
    var material = new THREE.PointsMaterial({
      size: size, vertexColors: true, transparent: true,
      opacity: mat.opacity != null ? mat.opacity : 0.9, depthWrite: false
    });
    var points = new THREE.Points(geometry, material);
    points.name = n.name || ('particles:' + preset);

    var update = function (dt) {
      builder.step(state, dt, speed, origin, spread, color1, color2, behaviors);
      geometry.attributes.position.needsUpdate = true;
      geometry.attributes.color.needsUpdate = true;
    };

    return { points: points, update: update, state: state, color: color1, size: size };
  }

  // A "line" node draws a trajectory/orbit polyline -- either an explicit
  // "points" list or a "circle" shape shorthand (scene_tools.rb already
  // validated exactly one of these is present). Unlike every other
  // primitive this returns a THREE.Line/THREE.LineLoop directly (not a
  // Geometry for the generic Mesh+material path below), since a line has
  // no faces to shade -- same reason "particles" is handled as its own
  // special case rather than living in MESH_BUILDERS.
  function buildLineObject(n) {
    var points;
    var closed = n.closed === true;
    if (n.shape === 'circle') {
      var center = n.center || [0, 0, 0];
      var radius = n.radius;
      var segments = n.segments != null ? Math.max(8, Math.min(256, Math.round(n.segments))) : 64;
      var plane = n.plane || 'xz';
      points = [];
      for (var i = 0; i < segments; i++) {
        var angle = (i / segments) * Math.PI * 2;
        var cx = Math.cos(angle) * radius, sx = Math.sin(angle) * radius;
        if (plane === 'xy') { points.push(new THREE.Vector3(center[0] + cx, center[1] + sx, center[2])); }
        else if (plane === 'yz') { points.push(new THREE.Vector3(center[0], center[1] + cx, center[2] + sx)); }
        else { points.push(new THREE.Vector3(center[0] + cx, center[1], center[2] + sx)); }
      }
      closed = true;
    } else {
      points = n.points.map(function (p) { return new THREE.Vector3(p[0], p[1], p[2]); });
    }
    var geometry = new THREE.BufferGeometry().setFromPoints(points);
    var color = (n.material && n.material.color) || '#ffffff';
    var material = new THREE.LineBasicMaterial({ color: new THREE.Color(color) });
    var line = closed ? new THREE.LineLoop(geometry, material) : new THREE.Line(geometry, material);
    var pos = n.position || [0, 0, 0];
    line.position.set(pos[0], pos[1], pos[2]);
    if (n.rotation) { line.rotation.set(n.rotation[0], n.rotation[1], n.rotation[2]); }
    line.name = n.name || 'line';
    return line;
  }

  // "kind: ai_chat_scene" is no longer required (see
  // scene_tools.rb#validate_scene!'s own comment on why -- the reference
  // implementation this format was ported from, ref-ai/floating-
  // assistant.js, never has a "kind" field at all) -- a real "nodes" array
  // is the actual, load-bearing signal that this is a scene at all.
  function parseScene(yamlText) {
    var data = window.jsyaml.load(yamlText);
    if (!data || typeof data !== 'object') { throw new Error('scene file did not decode to an object'); }
    if (!Array.isArray(data.nodes) || !data.nodes.length) { throw new Error('scene has no "nodes"'); }
    return data;
  }

  // Resolves every top-level "use" node into real copies of its "defs"
  // entry's nodes, offset by the "use" node's own "position" and uniformly
  // scaled by its "scale" (size/radius/height/position all scale together)
  // -- the declarative, non-executable echo of "node-graph reuse": no
  // scripting, just named groups instantiated at different places. A def's
  // own nodes are never mutated (each instantiation deep-clones them), so
  // the same "tree" definition can be reused any number of times safely.
  // An unrecognized "use" name is skipped (not thrown) to match this
  // file's existing "unknown primitive -> skip one node, not the whole
  // scene" leniency -- scene_tools.rb already rejects this server-side
  // before a scene can ever be saved, so this is defense-in-depth for a
  // hand-edited/stale yaml, not the primary validation path.
  function expandNodes(data) {
    var defs = data.defs || {};
    var expanded = [];
    (data.nodes || []).forEach(function (n) {
      if (!n || !n.use) { expanded.push(n); return; }

      var def = defs[n.use];
      if (!def || !Array.isArray(def.nodes)) { return; }

      var offset = n.position || [0, 0, 0];
      var scale = n.scale != null ? n.scale : 1;
      def.nodes.forEach(function (childRaw) {
        var child = JSON.parse(JSON.stringify(childRaw));
        var p = child.position || [0, 0, 0];
        child.position = [offset[0] + p[0] * scale, offset[1] + p[1] * scale, offset[2] + p[2] * scale];
        if (scale !== 1) {
          if (child.size) { child.size = child.size.map(function (v) { return v * scale; }); }
          if (child.radius != null) { child.radius *= scale; }
          if (child.height != null) { child.height *= scale; }
        }
        expanded.push(child);
      });
    });
    return expanded;
  }

  function buildScene(data) {
    var scene = new THREE.Scene();
    scene.background = new THREE.Color(data.background || '#1a1a1a');

    var lights = (data.lights && data.lights.length) ? data.lights
      : [{ type: 'ambient', intensity: 0.6 }, { type: 'directional', position: [5, 10, 5], intensity: 0.8 }];
    lights.forEach(function (l) {
      var color = new THREE.Color(l.color || '#ffffff');
      var light;
      if (l.type === 'directional') {
        light = new THREE.DirectionalLight(color, l.intensity != null ? l.intensity : 1);
        var p = l.position || [5, 10, 5];
        light.position.set(p[0], p[1], p[2]);
      } else if (l.type === 'point') {
        // "point" (the reference implementation's own light type, e.g. a
        // glowing sun/lamp radiating outward from one location) -- an
        // omnidirectional PointLight, unlike "directional"'s parallel rays
        // from a fixed angle. Was previously silently treated as "ambient"
        // (the else branch below), which ignored "position" entirely and
        // lit the whole scene flatly instead of radiating from a point.
        light = new THREE.PointLight(color, l.intensity != null ? l.intensity : 1);
        var pp = l.position || [0, 0, 0];
        light.position.set(pp[0], pp[1], pp[2]);
      } else {
        light = new THREE.AmbientLight(color, l.intensity != null ? l.intensity : 0.6);
      }
      scene.add(light);
    });

    var animators = [];
    var meshes = [];
    var meshesByName = {};
    var lines = [];
    var particleSystems = [];
    var texturePromises = [];
    // Scoped to this one buildScene call -- de-dupes fetches when several
    // nodes reference the same attachment_id+entry (see
    // loadSharedAttachmentTexture), without any page-wide cache lifetime/
    // invalidation concerns to manage.
    var textureCache = {};
    var warnings = [];
    // Two passes, not one: pass 1 builds every node's actual mesh/points/
    // line object (populating meshesByName as it goes); pass 2 then builds
    // animators, including "orbit"+"parent" (see normalizeAnimation/
    // ANIMATION_BUILDERS.orbit), which needs to look up ANY other node's
    // mesh by name/id regardless of whether that node appears earlier or
    // later in the "nodes" array -- e.g. the moon (with parent: "earth")
    // listed before earth itself. A single combined pass would leave
    // meshesByName only partially populated for a forward reference like
    // that. Mirrors the reference implementation's own two-phase
    // construction (ref-ai/floating-assistant.js's _build3DAnimatorForNode
    // comment: "第一輪先建完所有物件才建animator").
    var builtNodes = [];
    expandNodes(data).forEach(function (n) {
      // One bad/unexpected node must not blank out the whole scene -- a
      // real failure mode before this fix: any single node throwing during
      // construction (e.g. a future mesh type this build somehow mishandles)
      // aborted mount()'s entire promise chain, showing a generic "3D scene
      // failed to load" for a scene where every OTHER node was perfectly
      // fine. Collected warnings are surfaced in the viewer's toolbar title
      // (see mount()) rather than silently swallowed.
      try {
        var obj = buildOneNode(n);
        if (obj) { builtNodes.push({ node: n, mesh: obj }); }
      } catch (e) {
        warnings.push('node "' + (n && (n.id || n.name || n.mesh)) + '": ' + (e && e.message || e));
      }
    });
    builtNodes.forEach(function (entry) {
      var anim = normalizeAnimation(entry.node);
      if (anim && ANIMATION_BUILDERS[anim.type]) {
        animators.push(ANIMATION_BUILDERS[anim.type](entry.mesh, anim, meshesByName));
      }
    });

    function buildOneNode(n) {
      // Particles are a THREE.Points object driven by a per-frame
      // simulation, not a static Geometry+Mesh like every other primitive
      // -- handled entirely separately from the generic mesh path below.
      // Not returned to builtNodes above (particles/lines aren't sensible
      // "parent" targets for another node's orbit, and particles already
      // push their own animator directly here rather than through the
      // spin/bounce/orbit vocabulary).
      if (n.mesh === 'particles') {
        var system = buildParticleSystem(n);
        scene.add(system.points);
        particleSystems.push(system);
        animators.push(system.update);
        return null;
      }

      // A line has no faces to shade -- it's a THREE.Line/LineLoop, not a
      // Mesh, so (like particles above) it's built and added directly
      // rather than going through the generic Geometry+material path below.
      if (n.mesh === 'line') {
        var line = buildLineObject(n);
        scene.add(line);
        lines.push(line);
        return null;
      }

      var build = MESH_BUILDERS[n.mesh];
      if (!build) { return null; } // unknown primitive -- skip rather than crash the whole scene over one bad node

      var geometry = build(n);
      var mat = n.material || {};
      var materialOptions = {
        color: new THREE.Color(mat.color || '#4E79A7'),
        metalness: mat.metalness != null ? mat.metalness : 0.1,
        roughness: mat.roughness != null ? mat.roughness : 0.8
      };
      if (mat.emissive) {
        materialOptions.emissive = new THREE.Color(mat.emissive);
        materialOptions.emissiveIntensity = mat.emissive_intensity != null ? mat.emissive_intensity : 1.0;
      }
      if (mat.opacity != null && mat.opacity < 1) {
        materialOptions.opacity = mat.opacity;
        materialOptions.transparent = true;
      }
      // An arbitrary polygon's faces come straight from AI-authored
      // vertex/index lists -- getting every single face's winding order
      // consistently outward-facing across a whole solid is a real 3D-math
      // task an LLM routinely gets wrong on some subset of faces (confirmed
      // by a real report: a hand-built tetrahedron had one inverted face
      // that vanished under normal single-sided backface culling). Double-
      // siding polygon meshes specifically (not every mesh -- box/sphere/
      // etc. come from three.js's own generators, which are always
      // correctly wound) makes a winding mistake merely cosmetic (that
      // face's shading uses the flipped/incorrect normal) instead of making
      // part of the shape disappear entirely.
      if (n.mesh === 'polygon') { materialOptions.side = THREE.DoubleSide; }
      // "side":"front" (three.js's own default, so nothing to set)|"back"|
      // "double" -- the reference implementation's own field (e.g. a large
      // sky sphere/box meant to be seen from the CAMERA'S POSITION INSIDE
      // IT, where the default outside-facing culling would make it
      // invisible). Checked after the polygon rule above so an explicit
      // "side" on a polygon node still wins over the automatic DoubleSide.
      if (mat.side === 'back') { materialOptions.side = THREE.BackSide; }
      else if (mat.side === 'double') { materialOptions.side = THREE.DoubleSide; }
      // A named procedural pattern applies synchronously (built from a
      // small canvas, no network round-trip) -- set before construction so
      // the material is correct on its very first render. A real
      // uploaded-zip image is inherently async (an actual image load), so
      // it's applied to the material AFTER construction once it resolves;
      // texturePromises lets snapshotToDataUri (a single-frame export) wait
      // for that before it actually renders, so an export doesn't miss a
      // texture that just hadn't finished loading yet.
      if (mat.texture && TEXTURE_PATTERNS[mat.texture]) {
        materialOptions.map = applyTextureRegion(buildProceduralTexture(mat.texture), mat);
        // A texture + a high emissive_intensity together (e.g. a glowing,
        // patterned sun) otherwise washes the texture's pattern out under a
        // flat emissive color -- standard PBR shading behavior, but not
        // what "glowing AND textured" actually means to a scene author.
        // Reusing the same texture as emissiveMap makes the glow follow the
        // texture's own pattern instead of flattening it to a solid color.
        if (mat.emissive) { materialOptions.emissiveMap = materialOptions.map; }
      }
      var material = new THREE.MeshStandardMaterial(materialOptions);
      // A built-in photo texture ("earth", ...) is async exactly like an
      // uploaded-zip texture below (a real image load, no synchronous
      // canvas draw) -- same texturePromises wait-for-export mechanism,
      // same "don't break the whole scene if it somehow fails to load"
      // fallback to the flat color already set above.
      if (BUILTIN_PHOTO_TEXTURE_ASSET_KEYS[mat.texture]) {
        var photoTexPromise = loadBuiltinPhotoTexture(mat.texture).then(function (tex) {
          applyTextureRegion(tex, mat, [1, 1]);
          material.map = tex;
          if (mat.emissive) { material.emissiveMap = tex; }
          material.needsUpdate = true;
        }).catch(function () { /* a missing/broken texture must not break the whole scene -- keep the flat color */ });
        texturePromises.push(photoTexPromise);
      }
      // A direct http(s)/data: image url given as "texture" (see
      // isTextureUrl's own comment) -- same async/fallback shape as the
      // built-in photo texture above, just sourced from the url instead of
      // a fixed vendored asset.
      if (isTextureUrl(mat.texture)) {
        var urlTexPromise = loadUrlTexture(textureCache, mat.texture).then(function (tex) {
          applyTextureRegion(tex, mat, [1, 1]);
          material.map = tex;
          if (mat.emissive) { material.emissiveMap = tex; }
          material.needsUpdate = true;
        }).catch(function () { /* a missing/broken texture must not break the whole scene -- keep the flat color */ });
        texturePromises.push(urlTexPromise);
      }
      if (mat.texture_attachment_id && mat.texture_entry) {
        var texPromise = loadSharedAttachmentTexture(textureCache, mat.texture_attachment_id, mat.texture_entry).then(function (tex) {
          applyTextureRegion(tex, mat);
          material.map = tex;
          if (mat.emissive) { material.emissiveMap = tex; }
          material.needsUpdate = true;
        }).catch(function () { /* a missing/broken texture must not break the whole scene -- keep the flat color */ });
        texturePromises.push(texPromise);
      }
      var mesh = new THREE.Mesh(geometry, material);
      var p = n.position || [0, 0, 0];
      mesh.position.set(p[0], p[1], p[2]);
      // A "plane" with no explicit "rotation" is assumed to be a ground/
      // floor (the overwhelmingly common case for this primitive) rather
      // than three.js's own raw default -- PlaneGeometry lies flat in the
      // local XY plane, i.e. facing the camera like a vertical wall, not
      // lying horizontal like a floor. Nothing about that is discoverable
      // from this format's own vocabulary, so it's a sensible default
      // rather than something callers need to know about three.js
      // internals to get right; an explicit "rotation" always wins.
      var defaultRotation = (n.mesh === 'plane' && !n.rotation) ? [-Math.PI / 2, 0, 0] : [0, 0, 0];
      var r = n.rotation || defaultRotation;
      mesh.rotation.set(r[0], r[1], r[2]);
      // "id" (the reference implementation's own field name) takes
      // priority over this format's original "name", which is still
      // accepted as a synonym for any already-existing scene that used it
      // -- both are just how a node can be referenced by "animation_parent"
      // (or, before that existed, weren't referenced by anything at all).
      mesh.name = n.id || n.name || n.mesh;
      meshesByName[mesh.name] = mesh;
      scene.add(mesh);
      meshes.push(mesh);
      return mesh;
    }

    return {
      scene: scene, animators: animators, meshes: meshes, lines: lines, particleSystems: particleSystems,
      texturesReady: Promise.all(texturePromises), warnings: warnings
    };
  }

  function buildCamera(data, aspect, overridePos, overrideLook) {
    var cam = data.camera || {};
    var pos = overridePos || cam.position || [3, 3, 5];
    var look = overrideLook || cam.look_at || [0, 0, 0];
    // The far-clipping plane must comfortably exceed the camera-to-look_at
    // distance -- a fixed 1000 silently clips large/far-away scenes (a
    // real reported bug: an imported model's own bounding-box-based
    // camera, see buildSceneYaml, routinely puts the camera 500-1000+
    // units from the model for a large/spread-out import, so most or all
    // of the actual geometry ended up beyond this fixed far plane and
    // simply never got drawn -- the camera pointed at the right place,
    // but nothing was left inside its view frustum). Scaling both planes
    // off the real distance keeps every AI-authored scene (small,
    // origin-scale coordinates) working exactly as before, while making
    // large imports actually visible too -- one shared function, so every
    // rendering path (interactive WebGL, the software-rasterizer
    // fallback, and PDF/PPTX snapshot export, which all call this same
    // function) stays consistent with each other.
    var dx = pos[0] - look[0], dy = pos[1] - look[1], dz = pos[2] - look[2];
    var distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
    var far = Math.max(1000, distance * 10);
    var near = far / 100000;
    var camera = new THREE.PerspectiveCamera(cam.fov || 50, aspect, near, far);
    camera.position.set(pos[0], pos[1], pos[2]);
    camera.lookAt(look[0], look[1], look[2]);
    return camera;
  }

  // WebGLRenderer's constructor throws synchronously ("THREE.WebGLRenderer:
  // Error creating WebGL context.") when the browser/machine has no usable
  // WebGL at all -- common on locked-down enterprise VMs/thin clients (this
  // plugin already specifically targets internal/enterprise Redmine
  // instances, see the vendoring note above). Swallowing that here is what
  // lets both mount() and snapshotToDataUri() fall back to the software
  // rasterizer below instead of failing outright.
  function tryCreateWebGLRenderer(canvas, extraOptions) {
    var options = { canvas: canvas, antialias: true };
    for (var k in (extraOptions || {})) { options[k] = extraOptions[k]; }
    try {
      return new THREE.WebGLRenderer(options);
    } catch (e) {
      return null;
    }
  }

  // ------------------------------------------------- software fallback
  //
  // A plain 2D canvas has no WebGL dependency at all, so it works even when
  // tryCreateWebGLRenderer returns null. This is a deliberately simple
  // software rasterizer -- one fixed directional key light (Lambertian,
  // no shadows/specular), flat per-triangle shading, backface culling, and
  // a back-to-front painter's-algorithm depth sort (no per-pixel depth
  // test) -- not a second full renderer. It is enough to make the small,
  // closed set of primitive shapes this format supports legible; three.js
  // itself no longer ships a maintained CPU renderer (the old
  // CanvasRenderer/SVGRenderer were removed years ago), so this is
  // hand-rolled rather than borrowed. Mouse rotate/zoom/pan (OrbitControls)
  // and the built-in spin/bounce/orbit animations both keep working
  // identically in this mode -- neither one ever touches the renderer,
  // only the plain camera/mesh objects, which this rasterizer also reads
  // directly.
  function extractWorldTriangles(mesh) {
    var geo = mesh.geometry;
    var pos = geo.attributes.position.array;
    var index = geo.index ? geo.index.array : null;
    var triCount = index ? index.length / 3 : pos.length / 9;
    var triangles = [];
    var m = mesh.matrixWorld;

    function vertexAt(i) {
      return new THREE.Vector3(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]).applyMatrix4(m);
    }

    for (var t = 0; t < triCount; t++) {
      var a, b, c;
      if (index) {
        a = index[t * 3]; b = index[t * 3 + 1]; c = index[t * 3 + 2];
      } else {
        a = t * 3; b = t * 3 + 1; c = t * 3 + 2;
      }
      triangles.push({
        v0: vertexAt(a), v1: vertexAt(b), v2: vertexAt(c),
        color: mesh.material.color,
        // Always present on a real MeshStandardMaterial (default black,
        // intensity 1) even when the scene never set "emissive" -- so this
        // reads safely and contributes exactly 0 additional light for an
        // ordinary (non-glowing) material, no separate branch needed.
        emissive: mesh.material.emissive,
        emissiveIntensity: mesh.material.emissiveIntensity,
        // Mirrors the WebGL material's own side setting (buildScene sets
        // this for "polygon" meshes specifically) so an inconsistently-
        // wound face is handled the same way in both render paths -- see
        // the doubleSided handling in rasterFrame below.
        doubleSided: mesh.material.side === THREE.DoubleSide
      });
    }
    return triangles;
  }

  function defaultLightDirection(data) {
    var lights = data.lights || [];
    var dirLight = null;
    for (var i = 0; i < lights.length; i++) {
      if (lights[i].type === 'directional') { dirLight = lights[i]; break; }
    }
    var p = dirLight ? (dirLight.position || [5, 10, 5]) : [5, 10, 5];
    return new THREE.Vector3(p[0], p[1], p[2]).normalize();
  }

  function projectToScreen(v, width, height) {
    return { x: (v.x + 1) / 2 * width, y: (1 - v.y) / 2 * height };
  }

  function rasterFrame(ctx, width, height, data, built, camera) {
    built.scene.updateMatrixWorld(true);
    camera.updateMatrixWorld(true);

    ctx.fillStyle = data.background || '#1a1a1a';
    ctx.fillRect(0, 0, width, height);

    var lightDir = defaultLightDirection(data);
    var tris = [];
    built.meshes.forEach(function (mesh) {
      extractWorldTriangles(mesh).forEach(function (tri) { tris.push(tri); });
    });

    tris.forEach(function (tri) {
      var edge1 = tri.v1.clone().sub(tri.v0);
      var edge2 = tri.v2.clone().sub(tri.v0);
      tri.normal = edge1.cross(edge2).normalize();
      tri.center = tri.v0.clone().add(tri.v1).add(tri.v2).multiplyScalar(1 / 3);
      var toCamera = camera.position.clone().sub(tri.center).normalize();
      tri.facing = tri.normal.dot(toCamera) > 0;
      // Mirrors real THREE.DoubleSide behavior: rather than discarding a
      // back-facing triangle, flip its normal to face the camera so it
      // still draws (and shades using the correct outward direction for
      // the side actually visible), instead of an inverted-winding face
      // silently vanishing.
      if (!tri.facing && tri.doubleSided) { tri.normal.negate(); tri.facing = true; }
      tri.viewZ = tri.center.clone().applyMatrix4(camera.matrixWorldInverse).z;
    });

    var visible = tris.filter(function (t) { return t.facing; });
    visible.sort(function (a, b) { return a.viewZ - b.viewZ; }); // farthest (most negative) first

    visible.forEach(function (tri) {
      var p0 = tri.v0.clone().project(camera);
      var p1 = tri.v1.clone().project(camera);
      var p2 = tri.v2.clone().project(camera);
      // Skip triangles that clearly fall outside the view frustum (crude
      // near/far clip) -- projecting a vertex behind the camera would
      // otherwise wrap around to a nonsensical screen position.
      if (Math.abs(p0.z) > 1 || Math.abs(p1.z) > 1 || Math.abs(p2.z) > 1) { return; }

      var s0 = projectToScreen(p0, width, height);
      var s1 = projectToScreen(p1, width, height);
      var s2 = projectToScreen(p2, width, height);

      var lambert = Math.max(0, tri.normal.dot(lightDir));
      var shade = 0.35 + 0.65 * lambert;
      var c = tri.color;
      var e = tri.emissive;
      var ei = tri.emissiveIntensity || 0;
      var r = Math.min(1, c.r * shade + e.r * ei);
      var g = Math.min(1, c.g * shade + e.g * ei);
      var b = Math.min(1, c.b * shade + e.b * ei);
      ctx.fillStyle = 'rgb(' + Math.round(r * 255) + ',' + Math.round(g * 255) + ',' + Math.round(b * 255) + ')';
      ctx.beginPath();
      ctx.moveTo(s0.x, s0.y);
      ctx.lineTo(s1.x, s1.y);
      ctx.lineTo(s2.x, s2.y);
      ctx.closePath();
      ctx.fill();
    });

    // Particles have no faces/triangles at all (THREE.Points, not a Mesh)
    // -- drawn as small filled squares at each particle's projected screen
    // position instead, using its own per-vertex color. No lighting/depth
    // test (points are usually additive/glow-ish effects where that
    // wouldn't read correctly anyway); drawn after every mesh so effects
    // like sparks/flame appear on top of solid geometry behind them.
    (built.particleSystems || []).forEach(function (system) {
      var positions = system.state.positions;
      var colors = system.state.colors;
      // A fixed, constant-size dot (2px half-width, 4x4 total) regardless
      // of the node's configured particle_size -- matches the reference
      // implementation (floating-assistant.js's own software-rasterizer
      // fallback) exactly, so a scene looks the same whether WebGL or this
      // CPU fallback ends up drawing it, and the same whether it's viewed
      // here or in the reference implementation. Previously scaled with
      // (particle_size * canvas dimension), which produced noticeably
      // larger, blockier squares than either WebGL rendering of the same
      // scene or the reference's own fallback -- a real reported visual
      // inconsistency, not an intentional design difference.
      var half = 2;
      for (var i = 0; i < positions.length / 3; i++) {
        var v = new THREE.Vector3(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]).project(camera);
        if (Math.abs(v.z) > 1) { continue; }

        var s = projectToScreen(v, width, height);
        ctx.fillStyle = 'rgb(' + Math.round(colors[i * 3] * 255) + ',' + Math.round(colors[i * 3 + 1] * 255) + ',' + Math.round(colors[i * 3 + 2] * 255) + ')';
        ctx.fillRect(s.x - half, s.y - half, half * 2, half * 2);
      }
    });

    // Lines have no faces either -- projected and stroked as a connected
    // polyline (closing back to the first point for a LineLoop), a third
    // independent drawing step alongside triangles and particles above.
    (built.lines || []).forEach(function (line) {
      line.updateMatrixWorld(true);
      var pos = line.geometry.attributes.position;
      if (!pos) { return; }
      var color = line.material.color;
      ctx.strokeStyle = 'rgb(' + Math.round(color.r * 255) + ',' + Math.round(color.g * 255) + ',' + Math.round(color.b * 255) + ')';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      var started = false;
      var firstPoint = null;
      for (var i = 0; i < pos.count; i++) {
        var v = new THREE.Vector3(pos.getX(i), pos.getY(i), pos.getZ(i)).applyMatrix4(line.matrixWorld).project(camera);
        if (Math.abs(v.z) > 1) { started = false; continue; }

        var s = projectToScreen(v, width, height);
        if (!started) { ctx.moveTo(s.x, s.y); started = true; firstPoint = s; }
        else { ctx.lineTo(s.x, s.y); }
      }
      if (line.isLineLoop && firstPoint) { ctx.lineTo(firstPoint.x, firstPoint.y); }
      ctx.stroke();
    });
  }

  // --------------------------------------------------- export to file formats
  //
  // Export is deliberately done here, client-side, same as import (see
  // parseObj/parseStl/parse3mf below) -- by the time a user wants to
  // export, this scene's three.js geometry is already tessellated
  // and sitting in memory (box/sphere/cylinder/etc tessellation already
  // happened for free via three.js's own geometry generators), so
  // reimplementing that tessellation math in Ruby server-side would be
  // substantial new geometry code for zero benefit. See DESIGN.md.

  // Walks built.meshes (real THREE.Mesh objects only -- particles/lines
  // live in their own separate built.particleSystems/built.lines arrays
  // and have no face data to export) and extracts each one's real,
  // world-transformed vertex/face data -- a thin variant of
  // extractWorldTriangles that keeps deduplicated vertex positions + face
  // index triples (needed for compact OBJ/STL/3MF output) instead of
  // flattening into independent per-triangle vertex triples.
  function extractMeshPartsForExport(built) {
    var parts = [];
    (built.meshes || []).forEach(function (mesh) {
      var geo = mesh.geometry;
      var posAttr = geo.attributes.position;
      if (!posAttr) { return; }

      mesh.updateMatrixWorld(true);
      var m = mesh.matrixWorld;
      var vertices = [];
      for (var i = 0; i < posAttr.count; i++) {
        var v = new THREE.Vector3(posAttr.getX(i), posAttr.getY(i), posAttr.getZ(i)).applyMatrix4(m);
        vertices.push([v.x, v.y, v.z]);
      }

      var faces = [];
      var index = geo.index;
      if (index) {
        for (var t = 0; t < index.count; t += 3) { faces.push([index.getX(t), index.getX(t + 1), index.getX(t + 2)]); }
      } else {
        for (var t2 = 0; t2 + 2 < posAttr.count; t2 += 3) { faces.push([t2, t2 + 1, t2 + 2]); }
      }

      parts.push({ name: mesh.name || 'part', vertices: vertices, faces: faces, color: '#' + mesh.material.color.getHexString() });
    });
    return parts;
  }

  function buildObjBlob(parts) {
    var lines = ['# exported from redmine_ai_chat 3D scene viewer'];
    var vertexOffset = 0;
    parts.forEach(function (p, idx) {
      lines.push('o part_' + (idx + 1) + '_' + (String(p.name || 'unnamed').replace(/\s+/g, '_') || 'unnamed'));
      p.vertices.forEach(function (v) { lines.push('v ' + v[0] + ' ' + v[1] + ' ' + v[2]); });
      p.faces.forEach(function (f) {
        lines.push('f ' + (f[0] + 1 + vertexOffset) + ' ' + (f[1] + 1 + vertexOffset) + ' ' + (f[2] + 1 + vertexOffset));
      });
      vertexOffset += p.vertices.length;
    });
    return new Blob([lines.join('\n')], { type: 'text/plain' });
  }

  function buildStlBlob(parts) {
    var lines = ['solid exported_scene'];
    parts.forEach(function (p) {
      p.faces.forEach(function (f) {
        var va = p.vertices[f[0]], vb = p.vertices[f[1]], vc = p.vertices[f[2]];
        if (!va || !vb || !vc) { return; }

        var ux = vb[0] - va[0], uy = vb[1] - va[1], uz = vb[2] - va[2];
        var wx = vc[0] - va[0], wy = vc[1] - va[1], wz = vc[2] - va[2];
        var nx = (uy * wz) - (uz * wy), ny = (uz * wx) - (ux * wz), nz = (ux * wy) - (uy * wx);
        var len = Math.sqrt((nx * nx) + (ny * ny) + (nz * nz)) || 1;
        nx /= len; ny /= len; nz /= len;
        lines.push('facet normal ' + nx + ' ' + ny + ' ' + nz, '  outer loop');
        [va, vb, vc].forEach(function (v) { lines.push('    vertex ' + v[0] + ' ' + v[1] + ' ' + v[2]); });
        lines.push('  endloop', 'endfacet');
      });
    });
    lines.push('endsolid exported_scene');
    return new Blob([lines.join('\n')], { type: 'model/stl' });
  }

  // A hand-built, minimal OPC/zip container -- not three.js's own exporter
  // (it doesn't have one for 3MF), just enough XML to satisfy parse3mf
  // below (or any other 3MF reader) on the way back in.
  function build3mfBlob(parts) {
    return ensureJSZipLoaded().then(function () {
      var objectsXml = '', buildItemsXml = '';
      parts.forEach(function (p, idx) {
        var objId = idx + 1;
        var verticesXml = p.vertices.map(function (v) { return '<vertex x="' + v[0] + '" y="' + v[1] + '" z="' + v[2] + '"/>'; }).join('');
        var trianglesXml = p.faces.map(function (f) { return '<triangle v1="' + f[0] + '" v2="' + f[1] + '" v3="' + f[2] + '"/>'; }).join('');
        objectsXml += '<object id="' + objId + '" name="' + (p.name || ('part' + objId)) + '" type="model"><mesh><vertices>' +
          verticesXml + '</vertices><triangles>' + trianglesXml + '</triangles></mesh></object>';
        buildItemsXml += '<item objectid="' + objId + '"/>';
      });
      var modelXml = '<?xml version="1.0" encoding="UTF-8"?>\n<model unit="millimeter" xml:lang="en-US" ' +
        'xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">\n  <resources>' + objectsXml +
        '</resources>\n  <build>' + buildItemsXml + '</build>\n</model>';
      var contentTypes = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">\n' +
        '  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>\n' +
        '  <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>\n</Types>';
      var rels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\n' +
        '  <Relationship Target="/3D/3dmodel.model" Id="rel0" ' +
        'Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>\n</Relationships>';
      var zip = new window.JSZip();
      zip.file('[Content_Types].xml', contentTypes);
      zip.file('_rels/.rels', rels);
      zip.file('3D/3dmodel.model', modelXml);
      return zip.generateAsync({ type: 'blob' });
    });
  }

  function downloadBlob(blob, filename) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  // --------------------------------------------------- import from file formats
  //
  // Ported from the plugin's own Ruby SceneTools/(deleted) Model3DImporter
  // rather than three.js's official STLLoader/OBJLoader/ThreeMFLoader --
  // deliberately, to avoid vendoring those (plus fflate, which
  // ThreeMFLoader needs for zip inflation) when OBJ/STL need no library at
  // all and 3MF already has everything it needs client-side (JSZip, from
  // the export work above, + the browser's own native DOMParser). This
  // parsing intentionally happens here, in the browser, and NOT on the
  // server -- parsing a model file (especially a binary STL with many
  // thousands of triangles, or unzipping+parsing a 3MF's XML) is real CPU
  // work that would otherwise tie up a shared Rails worker process for
  // every other user too. The server's only remaining job is validating
  // and saving the small scene yaml this produces (AiChatClientScenesController),
  // exactly the same cost any AI-authored render_3d_scene call already has.

  var MAX_POLYGON_VERTICES = 500; // must stay in sync with SceneTools::MAX_POLYGON_VERTICES
  var MAX_POLYGON_FACES = 1000; // must stay in sync with SceneTools::MAX_POLYGON_FACES

  // Admin-configurable (see RedmineAiChat.max_imported_mesh_triangles /
  // window.AiChat3DLimits, set by index.html.erb) -- was a hardcoded
  // constant with no way to raise it at all, which a real user hit
  // immediately on a legitimate large model. 0 means unlimited, matching
  // the same convention as the "Max 3D scene nodes after expansion"
  // setting (which this mirrors -- see scene_tools.rb's validate_scene!).
  function currentMaxImportTriangles() {
    var limits = window.AiChat3DLimits;
    return (limits && typeof limits.maxImportTriangles === 'number') ? limits.maxImportTriangles : 10000;
  }

  function bytesToUtf8String(bytes) {
    return new TextDecoder('utf-8').decode(bytes);
  }

  // Cheap chunked conversion (avoids String.fromCharCode.apply blowing the
  // call stack on a large buffer) -- used only for ASCII-STL sniffing/
  // parsing, where the content is guaranteed 7-bit-safe text.
  function bytesToLatin1String(bytes) {
    var view = new Uint8Array(bytes);
    var chunks = [];
    var CHUNK = 0x8000;
    for (var i = 0; i < view.length; i += CHUNK) {
      chunks.push(String.fromCharCode.apply(null, view.subarray(i, i + CHUNK)));
    }
    return chunks.join('');
  }

  // OBJ vertex indices are 1-based and GLOBAL across the whole file (a face
  // can reference a vertex defined before any "o"/"g" line) -- "o"/"g"
  // lines split faces into named parts, but each part's own vertex array
  // (for our "polygon" node, always local/0-based) only needs to contain
  // the vertices that part actually references, remapped to local indices.
  function parseObj(text) {
    var vertices = [];
    var parts = [];
    var currentName = 'part1';
    var currentFaces = [];

    function flushPart() {
      if (currentFaces.length) { parts.push({ name: currentName, globalFaces: currentFaces }); }
    }

    text.split(/\r?\n/).forEach(function (rawLine) {
      var line = rawLine.trim();
      if (!line || line.charAt(0) === '#') { return; }

      var tokens = line.split(/\s+/);
      if (tokens[0] === 'v') {
        vertices.push([parseFloat(tokens[1]), parseFloat(tokens[2]), parseFloat(tokens[3])]);
      } else if (tokens[0] === 'o' || tokens[0] === 'g') {
        flushPart();
        currentFaces = [];
        currentName = tokens[1] || ('part' + (parts.length + 1));
      } else if (tokens[0] === 'f') {
        // Each face vertex may be "v", "v/vt", "v/vt/vn", or "v//vn" -- only
        // the vertex index (before the first "/") matters here.
        var idxs = tokens.slice(1).map(function (t) { return parseInt(t.split('/')[0], 10); });
        idxs = idxs.map(function (i) { return i > 0 ? i - 1 : vertices.length + i; }); // negative = relative-from-end
        // Triangulate a polygon face (fan) if it has more than 3 vertices.
        for (var k = 1; k <= idxs.length - 2; k++) { currentFaces.push([idxs[0], idxs[k], idxs[k + 1]]); }
      }
    });
    flushPart();

    if (!parts.length) { throw new Error('OBJ file has no faces'); }

    return parts.map(function (part) {
      var usedSet = {};
      part.globalFaces.forEach(function (f) { f.forEach(function (gi) { usedSet[gi] = true; }); });
      var used = Object.keys(usedSet).map(Number).sort(function (a, b) { return a - b; });
      var remap = {};
      used.forEach(function (gi, li) { remap[gi] = li; });
      return {
        name: part.name,
        vertices: used.map(function (gi) { return vertices[gi]; }),
        faces: part.globalFaces.map(function (f) { return f.map(function (gi) { return remap[gi]; }); }),
        color: '#cccccc'
      };
    });
  }

  // Binary STL is also legally allowed to start with the literal bytes
  // "solid" as an arbitrary 80-byte header -- only trust the ASCII branch
  // if real ASCII STL keywords actually appear too. Only the first few KB
  // are sniffed (not the whole file, unlike the Ruby version this was
  // ported from) since a real ASCII STL's "facet normal"/"outer loop"
  // keywords are guaranteed to appear at/near the very start (right after
  // the "solid ..." line, before the first vertex) -- a deliberate, safe
  // simplification for potentially very large files.
  function isAsciiStl(bytes) {
    var sniffLen = Math.min(bytes.byteLength, 4096);
    var head = bytesToLatin1String(bytes.slice(0, sniffLen));
    return /^\s*solid\b/.test(head) && head.indexOf('facet normal') !== -1 && head.indexOf('outer loop') !== -1;
  }

  function parseStlAscii(text) {
    var vertices = [];
    var faces = [];
    var pending = [];
    text.split(/\r?\n/).forEach(function (rawLine) {
      var line = rawLine.trim();
      if (line.indexOf('vertex') !== 0) { return; }

      var tokens = line.split(/\s+/);
      pending.push([parseFloat(tokens[1]), parseFloat(tokens[2]), parseFloat(tokens[3])]);
      if (pending.length === 3) {
        var base = vertices.length;
        vertices.push(pending[0], pending[1], pending[2]);
        faces.push([base, base + 1, base + 2]);
        pending = [];
      }
    });
    if (!faces.length) { throw new Error('STL file has no triangles'); }

    return [{ name: 'part1', vertices: vertices, faces: faces, color: '#cccccc' }];
  }

  // 80-byte header (arbitrary content, ignored) + 4-byte little-endian
  // triangle count + N x 50-byte records (12 bytes normal (ignored, three.js
  // recomputes it on render), 3 x 12-byte float32 vertices, 2-byte
  // attribute (ignored)).
  function parseStlBinary(bytes) {
    if (bytes.byteLength < 84) { throw new Error('binary STL file is too short to contain a valid header'); }

    var view = new DataView(bytes);
    var triangleCount = view.getUint32(80, true);
    var expectedSize = 84 + (triangleCount * 50);
    if (bytes.byteLength < expectedSize) { throw new Error('binary STL file size does not match its declared triangle count'); }

    var vertices = [];
    var faces = [];
    var offset = 84;
    for (var t = 0; t < triangleCount; t++) {
      var v1 = [view.getFloat32(offset + 12, true), view.getFloat32(offset + 16, true), view.getFloat32(offset + 20, true)];
      var v2 = [view.getFloat32(offset + 24, true), view.getFloat32(offset + 28, true), view.getFloat32(offset + 32, true)];
      var v3 = [view.getFloat32(offset + 36, true), view.getFloat32(offset + 40, true), view.getFloat32(offset + 44, true)];
      var base = vertices.length;
      vertices.push(v1, v2, v3);
      faces.push([base, base + 1, base + 2]);
      offset += 50;
    }
    if (!faces.length) { throw new Error('STL file has no triangles'); }

    return [{ name: 'part1', vertices: vertices, faces: faces, color: '#cccccc' }];
  }

  function parseStl(bytes) {
    return isAsciiStl(bytes) ? parseStlAscii(bytesToLatin1String(bytes)) : parseStlBinary(bytes);
  }

  // 3MF is a zip containing XML -- JSZip (already vendored for 3MF/PPTX
  // export above) reads the zip, the browser's own native DOMParser reads
  // the XML (no Nokogiri equivalent needed client-side).
  function parse3mf(bytes) {
    return ensureJSZipLoaded().then(function () {
      return window.JSZip.loadAsync(bytes);
    }).then(function (zip) {
      var entry = zip.file('3D/3dmodel.model');
      if (!entry) { throw new Error('not a valid .3mf file (missing 3D/3dmodel.model)'); }
      return entry.async('text');
    }).then(function (xmlText) {
      var doc = new DOMParser().parseFromString(xmlText, 'application/xml');
      var objectEls = doc.getElementsByTagName('object');
      var parts = [];
      for (var i = 0; i < objectEls.length; i++) {
        var objectEl = objectEls[i];
        var vertexEls = objectEl.getElementsByTagName('vertex');
        var triangleEls = objectEl.getElementsByTagName('triangle');
        var vertices = [];
        for (var v = 0; v < vertexEls.length; v++) {
          vertices.push([parseFloat(vertexEls[v].getAttribute('x')), parseFloat(vertexEls[v].getAttribute('y')), parseFloat(vertexEls[v].getAttribute('z'))]);
        }
        var faces = [];
        for (var t = 0; t < triangleEls.length; t++) {
          faces.push([
            parseInt(triangleEls[t].getAttribute('v1'), 10),
            parseInt(triangleEls[t].getAttribute('v2'), 10),
            parseInt(triangleEls[t].getAttribute('v3'), 10)
          ]);
        }
        if (!vertices.length || !faces.length) { continue; }

        parts.push({ name: objectEl.getAttribute('name') || ('part' + (i + 1)), vertices: vertices, faces: faces, color: '#cccccc' });
      }
      if (!parts.length) { throw new Error('no usable mesh objects found in this .3mf file'); }

      return parts;
    });
  }

  // A "polygon" node's own vertex/face counts are capped
  // (MAX_POLYGON_VERTICES/MAX_POLYGON_FACES) -- limits sized for a single
  // AI-authored call, not for a whole imported model's mesh part, which
  // can easily have thousands of faces. Splits one part's faces into as
  // many polygon nodes as needed to stay under BOTH caps (greedily closing
  // the current chunk before either limit would be exceeded), each with
  // its own local 0-based vertex list -- a purely mechanical split, not a
  // change in what gets rendered. Ported from Ruby's
  // chunk_part_into_nodes, including the real bug it caught and fixed
  // there (a shared vertex-array reference across chunks would make
  // YAML.dump emit an alias/anchor pair, which parse_scene_yaml's
  // aliases:false safety setting refuses to load) -- .slice() gives each
  // chunk its own independent copy, and buildSceneYaml below also passes
  // {noRefs:true} to js-yaml's dump as a second, belt-and-suspenders fix
  // at the serialization boundary itself.
  function chunkPartIntoNodes(part) {
    var chunks = [];
    var chunkFaces = [];
    var remap = {};

    function flushChunk() {
      if (!chunkFaces.length) { return; }

      var localVertices = new Array(Object.keys(remap).length);
      Object.keys(remap).forEach(function (globalIdxStr) {
        localVertices[remap[globalIdxStr]] = part.vertices[parseInt(globalIdxStr, 10)].slice();
      });
      chunks.push({ faces: chunkFaces, vertices: localVertices });
    }

    part.faces.forEach(function (face) {
      var newVertexCount = face.filter(function (gi) { return !(gi in remap); }).length;
      if (chunkFaces.length >= MAX_POLYGON_FACES || (Object.keys(remap).length + newVertexCount) > MAX_POLYGON_VERTICES) {
        flushChunk();
        chunkFaces = [];
        remap = {};
      }
      chunkFaces.push(face.map(function (gi) {
        if (!(gi in remap)) { remap[gi] = Object.keys(remap).length; }
        return remap[gi];
      }));
    });
    flushChunk();

    return chunks.map(function (chunk, i) {
      var suffix = chunks.length > 1 ? ('_' + (i + 1)) : '';
      return {
        name: part.name + suffix,
        mesh: 'polygon',
        vertices: chunk.vertices,
        faces: chunk.faces,
        material: { color: part.color || '#cccccc' }
      };
    });
  }

  // A real imported model's coordinates can be ANY scale/offset (a CAD
  // export centered nowhere near the origin, spanning hundreds of units --
  // an actual reported case: an alligator model with vertices from ~0 to
  // ~290 on X/Y and flat Z=0). A camera hardcoded to look at [0,0,0] from
  // [3,3,5] would either be buried inside such a model or pointed at empty
  // space next to it -- the scene "loads" successfully (no error) but the
  // canvas shows nothing, which is exactly the reported symptom. Framing
  // the camera around the ACTUAL bounding box of the imported geometry
  // fixes this regardless of the model's native scale/position.
  function computeBoundingBox(parts) {
    var min = [Infinity, Infinity, Infinity];
    var max = [-Infinity, -Infinity, -Infinity];
    parts.forEach(function (part) {
      (part.vertices || []).forEach(function (v) {
        for (var i = 0; i < 3; i++) {
          if (v[i] < min[i]) { min[i] = v[i]; }
          if (v[i] > max[i]) { max[i] = v[i]; }
        }
      });
    });
    return { min: min, max: max };
  }

  // Emits a "kind: ai_chat_scene" document: a default camera/lights framing
  // computed from the imported object's actual bounding box, plus one or
  // more "mesh: polygon" nodes per part. "title" is deliberately NOT a
  // field here -- it isn't one of scene_tools.rb's KNOWN_TOP_LEVEL_KEYS, so
  // embedding it would fail the scene's own top-level-key validation.
  function buildSceneYaml(parts) {
    var nodes = [];
    parts.forEach(function (part) { chunkPartIntoNodes(part).forEach(function (n) { nodes.push(n); }); });

    var bbox = computeBoundingBox(parts);
    var hasFiniteBounds = isFinite(bbox.min[0]);
    var center = hasFiniteBounds ? [0, 1, 2].map(function (i) { return (bbox.min[i] + bbox.max[i]) / 2; }) : [0, 0, 0];
    var extent = hasFiniteBounds ? [0, 1, 2].map(function (i) { return bbox.max[i] - bbox.min[i]; }) : [1, 1, 1];
    var maxExtent = Math.max(extent[0], extent[1], extent[2], 0.001);
    // A flat/2D-ish import (e.g. Z always 0) still needs a camera that
    // isn't perfectly edge-on -- the fixed 0.6 vertical bias keeps the
    // model visible instead of viewed exactly along its own flat plane.
    var distance = maxExtent * 1.5;
    var scene = {
      kind: 'ai_chat_scene',
      background: '#1a1a2e',
      camera: {
        position: [center[0] + distance, center[1] + distance * 0.6 + maxExtent * 0.1, center[2] + distance],
        look_at: center,
        fov: 50
      },
      lights: [
        { type: 'ambient', intensity: 0.6 },
        { type: 'directional', position: [center[0] + maxExtent, center[1] + maxExtent * 2, center[2] + maxExtent], intensity: 0.8 }
      ],
      nodes: nodes
    };
    return window.jsyaml.dump(scene, { noRefs: true });
  }

  // Cheap content-sniffing fallback for parseModelFile, used only when the
  // filename's own extension isn't one of obj/stl/3mf -- e.g. a previously
  // exported ".3dscene.yaml" re-downloaded through a save dialog that
  // trimmed/changed its extension, or any raw model file attached under a
  // renamed/extensionless filename. Mirrors scene_tools.rb's own
  // #sniff_model_or_scene (duplicated rather than shared, one is JS and the
  // other Ruby -- see that method's own comment). Returns 'obj'/'stl'/'3mf',
  // or null if content isn't recognizable as any of them either.
  function sniffModelFormat(bytes) {
    if (bytes.byteLength >= 4) {
      var head4 = new Uint8Array(bytes, 0, 4);
      // 3MF is a zip: local-file-header ("PK\x03\x04") or empty-archive
      // ("PK\x05\x06") magic.
      if (head4[0] === 0x50 && head4[1] === 0x4B && (head4[2] === 0x03 || head4[2] === 0x05) && (head4[3] === 0x04 || head4[3] === 0x06)) {
        return '3mf';
      }
    }
    if (isAsciiStl(bytes)) { return 'stl'; }
    // Binary STL: the 84-byte header's declared triangle count must exactly
    // account for the rest of the file's size -- an unlikely-by-coincidence
    // signature for content that isn't really a binary STL.
    if (bytes.byteLength >= 84) {
      var triangleCount = new DataView(bytes).getUint32(80, true);
      if (triangleCount > 0 && 84 + (triangleCount * 50) === bytes.byteLength) { return 'stl'; }
    }
    // OBJ: plain text with recognizable vertex/face lines near the start
    // (not necessarily the very first lines -- comments/mtllib often come
    // first), so this only needs to find them somewhere in the sniffed head.
    var head = bytesToUtf8String(bytes.slice(0, Math.min(bytes.byteLength, 4096)));
    if (/^\s*v\s+-?[\d.]/m.test(head) && /^\s*f\s+\d/m.test(head)) { return 'obj'; }
    return null;
  }

  // Same idea as sniffModelFormat, but for "is this actually an already-
  // built ai_chat_scene yaml, just under a filename that doesn't end in
  // .3dscene.yaml" -- e.g. the exact renamed-export case described above.
  // Deliberately a cheap regex over a small head, not a real YAML parse --
  // parseScene/validate_scene! (called by whichever caller actually treats
  // this as a scene) already do the real, authoritative parsing/validation.
  function looksLikeSceneYaml(bytes) {
    var head = bytesToLatin1String(bytes.slice(0, Math.min(bytes.byteLength, 4096)));
    // "kind: ai_chat_scene" (checked first when present) is this port's own
    // original marker; a bare top-level "nodes:" is just as reliable a
    // signal now that "kind" is no longer required at all (see
    // scene_tools.rb#validate_scene! -- the reference implementation's own
    // scenes never have a "kind" field).
    return /^\s*kind\s*:\s*ai_chat_scene\b/m.test(head) || /^nodes\s*:\s*$/m.test(head);
  }

  function parseModelFile(filename, bytes) {
    var ext = String(filename || '').toLowerCase().split('.').pop();
    if (['obj', 'stl', '3mf'].indexOf(ext) === -1) {
      var sniffed = sniffModelFormat(bytes);
      if (sniffed) { ext = sniffed; }
    }
    var partsPromise;
    if (ext === 'obj') { partsPromise = Promise.resolve(parseObj(bytesToUtf8String(bytes))); }
    else if (ext === 'stl') { partsPromise = Promise.resolve(parseStl(bytes)); }
    else if (ext === '3mf') { partsPromise = parse3mf(bytes); }
    else { return Promise.reject(new Error('unsupported 3D model format: "' + ext + '" -- content sniffing could not identify it either (supported: obj, stl, 3mf)')); }

    return partsPromise.then(function (parts) {
      var totalTriangles = parts.reduce(function (sum, p) { return sum + p.faces.length; }, 0);
      var maxTriangles = currentMaxImportTriangles();
      if (maxTriangles > 0 && totalTriangles > maxTriangles) {
        throw new Error('model has ' + totalTriangles + ' triangles, over the ' + maxTriangles + ' import limit -- use a simpler/lower-poly model, or raise "Max imported 3D model triangles" (0 = unlimited) in the plugin\'s admin settings');
      }
      return parts;
    });
  }

  // The single entry point ai_chat.js calls for both the AI-tool
  // client-round-trip and the "/import-3d-model" slash command -- fetches
  // the uploaded model file's bytes, parses it, and returns the built
  // scene yaml text ready to POST to AiChatClientScenesController.
  function fetchAndBuildSceneYaml(downloadUrl, filename) {
    // buildSceneYaml() below calls window.jsyaml.dump() -- js-yaml (like
    // three.js/OrbitControls) is lazy-loaded, normally by mount()'s own
    // ensureLibsLoaded() call whenever an existing rendered scene is first
    // shown on screen. This entry point is reachable WITHOUT any scene
    // ever having been mounted yet (a fresh session/page load whose very
    // first 3D interaction is an import, via either the AI tool or
    // "/import-3d-model") -- without this call, window.jsyaml is simply
    // undefined and buildSceneYaml's .dump() throws "Cannot read
    // properties of undefined (reading 'dump')" (a real reported error).
    return ensureLibsLoaded().then(function () {
      return fetch(downloadUrl, { credentials: 'same-origin' });
    }).then(function (res) {
      if (!res.ok) { throw new Error('HTTP ' + res.status); }
      return res.arrayBuffer();
    }).then(function (bytes) {
      return sceneYamlFromBytes(bytes, filename);
    });
  }

  // Same conversion as fetchAndBuildSceneYaml, for bytes the caller already
  // holds -- a model/scene that lives only in the browser's own
  // persistentStorage (attached over the server's attachment size limit, or
  // dropped in) has no download url to fetch.
  function buildSceneYamlFromBytes(bytes, filename) {
    return ensureLibsLoaded().then(function () { return sceneYamlFromBytes(bytes, filename); });
  }

  function sceneYamlFromBytes(bytes, filename) {
    return Promise.resolve(bytes).then(function (bytes) {
      // Content-sniffed fallback for the "already a real scene" case (see
      // looksLikeSceneYaml's own comment) -- the filename-based fast path
      // (".3dscene.yaml" suffix, checked by callers before ever reaching
      // this function) already skips conversion entirely when the name
      // matches; this covers the same renamed-export case content-first,
      // for whichever caller didn't (or couldn't) check the name first.
      if (looksLikeSceneYaml(bytes)) { return bytesToUtf8String(bytes); }
      return parseModelFile(filename, bytes).then(function (parts) { return buildSceneYaml(parts); });
    });
  }

  // ------------------------------------------------------ on-screen viewer

  function buildViewerContainer(url, alt) {
    var container = document.createElement('div');
    container.className = 'ai-chat-3d-viewer';
    container.setAttribute('data-scene-url', url);
    // Kept separate from the mutable title element below (which later gets
    // "(software rendering...)"/"(N node warnings...)" suffixes appended)
    // so the export filenames stay clean regardless of when the user
    // actually clicks export.
    container.setAttribute('data-scene-alt', alt || 'scene');

    var status = document.createElement('div');
    status.className = 'ai-chat-3d-status';
    status.textContent = 'Loading 3D scene…';
    container.appendChild(status);

    var canvas = document.createElement('canvas');
    canvas.className = 'ai-chat-3d-canvas';
    container.appendChild(canvas);

    var toolbar = document.createElement('div');
    toolbar.className = 'ai-chat-3d-toolbar';
    var title = document.createElement('span');
    title.className = 'ai-chat-3d-title';
    title.textContent = alt || '';
    var reset = document.createElement('button');
    reset.type = 'button';
    reset.className = 'ai-chat-3d-reset';
    reset.textContent = 'Reset view';
    toolbar.appendChild(title);
    toolbar.appendChild(reset);

    var exportWrap = document.createElement('div');
    exportWrap.className = 'ai-chat-3d-export-wrap';
    var exportBtn = document.createElement('button');
    exportBtn.type = 'button';
    exportBtn.className = 'ai-chat-3d-export-btn';
    exportBtn.textContent = 'Export ▾';
    var exportMenu = document.createElement('div');
    exportMenu.className = 'ai-chat-3d-export-menu';
    exportMenu.style.display = 'none';
    [['yaml', 'YAML'], ['obj', 'OBJ'], ['stl', 'STL'], ['3mf', '3MF'], ['mp4', '🎬 MP4影片']].forEach(function (pair) {
      var item = document.createElement('div');
      item.className = 'ai-chat-3d-export-item';
      item.setAttribute('data-fmt', pair[0]);
      item.textContent = pair[1];
      exportMenu.appendChild(item);
    });
    exportBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      document.querySelectorAll('.ai-chat-3d-export-menu').forEach(function (m) { if (m !== exportMenu) { m.style.display = 'none'; } });
      exportMenu.style.display = exportMenu.style.display === 'block' ? 'none' : 'block';
    });
    document.addEventListener('click', function () { exportMenu.style.display = 'none'; });
    exportWrap.appendChild(exportBtn);
    exportWrap.appendChild(exportMenu);
    toolbar.appendChild(exportWrap);

    container.appendChild(toolbar);

    return container;
  }

  function mount(container) {
    var url = container.getAttribute('data-scene-url');
    var status = container.querySelector('.ai-chat-3d-status');
    var canvas = container.querySelector('.ai-chat-3d-canvas');
    var resetBtn = container.querySelector('.ai-chat-3d-reset');
    var title = container.querySelector('.ai-chat-3d-title');

    ensureLibsLoaded().then(function () {
      return fetch(url, { credentials: 'same-origin' }).then(function (res) {
        if (!res.ok) { throw new Error('HTTP ' + res.status); }
        return res.text();
      });
    }).then(function (yamlText) {
      var data = parseScene(yamlText);
      var built = buildScene(data);
      if (built.warnings && built.warnings.length && title) {
        title.textContent = (title.textContent ? title.textContent + ' ' : '') + '(' + built.warnings.length + ' node warning' + (built.warnings.length > 1 ? 's' : '') + ', see console)';
        built.warnings.forEach(function (w) { console.warn('[ai_chat_3d_viewer]', w); });
      }

      var baseName = (container.getAttribute('data-scene-alt') || 'scene').replace(/\s+/g, '_').replace(/[^\w-]/g, '') || 'scene';

      // Builds a completely FRESH scene/camera/renderer from the same
      // yaml (independent of the live on-screen preview's own `built`
      // animator state, which has already been running since mount and
      // would otherwise make every export start mid-animation instead of
      // deterministically from t=0) -- the only thing shared with the
      // live preview is the underlying yaml text itself.
      function exportSceneToMp4(exportBtnEl) {
        var defaults = { durationSeconds: 5, speed: 1 };
        window.AiChatVideoExport.showMp4ExportOptionsDialog(defaults).then(function (chosen) {
          if (!chosen) { return; }

          var durationSeconds = Math.max(1, chosen.durationSeconds); // no upper bound, deliberately (per the reference this was ported from)
          var fps = 30;
          var speed = Math.max(0.1, Math.min(4, chosen.speed));
          var exportWidth = 640, exportHeight = 480;

          var exportCanvas = document.createElement('canvas');
          exportCanvas.width = exportWidth; exportCanvas.height = exportHeight;
          var exportBuilt = buildScene(data);
          // Use the live, user-rotated/zoomed/panned camera (OrbitControls
          // only ever mutates `camera`/`controls.target` in place -- see
          // below) as the export's starting view instead of re-deriving a
          // fresh one from the yaml's own static "camera" field. Without
          // this override, the exported video always opened from the
          // scene's original default angle no matter how the user had
          // rotated the on-screen preview beforehand (a real reported bug:
          // "export mp4 doesn't reflect the rotation shown on screen").
          var exportCamera = buildCamera(data, exportWidth / exportHeight, camera.position.toArray(), [controls.target.x, controls.target.y, controls.target.z]);
          var exportRenderer = tryCreateWebGLRenderer(exportCanvas, { preserveDrawingBuffer: true });
          var exportCtx2d = exportRenderer ? null : exportCanvas.getContext('2d');
          if (exportRenderer) { exportRenderer.setSize(exportWidth, exportHeight, false); }

          return exportBuilt.texturesReady.then(function () {
            var totalFrames = Math.round(durationSeconds * fps);
            var dtPerFrame = (1 / fps) * speed; // speed is a time-axis multiplier, not a frame-rate/bitrate change
            return window.AiChatVideoExport.encodeCanvasFramesToMp4(exportCanvas, totalFrames, fps, function () {
              exportBuilt.animators.forEach(function (fn) { fn(dtPerFrame); });
              if (exportRenderer) { exportRenderer.render(exportBuilt.scene, exportCamera); }
              else { rasterFrame(exportCtx2d, exportWidth, exportHeight, data, exportBuilt, exportCamera); }
            }, function (current, total) {
              if (total > 0) { exportBtnEl.textContent = '⏳' + Math.round((current / total) * 100) + '%'; }
            });
          }).then(function (result) {
            downloadBlob(result.blob, baseName + '.mp4');
            if (exportRenderer) { exportRenderer.dispose(); }
          });
        }).catch(function (err) {
          window.AiChatDialog.notify('MP4 export failed: ' + (err && err.message || err));
        });
      }

      container.querySelectorAll('.ai-chat-3d-export-item').forEach(function (item) {
        item.addEventListener('click', function (e) {
          e.stopPropagation();
          item.parentNode.style.display = 'none';
          var fmt = item.getAttribute('data-fmt');
          if (fmt === 'yaml') {
            downloadBlob(new Blob([yamlText], { type: 'application/x-yaml' }), baseName + '.3dscene.yaml');
            return;
          }
          if (fmt === 'mp4') {
            exportSceneToMp4(item);
            return;
          }
          var parts = extractMeshPartsForExport(built);
          if (!parts.length) {
            window.AiChatDialog.notify('This scene has no exportable mesh geometry (e.g. a particles/lines-only scene has no triangle mesh to export).');
            return;
          }
          if (fmt === 'obj') { downloadBlob(buildObjBlob(parts), baseName + '.obj'); }
          else if (fmt === 'stl') { downloadBlob(buildStlBlob(parts), baseName + '.stl'); }
          else if (fmt === '3mf') {
            build3mfBlob(parts).then(function (blob) { downloadBlob(blob, baseName + '.3mf'); })
              .catch(function (err) { window.AiChatDialog.notify('3MF export failed: ' + (err && err.message || err)); });
          }
        });
      });

      var width = container.clientWidth || 480;
      var height = Math.round(width * 0.65);
      canvas.width = width; canvas.height = height;

      var camera = buildCamera(data, width / height);
      // OrbitControls only ever mutates the plain camera object via mouse
      // events on canvas -- it works identically whether or not a
      // WebGLRenderer exists, so it's created before deciding which way
      // frames actually get drawn.
      var controls = new THREE.OrbitControls(camera, canvas);
      var look = (data.camera && data.camera.look_at) || [0, 0, 0];
      controls.target.set(look[0], look[1], look[2]);
      controls.update();

      var initialCameraPos = camera.position.clone();
      var initialTarget = controls.target.clone();
      resetBtn.addEventListener('click', function () {
        camera.position.copy(initialCameraPos);
        controls.target.copy(initialTarget);
        controls.update();
      });

      var renderer = tryCreateWebGLRenderer(canvas);
      var ctx2d = null;
      if (renderer) {
        renderer.setSize(width, height, false);
        renderer.setPixelRatio(window.devicePixelRatio || 1);
      } else {
        ctx2d = canvas.getContext('2d');
        if (title) { title.textContent = (title.textContent ? title.textContent + ' ' : '') + '(software rendering -- WebGL unavailable)'; }
      }

      status.style.display = 'none';

      var clock = new THREE.Clock();
      var stopped = false;
      function frame() {
        if (stopped) { return; }
        var dt = Math.min(clock.getDelta(), 0.1);
        built.animators.forEach(function (fn) { fn(dt); });
        controls.update();
        if (renderer) {
          renderer.render(built.scene, camera);
        } else {
          rasterFrame(ctx2d, width, height, data, built, camera);
        }
        requestAnimationFrame(frame);
      }
      frame();

      mounted.push({ container: container, renderer: renderer, stop: function () { stopped = true; } });
    }).catch(function (e) {
      status.textContent = '3D scene failed to load: ' + e.message;
      status.className = 'ai-chat-3d-status ai-chat-3d-error';
    });
  }

  // Scans rootEl (a freshly-rendered message's content element) for plain
  // <img> tags pointing at a *.3dscene.yaml url and replaces each with a
  // live, mounted viewer -- reusing the exact same markdown image syntax
  // (![description](url)) the model already uses for every other tool
  // result, rather than inventing a second, parallel markdown extension.
  function mountAll(rootEl) {
    if (!rootEl || !rootEl.querySelectorAll) { return; }
    var imgs = rootEl.querySelectorAll('img[src]');
    Array.prototype.forEach.call(imgs, function (img) {
      var src = img.getAttribute('src');
      if (!isSceneUrl(src)) { return; }
      var container = buildViewerContainer(src, img.getAttribute('alt'));
      img.parentNode.replaceChild(container, img);
      mount(container);
    });
  }

  // ------------------------------------------- static snapshot for export
  //
  // A WebGL canvas has no native vector/SVG representation -- "convert to
  // SVG at an angle" is approximated the same way the existing SVG-chart
  // export path works in reverse: render one real frame at the scene's own
  // default camera angle to an offscreen canvas and read it back as a PNG
  // data URI (see rasterizeIfSvg in ai_chat_markdown.js for the mirror-image
  // case). Animations are frozen at their starting pose since a static
  // document can't show motion.
  function snapshotToDataUri(url) {
    return ensureLibsLoaded().then(function () {
      return fetch(url, { credentials: 'same-origin' }).then(function (res) {
        if (!res.ok) { throw new Error('HTTP ' + res.status); }
        return res.text();
      });
    }).then(function (yamlText) {
      var data = parseScene(yamlText);
      var built = buildScene(data);

      // Wait for any real (async) uploaded-zip textures to actually finish
      // loading before rendering the one frame this export gets -- unlike
      // the on-screen viewer, there is no later frame for a texture to pop
      // into once it resolves.
      return built.texturesReady.then(function () { return { data: data, built: built }; });
    }).then(function (ready) {
      var data = ready.data;
      var built = ready.built;

      var width = 640, height = 420;
      var canvas = document.createElement('canvas');
      canvas.width = width; canvas.height = height;
      var camera = buildCamera(data, width / height);

      // Advance every animator (spin/bounce/orbit meshes, particle systems)
      // forward by ~1.5s of simulated time before the single frame this
      // export actually captures -- otherwise a static export always shows
      // every animated thing at its literal starting pose, which for a
      // particle effect (spark/flame/firework/etc.) looks like everything
      // bunched up at its emission point rather than mid-effect.
      var settleSteps = 90, settleDt = 1 / 60;
      for (var i = 0; i < settleSteps; i++) {
        built.animators.forEach(function (fn) { fn(settleDt); });
      }

      var renderer = tryCreateWebGLRenderer(canvas, { preserveDrawingBuffer: true });
      if (renderer) {
        renderer.setSize(width, height, false);
        renderer.render(built.scene, camera);
      } else {
        rasterFrame(canvas.getContext('2d'), width, height, data, built, camera);
      }

      var dataUri = canvas.toDataURL('image/png');
      if (renderer) { renderer.dispose(); }
      return dataUri;
    });
  }

  window.AiChat3D = {
    isSceneUrl: isSceneUrl,
    mountAll: mountAll,
    snapshotToDataUri: snapshotToDataUri,
    // three.js + js-yaml loader, reused by the media-presentation deck player (a live 3D slide visual).
    ensureLibsLoaded: ensureLibsLoaded,
    // Real public API, called by ai_chat.js for both the AI-tool
    // client-round-trip (a resumed "parse_3d_model" pending_browser_action)
    // and the fully client-side "/import-3d-model" slash command.
    fetchAndBuildSceneYaml: fetchAndBuildSceneYaml,
    buildSceneYamlFromBytes: buildSceneYamlFromBytes,
    // Exposed for testing only -- not part of the supported external API.
    _internal: {
      parseScene: parseScene,
      expandNodes: expandNodes,
      buildScene: buildScene,
      buildCamera: buildCamera,
      parseObj: parseObj,
      parseStl: parseStl,
      parseStlAscii: parseStlAscii,
      parseStlBinary: parseStlBinary,
      isAsciiStl: isAsciiStl,
      parse3mf: parse3mf,
      chunkPartIntoNodes: chunkPartIntoNodes,
      buildSceneYaml: buildSceneYaml,
      computeBoundingBox: computeBoundingBox,
      parseModelFile: parseModelFile,
      MESH_BUILDERS: MESH_BUILDERS,
      ANIMATION_BUILDERS: ANIMATION_BUILDERS,
      TEXTURE_PATTERNS: TEXTURE_PATTERNS,
      buildProceduralTexture: buildProceduralTexture,
      loadAttachmentTexture: loadAttachmentTexture,
      loadSharedAttachmentTexture: loadSharedAttachmentTexture,
      loadBuiltinPhotoTexture: loadBuiltinPhotoTexture,
      isTextureUrl: isTextureUrl,
      loadUrlTexture: loadUrlTexture,
      applyTextureRegion: applyTextureRegion,
      tryCreateWebGLRenderer: tryCreateWebGLRenderer,
      extractWorldTriangles: extractWorldTriangles,
      defaultLightDirection: defaultLightDirection,
      rasterFrame: rasterFrame,
      PARTICLE_BUILDERS: PARTICLE_BUILDERS,
      buildParticleSystem: buildParticleSystem,
      buildLineObject: buildLineObject,
      extractMeshPartsForExport: extractMeshPartsForExport,
      buildObjBlob: buildObjBlob,
      buildStlBlob: buildStlBlob,
      build3mfBlob: build3mfBlob
    }
  };
})(window);
