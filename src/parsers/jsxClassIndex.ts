import * as fs from 'fs';
import * as vscode from 'vscode';
import { parse } from '@babel/parser';
import traverseDefault from '@babel/traverse';
import type {
  Expression,
  StringLiteral,
  TemplateLiteral,
  ObjectExpression,
  Node,
} from '@babel/types';

// `@babel/traverse` ships as a CJS module whose default export ends up under
// `.default` when imported under our esbuild config. The `as any` indirection
// tolerates either shape so we don't break if upstream packaging changes.
const traverse: typeof traverseDefault =
  (traverseDefault as any).default ?? traverseDefault;

/**
 * One token (className/id literal) detected inside a JS/TS/JSX/TSX file.
 *
 * Offsets are absolute file character offsets. Callers convert to ranges via
 * `document.positionAt()` or `tokenToRange()` for off-document files.
 */
export interface ClassToken {
  type: 'class' | 'id';
  value: string;
  start: number;
  end: number;
  /**
   * - `attr-string` — `className="foo"` plain string attribute
   * - `attr-expr`   — `className={...}` expression container (template/ternary/&&/...)
   * - `helper`      — argument of `clsx()` / `classnames()` / `cn()` / etc.
   */
  source: 'attr-string' | 'attr-expr' | 'helper';
}

interface CacheEntry {
  mtimeMs: number;
  size: number;       // belt + suspenders for FSes with coarse mtime resolution
  tokens: ClassToken[];
}

const fileCache = new Map<string, CacheEntry>();

const DEFAULT_HELPERS = ['clsx', 'classnames', 'cn', 'cx', 'twMerge'];

function getHelpers(): string[] {
  const cfg = vscode.workspace.getConfiguration('cssBridge');
  const list = cfg.get<string[]>('classNameHelpers', DEFAULT_HELPERS);
  return Array.isArray(list) && list.length > 0 ? list : DEFAULT_HELPERS;
}

/**
 * Index a file on disk. mtime+size cached so repeated calls during a single
 * cursor movement / completion request don't re-parse with @babel/parser.
 */
export function indexJsxFile(filePath: string): ClassToken[] {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return [];
  }

  const cached = fileCache.get(filePath);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    return cached.tokens;
  }

  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return [];
  }

  const tokens = indexJsxText(content);
  fileCache.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, tokens });
  return tokens;
}

/**
 * Parse + walk arbitrary text. Used for the active editor's live (possibly
 * unsaved) buffer where mtime caching is meaningless.
 */
export function indexJsxText(content: string): ClassToken[] {
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

  const helpers = getHelpers();
  const tokens: ClassToken[] = [];

  traverse(ast, {
    JSXAttribute(path) {
      const node = path.node;
      if (node.name.type !== 'JSXIdentifier') return;
      const attrName = node.name.name;

      const type: 'class' | 'id' | null =
        attrName === 'className' ? 'class' :
        attrName === 'id'        ? 'id'    : null;
      if (!type) return;

      if (!node.value) return;

      if (node.value.type === 'StringLiteral') {
        // className="foo bar" — leaf case, no expression walking needed
        pushFromStringLiteral(node.value, type, 'attr-string', tokens);
      } else if (node.value.type === 'JSXExpressionContainer') {
        const expr = node.value.expression;
        if (expr.type === 'JSXEmptyExpression') return;
        // className={...} — recurse the expression to extract every literal
        extractFromExpression(expr as Expression, type, 'attr-expr', tokens);
      }
    },

    CallExpression(path) {
      const node = path.node;
      const callee = node.callee;

      // Match plain `clsx(...)` and member like `clsx.default(...)`.
      // Helpers are class-only — `id` doesn't get composed via these helpers,
      // so we always tag results as type='class'.
      let calleeName: string | null = null;
      if (callee.type === 'Identifier') {
        calleeName = callee.name;
      } else if (
        callee.type === 'MemberExpression' &&
        callee.property.type === 'Identifier' &&
        !callee.computed
      ) {
        calleeName = callee.property.name;
      }
      if (!calleeName || !helpers.includes(calleeName)) return;

      for (const arg of node.arguments) {
        if (arg.type === 'SpreadElement') continue;
        // ArgumentPlaceholder / JSXNamespacedName aren't expressions per se;
        // the cast is safe because anything weirder is filtered by the walker.
        extractFromExpression(arg as Expression, 'class', 'helper', tokens);
      }
    },
  });

  return tokens;
}

