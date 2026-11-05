'use strict';
// 共用測試夾具：A+B 題目與各語言（含 x86／x64 組語）的參考解。judge-runner.test.js、syntax-fix.test.js 共用。
// 題目：讀兩個 32 位元有號整數，印出和。hidden 含接近上限的值：用 int32 的語言也不會溢位（2e9 < 2^31）。
const APLUSB = { id: 'a-plus-b', tests: [{ in: '1 2\n', out: '3\n' }, { in: '-5 3\n', out: '-2\n' }, { in: '0 0\n', out: '0\n' }], hidden: [{ in: '1000000000 1000000000\n', out: '2000000000\n' }, { in: '-1000000000 -1000000000\n', out: '-2000000000\n' }] };

const SOL = {
  python: 'a, b = map(int, input().split())\nprint(a + b)\n',
  nodejs: "const [a, b] = require('fs').readFileSync(0, 'utf8').trim().split(/\\s+/).map(Number);\nconsole.log(a + b);\n",
  c: '#include <stdio.h>\nint main(void) { long long a, b; if (scanf("%lld %lld", &a, &b) != 2) return 1; printf("%lld\\n", a + b); return 0; }\n',
  cpp: '#include <iostream>\nint main() { long long a, b; std::cin >> a >> b; std::cout << a + b << "\\n"; return 0; }\n',
  java: 'import java.util.*;\npublic class Main { public static void main(String[] x) { Scanner s = new Scanner(System.in); long a = s.nextLong(), b = s.nextLong(); System.out.println(a + b); } }\n',
  ruby: 'a, b = gets.split.map(&:to_i)\nputs a + b\n',
  perl: 'my ($x, $y) = split " ", <STDIN>;\nprint $x + $y, "\\n";\n',
  bash: 'read -r a b\necho $((a + b))\n',
  csharp: 'using System;\nclass P { static void Main() { var t = Console.ReadLine().Split(new[] { \' \' }, StringSplitOptions.RemoveEmptyEntries); Console.WriteLine(long.Parse(t[0]) + long.Parse(t[1])); } }\n'
};
// 組語：不連 libc，read／write／exit 直接用系統呼叫。parse 跳過空白、認負號、讀十進位數字；印出時從尾端往前填數字。
const PARSE_BODY = (w) => w === 64 ? `
parse:
  xor eax, eax
  xor r11d, r11d
.Lskip:
  movzx ecx, byte ptr [rsi]
  cmp ecx, 32
  je .Ladv
  cmp ecx, 10
  je .Ladv
  cmp ecx, 13
  je .Ladv
  cmp ecx, 9
  je .Ladv
  jmp .Lsign
.Ladv:
  inc rsi
  jmp .Lskip
.Lsign:
  cmp ecx, 45
  jne .Ldig
  mov r11d, 1
  inc rsi
.Ldig:
  movzx ecx, byte ptr [rsi]
  sub ecx, 48
  cmp ecx, 9
  ja .Ldone
  imul rax, rax, 10
  add rax, rcx
  inc rsi
  jmp .Ldig
.Ldone:
  test r11d, r11d
  jz .Lret
  neg rax
.Lret:
  ret
` : `
parse:
  xor eax, eax
  xor edx, edx
.Lskip:
  movzx ecx, byte ptr [esi]
  cmp ecx, 32
  je .Ladv
  cmp ecx, 10
  je .Ladv
  cmp ecx, 13
  je .Ladv
  cmp ecx, 9
  je .Ladv
  jmp .Lsign
.Ladv:
  inc esi
  jmp .Lskip
.Lsign:
  cmp ecx, 45
  jne .Ldig
  mov edx, 1
  inc esi
.Ldig:
  movzx ecx, byte ptr [esi]
  sub ecx, 48
  cmp ecx, 9
  ja .Ldone
  imul eax, eax, 10
  add eax, ecx
  inc esi
  jmp .Ldig
.Ldone:
  test edx, edx
  jz .Lret
  neg eax
.Lret:
  ret
`;
SOL['asm-x64'] = `.intel_syntax noprefix
.globl _start
.bss
buf: .skip 256
out: .skip 32
.text
_start:
  xor eax, eax
  xor edi, edi
  lea rsi, [rip+buf]
  mov edx, 255
  syscall
  lea rsi, [rip+buf]
  call parse
  mov r8, rax
  call parse
  add r8, rax
  mov rax, r8
  lea rdi, [rip+out+31]
  mov byte ptr [rdi], 10
  mov r9, rdi
  mov rcx, 10
  xor r10d, r10d
  test rax, rax
  jns 1f
  neg rax
  mov r10d, 1
1:
  dec rdi
  xor edx, edx
  div rcx
  add dl, 48
  mov [rdi], dl
  test rax, rax
  jnz 1b
  test r10d, r10d
  jz 2f
  dec rdi
  mov byte ptr [rdi], 45
2:
  mov rdx, r9
  sub rdx, rdi
  inc rdx
  mov rsi, rdi
  mov edi, 1
  mov eax, 1
  syscall
  mov eax, 60
  xor edi, edi
  syscall
${PARSE_BODY(64)}`;
SOL['asm-x86'] = `.intel_syntax noprefix
.globl _start
.bss
buf: .skip 256
out: .skip 32
.text
_start:
  mov eax, 3
  xor ebx, ebx
  lea ecx, [buf]
  mov edx, 255
  int 0x80
  lea esi, [buf]
  call parse
  mov ebp, eax
  call parse
  add ebp, eax
  mov eax, ebp
  lea edi, [out+31]
  mov byte ptr [edi], 10
  mov ebp, edi
  mov ecx, 10
  xor ebx, ebx
  test eax, eax
  jns 1f
  neg eax
  mov ebx, 1
1:
  dec edi
  xor edx, edx
  div ecx
  add dl, 48
  mov [edi], dl
  test eax, eax
  jnz 1b
  test ebx, ebx
  jz 2f
  dec edi
  mov byte ptr [edi], 45
2:
  mov edx, ebp
  sub edx, edi
  inc edx
  mov ecx, edi
  mov ebx, 1
  mov eax, 4
  int 0x80
  mov eax, 1
  xor ebx, ebx
  int 0x80
${PARSE_BODY(32)}`;


module.exports = { APLUSB, SOL };
