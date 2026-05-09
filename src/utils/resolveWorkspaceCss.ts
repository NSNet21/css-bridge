import * as fs from 'fs';
import { findScopeBoundary, globFiles } from './scopeBoundary';
import { resolveCssImports } from '../parsers/importResolver';

interface CacheEntry {
  mtimeMax: number;   // newest mtime among any source file in the scope
  fileCount: number;  // detect file additions/deletions
  cssFiles: string[]; // union (deduplicated)
}

// Per-scope cache. Key = scope root dir. Value invalidated when any source file
// in the scope changes (mtimeMax) or when files are added/removed (fileCount).
const cache = new Map<string, CacheEntry>();

/**
 * Return every CSS file imported by any JS/TS source file inside the project
 * scope of `fromFile`. This makes child components see CSS that was imported
 * elsewhere in the project (e.g. `globals.css` imported by `App.tsx`).
 *
 * Scope is the nearest project boundary (tsconfig/jsconfig/package.json/build
 * config) — same boundary used by reverse navigation and rename, so behavior is
 * symmetric across all of CSS Bridge.
 *
 * Cached per-scope; invalidated when any source file's mtime changes or when
 * the file count differs (handles add/delete without a watcher round-trip).
 */
export function resolveWorkspaceCss(fromFile: string): string[] {
  const scope = findScopeBoundary(fromFile);
  const sourceFiles = globFiles(scope, ['.js', '.ts', '.jsx', '.tsx']);

  // Cheap fingerprint: count + max mtime. Avoids reading every file just to know
  // if the union changed. False positives (mtime touch with no import change)
  // only cost a recompute, not correctness.
  let mtimeMax = 0;
  for (const f of sourceFiles) {
    try {
      const m = fs.statSync(f).mtimeMs;
      if (m > mtimeMax) mtimeMax = m;
    } catch { /* ignore */ }
  }

  const cached = cache.get(scope);
  if (cached && cached.mtimeMax === mtimeMax && cached.fileCount === sourceFiles.length) {
    return cached.cssFiles;
  }

  const seen = new Set<string>();
  for (const f of sourceFiles) {
    for (const css of resolveCssImports(f)) {
      seen.add(css);
    }
  }
  const cssFiles = Array.from(seen);

  cache.set(scope, { mtimeMax, fileCount: sourceFiles.length, cssFiles });
  return cssFiles;
}

export function invalidateWorkspaceCssCache(): void {
  cache.clear();
}
