// Analysis tool behind the `compilerFixtures` test: categorise every downloaded
// compiler-test fixture into expected / K&R / recovered / gap, and for each remaining
// GAP list the file-scope function name the indexer dropped (want vs. have). Use it to
// hunt the next root cause without running the whole test runner.
//
//   1. Download fixtures:  node test/scripts/download_compiler_tests.js
//   2. Build test output:  npx tsc -p tsconfig.test.json
//   3. Run:                node test/scripts/analyzeCompilerFixtures.js [--gaps] [N]
//
// `--gaps` prints only the failing files; an optional N caps the file count.

const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.join(ROOT, 'out');
const FIXTURES_DIR = path.join(ROOT, 'test', 'fixtures', 'compiler_tests');

function req(p) {
    const full = path.join(OUT, p);
    if (!fs.existsSync(full)) {
        console.error(`Missing ${p} — run \`npx tsc -p tsconfig.test.json\` first.`);
        process.exit(1);
    }
    return require(full);
}
const { setupLiveParser } = req('test/liveTestSetup.js');
const { getParser } = req('src/indexer/parser.js');
const { indexFile } = req('src/indexer/indexFile.js');
const {
    EXPECTED_DIAG,
    CLANG_NEGATIVE_RUN,
    looksLikeKnrImplicitInt,
    fileScopeFunctionNames,
} = req('test/fixtureClassify.js');

function getFiles(dir, out = []) {
    if (!fs.existsSync(dir)) return out;
    for (const f of fs.readdirSync(dir)) {
        const p = path.join(dir, f);
        if (fs.statSync(p).isDirectory()) getFiles(p, out);
        else if (f.endsWith('.c') || f.endsWith('.cpp')) out.push(p);
    }
    return out;
}

function findErrorNodes(root) {
    const errors = [];
    const stack = [root];
    while (stack.length) {
        const node = stack.pop();
        if (!node) continue;
        if (node.type === 'ERROR' || node.isMissing) errors.push(node);
        for (let i = 0; i < node.childCount; i++) {
            const c = node.child(i);
            if (c) stack.push(c);
        }
    }
    return errors;
}

(async () => {
    await setupLiveParser();
    const gapsOnly = process.argv.includes('--gaps');
    const cap = Number(process.argv.find((a) => /^\d+$/.test(a))) || 1000;
    const files = getFiles(FIXTURES_DIR).slice(0, cap);

    const tally = { clean: 0, expected: 0, knr: 0, recovered: 0, gap: 0 };
    const gaps = [];

    for (const file of files) {
        const content = fs.readFileSync(file, 'utf8');
        const lang = file.endsWith('.cpp') ? 'cpp' : 'c';
        const rel = path.relative(FIXTURES_DIR, file).replace(/\\/g, '/');

        const parser = await getParser(lang);
        const tree = parser.parse(content);
        const hasErrors = tree ? findErrorNodes(tree.rootNode).length > 0 : false;
        if (tree) tree.delete();

        if (!hasErrors) { tally.clean++; continue; }

        const expected = EXPECTED_DIAG.test(content) || CLANG_NEGATIVE_RUN.test(content);
        if (expected) { tally.expected++; continue; }
        if (looksLikeKnrImplicitInt(content)) { tally.knr++; continue; }

        const fi = await indexFile(file, content, lang);
        const have = new Set(fi.symbols.filter((s) => s.kind === 'function').map((s) => s.name));
        const missing = fileScopeFunctionNames(content).filter((n) => !have.has(n));
        if (missing.length === 0) { tally.recovered++; continue; }
        tally.gap++;
        gaps.push({ rel, missing, parsedBy: fi.parsedBy });
    }

    if (!gapsOnly) {
        console.log(
            `\nclean=${tally.clean} | expected=${tally.expected} | knr=${tally.knr} | ` +
            `recovered=${tally.recovered} | gap=${tally.gap}  (of ${files.length} files)`,
        );
    }
    console.log(`\n${gaps.length} GAP file(s) — dropped file-scope function symbols:`);
    for (const g of gaps) {
        console.log(`  ${g.rel} [${g.parsedBy}]  missing: ${g.missing.join(', ')}`);
    }
})().catch((e) => { console.error(e); process.exit(1); });
