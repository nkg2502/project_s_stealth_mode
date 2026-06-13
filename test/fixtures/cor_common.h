/*
 * Synthetic stand-in for the proprietary cor_common.h. Its purpose in the test
 * suite is to verify that the macro it defines survives recovery parsing, even
 * though the file also contains a construct that pushes tree-sitter into ERROR
 * recovery. Keep COR_BLOCK_MAX_XOR_ZONES — reviewFindings.test.ts asserts on it.
 */
#ifndef COR_COMMON_H
#define COR_COMMON_H

#define COR_BLOCK_MAX_NUM            (256U)
#define COR_BLOCK_MAX_XOR_ZONES      (16U)
#define COR_PAGE_SIZE                (4096U)

/* An attribute-macro'd function whose multi-operator while-condition makes the
 * grammar cascade into ERROR nodes (the swallowing pattern) — the #defines
 * above must still be indexed from the initial parse. */
void MODULE_A_MACRO COR_CommonScan(Ctx_t* acc, int streamType)
{
    while (acc->mgr.canPeek &&
           acc->mgr.counter < acc->mgr.allowed[streamType] &&
           acc->ctxtCounter < acc->maxCtxSize &&
           (!IS_OPENED(acc->buf.id) || IHAS_ENDED((GET_INC(acc->buf, K)), acc->opId)))
    {
        COR_RunTask(acc);
    }
}

#endif /* COR_COMMON_H */
