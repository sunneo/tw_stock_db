// node join.js  -> 重組 plan-r4.fatrain 並核對 sha256
const fs=require('fs'),c=require('crypto'),p=require('path');const m=JSON.parse(fs.readFileSync(p.join(__dirname,'manifest.json')));
const h=(b)=>c.createHash('sha256').update(b).digest('hex');
const all=Buffer.concat(m.parts.map(x=>{const b=fs.readFileSync(p.join(__dirname,x.file));if(b.length!==x.size||h(b)!==x.sha256)throw new Error('bad part '+x.file);return b;}));
if(all.length!==m.size||h(all)!==m.sha256)throw new Error('bad total');fs.writeFileSync(p.join(__dirname,m.file),all);console.log('OK',m.file,all.length);
