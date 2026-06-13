import { describe, it, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { indexFile } from '../src/indexer/indexFile';
import { setupLiveParser } from './liveTestSetup';
import { getParser } from '../src/indexer/parser';
import {
    EXPECTED_DIAG,
    CLANG_NEGATIVE_RUN,
    looksLikeKnrImplicitInt,
    fileScopeFunctionNames,
} from './fixtureClassify';

const FIXTURES_DIR = path.resolve(__dirname, '../../test/fixtures/compiler_tests');

before(async () => {
    await setupLiveParser();
});

function getFiles(dir: string, fileList: string[] = []) {
    if (!fs.existsSync(dir)) return fileList;
    const files = fs.readdirSync(dir);
    for (const file of files) {
        const fullPath = path.join(dir, file);
        if (fs.statSync(fullPath).isDirectory()) {
            getFiles(fullPath, fileList);
        } else if (file.endsWith('.c') || file.endsWith('.cpp')) {
            fileList.push(fullPath);
        }
    }
    return fileList;
}

function findErrorNodes(root: any) {
    const errors: any[] = [];
    const stack = [root];
    while (stack.length > 0) {
        const node = stack.pop();
        if (!node) continue;
        
        if (node.type === 'ERROR' || node.isMissing) {
            errors.push(node);
        }
        for (let i = 0; i < node.childCount; i++) {
            const child = node.child(i);
            if (child) stack.push(child);
        }
    }
    return errors;
}

// Collapse a multi-line ERROR snippet to a single, length-capped line so the log stays
// readable. (The previous `/\\r?\\n/` matched literal backslash sequences, not real
// newlines, so snippets sprawled across multiple lines.)
function flattenSnippet(text: string, max = 200): string {
    const oneLine = text.replace(/\r?\n/g, '\\n').trim();
    return oneLine.length > max ? `${oneLine.slice(0, max)} …` : oneLine;
}

describe('Comprehensive Compiler Test Suites (Clang & GCC)', () => {
    const testFiles = getFiles(FIXTURES_DIR);

    if (testFiles.length === 0) {
        it.skip('No compiler tests found. Run the download script first.', () => {});
        return;
    }

    // Run every downloaded fixture — the per-file subtests stay cheap even at a few
    // thousand files (each is a fast parse + index, no DB). `CBLITZ_FIXTURE_LIMIT` caps
    // the count for a quick local run.
    const limit = Number(process.env.CBLITZ_FIXTURE_LIMIT) || testFiles.length;
    const filesToTest = testFiles.slice(0, limit);

    // Per-file verdict (latest wins). A file PASSES when tree-sitter parses it cleanly,
    // when its ERROR nodes are an intended clang negative test (`expected-` directive),
    // or when they come from obsolete K&R / implicit-int syntax we deliberately don't
    // support. It FAILS on any other ERROR node — a genuine tree-sitter parse gap (most
    // are near-standard GNU extensions / builtins worth handling) that silently drops
    // symbols. indexFile throwing is always a failure.
    let expectedErrFiles = 0;
    let knrErrFiles = 0;
    let recoveredErrFiles = 0;
    const unexpectedErrFiles: string[] = [];

    for (const file of filesToTest) {
        const rel = path.relative(FIXTURES_DIR, file).replace(/\\/g, '/');
        const lang = file.endsWith('.cpp') ? 'cpp' : 'c';

        it(`parses ${rel}`, async () => {
            const content = fs.readFileSync(file, 'utf8');

            // Snapshot ERROR/MISSING nodes to plain objects before freeing the tree.
            const parser = await getParser(lang);
            const tree = parser.parse(content);
            let errorInfos: { line: number; text: string }[] = [];
            if (tree) {
                errorInfos = findErrorNodes(tree.rootNode).map((e) => ({
                    line: e.startPosition.row + 1,
                    text: e.text,
                }));
                tree.delete();
            }

            // The indexer must always return a FileIndex without throwing, even on a
            // file it can only grep-scan.
            const result = await indexFile(file, content, lang);
            assert.ok(result, `indexFile returned no FileIndex for ${rel}`);

            if (errorInfos.length === 0) {
                return; // clean parse — nothing to classify
            }

            // Classify the ERROR nodes. A clang `expected-` directive marks deliberately
            // malformed code; obsolete K&R / implicit-int syntax we accept as-is. Anything
            // else is a real tree-sitter gap (typically a near-standard GNU extension) and
            // is judged by SYMBOL RECOVERY: tree-sitter ERROR nodes are a grammar limit we
            // cannot remove, but the indexer must still recover the symbols (so F12 etc.
            // keep working). Every file-scope function definition must yield a `function`
            // symbol — if any is dropped, the file fails; otherwise it passes (recovered).
            const expected = EXPECTED_DIAG.test(content) || CLANG_NEGATIVE_RUN.test(content);
            const knr = !expected && looksLikeKnrImplicitInt(content);

            let missingFns: string[] = [];
            let category: 'expected' | 'knr' | 'recovered' | 'gap';
            if (expected) { expectedErrFiles++; category = 'expected'; }
            else if (knr) { knrErrFiles++; category = 'knr'; }
            else {
                const want = fileScopeFunctionNames(content);
                const have = new Set(
                    result.symbols.filter((s) => s.kind === 'function').map((s) => s.name),
                );
                missingFns = want.filter((n) => !have.has(n));
                if (missingFns.length === 0) { recoveredErrFiles++; category = 'recovered'; }
                else { unexpectedErrFiles.push(rel); category = 'gap'; }
            }

            const tag = category === 'gap'
                ? `gap: no fn symbol for ${missingFns.slice(0, 3).join(', ')}`
                : category;
            console.log(`\n[ERROR NODES] (${tag}) in ${rel}:`);
            for (const err of errorInfos.slice(0, 3)) {
                console.log(`  Line ${err.line}: ${flattenSnippet(err.text)}`);
            }
            if (errorInfos.length > 3) {
                console.log(`  ... and ${errorInfos.length - 3} more errors.`);
            }

            // The per-file verdict: a dropped file-scope function symbol fails the file.
            if (category === 'gap') {
                assert.fail(
                    `tree-sitter parse gap dropped function symbol(s) [${missingFns.join(', ')}] ` +
                    `in ${rel} (${errorInfos.length} ERROR/MISSING node(s); first at line ` +
                    `${errorInfos[0].line}: ${flattenSnippet(errorInfos[0].text, 80)})`,
                );
            }
        });
    }

    after(() => {
        console.log(
            `\n[ERROR NODE SUMMARY] expected=${expectedErrFiles} (clang negative tests) | ` +
            `knr=${knrErrFiles} (K&R/implicit-int) | ` +
            `recovered=${recoveredErrFiles} (ERROR but symbols recovered) | ` +
            `gap=${unexpectedErrFiles.length} (dropped function symbols → fail).`,
        );
        if (unexpectedErrFiles.length > 0) {
            const shown = unexpectedErrFiles.slice(0, 20).join(', ');
            const more = unexpectedErrFiles.length > 20 ? `, …(+${unexpectedErrFiles.length - 20})` : '';
            console.log(`  Gaps: ${shown}${more}`);
        }
    });
});

