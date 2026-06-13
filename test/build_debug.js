const esbuild = require('esbuild');
esbuild.buildSync({
  entryPoints: ['test/debug_init.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  external: ['vscode'],
  outfile: 'dist/debug_init.js',
  define: { 'import.meta.url': 'import_meta_url' },
  banner: {
    js: "const import_meta_url = require('url').pathToFileURL(__filename).href;",
  },
});
console.log('build ok');
