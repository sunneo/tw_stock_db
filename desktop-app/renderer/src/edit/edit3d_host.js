/* /edit-3d-model 的主機轉接層(接在 edit_host.js 後面,同一個 FaEditHost):3D 場景編輯器與「單一物件編輯」(貼皮)。
 * 場景用助理既有的 3D 零件建出來(_build3DMeshObject:跟 render_3d_scene 同一套形狀與材質),所以編輯器裡看到的跟匯出的場景、對話裡播放的一樣。
 * 位置「以使用者的相對視角」:編輯器把目前的相機(位置與看向的點)交給核心(env.view),核心算出我的前方／右邊再放東西(見 edit3d_core.js)。
 * 貼圖:貼進編輯器對話框的圖、網址、「找一張…的圖」→ 縮成 512 px 存在這個瀏覽器(FaEditStore)→ 場景裡只記 ref:… 短代號,匯出時才展開成 data URL。
 * 單一物件編輯是另一個小視窗(FaWin),有自己的復原重做與 AI 對話;按「完成」把結果交回場景的那個物件(場景的一步)。設計見 DESIGN.edit-3d.md。 */
(function () {
    'use strict';
    const H = FaEditHost, T = H.T;
    const ZONE_WORDS = (mesh, text) => (typeof FaEdit3dPart !== 'undefined' ? FaEdit3dPart.zoneIn(mesh, text) : null);
    const PLACE_WORDS = /(放|加|擺|貼|掛|放進|放到|新增)/;
    const FIND = /(找|搜尋|搜|尋找|find|search).*(圖|照片|picture|photo|image)/i;

    H.register('edit-3d', {
        fence: 'fa-edit-3d', icon: '🧊', cmd: '/edit-3d-model', prefix: 'sd', label: () => T('3D 場景編輯器', '3D scene editor'), core: () => FaEdit3d, ui: () => FaEdit3dUI,
        lead: '🧊 3D 場景編輯器：用說的擺東西，位置是以你現在看的角度算的（「我的左前方」「桌子的右邊」）。物件欄是樹狀的；雙擊物件進到「單一物件編輯」，像做塑膠模型一樣決定每個面貼什麼圖、塗什麼顏色。「🧾 YAML 原始碼」分頁可以直接改。每一步都能復原，進度會保留。',
        polishSystem: 'You tidy a prompt that rebuilds a 3D scene. Keep every fact (objects, sizes, colours, textures, and WHERE things are relative to the viewer or to other objects); make it one clear, reusable prompt. Answer with the prompt only.',
        prepare: async function () { await this._ensureThreeJsLoaded(); await this._ensureJsYamlLoaded(); },
        collectRefs: (proj) => { const out = []; try { (JSON.stringify([proj.spec, ((proj.state && proj.state.states) || []).map((x) => x.spec)]).match(/ref:[A-Za-z0-9_-]+/g) || []).forEach((r) => { const k = r.slice(4); if (out.indexOf(k) < 0) out.push(k); }); } catch (_) { /* */ } return out; },
        mountOpts: function (id, proj) { const self = this; return { buildNode: (n) => self._ed3dBuildNode(n), raster: (sc, cam, g, w, h) => self._raster3DFrame(sc, cam, g, w, h), keepTexture: (blob) => self._ed3dKeepTexture(blob), openPart: (o) => self._ed3dOpenPart(id, o), origin: !!(proj && proj.origin), updateOrigin: (yml) => self._ed3dUpdateOrigin(id, yml) }; },
        ask: function (req, ed) { return this._edAsk3d(req, ed); },
        help: (starters) => '**' + T('3D 場景編輯器', '3D scene editor') + '**\n\n' + T('像 /edit-svg 那樣用說的，不過是 3D：「在我的左前方放一個紅色的球」「把它移到桌子上面」「把桌子往右移 2 公尺」。位置是以**你現在看的角度**算的（相機的前方、左右）；拖曳畫面轉視角，位置就跟著變。物件欄是樹狀的（可以綁成群組），雙擊物件進到「單一物件編輯」（貼皮、上色，像做塑膠模型）；「🧾 YAML 原始碼」分頁可以直接改場景，回到畫面立刻呈現。圖可以貼進對話框當貼圖。匯出：場景 YAML（可直接播放）、PNG、專案 YAML；也可以把成品放進對話、或更新回原本的場景。', 'Talk to it like /edit-svg, but in 3D: "put a red ball in front-left of me", "move it onto the table". Places are worked out from the way YOU are looking now. The objects view is a tree; double click an object for the single-object (skin) editor; the YAML tab is editable.') + '\n\n' + T('起手式：', 'Starters:') + '\n' + starters.map((s) => '- `/edit-3d-model ' + s.id + '` — ' + s.label + '：' + s.desc).join('\n') + '\n\n' + T('接著上一個 3D 場景：`/edit-3d-model last`（把對話裡最近的 3D 場景當起點）。', 'Continue the last 3D scene of the conversation: `/edit-3d-model last`.'),
    });

    const M = H.methods;
    // ───── the scene: nodes are built by the assistant's own 3D builder ─────
    M._ed3dBuildNode = function (n) {
        const o = this._build3DMeshObject(n, {}); if (!o) return null;
        if (o.isParticleSystem) return o.object || null;
        return o;
    };
    // a picture for a texture: at most 512 px, kept once in the browser (FaEditStore); returns the short ref
    M._ed3dKeepTexture = async function (blob) {
        const P = this._edPics('edit-3d'); const d = await P.decode(blob, 512); const png = /png|gif/i.test(blob.type) && blob.size < 400000;
        const kept = await P.canvasBlob(d.canvas, png ? 'image/png' : 'image/jpeg', 0.86); return FaEditStore.putImage(kept);
    };
    M._ed3dPictureFromText = async function (text, status, notes) {
        const ps = FaPictureSource.make({ fetch: this._edFetchFn(), timeoutMs: 20000 }), A = this._edAi(), urls = ps.urls(text).slice(0, 1);
        if (urls.length) { status(T('下載圖片：', 'Downloading: ') + urls[0].slice(0, 60)); try { const got = await ps.load(urls[0]); return { blob: got.blob, name: urls[0].split('/').pop().split('?')[0].replace(/\.[a-z0-9]+$/i, '') || 'picture', credit: urls[0] }; } catch (e) { notes.push(T('抓不到 ', 'could not get ') + urls[0].slice(0, 50) + '：' + String((e && e.message) || e).slice(0, 80)); return null; } }
        if (FIND.test(text)) {
            let q = String(text).replace(/^(?:請|麻煩|幫我|可以)?\s*(?:上網|到網路上|在網路上)?\s*(?:幫我)?\s*(?:找|搜尋|搜|尋找|find|search(?: for)?)\s*(?:一|幾|兩)?\s*(?:張|些|個|a|an|some|the)?\s*/i, '').replace(/\s*(?:的)?\s*(?:圖片|圖|照片|相片|picture|photo|image)s?.*$/i, '').trim() || String(text).trim();
            if (/[一-鿿]/.test(q) && A.have()) { try { const en = (await A.chat('Give 1 to 3 English keywords for searching a photo of this on Wikimedia Commons. Answer with the keywords only, separated by spaces.', q, { maxTokens: 40, timeoutMs: 30000 })).replace(/[^A-Za-z0-9 \-]/g, ' ').replace(/\s+/g, ' ').trim(); if (en) q = en; } catch (_) { /* the words as they are */ } }
            status(T('上網找圖：', 'Searching: ') + q); const sr = await ps.search(q, { limit: 5 }); if (!sr.ok) { notes.push(sr.error); return null; }
            const top = sr.results[0]; try { const got = await ps.load(top); return { blob: got.blob, name: q, credit: top.title + (top.license ? ' — ' + top.license : '') + ' (' + top.source + ')' }; } catch (e) { notes.push(T('下載找到的圖失敗：', 'could not download it: ') + String((e && e.message) || e).slice(0, 80)); return null; }
        }
        return null;
    };
    // a picture goes where the user says: a face of the selected (or named) object, the whole object, or a new upright picture frame
    M._ed3dTextureEdits = async function (spec, blobInfo, text, selection, edits, notes) {
        const C = FaEdit3d, ref = await this._ed3dKeepTexture(blobInfo.blob), tex = 'ref:' + ref;
        let target = selection && C.find(spec, selection) >= 0 ? spec.objects[C.find(spec, selection)] : null;
        if (!target) { const m = spec.objects.filter((o) => o.type === 'mesh' && text.toLowerCase().indexOf(o.name.toLowerCase()) >= 0).sort((a, b) => b.name.length - a.name.length)[0]; if (m) target = m; }
        if (target && target.type === 'group') { target = null; }
        if (target && target.type === 'mesh') {
            const zone = ZONE_WORDS(target.mesh, text);
            if (zone && C.zonesOf(target.mesh).length) { edits.push({ op: 'add_skin', id: target.id, skin: { zone, image: tex, w: 1, h: 1, name: (C.ZONE_LABEL[zone] || zone) + '貼圖' } }); return T('把圖貼在「' + target.name + '」的' + (C.ZONE_LABEL[zone] || zone) + '。', 'Put the picture on a face of "' + target.name + '".'); }
            edits.push({ op: 'set_material', id: target.id, texture: tex, color: '#ffffff' }); return T('把圖貼在「' + target.name + '」上。', 'Put the picture on "' + target.name + '".');
        }
        const im = await createImageBitmap(blobInfo.blob), asp = im.width / Math.max(1, im.height), hgt = 2, wid = Math.round(hgt * asp * 100) / 100;
        edits.push({ op: 'add_object', object: { type: 'mesh', mesh: 'plane', name: blobInfo.name ? String(blobInfo.name).slice(0, 24) : '圖片', size: [wid, hgt], rotation_deg: [0, 0, 0], material: { color: '#ffffff', texture: tex, side: 'double', roughness: 0.9, metalness: 0 } }, place: { of: 'view', rel: 'center', dy: hgt / 2 } });
        return T('沒有選取物件，把圖做成一張立在畫面中間的圖片（想貼在物件上，先選一個物件再貼）。', 'Nothing is selected: made it an upright picture in the middle (select an object first to put it on).');
    };
    M._edAsk3d = async function (req, ed) {
        req = req || {}; const A = this._edAi(), C = FaEdit3d, spec = C.validate(req.spec).spec, notes = [], edits = [], text = String(req.text || '').trim(), status = typeof req.onStatus === 'function' ? req.onStatus : () => {}; let say = '', refText = '';
        const holder = this._edEditors && this._edEditors.get('edit-3d:' + ed.id), env = holder && holder._ed && holder._ed.env ? holder._ed.env() : { selection: req.selection };
        // 1) pictures pasted into the chat
        for (let i = 0; i < Math.min(3, (req.images || []).length); i++) {
            const im = req.images[i];
            try { const blob = await (await fetch(im.dataUrl)).blob(); const s = await this._ed3dTextureEdits(C.applyEdits(spec, edits, env).spec, { blob, name: (im.name || 'picture').replace(/\.[a-z0-9]+$/i, '') }, text, req.selection, edits, notes); say = say || s; }
            catch (e) { notes.push(T('「' + (im.name || '圖片') + '」處理失敗：', 'the picture failed: ') + String((e && e.message) || e).slice(0, 80)); }
        }
        // 2) an address or "find a picture of …" -> a texture
        if (!edits.length && (/https?:\/\//i.test(text) || FIND.test(text))) {
            const got = await this._ed3dPictureFromText(text, status, notes);
            if (got) { try { const s = await this._ed3dTextureEdits(spec, got, text, req.selection, edits, notes); say = say || s; if (got.credit && edits.length) { notes.push(T('出處：', 'Source: ') + String(got.credit).slice(0, 100)); } } catch (e) { notes.push(String((e && e.message) || e).slice(0, 80)); } }
        }
        if (edits.length) return { say, edits, notes };   // the picture was the request
        // 3) the language of the scene: the AI turns it into closed actions
        if (this._edIsOffline() && text) { const off = await this._edOfflineTry('edit-3d', text, C.applyEdits(spec, edits, env).spec, env, status); if (off && off.edits.length) return { say: off.say, edits: edits.concat(off.edits), notes: notes.concat(off.notes) }; }
        if (!A.have()) return { say: edits.length ? say : T('這句話程式沒有讀懂，而且目前沒有可用的 AI；可以用物件欄與屬性面板自己改，或說「在我的左前方放一個紅色的球」「把它移到桌子上面」這類程式讀得懂的句子。', 'The program did not understand this and there is no AI; use the objects view and the properties, or say things like "put a red ball in front-left of me".'), edits, notes };
        if (!text) return { say, edits, notes };
        status(T('想一想怎麼擺…', 'Working out the changes…'));
        const Pm = C.editPrompt(C.applyEdits(spec, edits, env).spec, text, refText, req.selection, env);
        try {
            const rep = await A.chat(Pm.system, Pm.user), pr = C.parseEditsReply(rep);
            if (pr.ok) {
                for (const e of pr.edits) {
                    if (e.op === 'find_picture' || e.op === 'generate_image') {
                        const tgt = e.id || req.selection || ''; let blobInfo = null;
                        if (e.op === 'find_picture') { blobInfo = await this._ed3dPictureFromText(T('找一張 ', 'find a picture of ') + String(e.query || '') + T('的圖', ''), status, notes); }
                        else { const g = await this._edGenerate({ prompt: String(e.prompt || '') }, status); if (g.ok) blobInfo = { blob: g.image.blob, name: String(e.prompt || 'AI').slice(0, 24) }; else notes.push(g.needs_download ? T('本機生圖模型還沒下載：先輸入 /image download', 'The local image model is not downloaded: type /image download first') : g.error); }
                        if (blobInfo) { const s = await this._ed3dTextureEdits(C.applyEdits(spec, edits, env).spec, blobInfo, [text, e.zone ? String(e.zone) : ''].join(' '), tgt, edits, notes); say = say || s; }
                    } else edits.push(e);
                }
                if (pr.say) say = say ? say + '；' + pr.say : pr.say; if (pr.dropped) notes.push(T('有 ' + pr.dropped + ' 個動作不在可做的清單裡，已略過', pr.dropped + ' actions were not in the allowed list and were skipped'));
            } else if (!edits.length) say = T('AI 的回覆我讀不懂（要是 JSON 動作）。換個說法再試一次。', 'I could not read the AI\'s answer (it has to be JSON actions). Say it differently.');
        } catch (e5) { if (!edits.length) say = T('AI 這次沒有回應（', 'The AI did not answer (') + String((e5 && e5.message) || e5).slice(0, 80) + '）。'; }
        return { say, edits, notes };
    };

    // ───── the single-object editor (skins), in its own window ─────
    M._edAskPart = async function (req, ed) {
        req = req || {}; const A = this._edAi(), PC = FaEdit3dPart, spec = PC.validate(req.spec).spec, notes = [], edits = [], text = String(req.text || '').trim(), status = typeof req.onStatus === 'function' ? req.onStatus : () => {}; let say = '', lastRef = null;
        const zoneOf = () => ZONE_WORDS(spec.base.mesh, text) || (req.selection && PC.find(spec, req.selection) >= 0 ? spec.objects[PC.find(spec, req.selection)].zone : null);
        const addPic = async (blobInfo) => { const ref = await this._ed3dKeepTexture(blobInfo.blob); lastRef = 'ref:' + ref; const z = zoneOf(); const at = /(左上|右上|左下|右下|正中|中間|中央|偏上|偏下|偏左|偏右)/.exec(text); edits.push({ op: 'add_object', object: { type: 'skin', zone: z || undefined, image: lastRef, w: at ? 0.5 : 1, h: at ? 0.5 : 1, name: blobInfo.name ? String(blobInfo.name).slice(0, 24) : undefined }, place: at ? { at: ({ '左上': 'top-left', '右上': 'top-right', '左下': 'bottom-left', '右下': 'bottom-right', '正中': 'center', '中間': 'center', '中央': 'center', '偏上': 'top', '偏下': 'bottom', '偏左': 'left', '偏右': 'right' })[at[1]] } : undefined }); };
        for (let i = 0; i < Math.min(3, (req.images || []).length); i++) { const im = req.images[i]; try { await addPic({ blob: await (await fetch(im.dataUrl)).blob(), name: (im.name || 'picture').replace(/\.[a-z0-9]+$/i, '') }); say = say || T('把圖貼上去了。', 'Put the picture on.'); } catch (e) { notes.push(T('「' + (im.name || '圖片') + '」處理失敗：', 'the picture failed: ') + String((e && e.message) || e).slice(0, 80)); } }
        if (!edits.length && (/https?:\/\//i.test(text) || FIND.test(text))) { const got = await this._ed3dPictureFromText(text, status, notes); if (got) { try { await addPic(got); say = say || T('把圖貼上去了。', 'Put the picture on.'); } catch (e) { notes.push(String((e && e.message) || e).slice(0, 80)); } } }
        if (edits.length) return { say, edits, notes };
        if (!A.have()) return { say: T('這句話程式沒有讀懂，而且目前沒有可用的 AI；可以說「把正面塗成紅色」「底色改成白色」這類程式讀得懂的句子，或用屬性面板。', 'The program did not understand this and there is no AI; say things like "paint the front red", or use the properties.'), edits, notes };
        if (!text) return { say, edits, notes };
        status(T('想一想怎麼貼…', 'Working out the skins…'));
        const Pm = PC.editPrompt(spec, text, '', req.selection);
        try {
            const rep = await A.chat(Pm.system, Pm.user), pr = PC.parseEditsReply(rep);
            if (pr.ok) {
                for (const e of pr.edits) {
                    if (e.op === 'find_picture' || e.op === 'generate_image') { let bi = null; if (e.op === 'find_picture') bi = await this._ed3dPictureFromText(T('找一張 ', 'find a picture of ') + String(e.query || '') + T('的圖', ''), status, notes); else { const g = await this._edGenerate({ prompt: String(e.prompt || '') }, status); if (g.ok) bi = { blob: g.image.blob, name: String(e.prompt || 'AI').slice(0, 24) }; else notes.push(g.error); } if (bi) await addPic(bi); }
                    else { if (e.op === 'add_object' && e.object && e.object.image === 'attached') { if (lastRef) e.object.image = lastRef; else { notes.push(T('要貼的圖沒有附上來', 'there is no attached picture')); continue; } } if (e.op === 'update_object' && e.props && e.props.image === 'attached') { if (lastRef) e.props.image = lastRef; else { notes.push(T('要貼的圖沒有附上來', 'there is no attached picture')); continue; } } edits.push(e); }
                }
                if (pr.say) say = say ? say + '；' + pr.say : pr.say; if (pr.dropped) notes.push(T('有 ' + pr.dropped + ' 個動作不在可做的清單裡，已略過', pr.dropped + ' actions were not in the allowed list and were skipped'));
            } else say = T('AI 的回覆我讀不懂（要是 JSON 動作）。換個說法再試一次。', 'I could not read the AI\'s answer (it has to be JSON actions). Say it differently.');
        } catch (e5) { say = T('AI 這次沒有回應（', 'The AI did not answer (') + String((e5 && e5.message) || e5).slice(0, 80) + '）。'; }
        return { say, edits, notes };
    };
    const sigOf = (o) => JSON.stringify([o.skins || [], o.material || {}]);
    M._ed3dOpenPart = async function (sceneId, obj) {
        const C = FaEdit3d, PC = FaEdit3dPart, pid = sceneId + '__' + obj.id; this._edParts = this._edParts || new Map();
        if (this._edParts.has(pid)) { const w = this._edParts.get(pid); try { if (w.node._win && w.node._win.pop) w.node._win.pop(); w.node.scrollIntoView && w.node.scrollIntoView(); } catch (_) { /* */ } return; }
        const holder = this._edEditors && this._edEditors.get('edit-3d:' + sceneId); if (!holder || !holder._ed) throw new Error(T('找不到場景編輯器', 'the scene editor is not here'));
        const cur = holder._ed.getSpec(), o = cur.objects[C.byId(cur, obj.id)]; if (!o || o.type !== 'mesh') return;
        let proj = null; try { proj = await FaEditStore.loadProject('edit-3d-part', pid); } catch (_) { /* fresh */ }
        const sig = sigOf(o); let spec, state = null;
        if (proj && !proj.discard && proj.sig === sig && proj.spec) { spec = PC.validate(proj.spec).spec; state = proj.state || null; } else { spec = PC.fromObject(o, o.name + ' 的貼皮'); }
        const refs = (JSON.stringify([spec, state]).match(/ref:[A-Za-z0-9_-]+/g) || []).map((r) => r.slice(4)); await FaEditStore.preload(refs);
        await this._ensureThreeJsLoaded();
        const self = this; let node = null, curSig = sig; const wrapper = document.createElement('div'); wrapper.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden';
        const close = () => { try { if (node._ed) node._ed.destroy(); } catch (_) { /* */ } try { node.remove(); } catch (_) { /* */ } try { wrapper.remove(); } catch (_) { /* */ } self._edParts.delete(pid); };
        const ai = this._edAi();
        const host = {
            palette: () => ({ dark: !self._isLightTheme() }),
            ask: (rq) => self._edQuietRun((line) => { try { if (rq && typeof rq.onStatus === 'function') rq.onStatus(line); } catch (_) { /* */ } }, () => self._edAskPart(rq, { id: pid })),
            save: (st) => { try { const sp = st.states[st.ptr].spec; return FaEditStore.saveProject('edit-3d-part', pid, { v: 1, spec: sp, state: st, sig: curSig }); } catch (_) { return null; } },
            download: (blob, name, mime) => self.generateAndDeliverFile(blob, name, mime || blob.type),
            toChat: (blob, name, info) => self._edToChat('edit-3d', blob, name, info),
            polish: (self.advancedSettings && self.advancedSettings.offlineMode) ? undefined : (async (text) => String(await ai.chat('You tidy a prompt that rebuilds the skins (which picture or colour goes on which face, and where) of one 3D object. Keep every fact; answer with the prompt only.', text, { maxTokens: 900, timeoutMs: 90000 })).trim()),
        };
        node = FaEdit3dUI.mountPart({
            id: pid, state, spec, host, store: FaEditStore, buildNode: (n) => self._ed3dBuildNode(n), raster: (sc, cam, g, w, h) => self._raster3DFrame(sc, cam, g, w, h), keepTexture: (blob) => self._ed3dKeepTexture(blob),
            onDone: (partSpec) => {
                const live = self._edEditors && self._edEditors.get('edit-3d:' + sceneId); if (!live || !live._ed) { try { node._ed.ctx.say(T('找不到場景編輯器，沒有交回去', 'the scene editor is gone')); } catch (_) { /* */ } return; }
                const patch = PC.toObjectPatch(partSpec), r = live._ed.ctx.apply([{ op: 'set_skins', id: obj.id, skins: patch.skins, material: patch.material }], '編輯「' + o.name + '」的貼皮', '', 'panel');
                if (r && r.rejected && r.rejected.length) { try { node._ed.ctx.say(r.rejected[0].error); } catch (_) { /* */ } return; }
                const after = live._ed.getSpec(), o2 = after.objects[C.byId(after, obj.id)]; curSig = o2 ? sigOf(o2) : sig; try { FaEditStore.saveProject('edit-3d-part', pid, { v: 1, spec: partSpec, state: node._ed.getState(), sig: curSig }); } catch (_) { /* */ }
                close();
            },
            onCancel: () => { try { FaEditStore.saveProject('edit-3d-part', pid, { v: 1, discard: true }); } catch (_) { /* */ } close(); },
        });
        document.body.appendChild(wrapper); wrapper.appendChild(node); this._edParts.set(pid, { node });
        try { FaEditI18n.localize(node); } catch (_) { /* */ }
        requestAnimationFrame(() => { try { if (node._win && node._win.pop) node._win.pop(); } catch (_) { /* */ } });
    };

    // ───── the way in: a scene already in the conversation, a model file, a YAML ─────
    M._ed3dLastScene = function () { for (let i = this.messages.length - 1; i >= 0; i--) { const m = this.messages[i]; if (m && m._displayScene3DYaml) return { yaml: m._displayScene3DYaml, index: i }; } return null; };
    M._ed3dFromYaml = async function (yaml, notes) {
        await this._ensureJsYamlLoaded(); const r = FaEdit3d.fromYaml(yaml); if (!r.ok) throw new Error(r.error); (r.problems || []).slice(0, 3).forEach((p) => notes.push(p)); return r.spec;
    };
    // everything above, and the common ways: yaml (text), file_id (a .3dscene.yaml or a model: STL / OBJ / 3MF / FBX), last (the latest scene of the conversation)
    M._ed3dOpen = async function (a) {
        a = a || {}; const notes = []; let spec = null, origin = null;
        try {
            if (a.yaml) { spec = await this._ed3dFromYaml(String(a.yaml), notes); if (a.originIndex != null && a.originIndex >= 0) origin = { index: a.originIndex }; }
            else if (a.file_id) {
                const rec = await this.fileCache.get(String(a.file_id)); if (!rec) return { ok: false, error: T('找不到這個檔案：', 'no such file: ') + a.file_id };
                const name = String(rec.filename || ''); if (/\.ya?ml$/i.test(name)) spec = await this._ed3dFromYaml(await rec.blob.text(), notes);
                else { const conv = await this._convertModelFileToSceneYaml(rec, (stage) => { try { this._setResponseIndicatorLabel('⏳ ' + this._3dImportStageLabel(stage)); } catch (_) { /* */ } }); if (!conv.ok) return conv; spec = await this._ed3dFromYaml(conv.yaml, notes); spec.title = name.replace(/\.[a-z0-9]+$/i, '') || spec.title; notes.push(T('匯入的模型只有形狀與單一顏色（沒有原始貼圖與動畫）', 'the imported model keeps its shape and one colour (no textures or animation)')); }
            } else if (a.last) { const ls = this._ed3dLastScene(); if (!ls) return { ok: false, error: T('對話裡還沒有 3D 場景', 'there is no 3D scene in the conversation yet') }; spec = await this._ed3dFromYaml(ls.yaml, notes); origin = { index: ls.index }; }
        } catch (e) { return { ok: false, error: T('讀不進這個場景：', 'could not read the scene: ') + String((e && e.message) || e) }; }
        const r = await this._edOpen('edit-3d', { starter: spec ? undefined : a.starter, spec: spec || undefined, request: a.request, id: a.id, images: a.images, origin: origin || undefined });
        if (r && r.ok) r.notes = notes; return r;
    };
    // ───── /image-to-3d: a picture -> offline depth model -> one CLOSED solid per object (never a relief), opened in the 3D editor ─────
    // pixels of the picture, shrunk so the longest side is `longest`: { width, height, data: RGBA }
    M._i3dPixels = async function (blob, longest, force) {
        const bmp = await createImageBitmap(blob); const k = Math.min(1, longest / Math.max(bmp.width, bmp.height)), w = force ? force.width : Math.max(2, Math.round(bmp.width * k)), h = force ? force.height : Math.max(2, Math.round(bmp.height * k));
        const cv = document.createElement('canvas'); cv.width = w; cv.height = h; const cx = cv.getContext('2d', { willReadFrequently: true }); cx.drawImage(bmp, 0, 0, w, h); try { bmp.close(); } catch (_) { /* */ }
        const d = cx.getImageData(0, 0, w, h); return { width: w, height: h, data: d.data };
    };
    // the original picture as a JPEG data: URL (longest side 1024) to paste on the model as its texture
    M._i3dTexture = async function (blob) {
        const bmp = await createImageBitmap(blob); const k = Math.min(1, 1024 / Math.max(bmp.width, bmp.height)), w = Math.max(2, Math.round(bmp.width * k)), h = Math.max(2, Math.round(bmp.height * k));
        const cv = document.createElement('canvas'); cv.width = w; cv.height = h; cv.getContext('2d').drawImage(bmp, 0, 0, w, h); try { bmp.close(); } catch (_) { /* */ }
        return cv.toDataURL('image/jpeg', 0.85);
    };
    // p: { image?|blob?, request? (the user's words: "要能列印", "用樂高方塊"…), close?: 'objects'|'all', shape?: 'auto'|'cylinder'|'blocks', whole?: bool, model?, device? }
    M._imageTo3d = async function (p) {
        p = p || {}; const o = FaImage3d.parseOptions(p.request || '');
        const close = p.close === 'all' || p.close === 'objects' ? p.close : o.close, shape = ['auto', 'smooth', 'cylinder', 'blocks'].includes(p.shape) ? p.shape : o.shape, whole = p.whole != null ? !!p.whole : o.whole;
        const img = await this._vlmResolveImage(p); if (!img.blob) return { ok: false, cancelled: img.cancelled, error: img.error };
        let px; try { px = await this._i3dPixels(img.blob, 160); } catch (e) { return { ok: false, error: T('讀不了這張圖片：', 'could not read the picture: ') + String((e && e.message) || e) }; }
        const dr = await this._depthEstimate({ blob: img.blob, filename: img.filename, model: p.model, device: p.device }); if (!dr.ok) return dr;
        const t0 = Date.now(); let mask = null, fg = null, segs = null, segNote = '';
        const wantSeg = p.segment != null ? !!p.segment : o.segment;
        let bgNote = '';
        if (!whole && p.bg) { // 背景差分：另一張「沒有主體的背景圖」逐像素比對（同一個視角）
            const bi = await this._vlmResolveImage({ image: p.bg });
            if (bi.blob) { let bpx = null; try { bpx = await this._i3dPixels(bi.blob, 160, px); } catch (_) { /* */ } const dm = bpx ? FaImage3d.diffMask(px, bpx, {}) : null; if (dm && dm.fg >= 0.02 && dm.fg <= 0.95) { mask = { w: px.width, h: px.height, data: dm.mask }; fg = dm.fg; bgNote = T('用背景差分取出前景', 'foreground taken by background subtraction'); } else bgNote = T('背景差分沒有取出合理的前景（差異太少或太多，兩張圖要是同一個視角），改用其他方式', 'background subtraction found no sensible foreground (the two pictures must share one viewpoint); used another way'); }
            else bgNote = T('找不到背景圖：', 'background picture not found: ') + (bi.error || '');
        }
        if (!whole && !mask && wantSeg) { // 分割模型自動分物件；失敗不擋住，退回去背遮罩
            const sr = await this._segmentObjects({ blob: img.blob, filename: img.filename, device: p.device });
            if (sr.ok && sr.segments && sr.segments.length) segs = sr.segments; else if (sr.cancelled) return sr; else segNote = T('分割模型沒成功（' + (sr.error || '') + '），改用去背遮罩', 'segmentation failed (' + (sr.error || '') + '), used the background cut-out instead');
        }
        if (!whole && !segs && !mask) { const bm = FaSubject3d.bgMask(px, 42); fg = bm.fg; if (bm.fg >= 0.02 && bm.fg <= 0.95) mask = { w: px.width, h: px.height, data: bm.mask }; }
        const prep = FaImage3d.prepareInput(dr.depth, mask, { mode: (mask || segs) ? 'components' : 'whole', workMax: 96, segments: segs });
        const scene = FaImage3d.buildScene({ labels: prep.labels, depth: prep.depth }, { shape, closeMode: close, maxFaces: 12000 });
        if (!mask && !segs) scene.background = null; // the whole picture is the one object: a backdrop behind it would only be a copy
        if (!scene.objects.length) return { ok: false, error: T('沒有找到可以做成立體的物件', 'no object to build') };
        const sums = {}; for (let y = 0; y < px.height; y++) for (let x = 0; x < px.width; x++) {
            const id = prep.labels[Math.min(prep.height - 1, Math.floor(y * prep.height / px.height))][Math.min(prep.width - 1, Math.floor(x * prep.width / px.width))] || 'background', k = (y * px.width + x) * 4, s = sums[id] || (sums[id] = [0, 0, 0, 0]);
            s[0] += px.data[k]; s[1] += px.data[k + 1]; s[2] += px.data[k + 2]; s[3]++;
        }
        const colors = {}, hex = (n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0'); for (const id in sums) { const s = sums[id]; colors[id] = '#' + hex(s[0] / s[3]) + hex(s[1] / s[3]) + hex(s[2] / s[3]); }
        const title = T('圖片轉3D：', 'Image to 3D: ') + String(img.filename || '').replace(/\.[a-z0-9]+$/i, '').slice(0, 30);
        let texture = ''; if (p.texture !== false) { try { texture = await this._i3dTexture(img.blob); } catch (_) { texture = ''; } }
        const raw = FaImage3d.toSpec(scene, { colors, title, texture }); const v = FaEdit3d.validate(raw); if (!v.ok) return { ok: false, error: T('做出來的場景不合規格：', 'the scene is invalid: ') + (v.problems || []).slice(0, 3).join('；') };
        const r = await this._edOpen('edit-3d', { spec: v.spec });
        const parts = scene.objects.concat(scene.background ? [scene.background] : []);
        const out = { ok: !(r && r.ok === false), error: r && r.ok === false ? r.error : undefined, objects: scene.objects.length, shapes: scene.objects.map((x) => x.shape), faces: parts.reduce((a, x) => a + x.mesh.faces.length, 0), close, all_closed: parts.every((x) => FaImage3d.isClosed(x.mesh)), fell_back: parts.filter((x) => x.fallback).length, dropped_blobs: prep.dropped, foreground_ratio: fg == null ? undefined : Math.round(fg * 1000) / 1000, depth_model: dr.model, device: dr.device, ms: Date.now() - t0 + (dr.ms || 0), notes: [T('每個物件都是封閉的立體，不是浮雕；單張圖看不到背面，背面是依輪廓寬度推測的厚度', 'every object is a closed solid, not a relief; one picture cannot show the back, so its depth is a guess from the outline width')].concat(texture ? [T('原圖已貼在模型上（從正面投影，側面與背面是邊緣顏色拉伸）', 'the picture is pasted on as the texture (projected from the front; sides and back show stretched edge colours)')] : []).concat(prep.empty ? [T('沒有找到前景（背景色抓不準），整張圖當成一個物件', 'no foreground found: the whole picture became one object')] : [], mask || segs ? [] : [T('整張圖當成一個物件', 'the whole picture is one object')], segs ? [T('物件由分割模型找出來', 'objects found by the segmentation model')] : [], segNote ? [segNote] : [], bgNote ? [bgNote] : []) };
        return out;
    };
    // 全景／轉圈照片：決定要不要走全景。ids: [{id, filename}]；flag: 使用者說了 --panorama／全景。回傳 { pano:true, items:[{id,filename,blob}], fovDeg, note } 或 { pano:false, note? }
    M._i3dPanoPlan = async function (ids, flag) {
        const items = []; for (const x of ids) { let rec = null; try { rec = await this.fileCache.get(x.id); } catch (_) { /* */ } if (rec && rec.blob) items.push({ id: x.id, filename: x.filename, blob: rec.blob }); }
        if (!items.length) return { pano: false };
        if (items.length === 1) {
            let bmp = null; try { bmp = await createImageBitmap(items[0].blob); } catch (_) { return { pano: false }; }
            const aspect = bmp.width / bmp.height; try { bmp.close(); } catch (_) { /* */ }
            if (flag || aspect >= 2) return { pano: true, items, fovDeg: FaImage3d.panoFov(aspect), note: T('單張寬圖（寬高比 ' + aspect.toFixed(1) + '）當全景處理', 'a single wide picture (aspect ' + aspect.toFixed(1) + ') treated as a panorama') };
            return { pano: false };
        }
        const shots = []; for (const it of items) { let ex = null; try { ex = FaImage3d.readExif(await it.blob.slice(0, 131072).arrayBuffer()); } catch (_) { ex = null; } shots.push(ex || {}); }
        const ok = FaImage3d.orbitKind(shots, {});
        if (ok.kind === 'outward') { const ordered = ok.order.map((i) => items[i]); return { pano: true, items: ordered, fovDeg: ok.coverDeg >= 300 ? 360 : Math.min(360, ok.coverDeg + 65), note: T('照片的位置幾乎不動、方向轉了 ' + ok.coverDeg + ' 度：依方向排序拼成一條橫幅', 'photos from one spot turning ' + ok.coverDeg + ' degrees: sorted by heading into one strip') }; }
        if (ok.kind === 'inward') return { pano: false, note: T('這些照片是繞著物體拍的（位置轉了約 ' + ok.spreadM + ' 公尺）；繞物體重建需要多視角重建模型，目前做不到，這次只用第一張', 'these photos circle an object (about ' + ok.spreadM + ' m); that needs multi-view reconstruction which is not available, so only the first picture is used') };
        if (flag) return { pano: true, items, fovDeg: Math.min(360, items.length * 65), note: T('照片沒有方向資料，照你給的順序從左到右拼起來', 'no heading data in the photos: laid out left to right in the order given') };
        return { pano: false };
    };
    // 全景：每張各估深度（各自正規化，所以遠近只是近似）→ 橫向拼成一條 → 依深度切遠／中／近三層，各自封閉後彎到圓柱上；相機放在圓心往外看
    M._imageToPanorama = async function (p) {
        const items = p.items, depths = [];
        for (const it of items) { const dr = await this._depthEstimate({ blob: it.blob, filename: it.filename, model: p.model, device: p.device }); if (!dr.ok) return dr; depths.push(dr.depth); }
        const strip = FaImage3d.stitchDepths(depths, {}), fovDeg = p.fovDeg || FaImage3d.panoFov(strip.w / strip.h);
        let texture = ''; try {
            const H = 512, bmps = []; for (const it of items) bmps.push(await createImageBitmap(it.blob));
            const ws = bmps.map((b) => Math.round(b.width * H / b.height)), W = Math.min(4096, ws.reduce((a, b) => a + b, 0)), k = W / ws.reduce((a, b) => a + b, 0);
            const cv = document.createElement('canvas'); cv.width = W; cv.height = H; const cx = cv.getContext('2d'); let x0 = 0; bmps.forEach((b, i) => { cx.drawImage(b, x0 * k, 0, ws[i] * k, H); x0 += ws[i]; try { b.close(); } catch (_) { /* */ } });
            texture = cv.toDataURL('image/jpeg', 0.85);
        } catch (_) { texture = ''; }
        const sc = FaImage3d.buildPanorama(strip, { fovDeg, bands: 3, radius: 5 });
        const title = T('全景轉3D：', 'Panorama to 3D: ') + String(items[0].filename || '').replace(/\.[a-z0-9]+$/i, '').slice(0, 30);
        const raw = FaImage3d.toSpec(sc, { title, texture }); const v = FaEdit3d.validate(raw); if (!v.ok) return { ok: false, error: T('做出來的場景不合規格：', 'the scene is invalid: ') + (v.problems || []).slice(0, 3).join('；') };
        const r = await this._edOpen('edit-3d', { spec: v.spec });
        return { ok: !(r && r.ok === false), error: r && r.ok === false ? r.error : undefined, panorama: true, layers: sc.objects.map((o) => o.name), faces: sc.objects.reduce((a, o) => a + o.mesh.faces.length, 0), all_closed: sc.objects.every((o) => FaImage3d.isClosed(o.mesh)), fov_deg: fovDeg, photos: items.length, note: p.note || '',
            notes: [T('每張照片各自估深度、各自縮放到 0～1，所以遠近只是近似', 'each photo has its own depth scale, so near/far is approximate'), T('分成遠景／中景／近景三層，各自是封閉的立體，彎在圓柱上，相機在圓心往外看', 'three layers (far/middle/near), each a closed solid bent around a cylinder; the camera sits at the centre looking out'), T('可以匯出 glTF 給 VR 用；在頭戴裝置裡的觀看效果還沒驗證', 'can be exported as glTF for VR; how it looks in a headset is not verified')] };
    };
    // /image-to-3d [--close objects|all] [--shape auto|smooth|cylinder|blocks] [--whole] [說明]：先貼圖再打、或先打指令再貼圖送出都可以
    M._image3dCommand = async function (argsText) {
        argsText = String(argsText || ''); const ids = []; const mark = /\[附件：([^\]]*)\]/.exec(argsText);
        if (mark) { const re = /([^、（]+?)（file_id=([\w-]+)）/g; let x; while ((x = re.exec(mark[1]))) { let rec = null; try { rec = await this.fileCache.get(x[2]); } catch (_) { /* */ } if (rec && rec.blob && (/^image\//i.test(rec.blob.type || '') || /\.(png|jpe?g|gif|webp|bmp)$/i.test(x[1]))) ids.push({ id: x[2], filename: x[1].trim(), size: rec.blob.size }); } }
        const rest = argsText.replace(/\[附件：[^\]]*\]/g, ' ').trim() || this._i3dCmdArgs || ''; if (ids.length) this._i3dCmdArgs = '';
        if (!ids.length) { this._armedSkill = { name: 'image-to-3d', at: Date.now() }; this._i3dCmdArgs = argsText.replace(/\[附件：[^\]]*\]/g, ' ').trim(); this._pushAssistantMessage('🧊 請貼上要轉成 3D 的圖片（Ctrl+V）或用📎上傳，送出後我會直接處理（深度模型離線執行，圖片不會上傳；每個物件都會做成封閉的立體，不是浮雕）。', null); this._persistChatHistory(); this._renderMessageHistory(); return; }
        const o2 = FaImage3d.parseOptions(rest); let panoNote = '';
        if (!(ids.length === 2 && /背景差分|差分|--bg|--diff|第二張.{0,6}背景|背景圖/i.test(rest))) {
            const plan = await this._i3dPanoPlan(ids, o2.panorama);
            if (plan.pano) {
                const pr = await this._imageToPanorama({ items: plan.items, fovDeg: plan.fovDeg, note: plan.note });
                this._pushAssistantMessage(pr.ok ? '🌐 已經放進 3D 編輯器：' + pr.photos + ' 張照片拼成全景（視野約 ' + pr.fov_deg + ' 度），分成 ' + pr.layers.join('、') + ' ' + pr.layers.length + ' 層，共 ' + pr.faces + ' 個面' + (pr.all_closed ? '（每層都通過封閉檢查）' : '（有層沒通過封閉檢查）') + '。' + pr.note + '。' + pr.notes.join('；') + '。' : '🌐 ' + (pr.error || '全景轉 3D 失敗'), null);
                this._persistChatHistory(); this._renderMessageHistory(); return;
            }
            panoNote = plan.note || '';
        }
        let pick = ids[0], bgId; if (ids.length === 2 && /背景差分|差分|--bg|--diff|第二張.{0,6}背景|背景圖/i.test(rest)) bgId = ids[1].id; else if (ids.length > 1 && !panoNote) { pick = await this._pickAttachmentInteractive(ids, '要轉哪一張圖？', '附了好幾張圖，請選一張。'); if (!pick) return; }
        const r = await this._imageTo3d({ image: pick.id, request: rest, bg: bgId });
        this._pushAssistantMessage(r.ok ? '🧊 已經放進 3D 編輯器：' + r.objects + ' 個物件各自封閉' + (r.all_closed ? '（全部通過封閉檢查）' : '（有物件沒通過封閉檢查，已退回較粗的殼）') + '，共 ' + r.faces + ' 個面；封閉範圍：' + (r.close === 'all' ? '全部（背景也是實心）' : '物件（背景是薄板）') + '。' + r.notes.join('；') + '。' + (panoNote ? panoNote + '。' : '') : '🧊 ' + (r.cancelled ? '已取消' : '失敗：' + r.error), null);
        this._persistChatHistory(); this._renderMessageHistory();
    };
    M._registerEdit3dCommands = function () {
        const hint = '[起手式｜last｜一句話描述]';
        const run = async (argsText, run0) => {
            const r = run0 || this, a = String(argsText || '').trim();
            if (/^(last|最近|上一個|剛剛的)$/i.test(a)) { r.messages.push({ role: 'user', content: '/edit-3d-model ' + a }); const res = await r._ed3dOpen({ last: true }); if (res && res.ok === false) r._pushAssistantMessage('⚠️ ' + (res.error || T('開不起來', 'could not open it')), null); try { r._persistChatHistory(); r._renderMessageHistory(); } catch (_) { /* */ } return; }
            return r._edCommand('edit-3d', argsText, run0);
        };
        this.register_slash_command('/edit-3d-model', hint,
            '3D 場景編輯器（用語言主導，位置完全以你現在看的角度算）：「在我的左前方放一個紅色的球」「把它移到桌子上面」；物件欄是樹狀的、屬性面板、雙擊物件進「單一物件編輯」（像做塑膠模型：每個面貼什麼圖、塗什麼顏色）、🧾 YAML 原始碼分頁可以直接改、圖可以貼進對話框當貼圖、復原／重做、整理成 prompt、匯出場景 YAML／PNG。/edit-3d-model room 從起手式開始、/edit-3d-model last 接著對話裡最近的 3D 場景。',
            run);
        this.register_slash_command('/image-to-3d', '[--close objects|all] [--shape auto|smooth|cylinder|blocks] [--whole] [--segment] [--panorama] [--bg 背景圖]',
            '圖片轉 3D（離線）：深度模型在這台電腦上估計深度，再把每個物件各自做成封閉的立體（不是浮雕：用物件自己的輪廓做柱體或樂高方塊的殼，再逐層細切），放進 3D 場景編輯器。--close all＝連背景都做成實心（要列印用）；--shape 選殼的種類；--whole＝整張圖當一個物件；--segment＝用分割模型（SlimSAM）自動分出多個物件，不加則用去背遮罩；貼兩張圖並說「背景差分」＝第二張是沒有主體的背景圖（同一個視角），逐像素比對取出主體。先貼圖再打指令、或先打指令再貼圖送出都可以；第一次使用要下載深度模型（會先問）。單張圖看不到背面，背面是推測的。',
            async (argsText, run0) => { await (run0 || this)._image3dCommand(argsText); });
        { const ie = this.slashCommands.get('/image-to-3d'); if (ie) ie._autoFromSkillBundle = true; }
        this.register_slash_command('/edit-3d', hint, '3D 場景編輯器：/edit-3d-model 的別名。', (argsText, run0) => (this.slashCommands.get('/edit-3d-model') || { handler: run }).handler(argsText, run0));
    };
    M._registerEdit3dTools = function (registerOptional) {
        const parse = async (self, raw) => { let a = {}; try { a = await self.repairJsonPayload(String(raw || '{}')); } catch (_) { /* */ } return a || {}; };
        registerOptional('image_to_3d',
            '圖片轉 3D（離線、不是浮雕）：用跑在這台電腦上的深度模型（Depth Anything V2 Small）估計深度，把圖裡每個物件各自做成封閉的立體（用物件自己的輪廓做柱體或樂高方塊的殼，再逐層細切；每個物件都通過封閉檢查），背景另成一塊，全部放進 3D 場景編輯器。圖片不會上傳；第一次使用要下載深度模型。單張圖看不到背面，背面是依輪廓推測的。close=all 連背景都做成實心（要列印時用），預設 objects。',
            async function (rawArgs) { const a = await parse(this, rawArgs); try { return JSON.stringify(await this._imageTo3d({ image: a.image, request: a.request, close: a.close, shape: a.shape, whole: a.whole, segment: a.segment, bg: a.bg })); } catch (err) { return JSON.stringify({ ok: false, error: String((err && err.message) || err) }); } },
            { type: 'object', properties: { image: { type: 'string', description: '選填：圖片的 file_id 或檔名；省略時用這個對話最新的圖片附件' }, request: { type: 'string', description: '使用者的原話（例如「物件要封閉」「要能列印」「用樂高方塊」），程式會從裡面解析封閉範圍與外殼種類' }, close: { type: 'string', enum: ['objects', 'all'], description: 'objects＝每個物件封閉、背景是薄板（預設）；all＝連背景都做成實心' }, shape: { type: 'string', enum: ['auto', 'smooth', 'cylinder', 'blocks'] }, whole: { type: 'boolean', description: 'true＝整張圖當一個物件，不分前景背景' }, bg: { type: 'string', description: '選填：沒有主體的背景圖（file_id 或檔名，要跟主體圖同一個視角），用背景差分取出前景' }, segment: { type: 'boolean', description: 'true＝用分割模型自動分出多個物件（要下載 SlimSAM）；預設用去背遮罩' } } }
        );
        registerOptional('edit_3d_open',
            '在對話裡放一個「3D 場景編輯器」（用語言主導；位置完全以使用者現在看的角度算：「我的左前方」「桌子的右邊」）：物件欄（樹狀、群組）、屬性面板、3D 畫面（拖曳轉視角、點物件選取、拖曳移動）、🧾 YAML 原始碼分頁（可直接改）、雙擊物件進「單一物件編輯」（像做塑膠模型：每個面貼什麼圖、塗什麼顏色）、貼圖（貼進編輯器對話框、網址、找圖）、復原／重做、匯出場景 YAML（render_3d_scene 可直接播放）／PNG／整理成 prompt。參數：starter（blank、room、model、studio）、request（一句話：開起來後編輯器自己的 AI 去做）、yaml（一份場景 YAML 當起點）、file_id（使用者上傳的 .3dscene.yaml 或 STL／OBJ／3MF／FBX 模型）、last（true＝接著對話裡最近的 3D 場景）、id（接著原本的專案）。做完編輯器就在對話裡，不要把場景 YAML 貼進對話。參數: {"starter":"room","request":"（選填）","yaml":"（選填）","file_id":"（選填）","last":false,"id":"（選填）"}',
            async function (rawArgs) { const a = await parse(this, rawArgs); try { return JSON.stringify(await this._ed3dOpen({ starter: a.starter, request: a.request, yaml: a.yaml, file_id: a.file_id, last: !!a.last, id: a.id })); } catch (err) { return JSON.stringify({ ok: false, error: String((err && err.message) || err) }); } },
            { type: 'object', properties: { starter: { type: 'string', description: '起手式：blank、room、model、studio' }, request: { type: 'string', description: '一句話要擺什麼' }, yaml: { type: 'string', description: '場景 YAML 當起點' }, file_id: { type: 'string', description: '使用者上傳的 .3dscene.yaml 或 3D 模型檔' }, last: { type: 'boolean', description: '接著對話裡最近的 3D 場景' }, id: { type: 'string', description: '接著原本的專案' } }, additionalProperties: false }
        );
    };
    // "put it back into the conversation": the playable scene, and the original scene updated when the project came from one
    M._ed3dToChatScene = async function (editorId, yamlText, title) {
        const msg = { role: 'tool', content: '[3D 場景編輯器的成品場景「' + String(title || '').slice(0, 40) + '」，已直接顯示給使用者看]' }; Object.defineProperty(msg, '_displayScene3DYaml', { value: yamlText, enumerable: false, configurable: true }); this.messages.push(msg);
        try { this._persistChatHistory(); this._renderMessageHistory(); } catch (_) { /* */ }
    };
    M._ed3dUpdateOrigin = async function (editorId, yamlText) {
        const proj = await FaEditStore.loadProject('edit-3d', editorId), idx = proj && proj.origin && proj.origin.index; const m = idx != null ? this.messages[idx] : null;
        if (!m || !m._displayScene3DYaml) return false; Object.defineProperty(m, '_displayScene3DYaml', { value: yamlText, enumerable: false, configurable: true, writable: true }); try { this._persistChatHistory(); this._renderMessageHistory(); } catch (_) { /* */ } return true;
    };
})();
