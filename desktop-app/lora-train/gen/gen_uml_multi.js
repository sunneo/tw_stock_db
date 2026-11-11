// gen/gen_uml_multi.js — domain "uml_design"（多情境版）
//
// gen_uml_design.js 只有一個固定情境（書店），actors／classes 各 1 列、members／relations 各 4 列。
// 這支用同樣的做法（真的跑 uml_core.js 的 scenarioToModel，攔截它自己組的 messages），
// 但換成多個情境，每個情境有手寫的答案表；每個情境跑完後要通過 U.validateModel() 0 個錯誤才收，
// 不合法就整個情境丟掉並在 stderr 說明（答案由程式驗證，不是另外生成的猜測）。
// 情境與答案是本檔自己寫的資料（不是從測試檔抄的）；split 一律 train，凍結的留出檔不動。
const path = require('path');
const U = require(path.join(__dirname, '..', '..', 'renderer', 'src', 'uml', 'uml_core.js'));

// 每個情境：actors/usecases/classes/members/relations/seq
const S = [];
const sc = (scenario, o) => S.push(Object.assign({ scenario }, o));
const A = (name, type) => ({ name, type });
const op = (name, params, returns) => ({ name, params: params || [], returns: returns || 'void' });

sc('讀者可以搜尋圖書館的書、借書和還書，館員可以新增館藏並處理逾期罰款。', {
    actors: ['Reader', 'Librarian'],
    usecases: [{ name: 'BorrowBook', actor: 'Reader', summary: '借書' }, { name: 'AddHolding', actor: 'Librarian', summary: '新增館藏' }],
    classes: [['Book', 'class', '書'], ['Loan', 'class', '借閱紀錄'], ['Fine', 'class', '罰款'], ['LoanStatus', 'enum', '借閱狀態']],
    members: { Book: { attrs: [A('title', 'str'), A('isbn', 'str')], ops: [] }, Loan: { attrs: [A('book', 'Book'), A('due', 'date')], ops: [op('renew', [], 'bool'), op('close', [], 'void')] }, Fine: { attrs: [A('amount', 'decimal')], ops: [op('pay', [A('amount', 'decimal')], 'bool')] }, LoanStatus: ['OPEN', 'RETURNED', 'OVERDUE'] },
    relations: { Loan: [['Book', 'assoc'], ['Fine', 'compose']] },
    seq: { BorrowBook: [['Loan', 'renew']], AddHolding: [['Book', 'register']] },
});
sc('病人可以預約門診並查看看診紀錄，醫師可以開立處方。', {
    actors: ['Patient', 'Doctor'],
    usecases: [{ name: 'BookVisit', actor: 'Patient', summary: '預約門診' }, { name: 'Prescribe', actor: 'Doctor', summary: '開立處方' }],
    classes: [['Appointment', 'class', '掛號'], ['Prescription', 'class', '處方'], ['Billable', 'interface', '可計費'], ['VisitState', 'enum', '看診狀態']],
    members: { Appointment: { attrs: [A('time', 'datetime')], ops: [op('confirm', [], 'bool'), op('cancel', [], 'void')] }, Prescription: { attrs: [A('drug', 'str'), A('dose', 'int')], ops: [op('issue', [], 'void')] }, Billable: { attrs: [], ops: [op('charge', [A('amount', 'decimal')], 'bool')] }, VisitState: ['BOOKED', 'DONE', 'CANCELLED'] },
    relations: { Appointment: [['Prescription', 'aggregate'], ['Billable', 'implement']], Prescription: [['Billable', 'depend']] },
    seq: { BookVisit: [['Appointment', 'confirm']], Prescribe: [['Prescription', 'issue'], ['Billable', 'charge']] },
});
sc('駕駛進出停車場時領取與繳回停車票，管理員可以調整費率。', {
    actors: ['Driver', 'Manager'],
    usecases: [{ name: 'Park', actor: 'Driver', summary: '停車' }, { name: 'SetRate', actor: 'Manager', summary: '調整費率' }],
    classes: [['Ticket', 'class', '停車票'], ['Rate', 'class', '費率'], ['Gate', 'class', '閘門'], ['TicketState', 'enum', '票狀態']],
    members: { Ticket: { attrs: [A('entered', 'datetime'), A('plate', 'str')], ops: [op('fee', [], 'decimal')] }, Rate: { attrs: [A('perHour', 'decimal')], ops: [op('update', [A('value', 'decimal')], 'void')] }, Gate: { attrs: [], ops: [op('open', [], 'void'), op('issue', [], 'Ticket')] }, TicketState: ['ACTIVE', 'PAID'] },
    relations: { Gate: [['Ticket', 'assoc']], Ticket: [['Rate', 'depend']] },
    seq: { Park: [['Gate', 'issue'], ['Ticket', 'fee'], ['Gate', 'open']], SetRate: [['Rate', 'update']] },
});
sc('學生可以選課與查成績，老師可以登錄成績，系辦可以開課。', {
    actors: ['Student', 'Teacher', 'Office'],
    usecases: [{ name: 'Enroll', actor: 'Student', summary: '選課' }, { name: 'Grade', actor: 'Teacher', summary: '登錄成績' }, { name: 'OpenCourse', actor: 'Office', summary: '開課' }],
    classes: [['Course', 'class', '課程'], ['Enrollment', 'class', '選課紀錄'], ['Person', 'class', '人員'], ['Student', 'class', '學生']],
    members: { Course: { attrs: [A('name', 'str'), A('credits', 'int')], ops: [op('open', [], 'void')] }, Enrollment: { attrs: [A('score', 'Optional<float>')], ops: [op('record', [A('score', 'float')], 'void')] }, Person: { attrs: [A('name', 'str')], ops: [] }, Student: { attrs: [A('studentNo', 'str')], ops: [op('enroll', [A('course', 'Course')], 'bool')] } },
    relations: { Student: [['Person', 'inherit'], ['Enrollment', 'assoc']], Enrollment: [['Course', 'assoc']] },
    seq: { Enroll: [['Student', 'enroll'], ['Enrollment', 'record']], Grade: [['Enrollment', 'record']], OpenCourse: [['Course', 'open']] },
});
sc('客戶可以開戶、存款、提款和轉帳，行員可以凍結帳戶。', {
    actors: ['Customer', 'Teller'],
    usecases: [{ name: 'Transfer', actor: 'Customer', summary: '轉帳' }, { name: 'Freeze', actor: 'Teller', summary: '凍結帳戶' }],
    classes: [['Account', 'class', '帳戶'], ['Transaction', 'class', '交易'], ['Auditable', 'interface', '可稽核'], ['AccountState', 'enum', '帳戶狀態']],
    members: { Account: { attrs: [A('balance', 'decimal'), A('owner', 'str')], ops: [op('deposit', [A('amount', 'decimal')], 'void'), op('withdraw', [A('amount', 'decimal')], 'bool'), op('freeze', [], 'void')] }, Transaction: { attrs: [A('amount', 'decimal'), A('at', 'datetime')], ops: [] }, Auditable: { attrs: [], ops: [op('audit', [], 'str')] }, AccountState: ['ACTIVE', 'FROZEN'] },
    relations: { Account: [['Transaction', 'compose'], ['Auditable', 'implement']] },
    seq: { Transfer: [['Account', 'withdraw'], ['Account', 'deposit']], Freeze: [['Account', 'freeze']] },
});
sc('旅客可以搜尋房間並訂房，櫃台可以辦理入住與退房。', {
    actors: ['Guest', 'Clerk'],
    usecases: [{ name: 'Reserve', actor: 'Guest', summary: '訂房' }, { name: 'CheckIn', actor: 'Clerk', summary: '入住' }],
    classes: [['Room', 'class', '房間'], ['Reservation', 'class', '訂單'], ['RoomType', 'enum', '房型']],
    members: { Room: { attrs: [A('number', 'str'), A('price', 'decimal')], ops: [op('isFree', [A('day', 'date')], 'bool')] }, Reservation: { attrs: [A('from', 'date'), A('to', 'date')], ops: [op('confirm', [], 'bool'), op('checkIn', [], 'void')] }, RoomType: ['SINGLE', 'DOUBLE', 'SUITE'] },
    relations: { Reservation: [['Room', 'assoc']] },
    seq: { Reserve: [['Room', 'isFree'], ['Reservation', 'confirm']], CheckIn: [['Reservation', 'checkIn']] },
});
sc('客人可以看菜單點餐並結帳，廚師可以查看待做的餐點。', {
    actors: ['Diner', 'Cook'],
    usecases: [{ name: 'Order', actor: 'Diner', summary: '點餐' }, { name: 'Prepare', actor: 'Cook', summary: '備餐' }],
    classes: [['MenuItem', 'class', '菜色'], ['OrderLine', 'class', '餐點明細'], ['Bill', 'class', '帳單'], ['OrderState', 'enum', '訂單狀態']],
    members: { MenuItem: { attrs: [A('name', 'str'), A('price', 'decimal')], ops: [] }, OrderLine: { attrs: [A('item', 'MenuItem'), A('qty', 'int')], ops: [op('total', [], 'decimal')] }, Bill: { attrs: [A('lines', 'List<OrderLine>')], ops: [op('pay', [], 'bool'), op('sum', [], 'decimal')] }, OrderState: ['NEW', 'COOKING', 'SERVED'] },
    relations: { Bill: [['OrderLine', 'compose']], OrderLine: [['MenuItem', 'assoc']] },
    seq: { Order: [['OrderLine', 'total'], ['Bill', 'sum'], ['Bill', 'pay']], Prepare: [['OrderLine', 'total']] },
});
sc('使用者可以建立待辦事項、設定提醒並標記完成，也可以把事項分組。', {
    actors: ['User'],
    usecases: [{ name: 'AddTask', actor: 'User', summary: '建立待辦' }, { name: 'Complete', actor: 'User', summary: '標記完成' }],
    classes: [['Task', 'class', '待辦事項'], ['Group', 'class', '分組'], ['Reminder', 'class', '提醒'], ['Priority', 'enum', '優先級']],
    members: { Task: { attrs: [A('title', 'str'), A('done', 'bool')], ops: [op('complete', [], 'void')] }, Group: { attrs: [A('name', 'str'), A('tasks', 'List<Task>')], ops: [op('add', [A('task', 'Task')], 'void')] }, Reminder: { attrs: [A('at', 'datetime')], ops: [op('fire', [], 'void')] }, Priority: ['LOW', 'MID', 'HIGH'] },
    relations: { Group: [['Task', 'aggregate']], Task: [['Reminder', 'compose']] },
    seq: { AddTask: [['Task', 'create'], ['Group', 'add']], Complete: [['Task', 'complete']] },
});
sc('買家可以瀏覽商品並下單，賣家可以上架與出貨，平台會抽成。', {
    actors: ['Buyer', 'Seller'],
    usecases: [{ name: 'PlaceOrder', actor: 'Buyer', summary: '下單' }, { name: 'Ship', actor: 'Seller', summary: '出貨' }],
    classes: [['Product', 'class', '商品'], ['Order', 'class', '訂單'], ['Payable', 'interface', '可付款'], ['Shipment', 'class', '出貨單']],
    members: { Product: { attrs: [A('name', 'str'), A('stock', 'int')], ops: [op('reserve', [A('qty', 'int')], 'bool')] }, Order: { attrs: [A('items', 'List<Product>'), A('total', 'decimal')], ops: [op('pay', [A('amount', 'decimal')], 'bool'), op('place', [], 'void')] }, Payable: { attrs: [], ops: [op('pay', [A('amount', 'decimal')], 'bool')] }, Shipment: { attrs: [A('trackingNo', 'str')], ops: [op('dispatch', [], 'void')] } },
    relations: { Order: [['Product', 'aggregate'], ['Payable', 'implement'], ['Shipment', 'assoc']] },
    seq: { PlaceOrder: [['Product', 'reserve'], ['Order', 'place'], ['Order', 'pay']], Ship: [['Shipment', 'dispatch']] },
});
sc('成員可以在聊天室發訊息，管理者可以建立聊天室與封鎖成員。', {
    actors: ['Member', 'Admin'],
    usecases: [{ name: 'Send', actor: 'Member', summary: '發訊息' }, { name: 'Ban', actor: 'Admin', summary: '封鎖成員' }],
    classes: [['Room', 'class', '聊天室'], ['Message', 'class', '訊息'], ['Notifier', 'interface', '通知者'], ['Role', 'enum', '角色']],
    members: { Room: { attrs: [A('name', 'str'), A('messages', 'List<Message>')], ops: [op('post', [A('message', 'Message')], 'void'), op('ban', [A('user', 'str')], 'void')] }, Message: { attrs: [A('text', 'str'), A('at', 'datetime')], ops: [] }, Notifier: { attrs: [], ops: [op('notify', [A('text', 'str')], 'void')] }, Role: ['MEMBER', 'ADMIN'] },
    relations: { Room: [['Message', 'compose'], ['Notifier', 'depend']] },
    seq: { Send: [['Room', 'post'], ['Notifier', 'notify']], Ban: [['Room', 'ban']] },
});
sc('倉管可以收貨入庫與出貨，採購可以建立採購單。', {
    actors: ['Keeper', 'Buyer'],
    usecases: [{ name: 'Receive', actor: 'Keeper', summary: '收貨' }, { name: 'Purchase', actor: 'Buyer', summary: '採購' }],
    classes: [['Item', 'class', '貨品'], ['StockMove', 'class', '進出紀錄'], ['PurchaseOrder', 'class', '採購單'], ['MoveKind', 'enum', '進出種類']],
    members: { Item: { attrs: [A('sku', 'str'), A('qty', 'int')], ops: [op('adjust', [A('delta', 'int')], 'void')] }, StockMove: { attrs: [A('delta', 'int'), A('at', 'datetime')], ops: [op('apply', [], 'void')] }, PurchaseOrder: { attrs: [A('lines', 'List<Item>')], ops: [op('submit', [], 'bool')] }, MoveKind: ['IN', 'OUT'] },
    relations: { StockMove: [['Item', 'assoc']], PurchaseOrder: [['Item', 'aggregate']] },
    seq: { Receive: [['StockMove', 'apply'], ['Item', 'adjust']], Purchase: [['PurchaseOrder', 'submit']] },
});
sc('司機可以接單並載客，乘客可以叫車與評價。', {
    actors: ['Rider', 'Driver'],
    usecases: [{ name: 'Hail', actor: 'Rider', summary: '叫車' }, { name: 'Accept', actor: 'Driver', summary: '接單' }],
    classes: [['Trip', 'class', '行程'], ['Rating', 'class', '評價'], ['Vehicle', 'class', '車輛'], ['TripState', 'enum', '行程狀態']],
    members: { Trip: { attrs: [A('from', 'str'), A('to', 'str')], ops: [op('request', [], 'void'), op('accept', [A('vehicle', 'Vehicle')], 'bool'), op('finish', [], 'void')] }, Rating: { attrs: [A('stars', 'int')], ops: [] }, Vehicle: { attrs: [A('plate', 'str')], ops: [] }, TripState: ['REQUESTED', 'RUNNING', 'DONE'] },
    relations: { Trip: [['Vehicle', 'assoc'], ['Rating', 'aggregate']] },
    seq: { Hail: [['Trip', 'request']], Accept: [['Trip', 'accept'], ['Trip', 'finish']] },
});

