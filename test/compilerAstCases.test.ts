import { describe, it, before } from 'node:test';
import * as assert from 'node:assert/strict';
import { indexFile } from '../src/indexer/indexFile';
import { setupLiveParser } from './liveTestSetup';
import type { Lang } from '../src/core/types';

before(async () => {
    await setupLiveParser();
});

async function index(code: string, file = '/t.c', lang: Lang = 'c') {
    return indexFile(file, code, lang);
}

describe('Compiler AST testcases (clangd and gcc)', () => {
    // ----------------------------------------------------------------------
    // Clangd AST / DumpASTTests-inspired test cases
    // ----------------------------------------------------------------------
    describe('Clangd AST patterns', () => {
        it('should parse nested templates and classes (Clangd DumpASTTests.NestedTemplates)', async () => {
            const code = `
template <typename T>
struct Outer {
    struct Inner {
        T value;
        void print();
    };
};
            `;
            const { symbols } = await index(code, '/t.cpp', 'cpp');
            const outer = symbols.find(s => s.name === 'Outer');
            const inner = symbols.find(s => s.name === 'Inner');
            
            assert.ok(outer, 'should find Outer struct template');
            assert.equal(outer.kind, 'struct');
            assert.ok(inner, 'should find Inner struct');
            assert.equal(inner.kind, 'struct');
        });

        it('should parse trailing return types (Clangd DumpASTTests.TrailingReturn)', async () => {
            const code = `
auto get_value() -> int {
    return 42;
}
            `;
            const { symbols } = await index(code, '/t.cpp', 'cpp');
            const func = symbols.find(s => s.name === 'get_value');
            
            assert.ok(func, 'should find function with trailing return type');
            assert.equal(func.kind, 'function');
        });

        it('should parse namespaces and qualified names (Clangd AST tests)', async () => {
            const code = `
namespace MyCore {
    class Manager {
    public:
        void init();
    };
}
            `;
            const { symbols } = await index(code, '/t.cpp', 'cpp');
            const mgr = symbols.find(s => s.name === 'Manager');
            assert.ok(mgr, 'should find class inside namespace');
            assert.equal(mgr.kind, 'class');
            
            const initFunc = symbols.find(s => s.name === 'init');
            assert.ok(initFunc, 'should find method inside class');
            assert.equal(initFunc.kind, 'field');
        });
    });

    // ----------------------------------------------------------------------
    // GCC gcc.dg AST test cases
    // ----------------------------------------------------------------------
    describe('GCC (gcc.dg) AST patterns', () => {
        it('should parse anonymous structs and unions (GCC dg struct/anon)', async () => {
            const code = `
struct data_packet {
    int id;
    union {
        struct {
            int x;
            int y;
        } point;
        long raw_data;
    } payload;
};
            `;
            const { symbols } = await index(code);
            const dataPacket = symbols.find(s => s.name === 'data_packet');
            assert.ok(dataPacket, 'should find data_packet struct');
            assert.equal(dataPacket.kind, 'struct');

            const payload = symbols.find(s => s.name === 'payload');
            assert.ok(payload, 'should find payload union member');
            assert.equal(payload.kind, 'field');

            const point = symbols.find(s => s.name === 'point');
            assert.ok(point, 'should find point struct member');
            assert.equal(point.kind, 'field');
        });

        it('should parse struct bitfields (GCC dg bitfields)', async () => {
            const code = `
struct HardwareRegister {
    unsigned int enable : 1;
    unsigned int mode   : 3;
    unsigned int        : 4; // padding
    unsigned int value  : 24;
};
            `;
            const { symbols } = await index(code);
            const reg = symbols.find(s => s.name === 'HardwareRegister');
            assert.ok(reg, 'should find HardwareRegister struct');
            
            const enable = symbols.find(s => s.name === 'enable');
            assert.ok(enable, 'should find bitfield enable');
            assert.equal(enable.kind, 'field');
            
            const mode = symbols.find(s => s.name === 'mode');
            assert.ok(mode, 'should find bitfield mode');
            assert.equal(mode.kind, 'field');
        });

        it('should parse compiler attributes like __attribute__ (GCC dg attributes)', async () => {
            const code = `
struct __attribute__((packed)) PackedData {
    char a;
    int b;
};

void __attribute__((noreturn)) fatal_error(const char *msg) {
    while(1) {}
}
            `;
            const { symbols } = await index(code);
            const packedData = symbols.find(s => s.name === 'PackedData');
            assert.ok(packedData, 'should find PackedData struct');
            assert.equal(packedData.kind, 'struct');

            const fatalError = symbols.find(s => s.name === 'fatal_error');
            assert.ok(fatalError, 'should find fatal_error function');
            assert.equal(fatalError.kind, 'function');
        });

        it('should handle complex typedefs and function pointers (GCC dg decls)', async () => {
            const code = `
typedef void (*signal_handler_t)(int);

struct SignalAction {
    signal_handler_t handler;
    int flags;
};

signal_handler_t register_signal(int sig, signal_handler_t handler) {
    return 0;
}
            `;
            const { symbols } = await index(code);
            const typedefSym = symbols.find(s => s.name === 'signal_handler_t');
            assert.ok(typedefSym, 'should find typedef signal_handler_t');
            assert.equal(typedefSym.kind, 'typedef');

            const func = symbols.find(s => s.name === 'register_signal');
            assert.ok(func, 'should find register_signal function');
            assert.equal(func.kind, 'function');
        });
    });

    // ----------------------------------------------------------------------
    // GNU extension recovery — near-standard extensions tree-sitter's C grammar
    // doesn't model, but whose symbols the indexer must still recover.
    // ----------------------------------------------------------------------
    describe('GNU extension recovery', () => {
        // tree-sitter doesn't know `__complex__` (GNU) / `_Complex` (C99) as type
        // specifiers, so it misreads a trailing type keyword as the function name and
        // pushes the REAL name into an ERROR node just before the parameter list. The
        // indexer must recover the real name. (gcc dg 981223-1 / 20001222-1 / 941019-1.)
        it('should recover a function with a __complex__ return type', async () => {
            const code = `
__complex__ float
func (__complex__ float x)
{
    if (__real__ x == 0.0)
        return 1.0;
    return 0.0;
}
`;
            const { symbols } = await index(code);
            const fn = symbols.find(s => s.name === 'func');
            assert.ok(fn, 'should recover function func despite __complex__ return type');
            assert.equal(fn.kind, 'function');
        });

        it('should recover a function with a postfix `double __complex__` return type', async () => {
            const code = `
double __complex__
f (void)
{
  return 0;
}
`;
            const { symbols } = await index(code);
            const fn = symbols.find(s => s.name === 'f');
            assert.ok(fn, 'should recover function f despite double __complex__ return type');
            assert.equal(fn.kind, 'function');
        });

        it('should recover a function with a `__complex__ long double` return type', async () => {
            const code = `__complex__ long double sub (__complex__ long double cld) { return cld; }`;
            const { symbols } = await index(code);
            const fn = symbols.find(s => s.name === 'sub');
            assert.ok(fn, 'should recover function sub despite __complex__ long double return type');
            assert.equal(fn.kind, 'function');
        });

        it('should also recover with the C99 `_Complex` spelling', async () => {
            const code = `
_Complex float
gunc (_Complex float x)
{
  return x;
}
`;
            const { symbols } = await index(code);
            const fn = symbols.find(s => s.name === 'gunc');
            assert.ok(fn, 'should recover function gunc despite _Complex return type');
            assert.equal(fn.kind, 'function');
        });
    });
});
