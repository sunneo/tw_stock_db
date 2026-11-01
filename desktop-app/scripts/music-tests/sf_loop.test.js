// node scripts/music-tests/sf_loop.test.js -- sample-internal loop detection for the sound bank slimmer (synthetic signals)
const L = require('../sf-loop.js');
let ok = 0; const bad = [];
function check(name, cond, extra) { if (cond) ok++; else bad.push(name + (extra !== undefined ? ' ' + JSON.stringify(extra).slice(0, 300) : '')); }
const SR = 22050;
// 持續音:鋸齒＋泛音,淡入後穩定,略帶緩慢顫動;f 取不是整數週期的頻率(週期 = SR/f 非整數)
function sustained(f, sec, vib) { const n = Math.floor(SR * sec), x = new Float32Array(n); for (let i = 0; i < n; i++) { const t = i / SR, env = Math.min(1, t / 0.05) * (1 - 0.1 * t / sec); let s = 0; for (let h = 1; h <= 6; h++) s += Math.sin(2 * Math.PI * f * h * t + (vib ? 0.02 * Math.sin(2 * Math.PI * 5 * t) : 0)) / h; x[i] = 0.3 * env * s; } return x; }
function plucked(f, sec) { const n = Math.floor(SR * sec), x = new Float32Array(n); for (let i = 0; i < n; i++) { const t = i / SR; x[i] = 0.5 * Math.exp(-t * 14) * Math.sin(2 * Math.PI * f * t); } return x; }
function noise(sec) { const n = Math.floor(SR * sec), x = new Float32Array(n); let a = 7; for (let i = 0; i < n; i++) { a = (a * 1103515245 + 12345) & 0x7fffffff; x[i] = (a / 0x7fffffff - 0.5) * 0.4; } return x; }

const s220 = sustained(220.5, 1.2);
const per = L.findPeriod(s220, SR);
check('findPeriod: finds the fundamental period of a harmonic tone (within 1%)', Math.abs(per.period - SR / 220.5) / (SR / 220.5) < 0.01 && per.strength > 0.95, per);
check('findPeriod: noise has no strong period', L.findPeriod(noise(1), SR).strength < 0.5);
const lp = L.findLoop(s220, SR);
check('findLoop: a sustained tone gets a loop of whole periods', lp && Math.abs(lp.periods - Math.round(lp.periods)) < 0.15 && lp.end - lp.start >= SR * 0.07, lp);
check('findLoop: loop points sit on positive-going zero crossings', lp && s220[lp.start - 1] <= 0 && s220[lp.start] > 0 && s220[lp.end - 1] <= 0 && s220[lp.end] > 0);
check('findLoop: seam is nearly seamless', lp && L.seamError(s220, lp.start, lp.end) < 0.15, lp && L.seamError(s220, lp.start, lp.end));
check('findLoop: noise gets no loop (rejected rather than clicky)', L.findLoop(noise(1), SR) === null);
check('isSustained: sustained yes, plucked no', L.isSustained(s220, SR) && !L.isSustained(plucked(330, 1.2), SR));
// slim 規則
const noLoop = L.slim(s220, SR, { startLoop: 0, endLoop: 0 });
check('slim: sustained sample without loop gets one and the tail is cut', noLoop.action === 'add-loop' && noLoop.data.length < s220.length && noLoop.hdr.endLoop <= noLoop.data.length - L.GUARD + 1 && noLoop.hdr.endLoop > noLoop.hdr.startLoop, [noLoop.action, noLoop.data.length, s220.length, noLoop.hdr]);
const pl = L.slim(plucked(330, 1.2), SR, { startLoop: 0, endLoop: 0 });
check('slim: percussive/plucked sample is left alone', pl.action === 'keep' && pl.data.length === plucked(330, 1.2).length);
const withLoop = L.slim(s220, SR, { startLoop: 8000, endLoop: 14000 });
check('slim: existing loop keeps its points and drops everything after loop end + guard', withLoop.action === 'cut-tail' && withLoop.data.length === 14000 + L.GUARD && withLoop.hdr.startLoop === 8000 && withLoop.hdr.endLoop === 14000, [withLoop.action, withLoop.data.length]);
const longLoop = L.slim(s220, SR, { startLoop: 2000, endLoop: 26000 }, {});
check('slim: a very long existing loop is shortened to whole periods', longLoop.action.indexOf('shorten-loop') === 0 && longLoop.hdr.endLoop - longLoop.hdr.startLoop < 24000 && longLoop.hdr.endLoop - longLoop.hdr.startLoop >= SR * 0.07, longLoop);
const down = L.slim(plucked(330, 1.2), SR, { startLoop: 0, endLoop: 0 }, { maxRate: 11025 });
check('slim: downsampling halves length and rate, pitch preserved', down.hdr.rate === 11025 && Math.abs(down.data.length - plucked(330, 1.2).length / 2) <= 1 && (() => { const p = L.findPeriod(L.slim(sustained(220.5, 1.2), SR, { startLoop: 0, endLoop: 0 }, { maxRate: 11025 }).data, 11025); return Math.abs(p.period - 11025 / 220.5) / (11025 / 220.5) < 0.02; })(), [down.hdr]);
console.log(bad.length ? 'FAIL\n' + bad.join('\n') : 'ok'); console.log(ok + ' passed, ' + bad.length + ' failed'); process.exit(bad.length ? 1 : 0);