function makeScript(o) {
    const byName = Object.fromEntries(o.classes.map((c) => [c[0], c]));
    return (messages) => {
        const sys = messages[0].content;
        const nameIn = (/「([^」]+)」/.exec(sys) || [])[1];
        if (/參與者（人或外部系統）/.test(sys)) return JSON.stringify({ actors: o.actors, usecases: o.usecases });
        if (/找出系統需要的類別/.test(sys)) return JSON.stringify({ classes: o.classes.map((c) => ({ name: c[0], kind: c[1], label: c[2] })) });
        if (/列出屬性與操作/.test(sys)) {
            const m = o.members[nameIn];
            if (Array.isArray(m)) return JSON.stringify({ values: m });
            return JSON.stringify(m || { attrs: [], ops: [] });
        }
        if (/跟其他類別的關係/.test(sys)) return JSON.stringify({ relations: (o.relations[nameIn] || []).map((r) => ({ to: r[0], kind: r[1] })) });
        if (/呼叫順序/.test(sys)) return JSON.stringify({ steps: (o.seq[nameIn] || []).map((s) => ({ to: s[0], op: s[1] })) });
        return '{}';
    };
}
const STAGE_PATTERNS = [[/參與者（人或外部系統）/, 'uml_actors'], [/找出系統需要的類別/, 'uml_classes'], [/列出屬性與操作/, 'uml_members'], [/跟其他類別的關係/, 'uml_relations'], [/呼叫順序/, 'uml_sequence']];

