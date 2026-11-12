/* 競爭條件與同步的真執行（OpenMP）：T 次計數器加一，用不同的同步方式。
 * 用法：race_omp <mode> <T> <threads>   mode：atomic | critical | lock | reduction | unsync
 * stdout 一行：最後的計數值。atomic／critical／lock／reduction 必須＝T；unsync 沒有同步，會遺失更新（結果不固定，只回報）。
 * 編譯：gcc -O2 -fopenmp race_omp.c -o race_omp */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <omp.h>

int main(int argc, char **argv) {
    if (argc < 4) { fprintf(stderr, "用法：%s mode T threads\n", argv[0]); return 2; }
    const char *mode = argv[1]; long long T = atoll(argv[2]); int th = atoi(argv[3]);
    omp_set_num_threads(th);
    volatile long long c = 0;      /* volatile：避免編譯器把無同步版的迴圈優化掉（只是為了讓競爭真的發生） */
    long long shared = 0;
    omp_lock_t lk; omp_init_lock(&lk);
    if (strcmp(mode, "atomic") == 0) {
        #pragma omp parallel for
        for (long long i = 0; i < T; i++) {
            #pragma omp atomic
            shared++;
        }
    } else if (strcmp(mode, "critical") == 0) {
        #pragma omp parallel for
        for (long long i = 0; i < T; i++) {
            #pragma omp critical
            shared++;
        }
    } else if (strcmp(mode, "lock") == 0) {
        #pragma omp parallel for
        for (long long i = 0; i < T; i++) {
            omp_set_lock(&lk);
            shared++;
            omp_unset_lock(&lk);
        }
    } else if (strcmp(mode, "reduction") == 0) {
        long long r = 0;
        #pragma omp parallel for reduction(+:r)
        for (long long i = 0; i < T; i++) r++;
        shared = r;
    } else if (strcmp(mode, "unsync") == 0) {
        #pragma omp parallel for
        for (long long i = 0; i < T; i++) {
            c = c + 1;             /* 讀－改－寫 沒有保護：競爭條件 */
        }
        shared = c;
    } else { fprintf(stderr, "未知模式\n"); return 2; }
    omp_destroy_lock(&lk);
    printf("%lld\n", shared);
    return 0;
}
