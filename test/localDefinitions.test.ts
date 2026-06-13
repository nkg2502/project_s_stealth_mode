/**
 * Local variable & parameter definitions on the LIVE path.
 *
 * The legacy parser exposed findLocalDefinitions() (AST) and findParameterByText()
 * (a text fallback). The live design records every parameter/function-body local
 * in the `locals` table (tagged with its enclosing function and its declared
 * AGGREGATE dataType — `''` for scalars, pointer stripped), queried scope-aware
 * via `findLocal(db, name, file, func)`. These cases verify that storage/query.
 *
 * Run: npm run test:unit
 */

import { describe, it, before, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import { findLocal } from '../src/store/db';
import { setupLiveParser, openLiveStore } from './liveTestSetup';
import type { LiveStore } from './liveTestSetup';

const FILE = '/t.c';
let store: LiveStore;

before(async () => {
    await setupLiveParser();
});
beforeEach(() => {
    store = openLiveStore();
});
afterEach(() => {
    store.close();
});

/** Index `code` and return the scope-local hits for `name` in `func`. */
async function localsOf(code: string, name: string, func: string) {
    await store.index(FILE, code);
    return findLocal(store.db, name, FILE, func);
}

describe('findLocal - parameters and function-body locals', () => {
    it('should find a function parameter', async () => {
        const code = `\nvoid myFunc(int count, char *buf) {\n    return count;\n}\n        `;
        const results = await localsOf(code, 'count', 'myFunc');
        assert.ok(results.length > 0, 'should find parameter "count"');
        assert.equal(results[0].name, 'count');
        assert.equal(results[0].kind, 'parameter');
        assert.equal(results[0].line, 1); // 0-indexed, parameter is on line 1
    });

    it('should find a pointer parameter', async () => {
        const code = `\nvoid process(int *ptr) {\n    *ptr = 42;\n}\n        `;
        const results = await localsOf(code, 'ptr', 'process');
        assert.ok(results.length > 0, 'should find parameter "ptr"');
        assert.equal(results[0].name, 'ptr');
        assert.equal(results[0].kind, 'parameter');
    });

    it('should find a local variable', async () => {
        const code = `\nvoid myFunc() {\n    int localVar = 10;\n    localVar++;\n}\n        `;
        const results = await localsOf(code, 'localVar', 'myFunc');
        assert.ok(results.length > 0, 'should find local variable "localVar"');
        assert.equal(results[0].name, 'localVar');
        assert.equal(results[0].kind, 'local_variable');
        assert.equal(results[0].line, 2); // declaration on line 2
    });

    it('should find a local pointer variable', async () => {
        const code = `\nvoid myFunc() {\n    int *pData = NULL;\n    *pData = 5;\n}\n        `;
        const results = await localsOf(code, 'pData', 'myFunc');
        assert.ok(results.length > 0, 'should find local pointer variable "pData"');
        assert.equal(results[0].name, 'pData');
    });

    it('should find a local array variable', async () => {
        const code = `\nvoid myFunc() {\n    int arr[10];\n    arr[0] = 1;\n}\n        `;
        const results = await localsOf(code, 'arr', 'myFunc');
        assert.ok(results.length > 0, 'should find local array variable "arr"');
        assert.equal(results[0].name, 'arr');
    });

    it('should find variable in nested block', async () => {
        const code = `\nvoid myFunc() {\n    if (1) {\n        int nested = 5;\n        nested++;\n    }\n}\n        `;
        const results = await localsOf(code, 'nested', 'myFunc');
        assert.ok(results.length > 0, 'should find nested local variable');
        assert.equal(results[0].name, 'nested');
    });

    it('should find variable declared in else block', async () => {
        const code = `\nvoid myFunc(int flag) {\n    if (flag) {\n        doSomething();\n    } else {\n        int blockXorZoneData = 5;\n        use(blockXorZoneData);\n    }\n}\n        `;
        const results = await localsOf(code, 'blockXorZoneData', 'myFunc');
        assert.equal(results.length, 1, 'should find exactly 1 variable declared in else block');
        assert.equal(results[0].name, 'blockXorZoneData');
        assert.equal(results[0].kind, 'local_variable');
        assert.equal(results[0].line, 5);
    });

    it('should find variable declared in for loop', async () => {
        const code = `\nvoid myFunc() {\n    for (int i = 0; i < 10; i++) {\n        doSomething(i);\n    }\n}\n        `;
        const results = await localsOf(code, 'i', 'myFunc');
        assert.ok(results.length > 0, 'should find for-loop variable "i"');
        assert.equal(results[0].name, 'i');
    });

    it('should not find variable from a different function', async () => {
        const code = `\nvoid funcA() {\n    int onlyInA = 1;\n}\n\nvoid funcB() {\n    int x = 2;\n}\n        `;
        const results = await localsOf(code, 'onlyInA', 'funcB');
        assert.equal(results.length, 0, 'should not find variable from a different function');
    });

    it('should return empty for non-existent variable', async () => {
        const code = `\nvoid myFunc() {\n    int x = 1;\n}\n        `;
        const results = await localsOf(code, 'nonExistent', 'myFunc');
        assert.equal(results.length, 0);
    });

    it('should not find a global via local search', async () => {
        const code = `\nint globalVar = 10;\n\nvoid myFunc() {\n    int x = 1;\n}\n        `;
        const results = await localsOf(code, 'globalVar', 'myFunc');
        assert.equal(results.length, 0, 'globals are not locals');
    });

    it('should find multiple parameters', async () => {
        const code = `\nvoid myFunc(int a, int b, int c) {\n    int result = a + b + c;\n}\n        `;
        await store.index(FILE, code);
        const a = findLocal(store.db, 'a', FILE, 'myFunc');
        const b = findLocal(store.db, 'b', FILE, 'myFunc');
        const c = findLocal(store.db, 'c', FILE, 'myFunc');
        assert.ok(a.length > 0 && b.length > 0 && c.length > 0, 'should find params a, b, c');
        assert.equal(a[0].kind, 'parameter');
        assert.equal(b[0].kind, 'parameter');
        assert.equal(c[0].kind, 'parameter');
    });

    it('should distinguish parameter from local with same name across functions', async () => {
        const code = `\nvoid funcA(int val) {\n    val++;\n}\n\nvoid funcB() {\n    int val = 99;\n    val++;\n}\n        `;
        await store.index(FILE, code);
        const a = findLocal(store.db, 'val', FILE, 'funcA');
        assert.ok(a.length > 0);
        assert.equal(a[0].kind, 'parameter');
        const b = findLocal(store.db, 'val', FILE, 'funcB');
        assert.ok(b.length > 0);
        assert.equal(b[0].kind, 'local_variable');
    });

    it('should find both parameter and local variable if shadowed', async () => {
        const code = `\nvoid myFunc(int x) {\n    {\n        int x = 99;\n        x++;\n    }\n}\n        `;
        const results = await localsOf(code, 'x', 'myFunc');
        assert.ok(results.length >= 1, 'should find at least one definition of x');
    });

    it('should handle struct member access without matching struct fields', async () => {
        const code = `\nvoid myFunc() {\n    int count = 0;\n    someStruct.count = count;\n}\n        `;
        const results = await localsOf(code, 'count', 'myFunc');
        assert.ok(results.length > 0, 'should find local "count"');
        assert.equal(results[0].name, 'count');
        assert.equal(results[0].kind, 'local_variable');
    });

    it('should find local variable that shadows a global symbol name (RI-15)', async () => {
        const code = `\ntypedef struct {\n    int x;\n} SVC_Partition_t;\n\nstatic uint32_t SVC_CalculateGCCycle(void)\n{\n    SVC_Partition_t* partition_p;\n    partition_p = GetData();\n    return partition_p->x;\n}\n        `;
        const results = await localsOf(code, 'partition_p', 'SVC_CalculateGCCycle');
        assert.ok(results.length > 0, 'should find local "partition_p" even if a global symbol has the same name');
        assert.equal(results[0].name, 'partition_p');
        assert.equal(results[0].kind, 'local_variable');
        assert.equal(results[0].line, 7); // declaration line (0-indexed)
    });

    it('should find local pointer variable that shadows a global typedef (RI-15)', async () => {
        const code = `\nvoid ProcessData(void)\n{\n    SomeType_t* pData;\n    pData = AllocData();\n    pData->field = 0;\n}\n        `;
        const results = await localsOf(code, 'pData', 'ProcessData');
        assert.ok(results.length > 0, 'should find local "pData"');
        assert.equal(results[0].name, 'pData');
        assert.equal(results[0].kind, 'local_variable');
        assert.equal(results[0].line, 3);
    });

    it('should find local var in a macro-attributed function header (RI-15 variant)', async () => {
        const code = `static uint32_t MODULE_MACRO__SVC SVC_CalculateGCCycle(void)\n{\n    SVC_Partition_t* partition_p;\n    partition_p = GetData();\n}\n        `;
        const results = await localsOf(code, 'partition_p', 'SVC_CalculateGCCycle');
        assert.ok(results.length > 0, 'should find local "partition_p" with MODULE_MACRO__SVC macro');
        assert.equal(results[0].name, 'partition_p');
        assert.equal(results[0].kind, 'local_variable');
        assert.equal(results[0].line, 2);
    });

    it('should find local var when its declaration is the only occurrence (RI-15b)', async () => {
        const code = `\nstatic uint32_t MODULE_MACRO__SVC SVC_CalculateGCCycle(void)\n{\n    SVC_Partition_t* partition_p;\n    partition_p = SVC_SelectMigrationPartition();\n    return 0;\n}\n        `;
        const results = await localsOf(code, 'partition_p', 'SVC_CalculateGCCycle');
        assert.ok(results.length > 0, 'should find local "partition_p"');
        assert.equal(results[0].name, 'partition_p');
        assert.equal(results[0].kind, 'local_variable');
        assert.equal(results[0].line, 3);
    });

    it('should find a parameter in a file with attribute macros / parse hazards (SYS_DoPrefetch pTask)', async () => {
        const code = `\nINLINE BOOL32 funcA(uint32_t msgId, MsgRequest_t* pMsg) {\n    uint32_t msgType = pMsg->field;\n    return FALSE;\n}\n\nStatus_t funcB(uint32_t idx, MsgRequest_t *pMsg, uint32_t avail, BOOL32 isFromCache) {\n    uint64_t dataArray[TASK_SIZE];\n    TaskFastReadUnion_t * const pFR = (void *)dataArray;\n\n    SYS_FastMemResetTask(dataArray);\n}\n\n#ifdef SUPPORT_PREFETCH\nvoid SYS_DoPrefetch(uint32_t msgId, uint32_t msgIdx, MsgRequest_t* pMsg, uint32_t numBlocks, uint64_t *pTask) {\n    uint32_t dataType = pMsg->msgFooter.DataType;\n    taskPrefetchUnion_t * pContext = (taskPrefetchUnion_t*)pTask;\n    pContext->field = 0;\n}\n#endif\n        `;
        const lines = code.split('\n');
        const paramline = lines.findIndex(l => l.includes('uint64_t *pTask'));
        const results = await localsOf(code, 'pTask', 'SYS_DoPrefetch');
        assert.ok(results.length > 0, `should find parameter "pTask" (expected def at line ${paramline})`);
        assert.equal(results[0].name, 'pTask');
        assert.equal(results[0].kind, 'parameter');
        assert.equal(results[0].line, paramline);
    });

    it('should return empty for a file that was never indexed', async () => {
        const results = findLocal(store.db, 'x', '/never-indexed.c', 'f');
        assert.equal(results.length, 0);
    });

    it('should resolve a parameter even when a preceding function has a parse hazard', async () => {
        const code = `\nvoid MODULE_A_MACRO Swallower(HwdCtxmulator_t* pAcc, uint32_t streamType)\n{\n    while ( OBM_IS_BLOCK_OPENED(pAcc) && XOR_UTLS_HAS_ZONE_ENDED(pAcc, streamType) )\n    {\n        runTask(pAcc);\n    }\n}\n\nvoid MODULE_A_MACRO HWD_HandleData(HardwareContext_t* pHardwareContext, uint32_t hwdCtxtID)\n{\n    uint32_t blocks = pHardwareContext->blockCount;\n    process(pHardwareContext, blocks);\n}\n        `;
        const lines = code.split('\n');
        const paramline = lines.findIndex(l => l.includes('HardwareContext_t* pHardwareContext'));
        const results = await localsOf(code, 'pHardwareContext', 'HWD_HandleData');
        assert.ok(results.length > 0, `should resolve parameter "pHardwareContext" (def line ${paramline})`);
        assert.equal(results[0].name, 'pHardwareContext');
        assert.equal(results[0].kind, 'parameter');
        assert.equal(results[0].line, paramline);
    });
});

describe('findLocal - parameter dataType extraction', () => {
    it('records a simple parameter (scalar type has no aggregate dataType)', async () => {
        const code = `void myFunc(int count, char *buf)\n{\n    use(count);\n}\n        `;
        const results = await localsOf(code, 'count', 'myFunc');
        assert.equal(results.length, 1);
        assert.equal(results[0].name, 'count');
        assert.equal(results[0].kind, 'parameter');
        assert.equal(results[0].line, 0);
        assert.equal(results[0].dataType, ''); // scalar: no aggregate tag
    });

    it('records the aggregate tag for a pointer parameter (pointer stripped)', async () => {
        const code = `void process(HardwareContext_t* pHardwareContext, uint32_t id)\n{\n    use(pHardwareContext);\n}\n        `;
        const results = await localsOf(code, 'pHardwareContext', 'process');
        assert.equal(results.length, 1);
        assert.equal(results[0].name, 'pHardwareContext');
        assert.equal(results[0].kind, 'parameter');
        assert.equal(results[0].dataType, 'HardwareContext_t');
    });

    it('reports the correct column of the parameter name', async () => {
        const code = `void f(int alpha)\n{\n    use(alpha);\n}\n        `;
        const results = await localsOf(code, 'alpha', 'f');
        assert.equal(results.length, 1);
        assert.equal(results[0].line, 0);
        assert.equal(results[0].col, code.split('\n')[0].indexOf('alpha'));
    });

    it('handles a multi-line parameter list', async () => {
        const code = `void manyArgs(int a,\n             int b,\n             char *target)\n{\n    use(target);\n}\n        `;
        const results = await localsOf(code, 'target', 'manyArgs');
        assert.equal(results.length, 1);
        assert.equal(results[0].name, 'target');
        assert.equal(results[0].kind, 'parameter');
        assert.equal(results[0].line, 2);
    });

    it('does not split function-pointer parameters at nested commas', async () => {
        const code = `void reg(int id, void (*cb)(int, char), int flags)\n{\n    use(flags);\n}\n        `;
        const results = await localsOf(code, 'flags', 'reg');
        assert.equal(results.length, 1);
        assert.equal(results[0].name, 'flags');
        assert.equal(results[0].dataType, ''); // int scalar
    });

    it('anchors a parameter to its definition, ignoring indented call sites', async () => {
        const code = `void outer(int realParam)\n{\n    helper(notAParam, realParam);\n    use(realParam);\n}\n        `;
        const results = await localsOf(code, 'realParam', 'outer');
        assert.equal(results.length, 1);
        assert.equal(results[0].line, 0);
        assert.equal(results[0].kind, 'parameter');
    });

    it('binds the parameter to the definition, not a prototype', async () => {
        const code = `void target(int value);\n\nvoid target(int value)\n{\n    use(value);\n}\n        `;
        const results = await localsOf(code, 'value', 'target');
        // A prototype has no body, so only the definition contributes a local.
        assert.equal(results.length, 1);
        assert.equal(results[0].kind, 'parameter');
        assert.equal(results[0].line, 2);
    });

    it('returns empty when the parameter is not present', async () => {
        const code = `void f(int a, int b)\n{\n    use(a);\n}\n        `;
        const results = await localsOf(code, 'missing', 'f');
        assert.equal(results.length, 0);
    });

    it('does not match a parameter from a different (non-enclosing) function', async () => {
        const code = `void funcA(int onlyInA)\n{\n    work();\n}\n\nvoid funcB(int other)\n{\n    use(other);\n}\n        `;
        const results = await localsOf(code, 'onlyInA', 'funcB');
        assert.equal(results.length, 0);
    });

    it('handles a macro-attributed function header', async () => {
        const code = `void MODULE_A_MACRO HWD_HandleData(HardwareContext_t* pHardwareContext, uint32_t hwdCtxtID)\n{\n    use(pHardwareContext);\n}\n        `;
        const results = await localsOf(code, 'pHardwareContext', 'HWD_HandleData');
        assert.equal(results.length, 1);
        assert.equal(results[0].name, 'pHardwareContext');
        assert.equal(results[0].kind, 'parameter');
        assert.equal(results[0].dataType, 'HardwareContext_t');
    });
});
