// Shared MP4 video export, used by both ai_chat_3d_viewer.js and
// ai_chat_2d_viewer.js -- genuinely independent of either one (it only
// ever touches a plain <canvas> element and a frame-drawing callback the
// CALLER supplies), so it lives in its own file rather than living inside
// (and creating a dependency from) either viewer.
//
// Uses the browser's native WebCodecs VideoEncoder to produce real H.264
// video, then mp4-muxer (vendored, assets/javascripts/vendor/mp4-muxer.js,
// MIT-licensed, github.com/Vanilagy/mp4-muxer) to package it into an
// actual .mp4 container -- deliberately not ffmpeg.wasm (much larger to
// vendor, and unnecessary when the browser can already encode H.264
// natively via WebCodecs).
(function (window) {
  'use strict';

  var mp4MuxerPromise = null;

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

  function ensureMp4MuxerLoaded() {
    if (mp4MuxerPromise) { return mp4MuxerPromise; }
    var urls = window.AiChatExportAssetUrls || {};
    if (!urls.mp4Muxer) {
      return Promise.reject(new Error('MP4 export assets are not configured (window.AiChatExportAssetUrls missing mp4Muxer).'));
    }
    mp4MuxerPromise = loadScriptOnce(urls.mp4Muxer);
    return mp4MuxerPromise;
  }

  // H.264 Baseline Profile Level 3.1 -- broadly compatible playback target
  // (matches the reference implementation this was ported from), not the
  // highest-efficiency codec profile available.
  var VIDEO_CODEC = 'avc1.42001f';
  var BITRATE = 4_000_000;

  // AAC first (plays everywhere), Opus as the fallback; null when this browser has no AudioEncoder for either.
  function pickAudioCodec(audio) {
    if (typeof AudioEncoder === 'undefined' || typeof AudioData === 'undefined') { return Promise.resolve(null); }
    var candidates = [{ codec: 'mp4a.40.2', muxerCodec: 'aac' }, { codec: 'opus', muxerCodec: 'opus' }];
    var cfg = function (c) { return { codec: c.codec, sampleRate: audio.sampleRate, numberOfChannels: audio.channels.length || audio.channels, bitrate: 128000 }; };
    var i = 0;
    function next() {
      if (i >= candidates.length) { return Promise.resolve(null); }
      var c = candidates[i++];
      return AudioEncoder.isConfigSupported(cfg(c)).then(function (r) { return r && r.supported ? { codec: c.codec, muxerCodec: c.muxerCodec, config: cfg(c) } : next(); }, next);
    }
    return next();
  }

  // Feeds an audio track to an AudioEncoder in 1-second planar chunks, ON DEMAND: feedUntil(sample) encodes everything up to that sample
  // and returns a promise, so the caller can interleave audio with the video frames (a file written in one pass needs that, and the
  // PCM never exists as one big array). `audio` is either {sampleRate, channels:[Float32Array...]} (everything already in memory) or
  // {sampleRate, channels:<count>, length, read(pos, n) -> Promise<Float32Array>} (a mono source that produces chunks).
  function makeAudioFeeder(muxer, audio, pick) {
    var enc = new AudioEncoder({ output: function (chunk, meta) { muxer.addAudioChunk(chunk, meta); }, error: function (e) { throw e; } });
    enc.configure(pick.config);
    var streaming = typeof audio.read === 'function', count = streaming ? audio.channels : audio.channels.length;
    var total = streaming ? audio.length : audio.channels[0].length, pos = 0, step = audio.sampleRate;
    function chunk() {
      var n = Math.min(step, total - pos);
      var got = streaming ? audio.read(pos, n) : Promise.resolve(audio.channels.map(function (c) { return c.subarray(pos, pos + n); }));
      return got.then(function (parts) {
        var planes = streaming ? [parts] : parts, planar = new Float32Array(n * count);
        for (var c = 0; c < count; c++) { planar.set(planes[c], c * n); }
        var data = new AudioData({ format: 'f32-planar', sampleRate: audio.sampleRate, numberOfFrames: n, numberOfChannels: count, timestamp: Math.round(pos / audio.sampleRate * 1e6), data: planar });
        enc.encode(data); data.close(); pos += n;
      });
    }
    function waitQueue() { return enc.encodeQueueSize > 8 ? new Promise(function (r) { setTimeout(r, 5); }).then(waitQueue) : Promise.resolve(); }
    return {
      feedUntil: function (sample) {
        function loop() { return pos < Math.min(total, sample) ? waitQueue().then(chunk).then(loop) : Promise.resolve(); }
        return loop();
      },
      finish: function () {
        function feedAll() { return pos < total ? waitQueue().then(chunk).then(feedAll) : Promise.resolve(); }
        return feedAll().then(function () { return enc.flush(); }).then(function () { enc.close(); });
      }
    };
  }

  // A file in the browser's private disk storage (OPFS) the muxer streams into, so a long video is never held in memory. Chrome / Edge.
  function openDiskTarget(Mp4Muxer) {
    if (!(navigator.storage && navigator.storage.getDirectory && Mp4Muxer.FileSystemWritableFileStreamTarget)) { return Promise.resolve(null); }
    var name = 'ai-chat-deck-export-' + Date.now() + '.mp4', dir = null;
    return navigator.storage.getDirectory().then(function (d) {
      dir = d;
      // sweep leftovers of earlier exports (a finished one may still be being downloaded for a while; only old ones go)
      var sweeps = [];
      var iter = d.entries ? d.entries() : null;
      if (!iter) { return null; }
      function step() {
        return iter.next().then(function (r) {
          if (r.done) { return Promise.all(sweeps); }
          var entryName = r.value[0], stamp = parseInt((/ai-chat-deck-export-(\d+)\.mp4$/.exec(entryName) || [])[1], 10);
          if (stamp && Date.now() - stamp > 30 * 60 * 1000) { sweeps.push(d.removeEntry(entryName).catch(function () {})); }
          return step();
        });
      }
      return step();
    }).then(function () { return dir.getFileHandle(name, { create: true }); }).then(function (handle) {
      return handle.createWritable().then(function (writable) {
        return { target: new Mp4Muxer.FileSystemWritableFileStreamTarget(writable), writable: writable, handle: handle, dir: dir, name: name };
      });
    }).catch(function () { return null; });
  }

  /**
   * Drives `frameCallback(frameIndex)` once per frame (the caller is
   * responsible for actually drawing that frame onto `canvas` -- this
   * function only reads back whatever is on it afterward), encodes each
   * resulting frame via WebCodecs, and muxes the result into a real MP4
   * file. Returns a Promise<{blob: Blob}>.
   *
   * `onProgress(framesDone, totalFrames)` is called after each frame, if
   * given -- used to show a live percentage on the export button while a
   * long export runs.
   *
   * `options` (all optional; the 3D/2D viewers pass none and nothing changes for them):
   *   audio   -- the narration of "/media-presentation": {sampleRate, channels:[Float32Array...]} already mixed, or a streaming mono
   *              source {sampleRate, channels:1, length, read(pos, n)}; AAC (Opus if unavailable), interleaved with the video as it is
   *              written. If this browser cannot encode audio the video is still produced and the result says {audioDropped: true}.
   *   stream  -- write the file into the browser's private disk storage (OPFS) while encoding instead of building it in memory, so a
   *              30 minute video does not need 1 GB of RAM; the returned blob is that file (disk backed). Falls back to memory when
   *              the browser has no OPFS (result.streamed tells which). The temp file is removed on the next export (> 30 min old).
   *   bitrate -- video bits per second (default 4 Mbit).
   */
  function encodeCanvasFramesToMp4(canvas, totalFrames, fps, frameCallback, onProgress, options) {
    options = options || {};
    if (typeof VideoEncoder === 'undefined' || typeof VideoFrame === 'undefined') {
      return Promise.reject(new Error(
        'This browser does not support WebCodecs (VideoEncoder/VideoFrame) -- MP4 export needs a recent desktop Chrome or Edge.'
      ));
    }
    var audioIn = options.audio && (options.audio.read || (options.audio.channels && options.audio.channels.length)) ? options.audio : null;
    var disk = null, audioPick = null, Mp4Muxer = null;

    return ensureMp4MuxerLoaded().then(function () {
      Mp4Muxer = window.Mp4Muxer;
      return Promise.resolve(audioIn ? pickAudioCodec(audioIn) : null);
    }).then(function (pick) {
      audioPick = pick;
      return options.stream ? openDiskTarget(Mp4Muxer) : null;
    }).then(function (d) {
      disk = d;
      var muxerOptions = {
        target: disk ? disk.target : new Mp4Muxer.ArrayBufferTarget(),
        video: { codec: 'avc', width: canvas.width, height: canvas.height, frameRate: fps },
        fastStart: disk ? false : 'in-memory'
      };
      if (audioPick) { muxerOptions.audio = { codec: audioPick.muxerCodec, numberOfChannels: audioIn.read ? audioIn.channels : audioIn.channels.length, sampleRate: audioIn.sampleRate }; }
      var muxer = new Mp4Muxer.Muxer(muxerOptions);
      var feeder = audioPick ? makeAudioFeeder(muxer, audioIn, audioPick) : null;

      var encoder = new VideoEncoder({
        output: function (chunk, meta) { muxer.addVideoChunk(chunk, meta); },
        error: function (e) { throw e; }
      });
      encoder.configure({ codec: VIDEO_CODEC, width: canvas.width, height: canvas.height, bitrate: options.bitrate || BITRATE, framerate: fps });

      var frameDurationUs = Math.round(1e6 / fps);
      var keyFrameEveryNFrames = Math.max(1, Math.round(fps)); // one keyframe per second of output

      function discard() { if (disk) { try { disk.writable.abort(); } catch (e) { /* ignore */ } disk.dir.removeEntry(disk.name).catch(function () {}); } }

      return new Promise(function (resolve, reject) {
        var i = 0;
        function fail(e) { discard(); reject(e); }

        function encodeNext() {
          if (i >= totalFrames) {
            encoder.flush().then(function () {
              encoder.close();
              return feeder ? feeder.finish() : null;
            }).then(function () {
              muxer.finalize();
              if (!disk) { resolve({ blob: new Blob([muxer.target.buffer], { type: 'video/mp4' }), audioDropped: !!(audioIn && !audioPick), streamed: false }); return null; }
              return disk.writable.close().then(function () { return disk.handle.getFile(); }).then(function (file) {
                resolve({ blob: file, audioDropped: !!(audioIn && !audioPick), streamed: true, cleanup: function () { return disk.dir.removeEntry(disk.name).catch(function () {}); } });
              });
            }).catch(fail);
            return;
          }

          // Basic backpressure -- don't queue unboundedly many frames ahead of the encoder if it's falling behind.
          if (encoder.encodeQueueSize > 4) { setTimeout(encodeNext, 10); return; }

          try {
            frameCallback(i);
            var frame = new VideoFrame(canvas, { timestamp: i * frameDurationUs, duration: frameDurationUs });
            encoder.encode(frame, { keyFrame: i % keyFrameEveryNFrames === 0 });
            frame.close();
          } catch (e) { fail(e); return; }

          if (onProgress) { onProgress(i + 1, totalFrames); }
          i++;
          if (feeder) {
            // keep the audio about a second ahead of the video so the two tracks are interleaved in the file
            feeder.feedUntil(Math.round(((i / fps) + 1) * audioIn.sampleRate)).then(function () { setTimeout(encodeNext, 0); }, fail);
          } else { setTimeout(encodeNext, 0); }
        }

        encodeNext();
      });
    });
  }

  // ---------------------------------------------------- export options dialog
  //
  // A small, self-contained modal (native confirm()/prompt() can't take two
  // fields at once) -- reuses the SAME .ai-chat-dialog-overlay/.ai-chat-dialog
  // CSS classes the skill/function/RAG admin dialogs already use (see
  // ai_chat.js/ai_chat.css), but is built entirely dynamically here rather
  // than depending on any static markup in index.html.erb or on the AiChat
  // instance's own openDialog/closeDialog methods -- this file has no
  // dependency on ai_chat.js at all, only shares its CSS class names for a
  // visually consistent look.
  function showMp4ExportOptionsDialog(defaults) {
    defaults = defaults || {};
    return new Promise(function (resolve) {
      var overlay = document.createElement('div');
      overlay.className = 'ai-chat-dialog-overlay';

      var dialog = document.createElement('div');
      dialog.className = 'ai-chat-dialog';
      dialog.innerHTML =
        '<h3>匯出MP4影片</h3>' +
        '<div style="margin-bottom:0.8em;">' +
        '<label class="block">秒數（至少1秒，無上限）<br>' +
        '<input type="number" class="ai-chat-mp4dlg-duration" min="1" step="1" style="width:100%;"></label>' +
        '</div>' +
        '<div style="margin-bottom:0.8em;">' +
        '<label class="block">播放速度（0.1x ~ 4.0x）<br>' +
        '<input type="number" class="ai-chat-mp4dlg-speed" min="0.1" max="4" step="0.1" style="width:100%;"></label>' +
        '</div>' +
        '<div class="ai-chat-dialog-actions">' +
        '<span class="ai-chat-dialog-actions-spacer"></span>' +
        '<button type="button" class="ai-chat-mp4dlg-cancel">取消</button>' +
        '<button type="button" class="ai-chat-mp4dlg-confirm">匯出</button>' +
        '</div>';
      overlay.appendChild(dialog);
      document.body.appendChild(overlay);

      var durationInput = dialog.querySelector('.ai-chat-mp4dlg-duration');
      var speedInput = dialog.querySelector('.ai-chat-mp4dlg-speed');
      durationInput.value = Number.isFinite(defaults.durationSeconds) ? defaults.durationSeconds : 5;
      speedInput.value = Number.isFinite(defaults.speed) ? defaults.speed : 1;

      function close(result) {
        document.body.removeChild(overlay);
        resolve(result);
      }

      overlay.addEventListener('click', function (e) { if (e.target === overlay) { close(null); } });
      dialog.querySelector('.ai-chat-mp4dlg-cancel').addEventListener('click', function () { close(null); });
      dialog.querySelector('.ai-chat-mp4dlg-confirm').addEventListener('click', function () {
        var durationSeconds = Math.max(1, parseFloat(durationInput.value) || 5);
        var speed = Math.max(0.1, Math.min(4, parseFloat(speedInput.value) || 1));
        close({ durationSeconds: durationSeconds, speed: speed });
      });
    });
  }

  window.AiChatVideoExport = {
    encodeCanvasFramesToMp4: encodeCanvasFramesToMp4,
    showMp4ExportOptionsDialog: showMp4ExportOptionsDialog
  };
})(window);
