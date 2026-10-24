// node scripts/computer-tests/remote.test.js -- computer-remote.js：畫布視窗偵測、目標字串、RDP／SPICE／NX／SSH／HTTP／RFB 協定探測（假伺服器＋fixture）、WebSocket 客戶端
const net = require('net');
const http = require('http');
const R = require('../../computer-remote.js');
const WS = require('../../computer-ws.js');
const { startFakeRfb } = require('./fake_rfb_server.js');
const { suite } = require('./_t.js');
const t = suite('computer-remote');

// ---- 畫布視窗偵測
const cw = (p, title, cls) => R.classifyWindow({ process: p, title: title || '', class: cls || '' });
for (const [p, kind] of [['mstsc.exe', 'rdp'], ['xfreerdp', 'rdp'], ['wlfreerdp', 'rdp'], ['remmina', 'remote-desktop'], ['vncviewer', 'vnc'], ['tigervnc', 'vnc'], ['vinagre', 'vnc'], ['virt-viewer', 'spice'], ['virt-manager', 'spice'], ['qemu-system-x86_64', 'kvm'], ['nxplayer.bin', 'nx'], ['spicy', 'spice'], ['VirtualBoxVM', 'kvm'], ['x2goclient', 'remote-desktop']]) t.check('畫布視窗：' + p + ' → ' + kind, (() => { const r = cw(p); return r.canvas && r.kind === kind && r.capabilities.objects === 'vlm' && r.capabilities.input === 'os'; })(), cw(p));
t.check('瀏覽器分頁標題：noVNC／Guacamole／Proxmox Console 被認出', ['noVNC', 'Apache Guacamole', 'Proxmox Console - node1'].every((x) => cw('firefox', x).canvas && cw('firefox', x).kind === 'browser-canvas'));
t.check('普通視窗不是畫布（記事本、瀏覽器 Google、終端機、vim）', ['notepad', 'gedit', 'xterm', 'code'].every((p) => !cw(p, 'x').canvas) && !cw('firefox', 'Google 搜尋').canvas);
t.check('類別名稱也能認（TscShellContainerClass）', cw('', '', 'TscShellContainerClass').canvas);
// ---- 目標字串
t.check('parseTarget：host:port、host:顯示編號、host::port、IPv6、ws://、vnc://、http', (() => { const P = R.parseTarget; return P('h:5901').port === 5901 && P('h:1').port === 5901 && P('h::5902').port === 5902 && P('[::1]:5900').host === '::1' && P('ws://h:6080/websockify').wsUrl === 'ws://h:6080/websockify' && P('vnc://h:2').port === 5902 && P('https://x.com/v').https === true && P('h').port === undefined; })());
// ---- 封包 fixture
const req = R.buildRdpRequest(1 | 2 | 8);
t.check('RDP 請求：TPKT 版本 3、長度正確、X.224 CR（0xE0）、含 cookie 與 RDP_NEG_REQ(type1,len8,protocols=0x0B)', req[0] === 3 && req.readUInt16BE(2) === req.length && req[5] === 0xe0 && req.toString('latin1').includes('Cookie: mstshash=') && req[req.length - 8] === 1 && req.readUInt32LE(req.length - 4) === 11, req.toString('hex'));
t.check('RDP 請求：不含 negotiation（Standard-only）時沒有 type 1 區塊', R.buildRdpRequest(null).length === 4 + 7 + Buffer.byteLength('Cookie: mstshash=probe\r\n') && R.buildRdpRequest(null)[4] === 6 + Buffer.byteLength('Cookie: mstshash=probe\r\n'));
const ccRsp = (sel) => Buffer.from([3, 0, 0, 19, 14, 0xd0, 0, 0, 0x12, 0x34, 0, 2, 0x1f, 8, 0, sel, 0, 0, 0]);
t.check('RDP 回應：選了 CredSSP（selected=2）', (() => { const r = R.parseRdpResponse(ccRsp(2)); return r.ok && r.selected === 2 && r.nla === undefined && /NLA/.test(r.selectedName) && r.flagsInfo.authRequired; })());
t.check('RDP 回應：選了 TLS（selected=1）', R.parseRdpResponse(ccRsp(1)).selected === 1);
t.check('RDP 回應：negotiation failure（HYBRID_REQUIRED）', (() => { const b = ccRsp(5); b[11] = 3; const r = R.parseRdpResponse(b); return r.ok && r.failure === 5 && /NLA/.test(r.failureName); })());
t.check('RDP 回應：沒有 negotiation 區塊＝Standard RDP Security', (() => { const r = R.parseRdpResponse(Buffer.from([3, 0, 0, 11, 6, 0xd0, 0, 0, 0x12, 0x34, 0])); return r.ok && r.selected === 0 && /Standard/.test(r.selectedName); })());
t.check('RDP 回應：不是 TPKT 回 null', R.parseRdpResponse(Buffer.from('HTTP/1.1 400 Bad Request')) === null);
const spiceRep = Buffer.alloc(24); spiceRep.write('REDQ', 0, 'latin1'); spiceRep.writeUInt32LE(2, 4); spiceRep.writeUInt32LE(2, 8); spiceRep.writeUInt32LE(178, 12); spiceRep.writeUInt32LE(0, 16);
t.check('SPICE 回應解析（版本 2.2、link OK）', (() => { const r = R.parseSpiceReply(spiceRep); return r.ok && r.major === 2 && r.minor === 2 && r.linkErrorName === 'OK'; })());
t.check('SPICE link 請求：魔術字 REDQ、版本 2.2、size 與內容吻合', (() => { const b = R.buildSpiceLink(); return b.toString('latin1', 0, 4) === 'REDQ' && b.readUInt32LE(12) === b.length - 16; })());
t.check('橫幅分類：RFB／SSH／NX／HTTP', R.classifyBanner(Buffer.from('RFB 003.008\n')).kind === 'rfb' && R.classifyBanner(Buffer.from('SSH-2.0-OpenSSH_9.6\r\n')).kind === 'ssh' && R.classifyBanner(Buffer.from('NXD-3.5.0-4\n')).kind === 'nx' && R.classifyBanner(Buffer.from('HTTP/1.1 400 Bad\r\n')).kind === 'http' && R.classifyBanner(Buffer.from([1, 2, 3])) === null);
t.check('HTTP 內容分類：noVNC／Guacamole／Proxmox', R.classifyHttpBody('<title>noVNC</title>').web === 'novnc' && R.classifyHttpBody('Apache Guacamole').web === 'guacamole' && R.classifyHttpBody('Proxmox Virtual Environment').web === 'proxmox');
t.check('xfreerdp 指令：密碼走 stdin、不進 argv、帶安全層與標題', (() => { const c = R.buildFreerdpCommand({ host: 'h', port: 3390, user: 'u', domain: 'D', security: 'nla', password: 'p@ss', extra: ['/p:evil', '+auto-reconnect', 'rm -rf'] }); return c.args.includes('/v:h:3390') && c.args.includes('/u:u') && c.args.includes('/sec:nla') && c.args.includes('/from-stdin:force') && !c.args.some((a) => /p@ss|\/p:/.test(a)) && c.stdin === 'p@ss\n' && c.args.includes('+auto-reconnect') && !c.args.includes('rm -rf'); })());
t.check('remoteTarget 抽象：封閉詞彙、預設值', (() => { const a = R.makeRemoteTarget({ kind: 'rfb', id: 'rfb:1', capabilities: { objects: 'protocol', input: 'protocol' } }), b = R.makeRemoteTarget({ kind: 'bogus', capabilities: { objects: 'x', input: 'y' } }); return a.kind === 'rfb' && a.capabilities.objects === 'protocol' && b.kind === 'window' && b.capabilities.objects === 'vlm' && b.capabilities.input === 'os'; })());