/**
 * Generic walker shared by `#10` (JSX expression containers) and `#4` (helper
 * call arguments). Recurses through every shape that can yield a className
 * string literal; bails on anything dynamic (function calls, identifiers,
 * member access) — we can't predict their values at parse time.
 */
function extractFromExpression(
  node: Expression,
  type: 'class' | 'id',
  source: 'attr-expr' | 'helper',
  out: ClassToken[],
): void {
  switch (node.type) {
    case 'StringLiteral':
      pushFromStringLiteral(node, type, source, out);
      return;

    case 'TemplateLiteral':
      // Static parts only — `${expression}` interpolations are runtime values.
      // `btn btn-${size}` yields token "btn" + the partial "btn-" (which won't
      // match any selector — accepted: better than dropping the prefix entirely).
      pushFromTemplateLiteral(node, type, source, out);
      return;

    case 'ConditionalExpression':
      // a ? 'x' : 'y' — both branches are reachable
      extractFromExpression(node.consequent, type, source, out);
      extractFromExpression(node.alternate, type, source, out);
      return;

    case 'LogicalExpression':
      // a && 'x'  → only `right` yields the class (truthy branch)
      // a || 'x'  → either side could be the class string (truthy fallback)
      // a ?? 'x'  → likewise for nullish fallback
      if (node.operator === '&&') {
        extractFromExpression(node.right, type, source, out);
      } else {
        extractFromExpression(node.left, type, source, out);
        extractFromExpression(node.right, type, source, out);
      }
      return;

    case 'BinaryExpression':
      // String concat — only `+` yields class strings; numeric ops are ignored
      if (node.operator === '+' && node.left.type !== 'PrivateName') {
        extractFromExpression(node.left as Expression, type, source, out);
        extractFromExpression(node.right, type, source, out);
      }
      return;

    case 'ArrayExpression':
      // clsx(['a', 'b']) / className={[a, b]}
      for (const el of node.elements) {
        if (el && el.type !== 'SpreadElement') {
          extractFromExpression(el as Expression, type, source, out);
        }
      }
      return;

    case 'ObjectExpression':
      // clsx({ 'btn-active': flag, btnDisabled: other })
      // Keys = class names; values = boolean predicates we don't care about.
      pushFromObjectKeys(node, type, source, out);
      return;

    case 'ParenthesizedExpression':
      // TS plugin can emit these — unwrap and recurse
      extractFromExpression((node as any).expression, type, source, out);
      return;

    case 'TSAsExpression':
    case 'TSNonNullExpression':
    case 'TSTypeAssertion':
    case 'TSSatisfiesExpression':
      // `'foo' as const` etc. — unwrap the inner expression
      extractFromExpression((node as any).expression, type, source, out);
      return;

    // CallExpression / Identifier / MemberExpression / etc. — runtime values,
    // we can't statically know what className they produce. Drop silently.
    default:
      return;
  }
}

function pushFromStringLiteral(
  lit: StringLiteral,
  type: 'class' | 'id',
  source: ClassToken['source'],
  out: ClassToken[],
): void {
  if (lit.start == null || lit.end == null) return;
  // lit.start points at the opening quote; +1 lands on the first content char.
  // For classes this matches the source exactly because className strings
  // virtually never contain JS escapes (\n, \xNN). If they do, we'll be off by
  // a few bytes — accepted: real-world incidence is ~0.
  pushTokensFromRaw(lit.value, lit.start + 1, type, source, out);
}

