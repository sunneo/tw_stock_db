# `/edit-3d-model`:3D 場景編輯器(相對視角擺放、樹狀物件、YAML 原始碼、單一物件貼皮)

> 2026-10-23。跟 `/edit-svg`、`/edit-picture` 同一套外框(`FaEditShell`:物件欄、屬性面板、底部常駐的 AI 對話框、記錄、復原／重做、整理成 prompt、匯出、視窗化),主體換成 3D 檢視器。來源是使用者提的需求(原本記在 TODO.md)。**全部在 client 端**,3D 用助理既有的 three.js 與場景建構(`_build3DMeshObject`,跟 `render_3d_scene` 同一套形狀與材質),所以編輯器裡看到的、匯出的、對話裡播放的是同一個東西。

## 開法
- `/edit-3d-model`(列出起手式 blank、room、model、studio)、`/edit-3d-model <起手式>`、`/edit-3d-model <一句話>`(開空白,編輯器自己的 AI 去做)、`/edit-3d-model last`(把對話裡最近的 3D 場景當起點);別名 `/edit-3d`。
- 對話裡任何一個 3D 場景(`render_3d_scene`、匯入的模型)的卡片上有 **✏️ 編輯**:開編輯器,編輯完用「↩ 更新回原本的場景」取代那個場景(「進編輯模式再退出,會更新回去」)。
- AI 工具 `edit_3d_open`(參數 starter／request／yaml／file_id／last／id;file_id 可以是 `.3dscene.yaml` 或 STL／OBJ／3MF／FBX 模型,模型走既有的 `_convertModelFileToSceneYaml`,只還原形狀與單一顏色);領域 `editors`;依任務補工具 `edit_3d_open`。
- 編輯器是對話裡的一則訊息 ```` ```fa-edit-3d {"id":…} ````,新開的預設彈出成視窗(`FaWin`),專案在 IndexedDB(`tw_edit`),**可以持續編輯**(重新整理、換對話再回來都從存好的進度接著改;每一步與復原位置都在)。

## 要先決定的四件事(TODO 原本要問使用者;這次先照下面做,理由寫在旁邊,要改再說)
1. **「相對視角」的座標系 → 以目前相機為準。** 「前方」是相機看過去的方向(投影在地面)、「右」是前方的右手邊;使用者轉了視角,同一句「我的左前方」就放到另一個地方(測試:相機在 +z 看 −z、與相機在 +x 看 −x,各放一次,位置確實不同)。場景另存一個「預設視角」(📷 存成預設視角),匯出與重新開啟用它;AI 問答時用的是**當下**的相機。
2. **貼圖的 UV → 內建 UV 加「分面貼皮」。** 整個物件貼圖用 `material.texture`(內建名 water／grass／sand／wood／brick 或自己的圖);要「哪個位置貼什麼圖」就用貼皮(skin):方塊的六個面、圓柱的頂／底面、平面的正面,貼皮輸出成一片貼在那個面上的薄平面(所以匯出的場景任何地方都播得出來);球、圓環、圓錐與圓柱的側面是曲面,貼皮在輸出時**烘進一張貼圖**(畫布合成,基底顏色加每一層的位置)。不做逐頂點 UV 展開編輯。
3. **匯入模型(obj／glb)→ 第一版只做 STL／OBJ／3MF／FBX 走既有轉換**(`file_id` 或 `/import-3d-model`),形狀與單一顏色進來變成 `polygon` 物件(之後可以移動、縮放、上色、群組);glb 沒做。
4. **「有效 prompt」的判定 → 沒被復原、而且真的改變了場景的那幾輪**(跟 /edit-svg 一樣:`effectiveSteps`),每輪附使用者說的話與程式整理的結果(位置用「我的…」的說法,所以重現時要說明當時的視角)。

## 文件(`edit3d_core.js`,`FaEdit3d`,純函式;`node scripts/edit-tests/edit3d_core.test.js` 59 項)
```
spec = { v:1, title, background, camera:{position, look_at, fov}, seq, objects:[ … ] }      objects 的順序就是物件欄的樹狀順序(父在前、子在後)
 每個物件都有 id、name、parent(群組的 id 或 null)、visible、locked
 mesh   { mesh:'box|sphere|cylinder|cone|plane|torus|polygon|particles|line', position, rotation(弧度), size|radius|height|tube_radius, material:{color,metalness,roughness,opacity,emissive,texture,texture_repeat,side}, skins:[…], extra:{其他欄位原樣保留(頂點、粒子、動畫…)} }
 group  { position, rotation, scale }          子物件的座標是相對於群組;縮放只有等比
 light  { light:'directional|point|ambient', position, intensity, color }
