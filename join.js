// node join.js r2  -> rebuilds adapter_model.safetensors from parts and verifies sha256
const fs=require('fs'),c=require('crypto'),p=require('path');
const d=p.join(__dirname,process.argv[2]||'r2');const m=JSON.parse(fs.readFileSync(p.join(d,'manifest.json')));
const bufs=m.parts.map(x=>{const b=fs.readFileSync(p.join(d,x.file));if(b.length!==x.size||c.createHash('sha256').update(b).digest('hex')!==x.sha256)throw new Error('bad part '+x.file);return b;});
const all=Buffer.concat(bufs);if(c.createHash('sha256').update(all).digest('hex')!==m.sha256)throw new Error('bad total sha');
fs.writeFileSync(p.join(d,m.file),all);console.log('OK',m.file,all.length);
