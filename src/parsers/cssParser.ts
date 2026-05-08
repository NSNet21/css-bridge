import * as fs from 'fs';
import postcss from 'postcss';

export interface SelectorInfo {
  selector: string;   // full selector e.g. ".card" or "#hero"
  rawName: string;    // name only e.g. "card" or "hero"
  type: 'class' | 'id';
  line: number;       // 1-based
  column: number;     // 0-based
  filePath: string;
}

interface CacheEntry {
  mtimeMs: number;
  selectors: SelectorInfo[];
}

const cache = new Map<string, CacheEntry>();

export function parseSelectors(filePath: string): SelectorInfo[] {
  try {
    const stat = fs.statSync(filePath);
    const cached = cache.get(filePath);
    if (cached && cached.mtimeMs === stat.mtimeMs) {
      return cached.selectors;
    }

    const content = fs.readFileSync(filePath, 'utf-8');
    const root = postcss.parse(content, { from: filePath });
    const selectors: SelectorInfo[] = [];

    root.walkRules(rule => {
      rule.selectors.forEach(sel => {
        const trimmed = sel.trim();
        if (trimmed.startsWith('.')) {
          selectors.push({
            selector: trimmed,
            rawName: trimmed.slice(1),
            type: 'class',
            line: rule.source?.start?.line ?? 1,
            column: rule.source?.start?.column ?? 0,
            filePath,
          });
        } else if (trimmed.startsWith('#')) {
          selectors.push({
            selector: trimmed,
            rawName: trimmed.slice(1),
            type: 'id',
            line: rule.source?.start?.line ?? 1,
            column: rule.source?.start?.column ?? 0,
            filePath,
          });
        }
      });
    });

    cache.set(filePath, { mtimeMs: stat.mtimeMs, selectors });
    return selectors;
  } catch {
    return [];
  }
}

export function invalidateCache(filePath: string): void {
  cache.delete(filePath);
}