function pushFromTemplateLiteral(
  node: TemplateLiteral,
  type: 'class' | 'id',
  source: 'attr-expr' | 'helper',
  out: ClassToken[],
): void {
  // Static parts: each TemplateElement spans the literal text between
  // delimiters; its `start` is the offset of that text in the source.
  for (const quasi of node.quasis) {
    if (quasi.start == null) continue;
    pushTokensFromRaw(quasi.value.raw, quasi.start, type, source, out);
  }
  // Dynamic parts: `${expression}` interpolations may themselves be ternaries
  // (`${active ? "is-active" : ""}`) or logical short-circuits — recurse so
  // the literals inside surface as tokens.
  for (const expr of node.expressions) {
    // TSType nodes never appear in JSX-runtime templates; the cast guards
    // against future Babel additions without runtime cost.
    extractFromExpression(expr as Expression, type, source, out);
  }
}

function pushFromObjectKeys(
  obj: ObjectExpression,
  type: 'class' | 'id',
  source: ClassToken['source'],
  out: ClassToken[],
): void {
  for (const prop of obj.properties) {
    if (prop.type !== 'ObjectProperty') continue;
    if (prop.computed) continue;            // { [foo]: ... } — runtime key
    const key = prop.key as Node;
    if (key.type === 'StringLiteral') {
      // { 'btn-active': flag } — quoted key may contain dashes/spaces
      pushFromStringLiteral(key, type, source, out);
    } else if (key.type === 'Identifier' && key.start != null && key.end != null) {
      // { btnActive: flag } — bare identifier is a single token
      out.push({
        type,
        value: key.name,
        start: key.start,
        end: key.end,
        source,
      });
    }
    // Numeric / private / computed keys aren't class names — drop.
  }
}

/**
 * Tokenise a class-string-shaped value: split on whitespace, push each
 * non-empty run with its source offset preserved.
 */
function pushTokensFromRaw(
  raw: string,
  rawStart: number,
  type: 'class' | 'id',
  source: ClassToken['source'],
  out: ClassToken[],
): void {
  let i = 0;
  while (i < raw.length) {
    while (i < raw.length && isWs(raw[i])) i++;
    const tokStart = i;
    while (i < raw.length && !isWs(raw[i])) i++;
    const tokEnd = i;
    if (tokEnd > tokStart) {
      out.push({
        type,
        value: raw.slice(tokStart, tokEnd),
        start: rawStart + tokStart,
        end: rawStart + tokEnd,
        source,
      });
    }
  }
}

function isWs(ch: string): boolean {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\v' || ch === '\f';
}

/**
 * Linear scan — token lists are typically short (<100 entries), and binary
 * search over a sorted-by-start array would only matter for huge files. Keep
 * it simple; profile if it ever shows up in a flame graph.
 */
export function findTokenAtOffset(tokens: ClassToken[], offset: number): ClassToken | null {
  for (const t of tokens) {
    if (offset >= t.start && offset <= t.end) return t;
  }
  return null;
}

export function invalidateClassIndexCache(filePath: string): void {
  fileCache.delete(filePath);
}

/**
 * Convert a token's offsets to a `vscode.Range` using a precomputed line table.
 * Build the table once per file with `buildLineOffsets()` for batch conversions
 * (e.g. a rename scanning many files). For TextDocument-backed lookups, prefer
 * `document.positionAt(token.start)` — it's already O(log n).
 */
export function tokenToRange(token: ClassToken, lineOffsets: number[]): vscode.Range {
  return new vscode.Range(
    offsetToPosition(token.start, lineOffsets),
    offsetToPosition(token.end, lineOffsets),
  );
}

export function buildLineOffsets(text: string): number[] {
  const offsets: number[] = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') offsets.push(i + 1);
  }
  return offsets;
}

function offsetToPosition(offset: number, lineOffsets: number[]): vscode.Position {
  // Binary-search the line whose start offset ≤ offset and next line's > offset
  let lo = 0;
  let hi = lineOffsets.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1;
    if (lineOffsets[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return new vscode.Position(lo, offset - lineOffsets[lo]);
}
