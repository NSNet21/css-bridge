import * as fs from 'fs';
import postcss, { Declaration, Rule } from 'postcss';

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

// ───────────────────────────────────────────────────────────────────────────
// v1.3.0: CSS variable jump
// ───────────────────────────────────────────────────────────────────────────
// `parseVars` lives next to `parseSelectors` because they walk the same files,
// but it keeps a separate cache. Reasons:
//
//   1. Most CSS files have selectors but no `--vars` (or vice versa) — separate
//      caches let either grow independently without touching the other.
//   2. We can ship/refactor var-handling without risking regression on the
//      selector path that v1.0–v1.2 features depend on.
//   3. mtime check is shared (both call `fs.statSync` once per call), so the
//      perf cost of having two caches is essentially zero.
//
// Definitions go through postcss `walkDecls` because we need the **parent
// rule's selector** to power multi-theme disambiguation (`:root` vs
// `.theme-dark`). Usages stay on regex because:
//   - We need the absolute offset in the file (postcss values don't expose it).
//   - `var()` can appear inside any declaration value, including ones that
//     postcss represents as a single string.
//   - Strip block comments first so `/* var(--foo) */` is ignored — we replace
//     each comment with same-length whitespace to keep offsets stable.

export interface VarDef {
  name: string;       // 'primary' (without the leading '--')
  value: string;       // '#0066cc'
  selector: string;    // ':root' / '.theme-dark' / '(unknown)' for non-rule parents
  line: number;       // 1-based — points to the line of '--name'
  column: number;     // 0-based — points to start of '--name'
  filePath: string;
}

export interface VarUse {
  name: string;       // 'primary'
  line: number;       // 1-based — points to '--name' inside `var(--name…)`
  column: number;     // 0-based
  filePath: string;
}

interface VarCacheEntry {
  mtimeMs: number;
  defs: VarDef[];
  uses: VarUse[];
}

const varCache = new Map<string, VarCacheEntry>();

export function parseVars(filePath: string): { defs: VarDef[]; uses: VarUse[] } {
  try {
    const stat = fs.statSync(filePath);
    const cached = varCache.get(filePath);
    if (cached && cached.mtimeMs === stat.mtimeMs) {
      return { defs: cached.defs, uses: cached.uses };
    }

    const content = fs.readFileSync(filePath, 'utf-8');
    const defs: VarDef[] = [];
    const uses: VarUse[] = [];

    // --- Definitions ---------------------------------------------------------
    // postcss may throw on syntactically broken CSS — fall through with whatever
    // we collected so the cache still warms (better than thrashing on every call).
    try {
      const root = postcss.parse(content, { from: filePath });
      root.walkDecls(/^--/, (decl: Declaration) => {
        const name = decl.prop.slice(2); // strip leading '--'
        const parent = decl.parent;
        const selector =
          parent && parent.type === 'rule'
            ? (parent as Rule).selector.trim()
            : '(unknown)';
        const startLine = decl.source?.start?.line ?? 1;
        // postcss columns are 1-based; convert to 0-based for VS Code consumers.
        const startCol = decl.source?.start?.column ?? 1;
        defs.push({
          name,
          value: decl.value,
          selector,
          line: startLine,
          column: Math.max(0, startCol - 1),
          filePath,
        });
      });
    } catch {
      /* swallow — leaves defs empty for this snapshot */
    }

    // --- Usages --------------------------------------------------------------
    // Strip block comments so commented-out var() calls don't show up as uses.
    // Replace each comment with same-length whitespace (only swap non-newlines)
    // to preserve absolute offsets — line/column math stays accurate.
    const stripped = stripCssBlockComments(content);
    // Match `var(--name`, allowing optional whitespace after `(`.
    // We don't anchor on the closing `)` so `var(--foo, fallback)` works (we
    // capture only `--foo`; the fallback isn't a *use* of any other var unless
    // it nests another `var(...)`, which the regex picks up on its own pass).
    const useRegex = /\bvar\(\s*--([\w-]+)/g;
    let m: RegExpExecArray | null;
    while ((m = useRegex.exec(stripped)) !== null) {
      // m.index → 'v' of `var(`. The `--name` starts wherever `--` is inside m[0].
      const dashOffset = m[0].indexOf('--');
      const nameStart = m.index + dashOffset;
      const { line, column } = offsetToLineCol(stripped, nameStart);
      uses.push({ name: m[1], line, column, filePath });
    }

    varCache.set(filePath, { mtimeMs: stat.mtimeMs, defs, uses });
    return { defs, uses };
  } catch {
    return { defs: [], uses: [] };
  }
}

export function invalidateVarCache(filePath: string): void {
  varCache.delete(filePath);
}

function stripCssBlockComments(s: string): string {
  // Same-length replacement: preserves absolute offsets so line/column math
  // computed against the stripped string maps back 1:1 to the original.
  return s.replace(/\/\*[\s\S]*?\*\//g, comment =>
    comment.replace(/[^\n]/g, ' ')
  );
}

function offsetToLineCol(s: string, offset: number): { line: number; column: number } {
  // 1-based line, 0-based column — matches the convention used by SelectorInfo
  // and what VS Code wants once converted (line - 1, column).
  let line = 1;
  let lastNl = -1;
  for (let i = 0; i < offset; i++) {
    if (s.charCodeAt(i) === 10 /* \n */) {
      line++;
      lastNl = i;
    }
  }
  return { line, column: offset - lastNl - 1 };
}
