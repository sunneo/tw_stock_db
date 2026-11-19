// 一致性套件用到的全部 OpenCL C 核心（由 renderer/src/gpu/kir_conformance_cases.js 的 SRC 匯出，改核心請改那個檔）。
// 你可以直接抄去自己的 OpenCL 程式；這些核心就是「標準 OpenCL C」，沒有任何框架專屬寫法。

__kernel void k_vecadd(__global const float* a, __global const float* b, __global float* o, int n) {
  int i = get_global_id(0);
  if (i < n) { o[i] = a[i] + b[i]; }
}
__kernel void k_saxpy(__global const float* x, __global const float* y, __global float* o, float s, int n) {
  int i = get_global_id(0);
  if (i < n) { o[i] = s * x[i] + y[i]; }
}
__kernel void k_sqrt(__global const float* x, __global float* o, int n) {
  int i = get_global_id(0);
  if (i < n) { o[i] = sqrt(x[i]); }
}
__kernel void k_rsqrt(__global const float* x, __global float* o, int n) {
  int i = get_global_id(0);
  if (i < n) { o[i] = rsqrt(x[i]); }
}
__kernel void k_sin(__global const float* x, __global float* o, int n) {
  int i = get_global_id(0);
  if (i < n) { o[i] = sin(x[i]); }
}
__kernel void k_cos(__global const float* x, __global float* o, int n) {
  int i = get_global_id(0);
  if (i < n) { o[i] = cos(x[i]); }
}
__kernel void k_exp(__global const float* x, __global float* o, int n) {
  int i = get_global_id(0);
  if (i < n) { o[i] = exp(x[i]); }
}
__kernel void k_pow(__global const float* x, __global const float* y, __global float* o, int n) {
  int i = get_global_id(0);
  if (i < n) { o[i] = pow(x[i], y[i]); }
}
__kernel void k_floor(__global const float* x, __global float* o, int n) {
  int i = get_global_id(0);
  if (i < n) { o[i] = floor(x[i]); }
}
__kernel void k_select(__global const float* x, __global float* o, int n) {
  int i = get_global_id(0);
  if (i < n) { float v = x[i]; o[i] = v > 0.5f ? v : -v; }
}
__kernel void k_min(__global const float* a, __global const float* b, __global float* o, int n) {
  int i = get_global_id(0);
  if (i < n) { o[i] = min(a[i], b[i]); }
}
__kernel void k_max(__global const float* a, __global const float* b, __global float* o, int n) {
  int i = get_global_id(0);
  if (i < n) { o[i] = max(a[i], b[i]); }
}
__kernel void k_rowsum(__global const float* a, __global float* o, int n, int k) {
  int i = get_global_id(0);
  if (i < n) {
    float s = 0.0f;
    for (int j = 0; j < k; j++) { s += a[i * k + j]; }
    o[i] = s;
  }
}
__kernel void k_part(__global const float* a, __global float* p, int n, int ch, int m) {
  int g = get_global_id(0);
  if (g < m) {
    float s = 0.0f;
    int base = g * ch;
    for (int j = 0; j < ch; j++) {
      if (base + j < n) { s += a[base + j]; }
    }
    p[g] = s;
  }
}
__kernel void k_final(__global const float* p, __global float* o, int m) {
  int i = get_global_id(0);
  if (i < 1) {
    float s = 0.0f;
    for (int j = 0; j < m; j++) { s += p[j]; }
    o[0] = s;
  }
}
__kernel void k_grav(__global const float* x, __global const float* y, __global const float* z, __global const float* m, __global float* ax, __global float* ay, __global float* az, int n, float eps) {
  int i = get_global_id(0);
  if (i < n) {
    float xi = x[i]; float yi = y[i]; float zi = z[i];
    float fx = 0.0f; float fy = 0.0f; float fz = 0.0f;
    for (int j = 0; j < n; j++) {
      float dx = x[j] - xi; float dy = y[j] - yi; float dz = z[j] - zi;
      float r2 = dx * dx + dy * dy + dz * dz + eps;
      float inv = rsqrt(r2);
      float s = m[j] * inv * inv * inv;
      fx += dx * s; fy += dy * s; fz += dz * s;
    }
    ax[i] = fx; ay[i] = fy; az[i] = fz;
  }
}
__kernel void k_kdk(__global const float* x, __global const float* v, __global float* x2, __global float* v2, float dt, int n) {
  int i = get_global_id(0);
  if (i < n) {
    float vh = v[i] - 0.5f * dt * x[i];
    float xn = x[i] + dt * vh;
    x2[i] = xn;
    v2[i] = vh - 0.5f * dt * xn;
  }
}
__kernel void k_grav4(__global const float4* p, __global const float* m, __global float4* acc, int n, float eps) {
  int i = get_global_id(0);
  if (i < n) {
    float4 pi = p[i];
    float fx = 0.0f; float fy = 0.0f; float fz = 0.0f;
    for (int j = 0; j < n; j++) {
      float4 pj = p[j];
      float dx = pj.x - pi.x; float dy = pj.y - pi.y; float dz = pj.z - pi.z;
      float r2 = dx * dx + dy * dy + dz * dz + eps;
      float inv = rsqrt(r2);
      float s = m[j] * inv * inv * inv;
      fx += dx * s; fy += dy * s; fz += dz * s;
    }
    acc[i] = (float4)(fx, fy, fz, 0.0f);
  }
}
__kernel void k_kick4(__global const float4* v, __global const float4* acc, __global float4* vo, float h, int n) {
  int i = get_global_id(0);
  if (i < n) {
    vo[i] = (float4)(v[i].x + h * acc[i].x, v[i].y + h * acc[i].y, v[i].z + h * acc[i].z, 0.0f);
  }
}
__kernel void k_drift4(__global const float4* p, __global const float4* v, __global float4* po, float dt, int n) {
  int i = get_global_id(0);
  if (i < n) {
    po[i] = (float4)(p[i].x + dt * v[i].x, p[i].y + dt * v[i].y, p[i].z + dt * v[i].z, 0.0f);
  }
}
__kernel void k_vec4(__global const float4* a, __global float4* o, int n) {
  int i = get_global_id(0);
  if (i < n) {
    o[i] = (float4)(a[i].x + a[i].w, a[i].y * 2.0f, a[i].z - 1.0f, a[i].w);
  }
}
__kernel void k_twoout(__global const float* a, __global const float* b, __global float* s, __global float* d, int n) {
  int i = get_global_id(0);
  if (i < n) { s[i] = a[i] + b[i]; d[i] = a[i] - b[i]; }
}
