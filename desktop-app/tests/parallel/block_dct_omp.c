/* 有損影像壓縮的區塊 DCT＋量化（JPEG 亮度表），用 OpenMP 依排程平行化。
 * 每個 8x8 區塊互不相依（沒有迴圈攜帶相依），所以任何排程的結果都必須與循序版逐位元相同。
 * 用法：block_dct_omp <mode> <W> <H> <seed>   mode：seq | static | cyclic | chunk4 | dynamic4 | guided
 *   輸出 stdout 三行：coef 雜湊（FNV-1a 64 位元）、非零係數數、重建的平方誤差總和與 PSNR（小數三位）。耗時寫到 stderr。
 * 編譯：gcc -O2 -fopenmp block_dct_omp.c -o block_dct_omp -lm */
#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>
#include <string.h>
#include <math.h>
#include <omp.h>

static const int QT[64] = {16,11,10,16,24,40,51,61, 12,12,14,19,26,58,60,55, 14,13,16,24,40,57,69,56, 14,17,22,29,51,87,80,62,
    18,22,37,56,68,109,103,77, 24,35,55,64,81,104,113,92, 49,64,78,87,103,121,120,101, 72,92,95,98,112,100,103,99};
static double C[8][8];

static void block_fdct(const uint8_t *px, int stride, int *q) {
    double t[64];
    for (int u = 0; u < 8; u++) for (int v = 0; v < 8; v++) {
        double s = 0;
        for (int x = 0; x < 8; x++) for (int y = 0; y < 8; y++) s += (px[y * stride + x] - 128.0) * C[u][x] * C[v][y];
        t[u * 8 + v] = s;
    }
    for (int i = 0; i < 64; i++) q[i] = (int)lround(t[i] / QT[i]);
}
static void block_idct(const int *q, uint8_t *px, int stride) {
    for (int x = 0; x < 8; x++) for (int y = 0; y < 8; y++) {
        double s = 0;
        for (int u = 0; u < 8; u++) for (int v = 0; v < 8; v++) s += q[u * 8 + v] * (double)QT[u * 8 + v] * C[u][x] * C[v][y];
        long r = lround(s + 128.0); if (r < 0) r = 0; if (r > 255) r = 255;
        px[y * stride + x] = (uint8_t)r;
    }
}

int main(int argc, char **argv) {
    if (argc < 5) { fprintf(stderr, "用法：%s mode W H seed\n", argv[0]); return 2; }
    const char *mode = argv[1]; int W = atoi(argv[2]), H = atoi(argv[3]); uint32_t seed = (uint32_t)atoi(argv[4]);
    if (W % 8 || H % 8 || W <= 0 || H <= 0) { fprintf(stderr, "寬高要是 8 的倍數\n"); return 2; }
    for (int u = 0; u < 8; u++) for (int x = 0; x < 8; x++) C[u][x] = (u == 0 ? sqrt(1.0 / 8) : sqrt(2.0 / 8)) * cos((2 * x + 1) * u * M_PI / 16);
    /* 合成影像：平滑漸層＋方塊＋雜訊，確定性（與執行緒無關） */
    uint8_t *img = malloc((size_t)W * H); uint32_t s = seed;
    for (int y = 0; y < H; y++) for (int x = 0; x < W; x++) {
        s = s * 1664525u + 1013904223u;
        int v = (x + y) * 255 / (W + H) + (((x / 32) ^ (y / 32)) & 1 ? 40 : 0) + (int)((s >> 24) % 9) - 4;
        img[(size_t)y * W + x] = (uint8_t)(v < 0 ? 0 : v > 255 ? 255 : v);
    }
    int bw = W / 8, bh = H / 8, nb = bw * bh;
    int *coef = malloc(sizeof(int) * 64 * (size_t)nb);
    uint8_t *rec = malloc((size_t)W * H);
    long long nz = 0, sse = 0;
    double t0 = omp_get_wtime();
    if (strcmp(mode, "seq") == 0) {
        for (int b = 0; b < nb; b++) {
            int by = b / bw, bx = b % bw; const uint8_t *p = img + (size_t)by * 8 * W + bx * 8;
            block_fdct(p, W, coef + 64 * b); block_idct(coef + 64 * b, rec + (size_t)by * 8 * W + bx * 8, W);
        }
    } else {
        int chunk = 4; omp_sched_t kind = omp_sched_static; int ck = 0;
        if (strcmp(mode, "static") == 0) { kind = omp_sched_static; ck = 0; }
        else if (strcmp(mode, "cyclic") == 0) { kind = omp_sched_static; ck = 1; }
        else if (strcmp(mode, "chunk4") == 0) { kind = omp_sched_static; ck = chunk; }
        else if (strcmp(mode, "dynamic4") == 0) { kind = omp_sched_dynamic; ck = chunk; }
        else if (strcmp(mode, "guided") == 0) { kind = omp_sched_guided; ck = 1; }
        else { fprintf(stderr, "未知模式\n"); return 2; }
        omp_set_schedule(kind, ck);
        #pragma omp parallel for schedule(runtime) reduction(+:nz,sse)
        for (int b = 0; b < nb; b++) {
            int by = b / bw, bx = b % bw; const uint8_t *p = img + (size_t)by * 8 * W + bx * 8;
            block_fdct(p, W, coef + 64 * b); block_idct(coef + 64 * b, rec + (size_t)by * 8 * W + bx * 8, W);
        }
    }
    /* 歸約：非零係數數、重建誤差（循序與平行一樣，整數運算、與順序無關） */
    for (int b = 0; b < nb; b++) for (int i = 0; i < 64; i++) if (coef[64 * b + i]) nz++;
    for (size_t i = 0; i < (size_t)W * H; i++) { long d = (long)img[i] - (long)rec[i]; sse += d * d; }
    double t1 = omp_get_wtime();
    uint64_t h = 1469598103934665603ull; const unsigned char *bp = (const unsigned char *)coef;
    for (size_t i = 0; i < sizeof(int) * 64 * (size_t)nb; i++) { h ^= bp[i]; h *= 1099511628211ull; }
    double mse = (double)sse / ((double)W * H);
    printf("hash %016llx\nnonzero %lld\nsse %lld psnr %.3f\n", (unsigned long long)h, nz, sse, mse == 0 ? 99.0 : 10.0 * log10(255.0 * 255.0 / mse));
    fprintf(stderr, "耗時 %.6f 秒 執行緒數 %d\n", t1 - t0, omp_get_max_threads());
    free(img); free(coef); free(rec);
    return 0;
}