async function generate() {
    const rows = []; const skipReasons = [];
    for (let si = 0; si < S.length; si++) {
        const o = S[si]; const script = makeScript(o); const captured = [];
        const wrapped = async (a) => {
            const c = script(a.messages); const hit = STAGE_PATTERNS.find(([re]) => re.test(a.messages[0].content));
            if (hit) captured.push({ messages: a.messages, completion: c, stage: hit[1] });
            return c;
        };
        let res;
        try { res = await U.scenarioToModel(o.scenario, { program: false, generate: wrapped, thinkStack: false }); } catch (e) { res = { ok: false, err: String(e) }; }
        const errs = res.ok ? U.validateModel(res.model) : ['pipeline 沒有成功 ' + (res.err || '')];
        if (!res.ok || errs.length) { skipReasons.push('情境' + si + ' 丟棄：' + JSON.stringify(errs).slice(0, 160)); continue; }
        let i = 0;
        for (const c of captured) {
            i++;
            const label = (/「([^」]+)」/.exec(c.messages[0].content) || [])[1] || '';
            rows.push({ id: 'uml_design:multi' + si + ':' + c.stage + ':' + i, domain: 'uml_design', stage: c.stage, messages: c.messages, completion: c.completion, verified_by: 'program_ground_truth', split: 'train', source_file: 'lora-train/gen/gen_uml_multi.js', meta: { scenario: o.scenario, label, pipeline: 'scenarioToModel', thinkStack: false } });
        }
    }
    const by = {}; for (const r of rows) by[r.stage] = (by[r.stage] || 0) + 1;
    process.stderr.write('[gen_uml_multi] ' + S.length + ' 情境，產生 ' + rows.length + ' 筆：' + JSON.stringify(by) + (skipReasons.length ? '；' + skipReasons.join(' | ') : '') + '\n');
    return rows;
}
module.exports = { generate };
if (require.main === module) (async () => { for (const r of await generate()) process.stdout.write(JSON.stringify(r) + '\n'); })();
