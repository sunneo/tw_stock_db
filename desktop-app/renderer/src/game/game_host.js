/* /edit-game-2d、/edit-game-3d 的主機轉接層(接在 edit_host.js、edit3d_host.js 後面,同一個 FaEditHost)。設計見 DESIGN.edit-game.md。
 * 只有 GUI 與斜線指令(沒有給 AI 用的工具):使用者說話 → 程式先認得的白話(parseCommands)直接變成封閉動作;剩下的交給 AI 轉成同一組封閉動作(editPrompt),
 * AI 看到的是「脈絡包」(目前場景、焦點、試玩中的狀態摘要、最近的修改),程式驗證每個動作,放不進去的退回並說明;結果先預覽再套用(外框的 previewEdits)。
 * 外部能力都是選配、缺了就退回:找圖／生圖(圖片素材)、人物聲(TTS 烘成音檔,沒有時退回嘴音)、Mermaid(沒有時顯示文字)、JSZip(打包 .fagame)、目標原始碼(確定性輸出＋AI 逐檔)。 */
(function () {
    'use strict';
    const H = FaEditHost, T = H.T, M = H.methods;
    const GEN_DOWNLOAD = (blob, name, mime, self) => self.generateAndDeliverFile(blob, name, mime || blob.type);
    const srcOf = () => (typeof FAGAME_SRC !== 'undefined' ? FAGAME_SRC : {});

    function coreFor(dim) {
        return {
            validate: (s) => FaGame.validate(s),
            listStarters: () => FaGame.listTemplates().filter((t) => t.dim === dim).map((t) => ({ id: t.id, label: t.label, desc: t.desc })),
            starter: (id) => { id = String(id || ''); if (id === 'blank' || !id) { const d = FaGame.defaultSpec(); d.game.dimension = dim; d.game.view = dim === '3d' ? { width: 640, height: 360 } : { width: 320, height: 180 }; const r = FaGame.validate(d).spec; return FaGame.applyEdits(r, [{ op: 'apply_template', template: dim === '3d' ? 'walker-3rd' : 'platformer-side' }], {}).spec; } const sp = FaGame.starter(id, {}); return sp && sp.game.dimension === dim ? sp : null; },
        };
    }
    const KIND = (dim) => {
        const d3 = dim === '3d', core = coreFor(dim), cmd = '/edit-game-' + dim;
        return {
            fence: 'fa-edit-game-' + dim, icon: '🎮', cmd, prefix: d3 ? 'g3' : 'g2', label: () => (d3 ? T('3D 遊戲編輯器', '3D game editor') : T('2D 遊戲編輯器', '2D game editor')), core: () => core,
            ui: () => ({ mount: (o) => FaGameUI.mount(Object.assign({ dim }, o)) }),
            lead: '🎮 ' + (d3 ? '3D' : '2D') + ' 遊戲編輯器:用說的設計遊戲——東西、行為(規則與狀態機)、碰撞、路線、場景切換、對白、背景音樂與音效。位置是相對的(玩家右邊、畫面中間、地上);中間的畫面可以直接玩(▶),玩到一半按 ⏸ 就是編輯器,缺什麼說一聲就加(按「🎯 焦點」點一個東西,再說「讓它變快」)。AI 改的東西會先預覽(綠＝新增、黃＝修改、紅＝刪除),你按接受才算。YAML／UML／遊戲包(.fagame)與目標原始碼都在「套件」分頁。',
            polishSystem: 'You tidy a prompt that rebuilds a game. Keep every fact (the template, scenes, objects, behaviours, rules, sounds, dialogue and WHERE things are relative to each other); make it one clear, reusable prompt. Answer with the prompt only.',
            prepare: async function () { await this._ensureJsYamlLoaded(); try { await this._ensureJSZipLoaded(); } catch (_) { /* 打包時才需要 */ } if (d3) { await this._ensureThreeJsLoaded(); } },
            collectRefs: (proj) => { const out = []; try { (JSON.stringify([proj.spec]).match(/ref:[A-Za-z0-9_-]+/g) || []).forEach((r) => { const k = r.slice(4); if (out.indexOf(k) < 0) out.push(k); }); } catch (_) { /* */ } return out; },
            mountOpts: function (id, proj) { return this._gameMountOpts(id, dim); },
            ask: function (req, ed) { return this._edAskGame(req, ed, dim); },
            help: (starters) => '**' + (d3 ? T('3D 遊戲編輯器', '3D game editor') : T('2D 遊戲編輯器', '2D game editor')) + '**\n\n' + T('用說的設計遊戲:「在玩家右邊放一個史萊姆」「讓史萊姆碰到玩家就扣血」「新增一個洞穴場景接在終點旗後面」「這個場景放緊張的背景音樂」。中間的畫面可以直接玩(▶ 試玩;玩到一半按 ⏸ 就是編輯器,「🎯 焦點／選取」點一個東西再說「讓它變快」)。位置是相對的;AI 改的東西會先預覽,按「接受」才套用;每一步都能復原。', 'Design the game by talking; play it in the middle (pause = edit).') + '\n\n' + T('起手式(範本):', 'Starters (templates):') + '\n' + starters.map((s) => '- `' + cmd + ' ' + s.id + '` — ' + s.label + ':' + s.desc).join('\n') + '\n\n' + T('「📦 套件」分頁:YAML(權威文件)、UML(場景圖、狀態圖、類別圖)、遊戲包 .fagame(壓縮、可再開啟繼續編輯)、網頁版／Electron／Node.js 由程式直接產生,其他目標(SDL2／3、Qt、C# WinForms、Java、Android、Python、FC…)由 AI 逐檔移植(沒有在這裡編譯過,附測試向量)。', 'The Pack tab has YAML, UML, the .fagame pack and target source code.'),
        };
    };
    H.register('edit-game-2d', KIND('2d'));
    H.register('edit-game-3d', KIND('3d'));

    // ───── 圖片素材:素材 id → 圖(試玩與編輯畫面要畫的) ─────
    function imagesProxy(getSpec) {
        const cache = {}, pending = {};
        return new Proxy(cache, { get(t, id) {
            if (typeof id !== 'string') return undefined; if (cache[id]) return cache[id];
            const sp = getSpec(), a = sp && sp.assets && sp.assets[id]; if (!a || a.kind !== 'image' || !a.ref) return undefined; const ref = String(a.ref).replace(/^ref:/, '');
            let url = null; try { url = FaEditStore.imageUrl(ref); } catch (_) { url = null; }
            if (url) { const im = new Image(); im.src = url; cache[id] = im; return im; }
            if (!pending[ref]) { pending[ref] = true; FaEditStore.preload([ref]).catch(() => {}); }
            return undefined;
        } });
    }

    // ───── 掛載的選項 ─────
    M._gameMountOpts = function (id, dim) {
        const self = this, kind = 'edit-game-' + dim; const getSpec = () => { const h = self._edEditors && self._edEditors.get(kind + ':' + id); return h && h._ed ? h._ed.getSpec() : null; };
        const voiceCache = self._gameVoiceCache = self._gameVoiceCache || new Map();
        return {
            images: imagesProxy(getSpec),
            raster: (sc, cam, g, w, h) => self._raster3DFrame(sc, cam, g, w, h),
            mermaid: (text) => self._ensureMermaidLoaded().then(() => window.mermaid.render('fa-game-mm-' + Math.random().toString(36).slice(2, 8), String(text)).then((r) => (r && r.svg) || String(r))),
            // 人物聲:TTS 烘成音檔;第一次要載入語音模型可能很慢,等不及(4 秒)就退回嘴音,合成好了存起來,下一次就是真的聲音
            voice: (text, voice, actx) => {
                const key = String(voice || '') + '|' + text; if (voiceCache.has(key)) { const v = voiceCache.get(key); return v && v.then ? Promise.race([v, new Promise((r) => setTimeout(() => r(null), 1500))]) : Promise.resolve(v); }
                if (self.advancedSettings && self.advancedSettings.offlineMode === false && false) return Promise.resolve(null);
                const job = self._deckSynthesizeNow(text, null, null).then((buf) => actx.decodeAudioData(buf.slice(0))).then((b) => { voiceCache.set(key, b); return b; }, () => { voiceCache.set(key, null); return null; });
                voiceCache.set(key, job); return Promise.race([job, new Promise((r) => setTimeout(() => r(null), 4000))]);
            },
            pack: async (spec, o) => {
                await self._ensureJSZipLoaded(); const P = FaGamePack.create(window.JSZip), assets = {};
                const refs = []; Object.keys(spec.assets || {}).forEach((k) => { const a = spec.assets[k]; if (a.kind === 'image' && a.ref) refs.push([k, String(a.ref).replace(/^ref:/, '')]); });
                for (const r of refs) { try { const b = await FaEditStore.getImage(r[1]); if (b) assets[r[0] + '.' + ((/png/.test(b.type) && 'png') || (/jpe?g/.test(b.type) && 'jpg') || 'bin')] = new Uint8Array(await b.arrayBuffer()); } catch (_) { /* 少一張圖而已 */ } }
                return P.pack(spec, Object.assign({}, o || {}, { assets, modified: new Date().toISOString().slice(0, 19) }));
            },
            openPack: async (file) => self._gameOpenPack(file),
            gen: {
                targets: (spec) => FaGameGen.targets(spec),
                run: (tid, spec, onStatus) => self._gameGenerate(tid, spec, onStatus),
            },
        };
    };
    // 開一個 .fagame:拆開、圖片素材放回這個瀏覽器、開一個新的編輯器接著編輯
    M._gameOpenPack = async function (file) {
        await this._ensureJSZipLoaded(); await this._ensureJsYamlLoaded(); const P = FaGamePack.create(window.JSZip); const bytes = new Uint8Array(await file.arrayBuffer()); const r = await P.open(bytes);
        const spec = r.spec; for (const k of Object.keys(r.assets || {})) { const id = k.replace(/\.[A-Za-z0-9]+$/, ''); const a = spec.assets[id]; if (a && a.kind === 'image') { try { const ref = await FaEditStore.putImage(new Blob([r.assets[k]], { type: /\.png$/i.test(k) ? 'image/png' : 'image/jpeg' })); a.ref = 'ref:' + ref; } catch (_) { /* 沒有圖就留空 */ } } }
        const dim = spec.game.dimension === '3d' ? '3d' : '2d'; const res = await this._edOpen('edit-game-' + dim, { spec }); if (res && res.ok) { res.problems = r.problems; res.title = spec.game.title; res.dim = dim; } return res;
    };
    // 目標原始碼:程式直接產生的(網頁、Electron、Node.js、three.js)與 AI 逐檔的
    M._gameGenerate = async function (tid, spec, onStatus) {
        const t = FaGameGen.TARGETS.find((x) => x.id === tid); if (!t) throw new Error('不認得的目標 ' + tid); const src = srcOf(); const say = typeof onStatus === 'function' ? onStatus : () => {};
        const name = FaGameGen.safe(spec.game.title);
        if (t.kind === 'deterministic') {
            say('產生中…'); const out = FaGameGen.build(tid, spec, { src });
            if (out.files.length === 1) { const f = out.files[0]; const blob = new Blob([f.content], { type: 'text/html' }); return { summary: f.path + '(' + Math.round(blob.size / 1024) + ' KB)。' + out.notes.join(' '), download: { blob, name: f.path, mime: 'text/html' } }; }
            await this._ensureJSZipLoaded(); const z = new window.JSZip(); out.files.forEach((f) => z.file(f.path, f.content)); const blob = await z.generateAsync({ type: 'blob', compression: 'DEFLATE' });
            return { summary: out.files.length + ' 個檔案。' + out.notes.join(' '), download: { blob, name: name + '_' + tid + '.zip', mime: 'application/zip' } };
        }
        const A = this._edAi(); if (!A.have()) throw new Error('這個目標要 AI 逐檔移植,目前沒有可用的 AI');
        const fit = FaGameGen.fitness(tid, spec); if (!fit.ok) say('適配檢查:' + fit.problems.join(';'));
        const res = await FaGameGen.aiBuild(tid, spec, { simSource: src.sim }, (system, user) => A.chat(system, user, { maxTokens: 7000, timeoutMs: 300000 }), say);
        await this._ensureJSZipLoaded(); const z = new window.JSZip(); res.files.forEach((f) => z.file(f.path, f.content)); const blob = await z.generateAsync({ type: 'blob', compression: 'DEFLATE' });
        return { summary: res.files.length + ' 個檔案(AI 寫的,沒有編譯過;對照 TESTVECTOR.json)。' + res.notes.join(' '), download: { blob, name: name + '_' + tid + '.zip', mime: 'application/zip' } };
    };

    // ───── 圖片:找圖／生圖 → 圖片素材,貼在那個原型上 ─────
    M._gameImageEdits = async function (spec, blobInfo, targetId, edits, notes) {
        const o = targetId && FaGame.byId(spec, targetId) >= 0 ? spec.objects[FaGame.byId(spec, targetId)] : null; const pid = o ? (o.type === 'prefab' ? o.id : (o.type === 'object' ? o.prefab : null)) : null;
        if (!pid) { notes.push(T('要貼在哪個東西上?先選一個東西(按「🎯 焦點」點它)再說一次', 'Select an object first')); return false; }
        const d = await this._edPics('edit-game').decode(blobInfo.blob, 256); const png = /png|gif/i.test(blobInfo.blob.type); const kept = await this._edPics('edit-game').canvasBlob(d.canvas, png ? 'image/png' : 'image/jpeg', 0.86); const ref = await FaEditStore.putImage(kept);
        const aid = 'img' + (Object.keys(spec.assets || {}).length + edits.filter((e) => e.op === 'add_asset').length + 1);
        edits.push({ op: 'add_asset', id: aid, asset: { kind: 'image', name: String(blobInfo.name || '圖片').slice(0, 30), ref: 'ref:' + ref, credit: blobInfo.credit } }); edits.push({ op: 'update_prefab', id: pid, props: { sprite: { kind: 'image', asset: aid } } }); return true;
    };
    M._edAskGame = async function (req, ed, dim) {
        req = req || {}; const A = this._edAi(), C = FaGame, spec = C.validate(req.spec).spec, notes = [], edits = [], text = String(req.text || '').trim(), status = typeof req.onStatus === 'function' ? req.onStatus : () => {}; let say = '';
        const holder = this._edEditors && this._edEditors.get('edit-game-' + dim + ':' + ed.id), env = holder && holder._ed && holder._ed.env ? holder._ed.env() : { selection: req.selection };
        if (dim === '3d' && (req.images || []).length && typeof this._i3dSubjectSolid === 'function') {   // 3D 遊戲：貼了圖又說「只要咖啡杯」「把這張圖變成 3D 物件」→ 離線深度模型做成封閉的立體，當選到的那個原型的外觀（只留主體）
            const pre = FaImage3d.subjectIntent(text), asked = /(把|將|用)?這張(圖|照片|圖片).{0,8}(變成|轉成|做成|轉).{0,6}(3D|三維|立體)|圖(片)?轉\s*3D|image.?to.?3d/i.test(text);
            if (asked || (pre.decided && pre.subject === 'main' && (pre.source === 'phrase' || pre.source === 'flag'))) {
                const si = await this._i3dSubjectIntent(text), cur0 = C.applyEdits(spec, edits, env).spec, o0 = req.selection && C.byId(cur0, req.selection) >= 0 ? cur0.objects[C.byId(cur0, req.selection)] : null, pid = o0 ? (o0.type === 'prefab' ? o0.id : (o0.type === 'object' ? o0.prefab : null)) : null;
                if (!pid) notes.push(T('要把立體的外觀放在哪個東西上?先選一個東西(按「🎯 焦點」點它)再說一次', 'Select an object first, then say it again'));
                else {
                    let blob = null; try { blob = await (await fetch(req.images[0].dataUrl)).blob(); } catch (_) { blob = null; }
                    const r = blob ? await this._i3dSubjectSolid(blob, req.images[0].name, si.subject === 'main' ? { subject: { name: si.name } } : undefined) : null;
                    if (r) {
                        const aid = 'mesh' + (Object.keys(spec.assets || {}).length + edits.filter((e) => e.op === 'add_asset').length + 1), rd = (v) => Math.round(v * 1000) / 1000;
                        edits.push({ op: 'add_asset', id: aid, asset: { kind: 'mesh', name: String((si.name || req.images[0].name || '立體')).slice(0, 30), vertices: r.mesh.vertices.map((v) => [rd(v[0]), rd(v[1]), rd(v[2])]), faces: r.mesh.faces, credit: T('你貼的圖(離線深度模型轉成封閉立體;背面是推測的)', 'your picture (offline depth model, closed solid; the back is a guess)') } });
                        edits.push({ op: 'update_prefab', id: pid, props: { sprite: { kind: 'mesh', asset: aid, color: r.color || '#ffffff' } } });
                        notes.push(T('已把圖轉成封閉的 3D 外觀(' + r.faces + ' 個面,顏色取圖的平均色' + (r.subject ? ';只留主體:' + r.subject.note : '') + ');碰撞仍是方塊,位置用「放在…上面」這類話再安排', 'turned the picture into a closed 3D look (' + r.faces + ' faces); collision stays a box'));
                        return { say: T('把圖做成立體的外觀了。', 'Made the 3D look from the picture.'), edits, notes };
                    }
                    notes.push(T('這張圖沒能轉成立體(背景去不乾淨,或深度模型不能用)', 'could not turn the picture into a solid'));
                }
            }
        }
        for (let i = 0; i < Math.min(3, (req.images || []).length); i++) {
            const im = req.images[i]; try { const blob = await (await fetch(im.dataUrl)).blob(); if (await this._gameImageEdits(C.applyEdits(spec, edits, env).spec, { blob, name: (im.name || 'picture').replace(/\.[a-z0-9]+$/i, '') }, req.selection, edits, notes)) say = say || T('把圖貼成它的外觀了。', 'Used the picture as its look.'); } catch (e) { notes.push(T('「' + (im.name || '圖片') + '」處理失敗:', 'the picture failed: ') + String((e && e.message) || e).slice(0, 80)); }
        }
        if (edits.length) return { say, edits, notes };
        if (this._edIsOffline() && text) { const off = await this._edOfflineTry('edit-game-' + dim, text, C.applyEdits(spec, edits, env).spec, env, status); if (off && off.edits.length) return { say: off.say, edits: edits.concat(off.edits), notes: notes.concat(off.notes) }; }
        if (!A.have()) return { say: T('這句話程式沒有讀懂,而且目前沒有可用的 AI;可以用物件欄與屬性面板自己改,或說「在玩家右邊放一個史萊姆」「讓它變快」這類程式讀得懂的句子。', 'The program did not understand this and there is no AI; use the objects view and the properties.'), edits, notes };
        if (!text) return { say, edits, notes };
        status(T('想一想怎麼改…', 'Working out the changes…'));
        const Pm = C.editPrompt(spec, text, '', req.selection, env);
        try {
            const rep = await A.chat(Pm.system, Pm.user, { maxTokens: 2500, timeoutMs: 120000 }), pr = C.parseEditsReply(rep);
            if (pr.ok) {
                for (const e of pr.edits) {
                    const cur = () => C.applyEdits(spec, edits, env).spec;
                    if (e.op === 'find_picture' || e.op === 'generate_image') {
                        const tgt = e.id || e.prefab || req.selection || ''; let bi = null;
                        if (e.op === 'find_picture') { bi = await this._ed3dPictureFromText(T('找一張 ', 'find a picture of ') + String(e.query || '') + T('的圖', ''), status, notes); }
                        else { const g = await this._edGenerate({ prompt: String(e.prompt || '') }, status); if (g.ok) bi = { blob: g.image.blob, name: String(e.prompt || 'AI').slice(0, 24) }; else notes.push(g.needs_download ? T('本機生圖模型還沒下載:先輸入 /image download', 'The local image model is not downloaded: type /image download first') : g.error); }
                        if (bi) { try { await this._gameImageEdits(cur(), bi, tgt, edits, notes); } catch (e2) { notes.push(String((e2 && e2.message) || e2).slice(0, 80)); } }
                    } else if (e.op === 'make_sprite') {
                        status(T('畫像素圖…', 'Drawing a pixel sprite…')); const pid = e.prefab || e.id || req.selection; const o = pid && C.byId(cur(), pid) >= 0 ? cur().objects[C.byId(cur(), pid)] : null; const pf = o ? (o.type === 'object' ? o.prefab : o.id) : null;
                        if (!pf) { notes.push(T('要畫哪個東西的外觀?先選一個', 'Select an object first')); continue; }
                        try { const rr = await A.chat('Draw a 12x12 pixel-art sprite. Answer ONLY with JSON {"palette":["#rrggbb",... up to 8 colours],"rows":[12 strings of 12 chars]}; each char is a palette index 0-7 (in base 36) or "." for transparent.', String(e.prompt || e.description || ''), { maxTokens: 700, timeoutMs: 60000 }); const a = rr.indexOf('{'), b = rr.lastIndexOf('}'); const j = JSON.parse(rr.slice(a, b + 1)); if (Array.isArray(j.palette) && Array.isArray(j.rows)) edits.push({ op: 'update_prefab', id: pf, props: { sprite: { kind: 'pixels', pixels: { palette: j.palette.slice(0, 8), rows: j.rows.slice(0, 16).map(String) } } } }); else notes.push(T('像素圖的格式不對', 'bad sprite format')); } catch (e3) { notes.push(T('畫不出來:', 'could not draw: ') + String((e3 && e3.message) || e3).slice(0, 60)); }
                    } else if (e.op === 'make_voice') {
                        const di = e.dialog || e.id; const dl = di && C.byId(cur(), di) >= 0 ? cur().objects[C.byId(cur(), di)] : null; if (!dl || dl.type !== 'dialog') { notes.push(T('要配音的對白找不到', 'dialogue not found')); continue; }
                        const v = String(e.voice || 'narrator'); edits.push({ op: 'update_dialog', id: dl.id, props: { lines: dl.lines.map((l) => (!e.who || l.who === e.who ? Object.assign({}, l, { voice: v }) : l)) } });
                    } else edits.push(e);
                }
                if (pr.say) say = say ? say + ';' + pr.say : pr.say; if (pr.dropped) notes.push(T('有 ' + pr.dropped + ' 個動作不在可做的清單裡,已略過', pr.dropped + ' actions were not in the allowed list and were skipped'));
            } else if (!edits.length) say = T('AI 的回覆我讀不懂(要是 JSON 動作)。換個說法再試一次。', 'I could not read the AI\'s answer (it has to be JSON actions). Say it differently.');
        } catch (e5) { if (!edits.length) say = T('AI 這次沒有回應(', 'The AI did not answer (') + String((e5 && e5.message) || e5).slice(0, 80) + ')。'; }
        return { say, edits, notes };
    };

    // ───── 斜線指令(沒有給 AI 的工具:這是 GUI) ─────
    M._registerEditGameCommands = function () {
        const hint = '[範本｜一句話描述]';
        const mk = (dim) => async (argsText, run0) => (run0 || this)._edCommand('edit-game-' + dim, argsText, run0);
        this.register_slash_command('/edit-game-2d', hint, '2D 遊戲編輯器(用說的設計,GUI):東西、行為(規則與狀態機)、碰撞、路線、場景切換、對白、背景音樂與音效、常見範本(橫向／縱向／強制捲軸、自由地圖、格鬥、RPG)。中間可以直接試玩,玩到一半暫停就是編輯器;AI 改的先預覽再套用。中間格式 YAML／UML,輸出遊戲包 .fagame(可再編輯)與網頁／Electron／Node.js／其他平台的原始碼。/edit-game-2d platformer-side 從範本開始、/edit-game-2d 做一個太空射擊。', mk('2d'));
        this.register_slash_command('/edit-game-3d', hint, '3D 遊戲編輯器(用說的設計,GUI):第三人稱／第一人稱走動、俯視、跑酷範本;位置以相對方式放;中間 3D 畫面可以直接試玩與暫停編輯;輸出遊戲包 .fagame、網頁(three.js)、Electron、Node.js。/edit-game-3d walker-3rd 從範本開始。', mk('3d'));
    };

    const prevRegister = M._registerEditCommands; M._registerEditCommands = function () { if (prevRegister) { prevRegister.call(this); } this._registerEditGameCommands(); };
})();
