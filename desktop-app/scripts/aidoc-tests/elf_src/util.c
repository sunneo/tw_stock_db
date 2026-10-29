#include "util.h"

int add3(int a, int b, int c)
{
    int s = a;
    s += b;
    if (c > 2) {
        s += sq(c);
    }
    for (int i = 0; i < c; i++)
        s += i;
    return s;
}

int crash_here(int *p)
{
    int v = add3(1, 2, 3);
    return *p + v;
}
