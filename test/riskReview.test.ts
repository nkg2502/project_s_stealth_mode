/**
 * Regression tests for review findings.
 *
 * 1) saveAsync() snapshot concurrency — obsolete (the live store is on-disk
 *    node:sqlite with no in-memory save-snapshot model).
 * 2) worker failure/exit must not leave a pending request hanging (live
 *    IndexWorker / WorkerClientBase).
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { IndexWorker } from '../src/indexer/workerClient';
import type { WorkerLike } from '../src/indexer/workerClient';

function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function settlesWithin<T>(promise: Promise<T>, ms: number): Promise<boolean> {
    return Promise.race([
        promise.then(() => true, () => true),
        delay(ms).then(() => false),
    ]);
}

describe('Review Risk #1 - saveAsync concurrency (obsolete)', () => {
    it.skip('should keep the latest snapshot when two saveAsync calls overlap', () => {
        // obsolete: the live store is on-disk node:sqlite (DatabaseSync) with no
        // in-memory snapshot, so there is no saveAsync()/.tmp-rename model to make
        // concurrency-safe. Persistence across connections is the openDb reopen
        // path (covered by database.test.ts "persist and reload across connections").
    });
});

type WorkerListener = (...args: unknown[]) => void;

/**
 * A fake worker that crashes (emits 'error' then a non-zero 'exit') the instant
 * it receives a message, before ever replying — the exact failure the live
 * WorkerClientBase must survive without leaving its request promise pending.
 */
class FakeWorker implements WorkerLike {
    private listeners = new Map<string, WorkerListener[]>();

    on(event: string, listener: WorkerListener): this {
        const current = this.listeners.get(event) ?? [];
        current.push(listener);
        this.listeners.set(event, current);
        return this;
    }

    postMessage(_message: unknown): void {
        // Simulate a crash/exit before sending a result message.
        this.emit('error', new Error('synthetic worker crash'));
        this.emit('exit', 1);
    }

    terminate(): Promise<number> {
        return Promise.resolve(0);
    }

    private emit(event: string, ...args: unknown[]): void {
        const current = this.listeners.get(event);
        if (!current) return;
        for (const listener of [...current]) {
            listener(...args);
        }
    }
}

describe('Review Risk #2 - worker failure handling (live IndexWorker)', () => {
    it('settles a pending request when the worker errors/exits before responding', async () => {
        // Re-pointed from the retired TreeSitterWorkerPool to the live worker
        // client. WorkerClientBase rejects every pending request on worker
        // 'error' and on non-zero 'exit' (src/indexer/workerClient.ts:55-68), so
        // a crashing worker can never leave reindexContent() hanging. (The old
        // "worker removed from pool" assertion was a TreeSitterWorkerPool
        // lifecycle concern; the live WorkerPool uses a different sharded design
        // and is out of scope for this client-level guarantee.)
        const client = new IndexWorker(
            'unused-worker-path',
            { runtimeWasmPath: '', grammarPaths: {} },
            undefined,
            ':memory:',
            undefined,
            new FakeWorker(),
        );

        const settled = await settlesWithin(
            client.reindexContent('crash.c', 'void f(void) {}'),
            80,
        );

        // Correct behavior: the request settles (rejects) instead of hanging.
        assert.equal(settled, true);
        await client.dispose();
    });
});
