import { createHash } from 'node:crypto';
import type { ParseOptions } from 'web-tree-sitter';
import type { FileIndex, Lang } from '../core/types';
import { getParser } from './parser';
import { extractFromTree } from './extract';
import { scanWithRegex } from './regexScanner';
import { applyMacroWrappedVars } from './macroWrappedVars';

// Pure per-file indexing entry point: decides tree-sitter vs grep fallback and
// returns a FileIndex. The worker calls this; headless tests exercise it directly.

export interface IndexOptions {
  /** Files larger than this are indexed with the regex scanner (not skipped). */
  maxFileSizeBytes: number;
  /** If tree-sitter ERROR coverage exceeds this fraction, fall back to grep. */
  errorRatioThreshold: number;
  /** Per-file parse timeout in microseconds (0 = unlimited). */
  parseTimeoutMicros: number;
}

export const DEFAULT_INDEX_OPTIONS: IndexOptions = {
  maxFileSizeBytes: 2048 * 1024,
  errorRatioThreshold: 0.25,
  parseTimeoutMicros: 5000 * 1000,
};

export function hashText(text: string): string {
  return createHash('sha1').update(text).digest('hex');
}

export async function indexFile(
  file: string,
  text: string,
  lang: Lang | undefined,
  opts: IndexOptions = DEFAULT_INDEX_OPTIONS,
): Promise<FileIndex> {
  const hash = hashText(text);

  const debug = !!process.env.SINTRA_DEBUG;
  const grep = (reason: string): FileIndex => {
    if (debug) {
      console.error(`[indexFile] grep fallback for ${file}: ${reason}`);
    }
    const r = scanWithRegex(text, file, lang ?? 'c');
    // grep fallback has no scope analysis — no locals, no typedef aliases.
    const fi: FileIndex = { file, hash, parsedBy: 'grep', symbols: r.symbols, refs: r.refs, calls: r.calls, locals: [], aliases: [] };
    applyMacroWrappedVars(fi, text);
    return fi;
  };

  if (!lang) {
    return grep('no language');
  }
  if (Buffer.byteLength(text, 'utf8') > opts.maxFileSizeBytes) {
    return grep('size limit');
  }

  try {
    const parser = await getParser(lang);
    const start = Date.now();
    const timeoutMs = opts.parseTimeoutMicros > 0 ? opts.parseTimeoutMicros / 1000 : 0;
    // web-tree-sitter 0.25: cancel parsing by returning true from progressCallback
    // (setTimeoutMicros is deprecated and throws on this build).
    const parseOpts: ParseOptions | undefined =
      timeoutMs > 0 ? { progressCallback: () => Date.now() - start > timeoutMs } : undefined;
    const tree = parser.parse(text, undefined, parseOpts);
    if (!tree) {
      // timeout / cancellation: reset so the pooled parser is reusable
      parser.reset();
      return grep('null tree (timeout?)');
    }
    try {
      const res = extractFromTree(tree, file, lang);
      if (res.errorRatio > opts.errorRatioThreshold) {
        return grep(`errorRatio ${res.errorRatio.toFixed(3)} > ${opts.errorRatioThreshold}`);
      }
      const fi: FileIndex = {
        file,
        hash,
        parsedBy: 'ts',
        symbols: res.symbols,
        refs: res.refs,
        calls: res.calls,
        locals: res.locals,
        aliases: res.aliases,
      };
      applyMacroWrappedVars(fi, text);
      return fi;
    } finally {
      tree.delete();
    }
  } catch (e) {
    return grep(`exception: ${(e as Error)?.message ?? String(e)}`);
  }
}
