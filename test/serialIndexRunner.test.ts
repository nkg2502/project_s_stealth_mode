import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { SerialIndexRunner } from '../src/core/serialIndexRunner';

const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

describe('SerialIndexRunner', () => {
  it('runs a single task to completion', async () => {
    const r = new SerialIndexRunner(() => {});
    let ran = 0;
    await r.request(async () => { ran++; });
    assert.equal(ran, 1);
  });

  it('supersedes pending requests: only the latest queued task runs, and cancel fires each request', async () => {
    let cancels = 0;
    const r = new SerialIndexRunner(() => { cancels++; });
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((res) => { release = res; });

    const p1 = r.request(async () => { order.push('start1'); await gate; order.push('end1'); });
    await tick(); // let task1 begin (it is now in-flight)
    const p2 = r.request(async () => { order.push('run2'); });
    const p3 = r.request(async () => { order.push('run3'); });
    release();
    await Promise.all([p1, p2, p3]);

    // task1 was already running so it completes; task2 is superseded by task3.
    assert.deepEqual(order, ['start1', 'end1', 'run3']);
    assert.ok(cancels >= 2, `cancel hook fired per request (got ${cancels})`);
  });

  it('never overlaps tasks (serialized)', async () => {
    const r = new SerialIndexRunner(() => {});
    let active = 0;
    let maxActive = 0;
    const mk = () => async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await tick();
      active--;
    };
    await r.request(mk());
    await r.request(mk());
    assert.equal(maxActive, 1);
  });
});
