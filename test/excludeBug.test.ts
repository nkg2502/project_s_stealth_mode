import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as path from 'path';
import { ExclusionEngine } from '../src/indexer/exclusionEngine';

// Validates the extracted pure decision (ExclusionEngine.isExcludedInFolder)
// against real Windows absolute paths the way extension.ts feeds it: compute the
// folder-relative path + folder name, then delegate the whole decision to the
// engine (no logic duplicated in the host).
describe('Exclusion Bug Test', () => {
    it('isExcluded handles Windows paths correctly', () => {
        const engine = new ExclusionEngine();
        engine.setIncludeExclude(['**/fs/**'], ['**/linux-src/**']);

        const folder = 'c:\\repo\\project_sintra';
        const folderName = path.basename(folder);
        function isExcluded(fsPath: string): boolean {
            const rel = path.relative(folder, fsPath);
            if (rel.startsWith('..') || path.isAbsolute(rel)) {
                return false; // outside the workspace folder
            }
            return engine.isExcludedInFolder(rel, folderName);
        }

        const f1 = 'c:\\repo\\project_sintra\\linux-src\\Makefile';
        const f2 = 'c:\\repo\\project_sintra\\linux-src\\fs\\open.c';
        const f3 = 'c:\\repo\\project_sintra\\arch\\x86\\boot.c';

        assert.strictEqual(isExcluded(f1), true, 'Makefile should be excluded (matches the linux-src exclude)');
        assert.strictEqual(isExcluded(f2), false, 'open.c should be kept (the fs include re-admits it)');
        // gitignore semantics: a path matching NEITHER an exclude nor an include is
        // included by default. (Under the old whitelist mode this was excluded.)
        assert.strictEqual(isExcluded(f3), false, 'arch/x86/boot.c should be kept (matches no exclude rule)');
    });

    // The user-reported scenario: exclude `**/linux-src/**`, include `**/fs/**`.
    // Removing the linux-src exclude must ADD the previously-excluded linux-src
    // files back to the index (they now match no exclude rule). Under the old
    // whitelist mode the include `**/fs/**` capped the set, so removing the
    // exclude changed nothing — the bug this fix addresses.
    it('removing an exclude pattern re-admits its files (gitignore semantics)', () => {
        const folder = 'c:\\repo\\project_sintra';
        const folderName = path.basename(folder);
        const mm = 'c:\\repo\\project_sintra\\linux-src\\mm\\slab.c';
        function isExcludedWith(engine: ExclusionEngine, fsPath: string): boolean {
            const rel = path.relative(folder, fsPath);
            if (rel.startsWith('..') || path.isAbsolute(rel)) return false;
            return engine.isExcludedInFolder(rel, folderName);
        }

        const before = new ExclusionEngine();
        before.setIncludeExclude(['**/fs/**'], ['**/linux-src/**']);
        assert.strictEqual(isExcludedWith(before, mm), true, 'before: linux-src/mm is excluded');

        const after = new ExclusionEngine();
        after.setIncludeExclude(['**/fs/**'], []); // linux-src removed from exclude
        assert.strictEqual(isExcludedWith(after, mm), false, 'after: linux-src/mm is now included');
    });
});
