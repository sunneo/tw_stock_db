// 真的音訊（真實 Electron）：python 的 fa_audio 與 pygame.mixer 經橋接，由頁面的 Web Audio 播放；聲道、busy、停止、程式結束時收聲音。
// 用法：FA_DEBUG_EVAL_FILE=scripts/eval/audio_real.eval.js xvfb-run -a node_modules/electron/dist/electron . --no-sandbox --use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader --user-data-dir=$(mktemp -d)
const fa = window.fa; const R = {}; const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const tool = async (name, args) => JSON.parse(await fa.tools[name].callback.call(fa, JSON.stringify(args)));
let r = await tool('job_run', { lang: 'python', timeout_s: 120, code: `
import array, math, time, pygame, fa_audio
pcm = array.array("h", (int(9000 * math.sin(2 * math.pi * 440 * i / 22050)) for i in range(int(22050 * 0.4)))).tobytes()   # 440 Hz、0.4 秒
print('available', fa_audio.available())
print('duration', round(fa_audio.load_pcm('a', pcm, 22050, 1), 2))
c1 = fa_audio.play('a'); c2 = fa_audio.play('a', loops=-1)
print('channels', c1, c2, 'busy', fa_audio.busy(c1), fa_audio.busy(c2), 'count', fa_audio.count())
time.sleep(0.7)
print('after 0.7s once-busy', fa_audio.busy(c1), 'loop-busy', fa_audio.busy(c2))
fa_audio.stop(ch=c2); time.sleep(0.1); print('after stop loop-busy', fa_audio.busy(c2))
pygame.mixer.init(22050, -16, 1)
snd = pygame.mixer.Sound(buffer=pcm); ch = snd.play(); print('pygame channel', type(ch).__name__, ch.get_busy(), round(snd.get_length(), 2))
snd2 = pygame.mixer.Sound(buffer=pcm); ch2 = snd2.play(loops=-1); print('polyphony', pygame.mixer.get_busy(), fa_audio.count())
print('leaving with a looping sound playing')
` });
R.py = { exit: r.exit_code, out: (r.output || '').trim() };
await wait(400);
const st = fa._audioHost ? fa._audioHost.stats() : null; R.after_exit = st;
R.owner_stopped = !!(await fa._audioHost.handle({ cmd: 'busy' })).busy === false;
// node 的 audio
r = await tool('job_run', { lang: 'node', timeout_s: 60, code: `
const n = 4410, pcm = new Int16Array(n); for (let i = 0; i < n; i++) pcm[i] = Math.round(8000 * Math.sin(2 * Math.PI * 880 * i / 22050));
const d = await audio.load('b', pcm, 22050, 1); const ch = await audio.play('b', { loops: -1 });
console.log('node audio', d.toFixed(2), ch, await audio.busy(ch)); await audio.stop({ ch }); console.log('stopped', await audio.busy(ch));
` });
R.node = { exit: r.exit_code, out: (r.output || '').trim() };
R.ok = R.py.exit === 0 && /available True/.test(R.py.out) && /busy True True/.test(R.py.out) && /after 0.7s once-busy False loop-busy True/.test(R.py.out) && /after stop loop-busy False/.test(R.py.out) && /pygame channel Channel True 0.4/.test(R.py.out) && /polyphony True/.test(R.py.out) && R.owner_stopped && R.node.exit === 0 && /node audio 0.20 \d+ true/.test(R.node.out) && /stopped false/.test(R.node.out);
console.log('AUDIO_RESULT ' + JSON.stringify(R));
return R;