// ---- 假伺服器做真的探測
const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));
(async () => {
  // RDP：Connection Request 帶 protocols；全部 → 選 NLA；Standard-only → 失敗
  const rdp = net.createServer((s) => { s.on('data', (d) => { const hasNeg = d.length >= 8 && d[d.length - 8] === 1; if (hasNeg) { const b = ccRsp(2); s.write(b); } else { const b = ccRsp(5); b[11] = 3; s.write(b); } }); s.on('error', () => {}); });
  const rdpPort = await listen(rdp);
  await t.acheck('probe RDP：辨識協定、NLA、Standard 不允許、誠實說明走 VLM 慢路徑', async () => { const r = await R.probeRemote('127.0.0.1:' + rdpPort, { which: () => '' }); return r.ok && r.kind === 'rdp' && r.details.selected === 2 && r.details.nla === true && r.details.standardRdpSecurityAllowed === false && r.capabilities.objects === 'vlm' && r.capabilities.input === 'os' && /VLM 慢路徑/.test(r.advice.join('')) && /NLA/.test(r.advice.join('')) && /沒有 xfreerdp/.test(r.advice.join('')); });
  await t.acheck('probe RDP：找得到 xfreerdp 時建議 remote_connect kind:rdp', async () => { const r = await R.probeRemote('127.0.0.1:' + rdpPort, { which: (n) => (n === 'xfreerdp' ? '/usr/bin/xfreerdp' : '') }); return /remote_connect kind:'rdp'/.test(r.advice.join('')) && r.details.clients.xfreerdp === '/usr/bin/xfreerdp'; });
  rdp.close();
  const rdp2 = net.createServer((s) => { s.on('data', (d) => { s.write(Buffer.from([3, 0, 0, 11, 6, 0xd0, 0, 0, 0x12, 0x34, 0])); }); s.on('error', () => {}); }); const rdp2Port = await listen(rdp2);
  await t.acheck('probe RDP：只支援 Standard Security → 警告', async () => { const r = await R.probeRemote('127.0.0.1:' + rdp2Port); return r.kind === 'rdp' && r.details.standardRdpSecurityAllowed === true && /Standard RDP Security/.test(r.advice.join('')); }); rdp2.close();
  // SPICE
  const spice = net.createServer((s) => { s.on('data', (d) => { if (d.toString('latin1', 0, 4) === 'REDQ') s.write(spiceRep); }); s.on('error', () => {}); }); const spPort = await listen(spice);
  await t.acheck('probe SPICE', async () => { const r = await R.probeRemote('127.0.0.1:' + spPort); return r.kind === 'spice' && r.details.major === 2 && /視覺模型慢路徑/.test(r.advice.join('')) && r.capabilities.objects === 'vlm'; }); spice.close();
  // NX、SSH 橫幅
  const nx = net.createServer((s) => { s.write('NXD-3.5.0-4\n'); s.on('error', () => {}); }); const nxPort = await listen(nx);
  await t.acheck('probe NX（橫幅）', async () => { const r = await R.probeRemote('127.0.0.1:' + nxPort); return r.kind === 'nx' && /NoMachine/.test(r.advice.join('')); }); nx.close();
  const ssh = net.createServer((s) => { s.write('SSH-2.0-OpenSSH_9.6\r\n'); s.on('error', () => {}); }); const sshPort = await listen(ssh);
  await t.acheck('probe SSH → 說明不是遠端桌面', async () => { const r = await R.probeRemote('127.0.0.1:' + sshPort); return r.kind === 'ssh' && /ssh -L/.test(r.advice.join('')); }); ssh.close();
  // HTTP（noVNC 頁面）
  const web = http.createServer((q, s) => { s.writeHead(200, { 'Content-Type': 'text/html', Server: 'websockify' }); s.end('<html><title>noVNC</title></html>'); }); const webPort = await listen(web);
  await t.acheck('probe HTTP：辨識 noVNC 頁面並提示 /websockify', async () => { const r = await R.probeRemote('127.0.0.1:' + webPort); return r.kind === 'http' && r.details.web === 'novnc' && /websockify/.test(r.advice.join('')); }); web.close();
  // 沒有開的埠
  await t.acheck('probe 連不上 → ok:false kind:closed 並給建議', async () => { const r = await R.probeRemote('127.0.0.1:65501'); return !r.ok && r.kind === 'closed' && r.advice.length > 0; });
  // RFB（TCP；VNC 驗證）
  const rfb = await startFakeRfb({ security: 'vnc', password: 'x' });
  await t.acheck('probe RFB（TCP）：版本、安全類型 VNC 驗證、內建用戶端可用', async () => { const r = await R.probeRemote('127.0.0.1:' + rfb.port); return r.kind === 'rfb' && r.details.version === '003.008' && JSON.stringify(r.details.securityTypes) === '[2]' && r.details.supported && r.capabilities.objects === 'protocol' && r.capabilities.input === 'protocol' && /secretName/.test(r.advice.join('')); }); rfb.close();
  const rfbT = await startFakeRfb({ security: 'tight' });
  await t.acheck('probe RFB：只有 Tight／TLS → 不支援，退到 vlm＋os', async () => { const r = await R.probeRemote('127.0.0.1:' + rfbT.port); return r.kind === 'rfb' && r.details.supported === false && r.capabilities.objects === 'vlm' && /Tight/.test(r.details.securityNames); }); rfbT.close();
  const rfb33 = await startFakeRfb({ version: '003.003' });
  await t.acheck('probe RFB 3.3', async () => { const r = await R.probeRemote('127.0.0.1:' + rfb33.port); return r.kind === 'rfb' && r.details.securityTypes[0] === 1; }); rfb33.close();
  // RFB over WebSocket（noVNC）
  const rfbWs = await startFakeRfb({ ws: true });
  await t.acheck('probe ws://（noVNC／websockify）：第一個訊息是 RFB 橫幅', async () => { const r = await R.probeRemote('ws://127.0.0.1:' + rfbWs.port + '/websockify'); return r.kind === 'rfb' && r.details.transport === 'websocket' && r.capabilities.objects === 'protocol'; }); rfbWs.close();
  await t.acheck('probe ws:// 連不上 → ok:false', async () => { const r = await R.probeRemote('ws://127.0.0.1:65501/x'); return !r.ok; });

  // ---- WebSocket 客戶端：大訊息（16-bit／64-bit 長度）、分片、ping、close
  await t.acheck('WebSocket：65535+ 位元組二進位訊息往返（64-bit 長度）、文字訊息、分片重組', async () => {
    const srv = http.createServer(); srv.on('upgrade', (req, sock) => { sock.write(WS.acceptHeader(req.headers['sec-websocket-key'])); const c = new WS.WsConn(sock, { mask: false }); c.on('message', (m, bin) => { if (bin) c.send(m); else c.send('echo:' + m); });
      // 分片：先送兩段
      setTimeout(() => { sock.write(Buffer.from([0x01, 3, 0x61, 0x62, 0x63])); sock.write(Buffer.from([0x80, 2, 0x64, 0x65])); }, 200); });
    const port = await listen(srv); const c = await WS.connectWs('ws://127.0.0.1:' + port + '/'); const got = [];
    c.on('message', (m, bin) => got.push([m, bin])); const big = Buffer.alloc(70000, 5); c.send(big); c.send('hi'); await new Promise((r) => setTimeout(r, 700)); c.close(); srv.close();
    return got.some(([m, b]) => b && m.length === 70000 && m[69999] === 5) && got.some(([m]) => m === 'echo:hi') && got.some(([m]) => m === 'abcde');
  });
  await t.acheck('WebSocket：升級被拒（不是 101）→ 錯誤', async () => { const srv = http.createServer((q, s) => { s.writeHead(400); s.end('nope'); }); const port = await listen(srv); try { await WS.connectWs('ws://127.0.0.1:' + port + '/'); return false; } catch (e) { return /升級失敗/.test(e.message); } finally { srv.close(); } });
  t.done();
})();
