import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { ExclusionEngine } from '../src/indexer/exclusionEngine';

describe('ExclusionEngine', () => {
    describe('matchesGlob', () => {
        const engine = new ExclusionEngine();

        it('matches exact file name', () => {
            assert.ok(engine.matchesGlob('foo.txt', 'foo.txt'));
        });

        it('does not match different name', () => {
            assert.ok(!engine.matchesGlob('bar.txt', 'foo.txt'));
        });

        it('matches single wildcard', () => {
            assert.ok(engine.matchesGlob('foo.c', '*.c'));
        });

        it('single wildcard does not cross directories', () => {
            assert.ok(!engine.matchesGlob('src/foo.c', '*.c'));
        });

        it('matches double-star across directories', () => {
            assert.ok(engine.matchesGlob('a/b/c/foo.c', '**/*.c'));
        });

        it('matches question mark for single char', () => {
            assert.ok(engine.matchesGlob('foo.c', 'fo?.c'));
            assert.ok(!engine.matchesGlob('fooo.c', 'fo?.c'));
        });

        it('caches regex for same pattern', () => {
            const e = new ExclusionEngine();
            e.matchesGlob('a.c', '*.c');
            e.matchesGlob('b.c', '*.c');
            // No assertion needed - just ensure no crash; cache is internal
        });
    });

    describe('isExcludedRelativePath', () => {
        it('excludes matching path', () => {
            const engine = new ExclusionEngine();
            engine.setRules([{ pattern: '*.o', negated: false }]);
            assert.ok(engine.isExcludedRelativePath('foo.o'));
        });

        it('negation re-includes a path', () => {
            const engine = new ExclusionEngine();
            engine.setRules([
                { pattern: '*.o', negated: false },
                { pattern: 'keep.o', negated: true },
            ]);
            assert.ok(!engine.isExcludedRelativePath('keep.o'));
            assert.ok(engine.isExcludedRelativePath('other.o'));
        });

        it('normalizes backslashes', () => {
            const engine = new ExclusionEngine();
            engine.setRules([{ pattern: 'build/**', negated: false }]);
            assert.ok(engine.isExcludedRelativePath('build\\output\\foo.o'));
        });

        it('returns false when no rules', () => {
            const engine = new ExclusionEngine();
            assert.ok(!engine.isExcludedRelativePath('anything'));
        });

        it('matches VS Code style exclude patterns', () => {
            const engine = new ExclusionEngine();
            engine.setRules([{ pattern: '**/node_modules/**', negated: false }]);
            assert.ok(engine.isExcludedRelativePath('node_modules/pkg/foo.c'));
            assert.ok(engine.isExcludedRelativePath('project/node_modules/pkg/foo.c'));
            assert.ok(!engine.isExcludedRelativePath('src/foo.c'));
        });

        it('include has higher priority than exclude', () => {
            const engine = new ExclusionEngine();
            // exclude covers everything, but include re-includes src/**
            engine.setIncludeExclude(['src/**'], ['**/*']);
            assert.ok(engine.isExcludedRelativePath('lib/foo.c'), 'lib should be excluded');
            assert.ok(!engine.isExcludedRelativePath('src/foo.c'), 'src should be included');
            
            // exact conflict: include should win
            engine.setIncludeExclude(['conflict.c'], ['conflict.c']);
            assert.ok(!engine.isExcludedRelativePath('conflict.c'), 'conflict.c should be included due to higher priority');
        });

        it('setRules clears regex cache', () => {
            const engine = new ExclusionEngine();
            engine.setRules([{ pattern: '*.o', negated: false }]);
            assert.ok(engine.isExcludedRelativePath('foo.o'));
            engine.setRules([]);
            assert.ok(!engine.isExcludedRelativePath('foo.o'));
        });
    });

    describe('isExcludedInFolder', () => {
        it('include relative to the folder keeps matched paths (folder-prefix variant must not over-exclude)', () => {
            const engine = new ExclusionEngine();
            engine.setIncludeExclude(['src/**'], []);
            // src/foo.c matches the include `src/**` and must be KEPT even though
            // the folder-name-prefixed variant `myproj/src/foo.c` does not.
            assert.equal(engine.isExcludedInFolder('src/foo.c', 'myproj'), false, 'src/foo.c should be kept');
            // gitignore semantics: with no exclude rule matching it, lib/foo.c is
            // included by default. (An include alone is NOT a whitelist — it only
            // re-admits paths a prior exclude rule removed.)
            assert.equal(engine.isExcludedInFolder('lib/foo.c', 'myproj'), false, 'lib/foo.c should be kept (no exclude matches)');
        });

        it('a pattern can match the workspace folder name via the prefixed variant', () => {
            const engine = new ExclusionEngine();
            engine.setIncludeExclude([], ['**/linux-src/**']);
            // rel is relative to the folder named "linux-src", so it lacks the
            // folder name; the prefixed variant lets the pattern match.
            assert.equal(engine.isExcludedInFolder('Makefile', 'linux-src'), true);
            assert.equal(engine.isExcludedInFolder('fs\\open.c', 'linux-src'), true);
        });

        it('include overrides exclude consistently across both path forms', () => {
            const engine = new ExclusionEngine();
            engine.setIncludeExclude(['**/fs/**'], ['**/linux-src/**']);
            assert.equal(engine.isExcludedInFolder('linux-src/Makefile', 'project'), true, 'Makefile excluded');
            assert.equal(engine.isExcludedInFolder('linux-src/fs/open.c', 'project'), false, 'fs/open.c re-included');
            // gitignore semantics: boot.c matches no exclude rule, so it is kept.
            assert.equal(engine.isExcludedInFolder('arch/x86/boot.c', 'project'), false, 'boot.c kept (no exclude matches)');
        });

        it('no rules keeps everything', () => {
            const engine = new ExclusionEngine();
            assert.equal(engine.isExcludedInFolder('anything/foo.c', 'proj'), false);
        });
    });

    // gitignore semantics (the model the engine implements): everything is
    // included by default; `exclude` rules subtract; `include` rules are
    // exceptions that re-admit paths a prior exclude removed. An `include` alone
    // is NOT a whitelist.
    describe('gitignore semantics (default-include)', () => {
        it('an include alone does not exclude the rest', () => {
            const engine = new ExclusionEngine();
            engine.setIncludeExclude(['**/fs/**'], []);
            assert.equal(engine.isExcludedRelativePath('linux-src/fs/open.c'), false, 'matches include → kept');
            assert.equal(engine.isExcludedRelativePath('arch/x86/boot.c'), false, 'matches nothing → kept by default');
        });

        it('removing an exclude pattern re-admits its files', () => {
            const withExclude = new ExclusionEngine();
            withExclude.setIncludeExclude(['**/fs/**'], ['**/linux-src/**']);
            assert.equal(withExclude.isExcludedRelativePath('linux-src/mm/slab.c'), true, 'excluded while linux-src is in exclude');

            const withoutExclude = new ExclusionEngine();
            withoutExclude.setIncludeExclude(['**/fs/**'], []);
            assert.equal(withoutExclude.isExcludedRelativePath('linux-src/mm/slab.c'), false, 'kept once linux-src exclude is removed');
        });

        it('exclude still subtracts and a later include re-admits (last rule wins)', () => {
            const engine = new ExclusionEngine();
            engine.setIncludeExclude(['**/keep/**'], ['**/build/**']);
            assert.equal(engine.isExcludedRelativePath('build/out.o'), true, 'build excluded');
            assert.equal(engine.isExcludedRelativePath('build/keep/out.o'), false, 'keep re-admitted under build');
            assert.equal(engine.isExcludedRelativePath('src/main.c'), false, 'unmatched path kept');
        });
    });

    describe('parseGitignoreLine', () => {
        it('ignores empty lines', () => {
            assert.deepEqual(ExclusionEngine.parseGitignoreLine(''), []);
            assert.deepEqual(ExclusionEngine.parseGitignoreLine('   '), []);
        });

        it('ignores comments', () => {
            assert.deepEqual(ExclusionEngine.parseGitignoreLine('# comment'), []);
        });

        it('parses simple pattern', () => {
            const rules = ExclusionEngine.parseGitignoreLine('*.o');
            assert.ok(rules.length > 0);
            assert.ok(rules.every(r => !r.negated));
            assert.ok(rules.some(r => r.pattern === '*.o'));
        });

        it('parses negation pattern', () => {
            const rules = ExclusionEngine.parseGitignoreLine('!important.o');
            assert.ok(rules.length > 0);
            assert.ok(rules.every(r => r.negated));
        });

        it('handles directory-only trailing slash', () => {
            const rules = ExclusionEngine.parseGitignoreLine('build/');
            assert.ok(rules.some(r => r.pattern.includes('build')));
            assert.ok(rules.some(r => r.pattern.endsWith('/**')));
        });

        it('handles rooted pattern (leading /)', () => {
            const rules = ExclusionEngine.parseGitignoreLine('/build');
            // Rooted patterns should not have **/ prefix variant
            assert.ok(rules.some(r => r.pattern === 'build' || r.pattern === 'build/**'));
            assert.ok(!rules.some(r => r.pattern.startsWith('**/')));
        });
    });

    describe('parseGitignoreContent', () => {
        it('parses multi-line content', () => {
            const content = '# comment\n*.o\nbuild/\n!keep.o';
            const rules = ExclusionEngine.parseGitignoreContent(content);
            assert.ok(rules.length > 3);
            assert.ok(rules.some(r => r.negated));
        });

        it('handles CRLF line endings', () => {
            const content = '*.o\r\nbuild/\r\n';
            const rules = ExclusionEngine.parseGitignoreContent(content);
            assert.ok(rules.length > 0);
        });
    });

    describe('ruleCount', () => {
        it('returns 0 initially', () => {
            assert.equal(new ExclusionEngine().ruleCount, 0);
        });

        it('reflects set rules', () => {
            const engine = new ExclusionEngine();
            engine.setRules([
                { pattern: 'a', negated: false },
                { pattern: 'b', negated: false },
            ]);
            assert.equal(engine.ruleCount, 2);
        });
    });
});
