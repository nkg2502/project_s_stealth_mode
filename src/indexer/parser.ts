import { Parser, Language } from 'web-tree-sitter';
import type { Lang } from '../core/types';

// web-tree-sitter initialization and a small per-language parser pool.
// Pure (no vscode): callers pass wasm asset paths so this works both in the
// extension (dist/ paths) and in headless tests (node_modules/ paths).

export interface ParserAssets {
  /** Path to the web-tree-sitter runtime wasm (tree-sitter.wasm). */
  runtimeWasmPath: string;
  /** Map of language -> grammar wasm path. Missing languages fall back to grep. */
  grammarPaths: Partial<Record<Lang, string>>;
}

let assets: ParserAssets | undefined;
let initPromise: Promise<void> | undefined;
const languages = new Map<Lang, Language>();
const parsers = new Map<Lang, Parser>();

export function configureAssets(a: ParserAssets): void {
  assets = a;
}

export async function initParser(a?: ParserAssets): Promise<void> {
  if (a) {
    assets = a;
  }
  if (!assets) {
    throw new Error('parser assets not configured');
  }
  if (!initPromise) {
    const runtime = assets.runtimeWasmPath;
    initPromise = Parser.init({
      // Emscripten asks for "tree-sitter.wasm" by name; point it at our copy.
      locateFile: (scriptName: string) =>
        scriptName.endsWith('.wasm') ? runtime : scriptName,
    } as object);
  }
  await initPromise;
}

export async function getLanguage(lang: Lang): Promise<Language> {
  let l = languages.get(lang);
  if (!l) {
    const p = assets?.grammarPaths[lang];
    if (!p) {
      throw new Error(`no grammar configured for language: ${lang}`);
    }
    l = await Language.load(p);
    languages.set(lang, l);
  }
  return l;
}

/** Get a cached parser for a language (reused across files in one thread). */
export async function getParser(lang: Lang): Promise<Parser> {
  let p = parsers.get(lang);
  if (!p) {
    const language = await getLanguage(lang);
    p = new Parser();
    p.setLanguage(language);
    parsers.set(lang, p);
  }
  return p;
}

export function disposeParsers(): void {
  for (const p of parsers.values()) {
    p.delete();
  }
  parsers.clear();
  languages.clear();
}

const EXT_TO_LANG: Record<string, Lang> = {
  '.c': 'c',
  '.h': 'c',
  '.inc': 'c',
  '.cpp': 'cpp',
  '.cc': 'cpp',
  '.cxx': 'cpp',
  '.c++': 'cpp',
  '.hpp': 'cpp',
  '.hh': 'cpp',
  '.hxx': 'cpp',
  '.h++': 'cpp',
};

/** Map a lowercase file extension (with dot) to a language, if supported. */
export function langForExt(ext: string): Lang | undefined {
  return EXT_TO_LANG[ext.toLowerCase()];
}
