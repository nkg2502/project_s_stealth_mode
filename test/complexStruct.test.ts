import { describe, it, before } from 'node:test';
import * as assert from 'node:assert/strict';
import { indexFile } from '../src/indexer/indexFile';
import { setupLiveParser } from './liveTestSetup';

describe('extract - complex nested structs and unions', () => {
    before(async () => {
        await setupLiveParser();
    });

    it('indexes every nested struct/union field as a symbol', async () => {
        const code = `
struct ComplexData {
    int id;
    union {
        struct {
            int x;
            int y;
        } point;
        struct {
            float angle;
            float radius;
        } polar;
        long rawData[2];
    } coords;
    struct NextLevel {
        char name[32];
        union {
            int val1;
            float val2;
        } data;
    } next;
};

struct {
    int global_a;
} global_struct;
        `;
        const idx = await indexFile('test.c', code, 'c');
        const names = idx.symbols.map(s => s.name);
        assert.ok(names.includes('id'), 'id should be parsed');
        assert.ok(names.includes('coords'), 'coords should be parsed');
        assert.ok(names.includes('point'), 'point should be parsed');
        assert.ok(names.includes('x'), 'x should be parsed');
        assert.ok(names.includes('y'), 'y should be parsed');
        assert.ok(names.includes('polar'), 'polar should be parsed');
        assert.ok(names.includes('angle'), 'angle should be parsed');
        assert.ok(names.includes('radius'), 'radius should be parsed');
        assert.ok(names.includes('rawData'), 'rawData should be parsed');
        assert.ok(names.includes('next'), 'next should be parsed');
        assert.ok(names.includes('name'), 'name should be parsed');
        assert.ok(names.includes('data'), 'data should be parsed');
        assert.ok(names.includes('val1'), 'val1 should be parsed');
        assert.ok(names.includes('val2'), 'val2 should be parsed');
        assert.ok(names.includes('global_struct'), 'global_struct should be parsed');
        assert.ok(names.includes('global_a'), 'global_a should be parsed');
    });
});
