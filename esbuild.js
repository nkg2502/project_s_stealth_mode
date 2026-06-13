// Build script for the "C/C++ Blitz" (sintra) extension.
// Bundles the extension host entry and the indexing worker, and copies
// runtime resources (tree-sitter wasm grammars, SQL schema) into dist/.
const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const watch = process.argv.includes('--watch');
const production = process.argv.includes('--production');

/** @type {import('esbuild').BuildOptions} */
const baseOptions = {
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  sourcemap: !production,
  minify: production,
  // vscode is provided by the host. node: builtins (incl. node:sqlite) are
  // externalized automatically by esbuild for platform:node.
  external: ['vscode'],
  logLevel: 'info',
  // web-tree-sitter's loader calls createRequire(import.meta.url); in a CJS
  // bundle import.meta.url is undefined, so shim it to a real file URL.
  define: { 'import.meta.url': 'import_meta_url' },
  banner: {
    js: "const import_meta_url = require('url').pathToFileURL(__filename).href;",
  },
};

function tryCopy(from, to) {
  try {
    const src = require.resolve(from);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(src, to);
    return true;
  } catch (e) {
    console.warn(`[copyResources] skip ${from}: ${e.message}`);
    return false;
  }
}

function copyResources() {
  fs.mkdirSync('dist', { recursive: true });

  // tree-sitter language grammars (prebuilt wasm shipped inside each grammar pkg)
  tryCopy('tree-sitter-c/tree-sitter-c.wasm', 'dist/grammars/tree-sitter-c.wasm');
  tryCopy('tree-sitter-cpp/tree-sitter-cpp.wasm', 'dist/grammars/tree-sitter-cpp.wasm');

  // web-tree-sitter runtime wasm (resolved at runtime by Parser.init).
  // 0.26 renamed it tree-sitter.wasm -> web-tree-sitter.wasm (root).
  if (!tryCopy('web-tree-sitter/web-tree-sitter.wasm', 'dist/tree-sitter.wasm') &&
      !tryCopy('web-tree-sitter/tree-sitter.wasm', 'dist/tree-sitter.wasm')) {
    // older/newer layouts
    tryCopy('web-tree-sitter/debug/web-tree-sitter.wasm', 'dist/tree-sitter.wasm');
  }

  // tree-sitter query files
  const queryDir = path.join('resources', 'queries');
  if (fs.existsSync(queryDir)) {
    fs.mkdirSync('dist/queries', { recursive: true });
    for (const f of fs.readdirSync(queryDir)) {
      fs.copyFileSync(path.join(queryDir, f), path.join('dist/queries', f));
    }
  }

  // SQL schema
  const schema = path.join('src', 'store', 'schema.sql');
  if (fs.existsSync(schema)) {
    fs.copyFileSync(schema, 'dist/schema.sql');
  }
}

async function buildOne(entry, outfile) {
  const ctx = await esbuild.context({ ...baseOptions, entryPoints: [entry], outfile });
  if (watch) {
    await ctx.watch();
  } else {
    await ctx.rebuild();
    await ctx.dispose();
  }
}

async function main() {
  // Production: start from a clean dist/ so stale dev artifacts (sourcemaps, the
  // test bundle) never leak into the packaged .vsix.
  if (production) {
    fs.rmSync('dist', { recursive: true, force: true });
  }
  copyResources();
  const targets = [['src/extension.ts', 'dist/extension.js']];
  if (fs.existsSync('src/indexer/worker.ts')) {
    targets.push(['src/indexer/worker.ts', 'dist/worker.js']);
  }
  // The headless test bundle is for `npm test` only — never ship it.
  if (!production && fs.existsSync('test/run.ts')) {
    targets.push(['test/run.ts', 'dist/test.js']);
  }
  await Promise.all(targets.map(([e, o]) => buildOne(e, o)));
  if (watch) {
    console.log('[esbuild] watching...');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
