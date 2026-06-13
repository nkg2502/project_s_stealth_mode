import * as path from 'path';
import * as fs from 'fs';
import { WorkerPool } from '../src/indexer/workerPool';
import { ensureSchema } from '../src/store/db';
import type { WorkerAssets } from '../src/indexer/workerClient';

const TEST_DIR = path.join(__dirname, '..', '..', '.benchmark-tmp');
const EXTENSION_PATH = path.join(__dirname, '..', '..');
const LINUX_SRC_DIR = path.join(EXTENSION_PATH, 'test', 'linux-src');

const assets: WorkerAssets = {
  runtimeWasmPath: path.join(EXTENSION_PATH, 'dist', 'tree-sitter.wasm'),
  grammarPaths: {
    c: path.join(EXTENSION_PATH, 'dist', 'grammars', 'tree-sitter-c.wasm'),
    cpp: path.join(EXTENSION_PATH, 'dist', 'grammars', 'tree-sitter-cpp.wasm'),
  },
};

function findSourceFiles(dir: string): string[] {
  const result: string[] = [];
  function walk(current: string) {
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        walk(path.join(current, e.name));
      } else if (e.isFile() && /\.(c|h|cpp|hpp)$/.test(e.name)) {
        result.push(path.join(current, e.name));
      }
    }
  }
  walk(dir);
  return result;
}

async function runBenchmark(files: string[], workerCount: number) {
  if (!fs.existsSync(TEST_DIR)) {
    fs.mkdirSync(TEST_DIR, { recursive: true });
  }
  const dbPath = path.join(TEST_DIR, `benchmark_${workerCount}.db`);
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  if (fs.existsSync(dbPath + '-wal')) fs.unlinkSync(dbPath + '-wal');
  if (fs.existsSync(dbPath + '-shm')) fs.unlinkSync(dbPath + '-shm');

  ensureSchema(dbPath, 3); // using version 3 (0.0.3) schema

  const pool = new WorkerPool(
    path.join(EXTENSION_PATH, 'dist', 'worker.js'),
    dbPath,
    assets,
    undefined,
    workerCount
  );

  console.log(`Starting benchmark with ${workerCount} workers...`);
  const start = performance.now();
  await pool.indexAll(files);
  const end = performance.now();
  
  const timeMs = end - start;
  console.log(`WorkerCount ${workerCount}: ${(timeMs / 1000).toFixed(2)}s`);
  
  await pool.dispose();

  // Print DB size
  try {
    const stat = fs.statSync(dbPath);
    console.log(`DB Size: ${(stat.size / 1024 / 1024).toFixed(2)} MB`);
  } catch (e) {}

  // Cleanup
  try {
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
    if (fs.existsSync(dbPath + '-wal')) fs.unlinkSync(dbPath + '-wal');
    if (fs.existsSync(dbPath + '-shm')) fs.unlinkSync(dbPath + '-shm');
  } catch (e) {
    // ignore if locked
  }

  return timeMs;
}

async function main() {
  console.log(`Scanning for source files in ${LINUX_SRC_DIR}...`);
  const files = findSourceFiles(LINUX_SRC_DIR);
  console.log(`Found ${files.length} C/C++ files.`);
  
  const counts = [1, 2, 4, 8, 16];
  
  for (const c of counts) {
    await runBenchmark(files, c);
  }

  try {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  } catch (e) {}
}

main().catch(console.error);
