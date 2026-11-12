// node renderer/src/studio/studio_viewer_tabs.test.js
// 詳情／瀏覽資料改開在「資產清單另一側」的可關閉分頁，且每個分頁有上一頁／下一頁歷史（接線檢查；真實操作用假 API 頁面在瀏覽器驗證過）。
const fs = require('fs'), path = require('path');
const T = fs.readFileSync(path.join(__dirname, 'studio-viewer.template.html'), 'utf8');
let ok = 0, bad = 0; const check = (n, c) => { if (c) ok++; else { bad++; console.log('FAIL ' + n); } };
check('有 openDetail／closeDetail', /function openDetail\(kind,name\)/.test(T) && /function closeDetail\(id\)/.test(T));
check('詳情分頁開在資產清單的另一側', /function detSide\(\)\{return L\.panes\.left\.indexOf\('assets'\)>=0\?'right':'left'\}/.test(T));
check('資產清單的按鈕改開分頁（不再塞進清單）', !/detail\(it\.kind,it\.name,body\)/.test(T) && (T.match(/openDetail\(it\.kind,it\.name\)/g) || []).length === 2);
check('分頁有關閉鈕', /closeDetail\(d\.id\)/.test(T) && /title:'關閉這個分頁'/.test(T));
check('每個分頁有歷史堆疊（hist／i）與上一頁下一頁', /hist:\[\{t:'asset'\}\],i:0/.test(T) && /function navDetail\(d,dir\)/.test(T) && /上一頁/.test(T) && /下一頁/.test(T));
check('點檔案是推一個新的歷史項（可回上一頁）', /pushView\(dt,\{t:'file',path:f\.path\}\)/.test(T));
check('Alt+左右鍵切換歷史', /e\.altKey/.test(T) && /ArrowLeft/.test(T) && /ArrowRight/.test(T));
check('詳情分頁不存進版面偏好（暫時的）', !/DT/.test(fs.readFileSync(path.join(__dirname, 'studio_layout_core.js'), 'utf8')));
check('右鍵選單：關閉／全部／其他／左側／右側', /Close All/.test(T) && /Close Others/.test(T) && /Close Left/.test(T) && /Close Right/.test(T) && /addEventListener\('contextmenu',function\(e\)\{e\.preventDefault\(\);dtMenu/.test(T));
check('只重畫詳情那一側（左邊清單不跳回開頭）並保留捲動位置', /render\(\[detSide\(\)\]\)/.test(T) && /oldB\.scrollTop/.test(T) && /body\.scrollTop=keep/.test(T));
check('訓練分頁有簡單／進階模式切換並記住選擇', /function setMode\(m\)/.test(T) && /fa_train_mode/.test(T) && /簡單模式/.test(T) && /進階模式/.test(T));
check('精靈：先問訓練／更新資產，再問資料來源（已匯入資產或新資料）', /function trainWizard\(host\)/.test(T) && /你想做什麼/.test(T) && /訓練的資料從哪裡來/.test(T) && /更新資產/.test(T) && /要更新哪一份資產/.test(T));
check('精靈用 datasetRef／fromAsset 開始訓練，不叫使用者輸入路徑', /datasetRef:W\.data\|\|undefined/.test(T) && /fromAsset:needsData\(W\.kind\)\?W\.data/.test(T));
console.log(ok + ' passed, ' + bad + ' failed'); process.exit(bad ? 1 : 0);
