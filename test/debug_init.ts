import * as path from 'node:path';
import { configureAssets, initParser, getParser } from '../src/indexer/parser';
import { extractFromTree } from '../src/indexer/extract';

const root = process.cwd();

async function main() {
  configureAssets({
    runtimeWasmPath: path.join(root, 'node_modules', 'web-tree-sitter', 'web-tree-sitter.wasm'),
    grammarPaths: {
      c: path.join(root, 'node_modules', 'tree-sitter-c', 'tree-sitter-c.wasm'),
      cpp: path.join(root, 'node_modules', 'tree-sitter-cpp', 'tree-sitter-cpp.wasm'),
    },
  });
  await initParser();

  const parser = await getParser('c');

  // Test cases: various attribute macro patterns
  const cases: [string, string][] = [
    // Pattern 1: macro between return type and function name
    ['__init between type and name', 'void __init vfs_caches_init_early(void) { foo(); }'],
    // Pattern 2: macro before return type
    ['asmlinkage before type', 'asmlinkage void do_IRQ(void) { bar(); }'],
    // Pattern 3: multiple macros
    ['static __init', 'static void __init start_kernel(void) { baz(); }'],
    // Pattern 4: __exit
    ['__exit after type', 'void __exit cleanup_module(void) { qux(); }'],
    // Pattern 5: __cold
    ['__cold after type', 'int __cold notifier_call(void) { abc(); }'],
    // Pattern 6: __always_inline
    ['__always_inline', 'static __always_inline int read_reg(int x) { return x; }'],
    // Pattern 7: macro before and after type
    ['macro sandwich', 'asmlinkage __visible void __init early_init(void) { xyz(); }'],
    // Pattern 8: __attribute__ (native GCC)
    ['native __attribute__', 'void __attribute__((cold)) my_func(void) { test(); }'],
    // Pattern 9: return pointer with macro
    ['pointer return + macro', 'struct worker_ctl *__init idle_thread(void) { ret(); }'],
    // Pattern 10: EXPORT_SYMBOL pattern (not in decl)
    ['normal function (control)', 'int normal_function(int a) { return a; }'],
    // Pattern 11: __weak
    ['__weak', 'void __weak arch_setup(void) { init(); }'],
    // Pattern 12: multiple attrs between type and name
    ['__noinline __cold', 'void __noinline __cold error_handler(void) { err(); }'],
  ];

  for (const [label, src] of cases) {
    const tree = parser.parse(src);
    if (!tree) throw new Error("Parse failed");
    const result = extractFromTree(tree, 'test.c', 'c');

    // Check if function was properly identified
    const funcSymbol = result.symbols.find(s => s.kind === 'function');
    const calls = result.calls;
    const hasFuncScopeCalls = calls.some(c => c.caller !== null);

    console.log(`\n--- ${label} ---`);
    console.log(`  Source: ${src.substring(0, 70)}...`);
    console.log(`  Function found: ${funcSymbol ? funcSymbol.name : '❌ NONE'}`);
    console.log(`  Calls with caller: ${hasFuncScopeCalls ? '✅' : '❌ (file scope)'}`);
    if (!funcSymbol || !hasFuncScopeCalls) {
      // Print AST for failed cases
      console.log(`  AST root children:`);
      for (let i = 0; i < tree.rootNode.namedChildCount; i++) {
        const child = tree.rootNode.namedChild(i)!;
        console.log(`    [${i}] ${child.type}: "${child.text.substring(0, 60)}"`);
      }
    }
    console.log(`  errorRatio: ${result.errorRatio}`);
  }
}

main().catch(console.error);
