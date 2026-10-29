#include <stdio.h>
#include <stdlib.h>
#include "util.h"

static int helper(int n)
{
    int r = 0;
    while (n > 0) {
        r += sq(n);
        n--;
    }
    return r;
}

int main(int argc, char **argv)
{
    int k = helper(argc + 3);
    printf("%d\n", add3(k, argc, 4));
    if (argc > 5) {
        return crash_here(NULL);
    }
    return 0;
}
