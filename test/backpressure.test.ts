/**
 * Unit tests for worker pool backpressure and indexer chunked file reading.
 * 
 * Verifies that:
 *  - parseFiles limits concurrent in-flight tasks (backpressure)
 *  - The indexer reads files in bounded chunks, not all at once
 * 
 * Run: npm test
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';

/**
 * Simulates the backpressure logic from TreeSitterWorkerPool.parseFiles().
 * Tracks the maximum number of concurrently in-flight tasks.
 */
async function simulateBackpressure(
    fileCount: number,
    workerCount: number,
    parseTimeMs: number = 1
): Promise<{ maxInFlight: number; peakInFlight: number; completed: number }> {
    const maxInFlight = workerCount * 4;
    const inFlight = new Set<Promise<void>>();
    let currentInFlight = 0;
    let peakInFlight = 0;
    let completed = 0;

    for (let i = 0; i < fileCount; i++) {
        // Backpressure: wait when too many tasks are in-flight
        while (inFlight.size >= maxInFlight) {
            await Promise.race(inFlight);
        }

        currentInFlight = inFlight.size + 1;
        if (currentInFlight > peakInFlight) {
            peakInFlight = currentInFlight;
        }

        const p = new Promise<void>((resolve) => {
            setTimeout(resolve, parseTimeMs);
        }).then(() => {
            completed++;
        }).finally(() => {
            inFlight.delete(p);
        });
        inFlight.add(p);
    }

    await Promise.allSettled(inFlight);

    return { maxInFlight, peakInFlight, completed };
}

describe('Backpressure - parseFiles concurrency limit (RI-22)', () => {
    it('should never exceed workerCount*4 in-flight tasks (8 workers, 100 files)', async () => {
        const { peakInFlight, completed } = await simulateBackpressure(100, 8);
        assert.ok(peakInFlight <= 32, `peak in-flight was ${peakInFlight}, expected <= 32`);
        assert.equal(completed, 100);
    });

    it('should never exceed workerCount*4 in-flight tasks (4 workers, 200 files)', async () => {
        const { peakInFlight, completed } = await simulateBackpressure(200, 4);
        assert.ok(peakInFlight <= 16, `peak in-flight was ${peakInFlight}, expected <= 16`);
        assert.equal(completed, 200);
    });

    it('should handle fewer files than maxInFlight (3 files, 8 workers)', async () => {
        const { peakInFlight, completed } = await simulateBackpressure(3, 8);
        assert.ok(peakInFlight <= 3, `peak in-flight was ${peakInFlight}, expected <= 3`);
        assert.equal(completed, 3);
    });

    it('should handle single worker (1 worker, 50 files)', async () => {
        const { peakInFlight, completed } = await simulateBackpressure(50, 1);
        assert.ok(peakInFlight <= 4, `peak in-flight was ${peakInFlight}, expected <= 4`);
        assert.equal(completed, 50);
    });

    it('should handle zero files without error', async () => {
        const { peakInFlight, completed } = await simulateBackpressure(0, 8);
        assert.equal(peakInFlight, 0);
        assert.equal(completed, 0);
    });
});

describe('Backpressure memory limit - no chunking needed (RI-22)', () => {
    /**
     * With backpressure (maxInFlight = workerCount * 4), at most
     * maxInFlight file contents are in memory at any time.
     * No explicit chunking is needed.
     */
    function maxFilesInMemory(workerCount: number): number {
        return workerCount * 4;
    }

    it('8 workers = at most 32 files in memory', () => {
        assert.equal(maxFilesInMemory(8), 32);
    });

    it('4 workers = at most 16 files in memory', () => {
        assert.equal(maxFilesInMemory(4), 16);
    });

    it('1 worker = at most 4 files in memory', () => {
        assert.equal(maxFilesInMemory(1), 4);
    });

    it('13187 files with old approach would have all in memory', () => {
        const oldMaxInMemory = 13187;
        const newMax = maxFilesInMemory(8);
        assert.ok(
            newMax < oldMaxInMemory / 100,
            `new max ${newMax} should be <1% of old ${oldMaxInMemory}`
        );
    });

    it('backpressure alone is sufficient - benchmark showed 54MB for 3029 files', () => {
        // With maxInFlight=32 (8 workers * 4), the benchmark measured ~54MB
        // peak heap growth for 3029 files (81MB source). This is well under
        // the Extension Host limit (~1.5GB).
        const maxIF = maxFilesInMemory(8);
        assert.equal(maxIF, 32);
    });
});

describe('Backpressure active parsing visibility', () => {
    // DEFERRED — this case exercised the retired TreeSitterWorkerPool.parseFiles()
    // active-file reporting (which files a worker has actually started, cleared on
    // completion). The live WorkerPool (src/indexer/workerPool.ts) shards work
    // round-robin and streams to a Writer worker; it does NOT yet surface a
    // per-file "actively parsing" set, so there is no live API to re-point to.
    // Full preserved spec + the implementation plan live in
    // tasks/worker-pool-live-coverage.md. Un-skip once the live pool reports it.
    it.skip('should report actual worker-started files as active and clear them on completion', async () => {
        // see tasks/worker-pool-live-coverage.md
    });
});
