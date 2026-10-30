// /edit-video: reading what the user wrote about the video -- pure functions, loaded with the page (the editor's own scripts load only when it opens), tested in Node: test/edit_video/video_edit_core.test.js
//   TwVideoIntent.mediaKind(name)  parseAttachedFiles(text)  pickMedia(files)  isOpenEditorPhrase(text)
(function (root, factory) { if (typeof module === 'object' && module.exports) { module.exports = factory(); } else { root.TwVideoIntent = factory(); } }(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  // ---- sources of the video: what the chat's "[Attached files: name (client_file_id: ID), name2 (attachment_id: N)]" note says, and which names are playable media
  var VIDEO_EXT = ['.mp4', '.m4v', '.mov', '.webm', '.mkv', '.avi', '.ogv', '.mpg', '.mpeg', '.3gp', '.ts'], AUDIO_EXT = ['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.oga', '.opus', '.flac'];
  // 'video' | 'audio' | null by the file name
  function mediaKind(name) { var n = String(name || '').toLowerCase(); if (VIDEO_EXT.some(function (e) { return n.endsWith(e); })) { return 'video'; } if (AUDIO_EXT.some(function (e) { return n.endsWith(e); })) { return 'audio'; } return null; }
  // -> [{ name, kind: 'client' | 'attachment', id }] in the order written; ids are kept only in their safe shape (client file ids: letters, digits, - _ ; attachment ids: digits)
  function parseAttachedFiles(text) {
    var out = [], re = /([^,\[\]\n]+?)\s\((client_file_id|attachment_id):\s*([A-Za-z0-9_-]{1,64})\)/g, m, src = String(text == null ? '' : text);
    while ((m = re.exec(src))) {
      var name = m[1].replace(/^\s*(?:\[?\s*Attached files:\s*)/i, '').trim(), kind = m[2] === 'client_file_id' ? 'client' : 'attachment';
      if (!name || (kind === 'attachment' && !/^\d+$/.test(m[3]))) { continue; } out.push({ name: name.slice(0, 200), kind: kind, id: m[3] });
    }
    return out;
  }
  // the file to open from such a note: the first video, else the first audio, else null (a note without any media file opens an empty editor)
  function pickMedia(files) {
    var v = null, a = null; (files || []).forEach(function (f) { var k = mediaKind(f.name); if (k === 'video' && !v) { v = f; } else if (k === 'audio' && !a) { a = f; } }); return v || a || null;
  }
  // the words that mean "open the video editor" by themselves (no other request in the sentence), with or without the attached-files note:  編輯影片 / 請幫我剪輯這個影片 / open the video editor ...
  function isOpenEditorPhrase(text) {
    var bare = String(text == null ? '' : text).replace(/\s*\[Attached files:[\s\S]*\]\s*$/i, '').trim().replace(/[。.!!]+$/, '');
    if (!bare || bare.length > 40) { return false; }
    return /^(?:請|麻煩|幫我|請幫我)?\s*(?:編輯|剪輯|編修|開啟|打開|開)\s*(?:這個|這支|此|該|這部)?\s*(?:影片|視頻|影音)\s*(?:的)?\s*(?:逐字稿|字幕)?\s*(?:編輯器)?$/.test(bare) || /^(?:please\s+)?(?:edit|open)\s+(?:the\s+|this\s+|a\s+)?video(?:\s+(?:transcript|subtitles?))?(?:\s+editor)?$/i.test(bare);
  }

  return { mediaKind: mediaKind, parseAttachedFiles: parseAttachedFiles, pickMedia: pickMedia, isOpenEditorPhrase: isOpenEditorPhrase };
}));
