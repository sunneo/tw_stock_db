/* 訓練工作室：領域規格的示範（UMD，純資料）。用途：精靈的「載入範例」、端到端測試、內建化往返的示範領域。
 * 兩個極小領域：blockly「奇偶計數」（讀題規則＋一個帶槽位的骨架＋train／holdout 家族）、matrix「線性同餘與回文」（兩個操作＋題目）。
 * 全部自行撰寫，授權 MIT。 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.FaStudioDomainDemo = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';
    const META = { license: 'MIT', source: 'FloatingAssistant 訓練工作室內建示範（自行撰寫）', author: 'floating-assistant', description: '示範領域，用來驗證「新增領域→評量→匯出→內建化」整條流程' };
    const blockly = () => ({
        format: 'fa-domain-spec', version: 1, kind: 'blockly', id: 'demo-parity', label: '示範：奇偶計數', seed: 20261111, meta: Object.assign({}, META),
        algos: [{ key: 'demo-parity-count', any: ['偶數', '奇數'], all: ['個數'] }],
        judge: { checker: 'tokens' },
        skeletons: [{
            id: 'demo.parity-count', algo: 'demo-parity-count', paradigm: 'user-demo-parity', label: '迴圈計數：餘數等於某值的個數',
            slots: [{ id: 'par', label: '要數的餘數', options: [{ id: '0', v: '0' }, { id: '1', v: '1' }] }],
            lines: ['cnt_ = 0', 'for v_ in {{N.ls.0}}:', '    if v_ % 2 == {{c.par}}:', '        cnt_ += 1', 'print(cnt_)']
        }],
        families: [
            { id: 'even-count', algo: 'demo-parity-count', split: 'train', want: 'user-demo-parity',
                statements: ['第一行 n，第二行 n 個整數。請輸出這些整數中偶數的個數。', '第一行 n，第二行 n 個整數。統計其中偶數的個數並輸出。'],
                ref: 'n = int(input())\na = list(map(int, input().split()))\nprint(sum(1 for x in a if x % 2 == 0))',
                gen: [[{ name: 'n', int: [1, 8], big: [20, 60] }], [{ name: 'a', ints: { len: 'n', range: [-20, 50] } }]] },
            { id: 'odd-count', algo: 'demo-parity-count', split: 'holdout', want: 'user-demo-parity',
                statements: ['第一行 n，第二行 n 個整數。請輸出這些整數中奇數的個數。'],
                ref: 'n = int(input())\na = list(map(int, input().split()))\nprint(sum(1 for x in a if x % 2 != 0))',
                gen: [[{ name: 'n', int: [1, 8], big: [20, 60] }], [{ name: 'a', ints: { len: 'n', range: [-20, 50] } }]] }
        ],
        tasks: []
    });
    const matrix = () => ({
        format: 'fa-domain-spec', version: 1, kind: 'matrix', id: 'demo-ops', label: '示範：線性同餘與回文', seed: 20261111, meta: Object.assign({}, META),
        ops: [
            { id: 'lin-mod', label: '線性同餘 (a·n+b) mod m', level: 'L0', order: 5, keywords: ['同餘', '餘數'], layout: 'lines', input: [{ name: 'n', type: 'int' }], output: { type: 'int' },
                params: { a: [1, 2, 3, 4, 5, 6, 7], b: [0, 1, 2, 3, 4, 5], m: [7, 9, 10, 11, 13] }, expr: '(a * n + b) % m' },
            { id: 'is-pal', label: '回文判斷', level: 'L2', order: 6, keywords: ['回文'], layout: 'lines', input: [{ name: 's', type: 'str' }], output: { type: 'bool', yes: 'yes', no: 'no' }, params: {}, expr: 's == "".join(reversed(s))' }
        ],
        tasks: [
            { id: 'lin-3-2-11', op: 'lin-mod', split: 'train', statement: '輸入整數 n，輸出 (3n+2) 除以 11 的餘數（同餘計算）。',
                examples: [{ in: '1\n', out: '5\n' }, { in: '4\n', out: '3\n' }, { in: '7\n', out: '1\n' }], hidden: [{ in: '10\n', out: '10\n' }, { in: '20\n', out: '7\n' }, { in: '0\n', out: '2\n' }, { in: '13\n', out: '8\n' }] },
            { id: 'lin-5-1-9', op: 'lin-mod', split: 'holdout', statement: '輸入整數 n，輸出 (5n+1) 除以 9 的餘數（同餘計算）。',
                examples: [{ in: '2\n', out: '2\n' }, { in: '3\n', out: '7\n' }, { in: '5\n', out: '8\n' }], hidden: [{ in: '9\n', out: '1\n' }, { in: '11\n', out: '2\n' }, { in: '6\n', out: '4\n' }, { in: '14\n', out: '8\n' }] },
            { id: 'pal-yes-no', op: 'is-pal', split: 'train', statement: '輸入一個字串，若它是回文印 yes，否則印 no。',
                examples: [{ in: 'abba\n', out: 'yes\n' }, { in: 'abca\n', out: 'no\n' }, { in: 'x\n', out: 'yes\n' }], hidden: [{ in: 'level\n', out: 'yes\n' }, { in: 'ab\n', out: 'no\n' }, { in: 'noon\n', out: 'yes\n' }] },
            { id: 'pal-holdout', op: 'is-pal', split: 'holdout', statement: '輸入一個小寫字串，判斷它是不是回文，是就印 yes，不是就印 no。',
                examples: [{ in: 'racecar\n', out: 'yes\n' }, { in: 'abcd\n', out: 'no\n' }, { in: 'aa\n', out: 'yes\n' }], hidden: [{ in: 'abcba\n', out: 'yes\n' }, { in: 'abab\n', out: 'no\n' }, { in: 'z\n', out: 'yes\n' }] }
        ]
    });
    return { META, blockly, matrix };
});
