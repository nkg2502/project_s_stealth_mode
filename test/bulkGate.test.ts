import { test, before } from 'node:test';
import assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { setupLiveParser, withVscodeStub } from './liveTestSetup';
import { openDb, createWriter, findDefinitions } from '../src/store/db';
import { indexFile } from '../src/indexer/indexFile';
import type { Host } from '../src/core/host';

// During a bulk/full workspace scan the host must not read the DB at all: the
// name indexes are dropped (drop/create bulk strategy) and the writer holds the
// DB, so a host-side point query would full-scan multi-million-row tables and
// freeze the synchronous host thread. The single chokepoint is Host.getDb():
// while `bulkIndexing` is set it returns undefined, so every navigation path
// (F12 command, F10 search, Definition/Reference providers) naturally abstains
// and only serves once the scan finishes. This is the user-requested behaviour:
// don't show anything in F12/F10/providers during a scan, show it after.

before(async () => {
  await setupLiveParser();
});

test('getDb() abstains during a bulk scan, serves before/after', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sintra-bulkgate-'));
  const dbPath = path.join(dir, 'index.db');
  const writeDb = openDb(dbPath);
  const writer = createWriter(writeDb);
  const fi = await indexFile('/x.c', 'int foo(void) { return 0; }', 'c');
  writer.applyBatch([{ fi, mtime: 1 }]);

  try {
    const host = withVscodeStub(() => {
      const { Host } = require('../src/core/host') as { Host: new (p: string, o: unknown) => Host };
      return new Host(dbPath, {});
    });

    // Not scanning: the host serves reads and finds the symbol.
    const dbBefore = host.getDb();
    assert.ok(dbBefore, 'getDb() should return a connection when not bulk-indexing');
    assert.equal(findDefinitions(dbBefore!, 'foo').length, 1, 'foo should be found before a scan');

    // Bulk scan in progress: the host serves NO reads at all.
    host.bulkIndexing = true;
    assert.equal(host.getDb(), undefined, 'getDb() must return undefined during a bulk scan');

    // Scan finished: reads resume and the symbol is found again.
    host.bulkIndexing = false;
    const dbAfter = host.getDb();
    assert.ok(dbAfter, 'getDb() should serve again after the scan');
    assert.equal(findDefinitions(dbAfter!, 'foo').length, 1, 'foo should be found after the scan');
  } finally {
    try { writeDb.close(); } catch { /* ignore */ }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});
