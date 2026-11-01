// 音樂領域:MIDI 播放卡片的畫面 FaMidiUI(只依賴 DOM 與注入的 host,不碰聊天主程式)。
//   FaMidiUI.mount({ song, title, host }) → DOM 節點
//   host = { player(song) → Promise<createPlayer 的回傳>(第一次按播放才建立合成器),  download(name, bytes, mime), toMp3(song) → Promise<Blob>, onStatus }
//   卡片:播放／暫停、停止、進度條(可拖)、時間、音軌列(靜音、獨奏、音量)、下載 MIDI、轉 mp3、迴圈。
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(); else root.FaMidiUI = factory(); })(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const fmt = (s) => { s = Math.max(0, Math.round(s)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
  const el = (tag, css, text) => { const e = document.createElement(tag); if (css) e.style.cssText = css; if (text != null) e.textContent = text; return e; };
  const BTN = 'cursor:pointer;border:1px solid rgba(128,128,128,.5);background:transparent;color:inherit;border-radius:6px;padding:3px 9px;font-size:13px;';

  function mount(opts) {
    const song = opts.song, host = opts.host, M = opts.M;
    const card = el('div', 'border:1px solid rgba(128,128,128,.4);border-radius:10px;padding:10px;max-width:520px;font-size:13px;');
    card.className = 'fa-midi-card';
    const head = el('div', 'display:flex;align-items:center;gap:8px;flex-wrap:wrap;');
    head.appendChild(el('span', 'font-size:18px', '🎹'));
    head.appendChild(el('b', 'flex:1;min-width:80px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;', opts.title || song.title || 'MIDI'));
    head.appendChild(el('span', 'opacity:.7', M.noteCount(song) + ' 個音・' + song.tracks.length + ' 軌・' + Math.round(song.tempos[0].bpm) + ' 拍/分'));
    card.appendChild(head);

    const bar = el('div', 'display:flex;align-items:center;gap:8px;margin:8px 0;');
    const playBtn = el('button', BTN, '▶ 播放'); playBtn.title = '播放／暫停';
    const stopBtn = el('button', BTN, '■'); stopBtn.title = '停止';
    const seek = el('input', 'flex:1;min-width:60px;'); seek.type = 'range'; seek.min = 0; seek.max = 1000; seek.value = 0;
    const time = el('span', 'font-variant-numeric:tabular-nums;opacity:.8', '0:00 / ' + fmt(M.durationSec(song)));
    bar.append(playBtn, stopBtn, seek, time); card.appendChild(bar);

    const status = el('div', 'opacity:.75;min-height:1.2em;font-size:12px;', ''); card.appendChild(status);
    const say = (m) => { status.textContent = m || ''; };

    let player = null, muted = new Set(), soloIdx = null, dragging = false;
    const total = M.durationSec(song);
    const onTick = (sec) => { if (!dragging) seek.value = total ? Math.round(sec / total * 1000) : 0; time.textContent = fmt(sec) + ' / ' + fmt(total); };
    async function ensure() {
      if (player) return player;
      say('準備合成器(第一次要下載音色庫,之後直接從本機讀取)…');
      player = await host.player(song, (m) => say(m));
      player.onTick(onTick); player.onEnd(() => { playBtn.textContent = '▶ 播放'; });
      say(''); return player;
    }
    playBtn.onclick = async () => {
      try { const p = await ensure(); if (p.isPlaying()) { p.pause(); playBtn.textContent = '▶ 播放'; } else { p.play(); playBtn.textContent = '❚❚ 暫停'; } }
      catch (e) { say('⚠️ 無法播放:' + String((e && e.message) || e)); }
    };
    stopBtn.onclick = () => { if (player) { player.stop(); playBtn.textContent = '▶ 播放'; } };
    seek.oninput = () => { dragging = true; time.textContent = fmt(seek.value / 1000 * total) + ' / ' + fmt(total); };
    seek.onchange = async () => { dragging = false; try { const p = await ensure(); p.seek(seek.value / 1000 * total); } catch (e) { say('⚠️ ' + String((e && e.message) || e)); } };

    const list = el('div', 'margin-top:6px;');
    song.tracks.forEach((t, i) => {
      const row = el('div', 'display:flex;align-items:center;gap:6px;padding:2px 0;');
      const name = el('span', 'flex:1;min-width:60px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;', (i + 1) + '. ' + t.name + (t.drum ? '(鼓組)' : ''));
      const mute = el('button', BTN + 'padding:1px 6px;', 'M'); mute.title = '靜音';
      const solo = el('button', BTN + 'padding:1px 6px;', 'S'); solo.title = '獨奏';
      const vol = el('input', 'width:70px;'); vol.type = 'range'; vol.min = 0; vol.max = 150; vol.value = 100; vol.title = '音量';
      mute.onclick = async () => { const on = !muted.has(i); if (on) muted.add(i); else muted.delete(i); mute.style.background = on ? 'rgba(220,80,80,.4)' : 'transparent'; try { (await ensure()).setMute(i, on); } catch (_) { /* */ } };
      solo.onclick = async () => { soloIdx = soloIdx === i ? null : i; Array.from(list.querySelectorAll('button[data-solo]')).forEach((b) => { b.style.background = 'transparent'; }); if (soloIdx === i) solo.style.background = 'rgba(80,160,220,.4)'; try { (await ensure()).setSolo(soloIdx); } catch (_) { /* */ } };
      solo.dataset.solo = '1';
      vol.oninput = async () => { try { (await ensure()).setTrackVolume(i, vol.value / 100); } catch (_) { /* */ } };
      row.append(name, mute, solo, vol); list.appendChild(row);
    });
    card.appendChild(list);

    const foot = el('div', 'display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:8px;');
    const loop = el('label', 'display:flex;align-items:center;gap:4px;'); const lc = el('input'); lc.type = 'checkbox'; lc.onchange = async () => { try { (await ensure()).setLoop(lc.checked); } catch (_) { /* */ } }; loop.append(lc, document.createTextNode('重複'));
    const dl = el('button', BTN, '⬇ MIDI 檔'); dl.onclick = () => { try { host.download((opts.title || song.title || 'song').replace(/[\\/:*?"<>|]/g, '_') + '.mid', M.write(song), 'audio/midi'); } catch (e) { say('⚠️ ' + String((e && e.message) || e)); } };
    const mp3 = el('button', BTN, '⬇ mp3');
    mp3.onclick = async () => {
      mp3.disabled = true; const old = mp3.textContent; mp3.textContent = '渲染中…';
      try { const blob = await host.toMp3(song, (m) => say(m)); host.download((opts.title || song.title || 'song').replace(/[\\/:*?"<>|]/g, '_') + '.mp3', new Uint8Array(await blob.arrayBuffer()), 'audio/mpeg'); say('已轉成 mp3(' + Math.round(blob.size / 1024) + ' KB)'); }
      catch (e) { say('⚠️ 轉 mp3 失敗:' + String((e && e.message) || e)); }
      mp3.disabled = false; mp3.textContent = old;
    };
    foot.append(loop, dl, mp3); card.appendChild(foot);
    card._midi = { destroy() { if (player) player.stop(); } };
    return card;
  }
  return { mount, fmt };
});
