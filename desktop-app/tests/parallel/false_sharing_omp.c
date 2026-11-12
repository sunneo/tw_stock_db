/* 偽共享（false sharing）的真量測（OpenMP）：每個執行緒各自加 N 次自己的計數器。
 * 版本 packed：計數器緊鄰（同一條快取線，互相搶佔）；版本 padded：每個計數器獨占一條 64 位元組快取線。
 * 正確性：兩版每個計數器都必須恰好＝N（不論快慢）；耗時只回報、不斷言（依機器而異）。
 * 用法：false_sharing_omp <N> <threads>      編譯：gcc -O2 -fopenmp false_sharing_omp.c -o false_sharing_omp */
#include <stdio.h>
#include <stdlib.h>
#include <omp.h>

#define PAD 64
typedef struct { volatile long long v; char pad[PAD - sizeof(long long)]; } padded_t;

int main(int argc, char **argv) {
    if (argc < 3) { fprintf(stderr, "用法：%s N threads\n", argv[0]); return 2; }
    long long N = atoll(argv[1]); int th = atoi(argv[2]);
    omp_set_num_threads(th);
    volatile long long *packed = calloc(th, sizeof(long long));
    padded_t *padd = calloc(th, sizeof(padded_t));
    int ok = 1;
    double t0 = omp_get_wtime();
    #pragma omp parallel
    { int t = omp_get_thread_num(); for (long long i = 0; i < N; i++) packed[t]++; }
    double t1 = omp_get_wtime();
    #pragma omp parallel
    { int t = omp_get_thread_num(); for (long long i = 0; i < N; i++) padd[t].v++; }
    double t2 = omp_get_wtime();
    for (int t = 0; t < th; t++) { if (packed[t] != N || padd[t].v != N) ok = 0; }
    printf("%s\n", ok ? "correct" : "WRONG");
    fprintf(stderr, "packed %.4f 秒；padded %.4f 秒；執行緒 %d\n", t1 - t0, t2 - t1, th);
    free((void *)packed); free(padd);
    return ok ? 0 : 1;
}
