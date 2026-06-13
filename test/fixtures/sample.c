#include <stdio.h>

#define MAX_LEN 128            // comment_only must_not_index
/* block_only should be ignored */

typedef int my_int_t;

struct Point { int x; int y; };

enum Color { RED, GREEN, BLUE };

int helper(int a);

int helper(int a) {
    return a + MAX_LEN;
}

int main(void) {
    int total = 0;
    total = helper(total);
    if (total > 0) goto done;
    total = -1;
done:
    return total;
}

#if 0
int disabled_function(void) {
    return 0;
}
#endif
