import * as fs from 'fs';
import * as path from 'path';
import { parse } from '@babel/parser';
import { findNearestTsConfig, resolveImportPath } from '../utils/tsconfigResolver';

interface CacheEntry {
  mtimeMs: number;
  cssFiles: string[];
}

// mtime-keyed cache so providers (codeAction, completion, findLocations) called
// on every cursor move don't re-run @babel/parser on the same unchanged source.
const cache = new Map<string, CacheEntry>();

/**
 * Resolve every CSS file imported by the JS/TS file at `filePath`.
 *
 * Supports:
 *   - Relative imports     `import './foo.css'`
 *   - Aliased imports      `import '@/styles/globals.css'` (via tsconfig paths)
 *   - baseUrl imports      `import 'styles/globals.css'`   (via tsconfig baseUrl)
 *
 * Returns absolute paths to CSS files that actually exist on disk. Aliased
 * specifiers that don't resolve to a real file are silently dropped.
 */
export function resolveCssImports(filePath: string): string[] {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return [];
  }

  const cached = cache.get(filePath);
  if (cached && cached.mtimeMs === stat.mtimeMs) {
    return cached.cssFiles;
  }

  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return [];
  }

  let ast;
  try {
    ast = parse(content, {
      sourceType: 'module',
      plugins: ['jsx', 'typescript'],
      errorRecovery: true,
    });
  } catch {
    return [];
  }

  const tsconfig = findNearestTsConfig(filePath);
  const cssFiles: string[] = [];

  for (const node of ast.program.body) {
    if (node.type !== 'ImportDeclaration') continue;
    const spec = node.source.value;
    if (!spec.endsWith('.css')) continue;

    const resolved = resolveImportPath(spec, filePath, tsconfig);
    // Only keep paths that actually exist on disk — aliased imports that don't
    // map to a real file (typo, wrong baseUrl) get silently dropped instead of
    // polluting downstream lookups.
    if (fs.existsSync(resolved)) {
      cssFiles.push(resolved);
    }
  }

  cache.set(filePath, { mtimeMs: stat.mtimeMs, cssFiles });
  return cssFiles;
}

export function invalidateImportCache(filePath: string): void {
  cache.delete(filePath);
}
