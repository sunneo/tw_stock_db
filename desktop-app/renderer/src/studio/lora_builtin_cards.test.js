// 內建 LoRA 卡片的 HTML（DESIGN §33 批 3）：用途、把關原因、限制跳脫、刪除／下載按鈕、網頁版文字、總開關停用。
'use strict';
const LM=require('./lora_manage_core.js');
let ok=0,bad=[];const check=(n,c,x)=>{if(c)ok++;else{bad.push(n);console.log('FAIL',n,JSON.stringify(x||'').slice(0,300))}};
const html=LM.builtinCardsHTML({ok:true,available:true,master:true,source:'network',entries:[
 {id:'reading-r4',name:'reading-r4',purpose:'閱讀理解',evalSummary:'評測數字齊全',gatePass:true,note:'',downloaded:true,downloadedBytes:40375200,enabled:true,sizeMB:40.4,limits:['只量代表題 <script>x</script>'],failed:'',progress:null},
 {id:'plan-r4',name:'plan-r4',purpose:'規劃',evalSummary:'',gatePass:false,note:'未通過把關或未驗證：self_validate 單邊退化',downloaded:false,enabled:true,sizeMB:40,limits:[],failed:'連不上 GitHub',progress:null}]});
check('cards: two names', html.indexOf('reading-r4')>=0&&html.indexOf('plan-r4')>=0);
check('cards: gate reason shown', html.indexOf('被把關擋下')>=0&&html.indexOf('self_validate 單邊退化')>=0);
check('cards: escaped limit', html.indexOf('<script>x</script>')<0&&html.indexOf('&lt;script&gt;')>=0);
check('cards: delete for downloaded, fetch for not', html.indexOf('data-builtin-action="delete" data-id="reading-r4"')>=0&&html.indexOf('data-builtin-action="fetch" data-id="plan-r4"')>=0);
check('cards: failure reason', html.indexOf('上次下載失敗')>=0);
const web=LM.builtinCardsHTML({ok:false,available:false,message:'只有桌面版啟用'});
check('web: only desktop text', web.indexOf('只有桌面版啟用')>=0&&web.indexOf('data-builtin-action')<0, web);
const off=LM.builtinCardsHTML({ok:true,available:true,master:false,entries:[{id:'a',name:'a',purpose:'p',gatePass:true,downloaded:false,enabled:false,sizeMB:40,limits:[]}]});
check('master off disables per-card toggle', off.indexOf('disabled')>=0);
console.log('lora_builtin_cards: '+ok+' 通過，'+bad.length+' 失敗');process.exit(bad.length?1:0);
