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
            ask: (rq) => self._edAskPart(rq, { id: pid }),
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
        this.register_slash_command('/edit-3d', hint, '3D 場景編輯器：/edit-3d-model 的別名。', (argsText, run0) => (this.slashCommands.get('/edit-3d-model') || { handler: run }).handler(argsText, run0));
    };
    M._registerEdit3dTools = function (registerOptional) {
        const parse = async (self, raw) => { let a = {}; try { a = await self.repairJsonPayload(String(raw || '{}')); } catch (_) { /* */ } return a || {}; };
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
