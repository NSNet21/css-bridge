import * as fs from 'fs';
import * as path from 'path';
import { parse } from '@babel/parser';

interface CacheEntry {
  mtimeMs: number;
  cssFiles: string[];
}

// mtime-keyed cache so providers (codeAction, completion, findLocations) called
// on every cursor move don't re-run @babel/parser on the same unchanged source.
const cache = new Map<string, CacheEntry>();

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

  const dir = path.dirname(filePath);
  const cssFiles: string[] = [];

  for (const node of ast.program.body) {
    if (
      node.type === 'ImportDeclaration' &&
      node.source.value.endsWith('.css')
    ) {
      const resolved = path.resolve(dir, node.source.value);
      cssFiles.push(resolved);
    }
  }

  cache.set(filePath, { mtimeMs: stat.mtimeMs, cssFiles });
  return cssFiles;
}

export function invalidateImportCache(filePath: string): void {
  cache.delete(filePath);
}
