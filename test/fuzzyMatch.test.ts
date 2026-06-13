/**
 * Fuzzy matching test cases for fuzzyMatch / fuzzyFilterSymbols.
 * 
 * Run: npm test
 * 
 * Scoring is based on a modified Smith-Waterman algorithm (fzf-style):
 *   - SCORE_MATCH = 16 per matched char
 *   - GAP_START = -3, GAP_EXTENSION = -1 per gap char
 *   - Boundary/consecutive/camelCase bonuses
 *   - No magic score tiers on coverage coefficients
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { fuzzyMatch, fuzzyFilterSymbols } from '../src/store/fuzzyMatch';

describe('FuzzyMatch: Basic matching', () => {
    it('1. exact match returns high score', () => {
        const result = fuzzyMatch('SVC_IsMigration', 'SVC_IsMigration');
        assert.ok(result);
        assert.ok(result.score > 0, `exact match score (${result.score}) should be > 0`);
    });

    it('2. case-insensitive exact match scores same as case-sensitive', () => {
        const exact = fuzzyMatch('SVC_IsMigration', 'SVC_IsMigration');
        const lower = fuzzyMatch('svc_ismigration', 'SVC_IsMigration');
        assert.ok(exact);
        assert.ok(lower);
        assert.equal(exact.score, lower.score);
    });

    it('3. exact prefix match scores high', () => {
        const result = fuzzyMatch('SVC_Is', 'SVC_IsMigration');
        assert.ok(result);
        assert.ok(result.score > 0, `prefix score ${result.score} should be > 0`);
    });

    it('4. empty pattern matches everything with score 0', () => {
        const result = fuzzyMatch('', 'SVC_IsMigration');
        assert.ok(result);
        assert.equal(result.score, 0);
    });

    it('5. pattern longer than target returns null', () => {
        const result = fuzzyMatch('SVC_IsMigrationExtra', 'SVC_IsMigration');
        assert.equal(result, null);
    });

    it('6. completely unrelated pattern returns null', () => {
        const result = fuzzyMatch('xyz', 'SVC_IsMigration');
        assert.equal(result, null);
    });
});

describe('FuzzyMatch: SVC_IsMigration specific fuzzy scenarios', () => {
    const target = 'SVC_IsMigration';

    it('7. "svismigration" matches', () => {
        const result = fuzzyMatch('svismigration', target);
        assert.ok(result, 'should match');
        assert.ok(result.score > 0);
    });

    it('8. "svismigratin" matches', () => {
        const result = fuzzyMatch('svismigratin', target);
        assert.ok(result, 'should match even with missing "o" before "n"');
        assert.ok(result.score > 0);
    });

    it('9. "svismigration" scores higher than "svismigratin"', () => {
        const full = fuzzyMatch('svismigration', target);
        const typo = fuzzyMatch('svismigratin', target);
        assert.ok(full);
        assert.ok(typo);
        assert.ok(full.score > typo.score,
            `full (${full.score}) should beat typo (${typo.score})`);
    });

    it('10. "mir" matches via boundary initials', () => {
        const result = fuzzyMatch('sim', target);
        assert.ok(result, 'boundary initials should match');
    });

    it('11. "svcis" matches as prefix', () => {
        const result = fuzzyMatch('svcis', target);
        assert.ok(result, 'should match prefix portion');
    });

    it('12. "ismigr" matches substring', () => {
        const result = fuzzyMatch('ismigr', target);
        assert.ok(result, 'should match substring');
    });

    it('13. "svcismigration" matches full without underscore', () => {
        const result = fuzzyMatch('svcismigration', target);
        assert.ok(result, 'full name without underscore should match');
    });

    it('14. "svismigratoin" does NOT match (transposed)', () => {
        const result = fuzzyMatch('svismigratoin', target);
        assert.equal(result, null, 'transposed chars should not match');
    });

    it('15. "svzismigration" does NOT match', () => {
        const result = fuzzyMatch('svzismigration', target);
        assert.equal(result, null);
    });
});

// =========================================================================
// C. camelCase / snake_case boundary matching
// =========================================================================
describe('FuzzyMatch: Boundary matching', () => {
    it('16. "gbc" matches "get_buffer_count" via snake_case', () => {
        const result = fuzzyMatch('gbc', 'get_buffer_count');
        assert.ok(result);
    });

    it('17. "gbc" matches "getBufferCount" via camelCase', () => {
        const result = fuzzyMatch('gbc', 'getBufferCount');
        assert.ok(result);
    });

    it('18. "gbufcnt" matches "get_buffer_count" via partial boundary', () => {
        const result = fuzzyMatch('gbufcnt', 'get_buffer_count');
        assert.ok(result, 'partial boundary match');
    });

    it('19. "gbufcnt" matches "globalBufferCount" via partial boundary', () => {
        const result = fuzzyMatch('gbufcnt', 'globalBufferCount');
        assert.ok(result, 'partial camelCase boundary match');
    });

    it('20. "ir" matches "IsMigration" via boundaries', () => {
        const result = fuzzyMatch('ir', 'IsMigration');
        assert.ok(result);
    });
});

// =========================================================================
// D. Scoring & ordering
// =========================================================================
describe('FuzzyMatch: Scoring and ordering', () => {
    it('21. exact match ranks above prefix match', () => {
        // Same matched span produces equal raw score; length tiebreaker differentiates
        const results = fuzzyFilterSymbols([{ name: 'fooBar' }, { name: 'foo' }], 'foo');
        assert.equal(results.length, 2);
        assert.equal(results[0].item.name, 'foo',
            'exact match should rank first via length tiebreaker');
    });

    it('22. prefix match scores higher than substring match', () => {
        const prefix = fuzzyMatch('get', 'getBuffer');
        const substr = fuzzyMatch('get', 'my_getter');
        assert.ok(prefix);
        assert.ok(substr);
        assert.ok(prefix.score > substr.score,
            `prefix (${prefix.score}) should beat substring (${substr.score})`);
    });

    it('23. boundary match scores higher than scattered fuzzy', () => {
        const boundary = fuzzyMatch('gbc', 'get_buffer_count');
        const scattered = fuzzyMatch('gbc', 'g_abc_xyz');
        assert.ok(boundary);
        assert.ok(scattered);
        assert.ok(boundary.score > scattered.score,
            `boundary (${boundary.score}) should beat scattered (${scattered.score})`);
    });

    it('24. closer matches (less spread) score higher', () => {
        const tight = fuzzyMatch('abc', 'abcdef');
        const spread = fuzzyMatch('abc', 'a_b_c_def');
        assert.ok(tight);
        assert.ok(spread);
        assert.ok(tight.score > spread.score,
            `tight (${tight.score}) should beat spread (${spread.score})`);
    });
});

// =========================================================================
// E. FuzzyFilterSymbols
// =========================================================================
describe('FuzzyMatch: fuzzyFilterSymbols', () => {
    const symbols = [
        { name: 'SVC_IsMigration' },
        { name: 'SVC_InitScaleRatios' },
        { name: 'get_buffer_count' },
        { name: 'getBufferCount' },
        { name: 'globalBufferCount' },
        { name: 'foo_bar' },
        { name: 'unrelated_function' },
    ];

    it('25. "svc" returns SVC_ prefixed symbols first', () => {
        const results = fuzzyFilterSymbols(symbols, 'svc');
        assert.ok(results.length >= 2);
        assert.ok(results[0].item.name.startsWith('SVC_'));
        assert.ok(results[1].item.name.startsWith('SVC_'));
    });

    it('26. "gbc" returns all buffer count variants', () => {
        const results = fuzzyFilterSymbols(symbols, 'gbc');
        const names = results.map(r => r.item.name);
        assert.ok(names.includes('get_buffer_count'));
        assert.ok(names.includes('getBufferCount'));
        assert.ok(names.includes('globalBufferCount'));
    });

    it('27. maxResults limits output', () => {
        const results = fuzzyFilterSymbols(symbols, 'a', 2);
        assert.ok(results.length <= 2);
    });

    it('28. empty pattern returns empty array', () => {
        const results = fuzzyFilterSymbols(symbols, '');
        assert.equal(results.length, 0);
    });

    it('29. results are sorted by score descending', () => {
        const results = fuzzyFilterSymbols(symbols, 'buf');
        for (let i = 1; i < results.length; i++) {
            assert.ok(results[i - 1].score >= results[i].score,
                `result[${i - 1}].score (${results[i - 1].score}) should >= result[${i}].score (${results[i].score})`);
        }
    });

    it('30. "svismigration" finds SVC_IsMigration', () => {
        const results = fuzzyFilterSymbols(symbols, 'svismigration');
        assert.equal(results.length, 1);
        assert.equal(results[0].item.name, 'SVC_IsMigration');
    });

    it('31. "svismigratin" finds SVC_IsMigration', () => {
        const results = fuzzyFilterSymbols(symbols, 'svismigratin');
        assert.equal(results.length, 1);
        assert.equal(results[0].item.name, 'SVC_IsMigration');
    });
});

// =========================================================================
// F. RI-40: Custom sort order
// =========================================================================
describe('FuzzyMatch: RI-40 custom sort order preserved', () => {
    const symbols = [
        { name: 'DSP_VideoScalerCalcInit' },
        { name: 'SVC_Init' },
        { name: 'SVC_InitScaleRatios' },
        { name: 'SVC_IS_WAITING_SET_INSTANCE_ICTL_TERMINATE_ONE_SESSION_1' },
        { name: 'SVC_IS_WAITING_SET_INSTANCE_ICTL_TERMINATE_ONE_SESSION_2' },
        { name: 'SVC_IS_WAITING_SET_INSTANCE_ICTL_TERMINATE_ONE_SESSION_3' },
        { name: 'SVCUT_InitAll' },
        { name: 'MP_SVC_Init' },
        { name: 'MP_WinFwUnitTest' },
        { name: 'SVC_IsWaitingSetInstance_e' },
        { name: 'SVC_IsWaitingSetInstance_t' },
    ];

    it('32. "svcinit" - SVC_Init ranks first', () => {
        const results = fuzzyFilterSymbols(symbols, 'svcinit');
        assert.ok(results.length >= 2);
        assert.equal(results[0].item.name, 'SVC_Init',
            `SVC_Init should rank first, got "${results[0].item.name}"`);
    });

    it('33. "svcinit" - SVC_Init scores higher than DSP_VideoScalerCalcInit', () => {
        const results = fuzzyFilterSymbols(symbols, 'svcinit');
        const svcInit = results.find(r => r.item.name === 'SVC_Init');
        const paramInit = results.find(r => r.item.name === 'DSP_VideoScalerCalcInit');
        assert.ok(svcInit && paramInit);
        if (paramInit) {
            assert.ok(svcInit.score > paramInit.score,
                `SVC_Init (${svcInit.score}) > DSP (${paramInit.score})`);
        }
    });

    it('34. "svcinit" - SVC_InitScaleRatios ranks after SVC_Init', () => {
        const results = fuzzyFilterSymbols(symbols, 'svcinit');
        const idxInit = results.findIndex(r => r.item.name === 'SVC_Init');
        const idxScale = results.findIndex(r => r.item.name === 'SVC_InitScaleRatios');
        assert.ok(idxInit >= 0);
        assert.ok(idxScale >= 0);
        assert.ok(idxInit < idxScale,
            `SVC_Init (idx ${idxInit}) should rank before SVC_InitScaleRatios (idx ${idxScale})`);
    });

    it('35. "svcinit" - results sorted by score descending', () => {
        const results = fuzzyFilterSymbols(symbols, 'svcinit');
        for (let i = 1; i < results.length; i++) {
            assert.ok(results[i - 1].score >= results[i].score,
                `result[${i - 1}] "${results[i - 1].item.name}" (${results[i - 1].score}) should >= result[${i}] "${results[i].item.name}" (${results[i].score})`);
        }
    });

    it('36. FAIL SCENARIO: alphabetical label sort breaks score order', () => {
        const results = fuzzyFilterSymbols(symbols, 'svcinit');
        assert.ok(results.length >= 2);
        const asLabels = results.map(r => ({
            label: `${r.item.name}`,
            item: r.item,
            score: r.score,
        }));
        
        const alphabetical = [...asLabels].sort((a, b) => a.label.localeCompare(b.label));
        const scoreOrder = results.map(r => r.item);
        const alphaOrder = alphabetical.map(r => r.item);
        assert.notDeepEqual(alphaOrder, scoreOrder,
            'Alphabetical label sort should differ from score sort');
        const constAlphaIdxDSP = alphaOrder.indexOf(symbols[0]); // DSP
        const constAlphaIdxSVC = alphaOrder.indexOf(symbols[1]); // SVC_Init
        if (constAlphaIdxDSP >= 0 && constAlphaIdxSVC >= 0) {
            assert.ok(constAlphaIdxDSP < constAlphaIdxSVC,
                'In alpha sort, DSP wrongly precedes SVC_Init');
        }
    });

    it('37. FAIL SCENARIO: scattered match should NOT outrank prefix match', () => {
        const scattered = fuzzyFilterSymbols(symbols, 'svcinit');
        const idxDSP = scattered.findIndex(r => r.item.name === 'DSP_VideoScalerCalcInit');
        assert.ok(idxDSP >= 1);
        assert.equal(scattered[0].item.name, 'SVC_Init',
            'Prefix/boundary match must always outrank scattered match');
    });
});

// =========================================================================
// G. RI-41: Gap penalty naturally ranks tight matches above long scattered ones
// =========================================================================
describe('FuzzyMatch: RI-41 gap penalty ranking', () => {
    const symbols = [
        { name: 'SVR_NODE_VFS_BLOCK_POOL_DESC_VEC_CACHE_LINE_INDEX_NEXT_CTRL_INFO' },
        { name: 'SVR_NODE_VFS_BLOCK_POOL_DESC_VEC_CACHE_LINE_INDEX_NEXT_CTRL_INFO_s' },
        { name: 'SVR_NODE_VFS_BLOCK_POOL_DESC_VEC_CACHE_LINE_INDEX_NEXT_CTRL_INFO_t' },
        { name: 'SVR_NODE_VFS_BLOCK_POOL_DESC_VEC_CACHE_LINE_INDEX_NEXT_CTRL_INFO_u' },
        { name: 'SVC_IndependentHandler' },
        { name: 'SVC_Init' },
        { name: 'SVC_InitScaleRatios' },
        { name: 'WP_SVC_Init' },
        { name: 'SVCUT_InitAll' },
        { name: 'SVC_UT_INJECT_EXCEPTION' },
        { name: 'SVC_MSG_INFO' },
        { name: 'SvcLogInfo' },
        { name: 'svcLogInfo' },
    ];

    it('38. "svcin" - SVC_Init ranks first', () => {
        const results = fuzzyFilterSymbols(symbols, 'svcin');
        assert.ok(results.length >= 2);
        assert.equal(results[0].item.name, 'SVC_Init',
            `SVC_Init should rank first, got "${results[0].item.name}"`);
    });

    it('39. "svcin" - SVC_Init scores higher than SVR long name', () => {
        const svcInit = fuzzyMatch('svcin', 'SVC_Init');
        const longName = fuzzyMatch('svcin', 'SVR_NODE_VFS_BLOCK_POOL_DESC_VEC_CACHE_LINE_INDEX_NEXT_CTRL_INFO');
        assert.ok(svcInit);
        assert.ok(longName);
        assert.ok(svcInit.score > longName.score,
            `SVC_Init (${svcInit.score}) > SVR (${longName.score})`);
    });

    it('40. "svcin" - shorter target wins tiebreaker on equal match span', () => {
        const results = fuzzyFilterSymbols(
            [{ name: 'SVC_Init' }, { name: 'SVC_InitScaleRatios' }], 'svcin');
        assert.equal(results.length, 2);
        assert.equal(results[0].item.name, 'SVC_Init',
            'SVC_Init should rank first due to shorter length tiebreaker');
    });

    it('41. "svcin" - all SVR variants rank below SVC variants', () => {
        const results = fuzzyFilterSymbols(symbols, 'svcin');
        const firstDwcIdx = results.findIndex(r => r.item.name.startsWith('SVR_'));
        const lastSvcIdx = results.reduce((acc, r, i) => {
            return r.item.name.match(/^(SVC|SVCUT|svc|Svc)/) ? i : acc;
        }, -1);
        assert.ok(firstDwcIdx >= 0, 'SVR should be in results');
        assert.ok(lastSvcIdx >= 0, 'SVC variants should be in results');
        assert.ok(lastSvcIdx < firstDwcIdx,
            'All SVC variants should rank before SVR');
    });

    it('42. "svcin" - results sorted by score descending', () => {
        const results = fuzzyFilterSymbols(symbols, 'svcin');
        for (let i = 1; i < results.length; i++) {
            assert.ok(results[i - 1].score >= results[i].score,
                `result[${i - 1}] "${results[i - 1].item.name}" (${results[i - 1].score}) should >= result[${i}] "${results[i].item.name}" (${results[i].score})`);
        }
    });

    it('43. exact ranks above prefix via tiebreaker', () => {
        // Same matched span = equal raw score; length tiebreaker differentiates
        const results = fuzzyFilterSymbols(
            [{ name: 'SVC_InitScaleRatios' }, { name: 'SVC_Init' }], 'SVC_Init');
        assert.equal(results.length, 2);
        assert.equal(results[0].item.name, 'SVC_Init',
            'exact match should rank first via length tiebreaker');
    });

    it('44. prefix > scattered ordering preserved', () => {
        // NOTE: pattern is 'svcint' (not 'svcinit'); "SVC_IndependentHandler"
        // contains only one 'i', so 'svcinit' is not a subsequence of it and
        // could never match under strict-subsequence semantics (which ~30 other
        // tests rely on). 'svcint' preserves the intent: a tight prefix match
        // (SVC_Init) must outrank the same chars scattered across a long name.
        const prefix = fuzzyMatch('svcint', 'SVC_Init');
        const boundary = fuzzyMatch('svcint', 'SVC_IndependentHandler');
        assert.ok(prefix);
        assert.ok(boundary);
        if (boundary) {
            assert.ok(prefix.score > boundary.score,
                `prefix (${prefix.score}) > scattered (${boundary.score})`);
        }
    });
});

// =========================================================================
// H. Failure scenarios: demonstrate WHY gap penalty is correct
// =========================================================================
describe('FuzzyMatch: Failure scenarios without gap penalty', () => {
    it('45. FAIL SCENARIO: gap penalty makes long scattered matches score low', () => {
        // SVR matches "svcin" with chars spread across 63 chars.
        // Each gap accumulates penalty (-3 start, -1 extension).
        // SVC_Init has almost no gaps.
        const short = fuzzyMatch('svcin', 'SVC_Init');
        const long = fuzzyMatch('svcin', 'SVR_NODE_VFS_BLOCK_POOL_DESC_VEC_CACHE_LINE_INDEX_NEXT_CTRL_INFO');
        assert.ok(short);
        assert.ok(long);
        const diff = short.score - long.score;
        assert.ok(diff > short.score * 0.2,
            `Score diff (${diff}) should be >=20% of short score (${short.score}) \n` +
            `  -- gap penalty inherently penalizes sparse matches without magic coefficients`);
    });

    it('46. FAIL SCENARIO: wider gaps score lower than narrow gaps', () => {
        // In old heuristic system, boundary matches used fixed base score
        // regardless of gap size. With SW, wider gaps score lower.
        const tight = fuzzyMatch('mi', 'M_Init');
        const wide = fuzzyMatch('mi', 'MEGA_Init');
        assert.ok(tight);
        assert.ok(wide);
        assert.ok(tight.score > wide.score,
            `Tight gap (${tight.score}) > wide gap (${wide.score}) \n` +
            `  -- structurally impossible with fixed base scores`);
    });

    it('47. FAIL SCENARIO: contrived long name does not dominate via boundary count', () => {
        // In old system: more boundaries = higher score. In SW: large gaps penalize.
        const longSym = 'MEGA_VERY_POWERFUL_INTERESTING_NESTED_STRUCTURE_MEMBER_VARIABLE_POINTER_INIT_FLAG';
        const shortSym = 'SVC_Init';
        const longResult = fuzzyMatch('svcin', longSym);
        const shortResult = fuzzyMatch('svcin', shortSym);
        assert.ok(shortResult);
        if (longResult) {
            assert.ok(shortResult.score > longResult.score,
                `SVC_Init (${shortResult.score}) > long name (${longResult.score}) \n` +
                `  -- gap penalty naturally suppresses long scattered matches`);
        }
    });
});
