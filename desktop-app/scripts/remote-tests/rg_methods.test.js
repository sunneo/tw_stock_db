// 遠端群組的函式清單：每次把新功能「插進」這幾個檔案時，容易不小心把別組功能的函式一起蓋掉（曾經發生過），
// 掉了的話要到實際點到那個功能才會發現。這個測試列出該存在的函式，少一個就失敗。
const path = require('path');
const D = require(path.join(__dirname, '../../renderer/src/remote/rg_dispatch.js'));
const H = require(path.join(__dirname, '../../renderer/src/remote/rg_host.js'));
const dispatch = ['_rgDispatch', '_rgTaskEnd', '_rgDelegate', '_rgRegisterTools', '_rgResolveMachine', '_rgOnEvent', '_rgOnMembersChange', '_rgOnTask', '_rgRunTask', '_rgEvent', '_rgOnSync', '_rgOnStop',
    '_rgSend', '_rgVerify', '_rgGate', '_rgClearTasks', '_rgSaveTask', '_rgLoadTasks', '_rgBuildRefs', '_rgPullRefs', '_rgFetchRemote', '_rgGetItemBlob', '_rgSaveItem', '_rgSaveDeck', '_rgOpenItem', '_rgShowBlob', '_rgProgressModal',
    '_rgCreateRemoteChat', '_rgChatRecord', '_rgPendingStore', '_rgPendingSave', '_rgLoadPending', '_rgSyncPending', '_rgAutoSave',
    '_rgAct', '_rgTrace', '_rgOnAct', '_rgSharedList', '_rgPushChats', '_rgToggleShare', '_rgSerChat', '_rgOnChatsReq', '_rgOnChatGet', '_rgOnChatSay', '_rgOnChatStop',
    '_rgAsk', '_rgResolveAsk', '_rgOnSettingsGet', '_rgOnSettingsSet', '_rgHookFileCache', '_rgPrefOf', '_rgSavePref'];
const host = ['_rgSettings', '_rgCreate', '_rgJoin', '_rgEnter', '_rgLeave', '_rgAfterEnter', '_rgRegister', '_rgScheduleReconnect', '_rgFailover', '_rgSwitchTo', '_rgScheduleFailback', '_rgMirrorRegister', '_rgBackendOrder', '_rgSlow',
    '_rgKeepAlive', '_rgAutoRejoin', '_rgSaveSession', '_rgOnMessage', '_rgPing', '_rgInstallUi', '_rgSyncTargetSelect', '_rgOpenMenu', '_rgOpenRules', '_rgRender', '_rgBuildJoined', '_rgRenderMembers', '_rgRenderActs', '_rgFocusAct',
    '_rgOpenFp', '_rgOpenLog', '_rgOpenRebuild', '_rgRebuild', '_rgOnRebuild', '_rgLoadIdentity', '_rgTrustState', '_rgRefreshFps', '_rgChatListSig', '_rgRenderChatListMachines', '_rgPickMachine',
    '_rgOnChats', '_rgRefreshRemoteChats', '_rgOpenRemoteChat', '_rgCloseRemoteView'];
let bad = [];
for (const n of dispatch) if (typeof D.methods[n] !== 'function') bad.push('rg_dispatch: ' + n);
for (const n of host) if (typeof H.methods[n] !== 'function') bad.push('rg_host: ' + n);
console.log(bad.length ? 'FAILED:\n  ' + bad.join('\n  ') : 'rg_methods: ' + (dispatch.length + host.length) + ' passed');
process.exit(bad.length ? 1 : 0);
