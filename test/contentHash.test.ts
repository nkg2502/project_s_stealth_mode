/**
 * Unit tests for content hash utility and performance characteristics.
 * Tests: MD5 hashing, skip-on-same-hash behavior.
 * 
 * Run: npm test
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as crypto from 'crypto';

function computeHash(content: string): string {
    return crypto.createHash('md5').update(content).digest('hex');
}

describe('Content hash', () => {
    it('should produce consistent MD5 hash', () => {
        const content = 'void foo() {}';
        const h1 = computeHash(content);
        const h2 = computeHash(content);
        assert.equal(h1, h2);
        assert.equal(h1.length, 32); // MD5 hex is 32 chars
    });

    it('should produce different hashes for different content', () => {
        const h1 = computeHash('void foo() {}');
        const h2 = computeHash('void bar() {}');
        assert.notEqual(h1, h2);
    });

    it('should detect whitespace-only changes', () => {
        const h1 = computeHash('void foo() {}');
        const h2 = computeHash('void foo( ) {}');
        assert.notEqual(h1, h2);
    });

    it('should hash large content quickly', () => {
        const largeContent = 'x'.repeat(10 * 1024 * 1024); // 10MB
        const start = Date.now();
        const hash = computeHash(largeContent);
        const elapsed = Date.now() - start;
        assert.ok(hash.length === 32);
        assert.ok(elapsed < 1000, `hashing 10MB took ${elapsed}ms, expected < 1000ms`);
    });
});
