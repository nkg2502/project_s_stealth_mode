import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { scanWithRegex } from '../src/indexer/regexScanner';

describe('regexScanner', () => {
    it('should NOT match struct parameter as definition', () => {
        const code = `int cifs_truncate_page(struct address_space *mapping, loff_t from) { return 0; }`;
        const res = scanWithRegex(code, 'test.c', 'c');
        const s = res.symbols.find(s => s.name === 'address_space' && s.kind === 'struct');
        assert.ok(!s, 'should NOT emit address_space as struct definition');
    });

    it('should match actual struct definition', () => {
        const code = `struct address_space { int x; };`;
        const res = scanWithRegex(code, 'test.c', 'c');
        const s = res.symbols.find(s => s.name === 'address_space' && s.kind === 'struct');
        assert.ok(s, 'should emit address_space as struct definition');
    });
});