```
- **世界座標與盒子**:`worldT` 把父層的位置／旋轉／縮放一路乘下來(Euler XYZ,跟 three.js 同一個順序,測試對過);`worldBox` 是物件(群組=裡面所有東西)的世界軸對齊盒子。
- **相對放置** `place:{of:'me|view|origin|selection|<id|名字>', rel:'front|back|left|right|left-front|right-front|left-back|right-back|above|on|below|inside|center|beside', dist, gap, dx, dy, dz}`:
  `of:'me'`=相機在地面的位置,往 rel 的方向走 `dist`(預設相機到視線中心水平距離的 0.6,夾在 1.5～10);`of:'view'`=視線中心;`of:<物件>`=它的盒子:above 把新東西的底放在它的頂、右／左／前／後把新東西貼在它那一側(不重疊、底對齊,間距 0.05);沒說位置就放在畫面中間,**中間已經有東西就往我的右邊讓**;`dx/dy/dz` 最後加上去(往我的右／上／前)。位置詞錯了就說明原因、什麼都不加。
- **封閉動作**:set_title、set_background、set_camera(preset front/back/left/right/top/iso、position、look_at、fov、zoom)、add_object、update_object、remove_object(群組連裡面的東西)、rename_object、move_object(同一層裡調順序)、set_visible、set_locked、duplicate_object(群組連零件、複本往我的右邊讓)、clear_objects、place_object、transform_object(move=我的右／上／前、move_world、turn／tilt／roll 度、rotate_deg、scale)、group_objects(保持世界位置、只能同一層)、ungroup、set_parent(保持世界位置)、set_material(群組=裡面全部)、add_skin／update_skin／remove_skin／clear_skins／set_skins、drop_to_ground、align_objects;宿主執行的:find_picture、generate_image(結果變成貼圖)。每個動作單獨驗證,壞的回 `rejected`(含原因)且不動到文件。
- **程式先讀的中文**(`parseCommands`,不叫模型):「在我的左前方放一個紅色的球」「放一個藍色方塊在桌子上面」「在畫面中間加兩個綠色圓柱」「把桌子移到地板的右邊」「把桌子往左移 2 公尺」「轉 90 度」「放大一倍」「把桌面改成紅色」「刪除／隱藏／鎖定／複製／改名」「視角切到上面」「背景改成黑色」「把…綁成群組」。讀不懂的句子才交給模型;模型的提示詞帶著**當下的視角(前方與右邊的世界座標)**與整棵物件樹,只准回上面的封閉動作。
- **YAML**(`toYaml`／`fromYaml`):原始碼分頁的格式是 `render_3d_scene` 的格式再加 `id`、`name`、`parent`、`mesh: group`、`hidden`、`locked`、`skins`(燈光在 `lights:`,也有 id 與 name);`fromYaml` 兩種都讀(沒有 id 的一般場景、`defs`＋`use` 會展開成物件;polygon、粒子、動畫等欄位原樣留在 `extra`)。**匯出「場景 YAML」(`toScene`／`toSceneYaml`)是展平的**:群組攤開(位置、旋轉、縮放烘進每個節點)、隱藏的不輸出、貼皮變成薄平面、曲面貼皮烘成貼圖、`ref:…` 展開成 data URL,結果通過 `_validate3DSceneYaml` 的嚴格驗證且 `_mount3DScene` 播得出來(eval 驗過)。

## 畫面(`edit3d_ui.js`,`FaEdit3dUI`)
- **場景分頁**:三維檢視器(OrbitControls:拖曳轉、滾輪縮放、右鍵平移);點物件選取(Alt＋點選它的群組)、拖曳移動(✥,在物件所在高度的水平面上;Shift 上下)、⟳ 左右拖曳繞垂直軸轉、⤢ 上下拖曳縮放;放開才是一步(復原一次回去);燈光有小標記可以點選;選取框、格線(▦)、⌖ 看全部、📷 存成預設視角。沒有 WebGL 的機器改用助理的 CPU 光柵化(`_raster3DFrame`,沒有貼圖),再不行就只剩物件欄／屬性面板／YAML。
- **物件欄是樹狀的**(縮排、▾／▸ 收合群組、▲▼ 在同層調順序、⧉ 複製、🗑 刪除);**雙擊物件(或畫面裡的物件)進單一物件編輯**。屬性面板:名稱、位置、旋轉(度)、大小／半徑／高度、顏色／金屬感／粗糙度／不透明度、整個物件的貼圖(內建名或自己的圖)與重複、燈光的種類／顏色／強度,沒選東西時是場景(標題、背景、視角廣度、預設視角)。
- **🧾 YAML 原始碼分頁**:可以直接改;**切回「場景」分頁(或按「套用並看畫面」)就套用並立刻呈現**(一步);YAML 有錯就留在原分頁並顯示原因。
- 匯出:場景 YAML(可直接播放;也可「放進對話」成可轉動的場景)、PNG 截圖、專案 YAML(下載);整理成 prompt。

## 單一物件編輯(`edit3d_part_core.js`,`FaEdit3dPart`;`edit3d_part_core.test.js` 19 項)
像做塑膠模型(GK):一個物件、它的底色與材質、一層一層的貼皮。**貼皮就是這個編輯器的圖層**(物件欄、屬性、復原／重做、AI 對話、整理成 prompt 與場景編輯器同一套外框),在自己的視窗裡,有自己的歷史與對話。
- 貼皮 `{zone, image|color, u, v(中心 0..1,v 往上,從外面看)、w、h(占那一面的比例)、rotate、opacity}`;面(zone)依形狀:方塊 ±x／±y／±z(前=+z,左右上下是從外面看)、圓柱 side／top／bottom、圓錐 side／bottom、球與圓環 wrap、平面 front。
- 模型上**點一下**,選取的那層貼皮就移到你點的地方(也會換到那一面;沒有選取貼皮時,只顯示點到哪一面與 u、v);選取的貼皮在模型上有藍色外框。
- 說的:「把前面塗成紅色，上面漆成藍色」「底色改成白色」「把它放大一倍／往右移／轉 45 度／變半透明／移到右上角」;**圖直接貼進對話框**(或給網址、「找一張…的圖」、生圖),再說「貼在右面的右上角」就貼到那裡;其餘交給模型(`image:"attached"`＝剛貼的圖)。
- **「✔ 完成，交回場景」**把貼皮與底材質交回場景的那個物件(場景的一步:`set_skins`,可以在場景復原);「✕ 放棄修改」丟掉。進度自己存(`edit-3d-part` 專案):再開同一個物件時,如果場景裡那個物件的貼皮沒被別處改過,就接著上次的狀態(含歷史);被改過就重新從場景的物件開始。

## 桌面版主機轉接層(`edit3d_host.js`)
`_edAsk3d`(貼進來的圖、網址、找圖 → 貼在選取的(或名字說到的)物件的某一面或整個物件上,都沒有就做成一張立在畫面中間的圖片;其餘走模型,取得當下視角用 `el._ed.env()`)、`_ed3dKeepTexture`(圖縮到 512 px 存一份,場景只記 `ref:…`)、`_ed3dOpenPart`(視窗、存檔、完成交回)、`_ed3dOpen`(yaml／file_id／last／starter)、`_ed3dToChatScene`、`_ed3dUpdateOrigin`。

## 驗證與限制
- `node scripts/edit-tests/edit3d_core.test.js`(59)、`edit3d_part_core.test.js`(19)(在 `run-core-tests.js` 裡)。
- 真實 Electron(WebGL 用 swiftshader;假的 LLM／VLM／生圖):`scripts/eval/edit3d.eval.js`(45 項)——開啟與掛載、WebGL、樹狀(縮排與收合)、「在我的左前方放一個紅色的球」(不叫模型、位置對相機、轉了視角放到另一邊)、「把藍色方塊移到桌子上面」(底對桌面頂)、模型路徑、復原／重做、**點物件選取與拖曳移動**(合成的 pointer 事件)、YAML 分頁(內容、改了背景切回畫面立刻變、壞的 YAML 留在原分頁)、貼圖(存在 IndexedDB)、單一物件編輯(視窗、說話塗色、貼圖貼在右上角、**點模型移動貼皮**、復原、完成交回場景成一步、場景復原)、**曲面貼皮烘成貼圖**、匯出的場景通過嚴格驗證並用 `_mount3DScene` 播出來、專案存起來後**從 IndexedDB 真的重新掛載一份**、「✏️ 編輯」→「更新回原本的場景」、`yaml`／斜線指令／工具／依任務補工具。
- **沒驗證**:真實 LLM 把話翻成動作的品質(只用假模型);真實 GPU(用軟體 GL 驗畫面);匯入的真實 OBJ／STL 模型走編輯器(轉換器是既有的,沒有在編輯器裡跑過);粒子與動畫節點只保留、不在編輯器裡預覽(編輯器畫面是靜態的);很大的模型(幾十萬三角形)的效能;單一物件編輯的滑鼠拖曳旋轉(只驗證了點選);英文介面(3D 畫面的字只有中文)。
- **已知限制**:群組縮放只有等比;群組的旋轉與子物件旋轉合成後,「轉 N 度」是在物件自己的軸上加(傾斜過的物件會看起來不是繞垂直軸);曲面貼皮的圖片在曲面上會被拉伸(沒有展開);glb 沒做;燈光可以放進群組(位置跟著群組走);場景只有一台相機。
