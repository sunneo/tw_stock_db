/* Perl「出」：核心 IR → Perl 原始碼（共用 ir_out_dyn_core.js）。純函式 UMD。見 DESIGN.core-ir.md 第 12 節。 */
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(require('./ir_out_dyn_core.js')); else root.FaIrOutPerl = factory(root.FaIrOutDyn); })(typeof self !== 'undefined' ? self : this, function (T) { 'use strict'; return T.make('perl'); });
